import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createClient, type Client } from '@libsql/client';
import { synchronousPragma } from '../core/sqlite-sync.js';
import { validateKnowledgeWrite } from '../core/knowledge-validation.js';
import type { ProjectConfig } from '../core/types.js';
import { workspaceDir } from './paths.js';

/** Bump when a migration must run. Read and written as `PRAGMA user_version`. */
const SCHEMA_VERSION = 1;

/** Rows older than this are dropped when the ledger is opened. */
const RETENTION_DAYS = 90;

export type DemandKind = 'federated_query' | 'transcript_hit';

export type DemandEvent = {
  queryingRepo: string;
  kind: DemandKind;
  /** The raw query. Fingerprinted always; stored verbatim only if it passes the validators. */
  query: string;
  topScore?: number | null;
  servedRepo?: string | null;
  servedItemId?: string | null;
  detail?: Record<string, unknown> | null;
};

/**
 * Where one workspace records what its repos ask each other for.
 *
 * Beside the manifest rather than inside any member repo, for the same reason the manifest is:
 * a file in one repo makes that repo special and disappears when it is deleted. It is also the
 * only cross-repo channel this feature has -- it carries queries and scores, never content, so
 * nothing here can leak a peer's private atom into another repo's process.
 */
export function demandDbPath(workspaceName: string): string {
  return path.join(workspaceDir(workspaceName), 'demand.db');
}

function schemaStatements(): string[] {
  return [
    // Every Knowl process on this machine may write this file, and a query must never fail
    // because another one was mid-insert. Deliberately LOW, unlike resume.db's 10s: this is on
    // the response path, and a ledger write that blocks a query for ten seconds has inverted
    // the priority -- losing the row is the correct outcome, waiting is not.
    'PRAGMA busy_timeout = 250;',
    'PRAGMA journal_mode = WAL;',
    // See `synchronousPragma`. Demand is statistical; a row lost to a hard kill costs nothing
    // that the next query does not replace.
    synchronousPragma(),
    `CREATE TABLE IF NOT EXISTS demand_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at TEXT NOT NULL,
      querying_repo TEXT NOT NULL,
      kind TEXT NOT NULL,
      query_fingerprint TEXT NOT NULL,
      query_terms TEXT,
      top_score REAL,
      served_repo TEXT,
      served_item_id TEXT,
      detail TEXT
    );`,
    `CREATE TABLE IF NOT EXISTS demand_declines (
      item_id TEXT PRIMARY KEY,
      declined_at TEXT NOT NULL,
      reason TEXT
    );`,
  ];
}

/**
 * Indexes, applied only after the column guard has run.
 *
 * Not merged into `schemaStatements` even though `CREATE INDEX IF NOT EXISTS` looks equally
 * idempotent: an index names columns, and on a file written by a build that predates one of
 * them the statement fails outright -- so the open would throw on exactly the legacy file the
 * guard exists to repair, and the guard would never get to run. Ordering is the fix, not
 * tolerating the error.
 */
function indexStatements(): string[] {
  return [
    `CREATE INDEX IF NOT EXISTS idx_demand_events_at ON demand_events(at);`,
    `CREATE INDEX IF NOT EXISTS idx_demand_events_fingerprint ON demand_events(query_fingerprint);`,
    `CREATE INDEX IF NOT EXISTS idx_demand_events_served ON demand_events(served_repo, served_item_id);`,
  ];
}

/**
 * Add columns an older build's file is missing.
 *
 * Two builds write this file whenever a machine has a global CLI of one version and a repo
 * pinned to another, so `CREATE TABLE IF NOT EXISTS` alone is not a migration: it leaves an
 * older table in place and every insert naming a new column fails. Same guard shape as
 * `ensureEmbeddingProfileColumns` in the store's bootstrap.
 */
async function ensureDemandColumns(client: Client): Promise<void> {
  const columns = await client.execute('PRAGMA table_info(demand_events)');
  const present = new Set(columns.rows.map(row => String(row.name)));
  if (present.size === 0) return; // table absent: schemaStatements just created it
  for (const [name, type] of [
    ['query_terms', 'TEXT'],
    ['top_score', 'REAL'],
    ['served_repo', 'TEXT'],
    ['served_item_id', 'TEXT'],
    ['detail', 'TEXT'],
  ] as const) {
    if (!present.has(name)) await client.execute(`ALTER TABLE demand_events ADD COLUMN ${name} ${type};`);
  }
}

const clients = new Map<string, Client>();

/**
 * Open (and on first use create) a workspace's ledger.
 *
 * Never wrapped in `client.transaction()` anywhere in this file: the libSQL client's
 * transaction helper is the one this codebase has already been bitten by, and every write here
 * is a single statement that needs no atomicity across rows.
 */
export async function openDemandDb(workspaceName: string): Promise<Client> {
  const resolved = demandDbPath(workspaceName);
  const existing = clients.get(resolved);
  if (existing) return existing;

  await fs.mkdir(path.dirname(resolved), { recursive: true });
  const client = createClient({ url: `file:${resolved}` });
  try {
    for (const statement of schemaStatements()) await client.execute(statement);
    await ensureDemandColumns(client);
    for (const statement of indexStatements()) await client.execute(statement);
    await client.execute(`PRAGMA user_version = ${SCHEMA_VERSION};`);
    await pruneExpired(client);
  } catch (error) {
    // A partially bootstrapped client still holds whatever lock it took.
    await client.close();
    throw error;
  }

  clients.set(resolved, client);
  return client;
}

async function pruneExpired(client: Client): Promise<void> {
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  await client.execute({ sql: 'DELETE FROM demand_events WHERE at < ?', args: [cutoff] });
}

