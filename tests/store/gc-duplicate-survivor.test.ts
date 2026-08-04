import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, getClient, initDb } from '../../src/store/database.js';
import { releaseAll } from '../../src/store/connection-pool.js';
import * as repo from '../../src/store/repository.js';
import { attachEvidenceToKnowledge, listEvidenceForItem } from '../../src/store/evidence-repository.js';
import { applyKnowledgeGc, previewKnowledgeGc } from '../../src/store/gc.js';
import { resetWriteOwnershipCache } from '../../src/store/write-ownership.js';

let counter = 0;
let ROOT = '';
const NOW = new Date().toISOString();

/** GC prefers the newer copy on a tie, so age is set explicitly rather than left to timing. */
async function setUpdatedAt(itemId: string, iso: string) {
  await getClient().execute({ sql: 'UPDATE knowledge_items SET updated_at = ? WHERE id = ?', args: [iso, itemId] });
}

const OLDER = new Date(Date.now() - 5 * 86_400_000).toISOString();
const NEWER = new Date(Date.now() - 1 * 86_400_000).toISOString();

describe('GC never purges the richer of two twins', () => {
  let projectId = '';
  beforeEach(async () => {
    await closeDb();
    await releaseAll();
    resetWriteOwnershipCache();
    counter += 1;
    ROOT = path.resolve(`./.knowl-gc-survivor${counter}`);
    await fs.rm(ROOT, { recursive: true, force: true }).catch(() => {});
    await fs.mkdir(path.join(ROOT, '.knowl'), { recursive: true });
    await initDb(ROOT);
    projectId = (await repo.createProject(ROOT, 'gc-survivor')).id;
  });
  afterEach(async () => {
    await closeDb();
    await releaseAll();
    await fs.rm(ROOT, { recursive: true, force: true }).catch(() => {});
  });

  it('keeps the copy carrying reasoning, tags and paths over the newer bare one', async () => {
    // The duplicate key is category + title + content. Everything else an item carries --
    // reasoning, tags, affectedPaths, source commit -- is invisible to it, and the survivor was
    // then picked by confidence and recency. So the newer, barer copy won and the purge hard
    // deleted the richer one, cascading its evidence and assertions with it.
    const rich = await repo.createKnowledgeItem(projectId, {
      category: 'fact', title: 'Rate limit', content: 'The API allows 100 requests per minute.',
      reasoning: 'Measured against the edge proxy configuration.',
      tags: ['api', 'limits'], affectedPaths: ['src/api/limiter.ts'], sourceCommit: 'deadbee',
    });
    const bare = await repo.createKnowledgeItem(projectId, {
      category: 'fact', title: 'Rate limit', content: 'The API allows 100 requests per minute.',
    });
    await setUpdatedAt(rich.id, OLDER);
    await setUpdatedAt(bare.id, NEWER);

    const preview = await previewKnowledgeGc(projectId, { now: NOW });
    const purged = preview.candidates.filter(candidate => candidate.action === 'purge').map(candidate => candidate.itemId);
    expect(purged).toEqual([bare.id]);

    await applyKnowledgeGc(projectId, { now: NOW });
    const survivor = await repo.getKnowledgeItem(rich.id);
    expect(survivor).not.toBeNull();
    expect(survivor!.tags).toEqual(['api', 'limits']);
    expect(await repo.getKnowledgeItem(bare.id)).toBeNull();
  });

  it('keeps the copy whose evidence the other does not have', async () => {
    const evidenced = await repo.createKnowledgeItem(projectId, {
      category: 'fact', title: 'Queue driver', content: 'Background jobs run on Redis.',
    });
    await attachEvidenceToKnowledge(evidenced.id, [{
      type: 'file', locator: 'src/queue/driver.ts', observedAt: NOW, relationship: 'supports',
    }]);
    const bare = await repo.createKnowledgeItem(projectId, {
      category: 'fact', title: 'Queue driver', content: 'Background jobs run on Redis.',
    });
    await setUpdatedAt(evidenced.id, OLDER);
    await setUpdatedAt(bare.id, NEWER);

    await applyKnowledgeGc(projectId, { now: NOW });

    expect(await repo.getKnowledgeItem(evidenced.id)).not.toBeNull();
    expect(await listEvidenceForItem(evidenced.id)).toHaveLength(1);
    expect(await repo.getKnowledgeItem(bare.id)).toBeNull();
  });

  it('purges neither when each twin carries something the other lacks', async () => {
    // Nothing here subsumes anything, so there is no redundant copy to collect. Keeping both
    // is recoverable; hard deleting either is not.
    const tagged = await repo.createKnowledgeItem(projectId, {
      category: 'fact', title: 'Deploy target', content: 'The web app deploys to Fly.io.',
      tags: ['deploy'],
    });
    const pathed = await repo.createKnowledgeItem(projectId, {
      category: 'fact', title: 'Deploy target', content: 'The web app deploys to Fly.io.',
      affectedPaths: ['fly.toml'],
    });

    const preview = await previewKnowledgeGc(projectId, { now: NOW });
    expect(preview.candidates.filter(candidate => candidate.action === 'purge')).toHaveLength(0);

    await applyKnowledgeGc(projectId, { now: NOW });
    expect(await repo.getKnowledgeItem(tagged.id)).not.toBeNull();
    expect(await repo.getKnowledgeItem(pathed.id)).not.toBeNull();
  });

  it('still collects a genuinely identical twin', async () => {
    // The guard must not turn duplicate collection off: two copies carrying the same thing
    // are still one copy too many.
    const first = await repo.createKnowledgeItem(projectId, {
      category: 'fact', title: 'Search backend', content: 'Full-text search runs on SQLite FTS5.',
      tags: ['search'],
    });
    const second = await repo.createKnowledgeItem(projectId, {
      category: 'fact', title: 'Search backend', content: 'Full-text search runs on SQLite FTS5.',
      tags: ['search'],
    });
    await setUpdatedAt(first.id, OLDER);
    await setUpdatedAt(second.id, NEWER);

    const preview = await previewKnowledgeGc(projectId, { now: NOW });
    const purged = preview.candidates.filter(candidate => candidate.action === 'purge').map(candidate => candidate.itemId);
    expect(purged).toEqual([first.id]);
  });
});
