import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { governingDecisionForWrite, zScore } from '../../src/store/governing-decision.js';
import type { KnowledgeItem } from '../../src/core/types.js';

function item(overrides: Partial<KnowledgeItem> = {}): KnowledgeItem {
  return {
    id: 'item-1',
    category: 'fact',
    status: 'active',
    title: 'Recommend stripping the MCP tool-argument descriptions to save tokens',
    content: 'The serialized tool payload is 6,936 tokens; dropping argument prose saves 35%.',
    ...overrides,
  } as KnowledgeItem;
}

describe('governingDecisionForWrite', () => {
  // The whole point of an advisory is that it cannot cost you the write. Every failure path in
  // this module -- no project, no config, no embedder, model not on disk, vector search
  // unavailable -- has to come back as "no opinion" rather than as an exception, because it runs
  // inside knowl_store's result envelope. A throw here would turn a missing model into a failed
  // write, which is a far worse bug than the one the guard exists to catch.
  it('returns no opinion instead of throwing when there is no usable project', async () => {
    await expect(governingDecisionForWrite('project-that-does-not-exist', item()))
      .resolves.toBeUndefined();
  });

  it('stays silent when write-time embedding is switched off', async () => {
    const previous = process.env.KNOWL_DISABLE_WRITE_EMBEDDING;
    process.env.KNOWL_DISABLE_WRITE_EMBEDDING = '1';
    try {
      await expect(governingDecisionForWrite('any-project', item())).resolves.toBeUndefined();
    } finally {
      if (previous === undefined) delete process.env.KNOWL_DISABLE_WRITE_EMBEDDING;
      else process.env.KNOWL_DISABLE_WRITE_EMBEDDING = previous;
    }
  });
});

describe('zScore', () => {
  // The fallback for profiles with no calibrated constant. 3.32 is the firing bar.
  const flat = (n: number, value: number) => Array.from({ length: n }, () => value);

  it('scores a clear outlier above the firing bar, given a pool big enough to reach it', () => {
    const pool = [...flat(39, 0.30), 0.90];
    expect(zScore(pool, 0.90)).toBeGreaterThan(3.32);
  });

  /**
   * The arithmetic that made the first version of this suite fail, pinned so it cannot be
   * rediscovered the hard way.
   *
   * One value above n-1 identical others scores at most sqrt(n-1), so the firing bar is simply
   * UNREACHABLE in a small pool: exactly 3.0 at n=10 against a bar of 3.32. A guard whose
   * threshold cannot be met does not fail loudly, it just never fires — which reads exactly like
   * a guard that found nothing. `MIN_POOL_FOR_Z` exists so that silence is a decision rather
   * than an accident.
   *
   * The ceiling is asserted as well as the consequence, because the first version of this test
   * had the formula wrong ((n-1)/sqrt(n)) and still "passed" its inequality. Pinning the exact
   * value is what makes a wrong derivation fail instead of merely being unlucky.
   */
  it('cannot reach the firing bar at all in a small pool, however perfect the match', () => {
    const perfect = [...flat(9, 0.0), 1.0];
    expect(zScore(perfect, 1.0)).toBeCloseTo(Math.sqrt(9), 10);
    expect(zScore(perfect, 1.0)).toBeLessThan(3.32);
  });

  it('keeps a merely-best-of-a-flat-field below the bar', () => {
    // The failure this guards: in a pool where everything is similar, SOMETHING is always top.
    // Rank alone would fire every time; the spread is what says whether being top means
    // anything. 0.62 leads this field and must not clear the bar.
    const pool = [0.60, 0.58, 0.61, 0.59, 0.62, 0.57, 0.60, 0.61, 0.58, 0.59];
    expect(zScore(pool, 0.62)).toBeLessThan(3.32);
  });

  it('abstains on a pool with no spread rather than dividing by nearly nothing', () => {
    // Identical scores make the standard deviation ~0, and a naive (top - mean) / sd turns
    // floating-point dust into an enormous z. Abstaining is the honest answer: a pool that
    // cannot distinguish its members cannot tell you its top one is special.
    expect(zScore([0.5, 0.5, 0.5, 0.5], 0.5)).toBe(0);
  });

  it('abstains rather than scoring a pool too small to have a distribution', () => {
    expect(zScore([0.9], 0.9)).toBe(0);
  });
});

/**
 * `scripts/calibrate-governing-decision.ts` refuses to fit a constant below its own
 * `MIN_DECISIONS`, and this module abstains below `MIN_POOL_FOR_Z`. They are the same number for
 * the same reason -- a pool that small has no distribution of false matches to separate from, and
 * the z ceiling of sqrt(n-1) is not even reachable there.
 *
 * Two files holding one number is exactly how the preset list in `benchmark-embedding-models.mjs`
 * drifted out of step with `PRESET_IDS` and quietly stopped measuring the shipped model. A comment
 * asking to be kept in step is what allowed that. This makes the drift fail instead.
 */
describe('calibration floor', () => {
  it('is the same number in the guard and in the script that fits its constant', async () => {
    const [module, script] = await Promise.all([
      readFile(new URL('../../src/store/governing-decision.ts', import.meta.url), 'utf-8'),
      readFile(new URL('../../scripts/calibrate-governing-decision.ts', import.meta.url), 'utf-8'),
    ]);
    const inModule = module.match(/const MIN_POOL_FOR_Z = (\d+)/);
    const inScript = script.match(/const MIN_DECISIONS = (\d+)/);
    expect(inModule, 'MIN_POOL_FOR_Z not found -- governing-decision.ts was restructured').not.toBeNull();
    expect(inScript, 'MIN_DECISIONS not found -- the calibration script was restructured').not.toBeNull();
    expect(inScript![1]).toBe(inModule![1]);
  });
});
