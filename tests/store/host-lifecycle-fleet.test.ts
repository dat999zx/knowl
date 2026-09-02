import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NormalizedHostHook } from '../../src/core/host-hook-types.js';
import { closeDb, initDb } from '../../src/store/database.js';
import * as repo from '../../src/store/repository.js';
import { handleHostLifecycleEvent } from '../../src/session/host-lifecycle.js';
import { fleetTurnStartBestEffort } from '../../src/session/fleet-lifecycle.js';
import { closeFleetDb, getFleetSession, listFleetCards, openFleetClaimsForSession } from '../../src/fleet/store.js';

/**
 * Two Claude Code sessions in one repo, seen through the hooks. The host's registry is faked
 * with two records that both name this process's pid, so both count as alive; everything else
 * is the real lifecycle against a real store.
 */
const ROOT = path.resolve('.knowl-host-lifecycle-fleet-test');
const HOME = path.join(ROOT, 'knowl-home');
const CONFIG_DIR = path.join(ROOT, 'claude-config');
const previous = {
  KNOWL_HOME: process.env.KNOWL_HOME,
  CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
  KNOWL_CLAUDE_CONFIG_DIRS: process.env.KNOWL_CLAUDE_CONFIG_DIRS,
};

let projectId = '';

const A = 'session-a';
const B = 'session-b';

const hook = (input: Partial<NormalizedHostHook> & { externalSessionId: string }): NormalizedHostHook => ({
  host: 'claude',
  event: 'session-event',
  projectRoot: ROOT,
  payload: {},
  ...input,
});

const registryRecord = (sessionId: string, name: string) => JSON.stringify({
  pid: process.pid, sessionId, cwd: ROOT, startedAt: Date.now() - 600_000, name, kind: 'interactive', version: '2.1.257',
});

const additionalContext = (result: { hostOutput?: Record<string, unknown> }): string | undefined =>
  (result.hostOutput?.hookSpecificOutput as { additionalContext?: string } | undefined)?.additionalContext;

beforeAll(async () => {
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(path.join(ROOT, '.knowl'), { recursive: true });
  fs.mkdirSync(path.join(ROOT, 'src'), { recursive: true });
  fs.mkdirSync(path.join(CONFIG_DIR, 'sessions'), { recursive: true });
  fs.writeFileSync(path.join(CONFIG_DIR, 'sessions', '1.json'), registryRecord(A, 'test-a'));
  fs.writeFileSync(path.join(CONFIG_DIR, 'sessions', '2.json'), registryRecord(B, 'test-b'));
  fs.writeFileSync(path.join(ROOT, 'src', 'x.ts'), 'export const x = 1;\n');
  fs.writeFileSync(path.join(ROOT, '.knowl', 'config.json'), JSON.stringify({
    version: 1,
    workspace: { workspace: 'test', repo: 'test-repo' },
    impact: { enabled: true, gate: 'off' },
    fleet: { cards: 'enforce', nudge: 'enforce', digest: 'on' },
  }));
  process.env.KNOWL_HOME = HOME;
  process.env.CLAUDE_CONFIG_DIR = CONFIG_DIR;
  // Only the faked registry: without this the roster would also list whatever real sessions
  // are running on the developer's machine, and the counts below would depend on them.
  process.env.KNOWL_CLAUDE_CONFIG_DIRS = CONFIG_DIR;
  await initDb(ROOT);
  projectId = (await repo.createProject(ROOT, 'Fleet lifecycle')).id;
});

