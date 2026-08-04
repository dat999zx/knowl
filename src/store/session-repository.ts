import crypto from 'node:crypto';
import { MemorySession, MemorySessionEvent, SessionEventType, SessionStatus } from '../core/types.js';
import { validateKnowledgeWrite } from '../core/knowledge-validation.js';
import { getClient } from './database.js';

const HOUR = 60 * 60 * 1000;
const EVENT_TTL_HOURS = 48;
const SESSION_TTL_HOURS = 7 * 24;
const ABANDONED_AFTER_HOURS = 2;

const id = () => crypto.randomUUID().replace(/-/g, '').slice(0, 16);
const plusHours = (now: string, hours: number) => new Date(new Date(now).getTime() + hours * HOUR).toISOString();
const mapSession = (row: any): MemorySession => ({ id: String(row.id), agent: row.agent ? String(row.agent) : null, title: String(row.title), query: row.query ? String(row.query) : null, status: row.status as SessionStatus, startedAt: String(row.started_at), lastHeartbeatAt: String(row.last_heartbeat_at), finishedAt: row.finished_at ? String(row.finished_at) : null, baselineCommit: row.baseline_commit ? String(row.baseline_commit) : null, expiresAt: String(row.expires_at) });
const mapEvent = (row: any): MemorySessionEvent => ({ id: String(row.id), sessionId: String(row.session_id), type: row.type as SessionEventType, payload: JSON.parse(String(row.payload)), observedAt: String(row.observed_at), expiresAt: String(row.expires_at) });

export async function getMemorySession(id: string): Promise<MemorySession> {
  const row = (await getClient().execute({ sql: 'SELECT * FROM memory_sessions WHERE id = ?', args: [id] })).rows[0];
  if (!row) throw new Error(`Memory session not found: ${id}`);
  return mapSession(row);
}

export async function startMemorySession(input: { title: string; query?: string; agent?: string; ttlHours?: number }): Promise<MemorySession> {
  validateKnowledgeWrite({ title: input.title, content: input.query });
  // Both columns are nullable and both inputs optional; absent becomes null once, here, so
  // what is bound is a value the driver accepts -- it refuses undefined rather than
  // storing NULL for it.
  const agent = input.agent ?? null; const query = input.query ?? null;
  const now = new Date().toISOString(); const session: MemorySession = { id: id(), agent, title: input.title, query, status: 'active', startedAt: now, lastHeartbeatAt: now, finishedAt: null, baselineCommit: null, expiresAt: plusHours(now, input.ttlHours ?? SESSION_TTL_HOURS) };
  const client = getClient();
  await client.execute({ sql: 'INSERT INTO memory_sessions (id, agent, title, query, status, started_at, last_heartbeat_at, finished_at, baseline_commit, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', args: [session.id, agent, session.title, query, session.status, session.startedAt, session.lastHeartbeatAt, null, null, session.expiresAt] });
  await appendMemorySessionEvent(session.id, 'start', { title: input.title, agent: input.agent });
  return session;
}

export async function heartbeatMemorySession(sessionId: string): Promise<MemorySession> {
  const session = await getMemorySession(sessionId); if (session.status !== 'active') throw new Error('Cannot heartbeat a terminal memory session.');
  const now = new Date().toISOString(); await getClient().execute({ sql: 'UPDATE memory_sessions SET last_heartbeat_at = ? WHERE id = ?', args: [now, sessionId] });
  return { ...session, lastHeartbeatAt: now };
}

export async function appendMemorySessionEvent(sessionId: string, type: SessionEventType, payload: Record<string, unknown>): Promise<MemorySessionEvent> {
  const session = await getMemorySession(sessionId); if (session.status !== 'active') throw new Error('Cannot append an event to a terminal memory session.');
  const safePayload = Object.fromEntries(Object.entries(payload).filter(([key]) => key !== 'stdout' && key !== 'stderr'));
  const serialized = JSON.stringify(safePayload); validateKnowledgeWrite({ content: serialized });
  if (serialized.length > 4_000) throw new Error('Memory session event payload exceeds the allowed length.');
  const now = new Date().toISOString(); const event: MemorySessionEvent = { id: id(), sessionId, type, payload: safePayload, observedAt: now, expiresAt: plusHours(now, EVENT_TTL_HOURS) };
  await getClient().execute({ sql: 'INSERT INTO memory_session_events (id, session_id, type, payload, observed_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)', args: [event.id, sessionId, type, serialized, event.observedAt, event.expiresAt] });
  return event;
}

export async function finishMemorySession(sessionId: string, status: 'finished' | 'failed', summary?: string): Promise<MemorySession> {
  const session = await getMemorySession(sessionId); if (session.status !== 'active') return session;
  validateKnowledgeWrite({ content: summary }); const now = new Date().toISOString();
  await getClient().execute({ sql: 'UPDATE memory_sessions SET status = ?, finished_at = ?, last_heartbeat_at = ? WHERE id = ?', args: [status, now, now, sessionId] });
  await getClient().execute({ sql: 'INSERT INTO memory_session_events (id, session_id, type, payload, observed_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)', args: [id(), sessionId, 'stop', JSON.stringify({ status, summary: summary ?? null }), now, plusHours(now, EVENT_TTL_HOURS)] });
  return { ...session, status, finishedAt: now, lastHeartbeatAt: now };
}

export async function listActiveMemorySessions(): Promise<MemorySession[]> { const rows = await getClient().execute("SELECT * FROM memory_sessions WHERE status = 'active' ORDER BY started_at"); return rows.rows.map(mapSession); }
export async function recoverAbandonedSessions(now = new Date().toISOString()): Promise<MemorySession[]> { const cutoff = plusHours(now, -ABANDONED_AFTER_HOURS); const active = await getClient().execute({ sql: "SELECT * FROM memory_sessions WHERE status = 'active' AND last_heartbeat_at < ?", args: [cutoff] }); const recovered: MemorySession[] = []; for (const row of active.rows) { const session = mapSession(row); await getClient().execute({ sql: 'UPDATE memory_sessions SET status = ?, finished_at = ? WHERE id = ?', args: ['recovered', now, session.id] }); await getClient().execute({ sql: 'INSERT INTO memory_session_events (id, session_id, type, payload, observed_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)', args: [id(), session.id, 'stop', JSON.stringify({ status: 'recovered' }), now, plusHours(now, EVENT_TTL_HOURS)] }); recovered.push({ ...session, status: 'recovered', finishedAt: now }); } return recovered; }
export async function purgeExpiredSessionEvents(now = new Date().toISOString()): Promise<number> { const result = await getClient().execute({ sql: 'DELETE FROM memory_session_events WHERE expires_at <= ?', args: [now] }); return Number(result.rowsAffected ?? 0); }
