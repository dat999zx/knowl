import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createClient } from '@libsql/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  OpenClawEngineManager,
  checkMigrationLevel,
  safely,
  withDeadline,
  type HostLogger,
} from '../../../integrations/openclaw/src/engine.js';
import { KNOWL_MIGRATION_LEVEL } from '@dat999zx/knowl/plugin';
// Namespaced as well as named, because the guard tests below stub `openProject` on the module
// object: the manager reaches it through this same binding, so a spy installed here is the one
// it calls.
import * as pluginModule from '@dat999zx/knowl/plugin';

const CLI_PATH = path.resolve('dist/index.js');

describe('OpenClaw engine wrapper failure modes', () => {
  let scratchDir: string;

  beforeEach(async () => {
    scratchDir = path.join(os.tmpdir(), `knowl-engine-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await fs.mkdir(scratchDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(scratchDir, { recursive: true, force: true }).catch(() => {});
  });

  it('safely catches a throwing engine call, logs it, and returns fallback without rethrowing', async () => {
    const logger: HostLogger = {
      warn: vi.fn(),
      error: vi.fn(),
    };

    const throwingEngineCall = async () => {
      throw new Error('LibSQL disk I/O error or engine crash');
    };

    const fallback = { block: false };
    const result = await safely(throwingEngineCall, logger, fallback);

    expect(result).toBe(fallback);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Swallowed engine failure: LibSQL disk I/O error or engine crash'),
      expect.any(Error),
    );
  });

  it('safely prevents floated rejections from escaping and crashing Node', async () => {
    const logger: HostLogger = {
      warn: vi.fn(),
    };

    let rejectedPromiseSettled = false;
    const floatedPromiseFn = () =>
      new Promise<void>((_, reject) => {
        setTimeout(() => {
          rejectedPromiseSettled = true;
          reject(new Error('Delayed async explosion'));
        }, 10);
      });

    const result = await safely(floatedPromiseFn, logger, 'swallowed');
    expect(rejectedPromiseSettled).toBe(true);
    expect(result).toBe('swallowed');
    expect(logger.warn).toHaveBeenCalled();
  });

  it('hanging engine: withDeadline fires and accepts the write before the host budget expires', async () => {
    let timeoutFired = false;
    const hangingEngineWork = () =>
      new Promise<{ block: boolean }>((_resolve) => {
        // Stalled indefinitely: simulating an SQLite lock hang or cold model stall
      });

    const fallback = { block: false };
    const start = Date.now();
    const decision = await withDeadline(
      50,
      hangingEngineWork,
      fallback,
      () => {
        timeoutFired = true;
      },
    );
    const duration = Date.now() - start;

    expect(decision).toEqual({ block: false });
    expect(timeoutFired).toBe(true);
    expect(duration).toBeLessThan(1_000);
  });

  it('stale migration level: disables plugin for workspace when database level exceeds bundled engine', async () => {
    const projectDir = path.join(scratchDir, 'stale-migration-repo');
    await fs.mkdir(projectDir, { recursive: true });

    // Initialize real repo
    execFileSync(process.execPath, [CLI_PATH, 'init', '--yes'], { cwd: projectDir, encoding: 'utf8' });

    // Stamp application_id to a newer migration level
    const dbPath = path.join(projectDir, '.knowl', 'knowl.db');
    const newerLevel = KNOWL_MIGRATION_LEVEL + 5;
    const rawClient = createClient({ url: `file:${dbPath}` });
    await rawClient.execute(`PRAGMA application_id = ${newerLevel}`);
    rawClient.close();

    // Check migration check helper
    const check = await checkMigrationLevel(dbPath);
    expect(check.supported).toBe(false);
    expect(check.found).toBe(newerLevel);
    expect(check.maxSupported).toBe(KNOWL_MIGRATION_LEVEL);

    // Engine manager should refuse and disable workspace
    const logger: HostLogger = { warn: vi.fn() };
    const manager = new OpenClawEngineManager({ logger });

    const handle = await manager.warmWorkspace(projectDir);
    expect(handle).toBeNull();
    expect(manager.isDisabled(projectDir)).toBe(true);
    expect(manager.getDisabledReason(projectDir)).toContain(`migration level ${newerLevel}`);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining(`Disabling plugin for workspace`),
    );

    // Subsequent handle request returns null immediately without attempting to open
    const cachedAttempt = await manager.getHandle(projectDir);
    expect(cachedAttempt).toBeNull();
  });

  it('getHandle does not let a sibling directory that shares a prefix capture the lookup', async () => {
    const dirKnowl = path.join(scratchDir, 'knowl');
    const dirKnowlCloud = path.join(scratchDir, 'knowl-cloud');
    await fs.mkdir(dirKnowl, { recursive: true });
    await fs.mkdir(dirKnowlCloud, { recursive: true });

    execFileSync(process.execPath, [CLI_PATH, 'init', '--yes'], { cwd: dirKnowl, encoding: 'utf8' });
    execFileSync(process.execPath, [CLI_PATH, 'init', '--yes'], { cwd: dirKnowlCloud, encoding: 'utf8' });

    const manager = new OpenClawEngineManager();
    try {
      await manager.warmWorkspace(dirKnowl);

      const h = await manager.getHandle(dirKnowlCloud);
      expect(h).toBeDefined();
      expect(path.resolve(h!.projectRoot)).toBe(path.resolve(dirKnowlCloud));

      const dirKnowlSrc = path.join(dirKnowl, 'src');
      await fs.mkdir(dirKnowlSrc, { recursive: true });

      const hNested = await manager.getHandle(dirKnowlSrc);
      expect(hNested).toBeDefined();
      expect(path.resolve(hNested!.projectRoot)).toBe(path.resolve(dirKnowl));
    } finally {
      await manager.releaseAll();
    }
  });
});

describe('OpenClaw engine manager: an unverifiable database is not opened', () => {
  let scratchDir: string;
  let released: string[];
  let opened: number;

  beforeEach(async () => {
    scratchDir = path.join(os.tmpdir(), `knowl-openclaw-guard-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await fs.mkdir(scratchDir, { recursive: true });
    // Created as a DIRECTORY on purpose: libSQL refuses to open a connection to it, the same
    // rejection a locked store produces, and a path that simply does not exist would be
    // created as an empty database instead.
    await fs.mkdir(path.join(scratchDir, 'not-a-database'), { recursive: true });
    released = [];
    opened = 0;
    vi.spyOn(pluginModule, 'openProject').mockImplementation(async (cwd: string) => {
      opened += 1;
      return {
        projectRoot: cwd,
        // A directory rather than a database file, so opening it fails the way a locked one
        // does: `PRAGMA application_id` never returns an answer. On Windows a concurrent
        // `knowl serve` holding the store is the ordinary cause, which is what made the old
        // fail-open branch the common path rather than the rare one.
        databasePath: path.join(scratchDir, 'not-a-database'),
        lifecycle: async () => ({ accepted: true }) as never,
        query: async () => [],
        store: async () => ({ action: 'created' }) as never,
        release: async () => {
          released.push(cwd);
        },
      } satisfies ProjectHandle;
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(scratchDir, { recursive: true, force: true }).catch(() => {});
  });

  it('refuses the workspace and releases the handle when the migration level cannot be read', async () => {
    const logger: HostLogger = { warn: vi.fn() };
    const manager = new OpenClawEngineManager({ logger });
    const projectDir = path.join(scratchDir, 'repo');
    await fs.mkdir(projectDir, { recursive: true });

    expect(await manager.warmWorkspace(projectDir)).toBeNull();
    expect(released).toEqual([projectDir]);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Could not verify the migration level'));
  });

  it('does not cache the unverified handle, so a later hook is not answered from it', async () => {
    const manager = new OpenClawEngineManager({ logger: { warn: vi.fn() } });
    const projectDir = path.join(scratchDir, 'repo');
    await fs.mkdir(projectDir, { recursive: true });

    await manager.warmWorkspace(projectDir);
    expect(await manager.getHandle(projectDir)).toBeNull();
    expect(await manager.getHandle(path.join(projectDir, 'src'))).toBeNull();
  });

  it('is not sticky: the workspace is retried once the database can be read again', async () => {
    const manager = new OpenClawEngineManager({ logger: { warn: vi.fn() } });
    const projectDir = path.join(scratchDir, 'repo');
    await fs.mkdir(projectDir, { recursive: true });

    expect(await manager.warmWorkspace(projectDir)).toBeNull();
    expect(manager.isDisabled(projectDir)).toBe(false);
    // A lock clears, so the next event opens the project again rather than finding the
    // workspace permanently switched off -- which is what `disabledRoots` is for, and it is
    // reserved for the one condition that cannot resolve itself.
    await manager.getHandle(projectDir);
    expect(opened).toBe(2);
  });
});

