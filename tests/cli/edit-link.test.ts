import { describe, expect, it } from 'vitest';
import { atomEditUrl, resolveAtomId } from '../../src/cli/edit-link.js';

const IDS = ['a27d959082a140c9', '7878d8f86e5f40b5', '7878aaaaaaaaaaaa'];

describe('resolve atom id', () => {
  it('accepts the eight characters knowl list actually prints', () => {
    expect(resolveAtomId(IDS, 'a27d9590')).toEqual({ kind: 'one', id: 'a27d959082a140c9' });
  });

  it('accepts a full id', () => {
    expect(resolveAtomId(IDS, '7878d8f86e5f40b5')).toEqual({ kind: 'one', id: '7878d8f86e5f40b5' });
  });

  it('reports every candidate when a prefix is ambiguous rather than guessing', () => {
    const match = resolveAtomId(IDS, '7878');
    expect(match.kind).toBe('many');
    expect(match.kind === 'many' && match.ids.sort()).toEqual(['7878aaaaaaaaaaaa', '7878d8f86e5f40b5']);
  });

  it('reports none for a prefix that matches nothing', () => {
    expect(resolveAtomId(IDS, 'zzzz')).toEqual({ kind: 'none' });
  });

  it('prefers an exact match over the longer ids it also prefixes', () => {
    expect(resolveAtomId(['abc', 'abcdef'], 'abc')).toEqual({ kind: 'one', id: 'abc' });
  });
});

const VIEWER = { url: 'http://127.0.0.1:52413', token: 'tok-en_123' };

describe('atom edit url', () => {
  it('carries the token so a pasted link authenticates', () => {
    expect(atomEditUrl(VIEWER, 'abc123')).toBe('http://127.0.0.1:52413/?token=tok-en_123#/atom/abc123');
  });

  it('escapes an id that would otherwise break the fragment', () => {
    expect(atomEditUrl(VIEWER, 'a/b?c#d')).toContain('#/atom/a%2Fb%3Fc%23d');
  });

  it('escapes a token containing url-significant characters', () => {
    // base64url avoids these, but the token generator is not this function's business.
    expect(atomEditUrl({ url: 'http://127.0.0.1:1', token: 'a+b/c=' }, 'x'))
      .toContain('token=a%2Bb%2Fc%3D');
  });

  it('does not double up a slash when the origin carries a trailing one', () => {
    expect(atomEditUrl({ url: 'http://127.0.0.1:1/', token: 't' }, 'x'))
      .toBe('http://127.0.0.1:1/?token=t#/atom/x');
  });

  it('keeps the id out of the part of the url a server would see', () => {
    const url = new URL(atomEditUrl(VIEWER, 'secret-atom-id'));
    expect(url.search).not.toContain('secret-atom-id');
    expect(url.pathname).not.toContain('secret-atom-id');
    expect(url.hash).toContain('secret-atom-id');
  });
});
