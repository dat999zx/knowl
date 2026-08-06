import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  installProcessHooks, MAX_STARTUP_LOG_BYTES, serveBanner, trimStartupLog, type ProcessHooks,
} from '../../src/core/startup-trace.js';

let dir = '';
let logPath = '';

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'knowl-trace-'));
  logPath = path.join(dir, 'serve-startup.jsonl');
});

afterEach(() => {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* Windows */ }
});

/** A stand-in for `process` that records what the hooks did instead of doing it. */
function fakeProcess() {
  const emitter = new EventEmitter() as EventEmitter & ProcessHooks;
  const calls: { exit: number[]; kill: string[] } = { exit: [], kill: [] };
  emitter.pid = 4242;
  emitter.exit = ((code?: number) => { calls.exit.push(code ?? 0); }) as ProcessHooks['exit'];
  emitter.kill = ((_pid: number, signal?: string) => { calls.kill.push(String(signal)); return true; }) as ProcessHooks['kill'];
  return { emitter, calls };
}

describe('startup trace durability', () => {
  /**
   * One record per `knowl serve` boot, one serve per connected session, forever. Without a
   * cap this is a file that only grows, on every machine, and `knowl diagnose-startup` reads
   * it back in full. A diagnostic that becomes a disk-space problem gets deleted, and then
   * it is not a diagnostic.
   */
  it('caps the durable log instead of letting it grow without bound', () => {
    const line = JSON.stringify({ event: 'boot-end', pad: 'x'.repeat(400) }) + '\n';
    const lines = Math.ceil((MAX_STARTUP_LOG_BYTES * 2) / line.length);
    fs.writeFileSync(logPath, line.repeat(lines));
    expect(fs.statSync(logPath).size).toBeGreaterThan(MAX_STARTUP_LOG_BYTES);

    trimStartupLog(logPath);

    expect(fs.statSync(logPath).size).toBeLessThanOrEqual(MAX_STARTUP_LOG_BYTES);
  });

  it('keeps the newest records when it trims, not the oldest', () => {
    const record = (n: number) => JSON.stringify({ event: 'boot-end', n, pad: 'x'.repeat(400) }) + '\n';
    const count = Math.ceil((MAX_STARTUP_LOG_BYTES * 2) / record(0).length);
    fs.writeFileSync(logPath, Array.from({ length: count }, (_, i) => record(i)).join(''));

    trimStartupLog(logPath);

    const kept = fs.readFileSync(logPath, 'utf8').trim().split('\n');
    // The last boot is the one being diagnosed; the first is the one nobody is asking about.
    expect(JSON.parse(kept[kept.length - 1]).n).toBe(count - 1);
    // Trimming mid-record would leave a fragment no reader can parse.
    expect(() => kept.forEach(l => JSON.parse(l))).not.toThrow();
  });

  it('leaves a log that is already small alone', () => {
    fs.writeFileSync(logPath, JSON.stringify({ event: 'boot-end' }) + '\n');
    const before = fs.readFileSync(logPath, 'utf8');

    trimStartupLog(logPath);

    expect(fs.readFileSync(logPath, 'utf8')).toBe(before);
  });
});

describe('startup trace process hooks', () => {
  /**
   * Registering an `unhandledRejection` listener suppresses Node's default, which since v15
   * is to crash. A diagnostic that quietly converts a fatal bug into a logged one has changed
   * the program it was only supposed to observe.
   */
  it('records an unhandled rejection without swallowing it', () => {
    const { emitter } = fakeProcess();
    const seen: Record<string, unknown>[] = [];
    installProcessHooks(emitter, record => seen.push(record));

    expect(() => emitter.emit('unhandledRejection', new Error('boom')))
      .toThrowError(/boom/);
    expect(seen.map(r => r.event)).toContain('crash');
  });

  /**
   * The entire point of this trace is telling a host kill apart from a clean exit. Exiting 0
   * on SIGTERM tells everything downstream -- the host, a supervisor, CI -- that the process
   * finished its work, which is the opposite of what happened.
   */
  it('does not report success when it was killed by a signal', () => {
    const { emitter, calls } = fakeProcess();
    installProcessHooks(emitter, () => {});

    emitter.emit('SIGTERM');

    expect(calls.exit).not.toContain(0);
    // Either re-raised so the parent sees a signal death, or the conventional 128+n code.
    expect(calls.kill.includes('SIGTERM') || calls.exit.includes(143)).toBe(true);
  });

  it('records the signal it died on', () => {
    const { emitter } = fakeProcess();
    const seen: Record<string, unknown>[] = [];
    installProcessHooks(emitter, record => seen.push(record));

    emitter.emit('SIGINT');

    expect(seen.find(r => r.event === 'signal')?.signal).toBe('SIGINT');
  });
});

