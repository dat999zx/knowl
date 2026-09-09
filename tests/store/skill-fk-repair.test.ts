import fs from 'node:fs/promises';
import path from 'node:path';
import { createClient } from '@libsql/client';
import { afterAll, describe, expect, it } from 'vitest';
import { bootstrapSchema } from '../../src/store/bootstrap.js';
import { KNOWL_MIGRATION_LEVEL } from '../../src/store/schema-version.js';

/**
 * A skill FK repair must not roll back bootstrap.
 *
 * `repairSkillForeignKeys` rebuilds `skill_steps` and `skill_metadata` onto the correct
 * `knowledge_items` foreign key and copies every row across unfiltered. It runs inside the
 * migration transaction, where its own `PRAGMA foreign_keys = OFF` is a documented no-op and
 * `defer_foreign_keys` postpones every check to COMMIT -- so a copied orphan is a deferred
 * violation, and a deferred violation at COMMIT rolls back the WHOLE bootstrap: no tables,
 * `application_id` left at 0, and every later open failing identically. `knowl doctor` opens
 * the store too, so the diagnosis sits inside the failure.
 *
 * An orphan child row is the expected state in exactly the stores this repair exists for --
 * the wrong parent table is why skill deletes never cascaded.
 *
 * Measured 2026-09-09, and worth writing down because it is not obvious: whether the COMMIT
 * actually fails depends on the stale table's own foreign key. `DROP TABLE` decrements the
 * deferred counter once per violating row it deletes, so when the stale key points at a table
 * that no longer exists -- the historical `knowledge_items_legacy` shape -- every carried-over
 * orphan is +1 on the insert and -1 on the drop, and the COMMIT survives by cancellation. When
 * the stale key points at a table that still exists and satisfies the row, nothing cancels and
 * the store is bricked. Both cases leave a row the new foreign key forbids, which is the defect
 * either way; only one of them announces itself.
 */
const ROOT = path.resolve('./.knowl-skill-fk-repair-test');

const LEGACY_ITEMS = `CREATE TABLE knowledge_items (
  id TEXT PRIMARY KEY,
  category TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  reasoning TEXT,
  alternatives TEXT,
  tags TEXT,
  source TEXT,
  confidence REAL NOT NULL DEFAULT 1.0,
  superseded_by_id TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);`;

const SEED_ITEM = `INSERT INTO knowledge_items (
  id, category, status, title, content, confidence, version, created_at, updated_at
) VALUES (
  'item1', 'skill', 'active', 'Migrated skill', 'Migrated skill content', 1.0, 1,
  '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
);`;

/**
 * A store whose skill tables carry the wrong foreign key and the orphan rows that key let
 * accumulate. `staleTarget` is the table the wrong key points at; a caller passing a table it
 * also creates gets the shape that cannot cancel its own violation at COMMIT.
 */
async function seedStaleStore(dbPath: string, staleTarget: string, liveTarget: boolean) {
  await fs.mkdir(path.dirname(dbPath), { recursive: true });
  const client = createClient({ url: `file:${dbPath}` });
  await client.execute('PRAGMA foreign_keys = OFF;');
  // The compact pre-workspace shape: no `project_id`, so `migrateLegacyProjectSchema` returns
  // early and the stale-FK repair is the only rebuild in play.
  await client.execute(LEGACY_ITEMS);
  if (liveTarget) {
    await client.execute(`CREATE TABLE ${staleTarget} (id TEXT PRIMARY KEY);`);
    await client.execute(`INSERT INTO ${staleTarget} (id) VALUES ('deleted-item'), ('item1');`);
  }
  await client.execute(`CREATE TABLE skill_steps (
    id TEXT PRIMARY KEY,
    knowledge_item_id TEXT NOT NULL REFERENCES ${staleTarget}(id) ON DELETE CASCADE,
    step_order INTEGER NOT NULL,
    instruction TEXT NOT NULL,
    created_at TEXT NOT NULL
  );`);
  await client.execute(`CREATE TABLE skill_metadata (
    knowledge_item_id TEXT PRIMARY KEY REFERENCES ${staleTarget}(id) ON DELETE CASCADE,
    usage_count INTEGER NOT NULL DEFAULT 0,
    success_count INTEGER NOT NULL DEFAULT 0,
    last_used TEXT
  );`);
  await client.execute(SEED_ITEM);
  await client.execute(`INSERT INTO skill_steps (id, knowledge_item_id, step_order, instruction, created_at)
    VALUES ('step1', 'item1', 1, 'Still linked', '2026-01-01T00:00:00.000Z');`);
  // The orphan: its skill was deleted, and the wrong foreign key meant nothing cascaded.
  await client.execute(`INSERT INTO skill_steps (id, knowledge_item_id, step_order, instruction, created_at)
    VALUES ('step-orphan', 'deleted-item', 1, 'Left behind', '2026-01-01T00:00:00.000Z');`);
  await client.execute(`INSERT INTO skill_metadata (knowledge_item_id, usage_count, success_count)
    VALUES ('item1', 3, 2), ('deleted-item', 9, 9);`);
  client.close();
}

