import { getClient } from './database.js';
import type { CommitChange } from '../core/types.js';

/**
 * Highest `knowledge_commits` rowid, or 0 when the table is empty.
 *
 * rowid is used as the watermark because it is dense, monotonic, and already
 * present. It is NOT stable across snapshot restore, which reassigns rowids via
 * `INSERT ... SELECT *`; callers must clamp a stored watermark that exceeds head.
 */
export async function readCommitHead(): Promise<number> {
  const row = (await getClient().execute('SELECT MAX(rowid) AS head FROM knowledge_commits')).rows[0];
  const head = row?.head;
  return head === null || head === undefined ? 0 : Number(head);
}

export type ChangeSummaryItem = {
  itemId: string;
  category: string;
  title: string;
  action: CommitChange['action'];
};

export type ChangeSummary = {
  /** Distinct changed items, including any whose title could not be resolved. */
  count: number;
  /** Only the items with a resolvable title, in commit order. */
  items: ChangeSummaryItem[];
};

export type ChangeAttributionKeys = { ids: string[]; titles: string[] };

const parseChanges = (value: unknown): CommitChange[] => {
  const parsed = typeof value === 'string' ? JSON.parse(value) : value;
  return Array.isArray(parsed) ? parsed as CommitChange[] : [];
};

const changeTitle = (change: CommitChange): string | undefined => {
  const title = change.after?.title ?? change.before?.title;
  return typeof title === 'string' && title.length > 0 ? title : undefined;
};

const changeCategory = (change: CommitChange): string =>
  String(change.after?.category ?? change.before?.category ?? 'item');

/**
 * Changes committed after `seen` that are not attributable to the caller.
 *
 * Attribution is by content rather than by a stored author, because writes arrive
 * through the MCP process, which has no caller identity to record. A change is the
 * caller's own when its item id or title appears in the caller's own tool_input.
 */
export async function loadForeignChanges(
  seen: number,
  keys?: ChangeAttributionKeys,
): Promise<ChangeSummary> {
  const rows = (await getClient().execute({
    sql: 'SELECT changes FROM knowledge_commits WHERE rowid > ? ORDER BY rowid ASC',
    args: [seen],
  })).rows;

  const ownIds = new Set(keys?.ids ?? []);
  const ownTitles = new Set(keys?.titles ?? []);
  // Later changes to the same item overwrite earlier ones, so the card shows the
  // latest action rather than one line per commit.
  const byItem = new Map<string, { category: string; title?: string; action: CommitChange['action'] }>();

  for (const row of rows) {
    for (const change of parseChanges(row.changes)) {
      if (!change?.itemId) continue;
      const title = changeTitle(change);
      if (ownIds.has(change.itemId)) continue;
      if (title && ownTitles.has(title)) continue;
      byItem.set(change.itemId, { category: changeCategory(change), title, action: change.action });
    }
  }

  const items: ChangeSummaryItem[] = [];
  for (const [itemId, entry] of byItem) {
    if (!entry.title) continue;
    items.push({ itemId, category: entry.category, title: entry.title, action: entry.action });
  }
  return { count: byItem.size, items };
}
