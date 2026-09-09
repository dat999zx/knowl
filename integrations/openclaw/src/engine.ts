import path from 'node:path';
import { createClient } from '@libsql/client';
import {
  canonicalProjectRoot,
  openProject,
  KNOWL_MIGRATION_LEVEL,
  type ProjectHandle,
} from '@dat999zx/knowl/plugin';

export interface HostLogger {
  warn(message: string, ...args: unknown[]): void;
  error?(message: string, ...args: unknown[]): void;
  info?(message: string, ...args: unknown[]): void;
  debug?(message: string, ...args: unknown[]): void;
}

export const DEFAULT_GATE_DEADLINE_MS = 5_000;
export const DEFAULT_OBSERVER_DEADLINE_MS = 10_000;

/**
 * Run an async operation bounded by a deadline.
 *
 * If the operation does not finish within `ms`, `fallback` is returned.
 * Used by the write gate so a slow or stalled engine never blocks a user's
 * write under OpenClaw's 15-second fail-closed host budget.
 */
export async function withDeadline<T>(
  ms: number,
  work: () => Promise<T>,
  fallback: T,
  onTimeout?: () => void,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<T>((resolve) => {
    timer = setTimeout(() => {
      onTimeout?.();
      resolve(fallback);
    }, ms);
  });

  try {
    return await Promise.race([
      work().then((result) => {
        if (timer) clearTimeout(timer);
        return result;
      }),
      timeoutPromise,
    ]);
  } catch (error) {
    if (timer) clearTimeout(timer);
    throw error;
  }
}

/**
 * Execute an async operation safely without floating promises or leaking rejections.
 *
 * Node's default --unhandled-rejections=throw will terminate the gateway if an unhandled
 * rejection escapes. Every hook handler must await inside its own try/catch.
 * `safely` guarantees that any failure is logged through the host logger and swallowed,
 * returning `fallback` instead of rethrowing.
 */
export async function safely<T>(
  work: () => Promise<T>,
  logger?: HostLogger,
  fallback?: T,
): Promise<T | undefined> {
  try {
    return await work();
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (logger?.warn) {
      logger.warn(`[knowl] Swallowed engine failure: ${message}`, err);
    } else {
      console.warn(`[knowl] Swallowed engine failure: ${message}`);
    }
    return fallback;
  }
}

/**
 * Check the database's migration level (application_id).
 *
 * Returns true if the file is supported (level <= KNOWL_MIGRATION_LEVEL),
 * or false with the found level if the file was written by a newer Knowl version.
 */
export async function checkMigrationLevel(
  dbPath: string,
): Promise<{ supported: boolean; found: number; maxSupported: number }> {
  const client = createClient({ url: `file:${dbPath}` });
  try {
    const res = await client.execute('PRAGMA application_id');
    const found = Number(res.rows[0]?.application_id ?? 0);
    return {
      supported: found <= KNOWL_MIGRATION_LEVEL,
      found,
      maxSupported: KNOWL_MIGRATION_LEVEL,
    };
  } finally {
    client.close();
  }
}

/**
 * Is `candidate` the directory `root`, or a directory inside it?
 *
 * `String.prototype.startsWith` is not this question and never was. It has no separator
 * boundary, so on a machine holding `C:/Code/knowl` and `C:/Code/knowl-cloud` -- an ordinary
 * pair, since a project and its satellite share a prefix by convention -- the second answers
 * true against the first. The handle that answer selects carries query, the write gate and
 * lifecycle capture, so a hook fired in one repository reads the other's atoms, is judged
 * against the other's constraints, and writes capture rows into the other's store, with every
 * layer reporting success.
 *
 * `canonicalProjectRoot` is the folding the engine already applies to a path used as a key:
 * `path.resolve` plus a case fold on Windows only, because a hook payload's `cwd` reports
 * `D:\project` where `process.cwd()` reports `d:\project`, while POSIX paths are genuinely
 * case-sensitive and must not be folded together. `path.relative` then supplies the separator
 * boundary that the string comparison lacked: a sibling yields a relative path that climbs out.
 */
