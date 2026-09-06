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
});
