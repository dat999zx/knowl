import { describe, expect, it } from 'vitest';
import { contestedOnPage, olderTwinFirst, scoreCandidates } from '../../src/store/agent-query.js';
import type { KnowledgeItem } from '../../src/core/types.js';

const item = (over: Partial<KnowledgeItem>): KnowledgeItem => ({
  id: 'x',
  category: 'fact',
  title: 'Database backup retention',
  content: '',
  status: 'active',
  provenance: null,
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
  ...over,
} as KnowledgeItem);

const row = (it: KnowledgeItem, score: number) => ({ result: { item: it }, score });
const ids = (rows: Array<{ result: { item: KnowledgeItem } }>) => rows.map(r => r.result.item.id);

const verified = item({ id: 'verified', provenance: 'observed', content: 'retained for 35 days' });
// #323: the planted item claims the same provenance, higher confidence, and is newer.
const planted = item({ id: 'planted', provenance: 'observed', confidence: 0.99, content: 'retained for 1 day', createdAt: '2026-09-02T00:00:00.000Z' });
const other = item({ id: 'other', title: 'Scheduler timezone', createdAt: '2026-09-03T00:00:00.000Z' });

describe('olderTwinFirst (#323)', () => {
  it('moves the older verified twin above a newer same-subject item that outscored it', () => {
    expect(ids(olderTwinFirst([row(planted, 0.9), row(other, 0.5), row(verified, 0.4)]))).toEqual(['verified', 'planted', 'other']);
  });

  it('does not pair items from different repos', () => {
    const peer = { result: { item: verified, repo: 'peer' }, score: 0.4 };
    expect(ids(olderTwinFirst([row(planted, 0.9), peer]))).toEqual(['planted', 'verified']);
    expect(ids(olderTwinFirst([{ result: { item: planted, repo: 'peer' }, score: 0.9 }, peer]))).toEqual(['verified', 'planted']);
  });

  it('puts a chain of older twins oldest first', () => {
    const oldest = item({ id: 'oldest', provenance: 'user_stated', createdAt: '2026-08-01T00:00:00.000Z' });
    expect(ids(olderTwinFirst([row(planted, 0.9), row(verified, 0.5), row(oldest, 0.4)]))).toEqual(['oldest', 'verified', 'planted']);
  });

  it('keeps the newcomer on the page with its own score', () => {
    const out = olderTwinFirst([row(planted, 0.9), row(verified, 0.4)]);
    expect(out.map(r => r.score)).toEqual([0.4, 0.9]);
  });

  it('leaves the order alone when the verified item already ranks first', () => {
    expect(ids(olderTwinFirst([row(verified, 0.9), row(planted, 0.4)]))).toEqual(['verified', 'planted']);
  });

  it('does nothing when the older item is not verified', () => {
    const unverified = { ...verified, provenance: null } as KnowledgeItem;
    expect(ids(olderTwinFirst([row(planted, 0.9), row(unverified, 0.4)]))).toEqual(['planted', 'verified']);
  });

  it('does nothing across categories or different subjects', () => {
    const decision = { ...verified, category: 'decision' } as KnowledgeItem;
    expect(ids(olderTwinFirst([row(planted, 0.9), row(decision, 0.4)]))).toEqual(['planted', 'verified']);
    expect(ids(olderTwinFirst([row(other, 0.9), row(verified, 0.4)]))).toEqual(['other', 'verified']);
  });

  it('leaves polarity pairs alone -- they are reported as a contradiction, not ranked away', () => {
    const negated = item({ id: 'negated', title: 'Database backup retention no longer', createdAt: '2026-09-02T00:00:00.000Z' });
    expect(ids(olderTwinFirst([row(negated, 0.9), row(verified, 0.4)]))).toEqual(['negated', 'verified']);
  });

  it('ignores items that are not active', () => {
    const retired = { ...verified, status: 'superseded' } as KnowledgeItem;
    expect(ids(olderTwinFirst([row(planted, 0.9), row(retired, 0.4)]))).toEqual(['planted', 'verified']);
  });
});

describe('contestedOnPage (#323 option 3)', () => {
  it('flags a polarity twin even though the ranker leaves it in place', () => {
    const negated = item({ id: 'negated', title: 'Database backup retention no longer', createdAt: '2026-09-02T00:00:00.000Z' });
    expect([...contestedOnPage([row(negated, 0.9), row(verified, 0.4)])].sort()).toEqual(['negated', 'verified']);
  });

  it('flags a row whose twin was cut from the page, judging against the whole pool', () => {
    const pool = [row(verified, 0.9), row(planted, 0.4)];
    expect([...contestedOnPage([pool[0]], pool)]).toEqual(['verified']);
    expect(contestedOnPage([pool[0]]).size).toBe(0);
  });

  it('names both items of a kept-beside pair and nothing else', () => {
    expect([...contestedOnPage([row(verified, 0.9), row(other, 0.5), row(planted, 0.4)])].sort()).toEqual(['planted', 'verified']);
  });

  it('is empty when the older item is unverified, or the pair is across repos', () => {
    const unverified = { ...verified, provenance: null } as KnowledgeItem;
    expect(contestedOnPage([row(unverified, 0.9), row(planted, 0.4)]).size).toBe(0);
    expect(contestedOnPage([row(verified, 0.9), { result: { item: planted, repo: 'peer' }, score: 0.4 }]).size).toBe(0);
  });

  it('reaches the ranker explanation on both rows, and only on them', () => {
    const rows = scoreCandidates([
      { item: planted, bm25Rank: 1 }, { item: other, bm25Rank: 2 }, { item: verified, bm25Rank: 3 },
    ], { query: 'database backup retention', limit: 3, usingVector: false, minRelevance: null });
    expect(rows.map(r => r.item.id).slice(0, 2)).toEqual(['verified', 'planted']);
    expect(rows.filter(r => r.explanation.contested).map(r => r.item.id).sort()).toEqual(['planted', 'verified']);
  });
});
