import { describe, expect, it } from 'vitest';
import { evaluateRetrieval } from '../../src/store/retrieval-evaluation.js';

describe('retrieval evaluation', () => {
  it('calculates ranking, safety, latency, and context metrics', async () => {
    const result = await evaluateRetrieval([
      { id: 'first', query: 'sqlite choice', expectedItemIds: ['sqlite'], mustNotReturn: ['rejected'], limit: 3 },
      { id: 'second', query: 'auth command', expectedItemIds: ['auth', 'command'], mustNotReturn: [], limit: 3 },
    ], async (testCase) => testCase.id === 'first'
      ? { itemIds: ['sqlite', 'rejected'], staleItemIds: ['rejected'], latencyMs: 10, contextChars: 100 }
      : { itemIds: ['command', 'auth'], staleItemIds: [], latencyMs: 30, contextChars: 300 },
    );

    expect(result.metrics).toMatchObject({
      recallAt3: 1,
      recallAt10: 1,
      mrr: 1,
      ndcg: 1,
      staleHitCount: 1,
      forbiddenHitCount: 1,
      p50LatencyMs: 20,
      p95LatencyMs: 30,
      averageContextChars: 200,
    });
    expect(result.failedCaseIds).toEqual(['first']);
  });
});

describe('per-tier metrics', () => {
  it('reports each tier separately as well as overall', async () => {
    const cases = [
      { id: 'a', tier: 'basic', query: 'q', expectedItemIds: ['x'], mustNotReturn: [], limit: 10 },
      { id: 'b', tier: 'basic', query: 'q', expectedItemIds: ['x'], mustNotReturn: [], limit: 10 },
      { id: 'c', tier: 'extreme', query: 'q', expectedItemIds: ['y'], mustNotReturn: [], limit: 10 },
    ];

    // Basic cases hit, the extreme one misses.
    const result = await evaluateRetrieval(cases, async testCase => ({
      itemIds: testCase.tier === 'basic' ? ['x'] : ['z'],
      staleItemIds: [],
      latencyMs: 1,
      contextChars: 10,
    }));

    expect(result.byTier.basic.cases).toBe(2);
    expect(result.byTier.basic.recallAt3).toBe(1);
    expect(result.byTier.extreme.cases).toBe(1);
    expect(result.byTier.extreme.recallAt3).toBe(0);
    // The pooled number still averages every case, so a tier breakdown never
    // silently replaces the headline metric.
    expect(result.metrics.recallAt3).toBeCloseTo(2 / 3, 5);
  });

  it('omits byTier entries when no case declares a tier', async () => {
    const result = await evaluateRetrieval(
      [{ id: 'a', query: 'q', expectedItemIds: ['x'], mustNotReturn: [], limit: 10 }],
      async () => ({ itemIds: ['x'], staleItemIds: [], latencyMs: 1, contextChars: 10 }),
    );
    expect(Object.keys(result.byTier)).toEqual([]);
  });
});
