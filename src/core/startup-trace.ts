import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { knowlHome } from '../workspace/paths.js';

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
 * Append one record. Synchronous on purpose: this is called from watchdogs and exit handlers,
 * where an async write may never flush before the process dies -- which is precisely the
 * record worth keeping.
 */
function append(record: Record<string, unknown>): void {
  try {
    fs.mkdirSync(diagnosticsDir(), { recursive: true });
    fs.appendFileSync(startupLogPath(), JSON.stringify(record) + '\n');
  } catch {
    // A diagnostic must never be the reason a server fails to start.
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
    projectRoot: context.projectRoot ?? process.cwd(),
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

  // How the process actually died. "Killed by the host at the deadline" and "crashed during
  // bootstrap" look identical from the outside, and they need opposite fixes.
  process.once('uncaughtException', (error) => {
    append({ event: 'crash', at: new Date().toISOString(), kind: 'uncaughtException', message: String(error?.message ?? error), ...snapshot() });
    throw error;
  });
  process.once('unhandledRejection', (reason) => {
    append({ event: 'crash', at: new Date().toISOString(), kind: 'unhandledRejection', message: String(reason), ...snapshot() });
  });
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
    process.once(signal, () => {
      append({ event: 'signal', at: new Date().toISOString(), signal, ...snapshot() });
      process.exit(0);
    });
  }
  process.once('exit', (code) => {
    if (!finished) {
      append({ event: 'exit-before-ready', at: new Date().toISOString(), code, ...snapshot() });
    }
  });
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
