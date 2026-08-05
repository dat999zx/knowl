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
 * Tables the knowledge graph owns that nothing in it points *at*.
 *
 * The dependent walk below finds children. It cannot find parents, because a foreign key runs
 * one way: `knowledge_evidence.evidence_id` and `knowledge_assertions.source_evidence_id` both
 * reference `evidence`, and neither tells `evidence` about it. So a restore rebuilt the links
 * and left the rows they point at at their current values -- snapshot-era assertions attached
 * to present-day evidence, and evidence edited since the snapshot not rolled back at all.
 *
 * `knowledge_commits` is here for the same reason from the other direction: it has no foreign
 * key into items, but restoring items without their commits leaves the audit trail describing
 * a store that no longer exists.
 */
const RESTORE_ROOTS = ['knowledge_items', 'evidence', 'knowledge_commits'] as const;

/**
 * Every table a restore has to rewrite, derived rather than listed, and derived *transitively*.
 *
 * The previous walk stopped one foreign key from `knowledge_items`, which missed everything
 * that depends on a dependent. `knowledge_commit_items` references `knowledge_commits`, so
 * deleting commits cascaded it away and nothing put it back -- and that table is what makes
 * blast radius an equality search rather than a leading-wildcard scan (see
 * `compactKnowledgeCommits`). A successful restore silently degraded it.
 *
 * Returned parents-first so foreign keys resolve as rows land; callers delete in reverse.
 */
async function restoreClosure(client: Client, present: Set<string>): Promise<string[]> {
  const tables = (await client.execute(
    `SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
  )).rows.map(row => String(row.name));

  const references = new Map<string, string[]>();
  for (const name of tables) {
    const fks = await client.execute(`PRAGMA foreign_key_list(${name})`);
    references.set(name, [...new Set(fks.rows.map(fk => String(fk.table)))]);
  }

  // Breadth-first from the roots, so a table joins the moment anything already in the set is
  // its parent. Ordered by insertion, which is parents-before-children by construction.
  const ordered: string[] = [];
  const seen = new Set<string>();
  const queue = RESTORE_ROOTS.filter(root => present.has(root));
  for (const root of queue) { seen.add(root); ordered.push(root); }

  for (let index = 0; index < ordered.length; index += 1) {
    const parent = ordered[index];
    for (const name of tables) {
      if (seen.has(name) || !present.has(name)) continue;
      if (!(references.get(name) ?? []).includes(parent)) continue;
      seen.add(name);
      ordered.push(name);
    }
  }

  // FTS shadow tables are maintained by the triggers `bootstrap` defines, so they rebuild
  // themselves as rows land. Writing them directly would fight those triggers.
  return ordered.filter(name => !name.startsWith('knowledge_items_fts'));
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

  const ordered = await restoreClosure(client, present);
  const statements: string[] = [];

  // Children first, then parents: relying on the cascade to clear dependents is what hid the
  // original defect, and an explicit delete says which tables this function owns.
  for (const table of [...ordered].reverse()) statements.push(`DELETE FROM ${table}`);

  // Parents first on the way back in, so foreign keys resolve as rows land.
  for (const table of ordered) {
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
 * Read and range-check the sidecar manifest. Says nothing about the bytes.
 *
 * A checksum proves the bytes are intact, not who wrote them: whoever produces a snapshot can
 * compute a valid checksum for it. This is an integrity check against corruption and truncated
 * copies, and it does not claim more. What it must not do is pass silently -- the manifest was
 * previously optional, so a snapshot with none was restored with no verification at all, which
 * is the one situation where the previous state is already gone.
 */
async function readSnapshotManifest(source: string): Promise<SnapshotManifest> {
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
  return manifest;
}

/**
 * Prove one specific file matches a manifest.
 *
 * Separate from reading the manifest so the caller can verify the copy it is about to attach
 * rather than the path it read the manifest from. Those were the same call, and the gap
 * between them -- a VACUUM, a stat, a hash, a write and a directory prune -- was wide enough
 * that a pruned source became an empty ATTACH and a restore deleted a store it could not
 * refill.
 */
async function verifySnapshotBytes(file: string, manifest: SnapshotManifest): Promise<void> {
  const stat = await fs.stat(file);
  if (stat.size !== manifest.byteSize) {
    throw new Error(`Snapshot size ${stat.size} does not match its manifest size ${manifest.byteSize}.`);
  }
  if (manifest.sha256 !== await sha256(file)) {
    throw new Error('Snapshot checksum does not match its manifest.');
  }
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

  const manifest = await readSnapshotManifest(source);

  // Copied out of the snapshot directory before anything else runs, and everything after this
  // point reads the copy. `.knowl/` rather than `.knowl/snapshots/`, so the pre-restore
  // prune -- which matches on `.db` -- cannot see it. This is also why the WAL sidecars the
  // attachment creates land beside a throwaway file instead of beside a snapshot Knowl is
  // only supposed to read.
  const staged = path.join(path.dirname(destination), `.restore-${crypto.randomUUID().slice(0, 8)}.db`);
  await fs.copyFile(source, staged);

  try {
    await verifySnapshotBytes(staged, manifest);

    // The source is named as protected because this prune runs inside the restore. Without
    // it, restoring anything but the two newest snapshots deleted the very file being
    // restored -- and before the copy above, that deletion reached the file ATTACH was about
    // to open.
    const preRestore = await createSnapshot(root, { protect: [source] });
    const client = getClient();
    // ATTACH cannot run inside a transaction, so it stays outside the wrapper on both sides.
    await client.execute(`ATTACH DATABASE '${quoteSqlPath(staged)}' AS snapshot_restore`);
    try {
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
  } finally {
    // Sidecars too: the attachment may have written them beside the copy.
    for (const suffix of ['', '-wal', '-shm']) {
      await fs.rm(`${staged}${suffix}`, { force: true }).catch(() => {});
    }
  }
}
