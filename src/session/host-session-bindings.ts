import path from 'node:path';
import { canonicalProjectRoot } from '../core/project-path.js';
import { validateKnowledgeWrite } from '../core/knowledge-validation.js';
import { MemorySession } from '../core/types.js';
import { HookHost } from '../core/host-hook-types.js';
import { getClient } from '../store/database.js';
import { readCommitHead } from '../store/change-watermark.js';
import { bootstrapAgentSession } from '../store/context-bootstrap.js';
import { getMemorySession } from '../store/session-repository.js';

export type HostSessionKey = {
  projectRoot: string;
  host: HookHost | string;
  externalSessionId: string;
  externalTurnId?: string;
};

export type HostSessionInput = HostSessionKey & {
  projectId: string;
  title: string;
  query?: string;
  includeContext?: boolean;
};

const normalizedKey = (input: HostSessionKey) => ({
  host: input.host,
  projectRoot: canonicalProjectRoot(input.projectRoot),
  externalSessionId: input.externalSessionId.slice(0, 2_000),
  externalTurnId: (input.externalTurnId ?? '').slice(0, 2_000),
});

export async function findHostSession(input: HostSessionKey): Promise<MemorySession | null> {
  const key = normalizedKey(input);
  const row = (await getClient().execute({
    sql: `SELECT memory_session_id FROM host_session_bindings
      WHERE host = ? AND project_root = ? AND external_session_id = ? AND external_turn_id = ? AND active = 1`,
    args: [key.host, key.projectRoot, key.externalSessionId, key.externalTurnId],
  })).rows[0];
  if (!row) return null;
  try {
    const session = await getMemorySession(String(row.memory_session_id));
    if (session.status === 'active') return session;
  } catch {
    // A deleted or terminal session invalidates the binding below.
  }
  await closeHostSessionBinding(input);
  return null;
}

export async function getOrCreateHostSession(input: HostSessionInput) {
  validateKnowledgeWrite({ title: input.title, content: input.query });
  const existing = await findHostSession(input);
  if (existing) {
    const bootstrap = await bootstrapAgentSession({
      projectId: input.projectId,
      title: input.title,
      query: input.query,
      agent: String(input.host),
      sessionId: existing.id,
    }, { includeContext: input.includeContext });
    return { ...bootstrap, created: false };
  }

  const key = normalizedKey(input);
  const bootstrap = await bootstrapAgentSession({
    projectId: input.projectId,
    title: input.title,
    query: input.query,
    agent: String(input.host),
  }, { includeContext: input.includeContext });
  await bindHostSession(input, bootstrap.session.id);
  return { ...bootstrap, created: true };
}

export async function bindHostSession(input: HostSessionKey, memorySessionId: string): Promise<void> {
  const key = normalizedKey(input);
  const now = new Date().toISOString();
  // Seed the watermark at head so a brand-new row never reports the entire
  // commit history as "changed since you last looked".
  const head = await readCommitHead();
  await getClient().execute({
    sql: `INSERT INTO host_session_bindings
      (host, project_root, external_session_id, external_turn_id, memory_session_id, active, successful_tool_count, seen_commit_rowid, seen_commit_initialized, updated_at)
      VALUES (?, ?, ?, ?, ?, 1, 0, ?, 1, ?)
      ON CONFLICT (host, project_root, external_session_id, external_turn_id)
      DO UPDATE SET memory_session_id = excluded.memory_session_id, active = 1, successful_tool_count = 0,
        seen_commit_rowid = excluded.seen_commit_rowid, seen_commit_initialized = 1,
        seen_peer_commits = NULL, updated_at = excluded.updated_at`,
    args: [key.host, key.projectRoot, key.externalSessionId, key.externalTurnId, memorySessionId, head, now],
  });
}

export async function incrementHostSuccessfulToolCount(input: HostSessionKey): Promise<number> {
  const key = normalizedKey(input);
  const row = (await getClient().execute({
    sql: `UPDATE host_session_bindings
      SET successful_tool_count = successful_tool_count + 1, updated_at = ?
      WHERE host = ? AND project_root = ? AND external_session_id = ? AND external_turn_id = ? AND active = 1
      RETURNING successful_tool_count`,
    args: [new Date().toISOString(), key.host, key.projectRoot, key.externalSessionId, key.externalTurnId],
  })).rows[0];
  return row ? Number(row.successful_tool_count) : 0;
}

// Reset the drift counter — called when the agent actually uses a Knowl tool, so
// the continuation reminder only fires after a stretch of ignoring memory.
export async function resetHostSuccessfulToolCount(input: HostSessionKey): Promise<void> {
  const key = normalizedKey(input);
  await getClient().execute({
    sql: `UPDATE host_session_bindings SET successful_tool_count = 0, updated_at = ?
      WHERE host = ? AND project_root = ? AND external_session_id = ? AND external_turn_id = ? AND active = 1`,
    args: [new Date().toISOString(), key.host, key.projectRoot, key.externalSessionId, key.externalTurnId],
  });
}

export async function readHostSeenCommit(input: HostSessionKey): Promise<number | null> {
  const key = normalizedKey(input);
  const row = (await getClient().execute({
    sql: `SELECT seen_commit_rowid FROM host_session_bindings
      WHERE host = ? AND project_root = ? AND external_session_id = ? AND external_turn_id = ? AND active = 1`,
    args: [key.host, key.projectRoot, key.externalSessionId, key.externalTurnId],
  })).rows[0];
  return row ? Number(row.seen_commit_rowid) : null;
}

