import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkForUpdate, compareVersions, isUpdateCheckEnabled, formatUpdateNotice } from '../../src/core/version-check.js';

const PKG = '@dat999zx/knowl';
let root = '';

const okFetch = (version: string) => (async () => ({
  ok: true,
  json: async () => ({ version }),
})) as unknown as typeof fetch;

const failFetch = (async () => { throw new Error('offline'); }) as unknown as typeof fetch;

describe('npm update check', () => {
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'knowl-update-'));
    delete process.env.KNOWL_NO_UPDATE_CHECK;
    delete process.env.NO_UPDATE_NOTIFIER;
  });
  afterEach(async () => { await fs.rm(root, { recursive: true, force: true }).catch(() => {}); });

  it('compares versions numerically, ignoring prerelease suffixes', () => {
    expect(compareVersions('1.4.0', '1.3.1')).toBe(1);
    expect(compareVersions('1.3.1', '1.4.0')).toBe(-1);
    expect(compareVersions('1.3.1', '1.3.1')).toBe(0);
    expect(compareVersions('1.10.0', '1.9.9')).toBe(1);
    expect(compareVersions('2.0.0-beta.1', '2.0.0')).toBe(0);
  });

  it('reports an available update and caches the result', async () => {
    const result = await checkForUpdate({ packageName: PKG, currentVersion: '1.3.1', projectRoot: root, fetchImpl: okFetch('1.4.0') });
    expect(result).toMatchObject({ current: '1.3.1', latest: '1.4.0', updateAvailable: true });

    // second call is served from cache even though the network now fails
    const cached = await checkForUpdate({ packageName: PKG, currentVersion: '1.3.1', projectRoot: root, fetchImpl: failFetch });
    expect(cached?.latest).toBe('1.4.0');
    const raw = JSON.parse(await fs.readFile(path.join(root, '.knowl', 'cache', 'update-check.json'), 'utf-8'));
    expect(raw.latest).toBe('1.4.0');
  });

  it('reports no update when already current', async () => {
    const result = await checkForUpdate({ packageName: PKG, currentVersion: '1.4.0', projectRoot: root, fetchImpl: okFetch('1.4.0') });
    expect(result?.updateAvailable).toBe(false);
  });

  it('never surfaces an error when offline', async () => {
    await expect(checkForUpdate({ packageName: PKG, currentVersion: '1.3.1', projectRoot: root, fetchImpl: failFetch })).resolves.toBeNull();
  });

  it('refetches once the cache is stale', async () => {
    await checkForUpdate({ packageName: PKG, currentVersion: '1.3.1', projectRoot: root, fetchImpl: okFetch('1.4.0') });
    const result = await checkForUpdate({ packageName: PKG, currentVersion: '1.3.1', projectRoot: root, ttlMs: -1, fetchImpl: okFetch('1.5.0') });
    expect(result?.latest).toBe('1.5.0');
  });

  it('honours config and environment opt-outs', () => {
    expect(isUpdateCheckEnabled({})).toBe(true);
    expect(isUpdateCheckEnabled({ updateCheck: { enabled: false } })).toBe(false);
    process.env.KNOWL_NO_UPDATE_CHECK = '1';
    expect(isUpdateCheckEnabled({})).toBe(false);
  });

  it('formats an actionable notice', () => {
    const notice = formatUpdateNotice({ current: '1.3.1', latest: '1.4.0', updateAvailable: true }, PKG);
    expect(notice).toContain('1.3.1 → 1.4.0');
    expect(notice).toContain(`npm install -g ${PKG}`);
  });
});
