import { describe, expect, it } from 'vitest';
import {
  Bm25Adapter,
  GrepAdapter,
  HashVectorAdapter,
  NoMemoryAdapter,
} from '../../benchmarks/accuracy/src/baselines.js';
import type { NormalizedRecord } from '../../benchmarks/accuracy/src/schema.js';

const records: NormalizedRecord[] = [
  {
    sourceId: 'p1-old', projectId: 'p1', historyId: 'h1', sessionId: 's1',
    occurredAt: '2026-01-01T00:00:00.000Z', availableAt: '2026-01-01T00:00:00.000Z',
    kind: 'decision', title: 'Old database choice', content: 'Use PostgreSQL for persistence.',
  },
  {
    sourceId: 'p1-current', projectId: 'p1', historyId: 'h1', sessionId: 's2',
    occurredAt: '2026-02-01T00:00:00.000Z', availableAt: '2026-02-01T00:00:00.000Z',
    kind: 'decision', title: 'Current database choice', content: 'Use SQLite for local persistence.',
    relations: { supersedes: ['p1-old'] },
  },
  {
    sourceId: 'p1-symbol', projectId: 'p1', historyId: 'h1', sessionId: 's3',
    occurredAt: '2026-03-01T00:00:00.000Z', availableAt: '2026-03-01T00:00:00.000Z',
    kind: 'symbol', title: 'Token implementation', content: 'createAccessToken lives in src/auth/token.ts.',
    locators: { path: 'src/auth/token.ts', symbol: 'createAccessToken' },
  },
  {
    sourceId: 'p2-current', projectId: 'p2', historyId: 'h2', sessionId: 's4',
    occurredAt: '2026-02-01T00:00:00.000Z', availableAt: '2026-02-01T00:00:00.000Z',
    kind: 'decision', title: 'Other project database', content: 'Use SQLite for local persistence.',
  },
];

async function prepare(adapter: Bm25Adapter | GrepAdapter | HashVectorAdapter | NoMemoryAdapter) {
  await adapter.reset({ runId: 'test', mode: 'normalized', seed: 1 });
  for (const record of records) await adapter.ingestNormalized!(record);
  await adapter.finalize();
  return adapter;
}

describe('accuracy benchmark baselines', () => {
  it('keeps BM25 results project-scoped and source-attributed', async () => {
    const adapter = await prepare(new Bm25Adapter());
    const result = await adapter.retrieve({ queryId: 'q', projectId: 'p1', text: 'current SQLite database persistence', topK: 3 });

    expect(result.decision).toBe('results');
    expect(result.hits[0].sourceIds).toEqual(['p1-current']);
    expect(result.hits.flatMap(hit => hit.sourceIds ?? [])).not.toContain('p2-current');
  });

  it('supports exact identifiers through the grep baseline', async () => {
    const adapter = await prepare(new GrepAdapter());
    const result = await adapter.retrieve({ queryId: 'q', projectId: 'p1', text: 'src/auth/token.ts createAccessToken', topK: 3 });
    expect(result.hits[0].sourceIds).toEqual(['p1-symbol']);
  });

  it('uses only vector similarity in the deterministic hash-vector baseline', async () => {
    const adapter = await prepare(new HashVectorAdapter());
    const result = await adapter.retrieve({ queryId: 'q', projectId: 'p1', text: 'SQLite local persistence database', topK: 2 });
    expect(result.hits[0].sourceIds).toEqual(['p1-current']);
  });

  it('makes the no-memory baseline explicitly abstain', async () => {
    const adapter = await prepare(new NoMemoryAdapter());
    expect(await adapter.retrieve({ queryId: 'q', projectId: 'p1', text: 'anything', topK: 5 }))
      .toEqual({ decision: 'abstain', hits: [] });
  });
});
