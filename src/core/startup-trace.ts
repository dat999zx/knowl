import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { knowlHome } from './paths.js';

/**
 * Why a `knowl serve` startup took as long as it did.
 *
 * The host gives an MCP server a fixed window to complete its handshake -- 30s in Claude
 * Code, configurable via `MCP_TIMEOUT` -- and kills the process when it expires. A server
 * killed that way leaves almost nothing behind: the last thing on stderr is whatever it
 * happened to print before it stalled, which says where it got to but never why. Diagnosing
 * one from the outside is guesswork, and guesswork picks the most visible suspect rather
 * than the responsible one.
 *
 * So the boot reports on itself. Three properties, each answering a way an after-the-fact
 * investigation cannot:
 *
 * 1. **It reports from inside a hang, not after it.** A process killed at the deadline never
 *    reaches its own summary line, so a summary-only design is silent in exactly the case
 *    worth diagnosing. A watchdog fires at 5s/15s/25s -- inside the host's window -- and
 *    names the phase that is *currently* running.
 * 2. **It writes to both stderr and a file.** stderr lands in the host's own MCP log beside
 *    the host's timeout line, so cause and effect sit in one place. The file survives the
 *    kill, and it is machine-wide rather than per-project, which is the only way to see
 *    several servers stalling in the same second -- the signature of contention between
 *    processes rather than of any one project being slow.
 * 3. **It is silent when healthy.** A fast boot prints nothing to stderr and appends one line
 *    to the durable log, so the healthy distribution stays measurable without making normal
 *    operation noisy. Diagnostics that shout during normal operation get ignored during
 *    abnormal operation.
 *
 * Never throws and never blocks: a diagnostic that can fail a startup is worse than no
 * diagnostic. Set KNOWL_DISABLE_STARTUP_TRACE=1 to turn it off.
 */

type Phase = { name: string; startedAt: number; endedAt?: number };

const WATCHDOG_MARKS_MS = [5_000, 15_000, 25_000];

let bootId = '';
let bootStartedAt = 0;
let phases: Phase[] = [];
let current: Phase | null = null;
let modelLoad: { model: string; cached: boolean; ms: number } | null = null;
let timers: NodeJS.Timeout[] = [];
let finished = false;
let active = false;

const now = () => Date.now();
const enabled = () => process.env.KNOWL_DISABLE_STARTUP_TRACE !== '1';

export function diagnosticsDir(): string {
  return path.join(knowlHome(), 'diagnostics');
}

export function startupLogPath(): string {
  return path.join(diagnosticsDir(), 'serve-startup.jsonl');
}

/**
 * The ceiling this log is allowed to reach on disk.
 *
 * There is one record per boot, one boot per connected session, on every machine, forever --
 * so without a cap this only grows, and `knowl diagnose-startup` reads it back in full. At
 * roughly 400 bytes a record, 4 MB is on the order of ten thousand boots, far more history
 * than any startup question needs. A diagnostic that becomes a disk-space problem gets
 * deleted, and a deleted diagnostic diagnoses nothing.
 */
export const MAX_STARTUP_LOG_BYTES = 4 * 1024 * 1024;

/** Keep this much after a trim, so trimming is occasional rather than once per append. */
const TRIM_TARGET_BYTES = Math.floor(MAX_STARTUP_LOG_BYTES / 2);

/**
 * Drop the oldest records once the log outgrows its ceiling.
 *
 * Rewrites in place rather than rotating to a `.1` file: two files double the ceiling and
 * give `diagnose-startup` a second place to look, for history nobody asks for. The cut lands
 * on a newline, because half a JSON record is a line no reader can parse.
 *
 * Everything after the open goes through the descriptor -- `fstat`, read, truncate, `fchmod` --
 * so the bytes measured are the bytes rewritten. Checking a path and then acting on that path
 * is two separate lookups, and on a machine-wide directory the file can be replaced between
 * them: the size check would pass on one file and the truncating write land on another.
 */
