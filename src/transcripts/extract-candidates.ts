import crypto from 'node:crypto';
import type { Client } from '@libsql/client';
import type { KnowledgeAtom, ProjectConfig } from '../core/types.js';
import { hasAiConfigured } from '../core/config.js';
// `extractKnowledge` directly rather than `pipeline/extract.js`, which merely wraps it. The
// module-boundary guard refuses transcripts -> pipeline, and it is right to: pipeline's job is
// extract-verify-merge as one unit, and what this needs is the extract step alone -- staging
// exists precisely so verify and merge happen later, under a human decision.
import { extractKnowledge, initAI } from '../ai/provider.js';
import { readProseFrom } from './parse.js';

/**
 * Distilling a transcript into atoms, staged for review rather than promoted.
 *
 * The index makes past sessions searchable; it never puts anything in the knowledge store, so a
 * fresh install stays empty until somebody writes to it. This is the bulk path that fills it.
 *
 * **Nothing here promotes.** Extraction writes to `transcript_candidates` and stops. That is the
 * whole design: a first run over a real archive produces on the order of a thousand atoms, and
 * promoting them unreviewed would put an unexamined corpus in front of every future query while
 * the standing rule for this write path is that a human decides what durable memory contains.
 * Approval is a separate, explicit act -- see `approveCandidates`.
 *
 * **It costs the operator money, and the code says so out loud.** Extraction runs the configured
 * model over whole sessions; an archive of a few hundred is a real bill. So there is no "extract
 * everything" default: the caller states a session limit, the estimate is reported before any
 * request is made, and the resume watermark means a second run never pays twice for one session.
 */

/** Bytes of one session's prose handed to the model. */
const MAX_SESSION_CHARS = 24_000;

/** Sessions extracted in one run unless the caller raises it. Deliberately small: see above. */
export const DEFAULT_EXTRACT_LIMIT = 10;

const newId = (): string => crypto.randomUUID().replace(/-/g, '').slice(0, 16);

export type ExtractionCandidate = {
  id: string;
  sessionId: string;
  sourcePath: string;
  harness: string;
  category: string;
  title: string;
  content: string;
  confidence: number;
  status: string;
};

export type ExtractionPlanSession = { sessionId: string; path: string; harness: string; chars: number };

export type ExtractionPlan = {
  /** Sessions this run would extract, already limited. */
  sessions: ExtractionPlanSession[];
  /** Sessions with prose that have never been extracted, before the limit was applied. */
  pending: number;
  /** Sessions already extracted and therefore skipped. */
  done: number;
  /** Characters this run would send to the model, after per-session truncation. */
  chars: number;
};

/**
 * What a run would do, without doing any of it.
 *
 * Separate from `extractCandidates` so a caller can show the operator the size of the bill before
 * a single request is made. The CLI prints this and requires confirmation; nothing here decides
 * that policy, it only makes it possible to have one.
 */
export async function planExtraction(
  db: Client,
  options: { limit?: number } = {},
): Promise<ExtractionPlan> {
  const limit = Math.max(1, options.limit ?? DEFAULT_EXTRACT_LIMIT);

  const rows = (await db.execute(
    `SELECT f.session_id AS session_id, f.path AS path, f.harness AS harness,
            COALESCE(SUM(m.chars), 0) AS chars
     FROM transcript_files f
     JOIN transcript_messages m ON m.path = f.path
     LEFT JOIN transcript_extractions e ON e.session_id = f.session_id
     WHERE e.session_id IS NULL
     GROUP BY f.path
     HAVING chars > 0
     ORDER BY chars DESC`,
  )).rows;

  const done = Number((await db.execute('SELECT COUNT(*) AS n FROM transcript_extractions')).rows[0]?.n ?? 0);

  const sessions = rows.slice(0, limit).map(row => ({
    sessionId: String(row.session_id),
    path: String(row.path),
    harness: String(row.harness ?? 'claude'),
    // What will actually be sent, which is the truncated length rather than the session's size.
    chars: Math.min(Number(row.chars ?? 0), MAX_SESSION_CHARS),
  }));

  return {
    sessions,
    pending: rows.length,
    done,
    chars: sessions.reduce((total, session) => total + session.chars, 0),
  };
}

/**
 * One session's prose, as the text handed to the model.
 *
 * Read from the `.jsonl` rather than the index because the index stores pointers, not bodies --
 * that is the property that keeps it small, and it means the text has to come from the file.
 *
 * Truncated from the START, keeping the tail. A session's conclusions are at its end: what was
 * decided, what turned out to be true, what was fixed. Keeping the head would preserve the
 * problem statement and drop the answer.
 */
async function sessionText(filePath: string): Promise<string> {
  const { messages } = await readProseFrom(filePath, 0, 0);
  const joined = messages.map(message => `${message.role}: ${message.text}`).join('\n\n');
  return joined.length > MAX_SESSION_CHARS ? joined.slice(joined.length - MAX_SESSION_CHARS) : joined;
}

