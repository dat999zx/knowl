import { describe, expect, it } from 'vitest';
import { scoreCandidates, type Candidate } from '../../src/store/agent-query.js';
import type { KnowledgeItem } from '../../src/core/types.js';

/**
 * Recency is min-max normalised over the candidate set, so it is SCALE-FREE: a one-millisecond
 * gap is worth as much as a one-week gap when it is the only gap in the set.
 *
 * That is correct -- position within a page is what recency is for -- but it means the recency
 * term's magnitude is decided by how wide a span the page happens to cover, which for a test
 * fixture is decided by how fast the machine wrote it. Two rows whose lexical evidence differs
 * by 0.4% can therefore swap places between a fast machine and a slow one with nothing in the
 * ranking having changed.
 *
 * This is the mechanism behind the macOS-only failure in #293 (`small-peer-lexical`, run
 * 34430741581): a fixture seeded rows milliseconds apart, and on that runner the youngest row's
 * recency outweighed a 0.4% lexical deficit. Pinned here so the property is stated on purpose
 * rather than discovered again through a flake, and so any change to the recency prior that
 * removes the knife-edge fails a test that says why it existed.
 */

const item = (id: string, at: string): KnowledgeItem => ({
  id, category: 'fact', status: 'active', title: `Row ${id}`, content: `Body ${id}`,
  freshness: 'fresh', confidence: 1, version: 1, createdAt: at, updatedAt: at,
} as KnowledgeItem);

/** Two rows, near-identical lexically, separated only by `gapMs` of age. */
function leaderFor(gapMs: number, spanMs: number): string {
  const base = Date.parse('2026-09-01T00:00:00.000Z');
  const candidates: Array<Candidate & { repo?: string }> = [
    // An anchor that fixes the total span the set covers, and which cannot win on lexical.
    { item: item('anchor', new Date(base).toISOString()), bm25Rank: 3, lexicalScore: 1e-9, lexicalCoverage: 0 },
    { item: item('best', new Date(base + spanMs).toISOString()), bm25Rank: 1, lexicalScore: 3.860784043844392e-6, lexicalCoverage: 1 },
    { item: item('near', new Date(base + spanMs + gapMs).toISOString()), bm25Rank: 2, lexicalScore: 3.846264921786819e-6, lexicalCoverage: 1 },
  ];
  return scoreCandidates(candidates, { query: 'build output directory', limit: 3, usingVector: false })[0].item.id;
}

describe('the recency prior is scale-free, so a millisecond can outrank a lexical gap', () => {
  it('lets the newest row win when its age gap is the whole span', () => {
    // 1ms of newness across a 1ms span is a full point of recency -- the maximum the term can
    // pay -- and it buys more than the 0.4% of lexical evidence it gives up.
    expect(leaderFor(1, 0)).toBe('near');
  });

  it('lets the better lexical row win when the same gap is a sliver of a wide span', () => {
    // The identical one-millisecond gap, now 0.001% of the span, is worth almost nothing.
    expect(leaderFor(1, 100_000)).toBe('best');
  });

  it('is the same 0.4% lexical gap in both cases, so only the span decided it', () => {
    // Stated as an assertion rather than a comment: if someone widens the lexical gap in the
    // fixture above, these two cases stop testing what they claim to.
    const ratio = 3.846264921786819e-6 / 3.860784043844392e-6;
    expect(ratio).toBeGreaterThan(0.99);
    expect(ratio).toBeLessThan(1);
  });
});
