import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, getClient, initDb } from '../../src/store/database.js';
import { releaseAll } from '../../src/store/connection-pool.js';
import {
  publishedVersion, recordPushed, recordRetracted, restageForPublish, stageForPublish, unstagePublish,
} from '../../src/cloud/ledger.js';

const ROOT = path.resolve('./.knowl-ledger-invariant-root');
const WS = 'ws-invariant';

async function storedVersion(itemId: string): Promise<unknown> {
  const rows = await getClient().execute({
    sql: 'SELECT remote_version FROM cloud_published WHERE item_id = ? AND remote_workspace = ?',
    args: [itemId, WS],
  });
  return rows.rows[0]?.remote_version;
}

describe('remote_version is written by push and cleared only by retract', () => {
  beforeEach(async () => {
    await closeDb().catch(() => {});
    await releaseAll();
    await fs.rm(ROOT, { recursive: true, force: true }).catch(() => {});
    await fs.mkdir(path.join(ROOT, '.knowl'), { recursive: true });
    await fs.writeFile(path.join(ROOT, '.knowl', 'config.json'), JSON.stringify({ version: 1 }), 'utf8');
    await initDb(ROOT);
    // Wiped rather than trusted to the directory removal: on Windows libSQL can hold the file,
    // the `rm` is silently refused, and a surviving row answers the next test's question.
    await getClient().execute('DELETE FROM cloud_published');
  });

  afterEach(async () => {
    await closeDb().catch(() => {});
    await releaseAll();
    await fs.rm(ROOT, { recursive: true, force: true }).catch(() => {});
  });

  it('survives the full edit / unstage / edit / push cycle', async () => {
    await stageForPublish(['a'], WS, 'main');
    expect(await storedVersion('a')).toBeNull();

    await recordPushed('a', WS, 4, { contentHash: null, lifecycleHash: null });
    expect(Number(await storedVersion('a'))).toBe(4);

    // Edit -> re-stage -> change your mind -> edit again -> re-stage.
    await restageForPublish(['a'], WS, 'main');
    expect(Number(await storedVersion('a'))).toBe(4);

    await unstagePublish('a', WS);
    expect(Number(await storedVersion('a'))).toBe(4);

    await restageForPublish(['a'], WS, 'main');
    expect(Number(await storedVersion('a'))).toBe(4);

    // The second push must still be able to declare what it expects to overwrite.
    expect(await publishedVersion('a', WS)).toBe(4);
  });

  it('is cleared by retraction, and only by retraction', async () => {
    await stageForPublish(['a'], WS, 'main');
    await recordPushed('a', WS, 4, { contentHash: null, lifecycleHash: null });

    await recordRetracted('a', WS);
    expect(await storedVersion('a')).toBeNull();
  });

  it('a sweep never blanks the version of a pushed atom', async () => {
    await stageForPublish(['a'], WS, 'main');
    await recordPushed('a', WS, 11, { contentHash: null, lifecycleHash: null });

    await stageForPublish(['a'], WS, 'main');
    expect(Number(await storedVersion('a'))).toBe(11);
  });
});
