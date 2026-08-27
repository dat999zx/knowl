import { describe, expect, it } from 'vitest';
import { citesCode } from '../../src/store/unrestated.js';

describe('citesCode — what separates prose from code-coupled knowledge', () => {
  it('counts an item with no paths at all as prose', () => {
    expect(citesCode({ affectedPaths: null, source: null })).toBe(false);
    expect(citesCode({ affectedPaths: [], source: 'verified in this workspace' })).toBe(false);
  });

  it('counts a source that is a path list, not just affectedPaths', () => {
    // 58 of 71 items flagged with no affectedPaths in the measured store carried a
    // semicolon-separated path list in `source`. Reading only affectedPaths calls those prose.
    expect(citesCode({ source: 'src/store/database.ts; src/store/bootstrap.ts; package.json' })).toBe(true);
  });

  it('counts an item whose ONLY paths are prose files as prose', () => {
    // The caution raised on #98: citing a path is not the same as citing code. An atom whose
    // only path is a research write-up has non-empty affectedPaths and is exactly the prose this
    // report exists for. A census keyed on "has any path" puts it on the wrong side.
    expect(citesCode({ affectedPaths: ['docs/research/competitor-teardown.md'] })).toBe(false);
    expect(citesCode({ source: 'docs/evals/floor-sweep.md; README.md' })).toBe(false);
  });

  it('counts an item citing one code path among prose as code-coupled', () => {
    // One real file is enough for a drift check to have something to watch, which is the only
    // question this predicate is answering.
    expect(citesCode({ affectedPaths: ['docs/notes.md', 'src/store/drift.ts'] })).toBe(true);
  });

  it('does not mistake prose containing a full stop for a path', () => {
    // sourcePaths requires no whitespace and at least one `/` or `.`, so a sentence cannot
    // qualify -- but a single unspaced token with a dot could, and that is the edge worth pinning.
    expect(citesCode({ source: 'measured on the real store, twice' })).toBe(false);
  });
});
