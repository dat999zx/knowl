import { describe, expect, it } from 'vitest';
import { assertAnswerKeyResolves, parseFrozenThreshold } from '../src/preflight.js';

const valid = {
  threshold: 0.61,
  agreement: 0.95,
  pairs: 20,
  frozenAt: '2026-07-31T00:00:00.000Z',
  pairsSha256: 'a'.repeat(64),
};

describe('parseFrozenThreshold', () => {
  it('accepts a well-formed frozen threshold and returns its audit fields', () => {
    expect(parseFrozenThreshold(JSON.stringify(valid), 'threshold.json')).toEqual(valid);
  });

  it('accepts a threshold frozen before the pair hash existed', () => {
    const { pairsSha256, ...withoutHash } = valid;

    expect(parseFrozenThreshold(JSON.stringify(withoutHash), 'threshold.json').pairsSha256).toBeUndefined();
  });

  it('rejects an empty object rather than yielding an undefined threshold', () => {
    // `similarity >= undefined` is false for every pair, so this would report precision 0 and
    // recall 0 -- indistinguishable from a real disqualification.
    expect(() => parseFrozenThreshold('{}', 'threshold.json')).toThrow(/threshold/i);
  });

  it('rejects a renamed threshold field', () => {
    const renamed = { ...valid, matchThreshold: valid.threshold } as Record<string, unknown>;
    delete renamed.threshold;

    expect(() => parseFrozenThreshold(JSON.stringify(renamed), 'threshold.json')).toThrow(/threshold/i);
  });

  it('rejects a non-finite threshold, which compares false against everything', () => {
    // JSON has no NaN literal; a truncated or hand-edited file reaches the same state via a
    // string or null, and Infinity arrives via a serialiser that writes it out of range.
    expect(() => parseFrozenThreshold('{"threshold":"0.6","agreement":0.9,"pairs":20,"frozenAt":"x"}', 'f')).toThrow();
    expect(() => parseFrozenThreshold('{"threshold":null,"agreement":0.9,"pairs":20,"frozenAt":"x"}', 'f')).toThrow();
    expect(() => parseFrozenThreshold('{"threshold":1e400,"agreement":0.9,"pairs":20,"frozenAt":"x"}', 'f')).toThrow();
  });

  it('rejects a threshold outside the cosine range', () => {
    expect(() => parseFrozenThreshold(JSON.stringify({ ...valid, threshold: 1.4 }), 'f')).toThrow();
    expect(() => parseFrozenThreshold(JSON.stringify({ ...valid, threshold: -0.2 }), 'f')).toThrow();
  });

  it('rejects a truncated file by name instead of throwing a bare SyntaxError', () => {
    expect(() => parseFrozenThreshold('{"threshold": 0.6', 'answer-key/threshold.json')).toThrow(
      /answer-key\/threshold\.json is not valid JSON/,
    );
  });

  it('requires the preregistration fields an auditor needs', () => {
    const { frozenAt, ...withoutFrozenAt } = valid;
    const { agreement, ...withoutAgreement } = valid;

    expect(() => parseFrozenThreshold(JSON.stringify(withoutFrozenAt), 'f')).toThrow(/frozenAt/);
    expect(() => parseFrozenThreshold(JSON.stringify(withoutAgreement), 'f')).toThrow(/agreement/);
  });
});

describe('assertAnswerKeyResolves', () => {
  it('passes when every answer key session exists in the corpus', () => {
    expect(() => assertAnswerKeyResolves(['s1', 's2'], ['s1', 's2', 's3'])).not.toThrow();
  });

  it('names every unmatched id so the typo can be found', () => {
    expect(() => assertAnswerKeyResolves(['s1', 'typo-a', 'typo-b'], ['s1', 's2'])).toThrow(/typo-a, typo-b/);
  });

  it('fails on a single typo, which would otherwise lower recall silently', () => {
    // The mechanism: the mistyped session is never sent to the model, but scoreMethod still
    // counts its findableTotal, so recall drops against a 0.30 gate with nothing to show for it.
    expect(() => assertAnswerKeyResolves(['sess-abc'], ['sess-acb'])).toThrow(/not in the corpus/i);
  });

  it('does not object to a corpus session that the answer key omits', () => {
    expect(() => assertAnswerKeyResolves(['s1'], ['s1', 's2', 's3'])).not.toThrow();
  });
});
