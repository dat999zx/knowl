import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createClient } from '@libsql/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, initDbPath } from '../../src/store/database.js';
import { KNOWL_SCHEMA_VERSION, SchemaTooNewError } from '../../src/store/schema-version.js';

describe('preserve SchemaTooNewError across library boundary', () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(async () => {
    tmpDir = path.join(os.tmpdir(), `knowl-schema-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await fs.mkdir(tmpDir, { recursive: true });
    dbPath = path.join(tmpDir, 'knowl.db');

    // Create a database and stamp user_version higher than supported
    const rawClient = createClient({ url: `file:${dbPath}` });
    await rawClient.execute(`PRAGMA user_version = ${KNOWL_SCHEMA_VERSION + 1}`);
    rawClient.close();
  });

  afterEach(async () => {
    await closeDb().catch(() => {});
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  it('preserves SchemaTooNewError as cause when initDbPath throws', async () => {
    let thrownError: any = null;
    try {
      await initDbPath(dbPath, { configRoot: tmpDir });
    } catch (err: any) {
      thrownError = err;
    }

    expect(thrownError).toBeDefined();
    const causeOrSelf = thrownError instanceof SchemaTooNewError ? thrownError : thrownError?.cause;
    expect(causeOrSelf).toBeInstanceOf(SchemaTooNewError);
    expect(causeOrSelf.name).toBe('SchemaTooNewError');
  });
});
