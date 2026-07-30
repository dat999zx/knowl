import { describe, expect, it } from 'vitest';
import { KnowlBenchmarkAdapter } from '../../benchmarks/accuracy/src/knowl-adapter.js';
import type { NormalizedRecord } from '../../benchmarks/accuracy/src/schema.js';

const records: NormalizedRecord[] = [
  {
    sourceId: 'p1-old', projectId: 'p1', historyId: 'h1', sessionId: 's1',
    occurredAt: '2026-01-01T00:00:00.000Z', availableAt: '2026-01-01T00:00:00.000Z',
    kind: 'decision', title: 'Old database decision', content: 'Use PostgreSQL for project p1.',
  },
  {
    sourceId: 'p1-current', projectId: 'p1', historyId: 'h1', sessionId: 's2',
    occurredAt: '2026-02-01T00:00:00.000Z', availableAt: '2026-02-01T00:00:00.000Z',
    kind: 'decision', title: 'Current database decision', content: 'Use SQLite for project p1.',
    relations: { supersedes: ['p1-old'] },
  },
  {
    sourceId: 'p2-current', projectId: 'p2', historyId: 'h2', sessionId: 's3',
    occurredAt: '2026-02-01T00:00:00.000Z', availableAt: '2026-02-01T00:00:00.000Z',
    kind: 'decision', title: 'Other database decision', content: 'Use SQLite for project p2.',
  },
];

describe('Knowl normalized benchmark adapter', () => {
  it('preserves source IDs, applies supersession, and isolates projects', async () => {
    const adapter = new KnowlBenchmarkAdapter();
    await adapter.reset({ runId: 'knowl-adapter-test', mode: 'normalized', seed: 1 });
    try {
      for (const record of records) await adapter.ingestNormalized(record);
      await adapter.finalize();
      const response = await adapter.retrieve({
        queryId: 'q1', projectId: 'p1', text: 'current SQLite database decision for p1', topK: 5,
      });
      const sources = response.hits.flatMap(hit => hit.sourceIds ?? []);

      expect(sources[0]).toBe('p1-current');
      expect(sources).not.toContain('p1-old');
      expect(sources).not.toContain('p2-current');
    } finally {
      await adapter.close();
    }
  });

  it('declares strict historical retrieval unsupported', () => {
    expect(new KnowlBenchmarkAdapter().metadata.capabilities.normalized.temporalAsOf).toBe(false);
  });
});
