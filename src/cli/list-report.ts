import pc from 'picocolors';
import type { KnowledgeItem } from '../core/types.js';

export type ListLens = 'all' | 'unread' | 'stale';

export type ListOptions = {
  lens?: ListLens;
  category?: string;
  limit?: number;
};

export type ListRow = {
  id: string;
  title: string;
  category: string;
  freshness: string;
  ageDays: number | null;
  reads: number;
};

/**
 * `knowl query` searches; nothing browsed. This is the browse.
 *
 * `reads` is keyed only by atoms retrieved at least once -- `getAccessSummary` builds it from
 * `knowledge_access`, so an atom nobody has read has no row and therefore no key. **That absence
 * is the unread lens**; do not expect a stored zero, and do not reach for
 * `getKnowledgeAccessReport`, which INNER JOINs that table and so drops exactly the rows this
 * lens exists to find.
 *
 * `now` is a parameter rather than a `Date.now()` call so the age column is assertable.
 */
export function selectListRows(
  items: KnowledgeItem[],
  reads: Map<string, number>,
  options: ListOptions,
  now: number = Date.now(),
): { rows: ListRow[]; matched: number } {
  const lens = options.lens ?? 'all';

  const matching = items.filter(item => {
    if (item.status !== 'active') return false;
    if (options.category && item.category !== options.category) return false;
    if (lens === 'unread') return (reads.get(item.id) ?? 0) === 0;
    if (lens === 'stale') return item.freshness !== 'fresh';
    return true;
  });

  // Unread sorts oldest-first: the longest-ignored atom is the likeliest to be dead weight, and
  // is the one somebody reading down a list would otherwise never reach.
  const ascending = lens === 'unread';
  matching.sort((a, b) => {
    const left = String(a.updatedAt ?? '');
    const right = String(b.updatedAt ?? '');
    return ascending ? left.localeCompare(right) : right.localeCompare(left);
  });

  // After the sort, never before: `--unread --limit 5` must be the five oldest, not five of them.
  const limited = options.limit === undefined ? matching : matching.slice(0, options.limit);

  // `matched` counts what passed the FILTERS, before the limit. The footer exists to stop a
  // limited view reading as the whole store; reporting the store's total instead would make a
  // filtered view read as a limited one — "Showing 12 of 200" for a category that holds 12.
  return {
    matched: matching.length,
    rows: limited.map(item => {
      const at = item.updatedAt ? new Date(item.updatedAt).getTime() : Number.NaN;
      return {
        id: item.id,
        title: item.title,
        category: item.category,
        freshness: item.freshness,
        // Number.isFinite, not a truthiness check: an unparseable timestamp yields NaN, and
        // NaN flows through the arithmetic to render as "NaNd" in the age column.
        ageDays: Number.isFinite(at) ? Math.floor((now - at) / 86_400_000) : null,
        reads: reads.get(item.id) ?? 0,
      };
    }),
  };
}

function pad(value: string, width: number): string {
  // Truncation keeps one space, so a value that exactly fills its column cannot butt against
  // the next one and read as a single word. Colour is applied outside pad at every call site,
  // so this never slices an ANSI escape in half.
  return value.length >= width ? value.slice(0, width - 1) + ' ' : value + ' '.repeat(width - value.length);
}

export function formatListRows(rows: ListRow[], matched: number): string {
  if (rows.length === 0) return 'No memories match.';

  const lines = [
    pc.dim(`${pad('ID', 10)}${pad('CATEGORY', 14)}${pad('AGE', 7)}${pad('READS', 7)}TITLE`),
  ];

  for (const row of rows) {
    // Zero is the whole point of the unread lens, so it is the one number worth colouring.
    const reads = row.reads === 0 ? pc.yellow(pad('0', 7)) : pad(String(row.reads), 7);
    lines.push(
      pc.dim(pad(row.id.slice(0, 8), 10)) +
      pad(row.category, 14) +
      pad(row.ageDays === null ? '—' : `${row.ageDays}d`, 7) +
      reads +
      row.title,
    );
  }

  // Always say what was withheld. A limited view that reads as the whole store is how somebody
  // concludes their memory is nearly empty. Silent when nothing was withheld, because
  // "Showing 4 of 4" is noise.
  if (matched > rows.length) {
    lines.push('');
    lines.push(pc.dim(`Showing ${rows.length} of ${matched} matching. Raise --limit to see the rest.`));
  }
  return lines.join('\n');
}
