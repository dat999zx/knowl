import { describe, expect, it } from 'vitest';
import { formatLocator, parseLocator } from '../../src/transcripts/locator.js';

describe('locator', () => {
  it('omits the repo for a local hit', () => {
    expect(formatLocator({ sessionId: 'abc', line: 42 })).toBe('transcript://abc#L42');
  });

  it('includes the repo for a federated hit', () => {
    expect(formatLocator({ repo: 'knowl-cloud', sessionId: 'abc', line: 42 }))
      .toBe('transcript://knowl-cloud/abc#L42');
  });

  it('round-trips both shapes', () => {
    for (const hit of [{ sessionId: 'abc', line: 7 }, { repo: 'peer', sessionId: 'abc', line: 7 }]) {
      const parsed = parseLocator(formatLocator(hit));
      expect(parsed?.sessionId).toBe('abc');
      expect(parsed?.line).toBe(7);
      expect(parsed?.repo).toBe((hit as { repo?: string }).repo ?? null);
    }
  });

  it('survives a repo name containing a slash', () => {
    const parsed = parseLocator(formatLocator({ repo: 'group/repo', sessionId: 'abc', line: 1 }));
    expect(parsed?.repo).toBe('group/repo');
  });

  it('returns null for anything malformed', () => {
    for (const bad of ['', 'not-a-locator', 'transcript://abc', 'transcript://abc#L0', 'transcript://abc#Lx']) {
      expect(parseLocator(bad)).toBeNull();
    }
  });

  it('returns null rather than throwing on a bad percent-escape', () => {
    // decodeURIComponent('%') throws URIError. The contract here is null-not-throw.
    for (const bad of ['transcript://%/abc#L1', 'transcript://%zz/abc#L1', 'transcript://a%/abc#L1']) {
      expect(() => parseLocator(bad)).not.toThrow();
      expect(parseLocator(bad)).toBeNull();
    }
  });

  it('rejects a line number too large to be an exact integer', () => {
    expect(parseLocator('transcript://abc#L99999999999999999999')).toBeNull();
  });
});
