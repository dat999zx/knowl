import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Client } from '@libsql/client';
import { auditKnowledgeStore } from './integrity.js';
import { getClient } from './database.js';
import { resolveStorage } from './storage-roles.js';

export type SnapshotManifest = {
  schemaVersion: number;
  createdAt: string;
  byteSize: number;
  sha256: string;
};

export type Snapshot = { path: string; manifestPath: string; manifest: SnapshotManifest };

function databasePath(projectRoot: string): string {
  return path.resolve(resolveStorage(projectRoot).knowledge);
}

async function sha256(filePath: string): Promise<string> {
  return crypto.createHash('sha256').update(await fs.readFile(filePath)).digest('hex');
}

function quoteSqlPath(filePath: string): string {
  return filePath.replace(/'/g, "''");
}

export async function createSnapshot(projectRoot: string): Promise<Snapshot> {
  const root = path.resolve(projectRoot);
  const snapshotDir = path.join(root, '.knowl', 'snapshots');
  await fs.mkdir(snapshotDir, { recursive: true });
  const createdAt = new Date().toISOString();
  const stem = `${createdAt.replace(/[:.]/g, '-')}-${crypto.randomUUID().slice(0, 8)}`;
  const snapshotPath = path.join(snapshotDir, `${stem}.db`);

  await getClient().execute(`VACUUM INTO '${quoteSqlPath(snapshotPath)}'`);

  const stat = await fs.stat(snapshotPath);
  const manifest: SnapshotManifest = {
    schemaVersion: 1,
    createdAt,
    byteSize: stat.size,
    sha256: await sha256(snapshotPath),
  };
  const manifestPath = `${snapshotPath}.manifest.json`;
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
  return { path: snapshotPath, manifestPath, manifest };
}

/**
 * Every table a restore has to rewrite, derived rather than listed.
 *
 * The previous list was hand-written and named five tables. `DELETE FROM knowledge_items`
 * cascades into eight, so `knowledge_assertions`, `knowledge_evidence`, `knowledge_access`
 * and `drift_state` were emptied and never refilled. The assertion loss is not cosmetic:
 * `updateKnowledgeItemWithCommit` refuses any content edit on an item with no open assertion,
 * so a restored store looked intact and then rejected every write to it -- and the audit that
 * runs immediately afterwards did not check assertions, so it reported success. A recovery
 * path that quietly destroys history is worse than no recovery path, because it is used
 * exactly when the previous state is already gone.
 *
 * So the set is computed from the schema: `knowledge_items` plus everything declaring a
 * foreign key into it, plus the standalone tables the restore owns. A table added later
 * joins this automatically instead of waiting to be noticed.
 */
async function tablesReferencingItems(client: Client): Promise<string[]> {
  const tables = await client.execute(
    `SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
  );
  const dependents: string[] = [];
  for (const row of tables.rows) {
    const name = String(row.name);
    if (name === 'knowledge_items') continue;
    const fks = await client.execute(`PRAGMA foreign_key_list(${name})`);
    if (fks.rows.some(fk => String(fk.table) === 'knowledge_items')) dependents.push(name);
  }
  return dependents;
}

/**
 * Columns shared by the live table and the snapshot's, named explicitly.
 *
 * `INSERT INTO t SELECT * FROM snapshot.t` requires the two to agree on column count and
 * order. A snapshot taken before an additive migration does not, so the star form fails --
 * or worse, silently lands values in the wrong columns when the counts happen to match.
 * Restoring only the intersection means an older snapshot loads with its newer columns left
 * at their defaults, which is what "restore what this snapshot actually holds" should mean.
 */
async function sharedColumns(client: Client, table: string): Promise<string[]> {
  const live = await client.execute(`PRAGMA table_info(${table})`);
  const snap = await client.execute(`PRAGMA snapshot_restore.table_info(${table})`);
  const snapNames = new Set(snap.rows.map(row => String(row.name)));
  return live.rows.map(row => String(row.name)).filter(name => snapNames.has(name));
}

async function restoreStatements(client: Client): Promise<string[]> {
  const present = new Set(
    (await client.execute(
      `SELECT name FROM snapshot_restore.sqlite_schema WHERE type = 'table'`,
    )).rows.map(row => String(row.name)),
  );

  const dependents = (await tablesReferencingItems(client)).filter(table => present.has(table));
  // `knowledge_commits` has no foreign key into items but is part of the same history, and
  // restoring items without their commits leaves the audit trail describing a store that no
  // longer exists.
  const standalone = ['knowledge_commits'].filter(table => present.has(table));

  const statements: string[] = [];
  // Children first, then the parent: relying on the cascade to clear dependents is what hid
  // the original defect, and an explicit delete says which tables this function owns.
  for (const table of [...dependents, ...standalone]) statements.push(`DELETE FROM ${table}`);
  statements.push('DELETE FROM knowledge_items');

  // Parent first on the way back in, so foreign keys resolve as rows land.
  for (const table of ['knowledge_items', ...standalone, ...dependents]) {
    const columns = await sharedColumns(client, table);
    if (!columns.length) continue;
    const list = columns.join(', ');
    statements.push(`INSERT INTO ${table} (${list}) SELECT ${list} FROM snapshot_restore.${table}`);
  }
  return statements;
}

export async function restoreSnapshot(
  projectRoot: string,
  snapshotPath: string,
  options: { confirm?: boolean } = {},
): Promise<{ preRestore: Snapshot; findings: Awaited<ReturnType<typeof auditKnowledgeStore>>['findings'] }> {
  if (!options.confirm) throw new Error('Snapshot restore requires --confirm.');
  const root = path.resolve(projectRoot);
  const source = path.resolve(snapshotPath);
  const destination = databasePath(root);
  if (source === destination) throw new Error('Snapshot restore refuses the live database path.');
  await fs.access(source).catch(() => { throw new Error('Snapshot file was not found.'); });

  const manifestPath = `${source}.manifest.json`;
  try {
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8')) as SnapshotManifest;
    if (manifest.sha256 !== await sha256(source)) throw new Error('Snapshot checksum does not match its manifest.');
  } catch (error: any) {
    if (error.code !== 'ENOENT') throw error;
  }

  const preRestore = await createSnapshot(root);
  const client = getClient();
  await client.execute(`ATTACH DATABASE '${quoteSqlPath(source)}' AS snapshot_restore`);
  try {
    await client.execute('BEGIN');
    for (const statement of await restoreStatements(client)) {
      await client.execute(statement);
    }
    await client.execute('COMMIT');
  } catch (error) {
    await client.execute('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    await client.execute('DETACH DATABASE snapshot_restore');
  }
  const report = await auditKnowledgeStore();
  if (report.findings.some(finding => finding.severity === 'error')) {
    throw new Error('Restored snapshot failed integrity audit.');
  }
  return { preRestore, findings: report.findings };
}
