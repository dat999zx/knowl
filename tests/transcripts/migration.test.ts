import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createClient } from '@libsql/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeTranscriptDbs, openTranscriptDb } from '../../src/transcripts/database.js';
import { runIndexPass } from '../../src/transcripts/index-pass.js';
import { encodeProjectDir } from '../../src/transcripts/paths.js';

let dir: string;
let projectsDir: string;
let dbPath: string;
const PROJECT_ROOT = '/repo/knowl';
const ENCODED_ROOT = encodeProjectDir(path.resolve(PROJECT_ROOT));

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'knowl-migr-'));
  projectsDir = path.join(dir, 'projects');
  dbPath = path.join(dir, 'transcripts.db');
  await fs.mkdir(path.join(projectsDir, ENCODED_ROOT), { recursive: true });
});

afterEach(async () => {
  await closeTranscriptDbs();
  // Swallowed: Windows keeps the database locked for the life of the process. Each test has
  // its own mkdtemp root, so nothing leaks between tests.
  await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
});

const line = (role: 'user' | 'assistant', text: string) =>
  JSON.stringify({ type: role, timestamp: '2026-08-03T10:00:00Z', message: { content: text } }) + '\n';

const titleLine = (title: string) =>
  JSON.stringify({ type: 'custom-title', customTitle: title }) + '\n';

const sessionFile = (name: string) => path.join(projectsDir, ENCODED_ROOT, `${name}.jsonl`);

const pass = () => runIndexPass({ projectRoot: PROJECT_ROOT, dbPath, projectsDir });

async function countMessages() {
  const client = await openTranscriptDb(dbPath);
  return Number((await client.execute('SELECT COUNT(*) AS n FROM transcript_messages')).rows[0].n);
}

/**
 * Run SQL against the database without going through `openTranscriptDb`, which would migrate it.
 *
 * A fixture that wants the *old* shape cannot use the opener that exists to abolish it.
 */
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
 * Put a current-shape index back into the shape of the first transcript release.
 *
 * Faithful rather than approximate: those are exactly the columns `addNamingColumns` adds, so
 * an index regressed this way is what a user upgrading from that release actually has.
 */
async function regressToFirstRelease(): Promise<void> {
  await raw(async client => {
    for (const column of ['opening', 'anchor', 'display_name', 'name_kind']) {
      await client.execute(`ALTER TABLE transcript_files DROP COLUMN ${column}`);
    }
    await client.execute('ALTER TABLE transcript_messages DROP COLUMN byte_offset');
  });
}

describe('an index built before the naming columns existed', () => {
  // The `opening` migration zeroes `bytes_indexed`/`lines_indexed` on every row so the next pass
  // refills names and openings, and claims that is safe because `commitBatchOn` skips lines
  // already covered. It does not: `commitBatchOn` re-reads `lines_indexed`, which the migration
  // just set to 0, so every surviving message row is re-inserted and dies on UNIQUE(path, line).
  // The rows and the watermark stopped being one fact, and the pass throws for good.
  it('is brought up to date instead of throwing on UNIQUE(path, line)', async () => {
    await fs.writeFile(
      sessionFile('a'),
      line('user', 'first message') + line('assistant', 'second message') + line('user', 'third message'),
    );
    await pass();
    expect(await countMessages()).toBe(3);

    await regressToFirstRelease();
    await openTranscriptDb(dbPath); // migrates

    const result = await pass();

    expect(result.complete).toBe(true);
    expect(await countMessages()).toBe(3);
  });

  it('keeps indexing that archive on every later pass', async () => {
    await fs.writeFile(sessionFile('a'), line('user', 'first message'));
    await pass();

    await regressToFirstRelease();
    await openTranscriptDb(dbPath);
    await pass();

    // The file grows the way a live session does, and the index has to follow it.
    await fs.appendFile(sessionFile('a'), line('assistant', 'later message'));
    await pass();

    expect(await countMessages()).toBe(2);
    const client = await openTranscriptDb(dbPath);
    const hit = (await client.execute("SELECT rowid FROM transcript_fts WHERE transcript_fts MATCH 'later'")).rows;
    expect(hit).toHaveLength(1);
  });
});

