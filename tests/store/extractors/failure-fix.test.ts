import { describe, expect, it } from 'vitest';
import { findFailureFixPairs } from '../../../src/store/extractors/failure-fix.js';
import type { MemorySessionEvent } from '../../../src/core/types.js';

let seq = 0;
const event = (type: string, payload: Record<string, unknown>): MemorySessionEvent => ({
  id: `e${++seq}`,
  sessionId: 's1',
  type: type as MemorySessionEvent['type'],
  payload,
  observedAt: `2026-07-31T00:00:${String(seq).padStart(2, '0')}.000Z`,
  expiresAt: '2026-08-02T00:00:00.000Z',
});

describe('findFailureFixPairs', () => {
  it('pairs an error with the edits that followed it', () => {
    const pairs = findFailureFixPairs([
      event('error', { message: 'TypeError: x is not a function' }),
      event('checkpoint', { changedPaths: ['src/a.ts'] }),
      event('stop', { status: 'finished' }),
    ]);

    expect(pairs).toHaveLength(1);
    expect(pairs[0].message).toContain('TypeError');
    expect(pairs[0].changedPaths).toEqual(['src/a.ts']);
  });

  it('does not pair an error that recurs later — it was not fixed', () => {
    expect(findFailureFixPairs([
      event('error', { message: 'TypeError: x is not a function' }),
      event('checkpoint', { changedPaths: ['src/a.ts'] }),
      event('error', { message: 'TypeError: x is not a function' }),
    ])).toEqual([]);
  });

  it('recognises recurrence despite different paths and line numbers', () => {
    expect(findFailureFixPairs([
      event('error', { message: 'AssertionError: nope\n at D:/a/x.ts:1:2' }),
      event('checkpoint', { changedPaths: ['src/a.ts'] }),
      event('error', { message: 'AssertionError: nope\n at C:/b/y.ts:99:8' }),
    ])).toEqual([]);
  });

  it('does not pair an error with no edits after it', () => {
    expect(findFailureFixPairs([
      event('error', { message: 'TypeError: boom' }),
      event('stop', { status: 'failed' }),
    ])).toEqual([]);
  });

  it('collects every changed path after the error, de-duplicated', () => {
    const pairs = findFailureFixPairs([
      event('error', { message: 'TypeError: boom' }),
      event('checkpoint', { changedPaths: ['src/a.ts', 'src/b.ts'] }),
      event('checkpoint', { changedPaths: ['src/a.ts'] }),
    ]);

    expect(pairs[0].changedPaths).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('pairs two different errors independently', () => {
    const pairs = findFailureFixPairs([
      event('error', { message: 'TypeError: first' }),
      event('checkpoint', { changedPaths: ['src/a.ts'] }),
      event('error', { message: 'RangeError: second' }),
      event('checkpoint', { changedPaths: ['src/b.ts'] }),
    ]);

    expect(pairs).toHaveLength(2);
    expect(pairs[1].changedPaths).toEqual(['src/b.ts']);
  });

  it('ignores an error event carrying no message', () => {
    expect(findFailureFixPairs([
      event('error', {}),
      event('checkpoint', { changedPaths: ['src/a.ts'] }),
    ])).toEqual([]);
  });
});
