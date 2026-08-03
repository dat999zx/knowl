import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeTranscriptDbs, openTranscriptDb, withWriteRetry } from '../../src/transcripts/database.js';

let dir: string;
let dbPath: string;
/**
 * A second scratch root, inside the repo rather than the system temp directory. The
 * two-writer test spawns a child script, and Node resolves that script's bare `@libsql/client`
 * import by walking up from the *script's* own location -- from os.tmpdir() there is no
 * node_modules to find. `.knowl-*` is gitignored and swept by tests/global-teardown.ts.
 */
let repoScratch: string;
let scratchIndex = 0;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'knowl-conc-'));
  dbPath = path.join(dir, 'transcripts.db');
  repoScratch = path.resolve(`./.knowl-conc-${process.pid}-${scratchIndex++}`);
  await fs.mkdir(repoScratch, { recursive: true });
});

afterEach(async () => {
  await closeTranscriptDbs();
  // See tests/transcripts/database.test.ts: Windows holds the file for the life of the
  // process, so this cannot succeed here. Each test has its own root, so it does not matter.
  await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  await fs.rm(repoScratch, { recursive: true, force: true }).catch(() => {});
});

describe('withWriteRetry', () => {
  it('returns the callback result when nothing goes wrong', async () => {
    const value = await withWriteRetry(dbPath, async client => {
      await client.execute({ sql: 'INSERT INTO transcript_fts(rowid, body) VALUES (?, ?)', args: [1, 'x'] });
      return 'done';
    });
    expect(value).toBe('done');
  });

  it('reopens the connection on SQLITE_BUSY_SNAPSHOT and retries', async () => {
    let attempts = 0;
    const clients: unknown[] = [];

    const value = await withWriteRetry(dbPath, async client => {
      attempts++;
      clients.push(client);
      if (attempts === 1) {
        const error = new Error('database is locked (SQLITE_BUSY_SNAPSHOT)');
        (error as { code?: string }).code = 'SQLITE_BUSY_SNAPSHOT';
        throw error;
      }
      return 'recovered';
    });

    expect(value).toBe('recovered');
    expect(attempts).toBe(2);
    // A retry that reuses the pinned connection would fail forever; it must be a new one.
    expect(clients[0]).not.toBe(clients[1]);
  });

  it('retries a plain SQLITE_BUSY without reopening', async () => {
    let attempts = 0;
    await withWriteRetry(dbPath, async () => {
      attempts++;
      if (attempts < 3) {
        const error = new Error('database is locked');
        (error as { code?: string }).code = 'SQLITE_BUSY';
        throw error;
      }
    });
    expect(attempts).toBe(3);
  });

  it('gives up after the attempt limit rather than looping forever', async () => {
    await expect(
      withWriteRetry(dbPath, async () => {
        const error = new Error('database is locked');
        (error as { code?: string }).code = 'SQLITE_BUSY';
        throw error;
      }, { attempts: 3 }),
    ).rejects.toThrow(/locked/);
  });

  it('does not retry an error that is not a lock', async () => {
    let attempts = 0;
    await expect(
      withWriteRetry(dbPath, async () => {
        attempts++;
        throw new Error('UNIQUE constraint failed: transcript_messages.line');
      }),
    ).rejects.toThrow(/UNIQUE/);
    expect(attempts).toBe(1);
  });
});

describe('two concurrent writers', () => {
  /**
   * Two writers means two *processes*, which is also the case the feature actually faces: a
   * `--budget` backfill running while a live session's per-turn hook fires.
   *
   * It cannot be tested in-process. `@libsql/client`'s local driver is synchronous -- measured
   * here, the event loop does not tick once during a 400-insert transaction -- so two
   * connections driven by one thread deadlock by construction: whichever loses the race blocks
   * the only thread its lock-holder could commit on, and both sit there until busy_timeout
   * expires. Routing them through `openTranscriptDb` instead would be worse, sharing one cached
   * connection that contends for nothing and passing against no concurrency handling at all.
   */
  it('both complete without a lost update or a uniqueness collision', async () => {
    await openTranscriptDb(dbPath); // bootstrap the schema once
    await closeTranscriptDbs();

    const script = path.join(repoScratch, 'writer.mjs');
    await fs.writeFile(script, `
      import { createClient } from '@libsql/client';
      const [dbPath, base] = process.argv.slice(2);
      const client = createClient({ url: 'file:' + dbPath });
      await client.execute('PRAGMA busy_timeout = 10000;');
      for (let i = 0; i < 50; i++) {
        await client.execute('BEGIN IMMEDIATE');
        await client.execute({
          sql: 'INSERT INTO transcript_fts(rowid, body) VALUES (?, ?)',
          args: [Number(base) + i, 'row ' + (Number(base) + i)],
        });
        await client.execute('COMMIT');
      }
      client.close();
    `);

    const spawnWriter = (base: number) => new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, [script, dbPath, String(base)], { stdio: 'pipe' });
      let stderr = '';
      child.stderr.on('data', chunk => { stderr += chunk; });
      child.on('error', reject);
      child.on('exit', code => code === 0 ? resolve() : reject(new Error(`writer ${base} exited ${code}: ${stderr}`)));
    });

    await Promise.all([spawnWriter(1_000), spawnWriter(2_000)]);

    const client = await openTranscriptDb(dbPath);
    const n = (await client.execute("SELECT rowid FROM transcript_fts WHERE transcript_fts MATCH 'row'")).rows.length;
    expect(n).toBe(100);
  }, 60_000);

  it('a reconnect inside withWriteRetry does not leave an earlier handle in use', async () => {
    // The bug this guards: a caller that captured a client before the retry kept using it after
    // withWriteRetry closed and replaced it. Nothing may hold a handle across the boundary.
    const first = await openTranscriptDb(dbPath);

    let attempts = 0;
    await withWriteRetry(dbPath, async () => {
      attempts++;
      if (attempts === 1) {
        const error = new Error('SQLITE_BUSY_SNAPSHOT');
        (error as { code?: string }).code = 'SQLITE_BUSY_SNAPSHOT';
        throw error;
      }
    });

    const second = await openTranscriptDb(dbPath);
    expect(second).not.toBe(first);
    // And the replacement is usable, which a closed handle would not be.
    await expect(second.execute('SELECT 1')).resolves.toBeDefined();
  });
});
