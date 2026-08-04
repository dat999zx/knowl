import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createClient } from '@libsql/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeTranscriptDbs, openTranscriptDb } from '../../src/transcripts/database.js';
import { runIndexPass } from '../../src/transcripts/index-pass.js';
import { offsetResumePoint } from '../../src/transcripts/offset-backfill.js';
import { encodeProjectDir } from '../../src/transcripts/paths.js';
import { readMessagesFor } from '../../src/transcripts/read.js';

let dir: string;
let projectsDir: string;
let dbPath: string;
const PROJECT_ROOT = '/repo/knowl';
const ENCODED_ROOT = encodeProjectDir(path.resolve(PROJECT_ROOT));

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'knowl-offs-'));
  projectsDir = path.join(dir, 'projects');
  dbPath = path.join(dir, 'transcripts.db');
  await fs.mkdir(path.join(projectsDir, ENCODED_ROOT), { recursive: true });
});

afterEach(async () => {
  await closeTranscriptDbs();
  // Swallowed: Windows holds the database for the life of the process. Each test has its own root.
  await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
});

const line = (role: 'user' | 'assistant', text: string) =>
  JSON.stringify({ type: role, timestamp: '2026-08-03T10:00:00Z', message: { content: text } }) + '\n';

const sessionFile = (name: string) => path.join(projectsDir, ENCODED_ROOT, `${name}.jsonl`);
const pass = (deadline?: number) => runIndexPass({ projectRoot: PROJECT_ROOT, dbPath, projectsDir, deadline });

/** Byte offsets of each line in a file built from these strings: the oracle for what is stored. */
function offsetsOf(lines: string[]): number[] {
  const offsets: number[] = [];
  let at = 0;
  for (const text of lines) { offsets.push(at); at += Buffer.byteLength(text); }
  return offsets;
}

async function raw<T>(run: (client: Awaited<ReturnType<typeof openTranscriptDb>>) => Promise<T>): Promise<T> {
  await closeTranscriptDbs();
  const client = createClient({ url: `file:${path.resolve(dbPath)}` });
  try {
    return await run(client);
  } finally {
    client.close();
  }
}

/**
 * Put the messages table back into the shape it had before `byte_offset` existed.
 *
 * The partial index over the un-filled rows has to go first: SQLite refuses to drop a column an
 * index is built on, and an index from before the column could not have existed anyway.
 */
async function regressToNoOffsets(): Promise<void> {
  await raw(async client => {
    await client.execute('DROP INDEX IF EXISTS idx_transcript_messages_pending_offset');
    await client.execute('ALTER TABLE transcript_messages DROP COLUMN byte_offset');
  });
}

async function storedOffsets(): Promise<(number | null)[]> {
  const client = await openTranscriptDb(dbPath);
  return (await client.execute('SELECT byte_offset FROM transcript_messages ORDER BY line')).rows
    .map(row => (row.byte_offset === null ? null : Number(row.byte_offset)));
}

describe('an index whose rows predate the byte_offset column', () => {
  // K-47 shipped a 57x faster read by storing where each message starts, and every row already
  // in an index was left without one. Nothing re-reads a file that is already up to date, so
  // those rows never gain an offset and every hit on them takes the old streaming scan -- for
  // ever. The fix works, and nobody who already had an index gets it.
  it('gains offsets on a later pass', async () => {
    const lines = [line('user', 'first'), line('assistant', 'second'), line('user', 'third')];
    await fs.writeFile(sessionFile('a'), lines.join(''));
    await pass();

    await regressToNoOffsets();
    await openTranscriptDb(dbPath); // migrates: the column is back, every row null
    expect(await storedOffsets()).toEqual([null, null, null]);

    const result = await pass();

    expect(result.offsetsFilled).toBe(3);
    expect(await storedOffsets()).toEqual(offsetsOf(lines));
  });

  it('stores the byte the line begins at, so a seek lands on that message', async () => {
    const lines = [
      line('user', 'a question about embeddings'),
      line('assistant', 'an answer with a much longer body than the question had'),
      line('user', 'unicode: caffè, 日本語, and an emoji 🦆'),
      line('assistant', 'the last word'),
    ];
    await fs.writeFile(sessionFile('a'), lines.join(''));
    await pass();
    await regressToNoOffsets();
    await openTranscriptDb(dbPath);
    await pass();

    const client = await openTranscriptDb(dbPath);
    const pointers = (await client.execute('SELECT line, byte_offset, chars FROM transcript_messages ORDER BY line')).rows
      .map(row => ({
        line: Number(row.line),
        byteOffset: row.byte_offset === null ? null : Number(row.byte_offset),
        chars: Number(row.chars),
      }));
    expect(pointers.map(p => p.byteOffset)).toEqual(offsetsOf(lines));

    // Read back through the seeking path. `readMessagesFor` falls back to a scan for anything an
    // offset fails to resolve, so this asserts the bodies are right, not that the offsets were used.
    const bodies = await readMessagesFor(sessionFile('a'), pointers);
    expect(bodies.get(3)?.text).toBe('unicode: caffè, 日本語, and an emoji 🦆');
    expect(bodies.get(4)?.text).toBe('the last word');
  });

  // The reason this is a backfill and not a rebuild. An offset is metadata about where a message
  // sits in a file; the message, its FTS entry and its embedding are unchanged, and re-embedding
  // an archive is the expensive thing this must never trigger (K-11).
  it('keeps every id, FTS row and vector it fills around', async () => {
    await fs.writeFile(sessionFile('a'), line('user', 'worth embedding') + line('assistant', 'also embedded'));
    await pass();

    const before = await raw(async client => {
      const ids = (await client.execute('SELECT id FROM transcript_messages ORDER BY line')).rows.map(r => Number(r.id));
      for (const id of ids) {
        await client.execute({
          sql: 'INSERT INTO transcript_vectors (message_id, fingerprint, dims, scale, vec) VALUES (?, ?, ?, ?, ?)',
          args: [id, 'test-model', 4, 1, new Uint8Array([1, 2, 3, 4])],
        });
      }
      return ids;
    });

    await regressToNoOffsets();
    await openTranscriptDb(dbPath);
    await pass();

    const client = await openTranscriptDb(dbPath);
    const after = (await client.execute('SELECT id FROM transcript_messages ORDER BY line')).rows.map(r => Number(r.id));
    const vectors = Number((await client.execute('SELECT COUNT(*) AS n FROM transcript_vectors')).rows[0].n);
    const hits = (await client.execute("SELECT rowid FROM transcript_fts WHERE transcript_fts MATCH 'embedding'")).rows;

    expect(after).toEqual(before);
    expect(vectors).toBe(2);
    expect(hits).toHaveLength(1);
  });
});

