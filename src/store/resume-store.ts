import fs from 'node:fs/promises';
import path from 'node:path';
import { createClient, type Client } from '@libsql/client';
import { knowlHome } from '../workspace/paths.js';
import { synchronousPragma } from '../core/sqlite-sync.js';

/**
 * Where parked workstreams live: one database under the Knowl home, not inside any repo.
 *
 * This is the same reasoning `knowlHome` already applies to workspaces -- putting it in one
 * member repo would make that repo special and break when it is deleted -- but here it is the
 * feature itself. A resume key is held by the user, and the promise is that pasting it works
 * from any directory. Stored in a project's `.knowl/knowl.db`, a key parked in `~/work/api`
 * is simply invisible from `~/work/web`: measured, and it is the one thing this must not do.
 */
export function resumeDbPath(): string {
  return path.join(knowlHome(), 'resume.db');
}

function schemaStatements(): string[] {
  return [
    // Every Knowl process on this machine may open this file, so a concurrent writer must wait
    // rather than fail the open. Same reasoning as the transcript database.
    'PRAGMA busy_timeout = 10000;',
    'PRAGMA journal_mode = WAL;',
    // See `synchronousPragma`. A resume key is re-mintable and this file is tiny, so the
    // durability this trades away is worth even less here than it is in the knowledge store.
    synchronousPragma(),
    `CREATE TABLE IF NOT EXISTS resume_points (
      key TEXT PRIMARY KEY,
      project_dir TEXT NOT NULL,
      brief TEXT NOT NULL,
      created_at TEXT NOT NULL
    );`,
    `CREATE INDEX IF NOT EXISTS idx_resume_points_project ON resume_points(project_dir, created_at);`,
  ];
}

const clients = new Map<string, Client>();

/** The shared resume database, created on first use. */
export async function openResumeDb(): Promise<Client> {
  const resolved = resumeDbPath();
  const existing = clients.get(resolved);
  if (existing) return existing;

  await fs.mkdir(path.dirname(resolved), { recursive: true });
  const client = createClient({ url: `file:${resolved}` });
  try {
    for (const statement of schemaStatements()) await client.execute(statement);
  } catch (error) {
    // An un-closed client on a failed open keeps whatever lock its partial bootstrap took.
    await client.close();
    throw error;
  }

  clients.set(resolved, client);
  return client;
}

/** Drop the cached client so the next open reconnects. Tests need this on Windows. */
export async function closeResumeDb(): Promise<void> {
  const entries = [...clients.entries()];
  clients.clear();
  for (const [, client] of entries) {
    // Fold the WAL back in so the file is stable when this resolves; Windows otherwise holds
    // the sidecars and a test's directory removal fails.
    await client.execute('PRAGMA wal_checkpoint(TRUNCATE)').catch(() => {});
    client.close();
  }
}
