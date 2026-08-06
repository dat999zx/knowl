import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { KnowledgeItem } from '../../src/core/types.js';
import type { StoreHandle } from '../../src/store/store-handle.js';

vi.mock('../../src/store/queries.js', () => ({ queryKnowledgeCandidates: vi.fn() }));
vi.mock('../../src/store/vector.js', () => ({
  searchKnowledgeEmbeddings: vi.fn(),
  findEmbeddedItemIds: vi.fn(),
}));

const { queryKnowledgeCandidates } = await import('../../src/store/queries.js');
const { findEmbeddedItemIds, searchKnowledgeEmbeddings } = await import('../../src/store/vector.js');
const { selectCandidates } = await import('../../src/store/agent-query.js');

/**
 * The vector branch of `selectCandidates` (K-105: 25 NoCoverage mutants, no covering test at
 * all). Both collaborators are stubbed because what needs pinning is the merge itself -- which
 * evidence survives a fusion, and which ids the embedded-lookup is allowed to ask about -- and
 * neither is observable through a real index without also testing the ranker on top of it.
 */
describe('selectCandidates vector branch', () => {
  const FINGERPRINT = 'profile-abc';
  const store = { db: {} } as unknown as StoreHandle;

  const item = (id: string): KnowledgeItem => ({ id, title: id, content: id } as KnowledgeItem);
  const lexical = (id: string, lexicalScore: number, coverage: number) =>
    ({ item: item(id), lexicalScore, coverage, source: 'fts' as const });

  const run = (overrides: Record<string, unknown> = {}) =>
    selectCandidates(
      'project-1',
      {
        query: 'anything',
        limit: 3,
        vector: { enabled: true, embedding: [0.1, 0.2], profileFingerprint: FINGERPRINT },
        ...overrides,
      } as Parameters<typeof selectCandidates>[1],
      store,
    );

  beforeEach(() => {
    vi.mocked(queryKnowledgeCandidates).mockReset().mockResolvedValue([]);
    vi.mocked(searchKnowledgeEmbeddings).mockReset().mockResolvedValue([]);
    vi.mocked(findEmbeddedItemIds).mockReset().mockResolvedValue(new Set<string>());
  });

  it('does not reach the vector index when vector search is disabled', async () => {
    vi.mocked(queryKnowledgeCandidates).mockResolvedValue([lexical('a', 4, 1)]);
    await run({ vector: { enabled: false, embedding: [0.1], profileFingerprint: FINGERPRINT } });
    expect(searchKnowledgeEmbeddings).not.toHaveBeenCalled();
    expect(findEmbeddedItemIds).not.toHaveBeenCalled();
  });

  /** Enabled but un-embedded is the ordinary state of a query the embedder could not serve. */
  it('does not reach the vector index when there is no query embedding', async () => {
    vi.mocked(queryKnowledgeCandidates).mockResolvedValue([lexical('a', 4, 1)]);
    await run({ vector: { enabled: true, profileFingerprint: FINGERPRINT } });
    expect(searchKnowledgeEmbeddings).not.toHaveBeenCalled();
  });

  it('leaves a lexical-only candidate with no vector evidence rather than a zero', async () => {
    vi.mocked(queryKnowledgeCandidates).mockResolvedValue([lexical('a', 4, 1)]);
    const [candidate] = await run();
    expect(candidate.vectorRank).toBeUndefined();
    expect(candidate.vectorScore).toBeUndefined();
  });

  /**
   * The fusion case. A zero here would be a wrong answer rather than a missing one: the
   * ranker reads both halves, so dropping the lexical evidence of an item vector also found
   * silently reranks exactly the items both halves agreed on.
   */
  it('keeps lexical evidence when the same item comes back from vector', async () => {
    vi.mocked(queryKnowledgeCandidates).mockResolvedValue([lexical('a', 4.5, 0.75)]);
    vi.mocked(searchKnowledgeEmbeddings).mockResolvedValue([{ item: item('a'), score: 0.9 }]);

    const [candidate] = await run();
    expect(candidate.bm25Rank).toBe(1);
    expect(candidate.lexicalScore).toBe(4.5);
    expect(candidate.lexicalCoverage).toBe(0.75);
    expect(candidate.vectorRank).toBe(1);
    expect(candidate.vectorScore).toBe(0.9);
    expect(candidate.embedded).toBe(true);
  });

  it('admits a vector-only hit with no lexical rank', async () => {
    vi.mocked(queryKnowledgeCandidates).mockResolvedValue([]);
    vi.mocked(searchKnowledgeEmbeddings).mockResolvedValue([{ item: item('v'), score: 0.4 }]);

    const [candidate] = await run();
    expect(candidate.bm25Rank).toBeUndefined();
    expect(candidate.lexicalScore).toBeUndefined();
    expect(candidate.vectorRank).toBe(1);
  });

  it('ranks vector hits from one, in the order returned', async () => {
    vi.mocked(searchKnowledgeEmbeddings).mockResolvedValue([
      { item: item('first'), score: 0.9 },
      { item: item('second'), score: 0.8 },
      { item: item('third'), score: 0.7 },
    ]);

    const byId = new Map((await run()).map(c => [c.item.id, c]));
    expect(byId.get('first')?.vectorRank).toBe(1);
    expect(byId.get('second')?.vectorRank).toBe(2);
    expect(byId.get('third')?.vectorRank).toBe(3);
  });

  /**
   * The floor needs to know whether vector *could* have returned a lexical-only hit, so the
   * lookup is asked only about the ids vector did not return -- the difference between one
   * small query and a join on every search.
   */
  it('asks the embedded lookup only about candidates vector did not return', async () => {
    vi.mocked(queryKnowledgeCandidates).mockResolvedValue([
      lexical('both', 4, 1),
      lexical('lexical-only', 3, 1),
    ]);
    vi.mocked(searchKnowledgeEmbeddings).mockResolvedValue([{ item: item('both'), score: 0.9 }]);
    vi.mocked(findEmbeddedItemIds).mockResolvedValue(new Set(['lexical-only']));

    const byId = new Map((await run()).map(c => [c.item.id, c]));
    expect(findEmbeddedItemIds).toHaveBeenCalledTimes(1);
    expect(vi.mocked(findEmbeddedItemIds).mock.calls[0][0]).toEqual(['lexical-only']);
    expect(vi.mocked(findEmbeddedItemIds).mock.calls[0][1]).toEqual({ profileFingerprint: FINGERPRINT });
    expect(byId.get('lexical-only')?.embedded).toBe(true);
  });

  it('marks a lexical-only candidate the lookup did not find as not embedded', async () => {
    vi.mocked(queryKnowledgeCandidates).mockResolvedValue([lexical('orphan', 3, 1)]);
    vi.mocked(findEmbeddedItemIds).mockResolvedValue(new Set<string>());

    const [candidate] = await run();
    expect(candidate.embedded).toBe(false);
  });

  it('skips the lookup entirely when vector returned every candidate', async () => {
    vi.mocked(queryKnowledgeCandidates).mockResolvedValue([lexical('a', 4, 1)]);
    vi.mocked(searchKnowledgeEmbeddings).mockResolvedValue([{ item: item('a'), score: 0.9 }]);

    await run();
    expect(findEmbeddedItemIds).not.toHaveBeenCalled();
  });

  /** A fingerprint that does not reach the search scores vectors from other embedding spaces. */
  it('passes the query profile and candidate limit through to the vector search', async () => {
    await run({ limit: 5 });
    const [projectId, options] = vi.mocked(searchKnowledgeEmbeddings).mock.calls[0];
    expect(projectId).toBe('project-1');
    expect(options.profileFingerprint).toBe(FINGERPRINT);
    expect(options.vector).toEqual([0.1, 0.2]);
    expect(options.limit).toBe(15);
    expect(options.category).toBeUndefined();
  });
});