/**
 * The query text, if it is safe to keep.
 *
 * The fingerprint is always recorded and is enough to count repeat demand, but a *proposal*
 * has to be re-runnable against the owning repo's atoms, and a hash cannot be re-run. So the
 * terms are kept where they pass exactly the validators a knowledge write passes -- it would be
 * incoherent for this file to hold text the knowledge store next door would have refused, and
 * this file is less protected, not more: it sits in the workspace directory, outside any repo's
 * ignore rules.
 *
 * Failure resolves to `null`. Every path out of the validator that is not a clean pass means
 * "do not keep the text", including one that throws for a reason this code did not anticipate.
 */
function safeTerms(query: string, config?: ProjectConfig | null): string | null {
  try {
    // The query goes in `content`, which `stringFields` scans exactly as it scans a real
    // write's. `title` is a constant rather than the query repeated: the validators run over
    // every string field, so repeating it would only double the work to reach the same verdict.
    validateKnowledgeWrite(
      { title: 'demand', content: query },
      { rejectSecrets: config?.security?.rejectSecrets !== false, secretPatterns: config?.security?.secretPatterns ?? [] },
    );
    return query;
  } catch {
    return null;
  }
}

export function fingerprintQuery(query: string): string {
  // Normalised before hashing, so "Auth Token TTL" and "auth  token ttl" count as one question
  // being asked twice rather than as two questions asked once. Counting repeat demand is the
  // entire point of the fingerprint.
  const normalized = query.toLocaleLowerCase().replace(/\s+/g, ' ').trim();
  return crypto.createHash('sha256').update(normalized).digest('hex');
}

/**
 * Record one event. Never throws, never awaited on a response path.
 *
 * Best-effort is not laziness here. This runs after a query has already been answered, so the
 * only thing a failure can still affect is whether the caller gets their answer -- and a
 * telemetry file that can fail a query is strictly worse than no telemetry. The whole body is
 * inside the catch for that reason, including the open.
 */
export async function recordDemandEventBestEffort(
  workspaceName: string,
  event: DemandEvent,
  config?: ProjectConfig | null,
): Promise<void> {
  try {
    const client = await openDemandDb(workspaceName);
    await client.execute({
      sql: `INSERT INTO demand_events
        (at, querying_repo, kind, query_fingerprint, query_terms, top_score, served_repo, served_item_id, detail)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        new Date().toISOString(),
        event.queryingRepo,
        event.kind,
        fingerprintQuery(event.query),
        safeTerms(event.query, config),
        event.topScore ?? null,
        event.servedRepo ?? null,
        event.servedItemId ?? null,
        event.detail ? JSON.stringify(event.detail) : null,
      ],
    });
  } catch {
    // Deliberately silent. See the doc comment.
  }
}

export type DemandSummary = {
  total: number;
  byKind: Array<{ kind: string; count: number }>;
  byQueryingRepo: Array<{ repo: string; count: number }>;
  byServingRepo: Array<{ repo: string; count: number }>;
  /** Distinct questions, most-repeated first: the calibration readout. */
  topQuestions: Array<{ fingerprint: string; terms: string | null; count: number; bestScore: number | null }>;
  /** Where the scores actually fall, so a "weak query" predicate can be chosen from data. */
  scores: { withScore: number; min: number | null; median: number | null; max: number | null };
};

/** What the ledger has learned so far. Read-only; the report subcommand's whole body. */
export async function summarizeDemand(workspaceName: string, limit = 20): Promise<DemandSummary> {
  const client = await openDemandDb(workspaceName);
  const rows = async (sql: string) => (await client.execute(sql)).rows;

  const total = Number((await rows('SELECT COUNT(*) AS n FROM demand_events'))[0].n);
  const byKind = (await rows('SELECT kind, COUNT(*) AS n FROM demand_events GROUP BY kind ORDER BY n DESC'))
    .map(row => ({ kind: String(row.kind), count: Number(row.n) }));
  const byQueryingRepo = (await rows('SELECT querying_repo AS repo, COUNT(*) AS n FROM demand_events GROUP BY querying_repo ORDER BY n DESC'))
    .map(row => ({ repo: String(row.repo), count: Number(row.n) }));
  const byServingRepo = (await rows(
    'SELECT served_repo AS repo, COUNT(*) AS n FROM demand_events WHERE served_repo IS NOT NULL GROUP BY served_repo ORDER BY n DESC',
  )).map(row => ({ repo: String(row.repo), count: Number(row.n) }));

  const questions = await client.execute({
    sql: `SELECT query_fingerprint AS fp, MAX(query_terms) AS terms, COUNT(*) AS n, MAX(top_score) AS best
          FROM demand_events GROUP BY query_fingerprint ORDER BY n DESC, fp ASC LIMIT ?`,
    args: [limit],
  });

  const scored = (await rows('SELECT top_score FROM demand_events WHERE top_score IS NOT NULL ORDER BY top_score'))
    .map(row => Number(row.top_score));

  return {
    total,
    byKind,
    byQueryingRepo,
    byServingRepo,
    topQuestions: questions.rows.map(row => ({
      fingerprint: String(row.fp),
      terms: row.terms === null ? null : String(row.terms),
      count: Number(row.n),
      bestScore: row.best === null ? null : Number(row.best),
    })),
    scores: {
      withScore: scored.length,
      min: scored.length ? scored[0] : null,
      median: scored.length ? scored[Math.floor(scored.length / 2)] : null,
      max: scored.length ? scored[scored.length - 1] : null,
    },
  };
}

/** Drop cached clients so the next open reconnects. Tests need this on Windows. */
export async function closeDemandDb(): Promise<void> {
  const entries = [...clients.entries()];
  clients.clear();
  for (const [, client] of entries) {
    await client.execute('PRAGMA wal_checkpoint(TRUNCATE)').catch(() => {});
    client.close();
  }
}