describe('an index already stranded by a shipped migration', () => {
  // The rescue case, and the one no change to `addNamingColumns` can reach: a user who upgraded
  // while the old migration was live already has the zeroed watermarks, and the column now
  // exists so the migration never runs again. Their pass throws on every invocation, for ever.
  // "Rows exist past the recorded watermark" is always an invariant violation -- rows and
  // watermark only ever move together -- so the pass has to be able to walk back into one.
  const strand = () => raw(client =>
    client.execute('UPDATE transcript_files SET bytes_indexed = 0, lines_indexed = 0, size_at_index = 0'));

  it('heals on the next pass rather than throwing for ever', async () => {
    await fs.writeFile(
      sessionFile('a'),
      line('user', 'first message') + line('assistant', 'second message'),
    );
    await pass();
    await strand();

    const result = await pass();

    expect(result.complete).toBe(true);
    expect(await countMessages()).toBe(2);

    const client = await openTranscriptDb(dbPath);
    const dupes = (await client.execute(`
      SELECT line, COUNT(*) AS n FROM transcript_messages GROUP BY path, line HAVING n > 1
    `)).rows;
    expect(dupes).toEqual([]);

    // The watermark is back in agreement with the rows, so the *next* pass is an ordinary one.
    const orphans = (await client.execute(`
      SELECT m.line FROM transcript_messages m
      JOIN transcript_files f ON f.path = m.path
      WHERE m.line > f.lines_indexed
    `)).rows;
    expect(orphans).toEqual([]);
  });

  it('rescues the rows in place, keeping their ids and their embeddings', async () => {
    await fs.writeFile(sessionFile('a'), line('user', 'worth embedding') + line('assistant', 'also embedded'));
    await pass();

    const before = await raw(async client => {
      const ids = (await client.execute('SELECT id FROM transcript_messages ORDER BY line')).rows
        .map(row => Number(row.id));
      // Stand in for the embed pass: an id that survives keeps a vector that cost real time.
      for (const id of ids) {
        await client.execute({
          sql: 'INSERT INTO transcript_vectors (message_id, fingerprint, dims, scale, vec) VALUES (?, ?, ?, ?, ?)',
          args: [id, 'test-model', 4, 1, new Uint8Array([1, 2, 3, 4])],
        });
      }
      return ids;
    });

    await strand();
    await pass();

    const client = await openTranscriptDb(dbPath);
    const after = (await client.execute('SELECT id FROM transcript_messages ORDER BY line')).rows
      .map(row => Number(row.id));
    const vectors = Number((await client.execute('SELECT COUNT(*) AS n FROM transcript_vectors')).rows[0].n);

    expect(after).toEqual(before);
    expect(vectors).toBe(2);

    // And the text is still findable exactly once -- the FTS side was not duplicated either.
    const hits = (await client.execute("SELECT rowid FROM transcript_fts WHERE transcript_fts MATCH 'embedding'")).rows;
    expect(hits).toHaveLength(1);
  });

  // A stranded row is not evidence that the file behind it is unchanged: the pass throws for as
  // long as it takes the user to upgrade again, and a transcript can be rewritten in that window.
  // With no usable watermark there is nothing to detect that with, so the repair cannot assume
  // it -- a kept row whose line now holds different text resolves search to the wrong body.
  it('replaces a stranded row whose line no longer holds the same message', async () => {
    await fs.writeFile(sessionFile('a'), line('user', 'antiquated terminology'));
    await pass();
    await strand();

    await fs.writeFile(sessionFile('a'), line('user', 'replacement vocabulary of another length'));
    await pass();

    expect(await countMessages()).toBe(1);
    const client = await openTranscriptDb(dbPath);
    const stale = (await client.execute("SELECT rowid FROM transcript_fts WHERE transcript_fts MATCH 'antiquated'")).rows;
    const fresh = (await client.execute("SELECT rowid FROM transcript_fts WHERE transcript_fts MATCH 'replacement'")).rows;
    expect(stale).toHaveLength(0);
    expect(fresh).toHaveLength(1);
  });

  // The tail of the same case. A transcript rewritten shorter while the index was stranded
  // leaves rows for lines the file no longer has, and with the watermark back at the end of the
  // real file nothing would ever look at them again: dead pointers, matched by search, read
  // back as "unavailable".
  it('drops rows for lines a rewritten file no longer has', async () => {
    await fs.writeFile(
      sessionFile('a'),
      line('user', 'antiquated one') + line('user', 'antiquated two') + line('user', 'antiquated three'),
    );
    await pass();
    expect(await countMessages()).toBe(3);
    await strand();

    await fs.writeFile(sessionFile('a'), line('user', 'the only surviving message'));
    await pass();

    expect(await countMessages()).toBe(1);
    const client = await openTranscriptDb(dbPath);
    const stale = (await client.execute("SELECT rowid FROM transcript_fts WHERE transcript_fts MATCH 'antiquated'")).rows;
    expect(stale).toHaveLength(0);
    const vectors = Number((await client.execute('SELECT COUNT(*) AS n FROM transcript_vectors')).rows[0].n);
    expect(vectors).toBe(0);
  });
});

describe('the naming migration', () => {
  // The house rule the transcripts lane wrote its own migrations to: a column arrives, and
  // nothing already indexed is re-read or reset on account of it. The `opening` migration broke
  // it to backfill cosmetic metadata, and stranded the rows to do it.
  it('leaves the watermarks of an existing index alone', async () => {
    await fs.writeFile(sessionFile('a'), titleLine('a named session') + line('user', 'first message'));
    await pass();

    const before = await raw(async client => (await client.execute(
      'SELECT bytes_indexed, lines_indexed, size_at_index FROM transcript_files',
    )).rows[0]);
    expect(Number(before.bytes_indexed)).toBeGreaterThan(0);

    await regressToFirstRelease();
    const client = await openTranscriptDb(dbPath); // migrates

    const after = (await client.execute(
      'SELECT bytes_indexed, lines_indexed, size_at_index FROM transcript_files',
    )).rows[0];
    expect(Number(after.bytes_indexed)).toBe(Number(before.bytes_indexed));
    expect(Number(after.lines_indexed)).toBe(Number(before.lines_indexed));
    expect(Number(after.size_at_index)).toBe(Number(before.size_at_index));
  });

  // What the reset was for. A session that is still being written to gets its name and opening
  // from the next pass over the lines it grows by, so the metadata arrives without re-reading
  // the archive -- the same lazy adoption the anchor column uses.
  it('still names a session that is appended to afterwards', async () => {
    await fs.writeFile(sessionFile('a'), line('user', 'first message'));
    await pass();
    await regressToFirstRelease();
    await openTranscriptDb(dbPath);

    await fs.appendFile(sessionFile('a'), titleLine('a named session') + line('assistant', 'later message'));
    await pass();

    const client = await openTranscriptDb(dbPath);
    const row = (await client.execute('SELECT display_name FROM transcript_files')).rows[0];
    expect(row.display_name).toBe('a named session');
  });
});
