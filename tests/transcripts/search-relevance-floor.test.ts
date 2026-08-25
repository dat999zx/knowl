import { describe, expect, it } from 'vitest';
import {
  fuseRankings, judgeRelevanceFloor, TRANSCRIPT_RELEVANCE_FLOOR, type TranscriptHit,
} from '../../src/transcripts/search.js';

/**
 * #183: transcript search returned nearest-neighbour noise with nothing marking it, because the
 * absolute cosine was computed in `semanticRank` and thrown away by the fusion. These pin the
 * two halves of the fix that are easy to reintroduce.
 */

const hit = (id: number, score: number, cosine?: number): TranscriptHit => ({
  messageId: id,
  path: '/p',
  sessionId: 's',
  parentSessionId: null,
  line: id,
  role: 'user',
  score,
  ...(cosine === undefined ? {} : { cosine }),
});

describe('fuseRankings carries the cosine', () => {
  it('keeps the semantic cosine when the lexical arm won the key', () => {
    // The order the real caller uses: lexical first, so its object wins the key and would have
    // silently dropped the cosine. This is the whole reason the merge exists.
    const lexical = [hit(1, 5)];
    const semantic = [hit(1, 0.91, 0.91)];

    const [fused] = fuseRankings([lexical, semantic], 10);

    expect(fused.messageId).toBe(1);
    expect(fused.cosine).toBe(0.91);
  });

  it('leaves a lexical-only hit without a cosine rather than inventing one', () => {
    const [fused] = fuseRankings([[hit(2, 5)]], 10);

    // Absent means unjudged. A 0 here would read as "certainly irrelevant" and would make a
    // half-indexed archive report every query as off-subject.
    expect(fused.cosine).toBeUndefined();
  });
});

describe('judgeRelevanceFloor', () => {
  it('judges the best hit, not each one', () => {
    // A real recall with a weak tail must not be called off-subject.
    const hits = [hit(1, 5, 0.90), hit(2, 4, 0.40), hit(3, 3, 0.20)];

    expect(judgeRelevanceFloor(hits, 0.76)).toBe(false);
  });

  it('is true only when every judged hit is below the floor', () => {
    const hits = [hit(1, 5, 0.51), hit(2, 4, 0.40)];

    expect(judgeRelevanceFloor(hits, 0.76)).toBe(true);
  });

  it('skips unembedded rows instead of scoring them zero', () => {
    // One good hit plus rows the semantic half never saw. Counting the absent ones as 0 would
    // not change the max here, but treating the whole page as unjudgeable would -- so this pins
    // that a mixed page is still judged on the row that has a number.
    const hits = [hit(1, 5), hit(2, 4, 0.88), hit(3, 3)];

    expect(judgeRelevanceFloor(hits, 0.76)).toBe(false);
  });

  it('returns undefined when nothing was judged at all', () => {
    expect(judgeRelevanceFloor([hit(1, 5), hit(2, 4)], 0.76)).toBeUndefined();
  });

  it('returns undefined when the model has no measured floor', () => {
    // `relevanceFloor: null` is a withheld claim, not a floor of zero.
    expect(judgeRelevanceFloor([hit(1, 5, 0.02)], null)).toBeUndefined();
  });

  it('returns undefined on an empty page', () => {
    expect(judgeRelevanceFloor([], 0.76)).toBeUndefined();
  });
});

describe('TRANSCRIPT_RELEVANCE_FLOOR', () => {
  it('is null, so no page is judged until a floor is measured on transcripts', () => {
    // Pins the #189 decision rather than the value. The knowledge floors are measured over
    // atom fixtures, and borrowing one here judged EVERY query off-subject -- including ones the
    // archive answers -- which the fallback chain turned into "nothing here" over an archive
    // holding the answer. Arming this needs its own measurement, not a different borrow.
    expect(TRANSCRIPT_RELEVANCE_FLOOR).toBeNull();

    // A strong hit and pure noise reach the same verdict while the floor is null: none.
    expect(judgeRelevanceFloor([hit(1, 5, 0.95)], TRANSCRIPT_RELEVANCE_FLOOR)).toBeUndefined();
    expect(judgeRelevanceFloor([hit(2, 5, 0.10)], TRANSCRIPT_RELEVANCE_FLOOR)).toBeUndefined();
  });
});
