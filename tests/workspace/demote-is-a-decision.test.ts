import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, getClient, initDb } from '../../src/store/database.js';
import { releaseAll } from '../../src/store/connection-pool.js';
import * as repo from '../../src/store/repository.js';
import { storeKnowledgeItemDeduped } from '../../src/store/knowledge-writer.js';
import { queryFederated } from '../../src/workspace/federated-query.js';
import { loadForeignPeerChanges } from '../../src/store/change-watermark.js';
import { resolveWorkspace } from '../../src/workspace/resolve.js';
import { createManifest, writeManifest } from '../../src/workspace/manifest.js';
import { workspaceManifestPath } from '../../src/workspace/paths.js';
import { DEFAULT_CONFIG, saveConfig } from '../../src/core/config.js';

/**
 * Evidence for the "promotion is irreversible" claim, which K-58's severity rests on.
 *
 * The claim has two halves and they are not the same kind of thing.
 *
 * The *mechanism* half is false: un-sharing is one column, `promoteItems` already writes that
 * exact column, and both cross-repo read paths -- `queryFederated` and `loadForeignPeerChanges`
 * -- filter a peer's database on `visibility = 'workspace'` in SQL at read time. Nothing is
 * copied into the reading repo, so flipping the column back does stop every subsequent read.
 * These tests prove that: the same peer, the same query, before and after the flip.
 *
 * The *semantic* half is true and no code can change it: a peer that already read the item has
 * it, and a change notification already delivered into an agent's context has been delivered.
 * A "demote" would un-share going forward while reading as though it retracted.
 *
 * So `docs/superpowers/specs/2026-07-30-workspace-repo-role-design.md` and
 * `docs/superpowers/plans/2026-07-26-workspace-v2-shared-database.md` record a design
 * decision, not a missing function -- and the decision turns on the half that is true.
 * Recorded as a test so the next person weighing an inverse starts from the measurement.
 */

const HOME = path.resolve('./.knowl-demote-home');
const A = path.resolve('./.knowl-demote-a');
const B = path.resolve('./.knowl-demote-b');

const SHARED = 'Deploys are blue-green';

async function seed(root: string, name: string, title: string) {
  await fs.mkdir(path.join(root, '.knowl'), { recursive: true });
  await saveConfig(root, { ...DEFAULT_CONFIG, workspace: { workspace: 'ws', repo: name } });
  await initDb(root);
  const projectId = (await repo.createProject(root, name)).id;
  const stored = await storeKnowledgeItemDeduped(projectId, {
    category: 'decision', title, content: 'Two identical fleets swap on release.',
  });
  await getClient().execute({
    sql: "UPDATE knowledge_items SET visibility = 'workspace', origin_repo = ? WHERE id = ?",
    args: [name, stored.item.id],
  });
  await closeDb();
}

/** The one column a demote would write, applied directly to the publishing repo. */
async function setVisibility(root: string, visibility: string) {
  await initDb(root);
  try {
    await getClient().execute({ sql: 'UPDATE knowledge_items SET visibility = ? WHERE title = ?', args: [visibility, SHARED] });
  } finally {
    await closeDb();
  }
}

/** What repo B can see of repo A right now. */
async function whatBSees(): Promise<{ found: string[]; notified: string[] }> {
  await initDb(B);
  try {
    const active = (await resolveWorkspace(B))!;
    const federated = await queryFederated({ workspace: active, query: 'deploys blue green', limit: 10 });
    const changes = await loadForeignPeerChanges(active.peers[0], 0);
    return {
      found: federated.items.map(item => item.title),
      notified: (changes.items ?? []).map((entry: any) => String(entry.title)),
    };
  } finally {
    await closeDb();
  }
}

describe('un-sharing is a decision, not a missing mechanism', () => {
  beforeEach(async () => {
    process.env.KNOWL_HOME = HOME;
    await closeDb();
    await releaseAll();
    for (const dir of [HOME, A, B]) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    const manifest = createManifest('ws', null);
    manifest.repos.push({ name: 'a', path: A, addedAt: new Date().toISOString() });
    manifest.repos.push({ name: 'b', path: B, addedAt: new Date().toISOString() });
    await writeManifest(workspaceManifestPath('ws'), manifest);
    // Different titles: B must not hold its own copy of the item under test, or "B can still
    // see it" would be true for a reason that has nothing to do with A's visibility.
    await seed(A, 'a', SHARED);
    await seed(B, 'b', 'B knows about deploy windows');
  });

  afterEach(async () => {
    delete process.env.KNOWL_HOME;
    await closeDb();
    await releaseAll();
    for (const dir of [HOME, A, B]) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  it('stops every cross-repo read the moment visibility goes back to repo', async () => {
    const before = await whatBSees();
    expect(before.found).toContain(SHARED);
    expect(before.notified).toContain(SHARED);

    await setVisibility(A, 'repo');

    // Both paths re-read the peer's database and filter it in SQL, so there is no cached copy
    // anywhere for the flip to miss. A demote would work, mechanically, today.
    const after = await whatBSees();
    expect(after.found).not.toContain(SHARED);
    expect(after.notified).not.toContain(SHARED);
  });

  it('leaves nothing behind in the reading repo, which is why the flip is enough', async () => {
    await whatBSees();
    await setVisibility(A, 'repo');

    await initDb(B);
    try {
      const rows = await getClient().execute({ sql: 'SELECT id FROM knowledge_items WHERE title = ?', args: [SHARED] });
      // A federated read materialises nothing. What survives a demote is what a human or an
      // agent already carried away -- which is the half no inverse can reach.
      expect(rows.rows).toHaveLength(0);
    } finally {
      await closeDb();
    }
  });
});
