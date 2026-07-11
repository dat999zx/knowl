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
