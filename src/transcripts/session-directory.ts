import { getClient } from '../store/database.js';
import { resolveStorage } from '../store/storage-roles.js';
import { openTranscriptDb, readTranscriptIndexState, TranscriptIndexMissingError } from './database.js';
import { deriveSessionStatuses, type SessionStatus } from './session-status.js';

export type SessionEntry = {
  sessionId: string;
  parentSessionId: string | null;
  name: string | null;
  opening: string | null;
  status: SessionStatus;
  messages: number;
  lastActiveAt: string | null;
  card: string | null;
  promoted: string[];
};

/** Tag a session uses to declare its own purpose through the ordinary `knowl_store`. */
const CARD_TAG = 'session-card';

/** Cap on how many promoted titles are carried per session, so one prolific session cannot flood. */
const MAX_PROMOTED_PER_SESSION = 20;

/**
 * Every query token has to appear somewhere across the intent fields.
 *
 * Name, opening and card only -- never message bodies. Matching bodies here would make this
 * indistinguishable from `knowl_transcript_search`, and the two answer different questions:
 * "which session was about X" versus "where was X said".
 */
function matchesQuery(entry: SessionEntry, tokens: string[]): boolean {
  if (tokens.length === 0) return true;
  const haystack = [entry.name, entry.opening, entry.card]
    .filter((value): value is string => typeof value === 'string')
    .join('\n')
    .toLowerCase();
  return tokens.every(token => haystack.includes(token));
}

/** Newest first, with unknown activity last rather than sorted as the empty string. */
function byRecency(a: SessionEntry, b: SessionEntry): number {
  if (a.lastActiveAt === b.lastActiveAt) return a.sessionId.localeCompare(b.sessionId);
  if (a.lastActiveAt === null) return 1;
  if (b.lastActiveAt === null) return -1;
  return b.lastActiveAt.localeCompare(a.lastActiveAt);
}

/**
 * The declared card per session: newest wins.
 *
 * Cards are ordinary knowledge items, so a session that revised its intent has more than one.
 * Ordering by `updated_at` and keeping the first seen per session is the whole rule.
 */
async function loadCards(sessionIds: Set<string>): Promise<Map<string, string>> {
  const cards = new Map<string, string>();
  if (sessionIds.size === 0) return cards;

  const rows = (await getClient().execute({
    sql: `SELECT tags, content FROM knowledge_items
          WHERE status = 'active' AND tags LIKE ?
          ORDER BY updated_at DESC`,
    args: [`%${CARD_TAG}%`],
  })).rows;

  for (const row of rows) {
    const tags = String(row.tags ?? '');
    for (const id of sessionIds) {
      // Delimited, so `session:abc` cannot claim a card tagged for `session:abcdef`.
      if (!tags.includes(`"session:${id}"`)) continue;
      if (!cards.has(id)) cards.set(id, String(row.content ?? '').trim());
    }
  }
  return cards;
}

/**
 * What each session promoted into memory, through `host_session_bindings -> memory_sessions`.
 *
 * `promotion_items` is a JSON array of knowledge item ids on the session row, not a table, so the
 * titles come from a second lookup. This join is the one thing a plain transcript viewer cannot
 * offer: not what the session said, but what it was worth.
 */
async function loadPromoted(sessionIds: Set<string>): Promise<Map<string, string[]>> {
  const promoted = new Map<string, string[]>();
  if (sessionIds.size === 0) return promoted;

  const ids = [...sessionIds];
  const placeholders = ids.map(() => '?').join(', ');
  const rows = (await getClient().execute({
    sql: `SELECT b.external_session_id AS id, s.promotion_items AS items
          FROM host_session_bindings b
          JOIN memory_sessions s ON s.id = b.memory_session_id
          WHERE b.external_session_id IN (${placeholders})
            AND s.promotion_items IS NOT NULL`,
    args: ids,
  })).rows;

  const wanted = new Map<string, Set<string>>();
  for (const row of rows) {
    const sessionId = String(row.id);
    let itemIds: unknown;
    try {
      itemIds = JSON.parse(String(row.items ?? '[]'));
    } catch {
      continue; // A malformed column must not cost the whole listing.
    }
    if (!Array.isArray(itemIds)) continue;
    const bucket = wanted.get(sessionId) ?? new Set<string>();
    for (const itemId of itemIds.slice(0, MAX_PROMOTED_PER_SESSION)) {
      if (typeof itemId === 'string') bucket.add(itemId);
    }
    wanted.set(sessionId, bucket);
  }

  const allIds = [...new Set([...wanted.values()].flatMap(set => [...set]))];
  if (allIds.length === 0) return promoted;

  const titles = new Map<string, string>();
  const titleRows = (await getClient().execute({
    sql: `SELECT id, title FROM knowledge_items WHERE id IN (${allIds.map(() => '?').join(', ')})`,
    args: allIds,
  })).rows;
  for (const row of titleRows) titles.set(String(row.id), String(row.title));

  for (const [sessionId, bucket] of wanted) {
    const names = [...bucket].map(id => titles.get(id)).filter((t): t is string => Boolean(t));
    if (names.length) promoted.set(sessionId, names);
  }
  return promoted;
}