export function trimStartupLog(file: string): void {
  let fd: number;
  try {
    fd = fs.openSync(file, 'r+');
  } catch {
    return; // No log yet, or not ours to read -- either way there is nothing to trim.
  }
  try {
    if (fs.fstatSync(fd).size <= MAX_STARTUP_LOG_BYTES) return;

    const contents = fs.readFileSync(fd, 'utf8');
    const cut = contents.length - TRIM_TARGET_BYTES;
    const boundary = contents.indexOf('\n', Math.max(0, cut));
    // No newline after the cut means one enormous trailing record; keeping it whole is
    // better than writing a fragment, and the next append will try again.
    if (boundary === -1) return;

    fs.ftruncateSync(fd, 0);
    fs.writeSync(fd, contents.slice(boundary + 1), 0, 'utf8');
    // Mode preserved: a rewrite must not widen what `append` deliberately narrowed.
    fs.fchmodSync(fd, 0o600);
  } catch {
    // Same rule as append: a diagnostic must never be the reason a server fails to start.
  } finally {
    try { fs.closeSync(fd); } catch { /* already gone */ }
  }
}

/**
 * Append one record. Synchronous on purpose: this is called from watchdogs and exit handlers,
 * where an async write may never flush before the process dies -- which is precisely the
 * record worth keeping.
 *
 * The modes matter because this file is machine-wide rather than per-project: on a shared host
 * it would otherwise tell every local account which projects this user runs, and when.
 *
 * One `open('a', 0o600)` replaces the exists-then-create pair: it creates the file already
 * narrowed when it is absent and appends when it is not, with no window between the two in
 * which another account on the host could put its own file at that path and inherit the mode
 * we were about to set. `fchmod` on the descriptor then narrows what umask widened -- and an
 * older log left group-readable -- on the file actually written rather than on the name.
 */
function append(record: Record<string, unknown>): void {
  try {
    fs.mkdirSync(diagnosticsDir(), { recursive: true, mode: 0o700 });
    fs.chmodSync(diagnosticsDir(), 0o700);
    const file = startupLogPath();
    const fd = fs.openSync(file, 'a', 0o600);
    try {
      fs.writeSync(fd, JSON.stringify(record) + '\n');
      fs.fchmodSync(fd, 0o600);
    } finally {
      fs.closeSync(fd);
    }
    trimStartupLog(file);
  } catch {
    // A diagnostic must never be the reason a server fails to start.
  }
}

/**
 * A stable, non-identifying handle for one project.
 *
 * The log's questions are "was this the same project?" and "were several servers stalling
 * together?". A hash answers both; the path itself answers neither better, and on a shared
 * host it names the user's work to every other account.
 */
function projectHash(projectRoot: string): string {
  return crypto.createHash('sha256').update(path.resolve(projectRoot)).digest('hex').slice(0, 16);
}

/** Remove the machine-wide diagnostics log. Exposed as `knowl diagnose-startup --clear`. */
export function clearStartupLog(): void {
  try {
    fs.rmSync(startupLogPath(), { force: true });
  } catch {
    // Same rule as append.
  }
}

function emitStderr(line: string): void {
  try {
    process.stderr.write(line + '\n');
  } catch {
    /* stdio may already be torn down */
  }
}

function elapsed(): number {
  return now() - bootStartedAt;
}

function snapshot() {
  return {
    bootId,
    pid: process.pid,
    elapsedMs: elapsed(),
    phase: current ? current.name : null,
    phaseMs: current ? now() - current.startedAt : null,
    done: phases.filter(p => p.endedAt).map(p => `${p.name}=${p.endedAt! - p.startedAt}ms`),
  };
}

