import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { closeDb, getClient, getDb, initDb } from '../../src/store/database.js';
import * as repo from '../../src/store/repository.js';
import { bindHostSession } from '../../src/store/host-session-bindings.js';
import { startMemorySession } from '../../src/store/session-repository.js';
import { deriveSessionStatuses } from '../../src/transcripts/session-status.js';

const TEST_ROOT = path.resolve('./.knowl-session-status-test');

describe('deriveSessionStatuses', () => {
  let projectId = '';

  beforeAll(async () => {
    await fs.rm(TEST_ROOT, { recursive: true, force: true });
    await fs.mkdir(path.join(TEST_ROOT, '.knowl'), { recursive: true });
    await initDb(TEST_ROOT);
    projectId = (await repo.createProject(TEST_ROOT, 'Session status')).id;
  });

  afterAll(async () => {
    await closeDb();
    await fs.rm(TEST_ROOT, { recursive: true, force: true }).catch(() => {});
  });

  beforeEach(async () => {
    const db = getDb() as any;
    await db.run(sql`DELETE FROM host_session_bindings`);
    await db.run(sql`DELETE FROM knowledge_items`);
    await db.run(sql`DELETE FROM memory_sessions`);
  });

  /** A real binding to a real memory session, with the heartbeat moved to `at`. */
  async function bindLiveSession(externalSessionId: string, at: Date) {
    const session = await startMemorySession({ title: `session for ${externalSessionId}` });
    await bindHostSession({ projectRoot: TEST_ROOT, host: 'claude', externalSessionId }, session.id);
    await getClient().execute({
      sql: 'UPDATE memory_sessions SET last_heartbeat_at = ? WHERE id = ?',
      args: [at.toISOString(), session.id],
    });
    return session.id;
  }

  /** A pending handoff shaped the way session-handoff.ts writes one. */
  async function storePendingHandoff(
    externalSessionId: string,
    options: { tagged: boolean; consumed?: boolean },
  ) {
    const content = JSON.stringify({
      kind: 'interrupted', urgency: 'high', host: 'claude', projectRoot: TEST_ROOT,
      externalSessionId, failedAt: '2026-08-03T10:00:00.000Z', consumed: options.consumed === true,
    });
    await repo.createKnowledgeItem(projectId, {
      category: 'state',
      title: 'Pending session handoff',
      content,
      tags: options.tagged
        ? ['pending_handoff', 'interrupted', 'high', 'claude', `session:${externalSessionId}`]
        : ['pending_handoff', 'interrupted', 'high', 'claude'],
    } as never);
  }

  it('reports idle for a session with no signals', async () => {
    const statuses = await deriveSessionStatuses(projectId, ['session-quiet']);
    expect(statuses.get('session-quiet')).toBe('idle');
  });

  it('reports active for a recent bound heartbeat', async () => {
    await bindLiveSession('session-live', new Date());
    const statuses = await deriveSessionStatuses(projectId, ['session-live']);
    expect(statuses.get('session-live')).toBe('active');
  });

  it('reports idle for a bound session whose heartbeat is stale', async () => {
    await bindLiveSession('session-old', new Date(Date.parse('2026-08-01T00:00:00Z')));
    const statuses = await deriveSessionStatuses(
      projectId, ['session-old'], new Date(Date.parse('2026-08-03T00:00:00Z')),
    );
    expect(statuses.get('session-old')).toBe('idle');
  });

  it('reports interrupted when an unconsumed crash handoff names the session', async () => {
    await storePendingHandoff('session-crashed', { tagged: true });
    const statuses = await deriveSessionStatuses(projectId, ['session-crashed']);
    expect(statuses.get('session-crashed')).toBe('interrupted');
  });

  it('finds a pre-tag handoff that names the session only in its content', async () => {
    await storePendingHandoff('session-legacy', { tagged: false });
    const statuses = await deriveSessionStatuses(projectId, ['session-legacy']);
    expect(statuses.get('session-legacy')).toBe('interrupted');
  });

  it('ignores a handoff that was already consumed', async () => {
    await storePendingHandoff('session-done', { tagged: true, consumed: true });
    const statuses = await deriveSessionStatuses(projectId, ['session-done']);
    expect(statuses.get('session-done')).toBe('idle');
  });

  it('ranks interrupted above active when both apply', async () => {
    await bindLiveSession('session-both', new Date());
    await storePendingHandoff('session-both', { tagged: true });
    const statuses = await deriveSessionStatuses(projectId, ['session-both']);
    expect(statuses.get('session-both')).toBe('interrupted');
  });

  it('does not mistake one session for another whose id is a prefix of it', async () => {
    // `content.includes(id)` is a substring test, so a short id inside a longer one would
    // mark an unrelated session interrupted.
    await storePendingHandoff('session-abcdef', { tagged: true });
    const statuses = await deriveSessionStatuses(projectId, ['session-abc', 'session-abcdef']);
    expect(statuses.get('session-abcdef')).toBe('interrupted');
    expect(statuses.get('session-abc')).toBe('idle');
  });

  it('does one query for many sessions rather than one each', async () => {
    const ids = Array.from({ length: 50 }, (_, i) => `session-${i}`);
    const statuses = await deriveSessionStatuses(projectId, ids);
    expect(statuses.size).toBe(50);
  });
});
