import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveStorage } from '../../src/store/storage-roles.js';
import { projectNamespace, sessionNamespace } from '../../src/store/namespaces.js';

const ROOT = path.resolve('./some-project');

describe('resolveStorage', () => {
  it('places every role under the project .knowl directory by default', () => {
    const storage = resolveStorage(ROOT);
    expect(storage.local).toBe(path.join(ROOT, '.knowl', 'knowl.db'));
    expect(storage.session).toBe(path.join(ROOT, '.knowl', 'session.db'));
    expect(storage.knowledge).toBe(path.join(ROOT, '.knowl', 'knowl.db'));
  });

  it('agrees with the namespace descriptors, so query and context cannot diverge', () => {
    const storage = resolveStorage(ROOT);
    expect(projectNamespace(ROOT).databasePath).toBe(storage.knowledge);
    expect(sessionNamespace(ROOT).databasePath).toBe(storage.session);
  });

  it('is the path initDb actually opens, so storage and snapshots cannot diverge', async () => {
    const fs = await import('node:fs/promises');
    const { closeDb, initDb } = await import('../../src/store/database.js');
    const live = path.resolve('./.knowl-storage-roles-test');
    await fs.rm(live, { recursive: true, force: true });
    await fs.mkdir(path.join(live, '.knowl'), { recursive: true });

    await initDb(live);
    await closeDb();
    // If initDb built its own path and the resolver disagreed, snapshots would read a
    // different file from the live database with nothing reporting it.
    await expect(fs.access(resolveStorage(live).knowledge)).resolves.toBeUndefined();

    await fs.rm(live, { recursive: true, force: true }).catch(() => {});
  });

  it('keeps local and session distinct, since only knowledge can ever be redirected', () => {
    const storage = resolveStorage(ROOT);
    expect(storage.local).not.toBe(storage.session);
  });
});
