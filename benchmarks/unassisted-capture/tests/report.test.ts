import { describe, expect, it } from 'vitest';
import { readStage1, renderReport } from '../src/report.js';
import type { MethodScore } from '../src/types.js';

const score = (overrides: Partial<MethodScore> = {}): MethodScore => ({
  method: 'model-events',
  recallFindable: 0.5,
  recallThinkingOnly: 0.1,
  precision: 0.9,
  perSession: [
    { sessionId: 's1', findableTotal: 2, findableMatched: 1, thinkingOnlyTotal: 1, thinkingOnlyMatched: 0, predictedTotal: 1, predictedMatched: 1 },
  ],
  bandPairs: [],
  ...overrides,
});

describe('readStage1', () => {
  it('proceeds when recall clears 0.30 at or above the junk limit', () => {
    expect(readStage1(score())).toMatchObject({ proceed: true, disqualified: false });
  });

  it('stops when recall is below 0.30', () => {
    const reading = readStage1(score({ recallFindable: 0.29 }));

    expect(reading.proceed).toBe(false);
    expect(reading.verdict).toMatch(/payload/i);
  });

  it('disqualifies a method under the 0.80 junk limit however high its recall', () => {
    const reading = readStage1(score({ recallFindable: 0.99, precision: 0.79 }));

    expect(reading.disqualified).toBe(true);
    expect(reading.proceed).toBe(false);
  });

  it('treats exactly 0.30 recall and exactly 0.80 precision as passing', () => {
    expect(readStage1(score({ recallFindable: 0.3, precision: 0.8 }))).toMatchObject({
      proceed: true,
      disqualified: false,
    });
  });
});

describe('renderReport', () => {
  it('shows the headline numbers and flags band pairs needing adjudication', () => {
    const withBand = score({ bandPairs: [{ sessionId: 's1', targetId: 't1', predictedIndex: 0, similarity: 0.72 }] });
    const text = renderReport(withBand, readStage1(withBand));

    expect(text).toContain('0.50');
    expect(text).toContain('0.90');
    expect(text).toMatch(/1 pair/i);
  });

  it('states the thinking-only ceiling separately from headline recall', () => {
    expect(renderReport(score(), readStage1(score()))).toMatch(/thinking-only/i);
  });
});
