import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeTranscriptDbs } from '../../src/transcripts/database.js';
import {
  applyTranscriptConfigTransition,
  describeTranscriptTeardown,
  removeTranscriptIndex,
} from '../../src/transcripts/teardown.js';
import type { ProjectConfig } from '../../src/core/types.js';

let dir: string;
let dbPath: string;
let scratch: string;
let scratchIndex = 0;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'knowl-teardown-'));
  await fs.mkdir(path.join(dir, '.knowl'), { recursive: true });
  dbPath = path.join(dir, '.knowl', 'transcripts.db');
  // Inside the repo so the child script can resolve @libsql/client. `.knowl-*` is gitignored
  // and swept by tests/global-teardown.ts.
  scratch = path.resolve(`./.knowl-teardown-${process.pid}-${scratchIndex++}`);
  await fs.mkdir(scratch, { recursive: true });
});

afterEach(async () => {
  await closeTranscriptDbs();
  await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
});

/**
 * Create the index in a *separate process*, which is what production looks like.
 *
 * The indexing hook and `knowl config set` are different runs. Building the fixture in-process
 * would leave this process holding the file -- on Windows, permanently -- and would test a
 * situation that never occurs while hiding the one that does.
 */
async function seedIndexFromAnotherProcess(rows = 1): Promise<void> {
  const script = path.join(scratch, 'seed.mjs');
  await fs.writeFile(script, `
    import { createClient } from '@libsql/client';
    const [dbPath, rows] = process.argv.slice(2);
    const c = createClient({ url: 'file:' + dbPath });
    await c.execute('PRAGMA busy_timeout = 10000;');
    await c.execute('PRAGMA journal_mode = WAL;');
    await c.execute(\`CREATE TABLE IF NOT EXISTS transcript_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT, path TEXT NOT NULL, session_id TEXT NOT NULL,
      parent_session_id TEXT, line INTEGER NOT NULL, role TEXT NOT NULL, chars INTEGER NOT NULL, ts TEXT)\`);
    for (let i = 0; i < Number(rows); i++) {
      await c.execute({
        sql: 'INSERT INTO transcript_messages (path, session_id, line, role, chars) VALUES (?, ?, ?, ?, ?)',
        args: ['/x.jsonl', 's', i + 1, 'user', 4],
      });
    }
    c.close();
  `);
  const result = spawnSync(process.execPath, [script, dbPath, String(rows)], { encoding: 'utf-8' });
  if (result.status !== 0) throw new Error(`seed failed: ${result.stderr}`);
}

describe('removeTranscriptIndex', () => {
  it('deletes the database and reports what was reclaimed', async () => {
    await seedIndexFromAnotherProcess(5);

    const result = await removeTranscriptIndex(dir);

    expect(result.removed).toBe(true);
    expect(result.error).toBeNull();
    expect(result.bytes).toBeGreaterThan(0);
    await expect(fs.access(dbPath)).rejects.toThrow();
  });

  it('removes the WAL sidecars too', async () => {
    await seedIndexFromAnotherProcess();
    await removeTranscriptIndex(dir);

    for (const suffix of ['', '-wal', '-shm']) {
      await expect(fs.access(`${dbPath}${suffix}`)).rejects.toThrow();
    }
  });

  it('is a no-op when there is no index', async () => {
    const result = await removeTranscriptIndex(dir);
    expect(result).toEqual({ removed: false, bytes: 0, error: null });
    expect(describeTranscriptTeardown(result)).toBeNull();
  });

  it('deletes a corrupt database instead of leaving it behind', async () => {
    // The case that matters most: an unreadable index is exactly what a user wants gone, and
    // any implementation that reads it before deciding abandons it on disk.
    await fs.writeFile(dbPath, 'this is not a sqlite file');

    const result = await removeTranscriptIndex(dir);

    expect(result.removed).toBe(true);
    await expect(fs.access(dbPath)).rejects.toThrow();
  });

  it('describes what it reclaimed', async () => {
    await seedIndexFromAnotherProcess(50);
    expect(describeTranscriptTeardown(await removeTranscriptIndex(dir)))
      .toMatch(/Removed the transcript index \(.+ reclaimed\)/);
  });
});

describe('applyTranscriptConfigTransition', () => {
  const configWith = (enabled: boolean): ProjectConfig => ({
    version: 1,
    security: { rejectSecrets: true, secretPatterns: [] },
    search: { transcripts: { enabled } },
  });

  it('removes the index on the true -> false transition', async () => {
    await seedIndexFromAnotherProcess();
    const result = await applyTranscriptConfigTransition(dir, configWith(true), configWith(false));

    expect(result.removed).toBe(true);
    await expect(fs.access(dbPath)).rejects.toThrow();
  });

  it('leaves the index alone when it stays enabled', async () => {
    await seedIndexFromAnotherProcess();
    const result = await applyTranscriptConfigTransition(dir, configWith(true), configWith(true));

    expect(result.removed).toBe(false);
    await expect(fs.access(dbPath)).resolves.toBeUndefined();
  });

  it('does nothing when it was already off', async () => {
    const result = await applyTranscriptConfigTransition(dir, configWith(false), configWith(false));
    expect(result).toEqual({ removed: false, bytes: 0, error: null });
  });
});
