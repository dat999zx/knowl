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
import {
  annotateDisputes, createDissent, listIncomingDissents, listOutgoingDissents, rejectDissent,
  withdrawDissent,
} from '../../src/workspace/dissents.js';

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

/**
 * Run `body` with `root`'s `dissents` table invisible, then put it back.
 *
 * Renamed rather than dropped, and restored rather than left. The store is stamped at the
 * current migration level, so `bootstrapSchema` skips `SCHEMA_STATEMENTS` entirely on the next
 * open and would never recreate a dropped table -- and on Windows a fixture directory routinely
 * survives its own removal while libSQL holds the sidecar. A dropped table therefore outlives
 * the test that dropped it and breaks every later case in the file.
 */
async function withDissentsTableHidden(root: string, body: () => Promise<void>): Promise<void> {
  await initDb(root);
  await getClient().execute('ALTER TABLE dissents RENAME TO dissents_hidden');
  await closeDb();
  try {
    await body();
  } finally {
    await initDb(root);
    await getClient().execute('ALTER TABLE dissents_hidden RENAME TO dissents');
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

describe('the owner side', () => {
  let ownedByB = '';

  beforeEach(async () => {
    process.env.KNOWL_HOME = HOME;
    await closeDb();
    await releaseAll();
    for (const dir of [HOME, A, B]) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    await writeManifest(workspaceManifestPath('ws'), createManifest('ws', null));
    await seed(A, 'a', 'Local auth note', 'Auth tokens expire locally.');
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

  /** Raise a dissent from `a` against `b`'s atom, then leave `a` closed. */
  async function dissentFromA(claim = 'The TTL is five minutes, not fifteen.'): Promise<string> {
    await initDb(A);
    const workspace = await resolveWorkspace(A, await loadConfig(A));
    const { id } = await createDissent({ targetItemId: ownedByB, claim }, workspace);
    await closeDb();
    return id;
  }

  const inB = async () => {
    await initDb(B);
    return resolveWorkspace(B, await loadConfig(B));
  };

  it('the owning repo sees an open dissent raised against its atom', async () => {
    await dissentFromA();
    const workspace = await inB();
    const incoming = await listIncomingDissents(workspace);
    await closeDb();

    expect(incoming).toHaveLength(1);
    expect(incoming[0].fromRepo).toBe('a');
    expect(incoming[0].targetItemId).toBe(ownedByB);
    expect(incoming[0].targetTitle).toBe('Auth token TTL');
    expect(incoming[0].claim).toContain('five minutes');
    expect(incoming[0].staleAgainstCurrentRevision).toBe(false);
  });

  it('a withdrawn dissent stops being incoming', async () => {
    const id = await dissentFromA();
    await initDb(A);
    await withdrawDissent(id);
    await closeDb();

    const workspace = await inB();
    const incoming = await listIncomingDissents(workspace);
    await closeDb();
    expect(incoming).toHaveLength(0);
  });

  it('rejecting it clears it, and the rejection is written in the owner\'s own store', async () => {
    const id = await dissentFromA();
    const workspace = await inB();
    await rejectDissent(id, ownedByB, 'Measured at fifteen; the five-minute figure is the refresh window.');
    const incoming = await listIncomingDissents(workspace);
    const local = await getClient().execute({ sql: 'SELECT * FROM dissent_resolutions', args: [] });
    await closeDb();

    expect(incoming).toHaveLength(0);
    expect(local.rows).toHaveLength(1);
    expect(String(local.rows[0].resolution)).toBe('rejected');
    // Written by the owner, about a dissent that lives in the peer's store. That asymmetry is
    // the design: neither repo writes the other's database.
    expect(String(local.rows[0].dissent_id)).toBe(id);
  });

  it('the rejection did not reach the dissenting repo\'s store', async () => {
    const id = await dissentFromA();
    const workspace = await inB();
    await rejectDissent(id, ownedByB, 'Measured at fifteen.');
    await closeDb();
    void workspace;

    expect(await peerRowCount(A, 'dissent_resolutions')).toBe(0);
    await initDb(A);
    const stillOpen = await getClient().execute({ sql: 'SELECT status FROM dissents WHERE id = ?', args: [id] });
    await closeDb();
    // The dissenter's own record is untouched -- it still says what that repo believes.
    expect(String(stillOpen.rows[0].status)).toBe('open');
  });

  it('rewriting the disputed atom stales the dissent out, because the objection was to what it said', async () => {
    await dissentFromA();
    await initDb(B);
    const item = (await repo.getKnowledgeItem(ownedByB))!;
    await repo.updateKnowledgeItem(ownedByB, { content: 'Auth tokens expire after five minutes.' });
    void item;
    const workspace = await resolveWorkspace(B, await loadConfig(B));
    const incoming = await listIncomingDissents(workspace);
    await closeDb();

    expect(incoming.every(entry => entry.staleAgainstCurrentRevision)).toBe(true);
  });

  it('rejecting refuses a target this repo does not own', async () => {
    const id = await dissentFromA();
    await initDb(A);
    await expect(rejectDissent(id, 'no-such-item-000', 'nope')).rejects.toThrow(/No knowledge item|not yours/i);
    await closeDb();
  });

  it('the dissenting repo can list what it has raised', async () => {
    const id = await dissentFromA();
    await initDb(A);
    const outgoing = await listOutgoingDissents();
    await closeDb();

    // By id rather than by count: on Windows a fixture directory occasionally survives its own
    // removal while libSQL still holds the sidecar, so a count asserts fixture isolation rather
    // than the listing this test is about.
    const raised = outgoing.find(entry => entry.id === id);
    expect(raised).toBeDefined();
    expect(raised!.targetRepo).toBe('b');
    expect(raised!.status).toBe('open');
  });

  it('a peer with no dissents table contributes nothing rather than failing the listing', async () => {
    // An older build's store, or one never used. The overlay runs on every workspace read, so
    // this must degrade to "no dissents" and never to an error.
    await withDissentsTableHidden(A, async () => {
      const workspace = await inB();
      await expect(listIncomingDissents(workspace)).resolves.toEqual([]);
      await closeDb();
    });
  });
});

describe('annotateDisputes', () => {
  let ownedByB = '';

  beforeEach(async () => {
    process.env.KNOWL_HOME = HOME;
    await closeDb();
    await releaseAll();
    for (const dir of [HOME, A, B]) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    await writeManifest(workspaceManifestPath('ws'), createManifest('ws', null));
    await seed(A, 'a', 'Local auth note', 'Auth tokens expire locally.');
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

  async function dissentFromA(claim = 'The TTL is five minutes, not fifteen.'): Promise<string> {
    await initDb(A);
    const workspace = await resolveWorkspace(A, await loadConfig(A));
    const { id } = await createDissent({ targetItemId: ownedByB, claim }, workspace);
    await closeDb();
    return id;
  }

  const inB = async () => {
    await initDb(B);
    return resolveWorkspace(B, await loadConfig(B));
  };

  it('marks a disputed atom, naming the repo that disputes it', async () => {
    await dissentFromA();
    const workspace = await inB();
    const [annotated] = await annotateDisputes([{ id: ownedByB }], workspace);
    await closeDb();

    expect(annotated.disputed).toHaveLength(1);
    expect(annotated.disputed![0].by).toBe('a');
    expect(annotated.disputed![0].claim).toContain('five minutes');
  });

  it('leaves an undisputed atom exactly as it arrived', async () => {
    const workspace = await inB();
    const [annotated] = await annotateDisputes([{ id: ownedByB, keep: 'me' }], workspace);
    await closeDb();

    expect(annotated).not.toHaveProperty('disputed');
    expect(annotated.keep).toBe('me');
  });

  it('preserves order exactly — the overlay annotates and never ranks', async () => {
    await dissentFromA();
    const workspace = await inB();
    const input = [{ id: 'x1' }, { id: ownedByB }, { id: 'x2' }, { id: 'x3' }];
    const annotated = await annotateDisputes(input, workspace);
    await closeDb();

    expect(annotated.map(entry => entry.id)).toEqual(['x1', ownedByB, 'x2', 'x3']);
  });

  it('a withdrawn dissent no longer marks the atom', async () => {
    const id = await dissentFromA();
    await initDb(A);
    await withdrawDissent(id);
    await closeDb();

    const workspace = await inB();
    const [annotated] = await annotateDisputes([{ id: ownedByB }], workspace);
    await closeDb();
    expect(annotated).not.toHaveProperty('disputed');
  });

  it('a rejected dissent no longer marks the atom, as seen from the owning repo', async () => {
    const id = await dissentFromA();
    const workspace = await inB();
    await rejectDissent(id, ownedByB, 'Measured at fifteen.');
    const [annotated] = await annotateDisputes([{ id: ownedByB }], workspace);
    await closeDb();
    expect(annotated).not.toHaveProperty('disputed');
  });

  it('and no longer marks it for a THIRD repo either, whose store holds neither row', async () => {
    // The dissent lives in `a`, the rejection in `b`. A reader in `a` holds only its own half,
    // so without reading the owner's resolutions it would keep showing a dispute that is over.
    const id = await dissentFromA();
    const workspaceB = await inB();
    await rejectDissent(id, ownedByB, 'Measured at fifteen.');
    await closeDb();
    void workspaceB;

    await initDb(A);
    const workspaceA = await resolveWorkspace(A, await loadConfig(A));
    const [annotated] = await annotateDisputes([{ id: ownedByB }], workspaceA);
    await closeDb();
    expect(annotated).not.toHaveProperty('disputed');
  });

  it('a rewritten atom sheds the dispute, because the objection was to what it said', async () => {
    await dissentFromA();
    await initDb(B);
    await repo.updateKnowledgeItem(ownedByB, { content: 'Auth tokens expire after five minutes.' });
    const workspace = await resolveWorkspace(B, await loadConfig(B));
    const [annotated] = await annotateDisputes([{ id: ownedByB }], workspace);
    await closeDb();
    expect(annotated).not.toHaveProperty('disputed');
  });

  it('costs nothing outside a workspace, or with nothing to annotate', async () => {
    await initDb(B);
    await expect(annotateDisputes([{ id: ownedByB }], null)).resolves.toEqual([{ id: ownedByB }]);
    const workspace = await resolveWorkspace(B, await loadConfig(B));
    await expect(annotateDisputes([], workspace)).resolves.toEqual([]);
    await closeDb();
  });

  it('a peer with no dissents table degrades to no annotation, never an error', async () => {
    await withDissentsTableHidden(A, async () => {
      const workspace = await inB();
      await expect(annotateDisputes([{ id: ownedByB }], workspace)).resolves.toEqual([{ id: ownedByB }]);
      await closeDb();
    });
  });
});
