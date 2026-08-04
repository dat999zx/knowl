import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, initDb } from '../../src/store/database.js';
import { releaseAll } from '../../src/store/connection-pool.js';
import * as repo from '../../src/store/repository.js';
import { rankKnowledge, scoreCandidates, MIN_VECTOR_RELEVANCE, type Candidate } from '../../src/store/agent-query.js';
import { DEFAULT_CONFIG, saveConfig } from '../../src/core/config.js';
import type { KnowledgeItem } from '../../src/core/types.js';

type Dressing = Partial<Pick<KnowledgeItem,
  'freshness' | 'confidence' | 'tier' | 'provenance' | 'category' | 'title' | 'content' | 'updatedAt' | 'tags'>>;

function item(id: string, dressing: Dressing = {}): KnowledgeItem {
  return {
    id,
    category: 'fact',
    status: 'active',
    title: `item ${id}`,
    content: `content ${id}`,
    freshness: 'fresh',
    confidence: 1,
    version: 1,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    ...dressing,
  } as KnowledgeItem;
}

/**
 * Everything an item's *standing* can earn it. Standing only, because that is what "dressed"
 * means in the finding -- the caller-supplied category hint and the identifier match are
 * evidence about the question rather than about the item, and are bounded separately below.
 */
const BEST_DRESSED: Dressing = {
  freshness: 'fresh', confidence: 1, tier: 'verified', provenance: 'observed',
  updatedAt: '2026-08-01T00:00:00.000Z',
};

/** Everything an item's standing can cost it. */
const WORST_DRESSED: Dressing = {
  freshness: 'stale', confidence: 0, tier: undefined, provenance: 'inferred',
  updatedAt: '2020-01-01T00:00:00.000Z',
};

describe('K-70 -- a prior may move an item, never carry it', () => {
  function pair(cosine: number) {
    return scoreCandidates(
      [
        { item: item('best', BEST_DRESSED), embedded: true, vectorRank: 1, vectorScore: cosine },
        { item: item('worst', WORST_DRESSED), embedded: true, vectorRank: 2, vectorScore: cosine },
      ],
      { limit: 10, usingVector: true, query: 'anything' },
    );
  }

  it('bounds the caller-supplied hints too, and keeps them the smaller half', () => {
    // The category hint and the identifier match are sized above the standing priors on
    // purpose -- an explicit hint is evidence about the question. They still cannot carry an
    // item: together they are a 12% discount, and every one of them is a multiplier.
    const [matching, missing] = scoreCandidates(
      [
        {
          item: item('fits', { category: 'decision', title: 'src/store/agent-query.ts', content: 'x' }),
          embedded: true, vectorRank: 1, vectorScore: 0.5,
        },
        {
          item: item('misses', { category: 'fact', title: 'unrelated', content: 'unrelated' }),
          embedded: true, vectorRank: 2, vectorScore: 0.5,
        },
      ],
      { limit: 10, usingVector: true, query: 'src/store/agent-query.ts', category: 'decision' },
    );
    expect(missing.score / matching.score).toBeGreaterThan(0.85);
  });

  it('keeps the dressing swing well inside the legitimate-cosine range', () => {
    // Measured on the additive scorer: at a fixed cosine of 0.50 the best-dressed item scored
    // 0.6442 and the worst 0.4400 -- a 0.204 swing, 96% of the 0.401-0.614 range the file's
    // own comment documents as the whole span of a legitimate query.
    const scored = pair(0.5);
    const best = scored.find(row => row.item.id === 'best')!.score;
    const worst = scored.find(row => row.item.id === 'worst')!.score;
    expect(best - worst).toBeLessThan(0.213 / 2);
  });

  it('applies the same proportional discount at every cosine', () => {
    // The mechanism, not the magnitude. An additive boost is a fixed number of points, so its
    // effect relative to the score explodes as the score shrinks -- which is why it can flip
    // an ordering at one cosine and be invisible at another. A multiplicative prior is the
    // same ratio everywhere, so this is the property to assert.
    const ratio = (cosine: number) => {
      const scored = pair(cosine);
      return scored.find(row => row.item.id === 'worst')!.score
        / scored.find(row => row.item.id === 'best')!.score;
    };
    expect(ratio(0.9)).toBeCloseTo(ratio(0.4), 6);
  });

  it('never lets a prior lift a score above the calibrated ceiling', () => {
    const scored = pair(1);
    for (const row of scored) expect(row.score).toBeLessThanOrEqual(1);
  });

  it('values the whole lexical ordering above the step of merely appearing', () => {
    // "Did lexical return this at all" was worth 0.0333 while the whole lexical ordering was
    // worth 0.0158 -- the presence step was 2.1x the ordering it rode on. All three sit at the
    // same cosine and are dressed identically, so the only thing separating them is lexical.
    const scored = scoreCandidates(
      [
        { item: item('best'), embedded: true, vectorRank: 1, vectorScore: 0.5, bm25Rank: 1, lexicalScore: 9 },
        { item: item('worst'), embedded: true, vectorRank: 2, vectorScore: 0.5, bm25Rank: 30, lexicalScore: 0.1 },
        { item: item('absent'), embedded: true, vectorRank: 3, vectorScore: 0.5 },
      ],
      { limit: 10, usingVector: true, query: 'anything' },
    );
    const score = (id: string) => scored.find(row => row.item.id === id)!.score;

    const orderingSpan = score('best') - score('worst');
    const presenceStep = score('worst') - score('absent');
    expect(orderingSpan).toBeGreaterThan(presenceStep * 10);
  });
});

