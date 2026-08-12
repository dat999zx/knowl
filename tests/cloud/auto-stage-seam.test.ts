import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, getClient, initDb } from '../../src/store/database.js';
import { releaseAll } from '../../src/store/connection-pool.js';
import * as repo from '../../src/store/repository.js';
import { storeKnowledgeItemDeduped, storeKnowledgeAtomsDeduped } from '../../src/store/knowledge-writer.js';
import { recordDecisionDirect, updateKnowledgeItemWithCommit } from '../../src/store/knowledge-actions.js';
import { listStaged, publishedVersion, recordPushed } from '../../src/cloud/ledger.js';
import { excludeFromPublish } from '../../src/cloud/exclusions.js';

const ROOT = path.resolve('./.knowl-auto-stage-seam');
const WS = 'ws-seam';

let projectId: string;

const staged = async (): Promise<string[]> => (await listStaged(WS)).map(row => row.itemId).sort();

/**
 * Writes the repo's config with a cloud pointer, so the seam resolves a connected repo.
 *
 * `autoStageAfterWrite` reads config from disk per write rather than being handed it, so this is
 * what makes a test "connected" — there is no argument to pass.
 */
async function connect(overrides: Record<string, unknown> = {}): Promise<void> {
  await fs.writeFile(
    path.join(ROOT, '.knowl', 'config.json'),
    JSON.stringify({
      version: 1,
      cloud: {
        apiHost: 'https://api.knowl.test', workspaceId: WS, workspaceName: 'Acme',
        repo: 'github.com/acme/web', remote: 'origin', ...overrides,
      },
    }),
    'utf8',
  );
}

describe('the auto-stage seam', () => {
  beforeEach(async () => {
    await closeDb().catch(() => {});
    await releaseAll();
    await fs.rm(ROOT, { recursive: true, force: true }).catch(() => {});
    await fs.mkdir(path.join(ROOT, '.knowl'), { recursive: true });
    await connect();
    await initDb(ROOT);
    await getClient().execute('DELETE FROM knowledge_items');
    await getClient().execute('DELETE FROM cloud_published');
    await getClient().execute('DELETE FROM cloud_excluded');
    projectId = (await repo.createProject(ROOT, 'seam')).id;
  });

  afterEach(async () => {
    await closeDb().catch(() => {});
    await releaseAll();
    await fs.rm(ROOT, { recursive: true, force: true }).catch(() => {});
  });

  const atom = (title: string) => ({
    category: 'fact' as const,
    title,
    content: `Something worth knowing about ${title}, at enough length to look real.`,
  });

  it('a single-atom write stages', async () => {
    const result = await storeKnowledgeItemDeduped(projectId, atom('single'));
    expect(await staged()).toEqual([result.item.id]);
  });

  it('a batch write stages every atom it actually inserted', async () => {
    const result = await storeKnowledgeAtomsDeduped(projectId, [atom('one'), atom('two')]);
    expect(await staged()).toEqual([...result.itemIds].sort());
  });

  it('a decision stages, because it writes through the repository rather than the writer', async () => {
    const result = await recordDecisionDirect(projectId, {
      title: 'Roll back by tag', content: 'A failed deploy rolls back to the previous tag.',
    });
    expect(await staged()).toEqual([result.item.id]);
  });

  it('an update to a published atom stages a correction and keeps its version', async () => {
    const stored = await storeKnowledgeItemDeduped(projectId, atom('published'));
    await recordPushed(stored.item.id, WS, 4);
    expect(await staged()).toEqual([]);

    await updateKnowledgeItemWithCommit(projectId, stored.item.id, { content: 'Corrected wording entirely.' });

    expect(await staged()).toEqual([stored.item.id]);
    // The invariant Plan A exists to protect: a correction still declares what it overwrites.
    expect(await publishedVersion(stored.item.id, WS)).toBe(4);
  });

  it('stages nothing when the repo is not connected', async () => {
    await fs.writeFile(path.join(ROOT, '.knowl', 'config.json'), JSON.stringify({ version: 1 }), 'utf8');
    await storeKnowledgeItemDeduped(projectId, atom('offline'));
    expect(await staged()).toEqual([]);
  });

  it('stages nothing when autoStage is off', async () => {
    await connect({ autoStage: false });
    await storeKnowledgeItemDeduped(projectId, atom('opted out'));
    expect(await staged()).toEqual([]);
  });

  it('stages nothing for an excluded atom, even on a fresh write', async () => {
    const first = await storeKnowledgeItemDeduped(projectId, atom('local only'));
    await excludeFromPublish(first.item.id, 'test');
    await getClient().execute('DELETE FROM cloud_published');

    await updateKnowledgeItemWithCommit(projectId, first.item.id, { content: 'Edited, still local.' });
    expect(await staged()).toEqual([]);
  });

  /**
   * The structural property this seam was chosen for.
   *
   * These paths reach `repo.updateKnowledgeItem` directly and never touch a transaction owner,
   * so they cannot stage — not because a guard rejects them, but because the hook is not on
   * their path at all. Garbage collection archiving an atom, a drift sweep marking one stale,
   * or a session handoff being recorded must never queue anything for the team.
   */
  it('a direct repository update stages nothing, which is what keeps GC and drift off the wire', async () => {
    const stored = await storeKnowledgeItemDeduped(projectId, atom('swept'));
    await getClient().execute('DELETE FROM cloud_published');

    await repo.updateKnowledgeItem(stored.item.id, { status: 'archived' });

    expect(await staged()).toEqual([]);
  });
});
