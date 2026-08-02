import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { getClient } from './database.js';
import { ensureTranscriptIndex, sessionFiles, tokenize, transcriptIndexStats } from './transcript-index.js';
import { normalizeProjectDir } from './project-dir.js';
import { embedTranscripts, semanticCandidates, transcriptVectorStats, type TranscriptEmbedder } from './transcript-vectors.js';

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

export type { TranscriptEmbedder } from './transcript-vectors.js';

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
  /**
   * Cap on the indexing pass this search triggers. Lower it when the caller is on a tighter
   * deadline than the answer is worth — the result reports the coverage it actually got.
   */
  indexBudgetMs?: number;
  /** Override the config roots to scan. Injected by tests so they never mutate HOME. */
  stores?: string[];
  /** When present, the archive is also ranked by vector similarity and the two orders fused. */
  semantic?: TranscriptEmbedder;
  /** Cap on the embedding top-up this search triggers. 0 disables it, leaving coverage to grow only via the CLI. */
  embedBudgetMs?: number;
}

// Reciprocal Rank Fusion. 60 is the value from the original paper and is
// deliberately large: it flattens the head so neither ranker can dictate the
// result on its own, which is the point of fusing them.
const RRF_K = 60;

/**
 * Candidates taken from EACH ranker before fusion. The two lists are built
 * independently over the whole archive, so a message only the semantic side
 * knows about can win outright. That is the point: this used to re-rank BM25's
 * top 50, which meant semantic search could reorder the keyword results but
 * never reach past them - and the query it exists to serve is the one whose
 * remembered words are not the words that were used.
 */
const FUSION_DEPTH = 50;

/**
 * Time one search may spend embedding messages that have none yet. Small on
 * purpose: this is a top-up so an archive warms as it is used, not the way to
 * embed a large one. `knowl reindex --transcripts` does that in one pass.
 */
const DEFAULT_EMBED_BUDGET_MS = 1_500;

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
): Promise<{
  hits: TranscriptHit[];
  indexed: number;
  sessions: number;
  indexMs: number;
  indexComplete: boolean;
  /** Session files not yet searchable this pass; 0 when the index is complete. */
  filesPending: number;
  filesScanned: number;
  /** Messages carrying a vector for the active model; 0 when the search was lexical only. */
  vectorsEmbedded: number;
  /**
   * True when this result cannot distinguish "not in the archive" from "not indexed yet":
   * nothing was found AND part of the archive was never searched. Callers must surface it as
   * an inconclusive search rather than as an answer — an empty list reads as absence, and
   * that inference is exactly what a partial index cannot support.
   */
  inconclusive: boolean;
}> {
  const { projectDir: rawProjectDir = process.cwd(), limit = 10, since, snippetChars = 600, stores, semantic, sessionId, indexBudgetMs, embedBudgetMs = DEFAULT_EMBED_BUDGET_MS } = options;
  const projectDir = normalizeProjectDir(rawProjectDir);
  const terms = [...new Set(tokenize(query))];

  const index = await ensureTranscriptIndex(projectDir, stores, indexBudgetMs);
  const stats = await transcriptIndexStats(projectDir);

  // Warm a slice of the archive, then report how much of it the semantic side
  // could actually see. Partial coverage is normal and fine - the lexical side
  // covers everything - but it must travel as a number, because "semantic
  // search found nothing" means something different at 2% than at 100%.
  let vectors = { embedded: 0, total: stats.messages };
  if (semantic) {
    try {
      if (embedBudgetMs > 0) await embedTranscripts(projectDir, semantic, { budgetMs: embedBudgetMs });
      vectors = await transcriptVectorStats(projectDir, semantic.model);
    } catch { /* embeddings are optional; lexical search is unaffected */ }
  }

  const base = {
    indexed: stats.messages,
    sessions: stats.sessions,
    indexMs: index.ms,
    indexComplete: index.complete,
    filesPending: index.filesPending,
    filesScanned: index.filesScanned,
    vectorsEmbedded: vectors.embedded,
  };
  // Nothing found against a partially-searched archive is not a finding. With hits in hand a
  // caller has something real and `filesPending` tells them more may exist; with none, the
  // only honest answer is that the search did not conclude.
  const finish = (hits: TranscriptHit[]) => ({ hits, ...base, inconclusive: hits.length === 0 && !base.indexComplete });

  // An unusable query is the caller's problem, not the index's: never blame coverage for it.
  if (terms.length === 0) return { hits: [], ...base, inconclusive: false };

  const lexical = await lexicalRank(projectDir, terms, semantic ? FUSION_DEPTH : limit * 3, sessionId);

  // Built over the whole archive rather than over `lexical`, so it can bring
  // back messages the keyword pass never saw.
  let semanticOrder: Scored[] = [];
  if (semantic && vectors.embedded > 0) {
    try {
      const [queryVector] = await semantic.embed([query]);
      if (queryVector) {
        semanticOrder = await semanticCandidates(projectDir, queryVector, semantic.model, FUSION_DEPTH, sessionId);
      }
    } catch {
      // Embeddings are optional and can fail (model not downloaded, provider off).
      // Lexical order is a complete answer on its own, so degrade rather than error.
    }
  }

  if (lexical.length === 0 && semanticOrder.length === 0) return finish([]);

  const client = getClient();
  const ids = [...new Set([...lexical.map(entry => entry.messageId), ...semanticOrder.map(entry => entry.messageId)])];
  const rows = (await client.execute({
    sql: `SELECT id, session_id, line, role, ts, text FROM transcript_messages
          WHERE id IN (${ids.map(() => '?').join(',')})${since ? ' AND (ts IS NULL OR ts >= ?)' : ''}`,
    args: since ? [...ids, since] : ids,
  })).rows;
  const byId = new Map(rows.map(row => [Number(row.id), row]));

  let ordered = lexical.filter(entry => byId.has(entry.messageId));

  if (semanticOrder.length > 0) {
    // Reciprocal Rank Fusion: combine POSITIONS, not scores. BM25 magnitudes
    // and quantized dot products are not on a comparable scale, and normalising
    // them invents a relationship that isn't there.
    const fused = new Map<number, number>();
    const add = (entry: Scored, rank: number) => {
      if (!byId.has(entry.messageId)) return;
      fused.set(entry.messageId, (fused.get(entry.messageId) ?? 0) + 1 / (RRF_K + rank + 1));
    };
    ordered.forEach(add);
    semanticOrder.forEach(add);
    ordered = [...fused.entries()]
      .map(([messageId, score]) => ({ messageId, score }))
      .sort((a, b) => b.score - a.score);
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

  return finish(hits);
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
