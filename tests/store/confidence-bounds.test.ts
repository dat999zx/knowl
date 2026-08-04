import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, getClient, initDb } from '../../src/store/database.js';
import { releaseAll } from '../../src/store/connection-pool.js';
import * as repo from '../../src/store/repository.js';
import { storeKnowledgeAtomsDeduped, storeKnowledgeItemDeduped } from '../../src/store/knowledge-writer.js';
import { resetWriteOwnershipCache } from '../../src/store/write-ownership.js';
import { compactKnowledgeItem } from '../../src/core/token-budget.js';

let counter = 0;
let ROOT = '';

async function storedConfidences(): Promise<number[]> {
  const result = await getClient().execute('SELECT confidence FROM knowledge_items ORDER BY created_at');
  return result.rows.map(row => Number(row.confidence));
}

/**
 * K-21's residual. Lane 1 bounded `confidence` in the MCP tool schema, which covers exactly one
 * of the doors into the store: every CLI, hook and in-process caller reaches
 * `knowledge-writer.ts` without passing that schema, and a value written there is permanent.
 *
 * Refused rather than clamped, and the store told us which. Across five real stores on this
 * machine (764 items) every confidence sits in [0.70, 1.00] and 487 of them are exactly 1.00 --
 * so clamping a percent-scale 90 to 1 would not merely round it, it would move a caller who
 * meant "less sure than usual" to the most confident value the store holds, tied with the
 * default. Refusal is the only outcome the caller can act on.
 */
describe('confidence is bounded where it is stored, not only at the MCP boundary', () => {
  let projectId = '';
  beforeEach(async () => {
    await closeDb();
    await releaseAll();
    resetWriteOwnershipCache();
    counter += 1;
    ROOT = path.resolve(`./.knowl-confidence-bounds${counter}`);
    await fs.rm(ROOT, { recursive: true, force: true }).catch(() => {});
    await fs.mkdir(path.join(ROOT, '.knowl'), { recursive: true });
    await initDb(ROOT);
    projectId = (await repo.createProject(ROOT, 'confidence-bounds')).id;
  });
  afterEach(async () => {
    await closeDb();
    await releaseAll();
    await fs.rm(ROOT, { recursive: true, force: true }).catch(() => {});
  });

  it('refuses a percent-scale confidence on the single-atom write path', async () => {
    await expect(storeKnowledgeItemDeduped(projectId, {
      category: 'fact',
      title: 'Percent scale confidence',
      content: 'A model emitting 0-100 rather than 0-1 writes 99 here.',
      confidence: 99,
    })).rejects.toThrow(/confidence/i);

    expect(await storedConfidences()).toEqual([]);
  });

  it('refuses the whole batch before any atom is written', async () => {
    await expect(storeKnowledgeAtomsDeduped(projectId, [
      { category: 'fact', title: 'First atom is fine', content: 'This one is in range.', confidence: 0.9 },
      { category: 'fact', title: 'Second atom is out of range', content: 'This one is on a percent scale.', confidence: 999 },
    ])).rejects.toThrow(/confidence/i);

    // Not "the bad atom was skipped" -- nothing at all, the same all-or-nothing contract the
    // batch writer already holds for oversized fields and exclusive conflicts.
    expect(await storedConfidences()).toEqual([]);
  });

  it('refuses negative and non-finite confidence', async () => {
    for (const confidence of [-0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(storeKnowledgeItemDeduped(projectId, {
        category: 'fact',
        title: `Confidence ${String(confidence)}`,
        content: 'Out of range in a different direction.',
        confidence,
      })).rejects.toThrow(/confidence/i);
    }
    expect(await storedConfidences()).toEqual([]);
  });

  it('leaves every legitimate value alone, including the boundaries', async () => {
    const legitimate = [0, 0.5, 0.75, 1];
    for (const confidence of legitimate) {
      await storeKnowledgeItemDeduped(projectId, {
        category: 'fact',
        title: `Legitimate confidence ${confidence}`,
        content: `An ordinary write recording ${confidence} as its confidence.`,
        confidence,
      });
    }
    expect(await storedConfidences()).toEqual(legitimate);

    // Omitted still means "not specified", which the repository defaults to 1.0. Refusing an
    // absent value would break every caller that never had an opinion.
    await storeKnowledgeItemDeduped(projectId, {
      category: 'fact', title: 'No opinion about confidence', content: 'This write does not mention confidence at all.',
    });
    expect(await storedConfidences()).toEqual([...legitimate, 1]);
  });

  // The residual the writer-level guard does NOT close, recorded so it is not mistaken for
  // closed: `repository.createKnowledgeItem` is the actual column write and several callers
  // reach it directly (pipeline/merge.ts, portability import, session-handoff). A value that
  // arrives that way is still unbounded, and it reaches the agent verbatim -- the compact MCP
  // shape passes `confidence` straight through, so an agent is shown a number on a scale the
  // response never declares.
  it('documents the repository-level door the writer guard does not cover', async () => {
    const item = await repo.createKnowledgeItem(projectId, {
      category: 'fact', title: 'Written under the writer', content: 'Straight through the repository.', confidence: 999,
    });
    expect(item.confidence).toBe(999);
    expect(compactKnowledgeItem(item).confidence).toBe(999);
  });
});
