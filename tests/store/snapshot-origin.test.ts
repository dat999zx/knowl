import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, initDb } from '../../src/store/database.js';
import { releaseAll } from '../../src/store/connection-pool.js';
import { createProject, createKnowledgeItem, listKnowledgeItems } from '../../src/store/repository.js';
import { createSnapshot, restoreSnapshot } from '../../src/store/snapshots.js';

/**
 * A snapshot knows where it came from, and restore checks.
 *
 * The database carries no project identity (the projects table is gone), and every repo's
 * snapshots sit at the identically shaped path `.knowl/snapshots/<stamp>.db` -- so restoring
 * repo A's snapshot into repo B succeeded silently, replaced B's entire memory with A's, and
 * the post-restore audit called the result clean. The origin now rides in the manifest;
 * a mismatch refuses with both paths named, and `acceptOriginMismatch` exists because the
 * same repository legitimately moves.
 */

// Three roots rather than two, so no test has to delete and rebuild a store another test in
// this file already opened. `closeDb`/`releaseAll` are process-global, and a mid-file teardown
// raced whatever else shared the worker -- the failure only ever appeared in a full run.
const ROOT_A = path.resolve('.knowl-origin-a');
const ROOT_B = path.resolve('.knowl-origin-b');
const ROOT_C = path.resolve('.knowl-origin-c');
const ROOTS = [ROOT_A, ROOT_B, ROOT_C];

describe('snapshot origin', () => {
  beforeAll(async () => {
    for (const root of ROOTS) {
      await fs.rm(root, { recursive: true, force: true }).catch(() => {});
      await fs.mkdir(path.join(root, '.knowl'), { recursive: true });
    }
  });

  afterAll(async () => {
    await closeDb();
    await releaseAll();
    for (const root of ROOTS) {
      await fs.rm(root, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('records where it was taken, refuses a foreign restore, and allows an explicit override', async () => {
    await initDb(ROOT_A);
    const projectA = await createProject(ROOT_A, 'origin-a');
    await createKnowledgeItem(projectA.id, {
      category: 'fact', title: 'Alpha secret', content: 'belongs to repository A',
    });
    const snapshot = await createSnapshot(ROOT_A);
    expect(snapshot.manifest.originRoot).toBe(path.resolve(ROOT_A));
    await closeDb();
    await releaseAll();

    await initDb(ROOT_B);
    const projectB = await createProject(ROOT_B, 'origin-b');
    await createKnowledgeItem(projectB.id, {
      category: 'fact', title: 'Beta secret', content: 'belongs to repository B',
    });

    // The accident: restoring A's snapshot while sitting in B.
    await expect(restoreSnapshot(ROOT_B, snapshot.path, { confirm: true }))
      .rejects.toThrow(/different repository/i);
    // B's memory must be untouched by the refusal.
    expect((await listKnowledgeItems()).map(item => item.title)).toContain('Beta secret');

    // The legitimate case -- a moved repo -- goes through only when said out loud.
    await restoreSnapshot(ROOT_B, snapshot.path, { confirm: true, acceptOriginMismatch: true });
    const titles = (await listKnowledgeItems()).map(item => item.title);
    expect(titles).toContain('Alpha secret');
    expect(titles).not.toContain('Beta secret');
  });

  it('treats a legacy manifest with no origin as unknown, not wrong', async () => {
    await initDb(ROOT_C);
    const project = await createProject(ROOT_C, 'origin-legacy');
    await createKnowledgeItem(project.id, {
      category: 'fact', title: 'Legacy fact', content: 'snapshotted before originRoot existed',
    });
    const snapshot = await createSnapshot(ROOT_C);

    // Strip the field, as a pre-field snapshot's manifest genuinely lacks it.
    const manifest = JSON.parse(await fs.readFile(snapshot.manifestPath, 'utf8'));
    delete manifest.originRoot;
    await fs.writeFile(snapshot.manifestPath, JSON.stringify(manifest, null, 2), 'utf8');

    await restoreSnapshot(ROOT_C, snapshot.path, { confirm: true });
    expect((await listKnowledgeItems()).map(item => item.title)).toContain('Legacy fact');
  });
});
