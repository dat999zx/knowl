import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, getClient, initDb } from '../../src/store/database.js';
import { releaseAll } from '../../src/store/connection-pool.js';
import { listStaged, publishedVersion, recordPushed, stageForPublish } from '../../src/cloud/ledger.js';
import { excludeFromPublish } from '../../src/cloud/exclusions.js';
import { maybeAutoStage } from '../../src/cloud/auto-stage.js';
import type { ProjectConfig } from '../../src/core/types.js';

const ROOT = path.resolve('./.knowl-auto-stage-root');
const WS = 'ws-auto';

const connected = (overrides: Record<string, unknown> = {}): ProjectConfig => ({
  version: 1,
  cloud: {
    apiHost: 'https://api.example.com', workspaceId: WS,
    repo: 'github.com/acme/web', remote: 'origin',
    ...overrides,
  },
} as ProjectConfig);

describe('maybeAutoStage', () => {
  beforeEach(async () => {
    await closeDb().catch(() => {});
    await releaseAll();
    await fs.rm(ROOT, { recursive: true, force: true }).catch(() => {});
    await fs.mkdir(path.join(ROOT, '.knowl'), { recursive: true });
    await fs.writeFile(path.join(ROOT, '.knowl', 'config.json'), JSON.stringify({ version: 1 }), 'utf8');
    await initDb(ROOT);
    await getClient().execute('DELETE FROM cloud_published');
    await getClient().execute('DELETE FROM cloud_excluded');
  });

  afterEach(async () => {
    await closeDb().catch(() => {});
    await releaseAll();
    await fs.rm(ROOT, { recursive: true, force: true }).catch(() => {});
  });

  it('stages a new atom in a connected repo', async () => {
    await maybeAutoStage({ projectRoot: ROOT, config: connected(), itemId: 'a', alreadyPublished: false });
    expect((await listStaged(WS)).map(row => row.itemId)).toEqual(['a']);
  });

  it('stages nothing when the repo is not connected', async () => {
    await maybeAutoStage({ projectRoot: ROOT, config: { version: 1 }, itemId: 'a', alreadyPublished: false });
    expect(await listStaged(WS)).toEqual([]);
  });

  it('stages nothing when autoStage is off', async () => {
    await maybeAutoStage({
      projectRoot: ROOT, config: connected({ autoStage: false }), itemId: 'a', alreadyPublished: false,
    });
    expect(await listStaged(WS)).toEqual([]);
  });

  it('stages nothing for an excluded atom', async () => {
    await excludeFromPublish('a', 'machine-local');
    await maybeAutoStage({ projectRoot: ROOT, config: connected(), itemId: 'a', alreadyPublished: false });
    expect(await listStaged(WS)).toEqual([]);
  });

  it('stages nothing for a session-namespace write', async () => {
    await maybeAutoStage({
      projectRoot: ROOT, config: connected(), itemId: 'a', namespace: 'session', alreadyPublished: false,
    });
    expect(await listStaged(WS)).toEqual([]);
  });

  it('re-stages a published atom as a correction, preserving its version', async () => {
    await stageForPublish(['a'], WS, 'main');
    await recordPushed('a', WS, 5);

    await maybeAutoStage({ projectRoot: ROOT, config: connected(), itemId: 'a', alreadyPublished: true });

    expect((await listStaged(WS)).map(row => row.itemId)).toEqual(['a']);
    expect(await publishedVersion('a', WS)).toBe(5);
  });

  it('never throws, whatever goes wrong underneath', async () => {
    // The write that triggered this already committed. Reporting a failure here would tell the
    // caller to retry something that worked.
    await expect(maybeAutoStage({
      projectRoot: ROOT,
      config: connected({ workspaceId: null }),
      itemId: 'a',
      alreadyPublished: false,
    })).resolves.toBeUndefined();
  });
});
