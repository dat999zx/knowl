import { describe, expect, it } from 'vitest';
import { scoreRetrieval } from '../../benchmarks/accuracy/src/score.js';
import type { AdapterCapabilities, RetrievalPrediction } from '../../benchmarks/accuracy/src/protocol.js';
import type { NormalizedRecord, PublicQuery, QuestionGold } from '../../benchmarks/accuracy/src/schema.js';

const records: NormalizedRecord[] = ['a', 'b', 'c', 'd', 'e'].map(sourceId => ({
  sourceId,
  projectId: 'p1',
  historyId: 'h1',
  sessionId: `s-${sourceId}`,
  occurredAt: '2026-01-01T00:00:00.000Z',
  availableAt: '2026-01-01T00:00:00.000Z',
  kind: 'state',
  title: sourceId,
  content: sourceId,
}));

const queries: PublicQuery[] = [
  { questionId: 'q1', projectId: 'p1', historyId: 'h1', issuedAt: '2026-01-05T00:00:00.000Z', text: 'current value?' },
  { questionId: 'q2', projectId: 'p1', historyId: 'h1', issuedAt: '2026-01-05T00:00:00.000Z', text: 'unknown secret?' },
  { questionId: 'q3', projectId: 'p1', historyId: 'h1', issuedAt: '2026-01-05T00:00:00.000Z', text: 'missing response?' },
];

const gold: QuestionGold[] = [
  {
    questionId: 'q1', category: 'current_state', shouldAbstain: false,
    answer: { kind: 'string', canonical: 'alpha', acceptedText: ['alpha'] },
    judgments: [
      { sourceId: 'a', grade: 3, role: 'answer' },
      { sourceId: 'b', grade: 2, role: 'support' },
      { sourceId: 'c', grade: 1, role: 'background' },
    ],
    requiredEvidenceGroups: [['a'], ['b']],
    harmful: [{ sourceId: 'd', reason: 'superseded' }],
    temporalKind: 'current',
  },
  {
    questionId: 'q2', category: 'abstention', shouldAbstain: true,
    answer: { kind: 'abstain', canonical: null, acceptedText: ['unknown'] },
    judgments: [], requiredEvidenceGroups: [], harmful: [],
  },
  {
    questionId: 'q3', category: 'constraint', shouldAbstain: false,
    answer: { kind: 'string', canonical: 'required', acceptedText: ['required'] },
    judgments: [{ sourceId: 'e', grade: 3, role: 'answer' }],
    requiredEvidenceGroups: [['e']], harmful: [],
  },
];

const capabilities: AdapterCapabilities = {
  normalized: {
    supported: true,
    sourceProvenance: true,
    temporalAsOf: true,
    retrievalAbstention: true,
    memoryInventory: false,
    nativeContextComposition: false,
  },
  native: {
    supported: false,
    sourceProvenance: false,
    temporalAsOf: false,
    retrievalAbstention: false,
    memoryInventory: false,
    nativeContextComposition: false,
    reason: 'not implemented',
  },
};

describe('retrieval scoring', () => {
  it('scores graded relevance, strict evidence, harmful hits, duplicates, abstention, and missing predictions', () => {
    const predictions: RetrievalPrediction[] = [
      {
        questionId: 'q1',
        response: {
          decision: 'results',
          hits: [
            { memoryId: 'm1', text: 'alpha', sourceIds: ['a'] },
            { memoryId: 'm2', text: 'stale', sourceIds: ['d'] },
            { memoryId: 'm3', text: 'duplicate alpha', sourceIds: ['a'] },
            { memoryId: 'm4', text: 'background', sourceIds: ['c'] },
          ],
        },
      },
      { questionId: 'q2', response: { decision: 'abstain', hits: [] } },
      { questionId: 'q3', error: 'adapter timeout' },
    ];

    const result = scoreRetrieval(records, queries, gold, predictions, capabilities.normalized, 5);

    expect(result.metrics.recallAt1).toEqual({ value: 1 / 3, numerator: 1, denominator: 3 });
    expect(result.metrics.recallAt3).toEqual({ value: 1 / 3, numerator: 1, denominator: 3 });
    expect(result.metrics.mrr).toEqual({ value: 0.5, numerator: 1, denominator: 2 });
    expect(result.metrics.ndcgAt5.value).toBeCloseTo(0.39555, 4);
    expect(result.metrics.forbiddenResultRate).toEqual({ value: 0.25, numerator: 1, denominator: 4 });
    expect(result.metrics.staleResultRate).toEqual({ value: 0.25, numerator: 1, denominator: 4 });
    expect(result.metrics.duplicateResultRate).toEqual({ value: 0.25, numerator: 1, denominator: 4 });
    expect(result.metrics.abstentionAccuracy).toEqual({ value: 1, numerator: 1, denominator: 1 });
    expect(result.metrics.strictAccuracyAtK).toEqual({ value: 1 / 3, numerator: 1, denominator: 3 });
    expect(result.metrics.applicableCoverage).toEqual({ value: 1, numerator: 3, denominator: 3 });
    expect(result.failures).toEqual([
      { questionId: 'q1', reason: 'forbidden, cross-project, unknown, or unattributed result returned' },
      { questionId: 'q3', reason: 'adapter timeout' },
    ]);
  });

  it('returns N/A instead of invented zeroes for unsupported provenance', () => {
    const withoutProvenance = {
      ...capabilities.normalized,
      sourceProvenance: false,
    };
    const result = scoreRetrieval(records, queries, gold, [], withoutProvenance, 5);

    expect(result.metrics.recallAt5.value).toBeNull();
    expect(result.metrics.ndcgAt5.value).toBeNull();
    expect(result.metrics.strictAccuracyAtK).toEqual({ value: 0, numerator: 0, denominator: 1 });
    expect(result.metrics.applicableCoverage).toEqual({ value: 1 / 3, numerator: 1, denominator: 3 });
    expect(result.perQuery.filter(row => row.notApplicableReason)).toHaveLength(2);
  });

  it('ranks consolidated hits once and treats fake or cross-project provenance as forbidden', () => {
    const predictions: RetrievalPrediction[] = [{
      questionId: 'q1',
      response: {
        decision: 'results',
        hits: [
          { memoryId: 'consolidated', text: 'alpha and support', sourceIds: ['a', 'b'] },
          { memoryId: 'fake', text: 'fake', sourceIds: ['not-a-source'] },
        ],
      },
    }];
    const result = scoreRetrieval(records, queries.slice(0, 1), gold.slice(0, 1), predictions, capabilities.normalized, 5);

    expect(result.metrics.recallAt1).toEqual({ value: 1, numerator: 2, denominator: 2 });
    expect(result.metrics.mrr).toEqual({ value: 1, numerator: 1, denominator: 1 });
    expect(result.perQuery[0].forbiddenHits).toBe(1);
    expect(result.perQuery[0].strictCorrect).toBe(false);
  });

  it('marks abstention questions N/A when abstention is unsupported', () => {
    const result = scoreRetrieval(
      records,
      queries,
      gold,
      [],
      { ...capabilities.normalized, retrievalAbstention: false },
      5,
    );

    expect(result.metrics.abstentionAccuracy.value).toBeNull();
    expect(result.metrics.abstentionCoverage).toEqual({ value: 0, numerator: 0, denominator: 1 });
  });
});
