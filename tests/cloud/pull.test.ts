import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { writeCredential } from '../../src/cloud/credentials.js';
import { runPull } from '../../src/cloud/pull.js';
import type { ProjectConfig } from '../../src/core/types.js';
import type { CloudApi } from '../../src/cloud/api-client.js';
import type { SyncPage } from '../../src/cloud/sync-contract.js';

const HOME = path.resolve('./.knowl-pull-home');
const ROOT = path.resolve('./.knowl-pull-root');
const HOST = 'https://api.knowl.test';

const wipe = (dir: string) =>
  fs.rm(dir, { recursive: true, force: true, maxRetries: 2, retryDelay: 25 }).catch(() => {});

const connected: ProjectConfig = {
  version: 1,
  cloud: { apiHost: HOST, workspaceId: 'ws-5', workspaceName: 'Acme', repo: 'github.com/acme/web', remote: 'origin' },
};

const emptyPage: SyncPage = { rows: [], cursor: null, nextSeq: '3', role: 'reader', resyncRequired: false };

const api = (page: SyncPage = emptyPage) => ({
  startDeviceAuthorization: async () => { throw new Error('unused'); },
  pollForToken: async () => 'pending' as const,
  refresh: async () => { throw new Error('unused'); },
  listWorkspaces: async () => [],
  fetchSyncPage: async () => page,
}) as unknown as CloudApi;

describe('runPull', () => {
  beforeAll(async () => {
    process.env.KNOWL_HOME = HOME;
    for (const dir of [HOME, ROOT]) await wipe(dir);
    await fs.mkdir(path.join(ROOT, '.knowl'), { recursive: true });
    await fs.writeFile(path.join(ROOT, '.knowl', 'config.json'), JSON.stringify({ version: 1 }), 'utf8');
  });
  afterAll(async () => {
    delete process.env.KNOWL_HOME;
    for (const dir of [HOME, ROOT]) await wipe(dir);
  });

  it('says so when the repo is not connected, rather than doing nothing quietly', async () => {
    expect(await runPull({ projectRoot: ROOT, config: { version: 1 }, api: api() }))
      .toEqual({ status: 'not-connected' });
  });

  it('refuses before the network when nobody is signed in', async () => {
    expect(await runPull({ projectRoot: ROOT, config: connected, api: api() }))
      .toEqual({ status: 'not-logged-in' });
  });

  it('syncs when connected and signed in', async () => {
    await writeCredential(HOST, {
      accessToken: 'a', refreshToken: 'r', sessionId: 'sess-1',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    });

    const result = await runPull({ projectRoot: ROOT, config: connected, api: api() });

    expect(result).toMatchObject({ status: 'pulled', sync: { status: 'synced', since: '3' } });
  });
});
