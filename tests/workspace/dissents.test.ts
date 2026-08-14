import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, getClient, initDb } from '../../src/store/database.js';
import { releaseAll } from '../../src/store/connection-pool.js';
import * as repo from '../../src/store/repository.js';
import { storeKnowledgeItemDeduped } from '../../src/store/knowledge-writer.js';
import { createManifest, writeManifest } from '../../src/workspace/manifest.js';
import { workspaceManifestPath } from '../../src/workspace/paths.js';
import { joinWorkspace } from '../../src/workspace/membership.js';
import { resolveWorkspace } from '../../src/workspace/resolve.js';
import { DEFAULT_CONFIG, loadConfig, saveConfig } from '../../src/core/config.js';
import { createDissent, withdrawDissent } from '../../src/workspace/dissents.js';

/**
 * A dissent is one repo's recorded disagreement with an atom another repo owns.
 *
 * Two single-writer rows, joined at read time: the dissent lives in the DISSENTING repo's store
 * and the resolution in the OWNING repo's. Nothing here ever writes another repo's database,
 * which is the invariant `assertOwnedItem` enforces and the one this feature exists not to bend.
 */

const ROOT = path.join(os.tmpdir(), 'knowl-dissent-schema');

describe('dissent schema', () => {
  beforeEach(async () => {
    await closeDb();
    await releaseAll();
    await fs.rm(ROOT, { recursive: true, force: true }).catch(() => {});
    await fs.mkdir(path.join(ROOT, '.knowl'), { recursive: true });
    await initDb(ROOT);
  });

  afterEach(async () => {
    await closeDb();
    await releaseAll();
    await fs.rm(ROOT, { recursive: true, force: true }).catch(() => {});
  });

  it('bootstrap creates both tables', async () => {
    const tables = await getClient().execute({
      sql: `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('dissents', 'dissent_resolutions') ORDER BY name`,
      args: [],
    });
    expect(tables.rows.map(row => String(row.name))).toEqual(['dissent_resolutions', 'dissents']);
  });

  it('the overlay lookup is indexed, because it runs per returned atom', async () => {
    const plan = await getClient().execute({
      sql: `EXPLAIN QUERY PLAN SELECT * FROM dissents WHERE target_item_id = 'x'`,
      args: [],
    });
    expect(JSON.stringify(plan.rows)).toContain('idx_dissents_target');
  });

  it('resolutions are looked up the same way, by the atom being defended', async () => {
    const plan = await getClient().execute({
      sql: `EXPLAIN QUERY PLAN SELECT * FROM dissent_resolutions WHERE target_item_id = 'x'`,
      args: [],
    });
    expect(JSON.stringify(plan.rows)).toContain('idx_dissent_resolutions_target');
  });

  it('re-opening an existing store is idempotent', async () => {
    await closeDb();
    await expect(initDb(ROOT)).resolves.not.toThrow();
    const tables = await getClient().execute({
      sql: `SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name IN ('dissents', 'dissent_resolutions')`,
      args: [],
    });
    expect(Number(tables.rows[0].n)).toBe(2);
  });

  it('a dissent pins the revision it was raised against, so a rewrite can stale it out', async () => {
    // Not decoration: without the pinned hash, a dissent raised against revision N would still
    // read as live against N+1, and the owner's rewrite -- the most likely response -- could
    // never clear it.
    const columns = await getClient().execute({ sql: `PRAGMA table_info(dissents)`, args: [] });
    const names = columns.rows.map(row => String(row.name));
    expect(names).toContain('target_content_hash');
    expect(names).toContain('target_repo');
    expect(names).toContain('claim');
    expect(names).toContain('replacement_item_id');
    expect(names).toContain('status');
  });
});

// ---------------------------------------------------------------------------------------------
// Two linked repos on one machine: `a` dissents, `b` owns. Under os.tmpdir() for the reason the
// foreign-item suites record -- inside the repository, saveConfig races a Windows EPERM rename.
// ---------------------------------------------------------------------------------------------

const HOME = path.join(os.tmpdir(), 'knowl-dissent-home');
const A = path.join(os.tmpdir(), 'knowl-dissent-a');
const B = path.join(os.tmpdir(), 'knowl-dissent-b');

async function seed(root: string, name: string, title: string, content: string): Promise<string> {
  await fs.mkdir(path.join(root, '.knowl'), { recursive: true });
  await saveConfig(root, { ...DEFAULT_CONFIG });
  await initDb(root);
  await getClient().execute('DELETE FROM knowledge_commits');
  await getClient().execute('DELETE FROM knowledge_items');
  const projectId = (await repo.createProject(root, name)).id;
  const stored = await storeKnowledgeItemDeduped(projectId, { category: 'decision', title, content });
  await getClient().execute({
    sql: 'UPDATE knowledge_items SET visibility = ?, origin_repo = ? WHERE id = ?',
    args: ['workspace', name, stored.item.id],
  });
  await closeDb();
  return stored.item.id;
}

