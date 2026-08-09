import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeCredential } from '../../src/cloud/credentials.js';
import { cloudDoctorChecks } from '../../src/cloud/doctor-checks.js';
import { withTeamStore } from '../../src/cloud/team-store.js';
import { writeSyncState } from '../../src/cloud/sync-state.js';
import type { ProjectConfig } from '../../src/core/types.js';

const HOME = path.resolve('./.knowl-doctor-home');
const ROOT = path.resolve('./.knowl-doctor-root');
const HOST = 'https://api.knowl.test';
const NOW = Date.parse('2026-08-09T12:00:00.000Z');

const pointer = (workspaceId: string): ProjectConfig => ({
  version: 1,
  cloud: { apiHost: HOST, workspaceId, workspaceName: 'Acme', repo: 'github.com/acme/web', remote: 'origin' },
});

const connected = pointer('w1');

const wipe = (dir: string) =>
  fs.rm(dir, { recursive: true, force: true, maxRetries: 2, retryDelay: 25 }).catch(() => {});

describe('cloudDoctorChecks', () => {
  beforeEach(async () => {
    process.env.KNOWL_HOME = HOME;
    await wipe(HOME);
    await fs.mkdir(path.join(ROOT, '.knowl'), { recursive: true });
    await fs.writeFile(path.join(ROOT, '.knowl', 'config.json'), JSON.stringify({ version: 1 }), 'utf8');
  });
  afterEach(async () => {
    delete process.env.KNOWL_HOME;
    await wipe(HOME);
  });

  /** A synced replica, so the credential cases are not answered by the never-synced branch. */
  const synced = async (workspaceId: string, lastError: string | null = null) => {
    await withTeamStore(workspaceId, ROOT, () => writeSyncState({
      apiHost: HOST,
      since: '7',
      cursor: null,
      lastSyncedAt: '2026-08-09T11:00:00.000Z',
      lastError,
    }));
  };

  it('says nothing at all when the repo is not connected', async () => {
    // Knowl is local-first. A repo that never opted into the cloud must not be told about it
    // on every doctor run.
    expect(await cloudDoctorChecks({ version: 1 }, ROOT)).toEqual([]);
  });

  it('warns when connected but not signed in, and says how to fix it', async () => {
    const checks = await cloudDoctorChecks(connected, ROOT, () => NOW);

    expect(checks).toHaveLength(1);
    expect(checks[0].status).toBe('WARN');
    expect(checks[0].fix).toContain('knowl login');
  });

  it('reports OK when connected, signed in and synced', async () => {
    const config = pointer('w-ok');
    await writeCredential(HOST, {
      accessToken: 'a', refreshToken: 'r', sessionId: 'sess-1',
      expiresAt: new Date(NOW + 3_600_000).toISOString(),
    });
    await synced('w-ok');

    const checks = await cloudDoctorChecks(config, ROOT, () => NOW);

    expect(checks[0].status).toBe('OK');
    expect(checks[0].message).toContain('github.com/acme/web');
    expect(checks[0].message).toContain('Acme');
  });

  it('reports OK on an expired access token, because a refresh token still recovers it', async () => {
    // An expired ACCESS token is the ordinary steady state between refreshes. Calling it a
    // problem would make doctor cry wolf on every run more than an hour after login.
    const config = pointer('w-expired');
    await writeCredential(HOST, {
      accessToken: 'a', refreshToken: 'r', sessionId: 'sess-1',
      expiresAt: new Date(NOW - 3_600_000).toISOString(),
    });
    await synced('w-expired');

    const checks = await cloudDoctorChecks(config, ROOT, () => NOW);

    expect(checks[0].status).toBe('OK');
  });

  it('warns that the replica has never been synced', async () => {
    // WARN rather than FAIL: the repo is correctly configured and one command away from
    // working, so this is a next step rather than a fault.
    await writeCredential(HOST, {
      accessToken: 'a', refreshToken: 'r', sessionId: 'sess-1',
      expiresAt: new Date(NOW + 3_600_000).toISOString(),
    });

    const checks = await cloudDoctorChecks(pointer('w-never'), ROOT, () => NOW);

    expect(checks[0].status).toBe('WARN');
    expect(checks[0].message).toContain('never synced');
    expect(checks[0].fix).toContain('knowl cloud pull');
  });

  it('warns and names the reason when the last sync failed', async () => {
    // Still WARN, not FAIL: the replica remains readable, just older than the caller may
    // assume, and saying why is the whole point of recording the error.
    await writeCredential(HOST, {
      accessToken: 'a', refreshToken: 'r', sessionId: 'sess-1',
      expiresAt: new Date(NOW + 3_600_000).toISOString(),
    });
    await synced('w-failed', 'network down');

    const checks = await cloudDoctorChecks(pointer('w-failed'), ROOT, () => NOW);

    expect(checks[0].status).toBe('WARN');
    expect(checks[0].message).toContain('network down');
    expect(checks[0].fix).toContain('knowl cloud pull');
  });

  it('makes no network call, so doctor stays fast and works offline', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (() => { throw new Error('doctor must not reach the network'); }) as typeof fetch;
    try {
      await expect(cloudDoctorChecks(connected, ROOT, () => NOW)).resolves.toBeDefined();
    } finally {
      globalThis.fetch = original;
    }
  });
});