describe('K-30 -- the floor judges relevance, not standing', () => {
  const judged = (cosine: number, dressing: Dressing) => scoreCandidates(
    [{ item: item('only', dressing), embedded: true, vectorRank: 1, vectorScore: cosine }],
    { limit: 10, usingVector: true },
  );

  it('answers a query the same way for a fresh item and an identical stale one', () => {
    // Reproduced at 0.34: the fresh item cleared the floor on a +0.02 freshness re-rank and
    // the stale one was deleted by a -0.05 one. Age is a reason to rank lower, never a reason
    // to claim the store knows nothing.
    expect(judged(0.34, { freshness: 'fresh' })).toHaveLength(1);
    expect(judged(0.34, { freshness: 'stale' })).toHaveLength(1);
  });

  it('requires the same cosine of every candidate however it is dressed', () => {
    // The 36% spread in required cosine, closed. At the floor exactly, everything answers.
    for (const dressing of [BEST_DRESSED, WORST_DRESSED, { freshness: 'needs_review' as const }]) {
      expect(judged(MIN_VECTOR_RELEVANCE, dressing)).toHaveLength(1);
      expect(judged(MIN_VECTOR_RELEVANCE - 0.001, dressing)).toHaveLength(0);
    }
  });

  it('does not let a correction raise the bar on the siblings it flagged', () => {
    // Blast radius flips siblings to needs_review. That must not change what is answerable.
    const fresh = judged(0.31, { freshness: 'fresh' });
    const flagged = judged(0.31, { freshness: 'needs_review' });
    expect(flagged).toHaveLength(fresh.length);
  });
});

