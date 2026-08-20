import { describe, expect, it } from 'vitest';
import { selectListRows, formatListRows } from '../../src/cli/list-report.js';

const NOW = Date.parse('2026-08-19T00:00:00.000Z');

function atom(over: Record<string, unknown> = {}): any {
  return {
    id: 'a'.repeat(16), category: 'fact', status: 'active', title: 'An atom',
    content: 'Body.', freshness: 'fresh', updatedAt: '2026-08-18T00:00:00.000Z', ...over,
  };
}

const ESC = String.fromCharCode(27);
const ANSI = new RegExp(ESC + '[[]' + '[0-9;]*m', 'g');
/** Output lines with colour removed, so column positions can be asserted. */
function plainLines(text: string): string[] {
  return text.replace(ANSI, '').split(String.fromCharCode(10));
}

describe('list report', () => {
  it('shows only active atoms', () => {
    const rows = selectListRows(
      [atom({ id: 'keep' }), atom({ id: 'gone', status: 'superseded' }), atom({ id: 'filed', status: 'archived' })],
      new Map(), {}, NOW,
    ).rows;
    expect(rows.map(row => row.id)).toEqual(['keep']);
  });

  it('unread means absent from the read map, not a zero in it', () => {
    const rows = selectListRows(
      [atom({ id: 'never' }), atom({ id: 'read' })],
      new Map([['read', 3]]), { lens: 'unread' }, NOW,
    ).rows;
    expect(rows.map(row => row.id)).toEqual(['never']);
    expect(rows[0].reads).toBe(0);
  });

  it('sorts unread oldest first and everything else newest first', () => {
    const old = atom({ id: 'old', updatedAt: '2026-01-01T00:00:00.000Z' });
    const recent = atom({ id: 'recent', updatedAt: '2026-08-18T00:00:00.000Z' });
    expect(selectListRows([recent, old], new Map(), { lens: 'unread' }, NOW).rows.map(r => r.id))
      .toEqual(['old', 'recent']);
    expect(selectListRows([old, recent], new Map(), {}, NOW).rows.map(r => r.id))
      .toEqual(['recent', 'old']);
  });

  it('stale means any freshness that is not fresh', () => {
    const rows = selectListRows(
      [
        atom({ id: 'f', freshness: 'fresh' }),
        atom({ id: 's', freshness: 'stale' }),
        atom({ id: 'n', freshness: 'needs_review' }),
      ],
      new Map(), { lens: 'stale' }, NOW,
    ).rows;
    expect(rows.map(row => row.id).sort()).toEqual(['n', 's']);
  });

  it('filters by category and honours the limit', () => {
    const items = [
      atom({ id: '1', category: 'fact' }),
      atom({ id: '2', category: 'decision' }),
      atom({ id: '3', category: 'fact' }),
    ];
    expect(selectListRows(items, new Map(), { category: 'fact' }, NOW).rows).toHaveLength(2);
    expect(selectListRows(items, new Map(), { limit: 1 }, NOW).rows).toHaveLength(1);
  });

  it('applies the limit after sorting, so --unread --limit shows the oldest and not any five', () => {
    const items = [
      atom({ id: 'newest', updatedAt: '2026-08-18T00:00:00.000Z' }),
      atom({ id: 'oldest', updatedAt: '2026-01-01T00:00:00.000Z' }),
    ];
    expect(selectListRows(items, new Map(), { lens: 'unread', limit: 1 }, NOW).rows.map(r => r.id))
      .toEqual(['oldest']);
  });

  it('computes age in whole days from the given clock', () => {
    const rows = selectListRows([atom({ updatedAt: '2026-08-09T00:00:00.000Z' })], new Map(), {}, NOW).rows;
    expect(rows[0].ageDays).toBe(10);
  });

  it('reports a missing updatedAt as no age rather than as an enormous one', () => {
    const rows = selectListRows([atom({ updatedAt: null })], new Map(), {}, NOW).rows;
    expect(rows[0].ageDays).toBeNull();
  });

  it('rounds age DOWN, so an atom eleven hours old is not reported as a day', () => {
    // A mutation from floor to ceil survived the original fixture, because it sat on an exact
    // day boundary where floor, ceil and round agree.
    const rows = selectListRows(
      [atom({ id: 'partial', updatedAt: '2026-08-16T13:00:00.000Z' })], new Map(), {}, NOW,
    ).rows;
    expect(rows[0].ageDays).toBe(2);
  });

  it('reports an unparseable updatedAt as no age rather than NaNd', () => {
    const rows = selectListRows([atom({ updatedAt: 'not a date' })], new Map(), {}, NOW).rows;
    expect(rows[0].ageDays).toBeNull();
  });

  it('pads every column to a fixed width so the table lines up', () => {
    // Removing pad() entirely survived the original assertions, which only checked that a few
    // substrings appeared somewhere in the output.
    const rows = selectListRows([
      atom({ id: 'aaaaaaaabbbbbbbb', category: 'fact', title: 'Short' }),
      atom({ id: 'ccccccccdddddddd', category: 'architecture', title: 'Long' }),
    ], new Map(), {}, NOW).rows;
    const body = plainLines(formatListRows(rows, 2)).slice(1).filter(Boolean);
    expect(body).toHaveLength(2);
    // Both titles begin at the same column, whatever the category's length.
    expect(body[0].indexOf('Short')).toBe(body[1].indexOf('Long'));
  });

  it('keeps a separating space when a value fills its whole column', () => {
    const rows = selectListRows([atom({ category: 'architecture', title: 'T' })], new Map(), {}, NOW).rows;
    // 'architecture' is 12 in a 14-wide column, so overflow it to reach the truncation branch.
    const wide = plainLines(formatListRows([{ ...rows[0], category: 'architecturezzzzzz' }], 1))[1];
    // 14-wide column: 13 characters kept, then the separating space.
    expect(wide).toContain('architecturez ');
    expect(wide.indexOf('architecturezzzzzzT')).toBe(-1);
  });

  it('says nothing about totals when nothing was withheld', () => {
    const rows = selectListRows([atom()], new Map(), {}, NOW).rows;
    expect(formatListRows(rows, 1)).not.toContain('Showing');
  });

  it('counts what matched the filters, not the whole store', () => {
    const items = [
      atom({ id: '1', category: 'fact' }), atom({ id: '2', category: 'fact' }),
      atom({ id: '3', category: 'decision' }), atom({ id: '4', category: 'decision' }),
    ];
    const { rows, matched } = selectListRows(items, new Map(), { category: 'fact', limit: 1 }, NOW);
    expect(rows).toHaveLength(1);
    // Two facts matched, not four atoms: a filtered view must not read as a limited one.
    expect(matched).toBe(2);
    expect(formatListRows(rows, matched)).toContain('1 of 2');
  });

  it('renders a row per atom and says what was withheld', () => {
    const rows = selectListRows([atom({ id: 'abcdef1234567890', title: 'Readable title' })], new Map(), {}, NOW).rows;
    const output = formatListRows(rows, 40);
    expect(output).toContain('abcdef12');
    expect(output).toContain('Readable title');
    // A limited view must never read as the whole store.
    expect(output).toContain('1 of 40');
  });

  it('says so plainly when nothing matches', () => {
    expect(formatListRows([], 0)).toContain('No memories');
  });
});