export function pathIsWithin(root: string, candidate: string): boolean {
  if (!root || !candidate) return false;
  const canonicalRoot = canonicalProjectRoot(root);
  const canonicalCandidate = canonicalProjectRoot(candidate);
  if (canonicalRoot === canonicalCandidate) return true;
  const relative = path.relative(canonicalRoot, canonicalCandidate);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

/**
 * Manages project handles across multiple workspaces in an in-process OpenClaw gateway.
 *
 * Handles are keyed by resolved project root.
 * Workspaces are warmed at `session_start` so the first write gate never pays cold initialization.
 * Handles are cleanly released on `gateway_stop` without calling `closeDb()`.
 */
export class OpenClawEngineManager {
  private handles = new Map<string, ProjectHandle>();
  private disabledRoots = new Map<string, string>();
  private logger?: HostLogger;
  private gateDeadlineMs: number;
  private observerDeadlineMs: number;

  constructor(options: { logger?: HostLogger; gateDeadlineMs?: number; observerDeadlineMs?: number } = {}) {
    this.logger = options.logger;
    this.gateDeadlineMs = options.gateDeadlineMs ?? DEFAULT_GATE_DEADLINE_MS;
    this.observerDeadlineMs = options.observerDeadlineMs ?? DEFAULT_OBSERVER_DEADLINE_MS;
  }

  isDisabled(projectRoot: string): boolean {
    return this.disabledRoots.has(projectRoot);
  }

  getDisabledReason(projectRoot: string): string | undefined {
    return this.disabledRoots.get(projectRoot);
  }

  async getHandle(cwd: string): Promise<ProjectHandle | null> {
    const cached = this.findCachedHandle(cwd);
    if (cached) return cached;
    return await this.warmWorkspace(cwd);
  }

  /**
   * The open handle whose project root contains `cwd`, preferring the LONGEST such root.
   *
   * First-match-wins is the wrong answer for nested repositories, and the map's order is warm
   * order rather than depth order: a monorepo at `C:/Code/mono` and a project of its own at
   * `C:/Code/mono/packages/api` both contain a file under the second, and the file belongs to
   * the repository that owns it, not to whichever of the two the gateway happened to open
   * first. Longest wins, which is the same rule `findProjectRoot` applies when it walks up from
   * a directory and stops at the nearest marker.
   */
  private findCachedHandle(cwd: string): ProjectHandle | undefined {
    let best: ProjectHandle | undefined;
    let bestLength = -1;
    for (const handle of this.handles.values()) {
      if (!pathIsWithin(handle.projectRoot, cwd)) continue;
      const length = canonicalProjectRoot(handle.projectRoot).length;
      if (length > bestLength) {
        best = handle;
        bestLength = length;
      }
    }
    return best;
  }

  async warmWorkspace(cwd: string): Promise<ProjectHandle | null> {
    if (this.disabledRoots.has(cwd)) {
      return null;
    }

    let handle: ProjectHandle | null;
    try {
      handle = await openProject(cwd);
    } catch (err: unknown) {
      this.logger?.warn?.(`[knowl] Failed to open project at ${cwd}: ${err}`);
      return null;
    }

    if (!handle) return null;

    const root = handle.projectRoot;
    if (this.disabledRoots.has(root)) {
      await handle.release();
      return null;
    }

    if (this.handles.has(root)) {
      await handle.release();
      return this.handles.get(root)!;
    }

    // Check migration level of the opened database
    try {
      const migration = await checkMigrationLevel(handle.databasePath);
      if (!migration.supported) {
        const reason =
          `The knowledge database at "${handle.databasePath}" has migration level ${migration.found}, ` +
          `which is newer than this plugin supports (max level ${migration.maxSupported}). ` +
          `Please upgrade the Knowl plugin.`;
        this.disabledRoots.set(root, reason);
        this.logger?.warn?.(`[knowl] Disabling plugin for workspace ${root}: ${reason}`);
        await handle.release();
        return null;
      }
    } catch (err: unknown) {
      // Fail CLOSED, and not sticky.
      //
      // This branch means the level could not be READ -- on Windows a concurrent `knowl serve`
      // holding the file is the ordinary cause -- so the one thing actually known is that the
      // database is unverified. Warning and continuing to `handles.set` defeated the check
      // entirely: an older plugin writing into a store a newer Knowl migrated finds every table
      // it expects, because the schema is `CREATE TABLE IF NOT EXISTS` plus additive `ALTER`s,
      // and then writes rows the newer schema's invariants do not hold for. Nothing reports it.
      //
      // The root is deliberately NOT added to `disabledRoots`: a lock clears. A transient
      // failure costs this warm attempt, and the next hook in that workspace tries again --
      // where the sticky list is for the one condition that cannot resolve itself, a database
      // stamped past what this plugin understands.
      this.logger?.warn?.(
        `[knowl] Could not verify the migration level of "${handle.databasePath}", so this workspace ` +
        `is not being opened. Knowl will try again on the next event: ${err}`,
      );
      await safely(() => handle.release(), this.logger);
      return null;
    }

    this.handles.set(root, handle);
    return handle;
  }

  async releaseWorkspace(cwd: string): Promise<void> {
    // Same containment test as `findCachedHandle`, and for the same reason: released by string
    // prefix, closing a session in `knowl-cloud` also tore down the live handle for `knowl`.
    const matching = Array.from(this.handles.entries()).filter(
      ([root]) => pathIsWithin(root, cwd),
    );
    for (const [root, handle] of matching) {
      this.handles.delete(root);
      await safely(() => handle.release(), this.logger);
    }
  }

  async releaseAll(): Promise<void> {
    const all = Array.from(this.handles.values());
    this.handles.clear();
    for (const handle of all) {
      await safely(() => handle.release(), this.logger);
    }
  }

  getGateDeadlineMs(): number {
    return this.gateDeadlineMs;
  }

  getObserverDeadlineMs(): number {
    return this.observerDeadlineMs;
  }
}