/**
 * The watermark and whether it has ever been set.
 *
 * `seen` alone cannot answer the question: 0 is both "bound against a repo with no commit
 * history" and "row predates the watermark column", and those need opposite handling --
 * the first must report its next commit, the second must not replay everything.
 */
export async function readHostWatermark(
  input: HostSessionKey,
): Promise<{ seen: number; initialized: boolean } | null> {
  const key = normalizedKey(input);
  const row = (await getClient().execute({
    sql: `SELECT seen_commit_rowid, seen_commit_initialized FROM host_session_bindings
      WHERE host = ? AND project_root = ? AND external_session_id = ? AND external_turn_id = ? AND active = 1`,
    args: [key.host, key.projectRoot, key.externalSessionId, key.externalTurnId],
  })).rows[0];
  if (!row) return null;
  return { seen: Number(row.seen_commit_rowid), initialized: Number(row.seen_commit_initialized) === 1 };
}

/** Advancing the watermark also marks it initialized: the row now knows where it stands. */
export async function setHostSeenCommit(input: HostSessionKey, value: number): Promise<void> {
  const key = normalizedKey(input);
  await getClient().execute({
    sql: `UPDATE host_session_bindings SET seen_commit_rowid = ?, seen_commit_initialized = 1, updated_at = ?
      WHERE host = ? AND project_root = ? AND external_session_id = ? AND external_turn_id = ? AND active = 1`,
    args: [value, new Date().toISOString(), key.host, key.projectRoot, key.externalSessionId, key.externalTurnId],
  });
}

/**
 * Per-peer watermarks, or null when this binding has never looked at peers.
 *
 * Null and "peer absent from the map" mean the same thing and are handled the same way
 * by the caller: adopt that peer's head silently rather than replaying its history.
 */
export async function readHostSeenPeerCommits(input: HostSessionKey): Promise<Record<string, number> | null> {
  const key = normalizedKey(input);
  const row = (await getClient().execute({
    sql: `SELECT seen_peer_commits FROM host_session_bindings
      WHERE host = ? AND project_root = ? AND external_session_id = ? AND external_turn_id = ? AND active = 1`,
    args: [key.host, key.projectRoot, key.externalSessionId, key.externalTurnId],
  })).rows[0];
  if (!row || row.seen_peer_commits === null || row.seen_peer_commits === undefined) return null;
  try {
    const parsed = JSON.parse(String(row.seen_peer_commits));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const heads: Record<string, number> = {};
    for (const [name, value] of Object.entries(parsed)) {
      if (typeof value === 'number' && Number.isFinite(value)) heads[name] = value;
    }
    return heads;
  } catch {
    // Corrupt JSON re-seeds rather than throwing: a malformed watermark must not be able
    // to break every tool event for the rest of the session.
    return null;
  }
}

export async function setHostSeenPeerCommits(input: HostSessionKey, heads: Record<string, number>): Promise<void> {
  const key = normalizedKey(input);
  await getClient().execute({
    sql: `UPDATE host_session_bindings SET seen_peer_commits = ?, updated_at = ?
      WHERE host = ? AND project_root = ? AND external_session_id = ? AND external_turn_id = ? AND active = 1`,
    args: [JSON.stringify(heads), new Date().toISOString(), key.host, key.projectRoot, key.externalSessionId, key.externalTurnId],
  });
}

/**
 * Hosts with a live lifecycle binding on this project root.
 *
 * "Live" is active *and* recently touched, not merely active. A crashed session can leave
 * an active row behind indefinitely, and a caller using this to decide whether somebody
 * else is already delivering notifications would then stay silent forever. Every hook tool
 * event writes `updated_at`, so a real session keeps its row warm without any extra work.
 */
export async function listLiveHostBindings(projectRoot: string, since: string): Promise<string[]> {
  const rows = (await getClient().execute({
    sql: `SELECT DISTINCT host FROM host_session_bindings
      WHERE project_root = ? AND active = 1 AND updated_at >= ?`,
    args: [canonicalProjectRoot(projectRoot), since],
  })).rows;
  return rows.map(row => String(row.host));
}

export async function closeHostSessionBinding(input: HostSessionKey): Promise<boolean> {
  const key = normalizedKey(input);
  const result = await getClient().execute({
    sql: `UPDATE host_session_bindings SET active = 0, updated_at = ?
      WHERE host = ? AND project_root = ? AND external_session_id = ? AND external_turn_id = ? AND active = 1`,
    args: [new Date().toISOString(), key.host, key.projectRoot, key.externalSessionId, key.externalTurnId],
  });
  return Number(result.rowsAffected ?? 0) > 0;
}

export async function closeHostSessionBindings(input: Omit<HostSessionKey, 'externalTurnId'>): Promise<number> {
  const key = normalizedKey(input);
  const result = await getClient().execute({
    sql: `UPDATE host_session_bindings SET active = 0, updated_at = ?
      WHERE host = ? AND project_root = ? AND external_session_id = ? AND active = 1`,
    args: [new Date().toISOString(), key.host, key.projectRoot, key.externalSessionId],
  });
  return Number(result.rowsAffected ?? 0);
}

export async function closeInactiveHostSessionBindings(): Promise<number> {
  const result = await getClient().execute({
    sql: `UPDATE host_session_bindings SET active = 0, updated_at = ?
      WHERE active = 1 AND NOT EXISTS (
        SELECT 1 FROM memory_sessions
        WHERE memory_sessions.id = host_session_bindings.memory_session_id
          AND memory_sessions.status = 'active'
      )`,
    args: [new Date().toISOString()],
  });
  return Number(result.rowsAffected ?? 0);
}
