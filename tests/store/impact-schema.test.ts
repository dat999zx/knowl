import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootstrapSchema } from '../../src/store/bootstrap.js';
import { closeDb, getClient, initDb } from '../../src/store/database.js';
import { KNOWL_MIGRATION_LEVEL, readMigrationLevel } from '../../src/store/schema-version.js';

/**
 * The change-impact substrate: `work_read_sets` (what a session read, hashed at read time) and
 * `impact_findings` (what may now be wrong because something moved).
 *
 * These are checked as *shape* rather than behaviour because nothing reads them yet. The two
 * things that would silently break the feature later are a column that is nullable when the
 * detector assumes it is not, and an index whose column order does not match the query the gate
 * runs -- neither of which any behavioural test would catch until the code above them existed.
 */
const ROOT = path.resolve('./.knowl-impact-schema-test');

const AT = '2026-08-05T00:00:00.000Z';

type ColumnShape = { name: string; type: string; notnull: number; pk: number };

const columnsOf = async (table: string): Promise<ColumnShape[]> =>
  (await getClient().execute(`PRAGMA table_info(${table})`)).rows.map(row => ({
    name: String(row.name),
    type: String(row.type),
    notnull: Number(row.notnull),
    pk: Number(row.pk),
  }));

/** Declared indexes only: a TEXT PRIMARY KEY also produces `sqlite_autoindex_*`, which is not ours. */
const indexesOf = async (table: string): Promise<string[]> =>
  (await getClient().execute(`PRAGMA index_list(${table})`)).rows
    .map(row => String(row.name))
    .filter(name => !name.startsWith('sqlite_'))
    .sort();

const indexColumns = async (index: string): Promise<string[]> =>
  (await getClient().execute(`PRAGMA index_info(${index})`)).rows.map(row => String(row.name));

const queryPlan = async (sql: string, args: string[] = []): Promise<string> =>
  (await getClient().execute({ sql: `EXPLAIN QUERY PLAN ${sql}`, args })).rows
    .map(row => String(row.detail))
    .join(' | ');

const objectCount = async (name: string): Promise<number> =>
  Number((await getClient().execute({
    sql: 'SELECT COUNT(*) AS n FROM sqlite_master WHERE name = ?',
    args: [name],
  })).rows[0].n);

