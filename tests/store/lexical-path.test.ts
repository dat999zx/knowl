import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, getClient, getDb, initDb } from '../../src/store/database.js';
import { releaseAll } from '../../src/store/connection-pool.js';
import * as repo from '../../src/store/repository.js';
import { searchKnowledgeItems } from '../../src/store/search.js';
import { queryKnowledgeBase } from '../../src/store/queries.js';
import type { StoreHandle } from '../../src/store/store-handle.js';
import { DEFAULT_CONFIG, saveConfig } from '../../src/core/config.js';

async function open(root: string) {
  await closeDb();
  await releaseAll();
  await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  await fs.mkdir(path.join(root, '.knowl'), { recursive: true });
  await saveConfig(root, { ...DEFAULT_CONFIG });
  await initDb(root);
  return (await repo.createProject(root, 'p')).id;
}

async function drop(root: string) {
  await closeDb();
  await releaseAll();
  await fs.rm(root, { recursive: true, force: true }).catch(() => {});
}

/**
 * A store handle that counts how many statements the read path issues.
 *
 * `getKnowledgeItem` and `getKnowledgeItems` both go through `db.select()`, so one call per
 * hydrated row versus one call for the whole page is directly observable.
 */
function countingStore(): { store: StoreHandle; selects: () => number } {
  let selects = 0;
  const db = getDb();
  const proxy = new Proxy(db as any, {
    get(target, property, receiver) {
      if (property === 'select') selects += 1;
      return Reflect.get(target, property, receiver);
    },
  });
  return { store: { db: proxy, client: getClient() }, selects: () => selects };
}

describe('the lexical path applies its filters before its LIMIT', () => {
  const ROOT = path.resolve('./.knowl-lexical-tags');

  beforeAll(async () => {
    const projectId = await open(ROOT);
    // 120 untagged matches that outrank the tagged answer lexically: short, dense, all
    // query terms in the title. The tagged answer is long and mentions the phrase once, so
    // BM25 puts it last. Filtering tags after the SQL LIMIT therefore spends the entire
    // candidate window -- at any limit -- on rows it is about to throw away.
    for (let index = 0; index < 120; index += 1) {
      await repo.createKnowledgeItem(projectId, {
        category: 'fact',
        title: `Retention policy retention policy ${index}`,
        content: `Retention policy ${index}.`,
      });
    }
    await repo.createKnowledgeItem(projectId, {
      category: 'fact',
      title: 'Ninety days',
      content: `Records are kept for ninety days under the retention policy. ${'Everything else in this note is about unrelated operational detail. '.repeat(20)}`,
      tags: ['ops-runbook'],
    });
  });

  afterAll(() => drop(ROOT));

  // K-25 -- reproduced at exactly the limits the audit measured.
  it.each([3, 10, 30, 100])('returns the tagged match at limit %i', async (limit) => {
    const found = await searchKnowledgeItems('local', {
      query: 'retention policy', limit, tags: ['ops-runbook'],
    });
    expect(found.map(item => item.title)).toEqual(['Ninety days']);
  });

  // K-25, the other half: the vector path filters tags in SQL, so the two halves must agree
  // on what a tag filter means -- an item without the tag is never a result.
  it('never returns an untagged item for a tagged query', async () => {
    const found = await searchKnowledgeItems('local', {
      query: 'retention policy', limit: 50, tags: ['nobody-has-this'],
    });
    expect(found).toEqual([]);
  });

  it('requires every tag, not any of them', async () => {
    const found = await searchKnowledgeItems('local', {
      query: 'retention policy', limit: 50, tags: ['ops-runbook', 'nobody-has-this'],
    });
    expect(found).toEqual([]);
  });

  // K-46
  it('hydrates a page of hits with one statement, not one per hit', async () => {
    const { store, selects } = countingStore();
    const found = await searchKnowledgeItems('local', { query: 'retention policy', limit: 30 }, store);
    expect(found.length).toBe(30);
    // One batch fetch. N+1 hydration issues 30.
    expect(selects()).toBeLessThanOrEqual(2);
  });
});

describe('the LIKE fallback ranks before it truncates', () => {
  const ROOT = path.resolve('./.knowl-lexical-like');

  beforeAll(async () => {
    const projectId = await open(ROOT);
    // `buildFtsQuery` returns null when every token is a stop word, which is the reachable
    // route into the fallback -- measured, against the comment in queries.ts, which names
    // `package.json` and `/mcp` and is wrong about both (FTS5 tokenizes them and matches).
    //
    // 40 long rows that merely contain the phrase are written FIRST, so rowid order hands
    // back the oldest 40 and the item that answers is never offered to the ranker.
    for (let index = 0; index < 40; index += 1) {
      await repo.createKnowledgeItem(projectId, {
        category: 'fact',
        title: `Deployment note ${index}`,
        content: `A long note about staging and rollout ${index}. Somebody asked where is it `
          + 'and nobody answered, and then the thread went on at length about entirely '
          + 'different concerns none of which resolve anything at all. '.repeat(8),
      });
    }
    await repo.createKnowledgeItem(projectId, {
      category: 'fact',
      title: 'The tunnel config: where is it',
      content: 'Where is it: /etc/cloudflared/config.yml.',
    });
  });

  afterAll(() => drop(ROOT));

  // K-27
  it('hands the best match to the caller even when it was written last', async () => {
    const found = await queryKnowledgeBase('local', { query: 'where is it', limit: 10 });
    expect(found).toHaveLength(10);
    expect(found[0].title).toBe('The tunnel config: where is it');
  });

  it('still returns every match when the caller asks for them all', async () => {
    const found = await queryKnowledgeBase('local', { query: 'where is it', limit: 41 });
    expect(found).toHaveLength(41);
    expect(found[0].title).toBe('The tunnel config: where is it');
  });
});

describe('FTS5 bm25()', () => {
  const ROOT = path.resolve('./.knowl-lexical-bm25');

  beforeAll(async () => {
    const projectId = await open(ROOT);
    for (let index = 0; index < 200; index += 1) {
      await repo.createKnowledgeItem(projectId, {
        category: 'fact', title: `filler ${index}`, content: `filler body ${index} about nothing at all`,
      });
    }
    await repo.createKnowledgeItem(projectId, { category: 'fact', title: 'zephyr short', content: 'zephyr' });
    await repo.createKnowledgeItem(projectId, {
      category: 'fact', title: 'zephyr long', content: `zephyr ${'padding word '.repeat(300)}`,
    });
  });

  afterAll(() => drop(ROOT));

  it('is negative, more negative for a better match, and length-normalised', async () => {
    // The sign was inferred from `ORDER BY score ASC` and never measured. The convex
    // combination now consumes the number itself, so it is asserted rather than assumed.
    const rows = await (getDb() as any).all(
      `SELECT bm25(knowledge_items_fts) AS score, i.title AS title
       FROM knowledge_items_fts JOIN knowledge_items i ON i.id = knowledge_items_fts.item_id
       WHERE knowledge_items_fts MATCH 'zephyr*' ORDER BY score ASC`,
    ) as Array<{ score: number; title: string }>;

    expect(rows.map(row => row.title)).toEqual(['zephyr short', 'zephyr long']);
    expect(rows[0].score).toBeLessThan(0);
    expect(rows[1].score).toBeLessThan(0);
    // The same single occurrence, in a one-word document and in a 600-word one.
    expect(rows[0].score).toBeLessThan(rows[1].score);
  });
});
