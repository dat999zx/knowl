import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createClient, type Client } from '@libsql/client';
import { knowlHome } from '../core/paths.js';
import { synchronousPragma } from '../core/sqlite-sync.js';
import { sameErrorHead } from './signature.js';

/**
 * Where the fleet lives: one database under the Knowl home, not inside any repo.
 *
 * The thing being recorded is "the agent sessions running on this machine", whatever host each
 * one runs under, and that is a machine-level fact in the same way a resume key is. Filed per
 * repo it would be invisible across the boundary that matters most: a session in `~/work/api`
 * upgrading the engine every session in `~/work/web` is standing on. Claude Code keeps its own
 * registry at the same level (`<config dir>/sessions/`) and no other host does, so this file is
 * both the half of the picture that registry does not carry -- what each session is doing,
 * which problem it has claimed, what it wrote this turn -- and the only record at all that a
 * Codex or Windsurf session exists.
 *
 * Deliberately not a set of project-store tables. That would have meant a migration level, a
 * schema pin, a snapshot policy and a federated read across every linked repo on every hook
 * event; here it is one small file every hook already knows how to find.
 */
export function fleetDbPath(): string {
  return path.join(knowlHome(), 'fleet.db');
}

const MAX_WRITES_PER_TURN = 20;
const MAX_ASK_CHARS = 240;
const MAX_SUMMARY_CHARS = 240;
const MAX_ERROR_CHARS = 200;
const MAX_CLAIM_FILES = 12;

/** How long a session row without an end mark still counts as one worth listing. */
export const FLEET_SESSION_RETENTION_HOURS = 7 * 24;

function schemaStatements(): string[] {
  return [
    // Twenty sessions may open this file at once, and each writes a few rows per tool event.
    // A concurrent writer waits rather than fails, as the resume and transcript stores do.
    'PRAGMA busy_timeout = 10000;',
    'PRAGMA journal_mode = WAL;',
    // See `synchronousPragma`. Everything here is re-derivable from the next event, so the
    // durability this trades away is worth less than in the knowledge store.
    synchronousPragma(),
    `CREATE TABLE IF NOT EXISTS fleet_sessions (
      host TEXT NOT NULL,
      session_id TEXT NOT NULL,
      project_root TEXT NOT NULL,
      repo TEXT NOT NULL,
      ask TEXT,
      summary TEXT,
      writes_json TEXT NOT NULL DEFAULT '[]',
      last_error TEXT,
      last_error_sig TEXT,
      last_error_at TEXT,
      turns INTEGER NOT NULL DEFAULT 0,
      turn_started_at TEXT,
      turn_ended_at TEXT,
      started_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      ended_at TEXT,
      PRIMARY KEY (host, session_id)
    );`,
    'CREATE INDEX IF NOT EXISTS idx_fleet_sessions_updated ON fleet_sessions(updated_at);',
    `CREATE TABLE IF NOT EXISTS fleet_claims (
      id TEXT PRIMARY KEY,
      host TEXT NOT NULL,
      session_id TEXT NOT NULL,
      project_root TEXT NOT NULL,
      repo TEXT NOT NULL,
      sig TEXT NOT NULL,
      head TEXT NOT NULL,
      machine_wide INTEGER NOT NULL DEFAULT 0,
      files_json TEXT NOT NULL DEFAULT '[]',
      started_at TEXT NOT NULL,
      touched_at TEXT NOT NULL,
      released_at TEXT
    );`,
    'CREATE INDEX IF NOT EXISTS idx_fleet_claims_open ON fleet_claims(released_at, sig);',
    'CREATE INDEX IF NOT EXISTS idx_fleet_claims_session ON fleet_claims(host, session_id, released_at);',
    // What has already been said, so it is not said twice. One row per (session, kind,
    // subject); `recordFleetCard` reads it as a claim-once latch and nothing else does.
    `CREATE TABLE IF NOT EXISTS fleet_cards (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      host TEXT NOT NULL,
      session_id TEXT NOT NULL,
      subject TEXT NOT NULL,
      shown_at TEXT NOT NULL
    );`,
    'CREATE INDEX IF NOT EXISTS idx_fleet_cards_subject ON fleet_cards(host, session_id, kind, subject);',
    `CREATE TABLE IF NOT EXISTS fleet_seen (
      host TEXT NOT NULL,
      session_id TEXT NOT NULL,
      other_session_id TEXT NOT NULL,
      seen_updated_at TEXT NOT NULL,
      PRIMARY KEY (host, session_id, other_session_id)
    );`,
  ];
}

