import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { NormalizedHostHook } from '../../src/cli/agents/host-hook.js';
import { closeDb, initDb } from '../../src/store/database.js';
import { releaseAll } from '../../src/store/connection-pool.js';
import { DEFAULT_CONFIG, saveConfig } from '../../src/core/config.js';
import { handleHostLifecycleEvent } from '../../src/session/host-lifecycle.js';
import * as repo from '../../src/store/repository.js';
import { checkForUpdate, markUpdateNotified, readCachedUpdate } from '../../src/core/version-check.js';
import { PACKAGE_VERSION } from '../../src/version.js';

/**
 * The update notice on the session-start card: read from the cache the server refreshes, never
 * fetched on the hook path, and shown once per release.
 */
let nextRoot = 0;
const ROOTS: string[] = [];

const hook = (root: string): NormalizedHostHook => ({
  host: 'claude',
  event: 'session-start',
  externalSessionId: `session-${nextRoot}`,
  externalTurnId: undefined,
  projectRoot: root,
  payload: {},
});

async function withRepo(options: { updateCheck?: boolean; latest?: string } = {}) {
  const root = path.resolve(`./.knowl-update-notice-${nextRoot += 1}`);
  ROOTS.push(root);
  await closeDb();
  await releaseAll();
  await fs.mkdir(path.join(root, '.knowl', 'cache'), { recursive: true });
  await saveConfig(root, { ...DEFAULT_CONFIG, updateCheck: { enabled: options.updateCheck ?? true } });
  if (options.latest) {
    await fs.writeFile(path.join(root, '.knowl', 'cache', 'update-check.json'),
      JSON.stringify({ checkedAt: new Date().toISOString(), latest: options.latest }));
  }
  await initDb(root);
  const projectId = (await repo.createProject(root, 'update notice')).id;
  return { root, projectId };
}

const NEWER = '999.0.0';
const LINE = `Knowl ${PACKAGE_VERSION} → ${NEWER} is available`;

describe('update notice on the session card', () => {
  beforeEach(async () => {
    await closeDb();
    await releaseAll();
    delete process.env.KNOWL_NO_UPDATE_CHECK;
    delete process.env.NO_UPDATE_NOTIFIER;
  });

  afterAll(async () => {
    await closeDb();
    await releaseAll();
    vi.unstubAllGlobals();
    for (const root of ROOTS) await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  });

  it('shows a cached newer release once, and never fetches', async () => {
    const fetchStub = vi.fn();
    vi.stubGlobal('fetch', fetchStub);
    const { root, projectId } = await withRepo({ latest: NEWER });

    const first = await handleHostLifecycleEvent(projectId, hook(root));
    expect(first.context).toContain(LINE);
    expect(first.context).toContain('Tell the user.');

    const second = await handleHostLifecycleEvent(projectId, hook(root));
    expect(second.context ?? '').not.toContain(LINE);
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it('says nothing when the check is disabled', async () => {
    const { root, projectId } = await withRepo({ latest: NEWER, updateCheck: false });
    const result = await handleHostLifecycleEvent(projectId, hook(root));
    expect(result.context ?? '').not.toContain(LINE);
  });

  it('says nothing when the cache holds no newer release', async () => {
    const { root, projectId } = await withRepo({ latest: PACKAGE_VERSION });
    const result = await handleHostLifecycleEvent(projectId, hook(root));
    expect(result.context ?? '').not.toContain('is available');
  });
});

describe('the cache reader', () => {
  it('reads without fetching, and a refresh keeps the notified mark', async () => {
    const root = path.resolve(`./.knowl-update-notice-${nextRoot += 1}`);
    ROOTS.push(root);
    expect(await readCachedUpdate(root, '1.0.0')).toBeNull();

    await fs.mkdir(path.join(root, '.knowl', 'cache'), { recursive: true });
    await fs.writeFile(path.join(root, '.knowl', 'cache', 'update-check.json'),
      JSON.stringify({ checkedAt: '2000-01-01T00:00:00.000Z', latest: '2.0.0' }));
    expect(await readCachedUpdate(root, '1.0.0')).toEqual({ latest: '2.0.0', updateAvailable: true, notified: false });

    await markUpdateNotified(root, '2.0.0');
    expect(await readCachedUpdate(root, '1.0.0')).toMatchObject({ notified: true });

    // The stale entry forces a fetch; the rewrite must not forget what was already shown.
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ version: '2.0.0' }))) as unknown as typeof fetch;
    await checkForUpdate({ packageName: 'x', currentVersion: '1.0.0', projectRoot: root, fetchImpl });
    expect(fetchImpl).toHaveBeenCalled();
    expect(await readCachedUpdate(root, '1.0.0')).toMatchObject({ notified: true });
  });
});
