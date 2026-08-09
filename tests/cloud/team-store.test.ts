import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getClient } from '../../src/store/database.js';
import { dropTeamStore, teamStorePath, withTeamStore } from '../../src/cloud/team-store.js';
import { workspaceDir } from '../../src/workspace/paths.js';

const HOME = path.resolve('./.knowl-team-store-home');
const ROOT = path.resolve('./.knowl-team-store-root');

/**
 * A distinct replica per test, and the tree wiped once rather than between tests.
 *
 * Deleting a libSQL database and recreating it at the same path in the same process is slow and
 * unreliable on Windows -- the handle outlives the pool's close, so a per-test `rm` either
 * blocks for seconds retrying or silently gives up and leaks the previous test's rows into the
 * next one. Both were measured here. Separate ids need no deletion at all, which is also how
 * the store suites in `tests/store/` are shaped.
 */
const ws = (name: string) => `ws-${name}`;

describe('team store', () => {
  beforeAll(async () => {
    process.env.KNOWL_HOME = HOME;
    for (const dir of [HOME, ROOT]) {
      await fs.rm(dir, { recursive: true, force: true, maxRetries: 2, retryDelay: 25 }).catch(() => {});
    }
    await fs.mkdir(path.join(ROOT, '.knowl'), { recursive: true });
    await fs.writeFile(path.join(ROOT, '.knowl', 'config.json'), JSON.stringify({ version: 1 }), 'utf8');
  });

  afterAll(async () => {
    delete process.env.KNOWL_HOME;
    for (const dir of [HOME, ROOT]) {
      await fs.rm(dir, { recursive: true, force: true, maxRetries: 2, retryDelay: 25 }).catch(() => {});
    }
  });

  it('lives outside the OSS workspace directory, so a workspace name cannot collide with an id', () => {
    // `workspaceDir()` holds OSS workspace manifests keyed by a name matching
    // ^[a-z0-9][a-z0-9-]*$ -- which a cloud workspace id also matches. Sharing the tree would
    // let one silently sit inside the other.
    const id = ws('paths');
    expect(teamStorePath(id).startsWith(workspaceDir(id))).toBe(false);
    expect(teamStorePath(id)).toContain(path.join('cloud', id));
  });

  it('creates a database carrying the ordinary Knowl schema', async () => {
    // It is an ordinary Knowl database on purpose: Plan C opens it with openPeerStore and
    // ranks it with the same code as any other store. A bespoke schema would need a bespoke
    // reader, which is the drift this design exists to avoid.
    const tables = await withTeamStore(ws('schema'), ROOT, async () => {
      const result = await getClient().execute(
        "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
      );
      return result.rows.map(row => String(row.name));
    });

    expect(tables).toContain('knowledge_items');
    expect(tables).toContain('evidence');
    expect(tables).toContain('cloud_sync_state');
  });

  it('is idempotent, so a second open does not rebuild or wipe it', async () => {
    const id = ws('idempotent');
    await withTeamStore(id, ROOT, async () => {
      await getClient().execute("INSERT INTO cloud_sync_state (id, api_host) VALUES (1, 'https://a')");
    });

    const host = await withTeamStore(id, ROOT, async () => {
      const result = await getClient().execute('SELECT api_host FROM cloud_sync_state WHERE id = 1');
      return String(result.rows[0].api_host);
    });

    expect(host).toBe('https://a');
  });

  it('holds at most one sync-state row, because two watermarks is no watermark', async () => {
    await expect(withTeamStore(ws('single-row'), ROOT, async () => {
      await getClient().execute("INSERT INTO cloud_sync_state (id, api_host) VALUES (1, 'https://a')");
      await getClient().execute("INSERT INTO cloud_sync_state (id, api_host) VALUES (2, 'https://b')");
    })).rejects.toThrow();
  });

  it('leaves nothing behind, so a dropped store rebuilds empty rather than resurrecting', async () => {
    // Asserted as "holds nothing", not as "the file is gone". Those are the same thing off
    // Windows and different on it: the `-shm` sidecar stays locked for seconds after every
    // handle is closed and checkpointed, so the unlink fails there and the truncation fallback
    // is what delivers the guarantee. Emptiness is the property a resync actually depends on.
    const id = ws('droppable');
    await withTeamStore(id, ROOT, async () => {
      await getClient().execute("INSERT INTO cloud_sync_state (id, api_host) VALUES (1, 'https://a')");
      await getClient().execute(
        `INSERT INTO knowledge_items (id, category, title, content, created_at, updated_at)
         VALUES ('k1', 'fact', 'T', 'C', '2026-08-09T00:00:00.000Z', '2026-08-09T00:00:00.000Z')`,
      );
    });

    await dropTeamStore(id, ROOT);

    const counts = await withTeamStore(id, ROOT, async () => {
      const state = await getClient().execute('SELECT COUNT(*) AS n FROM cloud_sync_state');
      const items = await getClient().execute('SELECT COUNT(*) AS n FROM knowledge_items');
      return { state: Number(state.rows[0].n), items: Number(items.rows[0].n) };
    });

    expect(counts).toEqual({ state: 0, items: 0 });
  });

  it('drops a replica that was never created without complaining', async () => {
    // A drop that cannot leave the replica empty throws, so the ordinary "nothing to remove"
    // case has to be a success rather than the exception that would abort a resync before it
    // even starts.
    await expect(dropTeamStore(ws('never-opened'), ROOT)).resolves.toBeUndefined();
  });
});
