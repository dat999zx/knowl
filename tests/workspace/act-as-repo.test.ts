import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, getClient, getConfigRoot, getProjectRoot, initDb } from '../../src/store/database.js';
import { releaseAll } from '../../src/store/connection-pool.js';
import * as repo from '../../src/store/repository.js';
import { storeKnowledgeItemDeduped } from '../../src/store/knowledge-writer.js';
import { createManifest, writeManifest } from '../../src/workspace/manifest.js';
import { workspaceManifestPath } from '../../src/workspace/paths.js';
import { joinWorkspace } from '../../src/workspace/membership.js';
import { resolveWorkspace } from '../../src/workspace/resolve.js';
import { DEFAULT_CONFIG, loadConfig, saveConfig } from '../../src/core/config.js';
import { resetWriteOwnershipCache } from '../../src/store/write-ownership.js';
import { UnknownRepoError, withRepoContext } from '../../src/workspace/act-as.js';

/**
 * Acting as a linked repo.
 *
 * The CLI has always been able to do another repo's work: `cd` there and every command applies to
 * that repo, because standing somewhere is what the ownership guard checks. An MCP server cannot
 * `cd` -- it is bound to the directory it started in -- so an agent had the capability denied to
 * it that the human running the same tools already had.
 *
 * `withRepoContext` is that `cd`. It swaps the database AND the config root together, which is
 * the whole design: everything downstream reads the ambient context, so ownership stamping,
 * auto-staging, the cloud pointer and the ownership guard all follow the target repo without any
 * of them being told about this.
 */

const HOME = path.join(os.tmpdir(), 'knowl-actas-home');
const A = path.join(os.tmpdir(), 'knowl-actas-a');
const B = path.join(os.tmpdir(), 'knowl-actas-b');

async function seed(root: string, name: string, title: string, content: string): Promise<string> {
  await fs.mkdir(path.join(root, '.knowl'), { recursive: true });
  await saveConfig(root, { ...DEFAULT_CONFIG });
  await initDb(root);
  const projectId = (await repo.createProject(root, name)).id;
  const stored = await storeKnowledgeItemDeduped(projectId, { category: 'decision', title, content });
  await getClient().execute({
    sql: 'UPDATE knowledge_items SET visibility = ?, origin_repo = ? WHERE id = ?',
    args: ['workspace', name, stored.item.id],
  });
  await closeDb();
  return stored.item.id;
}

describe('withRepoContext', () => {
  let ownedByB = '';

  beforeEach(async () => {
    process.env.KNOWL_HOME = HOME;
    await closeDb();
    await releaseAll();
    for (const dir of [HOME, A, B]) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    await writeManifest(workspaceManifestPath('aws'), createManifest('aws', null));
    await seed(A, 'a', 'Local note', 'Something only this repo knows.');
    ownedByB = await seed(B, 'b', 'Auth token TTL', 'Auth tokens expire after fifteen minutes.');
    await joinWorkspace({ projectRoot: A, workspaceName: 'aws', repoName: 'a' });
    await joinWorkspace({ projectRoot: B, workspaceName: 'aws', repoName: 'b' });
    // The seeds above wrote before either repo had joined, so the per-root ownership cache holds
    // "unlinked" for both. That is a fixture artifact rather than a product one -- a server never
    // writes into a repo before it joins -- but leaving it would make the stamping assertion
    // below test the cache instead of the rebind.
    resetWriteOwnershipCache();
  });

  afterEach(async () => {
    delete process.env.KNOWL_HOME;
    await closeDb();
    await releaseAll();
    for (const dir of [HOME, A, B]) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  const inA = async () => {
    await initDb(A);
    return resolveWorkspace(A, await loadConfig(A));
  };

  it('swaps the config root too, not just the database', async () => {
    // The trap `withDbPath` documents: it keeps the CALLER's config root, which is right for a
    // namespace store and wrong for a repo. Ownership stamping and the cloud pointer are both
    // read from the config root, so a swap that moved only the database would write into `b`
    // and stamp it `a`.
    const workspace = await inA();
    const seen = await withRepoContext('b', workspace, async () => ({
      projectRoot: getProjectRoot(),
      configRoot: getConfigRoot(),
    }));
    await closeDb();

    expect(path.resolve(seen.projectRoot)).toBe(path.resolve(B));
    expect(path.resolve(seen.configRoot)).toBe(path.resolve(B));
  });

  it('restores the caller\'s context afterwards', async () => {
    const workspace = await inA();
    await withRepoContext('b', workspace, async () => undefined);
    const after = getProjectRoot();
    await closeDb();

    expect(path.resolve(after)).toBe(path.resolve(A));
  });

  it('a write inside the rebind lands in the target repo, stamped as the target', async () => {
    const workspace = await inA();
    const written = await withRepoContext('b', workspace, async () => {
      const project = await repo.getProjectByRootPath(getProjectRoot());
      const result = await storeKnowledgeItemDeduped(project!.id, {
        category: 'fact', title: 'Refresh window', content: 'The refresh window is five minutes.',
      });
      return result.item.id;
    });
    await closeDb();

    // In B's database...
    await initDb(B);
    const inTarget = await repo.getKnowledgeItem(written);
    const stamp = await getClient().execute({ sql: 'SELECT origin_repo FROM knowledge_items WHERE id = ?', args: [written] });
    await closeDb();
    expect(inTarget?.title).toBe('Refresh window');
    // ...and stamped as B's own, which is the point: it is indistinguishable from a write B made.
    expect(String(stamp.rows[0].origin_repo)).toBe('b');

    // ...and NOT in A's.
    await initDb(A);
    const inCaller = await repo.getKnowledgeItem(written);
    await closeDb();
    expect(inCaller).toBeNull();
  });

  it('the ownership guard is satisfied rather than bypassed', async () => {
    // Standing in `b` makes b's item local, so `assertOwnedItem` passes for the ordinary reason.
    // Nothing here weakens the guard; the guard is asked a different question.
    const { assertOwnedItem } = await import('../../src/workspace/ownership.js');
    const workspace = await inA();
    await expect(assertOwnedItem(ownedByB, workspace)).rejects.toThrow(/belongs to repo "b"/);
    await withRepoContext('b', workspace, async () => {
      const inner = await resolveWorkspace(getProjectRoot(), await loadConfig(getProjectRoot()));
      await expect(assertOwnedItem(ownedByB, inner)).resolves.toBeUndefined();
    });
    await closeDb();
  });

  it('refuses a repo that is not linked, naming what is', async () => {
    const workspace = await inA();
    await expect(withRepoContext('not-a-member', workspace, async () => undefined))
      .rejects.toThrow(UnknownRepoError);
    await closeDb();
  });

  it('refuses outside a workspace, rather than accepting an arbitrary path', async () => {
    await initDb(A);
    await expect(withRepoContext('b', null, async () => undefined)).rejects.toThrow(/workspace/i);
    await closeDb();
  });

  it('refuses a linked repo that is not checked out on this machine', async () => {
    const workspace = await inA();
    const absent = {
      ...workspace!,
      peers: workspace!.peers.map(peer => ({ ...peer, present: false })),
    };
    await expect(withRepoContext('b', absent, async () => undefined)).rejects.toThrow(/not checked out|not present/i);
    await closeDb();
  });

  it('acting as yourself is allowed and is a no-op, so callers need no special case', async () => {
    const workspace = await inA();
    const seen = await withRepoContext('a', workspace, async () => getProjectRoot());
    await closeDb();
    expect(path.resolve(seen)).toBe(path.resolve(A));
  });
});
