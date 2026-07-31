import { describe, expect, it } from 'vitest';
import { scoreMethod } from '../src/score.js';
import type { AnswerKey, PredictedAtom } from '../src/types.js';

const vectors: Record<string, number[]> = {
  'retry loop removed': [1, 0, 0],
  'the retry loop was removed': [1, 0, 0],
  'why it deadlocked': [0, 1, 0],
  'unrelated noise': [0, 0, 1],
};
const embed = async (texts: string[]) => texts.map((text) => vectors[text] ?? [0, 0, 0]);

const answerKey: AnswerKey[] = [
  {
    sessionId: 's1',
    targets: [
      { targetId: 't1', canonicalFact: 'the retry loop was removed', mark: 'findable' },
      { targetId: 't2', canonicalFact: 'why it deadlocked', mark: 'thinking-only' },
    ],
  },
];

describe('scoreMethod', () => {
  it('counts a findable hit in recall', async () => {
    const predictions: PredictedAtom[] = [
      { sessionId: 's1', category: 'fact', title: '', content: 'retry loop removed' },
    ];

    const score = await scoreMethod({ method: 'm', answerKey, predictions, threshold: 0.5, embed });

    expect(score.recallFindable).toBe(1);
    expect(score.precision).toBe(1);
    expect(score.recallThinkingOnly).toBe(0);
  });

  it('excludes thinking-only items from headline recall', async () => {
    const predictions: PredictedAtom[] = [
      { sessionId: 's1', category: 'fact', title: '', content: 'why it deadlocked' },
    ];

    const score = await scoreMethod({ method: 'm', answerKey, predictions, threshold: 0.5, embed });

    expect(score.recallFindable).toBe(0);
    expect(score.recallThinkingOnly).toBe(1);
    expect(score.precision).toBe(1);
  });

  it('counts an unmatched prediction against precision', async () => {
    const predictions: PredictedAtom[] = [
      { sessionId: 's1', category: 'fact', title: '', content: 'retry loop removed' },
      { sessionId: 's1', category: 'fact', title: '', content: 'unrelated noise' },
    ];

    const score = await scoreMethod({ method: 'm', answerKey, predictions, threshold: 0.5, embed });

    expect(score.precision).toBe(0.5);
    expect(score.recallFindable).toBe(1);
  });

  it('reports zero precision rather than NaN when a method predicts nothing', async () => {
    const score = await scoreMethod({ method: 'm', answerKey, predictions: [], threshold: 0.5, embed });

    expect(score.precision).toBe(0);
    expect(score.recallFindable).toBe(0);
  });

  it('collects borderline pairs for hand adjudication', async () => {
    const predictions: PredictedAtom[] = [
      { sessionId: 's1', category: 'fact', title: '', content: 'retry loop removed' },
    ];

    const score = await scoreMethod({ method: 'm', answerKey, predictions, threshold: 0.95, embed });

    expect(score.bandPairs.length).toBeGreaterThan(0);
    expect(score.bandPairs[0].targetId).toBe('t1');
  });

  it('carries both texts on a band pair so it can be adjudicated from the results file alone', async () => {
    // An index into a prediction array that no longer exists is not adjudicable: the hand
    // judgment happens after the process is gone, and a re-run at temperature 0.1 reproduces
    // neither the atoms nor their order.
    const predictions: PredictedAtom[] = [
      { sessionId: 's1', category: 'fact', title: '', content: 'retry loop removed' },
    ];

    const score = await scoreMethod({ method: 'm', answerKey, predictions, threshold: 0.95, embed });
    const pair = score.bandPairs.find((p) => p.targetId === 't1');

    expect(pair).toBeDefined();
    expect(pair!.predictedText).toBe('retry loop removed');
    expect(pair!.goldFact).toBe('the retry loop was removed');
  });

  it('reports the failed sessions it was handed, so a rate-limited run is not read as a real zero', async () => {
    const score = await scoreMethod({
      method: 'm',
      answerKey,
      predictions: [],
      threshold: 0.5,
      embed,
      failedSessions: [{ sessionId: 's9', message: 'rate limited' }],
    });

    expect(score.failedSessions).toEqual([{ sessionId: 's9', message: 'rate limited' }]);
  });

  it('reports per-session rows so the spread can be judged', async () => {
    const score = await scoreMethod({ method: 'm', answerKey, predictions: [], threshold: 0.5, embed });

    expect(score.perSession).toHaveLength(1);
    expect(score.perSession[0]).toMatchObject({ sessionId: 's1', findableTotal: 1, thinkingOnlyTotal: 1 });
  });
});

