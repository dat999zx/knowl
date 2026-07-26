import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, getClient, initDb } from '../../src/store/database.js';
import { releaseAll } from '../../src/store/connection-pool.js';
import * as repo from '../../src/store/repository.js';
import { storeKnowledgeItemDeduped } from '../../src/store/knowledge-writer.js';
import { promoteItems } from '../../src/workspace/promote.js';

const ROOT = path.resolve('./.knowl-promote-test');

async function readRows(sql: string): Promise<Array<Record<string, unknown>>> {
  await initDb(ROOT);
  try {
    return (await getClient().execute(sql)).rows as unknown as Array<Record<string, unknown>>;
  } finally {
    await closeDb();
  }
}

async function execute(sql: string): Promise<void> {
  await initDb(ROOT);
  try {
    await getClient().execute(sql);
  } finally {
    await closeDb();
  }
}

describe('promote', () => {
  let ids: { decision: string; fact: string };

  beforeEach(async () => {
    await closeDb();
    await releaseAll();
    await fs.rm(ROOT, { recursive: true, force: true }).catch(() => {});
    await fs.mkdir(path.join(ROOT, '.knowl'), { recursive: true });
    await initDb(ROOT);
    // Wipe the tables rather than trusting the directory removal: on Windows libSQL can
    // hold the file, the rm is silently refused, and a surviving row from the previous test
    // then dedups the seed away -- leaving stale visibility behind and failing the next
    // assertion for the wrong reason.
    await getClient().execute('DELETE FROM knowledge_commits');
    await getClient().execute('DELETE FROM knowledge_items');
    const projectId = (await repo.createProject(ROOT, 'promote')).id;
    const decision = await storeKnowledgeItemDeduped(projectId, {
      category: 'decision', title: 'Wire format is protobuf',
      content: 'Server and client exchange protobuf, not JSON.',
    });
    const fact = await storeKnowledgeItemDeduped(projectId, {
      category: 'fact', title: 'Local scratch note',
      content: 'A scratch observation that should stay in this repo.',
    });
    await getClient().execute("UPDATE knowledge_items SET origin_repo = 'server'");
    await closeDb();
    ids = { decision: decision.item.id, fact: fact.item.id };
  });

  afterEach(async () => {
    await closeDb();
    await releaseAll();
    await fs.rm(ROOT, { recursive: true, force: true }).catch(() => {});
  });

  it('dry-runs by default and changes nothing', async () => {
    const result = await promoteItems({ projectRoot: ROOT, repoName: 'server', categories: ['decision'] });
    expect(result.applied).toBe(false);
    expect(result.items.map(item => item.title)).toEqual(['Wire format is protobuf']);

    const rows = await readRows("SELECT COUNT(*) AS n FROM knowledge_items WHERE visibility = 'workspace'");
    expect(Number(rows[0].n)).toBe(0);
  });

  it('promotes by category when applied', async () => {
    await promoteItems({ projectRoot: ROOT, repoName: 'server', categories: ['decision'], apply: true });
    const rows = await readRows("SELECT title FROM knowledge_items WHERE visibility = 'workspace'");
    expect(rows.map(row => String(row.title))).toEqual(['Wire format is protobuf']);
  });

  it('promotes by id', async () => {
    await promoteItems({ projectRoot: ROOT, repoName: 'server', ids: [ids.fact], apply: true });
    const rows = await readRows("SELECT title FROM knowledge_items WHERE visibility = 'workspace'");
    expect(rows.map(row => String(row.title))).toEqual(['Local scratch note']);
  });

  it('refuses items this repo did not originate, and says how many', async () => {
    await execute("UPDATE knowledge_items SET origin_repo = 'web' WHERE category = 'decision'");
    const result = await promoteItems({ projectRoot: ROOT, repoName: 'server', categories: ['decision'], apply: true });
    expect(result.items).toEqual([]);
    expect(result.skippedForeign).toBe(1);
  });

  it('does not change content_hash or item count -- promotion is a visibility change', async () => {
    const before = await readRows('SELECT id, content_hash FROM knowledge_items ORDER BY id');
    await promoteItems({ projectRoot: ROOT, repoName: 'server', categories: ['decision'], apply: true });
    const after = await readRows('SELECT id, content_hash FROM knowledge_items ORDER BY id');

    expect(after.length).toBe(before.length);
    expect(after.map(row => String(row.content_hash))).toEqual(before.map(row => String(row.content_hash)));
  });

  it('is idempotent', async () => {
    await promoteItems({ projectRoot: ROOT, repoName: 'server', categories: ['decision'], apply: true });
    const second = await promoteItems({ projectRoot: ROOT, repoName: 'server', categories: ['decision'], apply: true });
    expect(second.items.length).toBe(0);
  });

  it('requires a category or an id, so a bare promote cannot publish everything', async () => {
    await expect(promoteItems({ projectRoot: ROOT, repoName: 'server', apply: true }))
      .rejects.toThrow(/--category|--id/);
  });
});