afterAll(async () => {
  await closeFleetDb();
  await closeDb();
  for (const key of ['KNOWL_HOME', 'CLAUDE_CONFIG_DIR', 'KNOWL_CLAUDE_CONFIG_DIRS'] as const) {
    if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
  }
  try { fs.rmSync(ROOT, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* swept by the global teardown */ }
});

describe('fleet through the lifecycle', () => {
  it('names the other live session on the SessionStart card', async () => {
    // B starts first. The host registry already lists A's process, so A appears -- under its
    // folder name, because Knowl has heard nothing from it yet.
    const first = await handleHostLifecycleEvent(projectId, hook({ event: 'session-start', externalSessionId: B, title: 'Agent session' }));
    expect(first.accepted).toBe(true);
    expect(first.context).toContain('LIVE SESSIONS (1 other Claude Code session on this machine)');
    expect(first.context).toContain(path.basename(ROOT));
    expect(first.context).toContain('test-a');
    expect(first.context).not.toContain('same repo as you');
    expect((await getFleetSession({ host: 'claude', sessionId: B }))).toMatchObject({ repo: 'test-repo', endedAt: null });

    // A starts second and is told about B, under the repo name B's own row recorded.
    const start = await handleHostLifecycleEvent(projectId, hook({ event: 'session-start', externalSessionId: A, title: 'Agent session' }));
    expect(start.accepted).toBe(true);
    expect(start.context).toContain('LIVE SESSIONS (1 other Claude Code session on this machine)');
    expect(start.context).toContain('test-repo');
    expect(start.context).toContain('test-b');
    expect(start.context).toContain('same repo as you');
    expect(start.context).toContain('knowl_fleet');
    expect(start.context!.length).toBeLessThanOrEqual(3_000);
  });

  it('tells the second session that the first is already on the same error', async () => {
    // B hits the error and starts editing: that opens B's claim.
    await handleHostLifecycleEvent(projectId, hook({
      externalSessionId: B, type: 'command', toolName: 'Bash',
      payload: { command: 'npx vitest run tests/one.test.ts', exitCode: 1 },
      errorText: 'FAIL tests/one.test.ts\n  → Error: SQLITE_BUSY: database is locked (C:\\b\\.knowl\\knowl.db)',
    }));
    await handleHostLifecycleEvent(projectId, hook({
      externalSessionId: B, type: 'checkpoint', toolName: 'Edit', captureKey: 'edit-b-1',
      payload: { changedPaths: ['src/x.ts'] },
    }));
    const claims = await openFleetClaimsForSession({ host: 'claude', sessionId: B });
    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({ files: ['src/x.ts'], machineWide: false });
    expect(claims[0].head).toContain('sqlite_busy: database is locked');

    // A hits the same error from its own worktree as a tool FAILURE, which the host's mid-turn
    // slot never carries -- so the card waits for A's next call.
    const failed = await handleHostLifecycleEvent(projectId, hook({
      externalSessionId: A, type: 'error', status: 'failed', toolName: 'Bash',
      payload: { message: 'Tool failed' },
      errorText: 'FAIL tests/one.test.ts\n  → Error: SQLITE_BUSY: database is locked (C:\\a\\.knowl\\knowl.db)',
    }));
    expect(failed.hostOutput).toBeUndefined();
    const next = await handleHostLifecycleEvent(projectId, hook({
      externalSessionId: A, type: 'checkpoint', toolName: 'Grep', captureKey: 'grep-a-1', payload: { summary: 'Grep completed' },
    }));
    const card = additionalContext(next);
    expect(card).toContain('ANOTHER SESSION IS ALREADY ON THIS PROBLEM');
    expect(card).toContain('test-b hit the same error');
    expect(card).toContain('sqlite_busy: database is locked');
    expect(card).toContain('editing: src/x.ts');
    expect(card).toContain('SendMessage(to:"test-b", notify_when_idle:true)');

    // Once. The next call gets nothing from the fleet.
    const again = await handleHostLifecycleEvent(projectId, hook({
      externalSessionId: A, type: 'checkpoint', toolName: 'Grep', captureKey: 'grep-a-2', payload: { summary: 'Grep completed' },
    }));
    expect(additionalContext(again) ?? '').not.toContain('ANOTHER SESSION');
    const ledger = await listFleetCards({ host: 'claude', sessionId: A });
    expect(ledger.filter(row => row.kind === 'same-problem')).toHaveLength(1);
  });

  it('runs a pre-flight card before an edit to a shared surface', async () => {
    const precheck = await handleHostLifecycleEvent(projectId, hook({
      event: 'tool-precheck', hostEvent: 'PreToolUse', externalSessionId: A, toolName: 'Edit',
      payload: { changedPaths: ['.knowl/config.json'] },
    }));
    expect(precheck.accepted).toBe(true);
    expect(precheck.denied).toBeUndefined();
    expect((precheck.hostOutput?.hookSpecificOutput as { hookEventName?: string })?.hookEventName).toBe('PreToolUse');
    const card = additionalContext(precheck)!;
    expect(card).toContain('SHARED SURFACE · knowl-config · .knowl/config.json');
    expect(card).toContain('test-b');
    expect(card).toContain('notify_when_idle:true');

    const repeat = await handleHostLifecycleEvent(projectId, hook({
      event: 'tool-precheck', hostEvent: 'PreToolUse', externalSessionId: A, toolName: 'Edit',
      payload: { changedPaths: ['.knowl/config.json'] },
    }));
    expect(repeat.hostOutput).toBeUndefined();

    const ordinary = await handleHostLifecycleEvent(projectId, hook({
      event: 'tool-precheck', hostEvent: 'PreToolUse', externalSessionId: A, toolName: 'Edit',
      payload: { changedPaths: ['src/nobody-read-this.ts'] },
    }));
    expect(ordinary.hostOutput).toBeUndefined();
  });

  it('withholds the stop once when this turn changed a file the other session read', async () => {
    // B reads src/x.ts at file granularity; the read set records the hash it saw.
    await handleHostLifecycleEvent(projectId, hook({
      externalSessionId: B, type: 'checkpoint', toolName: 'Read', captureKey: 'read-b-x',
      payload: { changedPaths: ['src/x.ts'] },
    }));
    // A rewrites it and ends its turn.
    fs.writeFileSync(path.join(ROOT, 'src', 'x.ts'), 'export const x = 2;\n');
    await handleHostLifecycleEvent(projectId, hook({
      externalSessionId: A, type: 'checkpoint', toolName: 'Edit', captureKey: 'edit-a-x',
      payload: { changedPaths: ['src/x.ts'] },
    }));
    const stop = await handleHostLifecycleEvent(projectId, hook({
      event: 'turn-stop', externalSessionId: A, status: 'finished', payload: { status: 'finished' },
      assistantMessage: 'Bumped x to 2 so the retry path has something to compare.',
    }));
    expect(stop.accepted).toBe(true);
    expect(stop.hostOutput).toMatchObject({ decision: 'block' });
    const reason = String((stop.hostOutput as { reason?: string }).reason);
    expect(reason).toContain('ANOTHER SESSION READ WHAT YOU JUST CHANGED');
    expect(reason).toContain('test-b');
    expect(reason).toContain('src/x.ts');
    expect(reason).toContain('SendMessage(to:"test-b")');

    const row = await getFleetSession({ host: 'claude', sessionId: A });
    expect(row?.summary).toBe('Bumped x to 2 so the retry path has something to compare.');
    expect(row?.writes).toEqual([]);
    expect(row?.turnEndedAt).toBeTruthy();

    // The next stop for the same file says nothing: the nudge is once per reader and path.
    await handleHostLifecycleEvent(projectId, hook({
      externalSessionId: A, type: 'checkpoint', toolName: 'Edit', captureKey: 'edit-a-x-2', payload: { changedPaths: ['src/x.ts'] },
    }));
    const second = await handleHostLifecycleEvent(projectId, hook({
      event: 'turn-stop', externalSessionId: A, status: 'finished', payload: { status: 'finished' },
    }));
    expect(second.hostOutput).toBeUndefined();
  });

  it('records the turn ask and digests what the other session moved on to', async () => {
    const config = { version: 1, fleet: { digest: 'on' as const } } as any;
    const first = await fleetTurnStartBestEffort({ host: 'claude', externalSessionId: A, projectRoot: ROOT, prompt: 'now port the fix to the reindex path' }, config);
    expect(first).toContain('SESSIONS MOVED (1)');
    expect(first).toContain('test-b');
    expect((await getFleetSession({ host: 'claude', sessionId: A }))?.ask).toBe('now port the fix to the reindex path');

    // Nothing moved since: silence.
    const quiet = await fleetTurnStartBestEffort({ host: 'claude', externalSessionId: A, projectRoot: ROOT }, config);
    expect(quiet).toBeUndefined();

    // An ask the secret validator refuses is dropped whole; the previous ask stands.
    await fleetTurnStartBestEffort({ host: 'claude', externalSessionId: A, projectRoot: ROOT, prompt: 'use api_key=sk-live-1234567890abcdef1234567890abcdef for the call' }, config);
    expect((await getFleetSession({ host: 'claude', sessionId: A }))?.ask).toBe('now port the fix to the reindex path');

    // B moves; A hears about it once.
    await fleetTurnStartBestEffort({ host: 'claude', externalSessionId: B, projectRoot: ROOT, prompt: 'write the changelog entry' }, config);
    const moved = await fleetTurnStartBestEffort({ host: 'claude', externalSessionId: A, projectRoot: ROOT }, config);
    expect(moved).toContain('write the changelog entry');
  });

  it('marks the session ended on SessionEnd', async () => {
    const end = await handleHostLifecycleEvent(projectId, hook({ event: 'session-stop', externalSessionId: B, status: 'finished', payload: { status: 'finished' } }));
    expect(end.accepted).toBe(true);
    expect((await getFleetSession({ host: 'claude', sessionId: B }))?.endedAt).toBeTruthy();
    expect(await openFleetClaimsForSession({ host: 'claude', sessionId: B })).toEqual([]);
  });
});
