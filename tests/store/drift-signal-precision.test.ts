import { describe, expect, it } from 'vitest';
import { knowledgeMentionsChangedPath } from '../../src/store/freshness.js';
import { classifyDriftPaths, isChurnPath } from '../../src/store/drift.js';

/**
 * What the matcher is allowed to call drift.
 *
 * Measured on this repo's own store before these were written: 339 of 867 active items carried an
 * unread drift observation, and only 42 of those had a cited path that had actually gone away. The
 * cases below pin the two matching rules that were wrong, and the one that was right and must
 * survive being made precise.
 */
describe('knowledgeMentionsChangedPath', () => {
  it('matches a path the item actually cites', () => {
    expect(knowledgeMentionsChangedPath(
      { affectedPaths: ['src/store/gc.ts'] },
      ['src/store/gc.ts'],
    )).toBe(true);
  });

  it('matches a directory the item cites', () => {
    // Citing a directory is citing everything under it, which is why `pathMatches` compares
    // prefixes rather than equality.
    expect(knowledgeMentionsChangedPath(
      { affectedPaths: ['src/store'] },
      ['src/store/gc.ts'],
    )).toBe(true);
  });

  it('still matches a path carried in `source`, which is where most items put them', () => {
    // 58 of the 71 items flagged with no `affectedPaths` were flagged legitimately through this:
    // `source` is in practice a semicolon-separated path list. Making the match precise must not
    // cost those.
    expect(knowledgeMentionsChangedPath(
      { source: 'src/store/database.ts; src/store/bootstrap.ts; package.json' },
      ['src/store/bootstrap.ts'],
    )).toBe(true);
  });

  it('does not match a path that is merely a substring of a longer path in `source`', () => {
    // `source.includes(changedPath)` is a raw substring test, so a different file whose path ends
    // with the changed one counted as drift. `vendor/src/index.ts` is not `src/index.ts`.
    expect(knowledgeMentionsChangedPath(
      { source: 'vendor/src/index.ts' },
      ['src/index.ts'],
    )).toBe(false);
  });

  it('does not match prose in `source` that happens to contain a path-like word', () => {
    expect(knowledgeMentionsChangedPath(
      { source: 'verified by hand in this workspace' },
      ['workspace'],
    )).toBe(false);
  });

  it('does not treat a tag as a path, even when the tag names a directory', () => {
    // A tag is a topic label. It could only ever fire when the tag was literally a top-level
    // directory -- 8 items in the measured store -- and it is indefensible in principle.
    expect(knowledgeMentionsChangedPath(
      { tags: ['tests'] },
      ['tests/store/gc.test.ts'],
    )).toBe(false);
  });

  it('says no when the item cites nothing at all', () => {
    expect(knowledgeMentionsChangedPath({}, ['src/store/gc.ts'])).toBe(false);
  });
});

/**
 * Telling "the file is gone" apart from "the file was edited".
 *
 * These were one event sharing one column. Measured, only 42 of 339 observations had a cited path
 * that had actually gone away -- so collapsing them is most of why the signal could not be acted
 * on. Existence is injected so the rule can be tested without a tree on disk.
 */
describe('classifyDriftPaths', () => {
  const exists = (present: string[]) => (candidate: string) => present.includes(candidate);

  it('calls a path that no longer exists removed', () => {
    expect(classifyDriftPaths(['src/gone.ts'], exists([])))
      .toEqual({ removed: ['src/gone.ts'], changed: [], moved: [] });
  });

  it('calls a path that still exists merely changed', () => {
    expect(classifyDriftPaths(['src/here.ts'], exists(['src/here.ts'])))
      .toEqual({ removed: [], changed: ['src/here.ts'], moved: [] });
  });

  it('calls a path git renamed moved, not removed', () => {
    // Audited on the real store after the first cut shipped: 30 of 44 survivors were this --
    // a refactor moved `src/store/host-lifecycle.ts` to `src/session/`, and every atom citing it
    // was flagged as though the runtime had been deleted. The atoms are still true; only their
    // paths are stale, which is a different and much weaker finding.
    expect(classifyDriftPaths(['src/store/host-lifecycle.ts'], exists([]),
      new Set(['src/store/host-lifecycle.ts'])))
      .toEqual({ removed: [], changed: [], moved: ['src/store/host-lifecycle.ts'] });
  });

  it('still calls a path removed when it is gone and was never renamed', () => {
    expect(classifyDriftPaths(['src/gone.ts'], exists([]), new Set(['src/other.ts'])))
      .toEqual({ removed: ['src/gone.ts'], changed: [], moved: [] });
  });

  it('separates the two rather than letting one hide the other', () => {
    // The case that matters: an item citing both. It is a removal candidate on the strength of the
    // first path, and reporting only "something changed" would lose that.
    expect(classifyDriftPaths(['src/gone.ts', 'src/here.ts'], exists(['src/here.ts'])))
      .toEqual({ removed: ['src/gone.ts'], changed: ['src/here.ts'], moved: [] });
  });
});

/**
 * Paths whose changing says nothing about whether an atom is still true.
 *
 * Among flagged items these were the most-cited paths in the store -- `package.json` 28 times,
 * `README.md` 23, `CHANGELOG.md` 14 -- because they change on essentially every release.
 */
describe('isChurnPath', () => {
  it.each([
    'package.json',
    'package-lock.json',
    'CHANGELOG.md',
    'README.md',
    '.github/workflows/ci.yml',
    'dist/index.js',
    'go.sum',
    'services/api/poetry.lock',
    'uv.lock',
  ])('treats %s as churn', (candidate) => {
    expect(isChurnPath(candidate)).toBe(true);
  });

  it.each([
    'src/store/gc.ts',
    'src/cli/program.ts',
    'tests/store/gc.test.ts',
    'docs/reference.md',
    'go.mod',
    'pyproject.toml',
  ])('does not treat %s as churn', (candidate) => {
    expect(isChurnPath(candidate)).toBe(false);
  });
});
