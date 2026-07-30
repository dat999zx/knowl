import { describe, expect, it } from 'vitest';
import { collectNative } from '../../benchmarks/accuracy/src/native-collect.js';
import type { BenchmarkAdapter } from '../../benchmarks/accuracy/src/protocol.js';
import type { NativeHistory } from '../../benchmarks/accuracy/src/schema.js';

function history(historyId: string, projectId: string): NativeHistory {
  return {
    historyId,
    projectId,
    sessions: Array.from({ length: 4 }, (_, sessionIndex) => ({
      sessionId: `${historyId}-s${sessionIndex + 1}`,
      startedAt: `2026-01-0${sessionIndex + 1}T00:00:00.000Z`,
      endedAt: `2026-01-0${sessionIndex + 1}T00:01:00.000Z`,
      termination: 'normal' as const,
      events: [{
        sourceId: `${historyId}-e${sessionIndex + 1}`,
        occurredAt: `2026-01-0${sessionIndex + 1}T00:00:30.000Z`,
        type: 'assistant' as const,
        content: `public event ${sessionIndex + 1}`,
      }],
    })) as NativeHistory['sessions'],
  };
}

function nativeAdapter(overrides: Partial<BenchmarkAdapter> = {}): BenchmarkAdapter {
  return {
    metadata: {
      name: 'native-recorder',
      version: '1',
      capabilities: {
        normalized: {
          supported: false,
          sourceProvenance: false,
          temporalAsOf: false,
          retrievalAbstention: false,
          memoryInventory: false,
          nativeContextComposition: false,
          reason: 'native only',
        },
        native: {
          supported: true,
          sourceProvenance: true,
          temporalAsOf: false,
          retrievalAbstention: false,
          memoryInventory: true,
          nativeContextComposition: false,
        },
      },
    },
    async reset() {},
    async ingestNative() {},
    async finalize() {},
    async retrieve() { return { decision: 'abstain', hits: [] }; },
    async listMemories() { return []; },
    async close() {},
    ...overrides,
  };
}

describe('native capture collection', () => {
  it('isolates each raw history and never sends evaluator capture gold to the adapter', async () => {
    const histories = [history('h1', 'p1'), history('h2', 'p2')];
    const received: object[] = [];
    const lifecycle: string[] = [];
    let currentSourceId = '';
    const adapter = nativeAdapter({
      async reset(input) {
        lifecycle.push(`reset:${input.runId}`);
        currentSourceId = '';
      },
      async ingestNative(event) {
        received.push(event);
        currentSourceId ||= event.sourceId;
      },
      async finalize() { lifecycle.push('finalize'); },
      async listMemories() {
        lifecycle.push('list');
        return [{ memoryId: `m-${currentSourceId}`, text: 'captured', sourceIds: [currentSourceId] }];
      },
      async close() { lifecycle.push('close'); },
    });

    const result = await collectNative({ histories }, adapter, { runs: 1, seed: 41 });

    expect(result.status).toBe('complete');
    expect(result.runs[0].predictions).toEqual([
      { historyId: 'h1', memories: [{ memoryId: 'm-h1-e1', text: 'captured', sourceIds: ['h1-e1'] }] },
      { historyId: 'h2', memories: [{ memoryId: 'm-h2-e1', text: 'captured', sourceIds: ['h2-e1'] }] },
    ]);
    expect(lifecycle.filter(item => item.startsWith('reset:'))).toHaveLength(2);
    expect(lifecycle.filter(item => item === 'finalize')).toHaveLength(2);
    expect(lifecycle.at(-1)).toBe('close');
    expect(received.map(event => (event as { sourceId: string }).sourceId)).toEqual([
      'h1-e1', 'h1-e2', 'h1-e3', 'h1-e4',
      'h2-e1', 'h2-e2', 'h2-e3', 'h2-e4',
    ]);
    const serialized = JSON.stringify(received);
    for (const forbidden of ['canonicalFact', 'targets', 'exclusions', 'shouldCapture', 'gold']) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it('returns N/A without starting an adapter when source-based scoring is unsupported', async () => {
    let reset = false;
    const base = nativeAdapter();
    const adapter = nativeAdapter({
      metadata: {
        ...base.metadata,
        capabilities: {
          ...base.metadata.capabilities,
          native: { ...base.metadata.capabilities.native, sourceProvenance: false },
        },
      },
      async reset() { reset = true; },
    });

    const result = await collectNative({ histories: [history('h1', 'p1')] }, adapter, { runs: 3, seed: 1 });

    expect(result).toMatchObject({
      status: 'not_applicable',
      reason: 'adapter does not expose source provenance',
      runs: [],
    });
    expect(reset).toBe(false);
  });
});
