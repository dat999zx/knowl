import type { Client } from '@libsql/client';
import type { KnowledgeEmbedder } from '../store/vector-index.js';
import { dotQuantized } from './quantize.js';
import { readMessagesAt } from './read.js';

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
 * Unquoted user input is FTS5 *syntax*: a stray `"` or `*` is a query error and `NOT` is an
 * operator, so every token has to be quoted. The mistake was what came first -- stripping the
 * token to word characters and gluing the pieces together. `index-pass.ts` became the single
 * token `indexpassts`, which the unicode61 tokenizer can never have produced, so it matched
 * nothing. Measured against the live index, every one of these returned zero: `index-pass.ts`,
 * `src/transcripts`, `duckprep.xyz`, `tailwind-v4`, `GPT-5.6` -- which is to say, filenames,
 * paths, domains and versions, the most natural things to search a transcript for.
 *
 * Quoting alone fixes it, because a quoted string is handed to the TOKENIZER rather than the
 * parser and its tokens become a phrase: `"index-pass.ts"` is the phrase [index, pass, ts],
 * which is exactly what the index holds (FTS5 §3.2). No schema change and no reindex -- and
 * a phrase beats splitting into OR'd terms, because it keeps the adjacency.
 *
 * Adding `.-/` to `tokenchars` would be the mirror-image bug: the path becomes one atomic
 * token and searching `index` stops finding it. The trigram tokenizer drops every token under
 * three characters, so `ts` and `db` would return nothing at all.
 */
export function toMatchQuery(query: string): string | null {
  const phrases = query
    .split(/\s+/)
    // Dropped rather than stripped: a token with no letter, digit or underscore has nothing
    // the tokenizer could index, so quoting it would produce a phrase of zero tokens.
    .filter(token => /[\p{L}\p{N}_]/u.test(token))
    .flatMap(token => {
      // Doubling `"` is the only escape the FTS5 string grammar defines (§3.1).
      const phrase = `"${token.replace(/"/g, '""')}"`;
      // A safety net for the spelling difference, not the punctuation: someone searching
      // `re-index` should still find a message that wrote `reindex`. Only added when the
      // token's interior actually contains a separator, so ordinary prose is untouched.
      const core = token.replace(/^[^\p{L}\p{N}_]+|[^\p{L}\p{N}_]+$/gu, '');
      const glued = core.replace(/[^\p{L}\p{N}_]/gu, '');
      return glued === core ? [phrase] : [phrase, `"${glued}"`];
    });
  if (phrases.length === 0) return null;
  return phrases.join(' OR ');
}

/**
 * Escape a session id for use as a LIKE *prefix* rather than a pattern.
 *
 * `%` and `_` are wildcards, and `sessionId` arrives from an MCP argument -- so an unescaped
 * `%` turned "restrict to this session" into "match every session", silently widening the very
 * thing the caller asked to narrow. Measured before the fix: `sessionId: '%'` returned hits
 * from every indexed session.
 */
export function escapeLikePrefix(sessionId: string): string {
  return sessionId.replace(/[\\%_]/g, character => `\\${character}`);
}

/**
 * Cap on paths a prefix may expand to.
 *
 * Bounded because the expansion becomes one `IN (?, ?, ...)` list: an over-broad prefix would
 * otherwise build a parameter list the size of the archive.
 */
const MAX_SESSION_PATHS = 50;

/**
 * Resolve a session id or unique prefix to the paths it covers.
 *
 * A prefix that matches nothing yields an empty list, which correctly produces no hits rather
 * than silently widening to the whole archive.
 */
