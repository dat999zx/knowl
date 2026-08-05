import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Client } from '@libsql/client';
import { auditKnowledgeStore } from './integrity.js';
import { getClient, withClientTransaction } from './database.js';
import { pruneSnapshots, SNAPSHOT_KEEP } from './retention.js';
import { resolveStorage } from './storage-roles.js';
import { KNOWL_SCHEMA_VERSION } from './schema-version.js';

export type SnapshotManifest = {
  schemaVersion: number;
  createdAt: string;
  byteSize: number;
  sha256: string;
};

export type Snapshot = {
  path: string;
  manifestPath: string;
  manifest: SnapshotManifest;
  /** Older snapshots this one replaced. Reported rather than silent; see `pruneSnapshots`. */
  pruned: string[];
};

function databasePath(projectRoot: string): string {
  return path.resolve(resolveStorage(projectRoot).knowledge);
}

async function sha256(filePath: string): Promise<string> {
  return crypto.createHash('sha256').update(await fs.readFile(filePath)).digest('hex');
}

function quoteSqlPath(filePath: string): string {
  return filePath.replace(/'/g, "''");
}

export async function createSnapshot(
  projectRoot: string,
  options: { protect?: string[] } = {},
): Promise<Snapshot> {
  const root = path.resolve(projectRoot);
  const snapshotDir = path.join(root, '.knowl', 'snapshots');
  await fs.mkdir(snapshotDir, { recursive: true });
  const createdAt = new Date().toISOString();
  const stem = `${createdAt.replace(/[:.]/g, '-')}-${crypto.randomUUID().slice(0, 8)}`;
  const snapshotPath = path.join(snapshotDir, `${stem}.db`);

  await getClient().execute(`VACUUM INTO '${quoteSqlPath(snapshotPath)}'`);

  const stat = await fs.stat(snapshotPath);
  const manifest: SnapshotManifest = {
    // The real constant, not a literal. A manifest that records "1" forever cannot be checked
    // for compatibility once the schema moves.
    schemaVersion: KNOWL_SCHEMA_VERSION,
    createdAt,
    byteSize: stat.size,
    sha256: await sha256(snapshotPath),
  };
  const manifestPath = `${snapshotPath}.manifest.json`;
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');

  // Pruned here rather than in a maintenance command, because this is the moment the older
  // ones became redundant -- and because `upgrade --all` snapshots every repository on the
  // machine, so without this the growth is on a schedule. Returned, never silent: the caller
  // prints what went, so nobody discovers it from a directory listing.
  const pruned = await pruneSnapshots(snapshotDir, SNAPSHOT_KEEP, [snapshotPath, ...(options.protect ?? [])]);

  return { path: snapshotPath, manifestPath, manifest, pruned };
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

  // ATTACH *creates* a missing database rather than failing, so an attachment can be a
  // perfectly valid empty file. Every table lookup below then finds nothing, the INSERT loop
  // skips every table for want of shared columns, and the statement list degrades to a bare
  // `DELETE FROM knowledge_items` -- which cascades through assertions, evidence links,
  // access, skill rows and embeddings and leaves a store the post-restore audit calls healthy.
  // A restore that inserts nothing is not a restore.
  if (!present.has('knowledge_items')) {
    throw new Error(
      'The attached snapshot holds no knowledge_items table, so there is nothing to restore. ' +
      'Refusing: continuing would delete the live store and insert nothing. ' +
      'The snapshot file was verified and then moved, removed, or replaced before it could be read.',
    );
  }

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

/**
 * A restore that landed and then failed its own audit.
 *
 * The distinction this error exists to carry is that the destruction is already committed:
 * the audit runs afterwards, so by the time it objects the store holds the snapshot's
 * contents, faults and all. `restoreSnapshot` takes a pre-restore snapshot precisely for
 * this case, and then said nothing about it -- the one message in the system that most needs
 * to name a file. An operator was left knowing the restore broke, in a store that is already
 * broken, with the way back sitting unnamed among timestamped filenames.
 */
export class SnapshotRestoreAuditError extends Error {
  constructor(
    public readonly preRestorePath: string,
    public readonly findings: Awaited<ReturnType<typeof auditKnowledgeStore>>['findings'],
  ) {
    const errors = findings.filter(finding => finding.severity === 'error');
    super(
      `Restored snapshot failed its integrity audit: ${errors.length} error finding(s) ` +
      `(${[...new Set(errors.map(finding => finding.code))].join(', ')}).\n` +
      `The restore was already applied -- this store now holds the snapshot's contents, ` +
      `faults and all.\n` +
      `Your previous state was snapshotted first, and is at:\n` +
      `  ${preRestorePath}\n` +
      `To put it back: knowl snapshot restore "${preRestorePath}" --confirm`,
    );
    this.name = 'SnapshotRestoreAuditError';
  }
}

/**
 * Verify the manifest before anything destructive happens.
 *
 * A checksum proves the bytes are intact, not who wrote them: whoever produces a snapshot can
 * compute a valid checksum for it. This is an integrity check against corruption and truncated
 * copies, and it does not claim more. What it must not do is pass silently -- the manifest was
 * previously optional, so a snapshot with none was restored with no verification at all, which
 * is the one situation where the previous state is already gone.
 */
async function verifySnapshotManifest(source: string): Promise<SnapshotManifest> {
  const manifestPath = `${source}.manifest.json`;
  let manifest: SnapshotManifest;
  try {
    manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8')) as SnapshotManifest;
  } catch (error: any) {
    throw new Error(error.code === 'ENOENT'
      ? `Snapshot manifest "${manifestPath}" was not found. Restore requires the manifest written beside the snapshot.`
      : `Snapshot manifest "${manifestPath}" is unreadable: ${error.message}`);
  }

  if (!Number.isInteger(manifest.schemaVersion) || manifest.schemaVersion > KNOWL_SCHEMA_VERSION) {
    throw new Error(
      `Snapshot was written with schema version ${manifest.schemaVersion}; this build reads up to ` +
      `${KNOWL_SCHEMA_VERSION}. Upgrade Knowl before restoring it.`,
    );
  }

  const stat = await fs.stat(source);
  if (stat.size !== manifest.byteSize) {
    throw new Error(`Snapshot size ${stat.size} does not match its manifest size ${manifest.byteSize}.`);
  }
  if (manifest.sha256 !== await sha256(source)) {
    throw new Error('Snapshot checksum does not match its manifest.');
  }
  return manifest;
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

  await verifySnapshotManifest(source);

  // The source is named as protected because this prune runs between the manifest check above
  // and the ATTACH below. Without it, restoring anything but the two newest snapshots deleted
  // the very file being restored.
  const preRestore = await createSnapshot(root, { protect: [source] });
  const client = getClient();
  // ATTACH cannot run inside a transaction, so it stays outside the wrapper on both sides.
  await client.execute(`ATTACH DATABASE '${quoteSqlPath(source)}' AS snapshot_restore`);
  try {
    // Asked of the attachment rather than a second connection: opening the snapshot separately
    // would create WAL sidecars beside a file this function is only supposed to read.
    const integrity = await client.execute('PRAGMA snapshot_restore.integrity_check');
    const verdict = String(integrity.rows[0]?.integrity_check ?? '');
    if (verdict !== 'ok') throw new Error(`Snapshot failed SQLite integrity_check: ${verdict}`);

    const stamped = Number((await client.execute('PRAGMA snapshot_restore.user_version')).rows[0]?.user_version ?? 0);
    if (stamped > KNOWL_SCHEMA_VERSION) {
      throw new Error(
        `Snapshot database is stamped with schema version ${stamped}; this build reads up to ` +
        `${KNOWL_SCHEMA_VERSION}. Upgrade Knowl before restoring it.`,
      );
    }

    // Through the shared wrapper rather than a raw BEGIN. A transaction belongs to the
    // connection and this process holds exactly one, so an unserialised BEGIN here could
    // interleave with any other writer into `BEGIN; BEGIN;` -- which SQLite refuses with
    // SQLITE_ERROR, not SQLITE_BUSY, so nothing retries it. Restore is the worst possible
    // place for a half-applied transaction.
    await withClientTransaction(async () => {
      for (const statement of await restoreStatements(client)) {
        await client.execute(statement);
      }
    });
  } finally {
    await client.execute('DETACH DATABASE snapshot_restore');
  }
  const report = await auditKnowledgeStore();
  if (report.findings.some(finding => finding.severity === 'error')) {
    throw new SnapshotRestoreAuditError(preRestore.path, report.findings);
  }
  return { preRestore, findings: report.findings };
}
