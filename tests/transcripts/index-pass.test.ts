import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeTranscriptDbs, openTranscriptDb } from '../../src/transcripts/database.js';
import { runIndexPass } from '../../src/transcripts/index-pass.js';
import { encodeProjectDir } from '../../src/transcripts/paths.js';

const execFileAsync = promisify(execFile);

let dir: string;
let projectsDir: string;
let dbPath: string;
const PROJECT_ROOT = '/repo/knowl';
/**
 * Derived, not hardcoded. Discovery resolves the root before encoding it, and `path.resolve`
 * is platform-dependent for these literals -- on Windows `/repo/knowl` becomes `D:\repo\knowl`
 * and encodes to `d--repo-knowl`, on POSIX it stays `-repo-knowl`. Computing the name the same
 * way the product does keeps the fixture correct on both.
 */
const ENCODED_ROOT = encodeProjectDir(path.resolve(PROJECT_ROOT));

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'knowl-pass-'));
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

const sessionFile = (name: string) => path.join(projectsDir, ENCODED_ROOT, `${name}.jsonl`);

const pass = () => runIndexPass({ projectRoot: PROJECT_ROOT, dbPath, projectsDir });

async function countMessages() {
  const client = await openTranscriptDb(dbPath);
  return Number((await client.execute('SELECT COUNT(*) AS n FROM transcript_messages')).rows[0].n);
}

