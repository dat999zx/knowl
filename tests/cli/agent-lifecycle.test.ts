import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isLifecycleCapability, isLifecycleEvent } from '../../src/cli/agents/lifecycle.js';

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
  }, 15_000);

  afterAll(async () => { await fs.rm(TEST_DIR, { recursive: true, force: true }).catch(() => {}); });

  it('exposes lifecycle capability and event contracts', () => {
    expect(['supported', 'unsupported', 'degraded'].every(isLifecycleCapability)).toBe(true);
    expect(['session-start', 'session-event', 'session-stop', 'session-recover'].every(isLifecycleEvent)).toBe(true);
    expect(isLifecycleEvent('start')).toBe(false);
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
  }, 15_000);

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
});
