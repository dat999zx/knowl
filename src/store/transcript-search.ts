import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { getClient } from './database.js';
import { ensureTranscriptIndex, sessionFiles, tokenize, transcriptIndexStats } from './transcript-index.js';

export { encodeProjectDir, transcriptStores } from './transcript-index.js';

// Ranked search over raw Claude Code session transcripts.
//
// Knowl stores distilled atoms. Those are lossy by construction: whatever the
// writer did not think worth keeping is gone, and there is no fallback. The
// transcripts are the lossless floor underneath - every word actually
// exchanged, still on disk. This makes that floor reachable, so a miss in
// memory becomes a slower lookup rather than amnesia.
//
// Consumer is an agent, not a human: no TUI, no pager. What matters is
// precision ranking, tight snippets, and a locator to cite when promoting a
// finding back into memory.

export interface TranscriptHit {
  sessionId: string;
  line: number;
  role: string;
  timestamp?: string;
  score: number;
  snippet: string;
  /** Cite this in the atom when promoting, so the claim keeps its provenance. */
  locator: string;
}

/** Supplied by the caller so this module never depends on how embeddings are configured. */
export interface SemanticReranker {
  model: string;
  embed(texts: string[]): Promise<number[][]>;
}

export interface TranscriptSearchOptions {
  projectDir?: string;
  limit?: number;
  since?: string;
  snippetChars?: number;
  /**
   * Restrict to one session, by id or a unique prefix. This is what makes a
   * handoff brief actionable: a new session is told which session it continues
   * from, and needs a way to ask that transcript specifically before widening
   * to the whole archive.
   */
  sessionId?: string;
  /** Override the config roots to scan. Injected by tests so they never mutate HOME. */
  stores?: string[];
  /** When present, the top BM25 candidates are re-ranked and the two orders fused. */
  semantic?: SemanticReranker;
}

// Reciprocal Rank Fusion. 60 is the value from the original paper and is
// deliberately large: it flattens the head so neither ranker can dictate the
// result on its own, which is the point of fusing them.
const RRF_K = 60;

// How many BM25 candidates get embedded for the semantic pass. Embedding is the
// expensive half, so recall is bounded by what BM25 surfaces first - a real
// limitation, and the reason the lexical side is tuned to be good alone.
const RERANK_DEPTH = 50;

/**
 * Cap for a full-entry read. Matches the index's own per-message clip, so the
 * tool returns everything that was searchable and nothing more.
 */
export const MAX_TRANSCRIPT_ENTRY_CHARS = 20_000;

interface Scored { messageId: number; score: number }

/**
 * Rank with FTS5's own BM25, then apply the field weighting it has no way to
 * express. bm25() returns a negative number where more negative is better, so
 * it is inverted before the weight is applied.
 *
 * A wider candidate window than `depth` is read on purpose: re-weighting can
 * promote a row FTS5 ranked lower, and a window equal to the final limit would
 * have already discarded it.
 */
