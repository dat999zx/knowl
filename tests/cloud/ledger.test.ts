import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, initDb } from '../../src/store/database.js';
import { releaseAll } from '../../src/store/connection-pool.js';
import {
  listPushed, listStaged, publishedVersion, recordPushed, restageForPublish, stageForPublish,
} from '../../src/cloud/ledger.js';

const ROOT = path.resolve('./.knowl-ledger-root');
const WS = 'ws-ledger';

describe('publication ledger', () => {
  beforeEach(async () => {
    await closeDb().catch(() => {});
    await releaseAll();
    await fs.rm(ROOT, { recursive: true, force: true }).catch(() => {});
    await fs.mkdir(path.join(ROOT, '.knowl'), { recursive: true });
    await fs.writeFile(path.join(ROOT, '.knowl', 'config.json'), JSON.stringify({ version: 1 }), 'utf8');
    await initDb(ROOT);
    // Wiped rather than trusted to the directory removal: on Windows libSQL can hold the file,
    // the `rm` is silently refused, and a surviving row answers the next test's question.
    await (await import('../../src/store/database.js')).getClient().execute('DELETE FROM cloud_published');
  });
  afterEach(async () => {
    await closeDb().catch(() => {});
    await releaseAll();
    await fs.rm(ROOT, { recursive: true, force: true }).catch(() => {});
  });

  it('starts empty', async () => {
    expect(await listStaged(WS)).toEqual([]);
    expect(await publishedVersion('a1', WS)).toBeNull();
  });

  it('stages items with the branch they were staged on', async () => {
    // The branch is recorded because the gate reads it later: an atom staged on a feature
    // branch must not push until that work is on the default branch.
    expect(await stageForPublish(['a1', 'a2'], WS, 'feature/rollback')).toBe(2);

    const staged = await listStaged(WS);
    expect(staged.map(row => row.itemId).sort()).toEqual(['a1', 'a2']);
    expect(staged[0].stagedOnBranch).toBe('feature/rollback');
    expect(staged[0].pushedAt).toBeNull();
  });

  it('staging twice does not duplicate or re-stage a pushed item', async () => {
    await stageForPublish(['a1'], WS, 'main');
    await recordPushed('a1', WS, 3);
    await stageForPublish(['a1'], WS, 'main');

    expect(await listStaged(WS)).toEqual([]);
    expect((await listPushed(WS)).map(row => row.itemId)).toEqual(['a1']);
  });

  it('re-stages a pushed item on request, without losing the version a republish needs', async () => {
    // The deliberate half of the pair above. A sweep leaves a published atom alone; naming its
    // id is the only way to send a correction, so it has to un-push the row -- and keep
    // `remote_version`, because dropping it would make the republish arrive with no
    // `expectedVersion`, which the server treats as a conflict by design.
    await stageForPublish(['a1'], WS, 'main');
    await recordPushed('a1', WS, 3);

    await restageForPublish(['a1'], WS, 'main');

    expect((await listStaged(WS)).map(row => row.itemId)).toEqual(['a1']);
    expect(await publishedVersion('a1', WS)).toBe(3);
  });

  it('remembers the remote version, which every republish needs', async () => {
    // The server treats a republish with no `expectedVersion` as a conflict, deliberately, so
    // an older client cannot acquire overwrite rights by not knowing the field exists. This
    // column is the only place that number lives on this machine.
    await stageForPublish(['a1'], WS, 'main');
    await recordPushed('a1', WS, 7);

    expect(await publishedVersion('a1', WS)).toBe(7);
  });

  it('keeps workspaces apart, so one team\'s version cannot answer for another\'s', async () => {
    await stageForPublish(['a1'], WS, 'main');
    await recordPushed('a1', WS, 7);

    expect(await publishedVersion('a1', 'other-workspace')).toBeNull();
  });

  it('unstage clears a pending row without touching remote_version', async () => {
    const { unstagePublish } = await import('../../src/cloud/ledger.js');

    await stageForPublish(['a'], WS, 'main');
    await recordPushed('a', WS, 7);
    await restageForPublish(['a'], WS, 'main');
    expect(await listStaged(WS)).toHaveLength(1);

    expect(await unstagePublish('a', WS)).toBe(true);
    expect(await listStaged(WS)).toHaveLength(0);

    // The invariant: unstaging is not a retraction, so the server's version survives.
    expect(await publishedVersion('a', WS)).toBe(7);
  });

  it('unstage reports false when nothing was pending', async () => {
    const { unstagePublish } = await import('../../src/cloud/ledger.js');
    expect(await unstagePublish('never-staged', WS)).toBe(false);
  });

  it('a re-stage preserves pushed_at instead of nulling it', async () => {
    const { getClient } = await import('../../src/store/database.js');

    await stageForPublish(['a'], WS, 'main');
    await recordPushed('a', WS, 1);
    await restageForPublish(['a'], WS, 'main');

    const rows = await getClient().execute({
      sql: 'SELECT pushed_at, stage_state FROM cloud_published WHERE item_id = ? AND remote_workspace = ?',
      args: ['a', WS],
    });
    expect(rows.rows[0].pushed_at).not.toBeNull();
    expect(String(rows.rows[0].stage_state)).toBe('pending');
  });

  it('a sweep re-stages an unstaged atom that was never pushed, and skips a pushed one', async () => {
    const { unstagePublish } = await import('../../src/cloud/ledger.js');

    await stageForPublish(['never-pushed'], WS, 'main');
    await unstagePublish('never-pushed', WS);

    await stageForPublish(['already-pushed'], WS, 'main');
    await recordPushed('already-pushed', WS, 2);

    await stageForPublish(['never-pushed', 'already-pushed'], WS, 'main');

    const staged = (await listStaged(WS)).map(row => row.itemId);
    expect(staged).toEqual(['never-pushed']);
  });
});