describe('scoreMethod across sessions of different sizes', () => {
  // Production is 32 sessions. At n=1 micro-average, macro-average and "return the first row"
  // are indistinguishable, so the aggregation is only pinned by an asymmetric two-session case.
  const crossVectors: Record<string, number[]> = {
    'alpha fact': [1, 0, 0, 0],
    'alpha restated': [1, 0, 0, 0],
    'beta fact': [0, 1, 0, 0],
    'beta restated': [0, 1, 0, 0],
    'gamma fact': [0, 0, 1, 0],
    'delta fact': [0, 0, 0, 1],
  };
  const crossEmbed = async (texts: string[]) => texts.map((text) => crossVectors[text] ?? [0, 0, 0, 0]);

  const twoSessions: AnswerKey[] = [
    // Small session, fully recovered and fully clean.
    { sessionId: 'small', targets: [{ targetId: 'a1', canonicalFact: 'alpha fact', mark: 'findable' }] },
    // Large session, one of three recovered and one of three predictions clean.
    {
      sessionId: 'large',
      targets: [
        { targetId: 'b1', canonicalFact: 'beta fact', mark: 'findable' },
        { targetId: 'b2', canonicalFact: 'gamma fact', mark: 'findable' },
        { targetId: 'b3', canonicalFact: 'delta fact', mark: 'findable' },
      ],
    },
  ];

  const twoSessionPredictions: PredictedAtom[] = [
    { sessionId: 'small', category: 'fact', title: '', content: 'alpha restated' },
    { sessionId: 'large', category: 'fact', title: '', content: 'beta restated' },
    { sessionId: 'large', category: 'fact', title: '', content: 'noise one' },
    { sessionId: 'large', category: 'fact', title: '', content: 'noise two' },
  ];

  it('pools totals across sessions instead of averaging per-session rates', async () => {
    const score = await scoreMethod({
      method: 'm',
      answerKey: twoSessions,
      predictions: twoSessionPredictions,
      threshold: 0.5,
      embed: crossEmbed,
    });

    expect(score.perSession).toMatchObject([
      { sessionId: 'small', findableTotal: 1, findableMatched: 1, predictedTotal: 1, predictedMatched: 1 },
      { sessionId: 'large', findableTotal: 3, findableMatched: 1, predictedTotal: 3, predictedMatched: 1 },
    ]);

    // Micro: 2 of 4 gold, 2 of 4 predictions. Macro would be (1 + 1/3) / 2 = 0.667 for both,
    // and "first row only" would be 1 for both -- the three answers are all distinct here.
    expect(score.recallFindable).toBe(0.5);
    expect(score.precision).toBe(0.5);
    expect(score.recallFindable).not.toBeCloseTo(2 / 3, 5);
    expect(score.precision).not.toBeCloseTo(2 / 3, 5);
  });

  it('pools thinking-only coverage the same way', async () => {
    const key: AnswerKey[] = [
      { sessionId: 'small', targets: [{ targetId: 'a1', canonicalFact: 'alpha fact', mark: 'thinking-only' }] },
      {
        sessionId: 'large',
        targets: [
          { targetId: 'b1', canonicalFact: 'beta fact', mark: 'thinking-only' },
          { targetId: 'b2', canonicalFact: 'gamma fact', mark: 'thinking-only' },
          { targetId: 'b3', canonicalFact: 'delta fact', mark: 'thinking-only' },
        ],
      },
    ];

    const score = await scoreMethod({
      method: 'm',
      answerKey: key,
      predictions: twoSessionPredictions,
      threshold: 0.5,
      embed: crossEmbed,
    });

    expect(score.recallThinkingOnly).toBe(0.5);
    expect(score.recallThinkingOnly).not.toBeCloseTo(2 / 3, 5);
  });
});
