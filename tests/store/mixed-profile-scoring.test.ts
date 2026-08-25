import { describe, expect, it } from 'vitest';
import { scoreCandidates } from '../../src/store/agent-query.js';
import type { KnowledgeItem } from '../../src/core/types.js';

/**
 * #187: federation searches each peer under that peer's own embedding profile, so one page can
 * carry cosines from two models. Granite's distribution sits roughly 0.5 above arctic's on
 * identical inputs, so the two must not be min-maxed together and must not be judged by one
 * floor.
 */

const item = (id: string): KnowledgeItem => ({
  id,
  category: 'fact',
  status: 'active',
  title: `title ${id}`,
  content: `content ${id}`,
  tags: [],
  confidence: 1,
  freshness: 'fresh',
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-01T00:00:00.000Z',
} as unknown as KnowledgeItem);

const candidate = (id: string, repo: string, vectorScore: number) =>
  ({ item: item(id), repo, vectorScore, embedded: true } as never);

/** Granite-scale local rows and arctic-scale peer rows, as a mixed workspace produces. */
const mixed = () => [
  candidate('local-strong', 'here', 0.90),
  candidate('local-weak', 'here', 0.78),
  candidate('peer-strong', 'there', 0.26),
  candidate('peer-weak', 'there', 0.17),
];

const scales = new Map([['here', 'granite'], ['there', 'arctic']]);

describe('scoring a page that mixes embedding profiles', () => {
  it('does not let one model\'s scale outrank the other wholesale', () => {
    // Without per-scale ranges a single min-max over 0.17-0.90 puts both arctic rows near 0 and
    // both granite rows near 1, so every local row beats every peer row on the semantic term
    // whatever either actually says. The peer's best must be able to reach the page.
    const scored = scoreCandidates(mixed(), {
      query: 'anything',
      limit: 4,
      usingVector: true,
      semanticScaleByCorpus: scales,
    });

    const order = scored.map(entry => entry.item.id);
    expect(order.indexOf('peer-strong')).toBeLessThan(order.indexOf('local-weak'));
  });

  it('judges each corpus against its own floor', () => {
    // Arctic's floor is 0.16 and granite's is 0.76. Both corpora clear their own bar here, so
    // nothing abstains. Judging arctic's 0.26 against granite's 0.76 would call the peer
    // off-subject on scale alone -- the #189 mistake, one level out.
    const scored = scoreCandidates(mixed(), {
      query: 'anything',
      limit: 4,
      usingVector: true,
      semanticScaleByCorpus: scales,
      minRelevance: 0.76,
      minRelevanceByCorpus: new Map([['here', 0.76], ['there', 0.16]]),
    });

    const abstained = scored.filter(entry => entry.explanation?.abstained);
    expect(abstained.map(entry => entry.item.id)).toEqual([]);
  });

  it('leaves a single-profile page scored exactly as before', () => {
    // The regression the cross-repo archetype baseline caught: repos sharing a profile produce
    // genuinely comparable cosines, and splitting their ranges rescales each repo's own best hit
    // to 1.0 however mediocre. With no scale map, every row shares one range.
    const shared = [
      candidate('a', 'here', 0.90),
      candidate('b', 'there', 0.40),
    ];

    const withoutMap = scoreCandidates(shared, { query: 'q', limit: 2, usingVector: true });
    const withOneScale = scoreCandidates(shared, {
      query: 'q',
      limit: 2,
      usingVector: true,
      semanticScaleByCorpus: new Map([['here', 'same'], ['there', 'same']]),
    });

    expect(withoutMap.map(e => e.item.id)).toEqual(withOneScale.map(e => e.item.id));
    expect(withoutMap[0].item.id).toBe('a');
  });
});
