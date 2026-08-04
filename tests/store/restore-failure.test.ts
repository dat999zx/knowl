import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, getClient, initDb } from '../../src/store/database.js';
import { releaseAll } from '../../src/store/connection-pool.js';
import * as repo from '../../src/store/repository.js';
import { DEFAULT_CONFIG, saveConfig } from '../../src/core/config.js';
import { storeKnowledgeItemDeduped } from '../../src/store/knowledge-writer.js';
import { createSnapshot, restoreSnapshot } from '../../src/store/snapshots.js';

/**
 * K-59: a restore that fails its own audit says where the previous state went.
 *
 * The destruction is committed before the audit runs, so when the audit rejects what
 * landed, the store already holds it. `restoreSnapshot` takes a pre-restore snapshot for
 * exactly this case -- and then threw a bare "Restored snapshot failed integrity audit",
 * which is the one message in the system that most needs to name a file and did not. The
 * operator is left knowing the restore broke, in a store that is already broken, with the
 * way back sitting unnamed in a directory of timestamped filenames.
 */

const ROOT = path.resolve('.knowl-restore-failure-test');

describe('a restore that fails its audit', () => {
  let badSnapshot = '';

  beforeAll(async () => {
    await fs.rm(ROOT, { recursive: true, force: true }).catch(() => {});
    await fs.mkdir(path.join(ROOT, '.knowl'), { recursive: true });
    await saveConfig(ROOT, { ...DEFAULT_CONFIG });
    await initDb(ROOT);
    const projectId = (await repo.createProject(ROOT, 'Restore failure test')).id;
    await storeKnowledgeItemDeduped(projectId, {
      category: 'fact',
      title: 'An item that will lose its assertion',
      content: 'Every item needs an open assertion, and this snapshot will not have one.',
    });

    // A store the integrity audit rejects: an active item standing on no assertion. This is
    // the shape K-01 restored into every database it touched, so it is the realistic one.
    await getClient().execute('DELETE FROM knowledge_assertions');
    badSnapshot = (await createSnapshot(ROOT)).path;
  });

  afterAll(async () => {
    await closeDb();
    await releaseAll();
    await fs.rm(ROOT, { recursive: true, force: true }).catch(() => {});
  });

  it('names the pre-restore snapshot and the command that undoes it', async () => {
    const failure = await restoreSnapshot(ROOT, badSnapshot, { confirm: true }).then(
      () => null,
      (error: Error) => error,
    );

    expect(failure).toBeTruthy();
    const message = failure!.message;

    // The path itself, because a directory of ISO-timestamped filenames is not a hint.
    expect(message).toMatch(/[/\\]snapshots[/\\].+\.db/);
    // Both facts the operator needs: it was applied, and here is the way back.
    expect(message).toMatch(/applied/i);
    expect(message).toMatch(/knowl snapshot restore/);

    // Absolute either way: `C:\...` on Windows, `/...` elsewhere. Matching only the
    // drive-letter form passed here and failed on CI's ubuntu runner, where nothing matched
    // and `named` was undefined — the assertion below then failed for the one reason it was
    // not written to catch.
    const named = message.match(/((?:[A-Za-z]:[\\/]|\/)[^\s"]+\.db)/)?.[1];
    expect(named, 'the message must name a file that exists').toBeTruthy();
    await expect(fs.access(named!)).resolves.toBeUndefined();
    expect(path.resolve(named!)).not.toBe(path.resolve(badSnapshot));
  });
});
