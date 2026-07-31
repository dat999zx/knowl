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
    exclusions: [],
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

  it('reports per-session rows so the spread can be judged', async () => {
    const score = await scoreMethod({ method: 'm', answerKey, predictions: [], threshold: 0.5, embed });

    expect(score.perSession).toHaveLength(1);
    expect(score.perSession[0]).toMatchObject({ sessionId: 's1', findableTotal: 1, thinkingOnlyTotal: 1 });
  });
});
