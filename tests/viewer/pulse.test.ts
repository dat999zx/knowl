import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, initDb } from '../../src/store/database.js';
import { storeKnowledgeItemDeduped } from '../../src/store/knowledge-writer.js';
import { updateKnowledgeItemWithCommit } from '../../src/store/knowledge-actions.js';
import { recordKnowledgeAccess } from '../../src/store/access-feedback.js';
import { readPulse } from '../../src/store/pulse.js';

/**
 * Written against the same entry points the MCP tools use, not against `repository.ts`.
 * That is load-bearing rather than incidental: `createKnowledgeItem` is a bare row insert
 * and writes NO commit, so a test built on it passes with an empty pulse forever and would
 * have certified a feature that never fires. `knowl_store` reaches
 * `storeKnowledgeItemDeduped` and `knowl_update` reaches `updateKnowledgeItemWithCommit`,
 * and the commit rows this reads exist because those two write them.
 */

const ROOT = path.resolve('.knowl-pulse-test');

const store = (title: string, content: string) =>
  storeKnowledgeItemDeduped('local', { category: 'fact', title, content });

describe('viewer pulse', () => {
  beforeAll(async () => {
    await fs.rm(ROOT, { recursive: true, force: true });
    await fs.mkdir(path.join(ROOT, '.knowl'), { recursive: true });
    await initDb(ROOT);
  });
  afterAll(async () => {
    await closeDb();
    await fs.rm(ROOT, { recursive: true, force: true }).catch(() => {});
  });

  it('reports writes and retrievals after a watermark, and nothing twice', async () => {
    // No watermark is the page's first call: take the heads, report no events. Without this
    // an opening tab replays the entire store as one firework.
    const opened = await readPulse(null, null);
    expect(opened.changes).toEqual([]);
    expect(opened.retrievals).toEqual([]);
    expect(opened.resync).toBe(false);

    const written = await store('Pulse atom', 'Written after the watermark was taken.');

    const afterWrite = await readPulse(opened.commits, opened.access);
    expect(afterWrite.changes).toEqual([{ itemId: written.item.id, action: 'insert' }]);
    expect(afterWrite.commits).toBeGreaterThan(opened.commits);

    // The same watermark must not replay the same commit. This is the property the whole
    // feature rests on -- a repeat means every atom re-animates four times a second.
    const replayed = await readPulse(afterWrite.commits, afterWrite.access);
    expect(replayed.changes).toEqual([]);
    expect(replayed.retrievals).toEqual([]);

    await recordKnowledgeAccess({ itemId: written.item.id, query: 'pulse atom', surface: 'mcp', rank: 0 });
    await recordKnowledgeAccess({ itemId: written.item.id, query: 'pulse atom', surface: 'mcp', rank: 1 });

    const afterRead = await readPulse(replayed.commits, replayed.access);
    // Both hits belong to ONE retrieval, because one query produced them. Reported as two
    // events the graph would flash twice for a single question.
    expect(afterRead.retrievals).toHaveLength(1);
    expect(afterRead.retrievals[0].surface).toBe('mcp');
    expect(afterRead.retrievals[0].hits.map(hit => hit.rank).sort()).toEqual([0, 1]);
  });

  it('excludes feedback rows, which are a verdict on a retrieval and not one', async () => {
    const written = await store('Feedback atom', 'Retrieved once, then judged.');
    const head = await readPulse(null, null);
    await recordKnowledgeAccess({ itemId: written.item.id, surface: 'feedback', rank: 0, used: true });

    const pulse = await readPulse(head.commits, head.access);
    expect(pulse.retrievals).toEqual([]);
    // The watermark still moves past it, or the row is re-read on every tick forever.
    expect(pulse.access).toBeGreaterThan(head.access);
  });

  it('collapses an item to its latest action and reports a status change as that verb', async () => {
    const head = await readPulse(null, null);
    const written = await store('Retired atom', 'Stored, then archived in the same window.');
    await updateKnowledgeItemWithCommit('local', written.item.id, { status: 'archived' });

    const pulse = await readPulse(head.commits, head.access);
    // One entry, not two: an atom inserted and archived inside one tick should animate where
    // it ended up, not both ways at once.
    const mine = pulse.changes.filter(change => change.itemId === written.item.id);
    expect(mine).toHaveLength(1);
    expect(mine[0].action).toBe('archive');
  });

  it('takes the watermark without the events when the backlog bursts', async () => {
    const head = await readPulse(null, null);
    // A background tab has its timers throttled to about one tick a second, so it returns to
    // a delta of hundreds. Played at once that is one frame containing every event, which
    // reads as a fault rather than as activity.
    for (let index = 0; index < 45; index++) {
      await store(`Burst atom ${index}`, `A distinct body for burst atom number ${index}.`);
    }

    const pulse = await readPulse(head.commits, head.access);
    expect(pulse.resync).toBe(true);
    expect(pulse.changes).toEqual([]);
    // The watermark still advances past the backlog. If it did not, the clamp would latch on
    // and the viewer would never animate anything again.
    expect(pulse.commits).toBeGreaterThan(head.commits);
    expect((await readPulse(pulse.commits, pulse.access)).resync).toBe(false);
  });
});
