import fs from 'node:fs/promises';
import path from 'node:path';
import { createClient } from '@libsql/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  KNOWL_SCHEMA_VERSION,
  SchemaTooNewError,
  assertSchemaSupported,
  readSchemaVersion,
  stampSchemaVersion,
} from '../../src/store/schema-version.js';
import { bootstrapSchema } from '../../src/store/bootstrap.js';
import { acquireClient, releaseAll } from '../../src/store/connection-pool.js';

const ROOT = path.resolve('./.knowl-schema-version-test');

describe('schema version guard', () => {
  beforeAll(async () => {
    await fs.rm(ROOT, { recursive: true, force: true });
    await fs.mkdir(ROOT, { recursive: true });
  });
  afterAll(async () => { await releaseAll(); await fs.rm(ROOT, { recursive: true, force: true }).catch(() => {}); });

  it('reads zero from a database nothing has stamped', async () => {
    const client = createClient({ url: `file:${path.join(ROOT, 'blank.db')}` });
    expect(await readSchemaVersion(client)).toBe(0);
    client.close();
  });

  it('bootstrap stamps the current version', async () => {
    const client = createClient({ url: `file:${path.join(ROOT, 'stamped.db')}` });
    await bootstrapSchema(client);
    expect(await readSchemaVersion(client)).toBe(KNOWL_SCHEMA_VERSION);
    client.close();
  });

  it('accepts a database at or below the version this client understands', async () => {
    const dbPath = path.join(ROOT, 'current.db');
    const client = createClient({ url: `file:${dbPath}` });
    await bootstrapSchema(client);
    await expect(assertSchemaSupported(client, dbPath)).resolves.toBeUndefined();
    client.close();
  });

  it('refuses a database written by a newer client', async () => {
    const dbPath = path.join(ROOT, 'future.db');
    const client = createClient({ url: `file:${dbPath}` });
    await bootstrapSchema(client);
    await client.execute(`PRAGMA user_version = ${KNOWL_SCHEMA_VERSION + 7}`);
    await expect(assertSchemaSupported(client, dbPath)).rejects.toThrow(SchemaTooNewError);
    client.close();
  });

  it('names both versions in the refusal, so the user knows to upgrade', async () => {
    const dbPath = path.join(ROOT, 'future-message.db');
    const client = createClient({ url: `file:${dbPath}` });
    await bootstrapSchema(client);
    await client.execute(`PRAGMA user_version = ${KNOWL_SCHEMA_VERSION + 1}`);
    const error = await assertSchemaSupported(client, dbPath).catch((caught: Error) => caught);
    expect(String((error as Error).message)).toContain(String(KNOWL_SCHEMA_VERSION + 1));
    expect(String((error as Error).message)).toContain(String(KNOWL_SCHEMA_VERSION));
    client.close();
  });

  it('stamping is idempotent', async () => {
    const client = createClient({ url: `file:${path.join(ROOT, 'twice.db')}` });
    await stampSchemaVersion(client);
    await stampSchemaVersion(client);
    expect(await readSchemaVersion(client)).toBe(KNOWL_SCHEMA_VERSION);
    client.close();
  });

  it('does not re-issue the header write once the version is already current', async () => {
    // Every rw open runs this. A concurrent process's open re-stamping an unchanged
    // value is a write it didn't need to make, and one more thing briefly holding a
    // lock while several processes race to bootstrap the same file at once.
    const client = createClient({ url: `file:${path.join(ROOT, 'no-rewrite.db')}` });
    await stampSchemaVersion(client);

    const originalExecute = client.execute.bind(client);
    const statements: string[] = [];
    vi.spyOn(client, 'execute').mockImplementation(((stmt: any) => {
      statements.push(typeof stmt === 'string' ? stmt : stmt.sql);
      return originalExecute(stmt);
    }) as any);

    await stampSchemaVersion(client);

    expect(statements.some(sql => /user_version\s*=/i.test(sql))).toBe(false);
    client.close();
  });

  it('refuses a too-new database on a read-only open, which skips bootstrap', async () => {
    // Read-only acquires suppress bootstrap, so they would skip the guard with it.
    const dbPath = path.join(ROOT, 'future-readonly.db');
    const writer = createClient({ url: `file:${dbPath}` });
    await bootstrapSchema(writer);
    await writer.execute(`PRAGMA user_version = ${KNOWL_SCHEMA_VERSION + 3}`);
    writer.close();

    await expect(acquireClient(dbPath, { readOnly: true })).rejects.toThrow(SchemaTooNewError);
  });
});