export function beginStartupTrace(context: { projectRoot?: string | null; version?: string } = {}): void {
  if (!enabled() || active) return;
  active = true;
  finished = false;
  bootStartedAt = now();
  // No crypto import for an identifier that only has to be unique among concurrent boots.
  bootId = `${process.pid.toString(36)}-${bootStartedAt.toString(36)}`;
  phases = [];
  modelLoad = null;

  append({
    event: 'boot-start',
    at: new Date(bootStartedAt).toISOString(),
    bootId,
    pid: process.pid,
    projectHash: projectHash(context.projectRoot ?? process.cwd()),
    version: context.version ?? null,
    node: process.version,
    host: os.hostname(),
    // Load average is the cheapest cross-platform proxy for "this machine is busy right
    // now", which is the leading explanation for a startup that is slow only sometimes.
    // Windows always reports zeroes, so it is recorded rather than interpreted.
    loadavg: os.loadavg(),
    freemem: os.freemem(),
  });

  for (const mark of WATCHDOG_MARKS_MS) {
    const timer = setTimeout(() => {
      if (finished) return;
      const state = snapshot();
      emitStderr(
        `[knowl serve] STALL bootId=${state.bootId} elapsed=${state.elapsedMs}ms ` +
        `phase=${state.phase ?? 'unknown'} phaseMs=${state.phaseMs ?? 0} ` +
        `done=[${state.done.join(' ')}]`
      );
      append({
        event: 'stall',
        at: new Date().toISOString(),
        mark,
        ...state,
        // A machine with little free memory pages the database file in and out and makes
        // opening it slow for reasons no per-phase timing would explain on its own. Sampled
        // at the moment of the stall, not at boot, so it describes the conditions during it.
        freemem: os.freemem(),
        loadavg: os.loadavg(),
      });
    }, mark);
    // A diagnostic timer must not be the reason the process stays alive.
    timer.unref?.();
    timers.push(timer);
  }

  installProcessHooks(process as unknown as ProcessHooks, append);
}

/** The slice of `process` these hooks touch, so a test can hand over a fake instead. */
export interface ProcessHooks {
  pid: number;
  once(event: string, listener: (...args: any[]) => void): unknown;
  removeListener(event: string, listener: (...args: any[]) => void): unknown;
  exit(code?: number): never;
  kill(pid: number, signal?: string): boolean;
}

/** Conventional shell encoding of "died on signal N", so an exit code still says which. */
const SIGNAL_EXIT_CODES: Record<string, number> = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 };

/**
 * Record how the process died, and then let it die exactly as it would have.
 *
 * The hard rule here is that observing must not change the thing observed. Two ways this got
 * that wrong are worth naming, because both look harmless:
 *
 * - **Listening for `unhandledRejection` suppresses Node's default**, which since v15 is to
 *   crash. Recording and returning silently converts a fatal bug anywhere in the process into
 *   a logged one, so the trace would quietly keep alive a server it was only meant to watch.
 *   It is re-thrown after recording.
 * - **`process.exit(0)` on a signal reports success for a kill.** Distinguishing a host kill
 *   from a clean exit is this module's entire purpose, and an exit code of 0 tells the host,
 *   a supervisor and CI the opposite of what happened. The listener removes itself and
 *   re-raises the signal, so the parent sees a real signal death; if the platform will not
 *   re-raise, it falls back to the conventional 128+n code.
 */
export function installProcessHooks(
  target: ProcessHooks,
  record: (entry: Record<string, unknown>) => void,
): void {
  // How the process actually died. "Killed by the host at the deadline" and "crashed during
  // bootstrap" look identical from the outside, and they need opposite fixes.
  target.once('uncaughtException', (error: any) => {
    record({ event: 'crash', at: new Date().toISOString(), kind: 'uncaughtException', message: String(error?.message ?? error), ...snapshot() });
    throw error;
  });

  target.once('unhandledRejection', (reason: unknown) => {
    record({ event: 'crash', at: new Date().toISOString(), kind: 'unhandledRejection', message: String(reason), ...snapshot() });
    throw reason;
  });

  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
    const onSignal = () => {
      record({ event: 'signal', at: new Date().toISOString(), signal, ...snapshot() });
      // Removed first, or re-raising re-enters this listener instead of reaching the default.
      target.removeListener(signal, onSignal);
      try {
        target.kill(target.pid, signal);
      } catch {
        target.exit(SIGNAL_EXIT_CODES[signal] ?? 1);
      }
    };
    target.once(signal, onSignal);
  }

  target.once('exit', (code: number) => {
    if (!finished) {
      record({ event: 'exit-before-ready', at: new Date().toISOString(), code, ...snapshot() });
    }
  });
}

