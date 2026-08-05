import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, initDb } from '../../src/store/database.js';
import * as repo from '../../src/store/repository.js';
import { createSnapshot, restoreSnapshot } from '../../src/store/snapshots.js';
import { KNOWL_SCHEMA_VERSION } from '../../src/store/schema-version.js';

const TEST_ROOT = path.resolve('./.knowl-snapshot-verification-test');
let projectId: string;

describe('snapshot verification', () => {
  beforeAll(async () => {
    await fs.rm(TEST_ROOT, { recursive: true, force: true }).catch(() => {});
    await fs.mkdir(path.join(TEST_ROOT, '.knowl'), { recursive: true });
    await initDb(TEST_ROOT);
    const project = await repo.createProject(TEST_ROOT, 'Verification');
    projectId = project.id;
    await repo.createKnowledgeItem(projectId, { category: 'fact', title: 'Survivor', content: 'Still here.' });
  });

  beforeEach(async () => {
    await fs.rm(path.join(TEST_ROOT, '.knowl', 'snapshots'), { recursive: true, force: true });
  });

  afterAll(async () => {
    await closeDb();
    await fs.rm(TEST_ROOT, { recursive: true, force: true }).catch(() => {});
  });

  it('records the real schema version in the manifest', async () => {
    const snapshot = await createSnapshot(TEST_ROOT);
    expect(snapshot.manifest.schemaVersion).toBe(KNOWL_SCHEMA_VERSION);
  });

  it('refuses a snapshot with no manifest', async () => {
    const snapshot = await createSnapshot(TEST_ROOT);
    await fs.rm(snapshot.manifestPath);
    await expect(restoreSnapshot(TEST_ROOT, snapshot.path, { confirm: true })).rejects.toThrow(/manifest/i);
  });

  it('refuses a snapshot whose byte size disagrees with its manifest', async () => {
    const snapshot = await createSnapshot(TEST_ROOT);
    const manifest = JSON.parse(await fs.readFile(snapshot.manifestPath, 'utf8'));
    manifest.byteSize += 1;
    await fs.writeFile(snapshot.manifestPath, JSON.stringify(manifest), 'utf8');
    await expect(restoreSnapshot(TEST_ROOT, snapshot.path, { confirm: true })).rejects.toThrow(/size/i);
  });

  it('refuses a snapshot recorded by a newer schema', async () => {
    const snapshot = await createSnapshot(TEST_ROOT);
    const manifest = JSON.parse(await fs.readFile(snapshot.manifestPath, 'utf8'));
    manifest.schemaVersion += 1;
    await fs.writeFile(snapshot.manifestPath, JSON.stringify(manifest), 'utf8');
    await expect(restoreSnapshot(TEST_ROOT, snapshot.path, { confirm: true })).rejects.toThrow(/schema version/i);
  });

  it('refuses a corrupted snapshot and leaves the live store usable', async () => {
    const snapshot = await createSnapshot(TEST_ROOT);
    const bytes = await fs.readFile(snapshot.path);
    bytes.fill(0, 200, Math.min(4096, bytes.length));
    await fs.writeFile(snapshot.path, bytes);
    await expect(restoreSnapshot(TEST_ROOT, snapshot.path, { confirm: true })).rejects.toThrow();
    expect((await repo.listKnowledgeItems()).map(entry => entry.title)).toContain('Survivor');
  });

  it('still restores a well-formed snapshot', async () => {
    const snapshot = await createSnapshot(TEST_ROOT);
    await repo.createKnowledgeItem(projectId, {
      category: 'fact', title: 'After snapshot', content: 'Must disappear.',
    });
    await restoreSnapshot(TEST_ROOT, snapshot.path, { confirm: true });
    const titles = (await repo.listKnowledgeItems()).map(entry => entry.title);
    expect(titles).toContain('Survivor');
    expect(titles).not.toContain('After snapshot');
  });
});
