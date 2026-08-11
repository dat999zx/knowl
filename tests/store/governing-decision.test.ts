import { describe, expect, it } from 'vitest';
import { governingDecisionForWrite, meanTopK } from '../../src/store/governing-decision.js';
import { CSLS_K, FIRE_RATE, MIN_POOL_FOR_Z } from '../../src/store/guard-stats.js';
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
  // this module -- no project, no config, no embedder, model not on disk, no corpus statistics --
  // has to come back as "no opinion" rather than as an exception, because it runs inside
  // knowl_store's result envelope. A throw here would turn a missing model into a failed write,
  // which is a far worse bug than the one the guard exists to catch.
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

describe('meanTopK', () => {
  // The CSLS scaling term. A wrong k or a wrong mean silently changes which decision wins
  // without failing anything, which is why it is tested rather than inlined.
  it('averages the k highest values, not the first k', () => {
    expect(meanTopK([0.1, 0.9, 0.2, 0.8], 2)).toBeCloseTo(0.85, 10);
  });

  it('uses everything it has when the pool is smaller than k', () => {
    expect(meanTopK([0.4, 0.6], 10)).toBeCloseTo(0.5, 10);
  });

  it('returns 0 for an empty pool rather than NaN', () => {
    // NaN would propagate silently through the CSLS arithmetic and make every comparison false,
    // which reads exactly like "found nothing" instead of like a bug.
    expect(meanTopK([], 5)).toBe(0);
  });
});

describe('guard constants', () => {
  /**
   * These three are the whole tuning surface, and each was measured rather than chosen.
   *
   * FIRE_RATE is the noise budget and the only one anyone should want to move: at 10% the guard
   * caught about a third of governed writes on a uniformly-sampled labelled set, against 16% for
   * the raw-cosine gate it replaced. CSLS_K=10 was the best of {3,5,10,20} and the neighbours were
   * close, so the result does not hinge on it. MIN_POOL_FOR_Z is the abstain floor.
   *
   * Pinned because a plausible-looking edit to any of them changes how often the product
   * interrupts people, and nothing else would fail if one drifted.
   */
  it('are the measured values, not round numbers someone liked', () => {
    expect(CSLS_K).toBe(10);
    expect(FIRE_RATE).toBeCloseTo(0.10, 10);
    expect(MIN_POOL_FOR_Z).toBe(25);
  });

  it('keeps the fire rate inside a range a person would tolerate', () => {
    // A guard nobody can stand is a guard that gets switched off, and one that never speaks is
    // the inert state this feature already shipped in once. Both ends are failure.
    expect(FIRE_RATE).toBeGreaterThan(0.01);
    expect(FIRE_RATE).toBeLessThan(0.25);
  });
});
