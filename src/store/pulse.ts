import type { Client } from '@libsql/client';
import { getClient } from './database.js';
import type { CommitChange } from '../core/types.js';

/**
 * What the store did since a caller last looked, for the viewer's live graph.
 *
 * **Nothing here instruments the write path.** Both tables this reads are written today by
 * code that already exists -- `knowledge_commits` on every write, `knowledge_access` on every
 * retrieval -- so an agent pays exactly nothing for this feature, and when no viewer is
 * running no part of it executes at all. That is the whole reason it is a poll from the
 * reader rather than a push from the writer: a push would cost every write a discovery and a
 * socket timeout to serve the small fraction of the time somebody is watching.
 *
 * It also means the viewer watches the DATABASE, not the agent. Claude Code, Codex, Cursor or
 * a second terminal running `knowl query` all light the graph identically, and none of them
 * needs to know the viewer exists.
 */

export type PulseChange = { itemId: string; action: CommitChange['action'] };
export type PulseRetrieval = { surface: string; hits: Array<{ itemId: string; rank: number }> };

export type Pulse = {
  /** Watermarks to hand back on the next call. rowid, for the reasons `readCommitHead` gives. */
  commits: number;
  access: number;
  /** One entry per item, carrying the latest action, in commit order. */
  changes: PulseChange[];
  retrievals: PulseRetrieval[];
  /**
   * The store moved but the motion was dropped. The caller should reconcile its copy of the
   * graph and animate nothing -- what is skipped is the animation, never the state.
   */
  resync: boolean;
};

/**
 * Past this many rows in one tick, take the watermark and skip the motion.
 *
 * Browsers throttle a background tab's timers to roughly one tick a second, so a tab left
 * behind during a long agent session comes back to a delta of hundreds. Played at once that
 * is not a montage of the work, it is one frame containing every event, which reads as a
 * fault. The same clamp covers a viewer opened next to a bulk import.
 */
const BURST = 40;

/**
 * `null` for either watermark means the caller has none yet: it takes the heads and sees only
 * what happens next. A tab replaying the store's whole history as it loads is a demo of
 * nothing, and the graph it just fetched is already current.
 */
export async function readPulse(sinceCommit: number | null, sinceAccess: number | null): Promise<Pulse> {
  const client = getClient();
  // One round trip for both heads. This runs four times a second while a viewer is open, so
  // it is the one query here worth not doing twice.
  const row = (await client.execute(
    'SELECT (SELECT MAX(rowid) FROM knowledge_commits) AS c, (SELECT MAX(rowid) FROM knowledge_access) AS a',
  )).rows[0];
  const commits = Number(row?.c ?? 0) || 0;
  const access = Number(row?.a ?? 0) || 0;

  const commitBurst = sinceCommit !== null && commits - sinceCommit > BURST;
  const accessBurst = sinceAccess !== null && access - sinceAccess > BURST;

  return {
    commits,
    access,
    changes: sinceCommit === null || commitBurst ? [] : await readChanges(client, sinceCommit, commits),
    retrievals: sinceAccess === null || accessBurst ? [] : await readRetrievals(client, sinceAccess, access),
    resync: commitBurst,
  };
}

/**
 * Collapsed to one entry per item carrying its latest action, matching what
 * `collapseCommitsSince` does for the change card: an item that was inserted and then
 * superseded inside one tick should animate where it ended up, not both ways at once.
 */
async function readChanges(client: Client, since: number, until: number): Promise<PulseChange[]> {
  const rows = (await client.execute({
    sql: 'SELECT changes FROM knowledge_commits WHERE rowid > ? AND rowid <= ? ORDER BY rowid ASC',
    args: [since, until],
  })).rows;

  const byItem = new Map<string, CommitChange['action']>();
  for (const row of rows) {
    const parsed = typeof row.changes === 'string' ? JSON.parse(row.changes) : row.changes;
    if (!Array.isArray(parsed)) continue;
    for (const change of parsed as CommitChange[]) {
      if (change?.itemId) byItem.set(change.itemId, change.action);
    }
  }
  return [...byItem].map(([itemId, action]) => ({ itemId, action }));
}

/**
 * Grouped by query fingerprint, so one retrieval lights as one event rather than as N
 * unrelated atoms. `rank` rides along because it is what makes the flare read as an ordered
 * answer instead of a flash: the viewer ignites the hits in rank order.
 *
 * The fingerprint is a SHA-256 of the query and the query text is NOT recoverable from it --
 * deliberately, and it stays that way. Storing the words to caption this would put every
 * question anyone asks memory on disk to decorate an animation. `surface` is what the caller
 * gets instead, and it answers the question that actually matters on screen: whether the
 * agent asked or the person watching did.
 *
 * `feedback` rows are excluded because they are not retrievals -- they are a later verdict on
 * one, written when the agent reports whether a hit was used.
 */
async function readRetrievals(client: Client, since: number, until: number): Promise<PulseRetrieval[]> {
  const rows = (await client.execute({
    sql: `SELECT knowledge_item_id AS item, "rank" AS rank, query_fingerprint AS fp, surface
          FROM knowledge_access
          WHERE rowid > ? AND rowid <= ? AND surface != 'feedback'
          ORDER BY rowid ASC`,
    args: [since, until],
  })).rows;

  const byQuery = new Map<string, PulseRetrieval>();
  for (const row of rows) {
    const surface = String(row.surface ?? '');
    // A null fingerprint means the retrieval carried no query text. Keying those by surface
    // alone lumps them together, which over a 250ms window is what they are anyway.
    const key = (row.fp === null || row.fp === undefined ? '' : String(row.fp)) + '|' + surface;
    const entry = byQuery.get(key) ?? { surface, hits: [] };
    entry.hits.push({ itemId: String(row.item), rank: Number(row.rank) || 0 });
    byQuery.set(key, entry);
  }
  return [...byQuery.values()];
}