describe('the backfill inside a budget', () => {
  const many = (n: number) => Array.from({ length: n }, (_, i) => line('user', `message ${i}`));

  // K-65's shape, third appearance: the expiry test ran BEFORE the first file, so a budget
  // eaten by scheduling before the loop was reached filled zero rows — pass after pass, each
  // reporting an honest `complete: false` and doing nothing. On a busy machine the backfill
  // was starved forever. A budget real at call time now buys exactly one batch, the same
  // bounded overrun the index pass accepts. This test is deterministic under ANY load: +1 ms
  // is always gone by the time the loop starts (the backfill opens the DB and queries the
  // partial index first), so before the guarantee it filled 0 and failed, and with it it
  // fills one WRITE_BATCH regardless of scheduling.
  it('a budget that was real at call time buys one batch, however late it arrives', async () => {
    const lines = many(1_200);
    await fs.writeFile(sessionFile('a'), lines.join(''));
    await pass();
    await regressToNoOffsets();
    await openTranscriptDb(dbPath);

    const first = await pass(Date.now() + 1);
    const filled = (await storedOffsets()).filter(o => o !== null).length;
    expect(first.offsetsFilled).toBeGreaterThan(0);
    expect(filled).toBeGreaterThan(0);
    expect(filled).toBeLessThan(1_200);

    // Still a prefix — the guarantee changes when work stops, never what resuming means.
    const partial = await storedOffsets();
    expect(partial.slice(0, filled).every(o => o !== null)).toBe(true);
  }, 30_000);

  it('stops at the deadline and finishes on later passes, filling each row once', async () => {
    const lines = many(1_200);
    await fs.writeFile(sessionFile('a'), lines.join(''));
    await pass();
    await regressToNoOffsets();
    await openTranscriptDb(dbPath);

    // A real-but-instantly-spent budget: the one-batch guarantee makes the partial fill
    // DETERMINISTIC. This used to be `Date.now() + 40`, which asserted a timing coincidence —
    // under load it filled 0 (the lower bound failed, 2/5 in full runs), and on a quiet
    // machine it filled all 1,200 inside the window (the upper bound failed). Both bounds
    // were scheduling accidents. Now the stop is expressed in work: exactly one batch.
    const first = await pass(Date.now() + 1);
    const partial = await storedOffsets();
    const filledFirst = partial.filter(o => o !== null).length;
    expect(first.offsetsFilled).toBeGreaterThan(0);
    expect(filledFirst).toBeLessThan(1_200);

    // What it wrote is a prefix: resuming means continuing, not starting again.
    expect(partial.slice(0, filledFirst).every(o => o !== null)).toBe(true);

    for (let i = 0; i < 40 && (await storedOffsets()).some(o => o === null); i++) await pass();

    expect(await storedOffsets()).toEqual(offsetsOf(lines));
  }, 30_000);

  // The resume point itself, rather than only the fact that progress continues: a backfill that
  // restarted from byte 0 every pass would also eventually finish, while re-reading the file
  // from the beginning each time -- which is the archive re-read this must not become.
  it('resumes from the last offset it wrote rather than from the start of the file', async () => {
    const lines = many(10);
    await fs.writeFile(sessionFile('a'), lines.join(''));
    await pass();

    // Rows 1-4 keep their offsets; the rest are as an older index left them.
    await raw(client => client.execute('UPDATE transcript_messages SET byte_offset = NULL WHERE line > 4'));

    const client = await openTranscriptDb(dbPath);
    const resume = await offsetResumePoint(client, sessionFile('a'));

    expect(resume).toEqual({ startByte: offsetsOf(lines)[3], startLine: 3 });
  });

  // Indexing new content beats enriching old rows: a hook's whole budget is 1.5s, and a session
  // that is still being written to needs its latest turns findable more than a year-old one needs
  // a faster seek.
  it('does not spend a budget on offsets while there is still content to index', async () => {
    await fs.writeFile(sessionFile('a'), many(400).join(''));
    await pass();
    await regressToNoOffsets();
    await openTranscriptDb(dbPath);

    // A second, unindexed session, and a budget that expires inside the walk.
    await fs.writeFile(sessionFile('b'), many(400).join(''));
    const result = await pass(Date.now() + 30);

    expect(result.complete).toBe(false);
    expect(result.offsetsFilled).toBe(0);
  }, 30_000);
});