async function pathsForSession(client: Client, sessionId: string): Promise<string[]> {
  const rows = (await client.execute({
    sql: `SELECT DISTINCT path FROM transcript_messages
          WHERE session_id = ? OR session_id LIKE ? ESCAPE '\\'
          LIMIT ?`,
    args: [sessionId, `${escapeLikePrefix(sessionId)}%`, MAX_SESSION_PATHS],
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

/**
 * RRF's rank constant. 60 is the value from the original paper and what the knowledge-side
 * fusion uses; keeping them equal means one number to reason about, not two.
 */
export const RRF_K = 60;

/**
 * Reciprocal Rank Fusion.
 *
 * Combines *positions* rather than scores. BM25 magnitudes and cosine similarities are not on a
 * comparable scale, so any weighted sum of the raw numbers is arbitrary.
 */
export function fuseRankings<T extends TranscriptHit>(
  rankings: T[][],
  limit: number,
  /**
   * Identity across rankings. Defaults to the message id, which is unique within one database
   * but NOT across repos -- federation must pass a repo-qualified key or two repos' message 5
   * would merge into one hit.
   */
  keyOf: (hit: T) => string = hit => String(hit.messageId),
): T[] {
  const scores = new Map<string, number>();
  const byKey = new Map<string, T>();

  for (const ranking of rankings) {
    ranking.forEach((hit, index) => {
      const key = keyOf(hit);
      scores.set(key, (scores.get(key) ?? 0) + 1 / (RRF_K + index + 1));
      if (!byKey.has(key)) byKey.set(key, hit);
    });
  }

  return [...scores.entries()]
    .sort((left, right) => right[1] - left[1] || compareTieKeys(left[0], right[0]))
    .slice(0, limit)
    .map(([key, score]) => ({ ...byKey.get(key)!, score }));
}

/**
 * Deterministic tiebreak for equal RRF scores.
 *
 * Ties are not rare here, they are the normal case in federation: a hit appears in exactly one
 * repo's ranking, so every repo's rank-1 scores exactly 1/(60+1). `Array.prototype.sort` is
 * stable, so without this the merged order is insertion order -- and with `limit: 1` the repo
 * that happened to be visited first always wins. That is iteration order dressed as relevance.
 *
 * Hashing the key gives an arbitrary but *stable* order that does not correlate with which repo
 * was searched first, so reversing the peer list cannot change the answer.
 */
function compareTieKeys(left: string, right: string): number {
  const hash = (value: string) => {
    let h = 2166136261;
    for (let i = 0; i < value.length; i++) {
      h ^= value.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  };
  const difference = hash(left) - hash(right);
  // Fall back to the key itself so two colliding hashes still order deterministically.
  return difference !== 0 ? difference : (left < right ? -1 : left > right ? 1 : 0);
}

/**
 * Cosine ranking over every stored vector.
 *
 * A full scan, not an ANN index: a few thousand int8 vectors is single-digit milliseconds, and
 * an index would cost rebuilds, a recall knob, and a native extension `@libsql/client` cannot
 * load. Crucially this covers the *whole* corpus -- re-ranking a lexical shortlist could never
 * surface a message whose words differ from the query, which is the query this exists for.
 */
export async function semanticRank(
  client: Client,
  queryVector: number[],
  fingerprint: string,
  limit: number,
  sessionId?: string,
): Promise<TranscriptHit[]> {
  const args: unknown[] = [fingerprint];
  let scope = '';
  if (sessionId) {
    // Same escaping as the lexical side. Leaving it out here would mean a `%` narrowed the
    // keyword half and not the semantic half, so the two rankings would disagree about scope.
    scope = " AND (m.session_id = ? OR m.session_id LIKE ? ESCAPE '\\')";
    args.push(sessionId, `${escapeLikePrefix(sessionId)}%`);
  }

  const rows = (await client.execute({
    sql: `SELECT m.id, m.path, m.session_id, m.parent_session_id, m.line, m.role, v.scale, v.vec
          FROM transcript_vectors v
          JOIN transcript_messages m ON m.id = v.message_id
          WHERE v.fingerprint = ?${scope}`,
    args: args as never[],
  })).rows;

  return rows
    .map(row => ({
      messageId: Number(row.id),
      path: String(row.path),
      sessionId: String(row.session_id),
      parentSessionId: row.parent_session_id === null ? null : String(row.parent_session_id),
      line: Number(row.line),
      role: String(row.role) as 'user' | 'assistant',
      score: dotQuantized(queryVector, new Uint8Array(row.vec as ArrayBuffer), Number(row.scale)),
    }))
    .sort((left, right) => right.score - left.score)
    .slice(0, limit);
}

export type SearchInput = {
  client: Client;
  query: string;
  limit: number;
  projectRoot: string;
  sessionId?: string;
  embedder?: KnowledgeEmbedder;
};

export async function searchTranscripts(
  input: SearchInput,
): Promise<{ hits: TranscriptHit[]; coverage: { embedded: number; indexed: number } }> {
  const { client, query, limit, sessionId } = input;

  const rankings: TranscriptHit[][] = [await lexicalRank(client, query, limit * 2, sessionId)];

  let fingerprint: string | null = null;
  if (input.embedder) {
    try {
      const vector = await input.embedder.embedQuery(query);
      if (vector?.length) {
        fingerprint = input.embedder.profileFingerprint;
        rankings.push(await semanticRank(client, vector, fingerprint, limit * 2, sessionId));
      }
    } catch {
      // A missing model or a failed load degrades to lexical. Returning nothing because the
      // optional half broke would be worse than returning the half that works.
    }
  }

  const fused = fuseRankings(rankings, limit);

  // Bodies are read only for what is actually returned -- ranking never touches disk. Grouped
  // by file: five hits in one session is one pass, not five whole-file reads.
  const byFile = new Map<string, TranscriptHit[]>();
  for (const hit of fused) {
    const group = byFile.get(hit.path);
    if (group) group.push(hit);
    else byFile.set(hit.path, [hit]);
  }
  for (const [filePath, group] of byFile) {
    const bodies = await readMessagesAt(filePath, group.map(hit => hit.line));
    for (const hit of group) hit.text = bodies.get(hit.line)?.text;
  }

  const indexed = Number((await client.execute('SELECT COUNT(*) AS n FROM transcript_messages')).rows[0].n);
  const embedded = fingerprint
    ? Number((await client.execute({
        sql: 'SELECT COUNT(*) AS n FROM transcript_vectors WHERE fingerprint = ?',
        args: [fingerprint],
      })).rows[0].n)
    : 0;

  return { hits: fused, coverage: { embedded, indexed } };
}