/**
 * The `[knowl serve]` line, before and after the root is known.
 *
 * Two lines rather than one because the database open moved off the handshake: the first
 * prints immediately and proves the process is alive and talking, and the root it cannot
 * know yet arrives on the second. Losing the root entirely was not an option -- it is how
 * you tell which repository a serve process in a host log belongs to, and a log full of
 * anonymous processes is worse than the stall this was meant to diagnose.
 */
export function serveBanner(state: {
  pid: number;
  projectRoot: string | null;
  readyMs?: number;
  /** True when serve created the store itself because nothing had run `knowl init` here. */
  autoInitialized?: boolean;
}): string {
  return [
    '[knowl serve]',
    `pid=${state.pid}`,
    state.projectRoot ? `projectRoot=${state.projectRoot}` : 'projectRoot=pending',
    // Announced so a host log shows the store was serve's own doing -- the difference between
    // "found your repository" and "made one here", which matters the day it made one in the
    // wrong directory. KNOWL_SERVE_AUTO_INIT=0 disables the behavior.
    state.autoInitialized ? 'auto-initialized' : null,
    state.readyMs === undefined ? null : `ready=${state.readyMs}ms`,
    state.projectRoot
      ? null
      : 'note=host-owned stdio process; one serve process per connected host session; hooks use agent-hook and do not spawn serve',
  ].filter(Boolean).join(' ');
}

/** Time one named startup phase, and make it the phase a watchdog would report. */
export async function tracePhase<T>(name: string, run: () => Promise<T>): Promise<T> {
  if (!enabled() || !active) return run();
  const phase: Phase = { name, startedAt: now() };
  phases.push(phase);
  current = phase;
  try {
    return await run();
  } finally {
    phase.endedAt = now();
    if (current === phase) current = null;
  }
}

/** Called once per process when the embedding pipeline is actually built. */
export function noteModelLoad(model: string, cached: boolean, ms: number): void {
  if (!enabled()) return;
  modelLoad = { model, cached, ms };
  append({
    event: 'model-load',
    at: new Date().toISOString(),
    bootId: bootId || null,
    pid: process.pid,
    model,
    cached,
    ms,
    // Whether a model load ever lands on the connect deadline is the question that decides
    // whether the model can be responsible for a failed handshake at all.
    afterReady: finished,
    sinceBootMs: bootStartedAt ? elapsed() : null,
  });
}

/** The handshake completed. Records the full phase breakdown and silences the watchdogs. */
export function finishStartupTrace(outcome: { ok: boolean; initError?: string | null; vectorModel?: string | null }): void {
  if (!enabled() || !active || finished) return;
  finished = true;
  for (const timer of timers) clearTimeout(timer);
  timers = [];

  const totalMs = elapsed();
  const record = {
    event: 'boot-end',
    at: new Date().toISOString(),
    bootId,
    pid: process.pid,
    totalMs,
    ok: outcome.ok,
    initError: outcome.initError ?? null,
    vectorModel: outcome.vectorModel ?? null,
    phases: phases.map(p => ({ name: p.name, ms: (p.endedAt ?? now()) - p.startedAt })),
    modelLoad,
  };
  append(record);

  // Only speak up on stderr when the boot was slow enough to be worth explaining. The host
  // renders every stderr line as an error, so a healthy boot stays quiet.
  if (totalMs >= 5_000) {
    emitStderr(
      `[knowl serve] SLOW-BOOT ${totalMs}ms bootId=${bootId} ` +
      record.phases.map(p => `${p.name}=${p.ms}ms`).join(' ')
    );
  }
}