describe('serve banner', () => {
  it('says the root is not resolved yet rather than inventing one', () => {
    expect(serveBanner({ pid: 7, projectRoot: null })).toContain('projectRoot=pending');
  });

  /**
   * The banner is how you tell which repo a serve process in a host log belongs to. Deferring
   * the database open moved the root out of reach of the first line, so it has to arrive on a
   * second one -- otherwise every process in the log is anonymous, which is worse than the
   * stall this PR set out to diagnose.
   */
  it('names the resolved root once initialization settles', () => {
    const line = serveBanner({ pid: 7, projectRoot: 'D:\\coding\\knowl', readyMs: 1234 });
    expect(line).toContain('projectRoot=D:\\coding\\knowl');
    expect(line).toContain('ready=1234ms');
  });
});

/**
 * What the log may know about this machine.
 *
 * The diagnostics directory is machine-wide, and every `boot-start` record carried the literal
 * project root beside hostname, PID, load average and free memory. On a shared Unix host that
 * told every local account which projects this user works on and when. A hash answers the
 * questions the log exists for -- "same project?", "several servers stalling together?" --
 * without being identifying.
 */
describe('startup diagnostics privacy and permissions', () => {
  const HOME = path.resolve('./.knowl-startup-trace-test-home');
  const DISTINCTIVE = path.join(os.tmpdir(), 'a-very-distinctive-project-name');
  const savedHome = process.env.KNOWL_HOME;
  const savedDisable = process.env.KNOWL_DISABLE_STARTUP_TRACE;

  // Traced ONCE, in beforeAll. `beginStartupTrace` guards on module-level `active` and is a
  // no-op on a second call -- correct, since one process has one boot -- so a per-test
  // beginStartupTrace would silently write nothing and the assertions would read a stale or
  // absent file. Ordering matters below: the clear test runs last because it destroys the log.
  beforeAll(async () => {
    fs.rmSync(HOME, { recursive: true, force: true });
    process.env.KNOWL_HOME = HOME;
    delete process.env.KNOWL_DISABLE_STARTUP_TRACE;
    const { beginStartupTrace } = await import('../../src/core/startup-trace.js');
    beginStartupTrace({ projectRoot: DISTINCTIVE, version: '0.0.0-test' });
  });

  afterAll(() => {
    if (savedHome === undefined) delete process.env.KNOWL_HOME;
    else process.env.KNOWL_HOME = savedHome;
    if (savedDisable === undefined) delete process.env.KNOWL_DISABLE_STARTUP_TRACE;
    else process.env.KNOWL_DISABLE_STARTUP_TRACE = savedDisable;
    try { fs.rmSync(HOME, { recursive: true, force: true }); } catch { /* Windows */ }
  });

  it('records a hashed project root, never the path', async () => {
    const { startupLogPath } = await import('../../src/core/startup-trace.js');
    const contents = fs.readFileSync(startupLogPath(), 'utf8');
    expect(contents).not.toContain('a-very-distinctive-project-name');
    const record = JSON.parse(contents.split('\n').filter(Boolean)[0]);
    expect(record.projectHash).toMatch(/^[0-9a-f]{16}$/);
    expect(record.projectRoot).toBeUndefined();
  });

  it.skipIf(process.platform === 'win32')('keeps the diagnostics directory and log owner-only', async () => {
    const { diagnosticsDir, startupLogPath } = await import('../../src/core/startup-trace.js');
    expect(fs.statSync(diagnosticsDir()).mode & 0o777).toBe(0o700);
    expect(fs.statSync(startupLogPath()).mode & 0o777).toBe(0o600);
  });

  it('clears the log on request', async () => {
    const { clearStartupLog, startupLogPath } = await import('../../src/core/startup-trace.js');
    expect(fs.existsSync(startupLogPath())).toBe(true);
    clearStartupLog();
    expect(fs.existsSync(startupLogPath())).toBe(false);
  });
});
