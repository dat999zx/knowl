import { describe, expect, it } from 'vitest';
import { scoreNativeCapture } from '../../benchmarks/accuracy/src/native-score.js';
import type { NativeCapturePrediction } from '../../benchmarks/accuracy/src/native-collect.js';
import type { ModeCapabilities } from '../../benchmarks/accuracy/src/protocol.js';
import type { CaptureGold, NativeHistory } from '../../benchmarks/accuracy/src/schema.js';

const capabilities: ModeCapabilities = {
  supported: true,
  sourceProvenance: true,
  temporalAsOf: false,
  retrievalAbstention: false,
  memoryInventory: true,
  nativeContextComposition: false,
};

function historiesFor(gold: CaptureGold[]): NativeHistory[] {
  return gold.map(row => ({
    historyId: row.historyId,
    projectId: 'p1',
    sessions: [{
      sessionId: `session-${row.historyId}`,
      startedAt: '2026-01-01T00:00:00.000Z',
      endedAt: '2026-01-01T01:00:00.000Z',
      termination: 'normal',
      events: [
        ...row.targets.flatMap(target => target.evidenceSourceIds.map(sourceId => ({
          sourceId,
          occurredAt: '2026-01-01T00:00:00.000Z',
          type: 'assistant' as const,
          content: target.canonicalFact,
        }))),
        ...row.exclusions.map(exclusion => ({
          sourceId: exclusion.sourceId,
          occurredAt: '2026-01-01T00:00:00.000Z',
          type: 'tool_result' as const,
          content: exclusion.sourceId === 'secret-x'
            ? 'retained secret'
            : exclusion.sourceId === 'secret-y'
              ? 'beta plus secret'
              : 'replayed event',
        })),
      ],
    }],
  }));
}

describe('native capture scoring', () => {
  it('uses one-to-one source matching and penalizes missing supported output', () => {
    const gold: CaptureGold[] = [
      {
        historyId: 'h1',
        targets: [
          { targetId: 't1', canonicalFact: 'alpha', evidenceSourceIds: ['a'] },
          { targetId: 't2', canonicalFact: 'beta', evidenceSourceIds: ['b'] },
        ],
        exclusions: [
          { sourceId: 'secret-x', reason: 'secret' },
          { sourceId: 'secret-y', reason: 'secret' },
          { sourceId: 'duplicate-input', reason: 'duplicate' },
        ],
      },
      {
        historyId: 'h2',
        targets: [{ targetId: 't3', canonicalFact: 'gamma', evidenceSourceIds: ['c'] }],
        exclusions: [],
      },
    ];
    const predictions: NativeCapturePrediction[] = [{
      historyId: 'h1',
      memories: [
        { memoryId: 'm1', text: 'alpha', sourceIds: ['a'] },
        { memoryId: 'm2', text: 'alpha again', sourceIds: ['a'] },
        { memoryId: 'm3', text: 'retained secret', sourceIds: ['secret-x'] },
        { memoryId: 'm4', text: 'unattributed output' },
        { memoryId: 'm5', text: 'replayed event', sourceIds: ['duplicate-input'] },
        { memoryId: 'm6', text: 'beta plus secret', sourceIds: ['b', 'secret-y'] },
      ],
    }];

    const result = scoreNativeCapture(historiesFor(gold), gold, predictions, capabilities);

    expect(result.metrics.capturePrecision).toEqual({ value: 1 / 3, numerator: 2, denominator: 6 });
    expect(result.metrics.captureRecall).toEqual({ value: 2 / 3, numerator: 2, denominator: 3 });
    expect(result.metrics.captureF1).toEqual({ value: 4 / 9, numerator: 4, denominator: 9 });
    expect(result.metrics.falsePromotionRate).toEqual({ value: 2 / 3, numerator: 4, denominator: 6 });
    expect(result.metrics.duplicatePromotionRate).toEqual({ value: 1 / 3, numerator: 2, denominator: 6 });
    expect(result.metrics.secretLeakRate).toEqual({ value: 1, numerator: 2, denominator: 2 });
    expect(result.metrics.provenanceCoverage).toEqual({ value: 5 / 6, numerator: 5, denominator: 6 });
    expect(result.metrics.evidenceCoverage).toEqual({ value: 2 / 3, numerator: 2, denominator: 3 });
    expect(result.perHistory[0]).toMatchObject({
      historyId: 'h1',
      matchedTargets: 2,
      falsePromotions: 4,
      duplicatePromotions: 2,
      secretLeaks: 2,
      missingOutput: false,
    });
    expect(result.perHistory[1]).toMatchObject({
      historyId: 'h2',
      matchedTargets: 0,
      missingOutput: true,
      error: 'missing prediction',
    });
    expect(result.failures).toEqual([{ historyId: 'h2', reason: 'missing prediction' }]);
  });

  it('finds a maximum one-to-one matching instead of depending on greedy order', () => {
    const gold: CaptureGold[] = [{
      historyId: 'h1',
      targets: [
        { targetId: 'flexible', canonicalFact: 'one', evidenceSourceIds: ['a', 'b'] },
        { targetId: 'a-only', canonicalFact: 'two', evidenceSourceIds: ['a'] },
      ],
      exclusions: [],
    }];
    const predictions: NativeCapturePrediction[] = [{
      historyId: 'h1',
      memories: [
        { memoryId: 'uses-a', text: 'two', sourceIds: ['a'] },
        { memoryId: 'uses-b', text: 'one', sourceIds: ['b'] },
      ],
    }];

    const result = scoreNativeCapture(historiesFor(gold), gold, predictions, capabilities);

    expect(result.metrics.captureRecall.value).toBe(1);
    expect(result.metrics.capturePrecision.value).toBe(1);
    expect(result.perHistory[0].matches).toEqual([
      { memoryId: 'uses-a', targetId: 'a-only' },
      { memoryId: 'uses-b', targetId: 'flexible' },
    ]);
  });

  it('reports unsupported provenance as N/A rather than zero', () => {
    const result = scoreNativeCapture([], [], [], { ...capabilities, sourceProvenance: false });

    expect(result.naReason).toBe('adapter does not expose source provenance');
    expect(result.metrics.capturePrecision.value).toBeNull();
    expect(result.metrics.captureRecall.value).toBeNull();
    expect(result.metrics.secretLeakRate.value).toBeNull();
  });
});
