import { describe, it, expect } from 'vitest';
import { knowledgeMentionsChangedPath } from '../../src/store/freshness.js';
import { citesCode } from '../../src/store/unrestated.js';

// Regression pin: a path-less atom (a personal fact, a definition) is never matched by a changed
// file. Drift candidates also need symbol evidence or untracked paths (src/store/drift.ts:366-369),
// both of which come only from cited paths or symbol:// locators, so these predicates cover the
// property.
describe('path-less atoms', () => {
  const changed = ['src/a.ts', 'README.md', 'personal'];
  const pathless = [
    { affectedPaths: [], source: null, tags: ['personal'] },
    { affectedPaths: null, source: 'told by the user', tags: null },
  ];

  it.each(pathless)('is never matched by a changed path: %j', (atom) => {
    expect(knowledgeMentionsChangedPath(atom, changed)).toBe(false);
    expect(citesCode(atom)).toBe(false);
  });

  it('control: an atom citing a path is matched', () => {
    const control = { affectedPaths: ['src/a.ts'], source: null };
    expect(knowledgeMentionsChangedPath(control, ['src/a.ts'])).toBe(true);
    expect(citesCode(control)).toBe(true);
  });
});
