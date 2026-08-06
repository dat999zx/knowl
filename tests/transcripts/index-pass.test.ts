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

  // K-12. `size < bytes_indexed` is blind to a rewrite that keeps the file the same length or
  // makes it longer, and the file is then skipped as "unchanged" -- so every stored line number
  // points into content that is no longer there. The hits resolve to the wrong bodies and the
  // new text is never indexed.
  it('rebuilds a file rewritten in place at the same size', async () => {
    const before = line('user', 'antiquated terminology');
    await fs.writeFile(sessionFile('a'), before);
    await pass();

    // Same byte length, entirely different content.
    const after = line('user', 'replacement vocabulary');
    expect(after.length).toBe(before.length);
    await fs.writeFile(sessionFile('a'), after);

    const result = await pass();

    expect(result.rebuilt).toBe(1);
    const client = await openTranscriptDb(dbPath);
    const stale = (await client.execute("SELECT rowid FROM transcript_fts WHERE transcript_fts MATCH 'antiquated'")).rows;
    const fresh = (await client.execute("SELECT rowid FROM transcript_fts WHERE transcript_fts MATCH 'replacement'")).rows;
    expect(stale).toHaveLength(0);
    expect(fresh).toHaveLength(1);
  });

  it('rebuilds a file rewritten in place and then grown', async () => {
    await fs.writeFile(sessionFile('a'), line('user', 'antiquated terminology'));
    await pass();

    await fs.writeFile(sessionFile('a'), line('user', 'replacement one') + line('user', 'replacement two'));
    await pass();

    const client = await openTranscriptDb(dbPath);
    const stale = (await client.execute("SELECT rowid FROM transcript_fts WHERE transcript_fts MATCH 'antiquated'")).rows;
    expect(stale).toHaveLength(0);
    expect(await countMessages()).toBe(2);
  });

  // K-57. A rebuild drops the file's rows and resets its watermark. As two steps, an
  // interruption between them leaves zero rows behind a high watermark -- and once the file has
  // grown past that watermark again, nothing detects it: the pass "resumes" into a transcript
  // whose earlier messages exist nowhere. The interruption here is real, not simulated: a
  // trigger aborts the watermark reset, which is exactly the second of the two steps.
  it('does not drop a file\'s rows unless the watermark reset lands with them', async () => {
    await fs.writeFile(sessionFile('a'), line('user', 'antiquated one') + line('user', 'antiquated two'));
    await pass();
    expect(await countMessages()).toBe(2);

    // Rewritten in place, so the next pass has to rebuild.
    await fs.writeFile(sessionFile('a'), line('user', 'replacement one'));

    const client = await openTranscriptDb(dbPath);
    await client.execute(`CREATE TRIGGER stop_reset BEFORE UPDATE ON transcript_files
                          BEGIN SELECT RAISE(ABORT, 'interrupted'); END;`);
    await expect(pass()).rejects.toThrow(/interrupted/);
    await client.execute('DROP TRIGGER stop_reset');

    // Nothing was dropped, because the reset it belongs with never landed.
    expect(await countMessages()).toBe(2);

    // Now the file grows past the old watermark, so a size comparison can no longer notice
    // anything is wrong. The rebuild has to happen anyway.
    await fs.writeFile(
      sessionFile('a'),
      line('user', 'replacement one') + line('user', 'replacement two') + line('user', 'replacement three'),
    );
    await pass();

    expect(await countMessages()).toBe(3);
    const stale = (await client.execute("SELECT rowid FROM transcript_fts WHERE transcript_fts MATCH 'antiquated'")).rows;
    expect(stale).toHaveLength(0);
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

  /**
   * The same discovery, reached through a symlinked root.
   *
   * git reports canonical paths; Node reports whatever it was handed. Where those differ, the
   * "is this my own repository?" guard in `resolveRepoRootSet` compared the two raw strings and
   * concluded git had answered about some other repo, so it dropped every worktree and indexed
   * only the project root.
   *
   * This is not hypothetical and it is not only about symlinks: macOS `os.tmpdir()` is
   * `/var/folders/...` whose real path is `/private/var/folders/...`, and a Windows profile
   * name over eight characters appears as `RUNNER~1`. The first CI run that covered anything
   * but ubuntu failed on all four non-Linux legs for exactly this. A symlink reproduces it on
   * Linux too, so the cheapest runner catches it next time.
   */
  /**
   * Discovery through a path whose PARENT is a link, which is the shape every non-Linux CI
   * runner has and Linux does not.
   *
   * `git worktree list` always answers canonically. macOS `os.tmpdir()` is `/var/folders/...`
   * whose real path is `/private/var/folders/...`, and a Windows profile over eight characters
   * appears as `RUNNER~1`. The archive, meanwhile, is named for the path the AGENT held. So the
   * repo root is reachable by resolving, but its SIBLING worktree is not: no amount of
   * canonicalising git's `/private/var/.../repo-wt` produces the `-var-...-repo-wt` directory
   * that is actually on disk. Recovering it needs the inverse substitution.
   *
   * Junctioning the parent rather than the repo is what makes this reproduce off macOS: with
   * only the repo linked, the sibling worktree path is identical in both forms and nothing is
   * being tested.
   */
  it('indexes a sibling worktree when the project root is reached through a linked parent', async () => {
    const realParent = await fs.mkdtemp(path.join(os.tmpdir(), 'knowl-parent-'));
    const repo = path.join(realParent, 'repo');
    const worktree = path.join(realParent, 'repo-wt');
    await fs.mkdir(repo, { recursive: true });

    const git = (...args: string[]) =>
      execFileAsync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: repo });
    await git('init');
    await git('commit', '--allow-empty', '-m', 'root');
    await git('worktree', 'add', worktree, '-b', 'side');

    // A junction on Windows: no elevation, no developer mode, and `realpath` resolves it
    // exactly as it resolves a POSIX symlink.
    const linkParent = path.join(dir, 'linked-parent');
    await fs.symlink(realParent, linkParent, process.platform === 'win32' ? 'junction' : 'dir');

    // Named the way an agent launched through the link would have named them.
    const archive = path.join(dir, 'linked-projects');
    const linkedRepo = path.join(linkParent, 'repo');
    for (const [root, session] of [[linkedRepo, 'root-session'], [path.join(linkParent, 'repo-wt'), 'wt-session']] as const) {
      const encoded = path.join(archive, encodeProjectDir(path.resolve(root)));
      await fs.mkdir(encoded, { recursive: true });
      await fs.writeFile(path.join(encoded, `${session}.jsonl`), line('user', session));
    }

    const pass = await runIndexPass({ projectRoot: linkedRepo, dbPath, projectsDir: archive });
    expect(pass.indexed).toBe(2);

    await git('worktree', 'remove', '--force', worktree).catch(() => {});
    await fs.rm(linkParent, { force: true, recursive: true }).catch(() => {});
    await fs.rm(realParent, { recursive: true, force: true }).catch(() => {});
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

  // The other side of K-65: a budget that governs only whether to *continue* lets a pass
  // return having done nothing at all. Opening and migrating the database and walking the
  // archive happen before the first file, and on a loaded machine that alone outlasts a hook's
  // budget -- so every pass pays the set-up cost, reports an honest incomplete result, and
  // advances by zero. The index never warms up, one truthful `complete: false` at a time.
  it('makes at least one batch of progress rather than spending its whole budget on set-up', async () => {
    await fs.writeFile(
      sessionFile('a'),
      Array.from({ length: 8_000 }, (_, i) => line('user', `message ${i}`)).join(''),
    );

    // A real budget, and far too small for 8,000 messages.
    //
    // The margin is deliberate. `budgeted` is `deadline > startedAt`, so a deadline of
    // `now + 1` is a coin flip: if more than a millisecond passes between this line and the
    // pass recording its own start -- which it does on a loaded CI runner -- the pass reads a
    // real budget as one already spent, correctly declines to start work it cannot afford, and
    // indexes nothing. That failed on ubuntu and passed on Windows for no better reason than
    // scheduling. 50ms is unambiguously a budget at call time and nowhere near enough to walk
    // 8,000 messages, so both halves of the assertion hold without racing.
    const result = await runIndexPass({
      projectRoot: PROJECT_ROOT, dbPath, projectsDir, deadline: Date.now() + 50,
    });

    expect(result.complete).toBe(false);
    expect(result.indexed).toBeGreaterThan(0);
    expect(result.indexed).toBeLessThan(8_000);

    // And what it did is still consistent: the watermark covers exactly the rows it committed.
    const client = await openTranscriptDb(dbPath);
    const watermark = (await client.execute('SELECT lines_indexed FROM transcript_files')).rows[0];
    expect(Number(watermark.lines_indexed)).toBe(await countMessages());
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