async function lexicalRank(projectDir: string, terms: string[], depth: number, sessionId?: string): Promise<Scored[]> {
  const client = getClient();
  // Prefix matching, the same convention knowledge search uses. Tokens are
  // already reduced to [a-z0-9_], so none of FTS5's operators can appear here.
  const match = terms.map(term => `${term}*`).join(' OR ');
  const rows = (await client.execute({
    sql: `SELECT transcript_fts.rowid AS id, bm25(transcript_fts) AS rank, m.weight AS weight
          FROM transcript_fts
          JOIN transcript_messages m ON m.id = transcript_fts.rowid
          WHERE transcript_fts MATCH ? AND m.project_dir = ?
            ${sessionId ? 'AND m.session_id LIKE ?' : ''}
          ORDER BY rank ASC
          LIMIT ?`,
    args: sessionId
      ? [match, projectDir, `${sessionId}%`, Math.max(depth * 4, 100)]
      : [match, projectDir, Math.max(depth * 4, 100)],
  })).rows;

  return rows
    .map(row => ({ messageId: Number(row.id), score: -Number(row.rank) * Number(row.weight) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, depth);
}

function cosine(left: number[], right: number[]): number {
  let dot = 0, l = 0, r = 0;
  for (let i = 0; i < left.length; i++) { dot += left[i] * right[i]; l += left[i] * left[i]; r += right[i] * right[i]; }
  return l === 0 || r === 0 ? 0 : dot / (Math.sqrt(l) * Math.sqrt(r));
}

/** Vectors for the candidates, embedding only those not already cached. */
async function candidateVectors(
  candidates: Array<{ messageId: number; text: string }>,
  semantic: SemanticReranker,
): Promise<Map<number, number[]>> {
  const client = getClient();
  const vectors = new Map<number, number[]>();
  if (candidates.length === 0) return vectors;

  const rows = (await client.execute({
    sql: `SELECT message_id, vector FROM transcript_embeddings WHERE model = ? AND message_id IN (${candidates.map(() => '?').join(',')})`,
    args: [semantic.model, ...candidates.map(c => c.messageId)],
  })).rows;
  for (const row of rows) {
    try { vectors.set(Number(row.message_id), JSON.parse(String(row.vector))); } catch { /* re-embed below */ }
  }

  const missing = candidates.filter(c => !vectors.has(c.messageId));
  if (missing.length > 0) {
    const embedded = await semantic.embed(missing.map(c => c.text.slice(0, 2_000)));
    for (let i = 0; i < missing.length; i++) {
      const vector = embedded[i];
      if (!vector) continue;
      vectors.set(missing[i].messageId, vector);
      await client.execute({
        sql: 'INSERT OR REPLACE INTO transcript_embeddings (message_id, model, vector) VALUES (?, ?, ?)',
        args: [missing[i].messageId, semantic.model, JSON.stringify(vector)],
      });
    }
  }
  return vectors;
}

function snippetAround(text: string, terms: Set<string>, chars: number): string {
  const lower = text.toLowerCase();
  let best = 0, bestCount = -1;
  const step = Math.max(1, Math.floor(chars / 4));
  for (let start = 0; start < Math.max(1, lower.length - chars); start += step) {
    const window = lower.slice(start, start + chars);
    let count = 0;
    for (const term of terms) if (window.includes(term)) count++;
    if (count > bestCount) { bestCount = count; best = start; }
  }
  const slice = text.slice(best, best + chars).replace(/\n{3,}/g, '\n\n').trim();
  return (best > 0 ? '…' : '') + slice + (best + chars < text.length ? '…' : '');
}

export async function searchTranscripts(
  query: string,
  options: TranscriptSearchOptions = {},
): Promise<{ hits: TranscriptHit[]; indexed: number; sessions: number; indexMs: number; indexComplete: boolean }> {
  const { projectDir = process.cwd(), limit = 10, since, snippetChars = 600, stores, semantic, sessionId } = options;
  const terms = [...new Set(tokenize(query))];

  const index = await ensureTranscriptIndex(projectDir, stores);
  const stats = await transcriptIndexStats(projectDir);
  const base = { indexed: stats.messages, sessions: stats.sessions, indexMs: index.ms, indexComplete: index.complete };
  if (terms.length === 0) return { hits: [], ...base };

  const lexical = await lexicalRank(projectDir, terms, semantic ? RERANK_DEPTH : limit * 3, sessionId);
  if (lexical.length === 0) return { hits: [], ...base };

  const client = getClient();
  const rows = (await client.execute({
    sql: `SELECT id, session_id, line, role, ts, text FROM transcript_messages
          WHERE id IN (${lexical.map(() => '?').join(',')})${since ? ' AND (ts IS NULL OR ts >= ?)' : ''}`,
    args: since ? [...lexical.map(l => l.messageId), since] : lexical.map(l => l.messageId),
  })).rows;
  const byId = new Map(rows.map(row => [Number(row.id), row]));

  let ordered = lexical.filter(entry => byId.has(entry.messageId));

  if (semantic && ordered.length > 1) {
    const candidates = ordered.map(entry => ({ messageId: entry.messageId, text: String(byId.get(entry.messageId)!.text) }));
    try {
      const byMessage = await candidateVectors(candidates, semantic);
      const [queryVector] = await semantic.embed([query]);
      if (queryVector && byMessage.size > 0) {
        const semanticOrder = [...byMessage.entries()]
          .map(([messageId, vector]) => ({ messageId, score: cosine(queryVector, vector) }))
          .sort((a, b) => b.score - a.score);
        // Reciprocal Rank Fusion: combine POSITIONS, not scores. BM25 magnitudes
        // and cosine similarities are not on a comparable scale, and normalising
        // them invents a relationship that isn't there.
        const fused = new Map<number, number>();
        ordered.forEach((entry, rank) => fused.set(entry.messageId, (fused.get(entry.messageId) ?? 0) + 1 / (RRF_K + rank + 1)));
        semanticOrder.forEach((entry, rank) => fused.set(entry.messageId, (fused.get(entry.messageId) ?? 0) + 1 / (RRF_K + rank + 1)));
        ordered = [...fused.entries()]
          .map(([messageId, score]) => ({ messageId, score }))
          .sort((a, b) => b.score - a.score);
      }
    } catch {
      // Embeddings are optional and can fail (model not downloaded, provider off).
      // Lexical order is a complete answer on its own, so degrade rather than error.
    }
  }

  const termSet = new Set(terms);
  const hits = ordered.slice(0, limit).map(entry => {
    const row = byId.get(entry.messageId)!;
    return {
      sessionId: String(row.session_id),
      line: Number(row.line),
      role: String(row.role),
      timestamp: row.ts ? String(row.ts) : undefined,
      score: Number(entry.score.toFixed(4)),
      snippet: snippetAround(String(row.text), termSet, snippetChars),
      locator: `transcript://${row.session_id}#L${row.line}`,
    };
  });

  return { hits, ...base };
}

/** Read one entry in full, straight from the file, for when a snippet cannot settle the question. */
export async function readTranscriptEntry(
  sessionId: string,
  line: number,
  projectDir = process.cwd(),
  stores?: string[],
): Promise<{ text: string; role: string; timestamp?: string } | null> {
  const files = await sessionFiles(projectDir, stores);
  const file = files.find(f => f.sessionId === sessionId || f.sessionId.startsWith(sessionId));
  if (!file) return null;
  const rl = createInterface({ input: createReadStream(file.path), crlfDelay: Infinity });
  let lineNo = 0;
  for await (const raw of rl) {
    lineNo++;
    if (lineNo !== line) continue;
    rl.close();
    try {
      const entry = JSON.parse(raw);
      const content = entry?.message?.content;
      const text = typeof content === 'string'
        ? content
        : Array.isArray(content)
          ? content.map((b: any) => b?.type === 'text' ? b.text
              : b?.type === 'tool_use' ? JSON.stringify(b.input ?? {})
              : b?.type === 'tool_result' ? (typeof b.content === 'string' ? b.content : JSON.stringify(b.content ?? ''))
              : '').join('\n')
          : '';
      return { text, role: entry.type, timestamp: entry.timestamp };
    } catch { return null; }
  }
  return null;
}