describe('K-36 -- an unindexed store cannot answer a question the indexed one abstained on', () => {
  it('keeps a just-written local item when its own store reached the verdict', () => {
    // The exemption exists for this: written since the last index, invisible to vector,
    // returned lexically. Its own store had judged candidates, so the verdict was informed.
    const scored = scoreCandidates(
      [
        { item: item('distant'), embedded: true, vectorRank: 1, vectorScore: 0.06 },
        { item: item('unindexed'), embedded: false, bm25Rank: 1, lexicalScore: 5 },
      ],
      { limit: 10, usingVector: true },
    );
    expect(scored.map(row => row.item.id)).toEqual(['unindexed']);
  });

  it('drops the peer in the exact shape lane 3 probed', () => {
    // Their numbers: a local item at cosine 0.18, embedded, alone returns [] -- the floor
    // deletes it correctly. Add one peer row at bm25Rank 1 with no embedding and the peer row
    // becomes the ONLY result, scored 0.0742, a quarter of the 0.30 floor, and unmarked.
    const local = { item: item('local'), repo: 'mine', embedded: true, vectorRank: 1, vectorScore: 0.18 };
    expect(scoreCandidates([{ ...local }], { limit: 10, usingVector: true })).toEqual([]);

    const union = scoreCandidates(
      [{ ...local }, { item: item('peer'), repo: 'theirs', embedded: false, bm25Rank: 1 }],
      { limit: 10, usingVector: true },
    );
    expect(union).toEqual([]);
  });

  it('drops a peer that contributed nothing the floor could judge', () => {
    // K-36, lane 3. The local store is indexed and says it does not know. The peer has no
    // embeddings at all, so every one of its rows escapes the floor and an off-topic peer
    // item becomes the only thing returned.
    const scored = scoreCandidates(
      [
        { item: item('local-distant'), repo: 'mine', embedded: true, vectorRank: 1, vectorScore: 0.06 },
        { item: item('peer-offtopic'), repo: 'theirs', embedded: false, bm25Rank: 1, lexicalScore: 5 },
      ],
      { limit: 10, usingVector: true },
    );
    expect(scored).toEqual([]);
  });

  it('still turns itself off when nothing anywhere is embedded', () => {
    const scored = scoreCandidates(
      [
        { item: item('a'), repo: 'mine', embedded: false, bm25Rank: 1, lexicalScore: 5 },
        { item: item('b'), repo: 'theirs', embedded: false, bm25Rank: 1, lexicalScore: 4 },
      ],
      { limit: 10, usingVector: true },
    );
    expect(scored).toHaveLength(2);
  });
});

describe('K-35 -- the score says how good the answer is', () => {
  const top = (cosine: number) => scoreCandidates(
    [{ item: item('x'), embedded: true, vectorRank: 1, vectorScore: cosine }],
    { limit: 1, usingVector: true },
  )[0];

  it('separates a strong match from the best of a bad lot', () => {
    // A rank cannot tell those apart, and RRF deliberately destroys the magnitude that can.
    expect(top(0.62).score).toBeGreaterThan(top(0.31).score + 0.2);
  });

  it('is comparable across queries, not normalised to the candidate set', () => {
    // Min-max over a small candidate set forces the top result to 1.0 whatever it is, which
    // is exactly the calibration this finding asks for and would silently destroy it.
    expect(top(0.45).score).toBeLessThan(0.9);
    expect(top(0.45).score).toBeGreaterThan(0.3);
  });

  it('does not tie an excellent lexical hit with a weak semantic one', () => {
    // Reciprocal rank gives 1/(60+1) to the top of either engine, so these scored exactly
    // equal and the order fell to whatever the sort did with a tie.
    // `semantic` is first in the array, so a tie resolved by a stable sort puts it first.
    const scored = scoreCandidates(
      [
        { item: item('semantic'), vectorRank: 1 },
        { item: item('lexical'), bm25Rank: 1, lexicalScore: 9 },
      ],
      { limit: 10, usingVector: false },
    );
    expect(scored[0].score).not.toBe(scored[1].score);
    expect(scored[0].item.id).toBe('lexical');
  });
});