describe('runIndexPass', () => {
  it('indexes prose and records a watermark', async () => {
    await fs.writeFile(sessionFile('a'), line('user', 'first') + line('assistant', 'second'));

    const result = await pass();

    expect(result.indexed).toBe(2);
    expect(await countMessages()).toBe(2);

    const client = await openTranscriptDb(dbPath);
    const file = (await client.execute('SELECT bytes_indexed, lines_indexed FROM transcript_files')).rows[0];
    expect(Number(file.bytes_indexed)).toBeGreaterThan(0);
    expect(Number(file.lines_indexed)).toBe(2);
  });

  it('indexes only new content on a second pass', async () => {
    await fs.writeFile(sessionFile('a'), line('user', 'first'));
    await pass();

    await fs.appendFile(sessionFile('a'), line('user', 'second'));
    const result = await pass();

    expect(result.indexed).toBe(1);
    expect(await countMessages()).toBe(2);
  });

  it('indexes nothing when nothing changed', async () => {
    await fs.writeFile(sessionFile('a'), line('user', 'first'));
    await pass();
    const result = await pass();

    expect(result.indexed).toBe(0);
    expect(await countMessages()).toBe(1);
  });

  it('rebuilds a file that shrank', async () => {
    await fs.writeFile(sessionFile('a'), line('user', 'one') + line('user', 'two'));
    await pass();

    await fs.writeFile(sessionFile('a'), line('user', 'replacement'));
    const result = await pass();

    expect(result.rebuilt).toBe(1);
    expect(await countMessages()).toBe(1);
  });

  it('drops rows for a transcript that was deleted from disk', async () => {
    await fs.writeFile(sessionFile('a'), line('user', 'gone soon'));
    await pass();
    await fs.rm(sessionFile('a'));

    const result = await pass();

    expect(result.removed).toBe(1);
    expect(await countMessages()).toBe(0);
  });

  // An unreachable archive -- network home directory, unset HOME, a machine where Claude Code
  // has not run -- looks exactly like "every transcript was deleted" from the file list alone.
  // Acting on that destroys the whole index, including a backfill that took hours.
  it('does not wipe the index when the archive directory is unreadable', async () => {
    await fs.writeFile(sessionFile('a'), line('user', 'worth keeping'));
    await pass();
    expect(await countMessages()).toBe(1);

    const result = await runIndexPass({
      projectRoot: PROJECT_ROOT, dbPath, projectsDir: path.join(dir, 'not-a-directory'),
    });

    expect(result.removed).toBe(0);
    expect(await countMessages()).toBe(1);
  });

  // K-11. The root set comes from `git worktree list`; a missing binary, a busy antivirus or a
  // sleeping network drive shrinks it to the project root alone. Every worktree session then
  // looks deleted, and the sweep drops its rows *and its vectors*. Re-indexing is cheap;
  // re-embedding an archive is not, and nothing was actually stale.
  it('keeps a worktree session when git cannot answer for the root set', async () => {
    const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'knowl-repo-'));
    const worktree = path.join(repo, '..', `${path.basename(repo)}-wt`);
    const emptyPath = await fs.mkdtemp(path.join(os.tmpdir(), 'knowl-nogit-'));
    const git = (...args: string[]) =>
      execFileAsync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: repo });

    await git('init');
    await git('commit', '--allow-empty', '-m', 'root');
    await git('worktree', 'add', worktree, '-b', 'side');

    const archive = path.join(dir, 'wt-projects');
    for (const [root, session] of [[repo, 'main-session'], [worktree, 'worktree-session']] as const) {
      const encoded = path.join(archive, encodeProjectDir(path.resolve(root)));
      await fs.mkdir(encoded, { recursive: true });
      await fs.writeFile(path.join(encoded, `${session}.jsonl`), line('user', `content of ${session}`));
    }

    const first = await runIndexPass({ projectRoot: repo, dbPath, projectsDir: archive });
    expect(first.indexed).toBe(2); // both roots discovered while git works

    const savedPath = process.env.PATH;
    let second;
    try {
      process.env.PATH = emptyPath; // git becomes unresolvable: the transient failure
      second = await runIndexPass({ projectRoot: repo, dbPath, projectsDir: archive });
    } finally {
      process.env.PATH = savedPath;
    }

    expect(second.removed).toBe(0);
    expect(await countMessages()).toBe(2);

    await fs.rm(emptyPath, { recursive: true, force: true });
    await git('worktree', 'remove', '--force', worktree).catch(() => {});
    await fs.rm(repo, { recursive: true, force: true }).catch(() => {});
    await fs.rm(worktree, { recursive: true, force: true }).catch(() => {});
  }, 30_000);

  it('mirrors every message into the FTS index under its own rowid', async () => {
    await fs.writeFile(sessionFile('a'), line('user', 'embedding crash investigation'));
    await pass();

    const client = await openTranscriptDb(dbPath);
    const hit = (await client.execute("SELECT rowid FROM transcript_fts WHERE transcript_fts MATCH 'embedding'")).rows[0];
    const message = (await client.execute({
      sql: 'SELECT id, line, role FROM transcript_messages WHERE id = ?',
      args: [Number(hit.rowid)],
    })).rows[0];

    expect(Number(message.line)).toBe(1);
    expect(message.role).toBe('user');
  });

  it('removes stale FTS rows when a file is rebuilt', async () => {
    await fs.writeFile(sessionFile('a'), line('user', 'antiquated terminology'));
    await pass();
    await fs.writeFile(sessionFile('a'), line('user', 'replacement text'));
    await pass();

    const client = await openTranscriptDb(dbPath);
    const stale = (await client.execute("SELECT rowid FROM transcript_fts WHERE transcript_fts MATCH 'antiquated'")).rows;
    expect(stale).toHaveLength(0);
  });

  it('records the parent session for a subagent transcript', async () => {
    const nested = path.join(projectsDir, ENCODED_ROOT, '78aed75d-4bed-4d1a-a93e-f3fd3eab4fb4', 'subagents');
    await fs.mkdir(nested, { recursive: true });
    await fs.writeFile(path.join(nested, 'sub.jsonl'), line('assistant', 'subagent finding'));

    await pass();

    const client = await openTranscriptDb(dbPath);
    const row = (await client.execute('SELECT session_id, parent_session_id FROM transcript_messages')).rows[0];
    expect(row.session_id).toBe('sub');
    expect(row.parent_session_id).toBe('78aed75d-4bed-4d1a-a93e-f3fd3eab4fb4');
  });

  it('stops at the deadline and reports itself incomplete, then resumes without duplicating', async () => {
    for (const name of ['a', 'b', 'c']) {
      await fs.writeFile(sessionFile(name), line('user', `session ${name}`));
    }

    const stopped = await runIndexPass({
      projectRoot: PROJECT_ROOT, dbPath, projectsDir,
      deadline: Date.now() - 1, // already expired: no file should be processed
    });
    expect(stopped.complete).toBe(false);
    expect(stopped.indexed).toBe(0);

    const finished = await pass();
    expect(finished.complete).toBe(true);
    expect(await countMessages()).toBe(3);
  });

  // The regression test for the blocker this task exists to fix. Before the watermark moved
  // inside the batch transaction, a crash between the two left rows behind a stale watermark
  // and the next pass died on UNIQUE(path, line).
  it('resumes after a crash mid-file instead of replaying committed lines', async () => {
    // 5,000 messages is 25 batches of WRITE_BATCH, and a full pass over them measures ~500ms.
    // The deadline below therefore lands well inside the file: far enough out that discovery
    // (single-digit ms) cannot consume it before the first batch -- which would abort the pass
    // having written nothing and make this test vacuous -- and far short of finishing.
    const TOTAL = 5_000;
    await fs.writeFile(
      sessionFile('a'),
      Array.from({ length: TOTAL }, (_, i) => line('user', `message ${i}`)).join(''),
    );

    // Simulate a crash by aborting the pass partway: the deadline fires between batches.
    const partial = await runIndexPass({
      projectRoot: PROJECT_ROOT, dbPath, projectsDir, deadline: Date.now() + 100,
    });
    expect(partial.complete).toBe(false);

    const client = await openTranscriptDb(dbPath);
    const committed = Number((await client.execute('SELECT COUNT(*) AS n FROM transcript_messages')).rows[0].n);
    const watermark = (await client.execute('SELECT lines_indexed FROM transcript_files')).rows[0];

    // It really did stop mid-file, so the invariant below is being asserted about something.
    expect(committed).toBeGreaterThan(0);
    expect(committed).toBeLessThan(TOTAL);

    // Whatever was committed, the watermark agrees with it. This is the invariant.
    expect(Number(watermark.lines_indexed)).toBe(committed);

    // And a full pass finishes rather than colliding on the unique index.
    const finished = await pass();
    expect(finished.complete).toBe(true);
    expect(await countMessages()).toBe(TOTAL);
  }, 30_000);

  it('lets two concurrent passes over the same file finish without colliding', async () => {
    await fs.writeFile(
      sessionFile('a'),
      Array.from({ length: 400 }, (_, i) => line('user', `message ${i}`)).join(''),
    );

    // Both read watermark 0, both stream the same lines. Without the in-transaction re-read,
    // the loser dies on UNIQUE(path, line).
    await Promise.all([pass(), pass()]);

    expect(await countMessages()).toBe(400);

    const client = await openTranscriptDb(dbPath);
    const dupes = (await client.execute(`
      SELECT line, COUNT(*) AS n FROM transcript_messages GROUP BY path, line HAVING n > 1
    `)).rows;
    expect(dupes).toEqual([]);
  }, 30_000);

  it('never leaves a row whose line is past the recorded watermark', async () => {
    await fs.writeFile(
      sessionFile('a'),
      Array.from({ length: 300 }, (_, i) => line('user', `message ${i}`)).join(''),
    );
    await runIndexPass({ projectRoot: PROJECT_ROOT, dbPath, projectsDir, deadline: Date.now() + 1 });

    const client = await openTranscriptDb(dbPath);
    const orphans = (await client.execute(`
      SELECT m.line FROM transcript_messages m
      JOIN transcript_files f ON f.path = m.path
      WHERE m.line > f.lines_indexed
    `)).rows;

    expect(orphans).toEqual([]);
  });
});