describe('skill foreign-key repair', () => {
  afterAll(async () => { await fs.rm(ROOT, { recursive: true, force: true }).catch(() => {}); });

  it('completes a bootstrap when the stale key points at a table that still exists', async () => {
    const dbPath = path.join(ROOT, 'live-target', '.knowl', 'knowl.db');
    // `projects` is the table the pre-compact schema hung skill rows off, and nothing drops it
    // unless the legacy item migration runs. Its rows satisfy the stale key, so the drop of the
    // stale table cancels nothing and the deferred violation reaches COMMIT.
    await seedStaleStore(dbPath, 'projects', true);

    const client = createClient({ url: `file:${dbPath}` });
    try {
      await expect(bootstrapSchema(client)).resolves.toBeUndefined();

      // The transaction COMMITTED: the level is stamped and the rest of the schema exists.
      // Without that, `application_id` stays 0, ~40 tables are never created, and every
      // later open -- `knowl doctor` included -- fails in exactly the same place.
      const stamped = await client.execute('PRAGMA application_id');
      expect(Number(stamped.rows[0].application_id)).toBe(KNOWL_MIGRATION_LEVEL);
      const commitItems = await client.execute(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'knowledge_commit_items'",
      );
      expect(commitItems.rows).toHaveLength(1);
    } finally {
      client.close();
    }

    const reopened = createClient({ url: `file:${dbPath}` });
    try {
      await expect(bootstrapSchema(reopened)).resolves.toBeUndefined();
      const items = await reopened.execute('SELECT id FROM knowledge_items');
      expect(items.rows.map(row => String(row.id))).toEqual(['item1']);
    } finally {
      reopened.close();
    }
  });

  it('leaves no row the rebuilt foreign key forbids', async () => {
    const dbPath = path.join(ROOT, 'dead-target', '.knowl', 'knowl.db');
    // The historical shape: the stale key points at a table the legacy migration already
    // dropped. This one survives COMMIT by cancellation -- and still lands an orphan in a
    // table whose own key forbids it, which `PRAGMA foreign_key_check` reports and the
    // integrity audit reports as a dangling reference.
    await seedStaleStore(dbPath, 'knowledge_items_legacy', false);

    const client = createClient({ url: `file:${dbPath}` });
    try {
      await bootstrapSchema(client);

      const stepForeignKeys = await client.execute('PRAGMA foreign_key_list(skill_steps)');
      const metadataForeignKeys = await client.execute('PRAGMA foreign_key_list(skill_metadata)');
      expect(stepForeignKeys.rows.map(row => String(row.table))).toEqual(['knowledge_items']);
      expect(metadataForeignKeys.rows.map(row => String(row.table))).toEqual(['knowledge_items']);

      // The reachable row survives; the orphan is the cascade that never ran.
      const steps = await client.execute('SELECT id FROM skill_steps ORDER BY id');
      expect(steps.rows.map(row => String(row.id))).toEqual(['step1']);
      const metadata = await client.execute('SELECT knowledge_item_id FROM skill_metadata ORDER BY knowledge_item_id');
      expect(metadata.rows.map(row => String(row.knowledge_item_id))).toEqual(['item1']);

      const violations = await client.execute('PRAGMA foreign_key_check');
      expect(violations.rows).toEqual([]);
    } finally {
      client.close();
    }
  });
});
