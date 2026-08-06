import { describe, expect, it } from 'vitest';
import { resolveSynchronous, synchronousPragma } from '../../src/core/sqlite-sync.js';

/**
 * The escape hatch on a durability policy, so the policy stays a choice.
 *
 * `synchronous = NORMAL` is the right default for memory that is re-derivable from the
 * transcripts beside it, and it is 4.19x on the un-batched writes that are this project's
 * common shape. It is still a policy, and one applied to every database with no way out is
 * not a decision the user gets to make.
 */
describe('KNOWL_SQLITE_SYNCHRONOUS', () => {
  it('defaults to NORMAL when unset or empty', () => {
    expect(resolveSynchronous({})).toBe('NORMAL');
    expect(resolveSynchronous({ KNOWL_SQLITE_SYNCHRONOUS: '' })).toBe('NORMAL');
    expect(resolveSynchronous({ KNOWL_SQLITE_SYNCHRONOUS: '   ' })).toBe('NORMAL');
  });

  it('accepts either value in any case, with surrounding whitespace', () => {
    // A trailing space out of a shell profile is a typo that should work, not one that should
    // stop every command.
    expect(resolveSynchronous({ KNOWL_SQLITE_SYNCHRONOUS: 'FULL' })).toBe('FULL');
    expect(resolveSynchronous({ KNOWL_SQLITE_SYNCHRONOUS: 'full ' })).toBe('FULL');
    expect(resolveSynchronous({ KNOWL_SQLITE_SYNCHRONOUS: ' Normal' })).toBe('NORMAL');
  });

  it('refuses OFF by name, rather than lumping it in with a typo', () => {
    // OFF can corrupt the file on power loss and measured no faster than NORMAL (0.867 vs
    // 0.832 ms/row), so it is a real risk for no gain. Somebody reaching for it deserves to
    // be told that, not told it was unparseable.
    expect(() => resolveSynchronous({ KNOWL_SQLITE_SYNCHRONOUS: 'OFF' })).toThrow(/OFF is refused/);
    expect(() => resolveSynchronous({ KNOWL_SQLITE_SYNCHRONOUS: 'off' })).toThrow(/corrupt/);
  });

  it('throws on an unrecognised value rather than falling back', () => {
    // Falling back would hand NORMAL to somebody who asked for FULL, which is precisely the
    // failure this variable exists to prevent.
    expect(() => resolveSynchronous({ KNOWL_SQLITE_SYNCHRONOUS: 'fast' }))
      .toThrow(/must be NORMAL or FULL/);
  });

  it('renders a pragma statement', () => {
    expect(synchronousPragma({})).toBe('PRAGMA synchronous = NORMAL;');
    expect(synchronousPragma({ KNOWL_SQLITE_SYNCHRONOUS: 'FULL' })).toBe('PRAGMA synchronous = FULL;');
  });
});
