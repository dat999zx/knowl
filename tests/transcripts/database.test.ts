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
    // An existing file, so the assertion is about bootstrap and not about creation. The
    // missing-file case is covered below, where the correct behaviour is to refuse rather
    // than to open an empty database -- this test previously asserted the latter, which was
    // the bug: it left an empty transcripts.db in a peer repo that had none.
    const bare = path.join(dir, 'bare.db');
    await fs.writeFile(bare, '');

    const peer = await openTranscriptDb(bare, { readOnly: true });
    const names = (await peer.execute("SELECT name FROM sqlite_master WHERE type='table'")).rows;
    expect(names).toHaveLength(0);
  });
});

describe('a read-only open never creates the database', () => {
  // `file:<path>` creates the file and `query_only` is applied only after the connection is
  // open, so a "read-only" open of a peer with no index used to write an empty transcripts.db
  // into that repo's .knowl/ -- the exact thing "we only ever read a peer" rules out.
  // `?mode=ro` is not available: @libsql/client rejects it with URL_PARAM_NOT_SUPPORTED.
  it('throws instead of creating a missing file', async () => {
    const missing = path.join(dir, 'absent.db');

    await expect(openTranscriptDb(missing, { readOnly: true })).rejects.toThrow(/no transcript index/i);
    await expect(fs.access(missing)).rejects.toThrow();
  });

  it('opens an existing database read-only as before', async () => {
    await openTranscriptDb(dbPath);
    await closeTranscriptDbs();

    const client = await openTranscriptDb(dbPath, { readOnly: true });
    await expect(client.execute('SELECT 1')).resolves.toBeDefined();
  });

  it('still creates the database on a writable open', async () => {
    const fresh = path.join(dir, 'fresh.db');
    await openTranscriptDb(fresh);
    await expect(fs.access(fresh)).resolves.toBeUndefined();
  });
});