async function peerRowCount(root: string, table: string): Promise<number> {
  await initDb(root);
  try {
    const rows = await getClient().execute({ sql: `SELECT count(*) AS n FROM ${table}`, args: [] });
    return Number(rows.rows[0].n);
  } finally {
    await closeDb();
  }
}

describe('createDissent', () => {
  let ownedByB = '';
  let ownedByA = '';

  beforeEach(async () => {
    process.env.KNOWL_HOME = HOME;
    await closeDb();
    await releaseAll();
    for (const dir of [HOME, A, B]) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    await writeManifest(workspaceManifestPath('ws'), createManifest('ws', null));
    ownedByA = await seed(A, 'a', 'Local auth note', 'Auth tokens expire locally.');
    ownedByB = await seed(B, 'b', 'Auth token TTL', 'Auth tokens expire after fifteen minutes.');
    await joinWorkspace({ projectRoot: A, workspaceName: 'ws', repoName: 'a' });
    await joinWorkspace({ projectRoot: B, workspaceName: 'ws', repoName: 'b' });
  });

  afterEach(async () => {
    delete process.env.KNOWL_HOME;
    await closeDb();
    await releaseAll();
    for (const dir of [HOME, A, B]) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  const inA = async () => {
    await initDb(A);
    return resolveWorkspace(A, await loadConfig(A));
  };

  it('records a dissent against a peer\'s atom, pinning the revision it was raised against', async () => {
    const workspace = await inA();
    const result = await createDissent({ targetItemId: ownedByB, claim: 'The TTL is five minutes, not fifteen.' }, workspace);

    expect(result.targetRepo).toBe('b');
    const rows = await getClient().execute({ sql: 'SELECT * FROM dissents', args: [] });
    await closeDb();

    expect(rows.rows).toHaveLength(1);
    const row = rows.rows[0];
    expect(String(row.target_repo)).toBe('b');
    expect(String(row.target_item_id)).toBe(ownedByB);
    expect(String(row.status)).toBe('open');
    expect(String(row.claim)).toContain('five minutes');
    // The pin is what lets the owner's rewrite stale this out rather than carry it forward.
    expect(String(row.target_content_hash).length).toBeGreaterThan(0);
  });

  it('writes nothing whatsoever into the repo it disagrees with', async () => {
    // The whole design in one assertion: disagreement never reaches the owner's database.
    const itemsBefore = await peerRowCount(B, 'knowledge_items');
    const workspace = await inA();
    await createDissent({ targetItemId: ownedByB, claim: 'The TTL is five minutes, not fifteen.' }, workspace);
    await closeDb();

    expect(await peerRowCount(B, 'knowledge_items')).toBe(itemsBefore);
    expect(await peerRowCount(B, 'dissents')).toBe(0);
  });

  it('refuses an atom this repo owns, and says what to do instead', async () => {
    const workspace = await inA();
    await expect(createDissent({ targetItemId: ownedByA, claim: 'Wrong.' }, workspace))
      .rejects.toThrow(/yours to change/i);
    await closeDb();
  });

  it('refuses an id no repo in the workspace holds', async () => {
    const workspace = await inA();
    await expect(createDissent({ targetItemId: 'no-such-item-000', claim: 'Wrong.' }, workspace))
      .rejects.toThrow(/No knowledge item/i);
    await closeDb();
  });

  it('refuses outside a workspace rather than recording a dissent nobody can receive', async () => {
    await initDb(A);
    await expect(createDissent({ targetItemId: ownedByB, claim: 'Wrong.' }, null))
      .rejects.toThrow(/workspace/i);
    await closeDb();
  });

  it('refuses a claim carrying a secret, and writes nothing', async () => {
    const workspace = await inA();
    const countRows = async () => Number(
      (await getClient().execute({ sql: 'SELECT count(*) AS n FROM dissents', args: [] })).rows[0].n,
    );
    // Relative, not absolute: on Windows a previous case's fixture directory occasionally
    // survives its own removal while libSQL still holds the sidecar, and an absolute zero would
    // then fail for a reason that has nothing to do with secret handling.
    const before = await countRows();
    await expect(createDissent({
      targetItemId: ownedByB,
      claim: 'The real value is AKIAIOSFODNN7EXAMPLE and the doc is wrong.',
    }, workspace)).rejects.toThrow(/secret material/i);
    const after = await countRows();
    await closeDb();
    expect(after).toBe(before);
  });

  it('withdraw flips this repo\'s own row and nothing else', async () => {
    const workspace = await inA();
    const { id } = await createDissent({ targetItemId: ownedByB, claim: 'The TTL is five minutes.' }, workspace);
    await withdrawDissent(id);
    const rows = await getClient().execute({ sql: 'SELECT status, withdrawn_at FROM dissents WHERE id = ?', args: [id] });
    await closeDb();

    expect(String(rows.rows[0].status)).toBe('withdrawn');
    expect(rows.rows[0].withdrawn_at).not.toBeNull();
  });

  it('withdraw refuses an id this store does not hold', async () => {
    await initDb(A);
    await expect(withdrawDissent('not-a-dissent-here')).rejects.toThrow(/No dissent/i);
    await closeDb();
  });
});