describe('K-29 -- MMR is a property of the result set, not of an item', () => {
  const overlapping = (id: string, body: string) => ({
    item: item(id, { title: body, content: body }),
    bm25Rank: 1,
    lexicalScore: 1,
  });

  it('reports a score that is never negative and never rises down the list', () => {
    // The diversity penalty was folded into the reported score, which then went negative and
    // non-monotonic -- a result further down the list could carry a higher number than the
    // one above it.
    const scored = scoreCandidates(
      [
        overlapping('a', 'postgres connection pool sizing for the api server'),
        overlapping('b', 'postgres connection pool sizing for the worker'),
        overlapping('c', 'postgres connection pool sizing for the scheduler'),
        overlapping('d', 'entirely different subject about fonts'),
      ],
      { limit: 4, usingVector: false, query: 'postgres connection pool' },
    );

    for (const row of scored) {
      expect(row.score).toBeGreaterThanOrEqual(0);
      // The score is relevance times prior and nothing else. Diversity is reported beside it,
      // where a reader can see it, rather than inside the number they compare across results.
      const { relevance, prior } = row.explanation.contributions;
      expect(row.score).toBeCloseTo(relevance * prior, 10);
    }
    // Some item in this set overlaps another enough for MMR to have a say, or the assertion
    // above is passing for want of anything to correct.
    expect(scored.some(row => row.explanation.contributions.diversity > 0)).toBe(true);
  });

  it('leaves the ranking monotone where nothing reorders it', () => {
    // The vector path runs no MMR, so the returned order is the score order and a reader can
    // rely on the number falling as they read down.
    const scored = scoreCandidates(
      [
        { item: item('a'), embedded: true, vectorRank: 1, vectorScore: 0.9 },
        { item: item('b'), embedded: true, vectorRank: 2, vectorScore: 0.7 },
        { item: item('c'), embedded: true, vectorRank: 3, vectorScore: 0.5 },
      ],
      { limit: 3, usingVector: true },
    );
    for (let index = 1; index < scored.length; index += 1) {
      expect(scored[index].score).toBeLessThanOrEqual(scored[index - 1].score);
    }
  });

  it('does not drop a legitimate second answer for an unrelated note', () => {
    // lambda 0.2 weighted novelty four times relevance, so a 30% token overlap cost more
    // than the entire relevance term could award.
    const scored = scoreCandidates(
      [
        { ...overlapping('answer-1', 'the connection pool is sized at sixteen for postgres'), lexicalScore: 9 },
        { ...overlapping('answer-2', 'the connection pool overflow for postgres is four'), lexicalScore: 8 },
        { ...overlapping('unrelated', 'fonts are Baloo and Nunito'), lexicalScore: 0.2 },
      ],
      { limit: 2, usingVector: false, query: 'postgres connection pool size' },
    );

    expect(scored.map(row => row.item.id)).toEqual(['answer-1', 'answer-2']);
  });
});

describe('K-28 -- the text term is BM25 done worse', () => {
  const ROOT = path.resolve('./.knowl-scoring-k28');

  beforeAll(async () => {
    await closeDb();
    await releaseAll();
    await fs.rm(ROOT, { recursive: true, force: true }).catch(() => {});
    await fs.mkdir(path.join(ROOT, '.knowl'), { recursive: true });
    await saveConfig(ROOT, { ...DEFAULT_CONFIG });
    await initDb(ROOT);
    const projectId = (await repo.createProject(ROOT, 'p')).id;

    // The changelog: long, and it says the words over and over.
    await repo.createKnowledgeItem(projectId, {
      category: 'fact',
      title: 'Changelog for the connection pool',
      content: Array.from({ length: 12 }, (unused, index) =>
        `- connection pool change ${index}: the connection pool was touched again and the `
        + 'connection pool behaviour around the connection pool changed slightly.').join('\n'),
    });
    // The answer: short, exact, says it once.
    await repo.createKnowledgeItem(projectId, {
      category: 'fact',
      title: 'Connection pool size',
      content: 'The connection pool is sized at sixteen.',
    });
  });

  afterAll(async () => {
    await closeDb();
    await releaseAll();
    await fs.rm(ROOT, { recursive: true, force: true }).catch(() => {});
  });

  it('ranks the short exact answer above the twelve-line changelog', async () => {
    // A raw term-frequency count moved a result 38x further than the entire BM25 ordering,
    // and it was un-normalised for length -- precisely what BM25 exists to provide, one
    // layer below, where it was computed and discarded.
    const ranked = await rankKnowledge('local', { query: 'connection pool size', limit: 2 });
    expect(ranked.map(row => row.title)).toEqual(['Connection pool size', 'Changelog for the connection pool']);
  });
});
