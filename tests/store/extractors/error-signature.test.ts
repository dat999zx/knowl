import { describe, expect, it } from 'vitest';
import { errorSignature } from '../../../src/store/extractors/error-signature.js';

describe('errorSignature', () => {
  it('matches the same failure across runs with different paths and line numbers', () => {
    const first = 'AssertionError: expected 1 to be 2\n  at D:/coding/knowl/tests/a.test.ts:12:34';
    const second = 'AssertionError: expected 1 to be 2\n  at C:/other/tests/a.test.ts:98:7';

    expect(errorSignature(first)).toBe(errorSignature(second));
  });

  it('separates genuinely different failures', () => {
    expect(errorSignature('TypeError: x is not a function'))
      .not.toBe(errorSignature('RangeError: index out of range'));
  });

  it('strips hex addresses so two crashes at different addresses match', () => {
    expect(errorSignature('Segfault at 0x00007ff8ab12cd34'))
      .toBe(errorSignature('Segfault at 0x00001aa2bc98ef01'));
  });

  it('strips durations, which vary run to run', () => {
    expect(errorSignature('FAIL suite (1 test) 802ms')).toBe(errorSignature('FAIL suite (1 test) 15620ms'));
  });

  it('ignores case and collapses whitespace', () => {
    expect(errorSignature('Error:   Broken\n\n  thing')).toBe(errorSignature('error: broken thing'));
  });

  it('returns an empty signature for an empty message rather than throwing', () => {
    expect(errorSignature('   ')).toBe('');
  });

  it('keeps only the leading portion, so a long tail cannot make two identical failures differ', () => {
    // The base must normalise to more than SIGNATURE_CHARS on its own, or both tails
    // survive truncation and the two signatures would differ, and the test would fail. Do not "simplify" the base string.
    const base = 'AssertionError: expected the workspace manifest to record the repo role and the default visibility for every linked repository in the workspace before any promotion runs';

    expect(errorSignature(`${base}\n${'noise line\n'.repeat(50)}`))
      .toBe(errorSignature(`${base}\ndifferent noise entirely`));
  });

  it('separates two assertion failures that differ only in their values', () => {
    // The blanket number strip used to collapse these, which made task 3 treat an
    // unrelated later failure as a recurrence of an earlier one.
    expect(errorSignature('AssertionError: expected 1 to be 2'))
      .not.toBe(errorSignature('AssertionError: expected 99 to be 42'));
  });

  it('strips POSIX absolute paths, not only Windows ones', () => {
    const first = 'Error: ENOENT\n  at /home/alice/project/src/a.ts';
    const second = 'Error: ENOENT\n  at /var/lib/other/src/a.ts';

    expect(errorSignature(first)).toBe(errorSignature(second));
  });
});
