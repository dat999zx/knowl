import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, getClient, initDb } from '../../src/store/database.js';
import { releaseAll } from '../../src/store/connection-pool.js';
import * as repo from '../../src/store/repository.js';
import { hashKnowledgeContent } from '../../src/store/freshness.js';
import { resetWriteOwnershipCache } from '../../src/store/write-ownership.js';

const ROOT = path.resolve('./.knowl-content-hash-test');

/** The hash the stored row deserves, computed from the row itself. */
async function hashOfStoredRow(id: string): Promise<{ stored: string | null; expected: string }> {
  const row = (await getClient().execute({
    sql: 'SELECT title, content, reasoning, source, affected_paths, content_hash FROM knowledge_items WHERE id = ?',
    args: [id],
  })).rows[0];

  const affectedPaths = row.affected_paths === null || row.affected_paths === undefined
    ? null
    : JSON.parse(String(row.affected_paths));

  return {
    stored: row.content_hash === null ? null : String(row.content_hash),
    expected: hashKnowledgeContent({
      title: String(row.title),
      content: String(row.content),
      reasoning: row.reasoning === null ? null : String(row.reasoning),
      source: row.source === null ? null : String(row.source),
      affectedPaths,
    }),
  };
}

describe('content_hash describes the row it is stored beside', () => {
  let projectId = '';
  beforeAll(async () => {
    await closeDb();
    await releaseAll();
    resetWriteOwnershipCache();
    await fs.rm(ROOT, { recursive: true, force: true }).catch(() => {});
    await fs.mkdir(path.join(ROOT, '.knowl'), { recursive: true });
    await initDb(ROOT);
    projectId = (await repo.createProject(ROOT, 'content-hash')).id;
  });
  afterAll(async () => {
    await closeDb();
    await releaseAll();
    await fs.rm(ROOT, { recursive: true, force: true }).catch(() => {});
  });

  it('matches on a fresh write', async () => {
    const item = await repo.createKnowledgeItem(projectId, {
      category: 'fact',
      title: 'Cache TTL is sixty seconds',
      content: 'Product cache entries expire after a minute.',
      reasoning: 'Measured against the staging cluster.',
      source: 'docs/cache.md',
      affectedPaths: ['src/cache.ts'],
    });

    const { stored, expected } = await hashOfStoredRow(item.id);
    expect(stored).toBe(expected);
  });

  it('matches after a field is cleared to null', async () => {
    // The merge that feeds the hash used `updates.x ?? current.x`, which cannot distinguish
    // "not mentioned" from "cleared". Clearing `reasoning` wrote NULL to the row and hashed
    // the OLD reasoning, so the stored hash described a row that no longer existed. Import
    // classifies an item as `identical` on this hash and skips it, and drift compares against
    // it, so both trust a fingerprint of the previous value indefinitely.
    const item = await repo.createKnowledgeItem(projectId, {
      category: 'fact',
      title: 'Queue driver is Redis',
      content: 'Background jobs run on Redis.',
      reasoning: 'Chosen over SQS for local development.',
      source: 'docs/queue.md',
    });

    const cleared = await repo.updateKnowledgeItem(item.id, { reasoning: null, source: null });
    expect(cleared.reasoning).toBeNull();
    expect(cleared.source).toBeNull();

    const { stored, expected } = await hashOfStoredRow(item.id);
    expect(stored).toBe(expected);
  });

  it('matches after a field is replaced rather than cleared', async () => {
    const item = await repo.createKnowledgeItem(projectId, {
      category: 'fact',
      title: 'Search backend is FTS5',
      content: 'Full-text search runs on SQLite FTS5.',
      reasoning: 'Ships with the driver.',
    });

    await repo.updateKnowledgeItem(item.id, { reasoning: 'No external service to operate.' });

    const { stored, expected } = await hashOfStoredRow(item.id);
    expect(stored).toBe(expected);
  });
});
