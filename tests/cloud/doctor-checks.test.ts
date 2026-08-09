import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeCredential } from '../../src/cloud/credentials.js';
import { cloudDoctorChecks } from '../../src/cloud/doctor-checks.js';
import type { ProjectConfig } from '../../src/core/types.js';

const HOME = path.resolve('./.knowl-doctor-home');
const HOST = 'https://api.knowl.dev';
const NOW = Date.parse('2026-08-09T12:00:00.000Z');

const connected: ProjectConfig = {
  version: 1,
  cloud: { apiHost: HOST, workspaceId: 'w1', workspaceName: 'Acme', repo: 'github.com/acme/web', remote: 'origin' },
};

describe('cloudDoctorChecks', () => {
  beforeEach(async () => {
    process.env.KNOWL_HOME = HOME;
    await fs.rm(HOME, { recursive: true, force: true }).catch(() => {});
  });
  afterEach(async () => {
    delete process.env.KNOWL_HOME;
    await fs.rm(HOME, { recursive: true, force: true }).catch(() => {});
  });

  it('says nothing at all when the repo is not connected', async () => {
    // Knowl is local-first. A repo that never opted into the cloud must not be told about it
    // on every doctor run.
    expect(await cloudDoctorChecks({ version: 1 })).toEqual([]);
  });

  it('warns when connected but not signed in, and says how to fix it', async () => {
    const checks = await cloudDoctorChecks(connected, () => NOW);

    expect(checks).toHaveLength(1);
    expect(checks[0].status).toBe('WARN');
    expect(checks[0].fix).toContain('knowl login');
  });

  it('reports OK when connected and holding a live credential', async () => {
    await writeCredential(HOST, {
      accessToken: 'a', refreshToken: 'r', userId: 'u',
      expiresAt: new Date(NOW + 3_600_000).toISOString(),
    });

    const checks = await cloudDoctorChecks(connected, () => NOW);

    expect(checks[0].status).toBe('OK');
    expect(checks[0].message).toContain('github.com/acme/web');
    expect(checks[0].message).toContain('Acme');
  });

  it('reports OK on an expired access token, because a refresh token still recovers it', async () => {
    // An expired ACCESS token is the ordinary steady state between refreshes. Calling it a
    // problem would make doctor cry wolf on every run more than an hour after login.
    await writeCredential(HOST, {
      accessToken: 'a', refreshToken: 'r', userId: 'u',
      expiresAt: new Date(NOW - 3_600_000).toISOString(),
    });

    const checks = await cloudDoctorChecks(connected, () => NOW);

    expect(checks[0].status).toBe('OK');
  });

  it('makes no network call, so doctor stays fast and works offline', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (() => { throw new Error('doctor must not reach the network'); }) as typeof fetch;
    try {
      await expect(cloudDoctorChecks(connected, () => NOW)).resolves.toBeDefined();
    } finally {
      globalThis.fetch = original;
    }
  });
});