describe('the backfill against a file that moved on', () => {
  // An offset is a claim about a file. The pass rebuilds a file whose anchor no longer matches
  // before this runs, so a mismatch here is the racy remainder -- and writing an offset for a
  // line that now holds something else would resolve a hit to the wrong body, which is the one
  // outcome the reader cannot detect. Leaving the row null is always safe: it reads by scanning.
  it('leaves a row null rather than pointing it at a line that changed', async () => {
    const before = [line('user', 'antiquated one'), line('user', 'antiquated two')];
    await fs.writeFile(sessionFile('a'), before.join(''));
    await pass();
    await raw(client => client.execute('UPDATE transcript_messages SET byte_offset = NULL'));

    // Rewritten under the index, with the watermark left claiming it is up to date, so nothing
    // else in the pass will notice for this one run.
    await fs.writeFile(sessionFile('a'), [line('user', 'replacement one is longer'), line('user', 'replacement two')].join(''));
    await raw(client => client.execute('UPDATE transcript_files SET anchor = NULL'));

    await pass();

    expect(await storedOffsets()).toEqual([null, null]);
  });

  it('skips a transcript that is no longer on disk instead of failing the pass', async () => {
    await fs.writeFile(sessionFile('a'), line('user', 'gone soon'));
    await pass();
    await raw(client => client.execute('UPDATE transcript_messages SET byte_offset = NULL'));

    // Deleted, and the archive unreadable, so the sweep cannot reclaim the row this pass.
    await fs.rm(sessionFile('a'));
    const result = await runIndexPass({
      projectRoot: PROJECT_ROOT, dbPath, projectsDir: path.join(dir, 'not-a-directory'),
    });

    expect(result.offsetsFilled).toBe(0);
    expect(await storedOffsets()).toEqual([null]);
  });
});

describe('once every row has an offset', () => {
  it('costs an index probe rather than a scan of the messages table', async () => {
    await fs.writeFile(sessionFile('a'), line('user', 'first') + line('assistant', 'second'));
    await pass();

    const result = await pass();
    expect(result.offsetsFilled).toBe(0);

    // The partial index holds only rows still missing an offset, so it empties itself as the
    // backfill finishes. Without it, every pass -- every agent turn -- scans the whole messages
    // table to discover there is nothing to do.
    const probe = 'EXPLAIN QUERY PLAN SELECT path FROM transcript_messages WHERE byte_offset IS NULL LIMIT 1';
    const planOf = async (client: Awaited<ReturnType<typeof openTranscriptDb>>) =>
      (await client.execute(probe)).rows.map(row => String(row.detail)).join(' ');

    const client = await openTranscriptDb(dbPath);
    // SQLite calls a walk of the index a SCAN too, so the assertion is about *what* is walked:
    // the partial index, which holds nothing once the backfill is done.
    expect(await planOf(client)).toMatch(/transcript_messages USING (COVERING )?INDEX idx_transcript_messages_pending_offset/);
    expect(Number((await client.execute('SELECT COUNT(*) AS n FROM transcript_messages WHERE byte_offset IS NULL')).rows[0].n)).toBe(0);

    // The control, so the assertion above is known to distinguish something: without the index
    // the same probe reads the table itself, once per pass, for as long as the index exists.
    const withoutIndex = await raw(async bare => {
      await bare.execute('DROP INDEX idx_transcript_messages_pending_offset');
      return planOf(bare);
    });
    expect(withoutIndex).toMatch(/SCAN transcript_messages(?! USING)/);
  });
});
