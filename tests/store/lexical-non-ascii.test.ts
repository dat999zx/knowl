import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, initDb } from '../../src/store/database.js';
import { releaseAll } from '../../src/store/connection-pool.js';
import * as repo from '../../src/store/repository.js';
import { searchKnowledgeItemsRanked } from '../../src/store/search.js';
import { DEFAULT_CONFIG, saveConfig } from '../../src/core/config.js';

/**
 * The lexical half has to be able to see a word that is not spelled in ASCII.
 *
 * `queryTokenGroups` split the query on `/[^a-z0-9_]+/`, which makes every letter outside
 * `a-z` a SEPARATOR rather than a character. Measured on the Vietnamese arm of
 * `docs/evals/multilingual.md`: `hành vi của cờ đánh dấu đã xóa` tokenised to
 * `["nh", "vi", "nh"]` -- eight words reduced to three fragments, one of them a duplicate --
 * and a query whose every word is short enough to be shredded below the two-character
 * minimum produced NO tokens at all, so `buildFtsQuery` returned null and the lexical path
 * returned nothing for a query that names the stored item almost exactly.
 *
 * `src/transcripts/search.ts` already tokenises with `\p{L}\p{N}_`; this is the half of the
 * codebase that disagreed. Blast radius on the real 482-item store: 5 items (1.0%) tokenise
 * differently, in every case an accented word that used to break into fragments
 * (`hambüchen` was `hamb` + `chen`) and is now one token.
 */
describe('the lexical path tokenises non-ASCII letters as letters', () => {
  const ROOT = path.resolve('./.knowl-lexical-non-ascii');
  let projectId: string;

  beforeAll(async () => {
    await closeDb();
    await releaseAll();
    await fs.rm(ROOT, { recursive: true, force: true }).catch(() => {});
    await fs.mkdir(path.join(ROOT, '.knowl'), { recursive: true });
    await saveConfig(ROOT, { ...DEFAULT_CONFIG });
    await initDb(ROOT);
    projectId = (await repo.createProject(ROOT, 'p')).id;

    await repo.createKnowledgeItem(projectId, {
      category: 'architecture',
      title: 'Cờ đã xóa',
      content: 'Bản ghi mang một cờ đã xóa thay vì bị loại bỏ khỏi bảng.',
      tags: ['persistence'],
    });
    await repo.createKnowledgeItem(projectId, {
      category: 'architecture',
      title: 'Rows are flagged, never dropped',
      content: 'Records carry a deleted_at timestamp so an accidental delete is undone.',
      tags: ['persistence'],
    });
  });

  afterAll(async () => {
    await closeDb();
    await releaseAll();
    await fs.rm(ROOT, { recursive: true, force: true }).catch(() => {});
  });

  it('finds a Vietnamese item from a Vietnamese query whose words are all non-ASCII', async () => {
    // Every word here shreds to nothing under an ASCII-only split: `cờ` -> `c`, `đã` -> ``,
    // `xóa` -> `x` + `a`, all below the two-character minimum. The query then had zero tokens.
    const hits = await searchKnowledgeItemsRanked(projectId, { query: 'cờ đã xóa', limit: 10 });

    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].item.title).toBe('Cờ đã xóa');
  });

  it('counts a non-ASCII word as one covered term rather than as fragments', async () => {
    const [hit] = await searchKnowledgeItemsRanked(projectId, { query: 'cờ đã xóa', limit: 10 });

    // Three distinct query terms, all present in the item. Fragments cannot express this:
    // coverage was being computed over the same shredded token set.
    expect(hit.coverage).toBe(1);
  });

  it('leaves an ASCII query alone', async () => {
    const hits = await searchKnowledgeItemsRanked(projectId, { query: 'deleted_at flag', limit: 10 });

    expect(hits[0].item.title).toBe('Rows are flagged, never dropped');
  });
});
