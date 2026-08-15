import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createClient, type Client } from '@libsql/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bootstrapSchema } from '../../src/store/bootstrap.js';
import { KNOWL_MIGRATION_LEVEL, readMigrationLevel, readSchemaVersion } from '../../src/store/schema-version.js';

let root: string;
let client: Client;

/**
 * A store as a level-10 build left it: `knowledge_items` without `written_by`.
 *
 * Built by bootstrapping the current schema and removing what level 11 added, rather than by
 * pasting level 10's DDL -- a copy would drift from `bootstrap.ts` silently and start testing a
 * schema no build ever wrote. Same construction as the level-10 test, for the same reason.
 */
async function makeLevel10Store(c: Client): Promise<void> {
  await bootstrapSchema(c);
  await c.execute('ALTER TABLE knowledge_items DROP COLUMN written_by');
  // Only the gate is rewound. `user_version` stays where a current build left it, which is what
  // makes this a migration test rather than a compatibility one.
  await c.execute('PRAGMA application_id = 10');
}

const columnsOf = async (c: Client): Promise<string[]> => {
  const rows = await c.execute('PRAGMA table_info(knowledge_items)');
  return rows.rows.map(row => String(row.name));
};

describe('a level-10 store upgrading to level 11', () => {
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'knowl-mig11-'));
    client = createClient({ url: `file:${path.join(root, 'knowl.db')}` });
    await makeLevel10Store(client);
  });

  afterEach(async () => {
    try { client.close(); } catch { /* already closed */ }
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  });

  it('gets the column and the stamp from one bootstrap', async () => {
    expect(await readMigrationLevel(client)).toBe(10);
    expect(await columnsOf(client)).not.toContain('written_by');

    await bootstrapSchema(client);

    expect(await columnsOf(client)).toContain('written_by');
    expect(await readMigrationLevel(client)).toBe(KNOWL_MIGRATION_LEVEL);
  });

  it('leaves existing rows NULL, which is the true answer rather than a gap', async () => {
    // Every row predating this column was written before a repo could act as another, so the
    // owner is exactly who wrote it -- and NULL is precisely how this column says that. A
    // backfill writing `origin_repo` into `written_by` would be inventing a distinction that
    // never existed and would make every legacy row read as cross-repo authored.
    await client.execute({
      sql: `INSERT INTO knowledge_items (id, category, status, title, content, origin_repo, created_at, updated_at)
            VALUES ('legacy-000', 'fact', 'active', 'Older than the column', 'Body.', 'a', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
    });

    await bootstrapSchema(client);

    const row = await client.execute("SELECT origin_repo, written_by FROM knowledge_items WHERE id = 'legacy-000'");
    expect(String(row.rows[0].origin_repo)).toBe('a');
    expect(row.rows[0].written_by).toBeNull();
  });

  it('does not move the compatibility floor, so an older build can still open it', async () => {
    // Additive and nullable: an older build ignores the column, and a newer one reading NULL
    // gets the truth rather than a hole. That is the whole case for not touching user_version.
    const before = await readSchemaVersion(client);
    await bootstrapSchema(client);
    expect(await readSchemaVersion(client)).toBe(before);
  });

  it('is idempotent: a second bootstrap neither re-adds nor throws', async () => {
    await bootstrapSchema(client);
    await client.execute({
      sql: `INSERT INTO knowledge_items (id, category, status, title, content, origin_repo, written_by, created_at, updated_at)
            VALUES ('after-000', 'fact', 'active', 'Written across', 'Body.', 'b', 'a', '2026-02-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z')`,
    });

    await bootstrapSchema(client);

    const row = await client.execute("SELECT written_by FROM knowledge_items WHERE id = 'after-000'");
    expect(String(row.rows[0].written_by)).toBe('a');
    expect((await columnsOf(client)).filter(name => name === 'written_by')).toHaveLength(1);
  });
});