describe('change-impact schema', () => {
  beforeAll(async () => {
    await fs.rm(ROOT, { recursive: true, force: true });
    await fs.mkdir(path.join(ROOT, '.knowl'), { recursive: true });
    await initDb(ROOT);
  });

  afterAll(async () => {
    await closeDb();
    await fs.rm(ROOT, { recursive: true, force: true }).catch(() => {});
  });

  it('creates both tables on a fresh bootstrap', async () => {
    const rows = await getClient().execute(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('work_read_sets', 'impact_findings')`,
    );
    expect(rows.rows.map(row => String(row.name)).sort()).toEqual(['impact_findings', 'work_read_sets']);
  });

  /**
   * Pinned column-by-column rather than by membership. The nullability of `observed_hash` is
   * the load-bearing part: a read-set row without the hash as of the read cannot answer the
   * only question the table exists to answer, so "the column is there" is not the assertion
   * that matters.
   */
  it('gives work_read_sets exactly the specified columns and nullability', async () => {
    expect(await columnsOf('work_read_sets')).toEqual([
      { name: 'id', type: 'TEXT', notnull: 0, pk: 1 },
      { name: 'session_id', type: 'TEXT', notnull: 1, pk: 0 },
      { name: 'agent_id', type: 'TEXT', notnull: 0, pk: 0 },
      { name: 'task_id', type: 'TEXT', notnull: 0, pk: 0 },
      { name: 'locator', type: 'TEXT', notnull: 1, pk: 0 },
      { name: 'observed_hash', type: 'TEXT', notnull: 1, pk: 0 },
      { name: 'tool_name', type: 'TEXT', notnull: 0, pk: 0 },
      { name: 'read_at', type: 'TEXT', notnull: 1, pk: 0 },
      { name: 'released_at', type: 'TEXT', notnull: 0, pk: 0 },
    ]);
  });

  it('gives impact_findings exactly the specified columns and nullability', async () => {
    expect(await columnsOf('impact_findings')).toEqual([
      { name: 'id', type: 'TEXT', notnull: 0, pk: 1 },
      { name: 'cause_locator', type: 'TEXT', notnull: 1, pk: 0 },
      { name: 'cause_session', type: 'TEXT', notnull: 0, pk: 0 },
      { name: 'affected_kind', type: 'TEXT', notnull: 1, pk: 0 },
      { name: 'affected_id', type: 'TEXT', notnull: 1, pk: 0 },
      { name: 'tier', type: 'TEXT', notnull: 1, pk: 0 },
      { name: 'path_json', type: 'TEXT', notnull: 0, pk: 0 },
      { name: 'detected_at', type: 'TEXT', notnull: 1, pk: 0 },
      { name: 'resolution', type: 'TEXT', notnull: 0, pk: 0 },
      { name: 'resolved_at', type: 'TEXT', notnull: 0, pk: 0 },
    ]);
  });

  /** The pragma says the constraint is declared; this says SQLite enforces it. */
  it('refuses a read-set row with no hash as of the read', async () => {
    await expect(getClient().execute({
      sql: 'INSERT INTO work_read_sets (id, session_id, locator, read_at) VALUES (?, ?, ?, ?)',
      args: ['no-hash', 'sess-a', 'file://src/a.ts', AT],
    })).rejects.toThrow(/NOT NULL/i);
  });

  it('refuses a finding with no tier or no detection time', async () => {
    await expect(getClient().execute({
      sql: `INSERT INTO impact_findings (id, cause_locator, affected_kind, affected_id, detected_at)
            VALUES (?, ?, ?, ?, ?)`,
      args: ['no-tier', 'symbol://src/a.ts#f', 'work', 'read-1', AT],
    })).rejects.toThrow(/NOT NULL/i);

    await expect(getClient().execute({
      sql: `INSERT INTO impact_findings (id, cause_locator, affected_kind, affected_id, tier)
            VALUES (?, ?, ?, ?, ?)`,
      args: ['no-detected-at', 'symbol://src/a.ts#f', 'work', 'read-1', 'certain'],
    })).rejects.toThrow(/NOT NULL/i);
  });

  /**
   * NULL is the open state on both tables -- an unreleased read is live work, an unresolved
   * finding is one the gate still blocks on. A DEFAULT on either column would make "open"
   * unrepresentable by omission, so the absence of one is the thing being pinned here.
   */
  it('leaves a new read-set row live and a new finding open', async () => {
    await getClient().execute({
      sql: `INSERT INTO work_read_sets (id, session_id, agent_id, task_id, locator, observed_hash, tool_name, read_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      args: ['read-1', 'sess-a', '__agent__:lane-a', 'task-1', 'symbol://src/a.ts#createSession', 'h1', 'Read', AT],
    });
    await getClient().execute({
      sql: `INSERT INTO impact_findings (id, cause_locator, cause_session, affected_kind, affected_id, tier, detected_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
      args: ['finding-1', 'symbol://src/a.ts#createSession', 'sess-b', 'work', 'read-1', 'certain', AT],
    });

    const read = (await getClient().execute("SELECT released_at FROM work_read_sets WHERE id = 'read-1'")).rows[0];
    expect(read.released_at).toBeNull();

    const finding = (await getClient().execute(
      "SELECT resolution, resolved_at, path_json FROM impact_findings WHERE id = 'finding-1'",
    )).rows[0];
    expect(finding.resolution).toBeNull();
    expect(finding.resolved_at).toBeNull();
    // NULL at the certain tier: the session read that exact locator, so there is no edge chain.
    expect(finding.path_json).toBeNull();
  });

  it('indexes work_read_sets by locator and by session, each with released_at trailing', async () => {
    expect(await indexesOf('work_read_sets')).toEqual([
      'idx_work_read_sets_locator',
      'idx_work_read_sets_session',
    ]);
    // Column ORDER, not membership: the leading column is the equality the caller supplies and
    // `released_at` has to trail it, or "live reads of this locator" stops being a range.
    expect(await indexColumns('idx_work_read_sets_locator')).toEqual(['locator', 'released_at']);
    expect(await indexColumns('idx_work_read_sets_session')).toEqual(['session_id', 'released_at']);
  });

  it('indexes impact_findings by open-ness first and by affected target second', async () => {
    expect(await indexesOf('impact_findings')).toEqual([
      'idx_impact_findings_affected',
      'idx_impact_findings_open',
    ]);
    // `resolution` leads because open-ness is the prefix the gate and the pull tool share; a
    // tier-first order would leave a tier-less pull to a scan.
    expect(await indexColumns('idx_impact_findings_open')).toEqual([
      'resolution', 'tier', 'affected_kind', 'affected_id',
    ]);
    expect(await indexColumns('idx_impact_findings_affected')).toEqual([
      'affected_kind', 'affected_id', 'resolution',
    ]);
  });

  /**
   * An index that exists but that the planner will not use for the query it was added for is
   * a comment, not an index. These are the two queries that run per tool call.
   */
  it('serves the detector and release lookups from the read-set indexes', async () => {
    expect(await queryPlan(
      'SELECT id FROM work_read_sets WHERE locator = ? AND released_at IS NULL', ['symbol://src/a.ts#createSession'],
    )).toContain('idx_work_read_sets_locator');

    expect(await queryPlan(
      'SELECT id FROM work_read_sets WHERE session_id = ? AND released_at IS NULL', ['sess-a'],
    )).toContain('idx_work_read_sets_session');
  });

  /**
   * The write gate's query, asserted as "index-served, never a scan" rather than as one exact
   * plan. Which of the two indexes SQLite picks is a costing decision that moves with the library
   * version and with whether ANALYZE has ever run; that the table is not scanned is the invariant
   * the gate actually depends on, since it runs in `PreToolUse` in front of every write, with a
   * user waiting on the tool call behind it.
   */
  it('never scans impact_findings to answer the write gate', async () => {
    const plan = await queryPlan(
      `SELECT f.id FROM impact_findings f
       JOIN work_read_sets w ON w.id = f.affected_id
       WHERE f.resolution IS NULL AND f.tier = 'certain' AND f.affected_kind = 'work' AND w.session_id = ?`,
      ['sess-a'],
    );
    expect(plan).toMatch(/idx_impact_findings_(open|affected)/);
    expect(plan).not.toMatch(/SCAN (f|impact_findings)\b(?! USING)/);
  });

  /**
   * The upgrade path, not a repeat of the fresh-install path: rewinding only the migration gate
   * is what makes `SCHEMA_STATEMENTS` run again in full, which is exactly what happens on an
   * existing database the first time it meets this level. `CREATE TABLE IF NOT EXISTS` must
   * find both tables already there and leave their rows alone.
   */
  it('re-runs the whole statement list without duplicating or emptying anything', async () => {
    const client = getClient();
    await client.execute('PRAGMA application_id = 0');

    await bootstrapSchema(client);

    expect(await readMigrationLevel(client)).toBe(KNOWL_MIGRATION_LEVEL);
    for (const name of [
      'work_read_sets', 'impact_findings',
      'idx_work_read_sets_locator', 'idx_work_read_sets_session',
      'idx_impact_findings_open', 'idx_impact_findings_affected',
    ]) {
      expect(await objectCount(name), `${name} was created twice or dropped`).toBe(1);
    }

    const rows = await client.execute(
      "SELECT (SELECT COUNT(*) FROM work_read_sets) AS reads, (SELECT COUNT(*) FROM impact_findings) AS findings",
    );
    expect(Number(rows.rows[0].reads)).toBe(1);
    expect(Number(rows.rows[0].findings)).toBe(1);
  });
});
