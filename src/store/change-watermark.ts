import type { Client } from '@libsql/client';
import { getClient } from './database.js';
import { acquireClient } from './connection-pool.js';
import type { CommitChange } from '../core/types.js';
import type { PeerRepo } from '../workspace/resolve.js';
import type { CommitRange } from './mcp-call-commits.js';

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
  /** Absent for the local repo; the peer's workspace name for a federated change. */
  repo?: string;
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
  until?: number,
  excludeRanges?: CommitRange[],
): Promise<ChangeSummary> {
  const byItem = await collapseCommitsSince(getClient(), seen, keys, until, excludeRanges);

  const items: ChangeSummaryItem[] = [];
  for (const [itemId, entry] of byItem) {
    if (!entry.title) continue;
    items.push({ itemId, category: entry.category, title: entry.title, action: entry.action });
  }
  return { count: byItem.size, items };
}

type CollapsedChange = { category: string; title?: string; action: CommitChange['action'] };

/**
 * Commits after `seen`, collapsed to one entry per item carrying the latest action.
 *
 * Later changes to the same item overwrite earlier ones, so the card shows where an
 * item ended up rather than one line per commit it passed through.
 */
async function collapseCommitsSince(
  client: Client,
  seen: number,
  keys?: ChangeAttributionKeys,
  until?: number,
  excludeRanges?: CommitRange[],
): Promise<Map<string, CollapsedChange>> {
  // `until` bounds the window at the top. A caller that knows when its own work began
  // uses it to exclude that work exactly, instead of guessing from titles.
  const rows = (await client.execute({
    sql: until === undefined
      ? 'SELECT rowid AS rowid, changes FROM knowledge_commits WHERE rowid > ? ORDER BY rowid ASC'
      : 'SELECT rowid AS rowid, changes FROM knowledge_commits WHERE rowid > ? AND rowid <= ? ORDER BY rowid ASC',
    args: until === undefined ? [seen] : [seen, until],
  })).rows;

  // Key matching is the fallback, used only for commits no recorded range accounts for.
  // Where a range applies it is strictly better: it covers a write's indirect effects,
  // which carry none of the caller's keys, and it cannot hide a foreign change that
  // merely shares a title.
  const ownIds = new Set(keys?.ids ?? []);
  const ownTitles = new Set(keys?.titles ?? []);
  const byItem = new Map<string, CollapsedChange>();

  for (const row of rows) {
    const rowid = Number(row.rowid);
    if (excludeRanges?.some(range => rowid > range.from && rowid <= range.to)) continue;
    for (const change of parseChanges(row.changes)) {
      if (!change?.itemId) continue;
      const title = changeTitle(change);
      if (ownIds.has(change.itemId)) continue;
      if (title && ownTitles.has(title)) continue;
      byItem.set(change.itemId, { category: changeCategory(change), title, action: change.action });
    }
  }
  return byItem;
}

/** The changes a recorded range contains, for confirming the range is the caller's own. */
export async function loadChangesInRange(range: CommitRange): Promise<Array<{ itemId: string; title?: string }>> {
  const rows = (await getClient().execute({
    sql: 'SELECT changes FROM knowledge_commits WHERE rowid > ? AND rowid <= ?',
    args: [range.from, range.to],
  })).rows;

  const changes: Array<{ itemId: string; title?: string }> = [];
  for (const row of rows) {
    for (const change of parseChanges(row.changes)) {
      if (change?.itemId) changes.push({ itemId: change.itemId, title: changeTitle(change) });
    }
  }
  return changes;
}

/** Peer commit heads by repo name. Unreadable or absent peers are simply omitted. */
export async function readPeerCommitHeads(peers: PeerRepo[]): Promise<Record<string, number>> {
  const heads: Record<string, number> = {};
  for (const peer of peers) {
    if (!peer.present) continue;
    try {
      const client = await acquireClient(peer.databasePath, { readOnly: true });
      const row = (await client.execute('SELECT MAX(rowid) AS head FROM knowledge_commits')).rows[0];
      const head = row?.head;
      heads[peer.name] = head === null || head === undefined ? 0 : Number(head);
    } catch {
      // A peer that is mid-write, schema-too-new or simply gone must not break the
      // local agent's own notification. Omitting it leaves its watermark untouched,
      // so the change is reported once the peer becomes readable again.
    }
  }
  return heads;
}

/**
 * Workspace-visible changes a peer committed after `seen`.
 *
 * No attribution filter: a caller can only ever write to its own repo (`assertOwnedItem`),
 * so nothing in a peer's commit log can be the caller's own write.
 *
 * The visibility check is the load-bearing part. A peer's commit log records changes to
 * its repo-private items too, and their titles must never reach another repo. Visibility
 * is read from the item row as it stands now, and an item whose row is gone -- a hard
 * delete -- is dropped rather than reported, because there is nothing left to prove it
 * was ever shared. Fail closed.
 */
export async function loadForeignPeerChanges(peer: PeerRepo, seen: number, until?: number): Promise<ChangeSummary> {
  const client = await acquireClient(peer.databasePath, { readOnly: true });
  const byItem = await collapseCommitsSince(client, seen, undefined, until);
  if (byItem.size === 0) return { count: 0, items: [] };

  const ids = [...byItem.keys()];
  const visible = new Set<string>();
  for (let index = 0; index < ids.length; index += VISIBILITY_CHUNK) {
    const chunk = ids.slice(index, index + VISIBILITY_CHUNK);
    const rows = await client.execute({
      sql: `SELECT id FROM knowledge_items
            WHERE id IN (${chunk.map(() => '?').join(', ')}) AND visibility = 'workspace'`,
      args: chunk,
    });
    for (const row of rows.rows) visible.add(String(row.id));
  }

  const items: ChangeSummaryItem[] = [];
  for (const [itemId, entry] of byItem) {
    if (!visible.has(itemId) || !entry.title) continue;
    items.push({ itemId, category: entry.category, title: entry.title, action: entry.action, repo: peer.name });
  }
  // Counts only what is reportable. The local count may exceed its item list because a
  // titleless change is still known to have happened; here an invisible change is not
  // the caller's business at all, so it must not even register as "something changed".
  return { count: items.length, items };
}

const VISIBILITY_CHUNK = 200;

/**
 * One card, not one per repo. Local changes lead because they are the ones the agent is
 * most likely to be sitting on; peer changes follow in workspace order.
 */
export function mergeChangeSummaries(summaries: ChangeSummary[]): ChangeSummary | undefined {
  const nonEmpty = summaries.filter(summary => summary.count > 0);
  if (nonEmpty.length === 0) return undefined;
  return {
    count: nonEmpty.reduce((total, summary) => total + summary.count, 0),
    items: nonEmpty.flatMap(summary => summary.items),
  };
}
