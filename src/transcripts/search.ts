import type { Client } from '@libsql/client';

export type TranscriptHit = {
  messageId: number;
  path: string;
  sessionId: string;
  parentSessionId: string | null;
  line: number;
  role: 'user' | 'assistant';
  score: number;
  /** Filled in by the caller from the source file; never stored. */
  text?: string;
};

/**
 * What a message's rank is multiplied by.
 *
 * PR #7 needed a third weight -- 0.3 for anything more than half tool output -- to stop pasted
 * files winning on volume. Tool output is not indexed at all here, so that weight has no work
 * to do and does not exist.
 */
export const ROLE_WEIGHTS: Record<'user' | 'assistant', number> = {
  user: 2.0,
  assistant: 1.0,
};

/**
 * Turn a human query into an FTS5 MATCH expression.
 *
 * Every token is stripped to word characters and quoted. Unquoted user input is FTS5 *syntax*:
 * a stray `"` or `*` is a query error, and `NOT` is an operator.
 */
export function toMatchQuery(query: string): string | null {
  const tokens = query
    .split(/\s+/)
    .map(token => token.replace(/[^\p{L}\p{N}_]/gu, ''))
    .filter(token => token.length > 0);
  if (tokens.length === 0) return null;
  return tokens.map(token => `"${token}"`).join(' OR ');
}

/**
 * Resolve a session id or unique prefix to the paths it covers.
 *
 * A prefix that matches nothing yields an empty list, which correctly produces no hits rather
 * than silently widening to the whole archive.
 */
async function pathsForSession(client: Client, sessionId: string): Promise<string[]> {
  const rows = (await client.execute({
    sql: 'SELECT DISTINCT path FROM transcript_messages WHERE session_id = ? OR session_id LIKE ?',
    args: [sessionId, `${sessionId}%`],
  })).rows;
  return rows.map(row => String(row.path));
}

/**
 * BM25 ranking with role weighting.
 *
 * `bm25()` is negative-is-better, so it is negated before the weight is applied. The candidate
 * window is wider than `limit` because re-weighting can promote a row FTS5 ranked lower.
 */
export async function lexicalRank(
  client: Client,
  query: string,
  limit: number,
  sessionId?: string,
): Promise<TranscriptHit[]> {
  const match = toMatchQuery(query);
  if (!match) return [];

  const args: unknown[] = [match];
  let scope = '';
  if (sessionId) {
    const paths = await pathsForSession(client, sessionId);
    if (paths.length === 0) return [];
    scope = ` AND m.path IN (${paths.map(() => '?').join(', ')})`;
    args.push(...paths);
  }
  args.push(limit * 4);

  const rows = (await client.execute({
    sql: `SELECT m.id, m.path, m.session_id, m.parent_session_id, m.line, m.role,
                 bm25(transcript_fts) AS rank
          FROM transcript_fts
          JOIN transcript_messages m ON m.id = transcript_fts.rowid
          WHERE transcript_fts MATCH ?${scope}
          ORDER BY rank
          LIMIT ?`,
    args: args as never[],
  })).rows;

  return rows
    .map(row => {
      const role = String(row.role) as 'user' | 'assistant';
      return {
        messageId: Number(row.id),
        path: String(row.path),
        sessionId: String(row.session_id),
        parentSessionId: row.parent_session_id === null ? null : String(row.parent_session_id),
        line: Number(row.line),
        role,
        score: -Number(row.rank) * (ROLE_WEIGHTS[role] ?? 1),
      };
    })
    .sort((left, right) => right.score - left.score)
    .slice(0, limit);
}
