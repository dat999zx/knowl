import { InvalidArgumentError } from 'commander';
import { describe, expect, it } from 'vitest';
import { positiveInt } from '../../src/cli/parse-options.js';

describe('positiveInt', () => {
  const limit = positiveInt('--limit');

  it('parses a plain decimal', () => {
    expect(limit('50')).toBe(50);
    expect(limit('1')).toBe(1);
  });

  it('is arity 1, so commander cannot pass a radix as the second argument', () => {
    // This is the whole bug: commander calls a coercion as fn(value, previous), and
    // parseInt's second parameter is the radix, so `--limit 5 --limit 8` became
    // parseInt('8', 5) -> NaN. A one-parameter function cannot be corrupted that way.
    expect(limit.length).toBe(1);
    expect((limit as (a: string, b?: unknown) => number)('8', 5)).toBe(8);
  });

  it('refuses garbage instead of yielding NaN', () => {
    // NaN was the dangerous outcome: `NaN ?? 50` is NaN, and slice(0, NaN) is [], so the
    // command printed "No memories match." against a full store and exited 0.
    expect(() => limit('abc')).toThrow(/--limit/);
    expect(() => limit('')).toThrow();
  });

  it('refuses zero and negatives, which silently truncate a list', () => {
    expect(() => limit('0')).toThrow();
    expect(() => limit('-1')).toThrow();
  });

  it('names the flag and the offending value, so the message is actionable', () => {
    expect(() => limit('abc')).toThrow(/"abc"/);
  });

  it('throws commander-s InvalidArgumentError, so the CLI prints one line and not a stack', () => {
    // A bare Error thrown from a coercion escapes commander as an unhandled exception and
    // shows the user a stack trace through commander's own internals.
    expect(() => limit('abc')).toThrow(InvalidArgumentError);
  });

  it('takes the leading integer of a decimal rather than rejecting it', () => {
    // parseInt semantics are kept deliberately: '5.9' is a plausible typo for 5, not garbage.
    expect(limit('5.9')).toBe(5);
  });
});
