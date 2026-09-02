import { describe, expect, it } from 'vitest';
import { pathsChangedNote } from '../../src/core/format.js';

/**
 * The staleness marker's wording, tested at the function rather than through a query, because
 * the properties that matter here are about the sentence and a query cannot cheaply produce an
 * atom citing thirty files.
 *
 * The behaviour under test is that the marker leads with an instruction naming a target. A
 * marker that only describes a condition is the shape measurement says a reader skips: served a
 * claim whose source had moved, with the link present and reachable, agents opened it in about
 * one turn in five and acted on the stale value in three quarters of the rest.
 */
describe('pathsChangedNote', () => {
  it('opens with the verb and the names, and keeps the count behind them', () => {
    const note = pathsChangedNote(2, 6, ['src/auth.ts', 'src/session.ts']);

    expect(note).toBe('Open src/auth.ts, src/session.ts, then verify this still holds: 2 of 6 affectedPaths modified since this was stored.');
    expect(note.indexOf('Open')).toBeLessThan(note.indexOf('2 of 6'));
  });

  it('names three and counts the rest, so a heavily-cited atom stays one line', () => {
    const note = pathsChangedNote(7, 9, [
      'src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts', 'src/e.ts', 'src/f.ts', 'src/g.ts',
    ]);

    expect(note).toContain('Open src/a.ts, src/b.ts, src/c.ts and 4 more,');
    expect(note).toContain('7 of 9');
    // The names it dropped are not silently gone -- "and 4 more" says there are others, which
    // is what stops a reader treating the three as the whole story.
    expect(note).not.toContain('src/d.ts');
  });

  it('falls back to the bare condition rather than telling anyone to open nothing', () => {
    // Reachable only if a caller counts a change it cannot name. An instruction with no target
    // is worse than the description it replaced, so the old sentence is what survives here.
    const note = pathsChangedNote(1, 1, []);

    expect(note).toBe('1 of 1 affectedPaths modified since this was stored -- verify against the files before trusting.');
    expect(note).not.toContain('Open');
  });

  it('preserves the caller\'s order, which is the atom\'s own citation order', () => {
    const note = pathsChangedNote(3, 3, ['src/zeta.ts', 'src/alpha.ts', 'src/mid.ts']);

    expect(note).toContain('Open src/zeta.ts, src/alpha.ts, src/mid.ts,');
  });
});