/**
 * A browsable inventory of this project's past sessions.
 *
 * Deliberately uncapped by default. The native `/resume` picker caps at 50 and hides unnamed
 * sessions entirely, which is the behaviour behind a string of upstream issues; an unnamed
 * session here is described by its opening ask instead of being dropped.
 */
export async function listSessionDirectory(input: {
  projectId: string;
  projectRoot: string;
  query?: string;
  limit?: number;
}): Promise<{ sessions: SessionEntry[]; indexComplete: boolean }> {
  // Read-only, and only if it already exists. A writable open creates the file, which would
  // resurrect an index the user deleted by turning the feature off.
  let client;
  try {
    client = await openTranscriptDb(resolveStorage(input.projectRoot).transcripts, { readOnly: true });
  } catch (error) {
    if (error instanceof TranscriptIndexMissingError) return { sessions: [], indexComplete: false };
    throw error;
  }

  const rows = (await client.execute(`
    SELECT f.session_id AS session_id,
           MAX(f.parent_session_id) AS parent_session_id,
           MAX(f.display_name) AS display_name,
           MAX(f.opening) AS opening,
           MIN(f.bytes_indexed >= f.size_at_index) AS complete,
           (SELECT COUNT(*) FROM transcript_messages m WHERE m.session_id = f.session_id) AS messages,
           (SELECT MAX(m.ts) FROM transcript_messages m WHERE m.session_id = f.session_id) AS last_active
    FROM transcript_files f
    GROUP BY f.session_id
  `)).rows;

  if (rows.length === 0) {
    // Nothing indexed is not the same as nothing to index, and a caller told "no sessions"
    // reads it as proof of absence. An empty index has not finished proving anything.
    return { sessions: [], indexComplete: false };
  }

  // Two questions, and the rows can only answer one of them. "Is every file I know about caught
  // up" says nothing about a file the pass never reached -- it has no row here at all, so a
  // listing missing whole sessions passed this test. What the last pass reported about itself is
  // the other half, and a pass that has never reported (or an index older than the record)
  // proves nothing either way.
  const passState = await readTranscriptIndexState(client);
  const indexComplete = passState !== null
    && passState.complete
    && rows.every(row => Number(row.complete ?? 0) === 1);
  const sessionIds = new Set(rows.map(row => String(row.session_id)));

  const [statuses, cards, promoted] = await Promise.all([
    deriveSessionStatuses(input.projectId, [...sessionIds]),
    loadCards(sessionIds),
    loadPromoted(sessionIds),
  ]);

  const entries: SessionEntry[] = rows.map(row => {
    const sessionId = String(row.session_id);
    return {
      sessionId,
      parentSessionId: row.parent_session_id === null ? null : String(row.parent_session_id),
      name: row.display_name === null ? null : String(row.display_name),
      opening: row.opening === null ? null : String(row.opening),
      status: statuses.get(sessionId) ?? 'idle',
      messages: Number(row.messages ?? 0),
      lastActiveAt: row.last_active === null ? null : String(row.last_active),
      card: cards.get(sessionId) ?? null,
      promoted: promoted.get(sessionId) ?? [],
    };
  });

  const tokens = (input.query ?? '')
    .toLowerCase()
    .split(/\s+/)
    .map(token => token.trim())
    .filter(Boolean);

  const matched = entries.filter(entry => matchesQuery(entry, tokens)).sort(byRecency);
  const sessions = input.limit === undefined ? matched : matched.slice(0, input.limit);

  return { sessions, indexComplete };
}
