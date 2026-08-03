import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeTranscriptDbs, openTranscriptDb } from '../../src/transcripts/database.js';

let dir: string;
let dbPath: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'knowl-tdb-'));
  dbPath = path.join(dir, 'transcripts.db');
});

afterEach(async () => {
  await closeTranscriptDbs();
  // Swallowed, as every suite here does: on Windows libSQL keeps the database and its
  // -wal/-shm sidecars locked for the life of the process even after close() and a
  // TRUNCATE checkpoint, so this removal cannot succeed from the process that opened it.
  // Each test gets its own mkdtemp root, so a failed removal never leaks into the next.
  await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
});

describe('transcript database', () => {
  it('creates every table on first open', async () => {
    const client = await openTranscriptDb(dbPath);
    const names = (await client.execute(
      "SELECT name FROM sqlite_master WHERE type IN ('table','view') ORDER BY name",
    )).rows.map(r => String(r.name));

    expect(names).toContain('transcript_files');
    expect(names).toContain('transcript_messages');
    expect(names).toContain('transcript_fts');
    expect(names).toContain('transcript_vectors');
  });

  it('is idempotent across opens', async () => {
    await openTranscriptDb(dbPath);
    await closeTranscriptDbs();
    await expect(openTranscriptDb(dbPath)).resolves.toBeDefined();
  });

  it('supports contentless FTS5 deletion', async () => {
    const client = await openTranscriptDb(dbPath);
    await client.execute({ sql: 'INSERT INTO transcript_fts(rowid, body) VALUES (?, ?)', args: [1, 'hello world'] });
    await client.execute({ sql: 'DELETE FROM transcript_fts WHERE rowid = ?', args: [1] });

    const rows = (await client.execute("SELECT rowid FROM transcript_fts WHERE transcript_fts MATCH 'hello'")).rows;
    expect(rows).toHaveLength(0);
  });

  it('sets a busy timeout so a concurrent writer waits instead of failing', async () => {
    const client = await openTranscriptDb(dbPath);
    const value = (await client.execute('PRAGMA busy_timeout')).rows[0];
    expect(Number(Object.values(value)[0])).toBeGreaterThan(0);
  });

  it('refuses writes on a read-only open', async () => {
    await openTranscriptDb(dbPath);
    await closeTranscriptDbs();

    const peer = await openTranscriptDb(dbPath, { readOnly: true });
    await expect(
      peer.execute({ sql: 'INSERT INTO transcript_fts(rowid, body) VALUES (?, ?)', args: [9, 'x'] }),
    ).rejects.toThrow();
  });

  it('does not bootstrap a database it opens read-only', async () => {
    const missing = path.join(dir, 'absent.db');
    const peer = await openTranscriptDb(missing, { readOnly: true });
    const names = (await peer.execute("SELECT name FROM sqlite_master WHERE type='table'")).rows;
    expect(names).toHaveLength(0);
  });
});
