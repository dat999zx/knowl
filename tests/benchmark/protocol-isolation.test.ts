import { describe, expect, it } from 'vitest';
import { generateCodingMemoryBundle } from '../../benchmarks/accuracy/src/generator.js';
import { collectNormalized } from '../../benchmarks/accuracy/src/collect.js';
import type { BenchmarkAdapter, RetrieveRequest } from '../../benchmarks/accuracy/src/protocol.js';

describe('benchmark protocol isolation', () => {
  it('sends records and query-only requests to adapters without evaluator gold', async () => {
    const bundle = generateCodingMemoryBundle('protocol-isolation');
    const received: RetrieveRequest[] = [];
    const lifecycle: string[] = [];
    const adapter: BenchmarkAdapter = {
      metadata: {
        name: 'recording-adapter', version: '1',
        capabilities: {
          normalized: {
            supported: true, sourceProvenance: true, temporalAsOf: true,
            retrievalAbstention: true, memoryInventory: false, nativeContextComposition: false,
          },
          native: {
            supported: false, sourceProvenance: false, temporalAsOf: false,
            retrievalAbstention: false, memoryInventory: false, nativeContextComposition: false,
            reason: 'not implemented',
          },
        },
      },
      async reset(input) { lifecycle.push(`reset:${input.runId}`); },
      async ingestNormalized(record) { lifecycle.push(`record:${record.sourceId}`); },
      async finalize() { lifecycle.push('finalize'); },
      async retrieve(request) {
        received.push(request);
        return { decision: 'abstain', hits: [] };
      },
      async close() { lifecycle.push('close'); },
    };

    const collected = await collectNormalized(
      { records: bundle.normalizedRecords.slice(0, 4), queries: bundle.queries.slice(0, 2) },
      adapter,
      { runs: 1, seed: 7, topK: 5, contextBudget: 1_000 },
    );

    expect(collected.status).toBe('complete');
    expect(collected.runs[0].predictions).toHaveLength(2);
    expect(received).toHaveLength(2);
    const allowed = new Set(['asOf', 'contextBudget', 'projectId', 'text', 'topK']);
    expect(received.every(request => Object.keys(request).every(key => allowed.has(key)))).toBe(true);
    expect(received.every(request => !('queryId' in request))).toBe(true);
    const serialized = JSON.stringify(received);
    for (const forbidden of ['answer', 'expected', 'forbidden', 'grade', 'harmful', 'judgments', 'relevance']) {
      expect(serialized).not.toContain(forbidden);
    }
    expect(lifecycle.at(-1)).toBe('close');
  });

  it('returns N/A without starting an adapter when normalized mode is unsupported', async () => {
    let reset = false;
    const adapter: BenchmarkAdapter = {
      metadata: {
        name: 'native-only', version: '1',
        capabilities: {
          normalized: {
            supported: false, sourceProvenance: false, temporalAsOf: false,
            retrievalAbstention: false, memoryInventory: false, nativeContextComposition: false,
            reason: 'native capture only',
          },
          native: {
            supported: true, sourceProvenance: false, temporalAsOf: false,
            retrievalAbstention: false, memoryInventory: true, nativeContextComposition: false,
          },
        },
      },
      async reset() { reset = true; },
      async finalize() {},
      async retrieve() { return { decision: 'abstain', hits: [] }; },
      async close() {},
    };

    const result = await collectNormalized({ records: [], queries: [] }, adapter, { runs: 3, seed: 1, topK: 5 });
    expect(result).toMatchObject({ status: 'not_applicable', reason: 'native capture only', runs: [] });
    expect(reset).toBe(false);
  });
});
