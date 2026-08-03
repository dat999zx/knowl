import { getClient } from '../store/database.js';

export type SessionStatus = 'active' | 'interrupted' | 'idle';

/** How recent a heartbeat has to be for a bound session to count as live. */
const ACTIVE_WINDOW_MS = 15 * 60 * 1000;

/**
 * A status per session, derived and never stored.
 *
 * Storing it would be wrong the moment the session it describes changes, and this is a recall
 * surface: the answer only has to be true when it is read.
 *
 * `interrupted` outranks `active` deliberately. A session can be both -- bound and live, with an
 * unconsumed crash handoff naming it -- and the unfinished business is the more useful thing to
 * surface.
 *
 * One query per signal for the whole batch, not per session: a directory listing 60 sessions
 * would otherwise issue 120 round trips to answer one question.
 */
export async function deriveSessionStatuses(
  projectId: string,
  sessionIds: string[],
  now: Date = new Date(),
): Promise<Map<string, SessionStatus>> {
  const statuses = new Map<string, SessionStatus>(sessionIds.map(id => [id, 'idle']));
  if (sessionIds.length === 0) return statuses;

  const since = new Date(now.getTime() - ACTIVE_WINDOW_MS).toISOString();
  const placeholders = sessionIds.map(() => '?').join(', ');

  // The heartbeat lives on `memory_sessions`, not on the binding -- `host_session_bindings` has
  // no `last_seen_at`, only an `updated_at` that a turn bumps for other reasons.
  //
  // Deliberately not filtered by `project_root`. External session ids are already unique, and
  // that column has a known Windows drive-letter casing split that would drop real rows.
  const live = (await getClient().execute({
    sql: `SELECT b.external_session_id AS id
          FROM host_session_bindings b
          JOIN memory_sessions s ON s.id = b.memory_session_id
          WHERE b.external_session_id IN (${placeholders})
            AND b.active = 1
            AND s.status = 'active'
            AND s.last_heartbeat_at >= ?`,
    args: [...sessionIds, since],
  })).rows;
  for (const row of live) statuses.set(String(row.id), 'active');

  // Two shapes on purpose. Newer handoffs carry `session:<id>` as a tag; pre-tag ones name the
  // session only inside the content JSON, and real archives contain both. Matching only the tag
  // silently reports every older session as idle.
  const handoffs = (await getClient().execute({
    sql: `SELECT tags, content FROM knowledge_items
          WHERE status = 'active' AND tags LIKE '%pending_handoff%'`,
    args: [],
  })).rows;

  for (const row of handoffs) {
    const tags = String(row.tags ?? '');
    const content = String(row.content ?? '');
    if (content.includes('"consumed":true')) continue;

    for (const id of sessionIds) {
      // Both tests are delimited rather than bare substring matches. A plain `content.includes(id)`
      // marks `session-abc` interrupted whenever `session-abcdef` crashed, because one id is a
      // prefix of the other -- and real session ids share long prefixes far more often than not.
      if (tags.includes(`"session:${id}"`) || content.includes(`"externalSessionId":"${id}"`)) {
        statuses.set(id, 'interrupted');
      }
    }
  }

  return statuses;
}
