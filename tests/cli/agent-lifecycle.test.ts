import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { createClient } from '@libsql/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isLifecycleCapability, isLifecycleEvent, readLifecyclePayload } from '../../src/cli/agents/lifecycle.js';

const TEST_DIR = path.resolve('./.knowl-agent-lifecycle-test');
const CLI_PATH = path.resolve('./dist/index.js');

function run(args: string[], input?: string) {
  return execFileSync(process.execPath, [CLI_PATH, ...args], {
    cwd: TEST_DIR,
    encoding: 'utf8',
    input,
  });
}

describe('agent lifecycle CLI', () => {
  beforeAll(async () => {
    await fs.rm(TEST_DIR, { recursive: true, force: true });
    await fs.mkdir(TEST_DIR, { recursive: true });
    run(['init', '--yes']);
  }, 60_000);

  afterAll(async () => { await fs.rm(TEST_DIR, { recursive: true, force: true }).catch(() => {}); });

  it('exposes lifecycle capability and event contracts', () => {
    expect(['supported', 'unsupported', 'degraded'].every(isLifecycleCapability)).toBe(true);
    expect(['session-start', 'session-event', 'session-stop', 'session-recover'].every(isLifecycleEvent)).toBe(true);
    expect(isLifecycleEvent('start')).toBe(false);
  });

  it('streams allowlisted nested fields without retaining ignored output', async () => {
    const payload = await readLifecyclePayload(Readable.from([JSON.stringify({
      session_id: 'stream-session',
      cwd: TEST_DIR,
      tool_name: 'Bash',
      tool_input: { command: 'npm test', unsafe: 'discard me' },
      tool_response: { stdout: `sk-test-123456789012345678901234567890${'x'.repeat(1_100_000)}`, exit_code: 0 },
    })]) as NodeJS.ReadStream);

    expect(payload).toEqual({
      session_id: 'stream-session',
      cwd: TEST_DIR,
      tool_name: 'Bash',
      tool_input: { command: 'npm test' },
      tool_response: { exit_code: 0 },
    });
  });

  it('retains subagent identity and Knowl write arguments while still discarding noise', async () => {
    const payload = await readLifecyclePayload(Readable.from([JSON.stringify({
      session_id: 'stream-subagent',
      agent_id: 'adc54472c7d8cad78',
      agent_type: 'Explore',
      cwd: TEST_DIR,
      prompt_id: 'discard me',
      tool_name: 'mcp__knowl__knowl_ingest_atoms',
      tool_input: {
        atoms: [{ title: 'First atom', content: 'discard me' }],
        id: 'item-9',
        supersedeId: 'item-8',
        title: 'A title',
        unsafe: 'discard me',
      },
    })]) as NodeJS.ReadStream);

    expect(payload.agent_id).toBe('adc54472c7d8cad78');
    expect(payload.agent_type).toBe('Explore');
    expect(payload.prompt_id).toBeUndefined();
    expect(payload.tool_input).toMatchObject({ id: 'item-9', supersedeId: 'item-8', title: 'A title' });
    expect((payload.tool_input as any).atoms[0].title).toBe('First atom');
    expect((payload.tool_input as any).unsafe).toBeUndefined();
  });

  it('captures bounded lifecycle events from stdin', () => {
    const started = JSON.parse(run(['agent-event', 'session-start', '--title', 'Implement lifecycle hooks', '--agent', 'codex', '--json']));
    expect(started).toMatchObject({ id: expect.any(String), status: 'active', agent: 'codex' });

    const event = JSON.parse(run(['agent-event', 'session-event', '--session', started.id, '--json'], JSON.stringify({
      type: 'command', command: 'npm test', exitCode: 0, summary: 'Lifecycle command passed', stdout: 'must not persist',
    })));
    expect(event).toMatchObject({ sessionId: started.id, type: 'command', payload: { command: 'npm test', exitCode: 0, summary: 'Lifecycle command passed' } });
    expect(event.payload).not.toHaveProperty('stdout');

    const stopped = JSON.parse(run(['agent-event', 'session-stop', '--session', started.id, '--status', 'finished', '--json']));
    expect(stopped).toMatchObject({ id: started.id, status: 'finished', promotion: expect.any(Object) });

    const lostEvent = JSON.parse(run(['agent-event', 'session-event', '--session', started.id, '--type', 'command', '--json']));
    expect(lostEvent).toEqual({ accepted: false, reason: 'event-loss' });
  }, 60_000);

  it('rejects malformed and secret lifecycle payloads without echoing secret values', () => {
    let malformed: any;
    try { run(['agent-event', 'session-start', '--json'], '{'); } catch (error: any) { malformed = error; }
    expect(malformed.status).toBe(1);
    expect(malformed.stderr.toString()).toContain('Error handling agent lifecycle event');

    const secret = 'sk-abcdefghijklmnopqrstuvwxyz123456';
    let rejected: any;
    try { run(['agent-event', 'session-start', '--title', secret, '--json']); } catch (error: any) { rejected = error; }
    expect(rejected.status).toBe(1);
    expect(rejected.stderr.toString()).toContain('secret material was detected');
    expect(rejected.stderr.toString()).not.toContain(secret);
  });

  it('recovers a session left active when a hook process crashes', async () => {
    const started = JSON.parse(run(['agent-event', 'session-start', '--title', 'Interrupted hook', '--json']));
    const client = createClient({ url: `file:${path.join(TEST_DIR, '.knowl', 'knowl.db')}` });
    await client.execute({ sql: "UPDATE memory_sessions SET last_heartbeat_at = '2020-01-01T00:00:00.000Z' WHERE id = ?", args: [started.id] });
    client.close();

    expect(JSON.parse(run(['agent-event', 'session-recover', '--json']))).toMatchObject({ recoveredCount: 1 });
  }, 60_000);

  it('accepts the host-neutral hook contract and promotes a completed turn', () => {
    const started = JSON.parse(run(['agent-hook', 'generic', 'turn-start', '--json'], JSON.stringify({
      sessionId: 'generic-session',
      turnId: 'generic-turn',
      cwd: TEST_DIR,
      title: 'Generic host turn',
    })));
    expect(started).toMatchObject({ accepted: true, sessionId: expect.any(String) });

    const event = JSON.parse(run(['agent-hook', 'generic', 'session-event', '--json'], JSON.stringify({
      sessionId: 'generic-session',
      turnId: 'generic-turn',
      cwd: TEST_DIR,
      type: 'command',
      command: 'npm test',
      exitCode: 0,
    })));
    expect(event).toMatchObject({ accepted: true, sessionId: started.sessionId });

    const stopped = JSON.parse(run(['agent-hook', 'generic', 'turn-stop', '--json'], JSON.stringify({
      sessionId: 'generic-session',
      turnId: 'generic-turn',
      cwd: TEST_DIR,
      status: 'finished',
    })));
    expect(stopped).toMatchObject({ accepted: true, sessionId: started.sessionId, promotion: expect.any(Object) });

    const duplicate = JSON.parse(run(['agent-hook', 'generic', 'turn-stop', '--json'], JSON.stringify({
      sessionId: 'generic-session',
      turnId: 'generic-turn',
      cwd: TEST_DIR,
      status: 'finished',
    })));
    expect(duplicate).toEqual({ accepted: false, reason: 'event-loss' });
  }, 60_000);

  it('returns host-native context and rejects secret-bearing host payloads safely', () => {
    const context = JSON.parse(run(['agent-hook', 'codex', 'SessionStart', '--json'], JSON.stringify({
      session_id: 'codex-session',
      cwd: TEST_DIR,
      hook_event_name: 'SessionStart',
    })));
    expect(context).toMatchObject({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: expect.stringContaining('KNOWL'),
      },
    });

    const secret = 'sk-abcdefghijklmnopqrstuvwxyz123456';
    let rejected: any;
    try {
      run(['agent-hook', 'generic', 'turn-start', '--json'], JSON.stringify({
        sessionId: 'secret-session',
        turnId: 'secret-turn',
        cwd: TEST_DIR,
        title: secret,
      }));
    } catch (error: any) {
      rejected = error;
    }
    expect(rejected.status).toBe(1);
    expect(rejected.stderr.toString()).toContain('secret material was detected');
    expect(rejected.stderr.toString()).not.toContain(secret);
  }, 60_000);

  it('accepts large host payloads when retained hook data stays bounded', () => {
    const output = run(['agent-hook', 'codex', 'PostToolUse', '--json'], JSON.stringify({
      session_id: 'codex-large-session',
      turn_id: 'codex-large-turn',
      cwd: TEST_DIR,
      tool_name: 'Bash',
      tool_input: { command: 'npm test' },
      tool_response: { stdout: `sk-test-123456789012345678901234567890${'x'.repeat(5_000)}`, exit_code: 0 },
    }));

    expect(output).toBe('');
  }, 60_000);

  it('accepts Codex thread_id payloads streamed from PostToolUse', () => {
    const output = run(['agent-hook', 'codex', 'PostToolUse', '--json'], JSON.stringify({
      thread_id: 'codex-thread-session',
      generation_id: 'codex-thread-turn',
      cwd: TEST_DIR,
      tool_name: 'Bash',
      tool_input: { command: 'npm test' },
      tool_response: { exit_code: 0 },
    }));

    expect(output).toBe('');
  }, 60_000);

  it('drops incomplete envelopes for every host adapter without failing the host', () => {
    const hooks = [
      ['codex', 'PostToolUse'],
      ['claude', 'PostToolUse'],
      ['cursor', 'postToolUse'],
      ['generic', 'session-event'],
    ];

    for (const [host, event] of hooks) {
      expect(run(['agent-hook', host, event, '--json'], '{}')).toBe('');
    }

    expect(run(['agent-hook', 'generic', 'session-event', '--json'], JSON.stringify({
      sessionId: 'incomplete-generic',
      turnId: 'incomplete-turn',
      cwd: TEST_DIR,
    }))).toBe('');
  }, 60_000);

  it('accepts host payloads larger than the legacy transport cap', () => {
    const output = run(['agent-hook', 'codex', 'PostToolUse', '--json'], JSON.stringify({
      session_id: 'codex-unbounded-session',
      turn_id: 'codex-unbounded-turn',
      cwd: TEST_DIR,
      tool_name: 'Bash',
      tool_input: { command: 'npm test' },
      tool_response: { stdout: 'x'.repeat(1_100_000), exit_code: 0 },
    }));

    expect(output).toBe('');
  }, 60_000);

  it('emits no JSON for Codex Stop hooks', () => {
    const payload = {
      session_id: 'codex-stop-session',
      turn_id: 'codex-stop-turn',
      cwd: TEST_DIR,
    };
    run(['agent-hook', 'codex', 'UserPromptSubmit', '--json'], JSON.stringify(payload));

    expect(run(['agent-hook', 'codex', 'Stop', '--json'], JSON.stringify(payload))).toBe('');
  }, 60_000);
});
