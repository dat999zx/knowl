import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createClient } from '@libsql/client';

import { acquireClient, releaseAll } from '../../src/store/connection-pool.js';
import { openTranscriptDb, closeTranscriptDbs } from '../../src/transcripts/database.js';
import { openResumeDb, closeResumeDb } from '../../src/session/resume-store.js';

const ROOT = path.resolve('./.knowl-pragma-test');

const readPragma = async (client: { execute: (sql: string) => Promise<any> }, name: string) => {
  const rows = (await client.execute(`PRAGMA ${name}`)).rows;
  return Object.values(rows[0] ?? {})[0];
};

/**
 * The pragmas are a decision, so they are pinned like one.
 *
 * These assertions exist to be argued with rather than quietly edited. Each carries the
 * reason it holds the value it does, because the failure they guard against is not a bug
 * that shows up in another test -- a database with the wrong `synchronous` is correct in
 * every observable way, just four times slower per write, and a database whose
 * `busy_timeout` has gone back to 0 is correct until two processes overlap.
 */
describe('database engine configuration', () => {
  beforeAll(async () => {
    await releaseAll();
    await fs.rm(ROOT, { recursive: true, force: true }).catch(() => {});
    await fs.mkdir(ROOT, { recursive: true });
  });

  afterAll(async () => {
    await releaseAll();
    await closeTranscriptDbs().catch(() => {});
    await fs.rm(ROOT, { recursive: true, force: true }).catch(() => {});
  });

  it('the knowledge database is WAL with synchronous=NORMAL', async () => {
    const client = await acquireClient(path.join(ROOT, 'knowl.db'));

    // WAL, because synchronous=NORMAL is only corruption-safe in WAL. SQLite's documentation
    // is explicit that in journal_mode=DELETE there is "a very small (though non-zero) chance
    // that a power failure at just the wrong time could corrupt the database" at NORMAL, while
    // "WAL mode is safe from corruption with synchronous=NORMAL". The two settings are one
    // decision and must not be separated.
    expect(await readPragma(client, 'journal_mode')).toBe('wal');

    // 1 = NORMAL. Not inherited -- libSQL leaves this at SQLite's default of 2 (FULL), which
    // fsyncs on every commit, and every un-batched write is its own implicit commit. Measured
    // on this schema: 3.488 ms/row at FULL against 0.832 at NORMAL for un-batched writes, and
    // 173 -> 337 writes/s with six processes contending on one file. What it trades away is
    // durability across a POWER LOSS or OS crash only: "Transactions are durable across
    // application crashes regardless of the synchronous setting or journal mode."
    expect(await readPragma(client, 'synchronous')).toBe(1);

    // Waiting beats failing: several knowl processes write to one file as the normal case,
    // and SQLite's default busy handler gives up instantly.
    expect(await readPragma(client, 'busy_timeout')).toBe(10000);
    expect(await readPragma(client, 'foreign_keys')).toBe(1);
  });

  it('the transcript index is WAL with synchronous=NORMAL', async () => {
    const client = await openTranscriptDb(path.join(ROOT, 'transcripts.db'));
    expect(await readPragma(client, 'journal_mode')).toBe('wal');
    expect(await readPragma(client, 'synchronous')).toBe(1);
    expect(await readPragma(client, 'busy_timeout')).toBe(10000);
  });

  /**
   * The landmine under the whole configuration.
   *
   * `@libsql/client@0.14.0`'s `Sqlite3Client.transaction()` hands its connection to the
   * transaction object and sets `this.#db = null`, so the NEXT `client.execute()` lazily opens
   * a brand-new connection -- with SQLite's defaults, not ours. Verified against the installed
   * client: after one `transaction()`, `busy_timeout` reads 0 and `synchronous` reads 2, and a
   * TEMP table created beforehand is gone, which is what identifies it as a different
   * connection rather than a reset one.
   *
   * The consequence is not subtle. With `busy_timeout` silently back at 0, a write contending
   * with another process fails in 42 ms with SQLITE_BUSY where it would otherwise have waited
   * 1467 ms and succeeded -- measured, both.
   *
   * knowl does not currently step on this: `withClientTransaction` issues raw BEGIN/COMMIT
   * through `execute`, and `bootstrapSchema` uses `BEGIN IMMEDIATE` the same way. Both chose
   * that for an unrelated reason (drizzle's per-transaction native leak), and neither knows it
   * is also what keeps the pragmas alive. This test is here so that a future simplification
   * back to the official API -- which looks strictly cleaner -- has to fail a test that
   * explains why it is not.
   */
  it('client.transaction() would discard the configured connection', async () => {
    const probePath = path.join(ROOT, 'landmine.db');
    const client = createClient({ url: `file:${probePath}` });
    try {
      await client.execute('PRAGMA journal_mode = WAL;');
      await client.execute('PRAGMA busy_timeout = 10000;');
      await client.execute('PRAGMA synchronous = NORMAL;');
      await client.execute('CREATE TABLE IF NOT EXISTS t (id INTEGER PRIMARY KEY)');
      expect(await readPragma(client, 'busy_timeout')).toBe(10000);

      // Raw BEGIN/COMMIT -- what knowl actually does -- keeps the connection and its pragmas.
      await client.execute('BEGIN');
      await client.execute('INSERT INTO t (id) VALUES (1)');
      await client.execute('COMMIT');
      expect(await readPragma(client, 'busy_timeout')).toBe(10000);
      expect(await readPragma(client, 'synchronous')).toBe(1);

      // The client's own transaction API does not. If this ever stops being true the
      // dependency has been fixed, and the comment above should be revisited rather than
      // this expectation simply flipped.
      const tx = await client.transaction('write');
      await tx.execute('INSERT INTO t (id) VALUES (2)');
      await tx.commit();

      expect(await readPragma(client, 'busy_timeout')).toBe(0);
      expect(await readPragma(client, 'synchronous')).toBe(2);
    } finally {
      await client.close();
    }
  });

  /**
   * Only what was measured. `mmap_size`, `cache_size` and `temp_store` were benchmarked
   * against this schema over 25 interleaved rounds and none produced an effect that survived
   * the noise -- the orderings shuffled between runs and every delta sat inside the p95
   * spread. They are therefore left at their defaults deliberately, not by omission, and this
   * records that so the next person does not re-run the same experiment.
   *
   * `mmap_size` in particular is left off on evidence, not indifference: SQLite disables
   * memory-mapped I/O by default because some operating systems' unified buffer caches are
   * buggy enough to corrupt a database, and it buys us nothing here.
   */
  it('leaves the pragmas that measured as noise at their defaults', async () => {
    const client = await acquireClient(path.join(ROOT, 'defaults.db'));
    expect(await readPragma(client, 'mmap_size')).toBe(0);
    expect(await readPragma(client, 'cache_size')).toBe(-2000);
    expect(await readPragma(client, 'temp_store')).toBe(0);
  });
});

