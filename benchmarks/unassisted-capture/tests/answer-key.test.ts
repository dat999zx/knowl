import { describe, expect, it } from 'vitest';
import { parseAnswerKey } from '../src/answer-key.js';

const line = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    sessionId: 's1',
    targets: [{ targetId: 't1', canonicalFact: 'The retry loop was removed.', mark: 'findable' }],
    exclusions: [],
    ...overrides,
  });

describe('parseAnswerKey', () => {
  it('parses one record per line', () => {
    const keys = parseAnswerKey(
      `${line()}\n${line({ sessionId: 's2', targets: [{ targetId: 't2', canonicalFact: 'Another fact.', mark: 'findable' }] })}`
    );

    expect(keys.map((k) => k.sessionId)).toEqual(['s1', 's2']);
    expect(keys[0].targets[0].mark).toBe('findable');
  });

  it('ignores blank lines so a trailing newline is not an error', () => {
    expect(parseAnswerKey(`${line()}\n\n`)).toHaveLength(1);
  });

  it('rejects a mark outside the two allowed values', () => {
    const bad = line({ targets: [{ targetId: 't1', canonicalFact: 'x', mark: 'maybe' }] });

    expect(() => parseAnswerKey(bad)).toThrow(/mark/i);
  });

  it('rejects a duplicate targetId even across different sessions', () => {
    // Distinct sessions, same targetId -- the session check passes and the target check catches it.
    const second = line({ sessionId: 's2' });

    expect(() => parseAnswerKey(`${line()}\n${second}`)).toThrow(/duplicate targetId/i);
  });

  it('rejects a duplicate sessionId', () => {
    // Same session, distinct targetId -- the session check fires first.
    const other = line({ targets: [{ targetId: 't2', canonicalFact: 'y', mark: 'findable' }] });

    expect(() => parseAnswerKey(`${line()}\n${other}`)).toThrow(/duplicate session/i);
  });

  it('rejects an empty canonicalFact, which would match everything', () => {
    const bad = line({ targets: [{ targetId: 't1', canonicalFact: '   ', mark: 'findable' }] });

    expect(() => parseAnswerKey(bad)).toThrow();
  });
});
