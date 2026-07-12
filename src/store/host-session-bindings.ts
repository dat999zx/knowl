import path from 'node:path';
import { validateKnowledgeWrite } from '../core/knowledge-validation.js';
import { MemorySession } from '../core/types.js';
import { HookHost } from '../cli/agents/host-hook.js';
import { getClient } from './database.js';
import { bootstrapAgentSession } from './context-bootstrap.js';
import { getMemorySession } from './session-repository.js';

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
  projectRoot: path.resolve(input.projectRoot),
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
  await getClient().execute({
    sql: `INSERT INTO host_session_bindings
      (host, project_root, external_session_id, external_turn_id, memory_session_id, active, updated_at)
      VALUES (?, ?, ?, ?, ?, 1, ?)
      ON CONFLICT (host, project_root, external_session_id, external_turn_id)
      DO UPDATE SET memory_session_id = excluded.memory_session_id, active = 1, updated_at = excluded.updated_at`,
    args: [key.host, key.projectRoot, key.externalSessionId, key.externalTurnId, memorySessionId, now],
  });
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