const clients = new Map<string, Client>();

/** The shared fleet database, created on first use. */
export async function openFleetDb(): Promise<Client> {
  const resolved = fleetDbPath();
  const existing = clients.get(resolved);
  if (existing) return existing;

  await fs.mkdir(path.dirname(resolved), { recursive: true });
  const client = createClient({ url: `file:${resolved}` });
  try {
    for (const statement of schemaStatements()) await client.execute(statement);
  } catch (error) {
    await client.close();
    throw error;
  }
  clients.set(resolved, client);
  return client;
}

/** Drop the cached client so the next open reconnects. Tests need this on Windows. */
export async function closeFleetDb(): Promise<void> {
  const entries = [...clients.entries()];
  clients.clear();
  for (const [, client] of entries) {
    await client.execute('PRAGMA wal_checkpoint(TRUNCATE)').catch(() => {});
    client.close();
  }
}

const newId = (): string => crypto.randomUUID().replace(/-/g, '').slice(0, 16);
const now = (): string => new Date().toISOString();
const clip = (value: string | undefined | null, max: number): string | null =>
  value ? value.replace(/\s+/g, ' ').trim().slice(0, max) || null : null;

function parseList(raw: unknown): string[] {
  try {
    const parsed = JSON.parse(String(raw ?? '[]'));
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

export interface FleetSessionKey {
  host: string;
  sessionId: string;
}

export interface FleetSessionRow extends FleetSessionKey {
  projectRoot: string;
  repo: string;
  ask: string | null;
  summary: string | null;
  writes: string[];
  lastError: string | null;
  lastErrorSig: string | null;
  lastErrorAt: string | null;
  turns: number;
  turnStartedAt: string | null;
  turnEndedAt: string | null;
  startedAt: string;
  updatedAt: string;
  endedAt: string | null;
}

function toSessionRow(row: Record<string, unknown>): FleetSessionRow {
  return {
    host: String(row.host),
    sessionId: String(row.session_id),
    projectRoot: String(row.project_root),
    repo: String(row.repo),
    ask: row.ask ? String(row.ask) : null,
    summary: row.summary ? String(row.summary) : null,
    writes: parseList(row.writes_json),
    lastError: row.last_error ? String(row.last_error) : null,
    lastErrorSig: row.last_error_sig ? String(row.last_error_sig) : null,
    lastErrorAt: row.last_error_at ? String(row.last_error_at) : null,
    turns: Number(row.turns ?? 0),
    turnStartedAt: row.turn_started_at ? String(row.turn_started_at) : null,
    turnEndedAt: row.turn_ended_at ? String(row.turn_ended_at) : null,
    startedAt: String(row.started_at),
    updatedAt: String(row.updated_at),
    endedAt: row.ended_at ? String(row.ended_at) : null,
  };
}

/**
 * Make sure a session has a row, and mark it live.
 *
 * An upsert keyed on the host's own session id, so a session whose SessionStart was lost still
 * appears the moment any later event arrives -- the same recovery the host bindings do. A
 * resumed session gets its `ended_at` cleared rather than a second row: it is the same
 * conversation, and the host reuses the id.
 */
export async function touchFleetSession(input: FleetSessionKey & { projectRoot: string; repo: string }): Promise<void> {
  const stamp = now();
  await (await openFleetDb()).execute({
    sql: `INSERT INTO fleet_sessions (host, session_id, project_root, repo, started_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(host, session_id) DO UPDATE SET
            project_root = excluded.project_root, repo = excluded.repo, updated_at = excluded.updated_at, ended_at = NULL`,
    args: [input.host, input.sessionId, input.projectRoot, input.repo, stamp, stamp],
  });
}

export async function recordFleetTurnStart(input: FleetSessionKey & { ask?: string | null }): Promise<void> {
  const stamp = now();
  await (await openFleetDb()).execute({
    sql: `UPDATE fleet_sessions
          SET ask = COALESCE(?, ask), turns = turns + 1, turn_started_at = ?, turn_ended_at = NULL, updated_at = ?
          WHERE host = ? AND session_id = ?`,
    args: [clip(input.ask, MAX_ASK_CHARS), stamp, stamp, input.host, input.sessionId],
  });
}

/** Append a repo-relative path to this turn's writes. Bounded and deduplicated; the newest stays. */
export async function recordFleetWrite(input: FleetSessionKey & { paths: string[] }): Promise<string[]> {
  const db = await openFleetDb();
  const current = await db.execute({
    sql: 'SELECT writes_json FROM fleet_sessions WHERE host = ? AND session_id = ?',
    args: [input.host, input.sessionId],
  });
  if (current.rows.length === 0) return [];
  const merged = [...parseList(current.rows[0].writes_json)];
  for (const candidate of input.paths) {
    const index = merged.indexOf(candidate);
    if (index >= 0) merged.splice(index, 1);
    merged.push(candidate);
  }
  const writes = merged.slice(-MAX_WRITES_PER_TURN);
  await db.execute({
    sql: 'UPDATE fleet_sessions SET writes_json = ?, updated_at = ? WHERE host = ? AND session_id = ?',
    args: [JSON.stringify(writes), now(), input.host, input.sessionId],
  });
  return writes;
}

export async function recordFleetError(input: FleetSessionKey & { head: string; sig: string }): Promise<void> {
  const stamp = now();
  await (await openFleetDb()).execute({
    sql: `UPDATE fleet_sessions SET last_error = ?, last_error_sig = ?, last_error_at = ?, updated_at = ?
          WHERE host = ? AND session_id = ?`,
    args: [clip(input.head, MAX_ERROR_CHARS), input.sig, stamp, stamp, input.host, input.sessionId],
  });
}

/**
 * Close the turn: keep what the assistant said it did, and hand back the writes so the caller
 * can check them against other sessions' reads before they are cleared.
 */
export async function recordFleetTurnStop(input: FleetSessionKey & { summary?: string | null }): Promise<{ writes: string[] }> {
  const db = await openFleetDb();
  const current = await db.execute({
    sql: 'SELECT writes_json FROM fleet_sessions WHERE host = ? AND session_id = ?',
    args: [input.host, input.sessionId],
  });
  const writes = current.rows.length > 0 ? parseList(current.rows[0].writes_json) : [];
  const stamp = now();
  await db.execute({
    sql: `UPDATE fleet_sessions SET summary = COALESCE(?, summary), turn_ended_at = ?, writes_json = '[]', updated_at = ?
          WHERE host = ? AND session_id = ?`,
    args: [clip(input.summary, MAX_SUMMARY_CHARS), stamp, stamp, input.host, input.sessionId],
  });
  return { writes };
}

export async function endFleetSession(input: FleetSessionKey): Promise<void> {
  const stamp = now();
  const db = await openFleetDb();
  await db.execute({
    sql: 'UPDATE fleet_sessions SET ended_at = ?, updated_at = ? WHERE host = ? AND session_id = ?',
    args: [stamp, stamp, input.host, input.sessionId],
  });
  await db.execute({
    sql: 'UPDATE fleet_claims SET released_at = ? WHERE host = ? AND session_id = ? AND released_at IS NULL',
    args: [stamp, input.host, input.sessionId],
  });
}

export async function getFleetSession(input: FleetSessionKey): Promise<FleetSessionRow | null> {
  const rows = await (await openFleetDb()).execute({
    sql: 'SELECT * FROM fleet_sessions WHERE host = ? AND session_id = ?',
    args: [input.host, input.sessionId],
  });
  return rows.rows.length > 0 ? toSessionRow(rows.rows[0] as Record<string, unknown>) : null;
}

/**
 * Every session row that has not ended and was touched inside the retention window. The
 * caller joins these to the host's live registry; a row here is a claim of activity, not
 * proof of a process.
 */
export async function listFleetSessions(options: { sinceIso?: string } = {}): Promise<FleetSessionRow[]> {
  const since = options.sinceIso ?? new Date(Date.now() - FLEET_SESSION_RETENTION_HOURS * 3_600_000).toISOString();
  const rows = await (await openFleetDb()).execute({
    sql: 'SELECT * FROM fleet_sessions WHERE ended_at IS NULL AND updated_at >= ? ORDER BY updated_at DESC',
    args: [since],
  });
  return rows.rows.map(row => toSessionRow(row as Record<string, unknown>));
}

export interface FleetClaim {
  id: string;
  host: string;
  sessionId: string;
  projectRoot: string;
  repo: string;
  sig: string;
  head: string;
  machineWide: boolean;
  files: string[];
  startedAt: string;
  touchedAt: string;
  releasedAt: string | null;
}

function toClaim(row: Record<string, unknown>): FleetClaim {
  return {
    id: String(row.id),
    host: String(row.host),
    sessionId: String(row.session_id),
    projectRoot: String(row.project_root),
    repo: String(row.repo),
    sig: String(row.sig),
    head: String(row.head),
    machineWide: Number(row.machine_wide) === 1,
    files: parseList(row.files_json),
    startedAt: String(row.started_at),
    touchedAt: String(row.touched_at),
    releasedAt: row.released_at ? String(row.released_at) : null,
  };
}

/**
 * Record that a session is working on a problem: it saw this failure and then edited these
 * files. One open claim per (session, signature); a second sighting extends it rather than
 * duplicating it, and the files accumulate.
 */
export async function openFleetClaim(input: {
  host: string;
  sessionId: string;
  projectRoot: string;
  repo: string;
  sig: string;
  head: string;
  machineWide: boolean;
  files: string[];
}): Promise<FleetClaim> {
  const db = await openFleetDb();
  const stamp = now();
  const existing = await db.execute({
    sql: 'SELECT * FROM fleet_claims WHERE host = ? AND session_id = ? AND sig = ? AND released_at IS NULL LIMIT 1',
    args: [input.host, input.sessionId, input.sig],
  });
  if (existing.rows.length > 0) {
    const claim = toClaim(existing.rows[0] as Record<string, unknown>);
    const files = [...new Set([...claim.files, ...input.files])].slice(-MAX_CLAIM_FILES);
    await db.execute({
      sql: 'UPDATE fleet_claims SET files_json = ?, touched_at = ? WHERE id = ?',
      args: [JSON.stringify(files), stamp, claim.id],
    });
    return { ...claim, files, touchedAt: stamp };
  }
  const id = newId();
  const files = [...new Set(input.files)].slice(-MAX_CLAIM_FILES);
  await db.execute({
    sql: `INSERT INTO fleet_claims (id, host, session_id, project_root, repo, sig, head, machine_wide, files_json, started_at, touched_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [id, input.host, input.sessionId, input.projectRoot, input.repo, input.sig, clip(input.head, MAX_ERROR_CHARS) ?? input.sig, input.machineWide ? 1 : 0, JSON.stringify(files), stamp, stamp],
  });
  return {
    id, host: input.host, sessionId: input.sessionId, projectRoot: input.projectRoot, repo: input.repo,
    sig: input.sig, head: input.head, machineWide: input.machineWide, files, startedAt: stamp, touchedAt: stamp, releasedAt: null,
  };
}

export async function openFleetClaimsForSession(input: FleetSessionKey): Promise<FleetClaim[]> {
  const rows = await (await openFleetDb()).execute({
    sql: 'SELECT * FROM fleet_claims WHERE host = ? AND session_id = ? AND released_at IS NULL ORDER BY touched_at DESC',
    args: [input.host, input.sessionId],
  });
  return rows.rows.map(row => toClaim(row as Record<string, unknown>));
}

/**
 * Release claims a session is no longer working: every open one, or only those whose files
 * saw no edit this turn. The second form is what a turn boundary uses -- a session that edited
 * the claimed files this turn is still on the problem; one that moved on has let it go.
 */
export async function releaseFleetClaims(input: FleetSessionKey & { untouchedBy?: string[] }): Promise<number> {
  const db = await openFleetDb();
  const stamp = now();
  if (!input.untouchedBy) {
    const result = await db.execute({
      sql: 'UPDATE fleet_claims SET released_at = ? WHERE host = ? AND session_id = ? AND released_at IS NULL',
      args: [stamp, input.host, input.sessionId],
    });
    return Number(result.rowsAffected ?? 0);
  }
  const open = await openFleetClaimsForSession(input);
  const touched = new Set(input.untouchedBy);
  let released = 0;
  for (const claim of open) {
    if (claim.files.some(file => touched.has(file))) continue;
    await db.execute({ sql: 'UPDATE fleet_claims SET released_at = ? WHERE id = ?', args: [stamp, claim.id] });
    released += 1;
  }
  return released;
}

/**
 * Other sessions' open claims on the same problem.
 *
 * Exact signature first; failing that, a fuzzy match on the normalised head, which is what
 * catches the same failure phrased two ways. Scope is the repo unless the claim was marked
 * machine-wide -- an engine or hook failure hits every session on the box, a repo's own test
 * failure does not. The caller still has to check the claiming session is alive; this table
 * cannot know.
 */
export async function matchingFleetClaims(input: {
  sig: string;
  head: string;
  projectRoot: string;
  excludeSessionId: string;
}): Promise<FleetClaim[]> {
  const rows = await (await openFleetDb()).execute({
    sql: 'SELECT * FROM fleet_claims WHERE released_at IS NULL AND session_id != ? ORDER BY touched_at DESC LIMIT 200',
    args: [input.excludeSessionId],
  });
  const root = input.projectRoot.toLowerCase();
  return rows.rows
    .map(row => toClaim(row as Record<string, unknown>))
    .filter(claim => claim.machineWide || claim.projectRoot.toLowerCase() === root)
    .filter(claim => claim.sig === input.sig || sameErrorHead(claim.head, input.head));
}

export type FleetCardKind = 'same-problem' | 'shared-surface' | 'stale-read' | 'digest';

/**
 * Record a card, and say whether it is the first of its kind on this subject for this session.
 *
 * "First" is the claim-once rule every card here follows: the same problem, the same surface
 * or the same stale read is announced once per session, because a card that repeats is the
 * fatigue that teaches an agent to skip the channel. A shadowed card claims its subject exactly
 * like a shown one, so switching a repo from shadow to enforce does not replay what shadow
 * already decided.
 */
export async function recordFleetCard(input: {
  kind: FleetCardKind;
  host: string;
  sessionId: string;
  subject: string;
}): Promise<boolean> {
  const db = await openFleetDb();
  const existing = await db.execute({
    sql: 'SELECT id FROM fleet_cards WHERE host = ? AND session_id = ? AND kind = ? AND subject = ? LIMIT 1',
    args: [input.host, input.sessionId, input.kind, input.subject],
  });
  if (existing.rows.length > 0) return false;
  await db.execute({
    sql: 'INSERT INTO fleet_cards (id, kind, host, session_id, subject, shown_at) VALUES (?, ?, ?, ?, ?, ?)',
    args: [newId(), input.kind, input.host, input.sessionId, input.subject, now()],
  });
  return true;
}

export async function listFleetCards(input: FleetSessionKey & { limit?: number }): Promise<Array<{ kind: FleetCardKind; subject: string; shownAt: string }>> {
  const rows = await (await openFleetDb()).execute({
    sql: 'SELECT kind, subject, shown_at FROM fleet_cards WHERE host = ? AND session_id = ? ORDER BY shown_at DESC LIMIT ?',
    args: [input.host, input.sessionId, input.limit ?? 20],
  });
  return rows.rows.map(row => ({
    kind: String(row.kind) as FleetCardKind, subject: String(row.subject), shownAt: String(row.shown_at),
  }));
}

/** What this session last saw of each other session, for the per-turn delta digest. */
export async function readFleetSeen(input: FleetSessionKey): Promise<Map<string, string>> {
  const rows = await (await openFleetDb()).execute({
    sql: 'SELECT other_session_id, seen_updated_at FROM fleet_seen WHERE host = ? AND session_id = ?',
    args: [input.host, input.sessionId],
  });
  return new Map(rows.rows.map(row => [String(row.other_session_id), String(row.seen_updated_at)]));
}

export async function markFleetSeen(input: FleetSessionKey & { seen: Array<{ otherSessionId: string; updatedAt: string }> }): Promise<void> {
  if (input.seen.length === 0) return;
  const db = await openFleetDb();
  for (const entry of input.seen) {
    await db.execute({
      sql: `INSERT INTO fleet_seen (host, session_id, other_session_id, seen_updated_at) VALUES (?, ?, ?, ?)
            ON CONFLICT(host, session_id, other_session_id) DO UPDATE SET seen_updated_at = excluded.seen_updated_at`,
      args: [input.host, input.sessionId, entry.otherSessionId, entry.updatedAt],
    });
  }
}

/** Drop rows nobody will read again: ended or silent sessions past retention, and their claims, cards and watermarks. */
export async function sweepFleet(olderThanIso: string): Promise<number> {
  const db = await openFleetDb();
  const stale = await db.execute({
    sql: 'SELECT host, session_id FROM fleet_sessions WHERE updated_at < ?',
    args: [olderThanIso],
  });
  let removed = 0;
  for (const row of stale.rows) {
    const args = [String(row.host), String(row.session_id)];
    await db.execute({ sql: 'DELETE FROM fleet_claims WHERE host = ? AND session_id = ?', args });
    await db.execute({ sql: 'DELETE FROM fleet_cards WHERE host = ? AND session_id = ?', args });
    await db.execute({ sql: 'DELETE FROM fleet_seen WHERE host = ? AND session_id = ?', args });
    await db.execute({ sql: 'DELETE FROM fleet_sessions WHERE host = ? AND session_id = ?', args });
    removed += 1;
  }
  return removed;
}
