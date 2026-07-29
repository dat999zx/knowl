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

  it('promotes an item written after linking, which carries no owner yet', async () => {
    // Ownership is only ever stamped by the join-time backfill, so everything written
    // afterwards -- the normal case -- has origin_repo NULL. This used to be counted as
    // foreign, which made promote unreachable for it: "Nothing to promote. 1 matching
    // item(s) belong to another repo."
    await execute('UPDATE knowledge_items SET origin_repo = NULL');

    const result = await promoteItems({ projectRoot: ROOT, repoName: 'server', categories: ['decision'], apply: true });

    expect(result.skippedForeign).toBe(0);
    expect(result.items.map(item => item.title)).toEqual(['Wire format is protobuf']);

    // Promoting claims it, so it is owned from here on rather than staying unowned.
    const rows = await readRows("SELECT origin_repo FROM knowledge_items WHERE visibility = 'workspace'");
    expect(rows.map(row => String(row.origin_repo))).toEqual(['server']);
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

  it('records a commit, so other repos can see the promotion happened', async () => {
    await promoteItems({ projectRoot: ROOT, repoName: 'server', categories: ['decision'], apply: true });

    const rows = await readRows('SELECT message, changes FROM knowledge_commits ORDER BY rowid DESC LIMIT 1');
    expect(String(rows[0].message)).toMatch(/Promote 1 item/);
    const changes = JSON.parse(String(rows[0].changes));
    expect(changes).toHaveLength(1);
    expect(changes[0].itemId).toBe(ids.decision);
    expect(changes[0].after.title).toBe('Wire format is protobuf');
  });

  it('records no commit for a dry run or an empty promote', async () => {
    const before = await readRows('SELECT COUNT(*) AS n FROM knowledge_commits');
    await promoteItems({ projectRoot: ROOT, repoName: 'server', categories: ['decision'] });
    await promoteItems({ projectRoot: ROOT, repoName: 'server', ids: ['does-not-exist'], apply: true });
    const after = await readRows('SELECT COUNT(*) AS n FROM knowledge_commits');

    expect(Number(after[0].n)).toBe(Number(before[0].n));
  });

  it('requires a category or an id, so a bare promote cannot publish everything', async () => {
    await expect(promoteItems({ projectRoot: ROOT, repoName: 'server', apply: true }))
      .rejects.toThrow(/--category|--id/);
  });
});
