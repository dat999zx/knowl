import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NormalizedHostHook } from '../../src/cli/agents/host-hook.js';
import { closeDb, getClient, initDb } from '../../src/store/database.js';
import { handleHostLifecycleEvent } from '../../src/store/host-lifecycle.js';
import * as repo from '../../src/store/repository.js';

const ROOT = path.resolve('.knowl-host-lifecycle-test');

const hook = (input: Partial<NormalizedHostHook>): NormalizedHostHook => ({
  host: 'generic',
  event: 'turn-start',
  externalSessionId: 'external-session',
  externalTurnId: 'turn-1',
  projectRoot: ROOT,
  payload: {},
  ...input,
});

describe('host lifecycle orchestration', () => {
  let projectId = '';

  beforeAll(async () => {
    await fs.rm(ROOT, { recursive: true, force: true });
    await fs.mkdir(path.join(ROOT, '.knowl'), { recursive: true });
    await initDb(ROOT);
    projectId = (await repo.createProject(ROOT, 'Host lifecycle')).id;
    await repo.createKnowledgeItem(projectId, {
      category: 'decision',
      title: 'Use local memory',
      content: 'Knowl stores project memory locally.',
    });
  });

  afterAll(async () => {
    await closeDb();
    await fs.rm(ROOT, { recursive: true, force: true }).catch(() => {});
  });

  it('bootstraps bounded context at host session start', async () => {
    const result = await handleHostLifecycleEvent(projectId, hook({
      host: 'codex',
      event: 'session-start',
      externalSessionId: 'codex-session',
      externalTurnId: undefined,
      title: 'Agent session',
    }));

    expect(result).toMatchObject({ accepted: true, sessionId: expect.any(String) });
    expect(result.context).toContain('Use local memory');
    expect(result.context!.length).toBeLessThanOrEqual(6_000);
    expect(result.hostOutput).toEqual({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: result.context,
      },
    });
  });

  it('captures a turn, finalizes candidates, and drops duplicate stops', async () => {
    const start = await handleHostLifecycleEvent(projectId, hook({ title: 'Agent turn' }));
    const event = await handleHostLifecycleEvent(projectId, hook({
      event: 'session-event',
      type: 'command',
      payload: { command: 'npm test', exitCode: 0, stdout: 'discard me' },
    }));
    const stop = await handleHostLifecycleEvent(projectId, hook({
      event: 'turn-stop',
      status: 'finished',
      payload: { status: 'finished' },
    }));
    const duplicate = await handleHostLifecycleEvent(projectId, hook({
      event: 'turn-stop',
      status: 'finished',
      payload: { status: 'finished' },
    }));

    expect(event.sessionId).toBe(start.sessionId);
    expect(stop).toMatchObject({ accepted: true, sessionId: start.sessionId, promotion: { candidateCount: 1 } });
    expect(duplicate).toEqual({ accepted: false, reason: 'event-loss' });
    const rows = await getClient().execute({ sql: 'SELECT payload FROM memory_session_events WHERE session_id = ? AND type = ?', args: [start.sessionId!, 'command'] });
    expect(String(rows.rows[0].payload)).not.toContain('discard me');
  });

  it('records bounded checkpoints before compaction', async () => {
    const start = await handleHostLifecycleEvent(projectId, hook({ externalTurnId: 'turn-2', title: 'Compaction turn' }));
    const checkpoint = await handleHostLifecycleEvent(projectId, hook({
      externalTurnId: 'turn-2',
      event: 'checkpoint',
      type: 'checkpoint',
      payload: { summary: 'Current task state', changedPaths: ['src/auth.ts'] },
    }));

    expect(checkpoint.sessionId).toBe(start.sessionId);
    const rows = await getClient().execute({ sql: 'SELECT payload FROM memory_session_events WHERE session_id = ? AND type = ?', args: [start.sessionId!, 'checkpoint'] });
    expect(JSON.parse(String(rows.rows[0].payload))).toEqual({ summary: 'Current task state', changedPaths: ['src/auth.ts'] });
  });
});
