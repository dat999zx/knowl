import { createClient } from '@libsql/client';
import {
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
    const cached = Array.from(this.handles.values()).find((h) => cwd.startsWith(h.projectRoot));
    if (cached) return cached;
    return await this.warmWorkspace(cwd);
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
      this.logger?.warn?.(`[knowl] Could not verify migration level for ${handle.databasePath}: ${err}`);
    }

    this.handles.set(root, handle);
    return handle;
  }

  async releaseWorkspace(cwd: string): Promise<void> {
    const matching = Array.from(this.handles.entries()).filter(
      ([root]) => cwd === root || cwd.startsWith(root),
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
