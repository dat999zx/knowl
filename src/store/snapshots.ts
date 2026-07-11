import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { auditKnowledgeStore } from './integrity.js';
import { getClient } from './database.js';

export type SnapshotManifest = {
  schemaVersion: number;
  createdAt: string;
  byteSize: number;
  sha256: string;
};

export type Snapshot = { path: string; manifestPath: string; manifest: SnapshotManifest };

function databasePath(projectRoot: string): string {
  return path.resolve(projectRoot, '.knowl', 'knowl.db');
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
    for (const statement of [
      'DELETE FROM knowledge_embeddings',
      'DELETE FROM skill_steps',
      'DELETE FROM skill_metadata',
      'DELETE FROM knowledge_items',
      'DELETE FROM knowledge_commits',
      'INSERT INTO knowledge_items SELECT * FROM snapshot_restore.knowledge_items',
      'INSERT INTO knowledge_commits SELECT * FROM snapshot_restore.knowledge_commits',
      'INSERT INTO skill_steps SELECT * FROM snapshot_restore.skill_steps',
      'INSERT INTO skill_metadata SELECT * FROM snapshot_restore.skill_metadata',
      'INSERT INTO knowledge_embeddings SELECT * FROM snapshot_restore.knowledge_embeddings',
    ]) {
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
