import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { closeDb, getDb, initDb } from '../../src/store/database.js';
import {
  appendMemorySessionEvent, finishMemorySession, heartbeatMemorySession, listActiveMemorySessions,
  purgeExpiredSessionEvents, recoverAbandonedSessions, startMemorySession,
} from '../../src/store/session-repository.js';

const TEST_ROOT = path.resolve('./.knowl-session-repository-test');

describe('memory session repository', () => {
  beforeAll(async () => {
    await fs.rm(TEST_ROOT, { recursive: true, force: true });
    await fs.mkdir(path.join(TEST_ROOT, '.knowl'), { recursive: true });
    await initDb(TEST_ROOT);
  });
  beforeEach(async () => {
    const db = getDb() as any;
    await db.run(sql`DELETE FROM memory_session_events`);
    await db.run(sql`DELETE FROM memory_sessions`);
  });
  afterAll(async () => { await closeDb(); await fs.rm(TEST_ROOT, { recursive: true, force: true }).catch(() => {}); });

  it('runs bounded session lifecycle and rejects terminal events', async () => {
    const session = await startMemorySession({ title: 'Implement sessions', query: 'session recovery', agent: 'codex' });
    const heartbeat = await heartbeatMemorySession(session.id);
    const event = await appendMemorySessionEvent(session.id, 'command', { command: 'npm test', exitCode: 0, stdout: 'ignored raw output' });
    const finished = await finishMemorySession(session.id, 'finished', 'Tests passed.');

    expect(heartbeat.status).toBe('active');
    expect(event.payload).toEqual({ command: 'npm test', exitCode: 0 });
    expect(finished.status).toBe('finished');
    await expect(appendMemorySessionEvent(session.id, 'error', { code: 'LATE' })).rejects.toThrow('terminal');
  });

  it('recovers stale active sessions and purges expired events', async () => {
    const session = await startMemorySession({ title: 'Recover session' });
    await appendMemorySessionEvent(session.id, 'checkpoint', { summary: 'Temporary state' });
    const db = getDb() as any;
    await db.run(sql`UPDATE memory_sessions SET last_heartbeat_at = '2020-01-01T00:00:00.000Z' WHERE id = ${session.id}`);
    await db.run(sql`UPDATE memory_session_events SET expires_at = '2020-01-01T00:00:00.000Z' WHERE session_id = ${session.id}`);

    expect(await recoverAbandonedSessions('2026-01-01T00:00:00.000Z')).toEqual([expect.objectContaining({ id: session.id, status: 'recovered' })]);
    expect(await purgeExpiredSessionEvents('2026-01-01T00:00:00.000Z')).toBe(2);
    expect(await listActiveMemorySessions()).toEqual([]);
  });
});
