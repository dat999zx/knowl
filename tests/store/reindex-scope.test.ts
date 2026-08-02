import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { closeDb, getClient, initDb } from '../../src/store/database.js';
import * as repo from '../../src/store/repository.js';
import { reindexKnowledgeEmbeddings } from '../../src/store/vector-index.js';
import { fingerprintProfile } from '../../src/core/vector-profile.js';

// One directory per test: on Windows the previous database file can still be locked
// when the next test starts, and a silently failed cleanup would carry its items over.
let testRoot = '';
let testIndex = 0;
const PROFILE = { provider: 'local', model: 'a/b', dtype: 'q8', pooling: 'cls' } as const;

function stubEmbedder() {
  return {
    provider: 'local',
    model: 'a/b',
    pooling: 'cls' as const,
    profileFingerprint: fingerprintProfile(PROFILE),
    embed: async (texts: string[]) => texts.map(() => [1, 0, 0]),
  };
}

let projectId: string;

async function seedItemsWithStatuses(statuses: string[]) {
  for (const [index, status] of statuses.entries()) {
    const item = await repo.createKnowledgeItem(projectId, {
      category: 'fact', title: `item ${index}`, content: `body ${index}`,
    });
    if (status !== 'active') {
      await getClient().execute({
        sql: 'UPDATE knowledge_items SET status = ? WHERE id = ?',
        args: [status, item.id],
      });
    }
  }
  return { projectId };
}

/** Raw batched inserts: 10k items through the public API would dominate the runtime. */
async function seedManyItems(total: number) {
  const now = new Date().toISOString();
  const client = getClient();
  const batchSize = 500;

  await client.execute('BEGIN');
  for (let start = 0; start < total; start += batchSize) {
    const count = Math.min(batchSize, total - start);
    const args: unknown[] = [];
    for (let offset = 0; offset < count; offset++) {
      const index = start + offset;
      args.push(`bulk-${String(index).padStart(6, '0')}`, 'fact', 'active', `bulk ${index}`, 'body', now, now);
    }
    await client.execute({
      sql: `INSERT INTO knowledge_items (id, category, status, title, content, created_at, updated_at)
            VALUES ${Array.from({ length: count }, () => '(?, ?, ?, ?, ?, ?, ?)').join(', ')}`,
      args: args as any[],
    });
  }
  await client.execute('COMMIT');

  return { projectId };
}

async function writeEmbeddingWithFingerprint(_projectId: string, fingerprint: string) {
  const item = await repo.createKnowledgeItem(projectId, {
    category: 'fact', title: 'previously embedded', content: 'old profile',
  });
  await getClient().execute({
    sql: `INSERT INTO knowledge_embeddings (knowledge_item_id, provider, model, profile_fingerprint, dimensions, vector, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)`,
    args: [item.id, 'local', 'old/model', fingerprint, 3, JSON.stringify([0, 1, 0]), new Date().toISOString()],
  });
}

async function countEmbeddingsWithFingerprint(_projectId: string, fingerprint: string) {
  const rows = await getClient().execute({
    sql: 'SELECT COUNT(*) AS total FROM knowledge_embeddings WHERE profile_fingerprint = ?',
    args: [fingerprint],
  });
  return Number((rows.rows[0] as any).total ?? 0);
}

describe('reindex scope', () => {
  beforeEach(async () => {
    testRoot = path.resolve(`./.knowl-test-reindex-scope-${testIndex++}`);
    await fs.rm(testRoot, { recursive: true, force: true }).catch(() => {});
    await fs.mkdir(path.join(testRoot, '.knowl'), { recursive: true });
    await initDb(testRoot);
    const project = await repo.createProject(testRoot, 'reindex fixture');
    projectId = project.id;
  });

  afterEach(async () => {
    await closeDb();
    await fs.rm(testRoot, { recursive: true, force: true }).catch(() => {});
  });

  it('re-embeds items in every status, not only active', async () => {
    await seedItemsWithStatuses(['active', 'superseded', 'archived']);

    const result = await reindexKnowledgeEmbeddings(projectId, stubEmbedder());

    expect(result.indexed).toBe(3);
    expect(result.byStatus).toEqual({ active: 1, superseded: 1, archived: 1 });
  });

  it('pages past the old 10,000 ceiling', async () => {
    await seedManyItems(10_050);
    const result = await reindexKnowledgeEmbeddings(projectId, stubEmbedder());
    expect(result.indexed).toBe(10_050);
  });

  it('purges rows left over from a previous profile', async () => {
    await seedItemsWithStatuses(['active']);
    await writeEmbeddingWithFingerprint(projectId, 'stale-fingerprint');

    const result = await reindexKnowledgeEmbeddings(projectId, stubEmbedder());

    expect(result.purged).toBeGreaterThanOrEqual(0);
    expect(await countEmbeddingsWithFingerprint(projectId, 'stale-fingerprint')).toBe(0);
  });
});