function stageAtom(
  db: Client,
  session: ExtractionPlanSession,
  atom: KnowledgeAtom,
  now: string,
): Promise<unknown> {
  return db.execute({
    sql: `INSERT INTO transcript_candidates
            (id, session_id, source_path, harness, category, title, content, reasoning, tags, confidence, status, extracted_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
    args: [
      newId(), session.sessionId, session.path, session.harness,
      atom.category, atom.title, atom.content,
      atom.reasoning ?? null,
      atom.tags && atom.tags.length ? JSON.stringify(atom.tags) : null,
      typeof atom.confidence === 'number' ? atom.confidence : 0.5,
      now,
    ],
  });
}

export type ExtractionResult = {
  sessionsExtracted: number;
  candidates: number;
  /** Sessions left unextracted by the limit or the deadline. */
  remaining: number;
  /** Sessions that produced no atoms, which are still recorded so a rerun does not repay. */
  empty: number;
};

/**
 * Extract the planned sessions into staged candidates.
 *
 * A session that yields nothing is still watermarked. Otherwise every run would re-send the same
 * unproductive sessions to the model forever, and the sessions most likely to yield nothing are
 * the short ones -- so the bill would be dominated by exactly the work with no output.
 *
 * A session whose extraction throws is left unwatermarked and simply not counted: a transient
 * provider failure must not mark a session permanently done.
 */
export async function extractCandidates(
  db: Client,
  config: ProjectConfig,
  options: { limit?: number; deadline?: number } = {},
): Promise<ExtractionResult> {
  if (!hasAiConfigured(config)) {
    throw new Error(
      'Extracting atoms from transcripts requires explicit Knowl AI configuration. '
      + 'Configure ai.provider and ai.model (knowl config), or distil a session yourself with '
      + 'knowl_transcript_read and store the result with knowl_ingest_atoms.',
    );
  }
  initAI(config.ai!);

  const plan = await planExtraction(db, options);
  let sessionsExtracted = 0;
  let candidates = 0;
  let empty = 0;
  let stopped = 0;

  for (const session of plan.sessions) {
    if (options.deadline !== undefined && Date.now() >= options.deadline) break;
    stopped += 1;

    const text = await sessionText(session.path);
    if (!text.trim()) {
      await recordExtraction(db, session.sessionId, 0, 0);
      empty += 1;
      continue;
    }

    let atoms: KnowledgeAtom[];
    try {
      atoms = await extractKnowledge(text);
    } catch {
      // Unwatermarked on purpose: a provider hiccup is not a verdict about this session.
      stopped -= 1;
      continue;
    }

    const now = new Date().toISOString();
    for (const atom of atoms) await stageAtom(db, session, atom, now);
    await recordExtraction(db, session.sessionId, atoms.length, text.length);

    sessionsExtracted += 1;
    candidates += atoms.length;
    if (atoms.length === 0) empty += 1;
  }

  return {
    sessionsExtracted,
    candidates,
    empty,
    remaining: Math.max(0, plan.pending - stopped),
  };
}

async function recordExtraction(db: Client, sessionId: string, count: number, chars: number): Promise<void> {
  await db.execute({
    sql: `INSERT INTO transcript_extractions (session_id, extracted_at, candidate_count, chars_sent)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(session_id) DO UPDATE SET
            extracted_at = excluded.extracted_at,
            candidate_count = excluded.candidate_count,
            chars_sent = excluded.chars_sent`,
    args: [sessionId, new Date().toISOString(), count, chars],
  });
}

export async function listCandidates(
  db: Client,
  options: { status?: string; limit?: number } = {},
): Promise<ExtractionCandidate[]> {
  const status = options.status ?? 'pending';
  const rows = (await db.execute({
    sql: `SELECT id, session_id, source_path, harness, category, title, content, confidence, status
          FROM transcript_candidates
          WHERE status = ?
          ORDER BY confidence DESC, title ASC
          LIMIT ?`,
    args: [status, Math.max(1, options.limit ?? 50)],
  })).rows;

  return rows.map(row => ({
    id: String(row.id),
    sessionId: String(row.session_id),
    sourcePath: String(row.source_path),
    harness: String(row.harness ?? 'claude'),
    category: String(row.category),
    title: String(row.title),
    content: String(row.content),
    confidence: Number(row.confidence ?? 0),
    status: String(row.status),
  }));
}

export async function countCandidates(db: Client): Promise<Record<string, number>> {
  const rows = (await db.execute(
    'SELECT status, COUNT(*) AS n FROM transcript_candidates GROUP BY status',
  )).rows;
  const counts: Record<string, number> = {};
  for (const row of rows) counts[String(row.status)] = Number(row.n ?? 0);
  return counts;
}

/** The atom a staged row becomes, with its origin attached as evidence. */
export function candidateToAtom(candidate: ExtractionCandidate, tags: string[] | null): KnowledgeAtom {
  return {
    category: candidate.category as KnowledgeAtom['category'],
    title: candidate.title,
    content: candidate.content,
    tags,
    confidence: candidate.confidence,
    // Distilled by a model from a conversation nobody re-read at approval time. That is inferred,
    // and claiming `observed` would rank this above knowledge somebody actually verified.
    provenance: 'inferred',
    source: `transcript:${candidate.harness}:${candidate.sessionId}`,
  };
}
