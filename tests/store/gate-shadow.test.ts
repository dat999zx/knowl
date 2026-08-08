import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, getClient, initDb } from '../../src/store/database.js';
import { countShadowBlocks, recordShadowBlock, shadowGatePrecision } from '../../src/store/gate-shadow.js';

/**
 * The record of what an enforcing write gate would have refused, and the number it exists to
 * produce.
 *
 * Everything here is about the *denominator*. Shadow mode's whole purpose is to let plan §9's
 * ≥95%-over-≥40-findings bar be measured before the gate is allowed to block anything, so the two
 * ways this could quietly lie are the two things worth pinning: counting the same stale belief
 * more than once, and counting an unadjudicated finding as a correct one.
 */

const ROOT = path.join(os.tmpdir(), `knowl-gate-shadow-${process.pid}`);
const AT = '2026-08-08T00:00:00.000Z';

/**
 * A finding, written directly rather than through the detector.
 *
 * Real rather than a bare id, because the precision query joins `impact_findings` -- a fake id
 * would join to nothing, measure nothing, and let a broken query pass. `affected_id` carries the
 * read-set row id the same way `detectCertainImpact` writes it.
 */
async function seedFinding(id: string, resolution: string | null): Promise<void> {
  await getClient().execute({
    sql: `INSERT INTO impact_findings
            (id, cause_locator, cause_session, affected_kind, affected_id, tier, path_json, detected_at, delivered_at, resolution, resolved_at)
          VALUES (?, 'symbol://src/a.ts#createSession', 'other-session', 'work', ?, 'certain', NULL, ?, NULL, ?, ?)`,
    args: [id, `read-${id}`, AT, resolution, resolution ? '2026-08-08T01:00:00.000Z' : null],
  });
}

describe('gate shadow log', () => {
  // One database for the file, emptied between tests rather than recreated. Tearing the store
  // down per test fails on Windows with EBUSY: libSQL's handle, and its -shm/-wal siblings, are
  // not always released by the time `rm` reaches them. `impact-schema.test.ts` is shaped the same
  // way for the same reason.
  beforeAll(async () => {
    await fs.rm(ROOT, { recursive: true, force: true });
    await fs.mkdir(path.join(ROOT, '.knowl'), { recursive: true });
    await initDb(ROOT);
  });

  afterAll(async () => {
    await closeDb();
    await fs.rm(ROOT, { recursive: true, force: true }).catch(() => {});
  });

  beforeEach(async () => {
    await getClient().execute('DELETE FROM impact_gate_shadow');
    await getClient().execute('DELETE FROM impact_findings');
  });

  it('records a belief once and reports the repeat as not written', async () => {
    await seedFinding('f1', null);

    expect(await recordShadowBlock({ findingId: 'f1', sessionId: 's1', targetPath: 'src/a.ts' })).toBe(true);
    // The same belief, reached from a different write. Shadow mode does not release the read-set
    // row, so this is the ordinary case rather than an error: the finding is still open and still
    // live, and it will arrive again on every subsequent write to that file.
    expect(await recordShadowBlock({ findingId: 'f1', sessionId: 's1', targetPath: 'src/b.ts' })).toBe(false);
    expect(await countShadowBlocks()).toBe(1);
  });

  it('records distinct beliefs separately', async () => {
    await seedFinding('f1', null);
    await seedFinding('f2', null);

    expect(await recordShadowBlock({ findingId: 'f1', sessionId: 's1', targetPath: 'src/a.ts' })).toBe(true);
    expect(await recordShadowBlock({ findingId: 'f2', sessionId: 's1', targetPath: 'src/a.ts' })).toBe(true);
    expect(await countShadowBlocks()).toBe(2);
  });

  it('computes precision from the findings the rows point at', async () => {
    await seedFinding('f1', 'repaired');
    await seedFinding('f2', 'false_positive');
    await seedFinding('f3', 'dismissed');
    for (const id of ['f1', 'f2', 'f3']) {
      await recordShadowBlock({ findingId: id, sessionId: 's1', targetPath: 'src/a.ts' });
    }

    const result = await shadowGatePrecision();
    expect(result.adjudicated).toBe(3);
    expect(result.falsePositives).toBe(1);
    expect(result.precision).toBeCloseTo(2 / 3, 10);
  });

  /**
   * Unresolved findings leave both halves alone rather than counting as correct.
   *
   * Assuming an unadjudicated block was justified is exactly how a precision number talks its way
   * past the bar it was meant to clear -- and since nothing forces adjudication, the unresolved
   * set is the *larger* one early on.
   */
  it('excludes unresolved findings from both halves', async () => {
    await seedFinding('f1', 'false_positive');
    await seedFinding('f2', null);
    await recordShadowBlock({ findingId: 'f1', sessionId: 's1', targetPath: 'src/a.ts' });
    await recordShadowBlock({ findingId: 'f2', sessionId: 's1', targetPath: 'src/a.ts' });

    const result = await shadowGatePrecision();
    expect(await countShadowBlocks()).toBe(2);
    expect(result.adjudicated).toBe(1);
    expect(result.falsePositives).toBe(1);
    expect(result.precision).toBe(0);
  });

  it('reports null precision rather than a perfect score when nothing is adjudicated', async () => {
    await seedFinding('f1', null);
    await recordShadowBlock({ findingId: 'f1', sessionId: 's1', targetPath: 'src/a.ts' });

    const result = await shadowGatePrecision();
    expect(result.adjudicated).toBe(0);
    expect(result.falsePositives).toBe(0);
    // No evidence is not a perfect score. Returning 1 here would let an untouched install report
    // that it had cleared a ≥95% bar it has not measured at all.
    expect(result.precision).toBeNull();
  });

  it('returns false rather than throwing on input it will not store', async () => {
    // Same contract as `recordReadBestEffort`: this runs inside the PreToolUse path with a host
    // blocked on the answer, and the entire promise of shadow mode is that it cannot affect the
    // write. A lost measurement beats a broken tool call.
    expect(await recordShadowBlock({ findingId: '', sessionId: 's1', targetPath: 'src/a.ts' })).toBe(false);
    expect(await recordShadowBlock({ findingId: 'f1', sessionId: '', targetPath: 'src/a.ts' })).toBe(false);
    expect(await recordShadowBlock({ findingId: 'f1', sessionId: 's1', targetPath: '   ' })).toBe(false);
    expect(await countShadowBlocks()).toBe(0);
  });

  it('survives the store being closed underneath it', async () => {
    await seedFinding('f1', null);
    await closeDb();

    expect(await recordShadowBlock({ findingId: 'f1', sessionId: 's1', targetPath: 'src/a.ts' })).toBe(false);

    await initDb(ROOT);
  });
});