/**
 * The escape hatch, exercised on every database it applies to.
 *
 * NORMAL is the default and the right one, but it is a durability policy and a policy applied
 * everywhere with no way out is not a decision anyone gets to make. These pin that the way out
 * exists, reaches all three files, and fails loudly rather than quietly.
 */
describe('KNOWL_SQLITE_SYNCHRONOUS reaches every database', () => {
  const savedSync = process.env.KNOWL_SQLITE_SYNCHRONOUS;
  const savedHome = process.env.KNOWL_HOME;

  // Its own root lifecycle: the describe above removes ROOT in its afterAll, which runs before
  // this block starts.
  beforeAll(async () => {
    await fs.mkdir(ROOT, { recursive: true });
  });

  afterAll(async () => {
    await releaseAll();
    await closeTranscriptDbs().catch(() => {});
    await closeResumeDb().catch(() => {});
    await fs.rm(ROOT, { recursive: true, force: true }).catch(() => {});
  });

  afterEach(async () => {
    if (savedSync === undefined) delete process.env.KNOWL_SQLITE_SYNCHRONOUS;
    else process.env.KNOWL_SQLITE_SYNCHRONOUS = savedSync;
    if (savedHome === undefined) delete process.env.KNOWL_HOME;
    else process.env.KNOWL_HOME = savedHome;
    await releaseAll();
    await closeTranscriptDbs().catch(() => {});
    await closeResumeDb().catch(() => {});
  });

  // Each case opens its OWN file. The connection pool caches by path, so re-acquiring one
  // already opened would hand back a client still carrying the previous case's pragma.
  it('gives the knowledge database FULL when asked', async () => {
    process.env.KNOWL_SQLITE_SYNCHRONOUS = 'FULL';
    const client = await acquireClient(path.join(ROOT, 'sync-full.db'));
    expect(await readPragma(client, 'synchronous')).toBe(2);
  });

  it('gives the transcript index FULL when asked', async () => {
    process.env.KNOWL_SQLITE_SYNCHRONOUS = 'FULL';
    const client = await openTranscriptDb(path.join(ROOT, 'sync-full-transcripts.db'));
    expect(await readPragma(client, 'synchronous')).toBe(2);
  });

  it('gives the resume store FULL when asked', async () => {
    process.env.KNOWL_HOME = path.join(ROOT, 'home-full');
    process.env.KNOWL_SQLITE_SYNCHRONOUS = 'FULL';
    const client = await openResumeDb();
    expect(await readPragma(client, 'synchronous')).toBe(2);
  });

  it('still defaults to NORMAL with the variable unset', async () => {
    delete process.env.KNOWL_SQLITE_SYNCHRONOUS;
    const client = await acquireClient(path.join(ROOT, 'sync-default.db'));
    expect(await readPragma(client, 'synchronous')).toBe(1);
  });

  it('refuses to open a database at all on an unrecognised value', async () => {
    // Not a fallback to NORMAL. Handing NORMAL to somebody who asked for FULL is the failure
    // the variable exists to prevent, so a typo has to stop the command.
    process.env.KNOWL_SQLITE_SYNCHRONOUS = 'sorta';
    await expect(acquireClient(path.join(ROOT, 'sync-bad.db')))
      .rejects.toThrow(/must be NORMAL or FULL/);
  });
});
