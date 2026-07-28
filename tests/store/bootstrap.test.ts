import fs from 'node:fs/promises';
import path from 'node:path';
import { createClient } from '@libsql/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { bootstrapSchema } from '../../src/store/bootstrap.js';

const ROOT = path.resolve('./.knowl-bootstrap-test');

describe('bootstrapSchema', () => {
  beforeAll(async () => {
    await fs.rm(ROOT, { recursive: true, force: true });
    await fs.mkdir(ROOT, { recursive: true });
  });
  afterAll(async () => { await fs.rm(ROOT, { recursive: true, force: true }).catch(() => {}); });

  it('sets busy_timeout before any statement that can contend for a lock', async () => {
    // journal_mode = WAL (and everything after it) takes locks. Issuing it before
    // busy_timeout is set means a concurrent writer at that instant fails the whole
    // bootstrap with SQLITE_BUSY instead of waiting.
    const client = createClient({ url: `file:${path.join(ROOT, 'order.db')}` });
    const statements: string[] = [];
    const originalExecute = client.execute.bind(client);
    vi.spyOn(client, 'execute').mockImplementation(((stmt: any) => {
      statements.push(typeof stmt === 'string' ? stmt : stmt.sql);
      return originalExecute(stmt);
    }) as any);

    await bootstrapSchema(client);

    expect(statements[0]).toMatch(/busy_timeout/i);
    client.close();
  });
});
