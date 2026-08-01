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
  failedSessions: [],
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

  it('disqualifies on precision before considering recall, when both gates fail', () => {
    // The only input where check order is observable: both gates fail. Under the correct
    // order the verdict is about the junk limit; under a swapped order it would be about
    // the payload, and disqualified would be false.
    const reading = readStage1(score({ recallFindable: 0.1, precision: 0.5 }));

    expect(reading.disqualified).toBe(true);
    expect(reading.proceed).toBe(false);
    expect(reading.verdict).toMatch(/junk limit/i);
    expect(reading.verdict).not.toMatch(/payload/i);
  });
});

describe('renderReport', () => {
  it('shows the headline numbers and flags band pairs needing adjudication', () => {
    const withBand = score({
      bandPairs: [
        {
          sessionId: 's1',
          targetId: 't1',
          predictedIndex: 0,
          predictedText: 'the retry loop is gone',
          goldFact: 'the retry loop was removed',
          similarity: 0.72,
        },
      ],
    });
    const text = renderReport(withBand, readStage1(withBand));

    expect(text).toContain('0.50');
    expect(text).toContain('0.90');
    expect(text).toMatch(/1 pair/i);
  });

  it('states the thinking-only ceiling separately from headline recall', () => {
    expect(renderReport(score(), readStage1(score()))).toMatch(/thinking-only/i);
  });

  it('reports failed sessions and warns that recall is only a lower bound', () => {
    const withFailures = score({
      failedSessions: [
        { sessionId: 's7', message: 'rate limited' },
        { sessionId: 's8', message: 'socket hang up' },
      ],
    });
    const text = renderReport(withFailures, readStage1(withFailures));

    expect(text).toMatch(/Sessions failed\s+2/);
    expect(text).toMatch(/lower bound/i);
  });

  it('does not warn about a lower bound when every session ran', () => {
    const text = renderReport(score(), readStage1(score()));

    expect(text).toMatch(/Sessions failed\s+0/);
    expect(text).not.toMatch(/lower bound/i);
  });
});
