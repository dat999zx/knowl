import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

/**
 * Which agent harness wrote a transcript.
 *
 * Carried per file rather than inferred from the path at the point of use. The two archives are
 * discovered by genuinely different mechanisms -- Claude Code's directory *is* the project, while
 * Codex records its project inside the file -- so by the time a file reaches the indexer the
 * knowledge of where it came from is not recoverable from its path without redoing that work.
 */
export type TranscriptHarness = 'claude' | 'codex';

export type TranscriptFile = {
  /** Absolute path to the `.jsonl`. */
  path: string;
  /** The file's basename without extension; Claude Code names it after the session. */
  sessionId: string;
  /** For a subagent transcript, the session that spawned it. Null for a main session. */
  parentSessionId: string | null;
  harness: TranscriptHarness;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The only directory under a session UUID that holds transcripts. Compared case-folded. */
const SUBAGENT_DIR = 'subagents';

/**
 * Claude Code's directory name for a project root: every character outside [A-Za-z0-9] becomes
 * a dash. `d:\coding\knowl` -> `d--coding-knowl` (the colon and the separator each contribute one).
 */
export function encodeProjectDir(projectRoot: string): string {
  return projectRoot.replace(/[^A-Za-z0-9]/g, '-');
}

export function defaultProjectsDir(): string {
  return path.join(os.homedir(), '.claude', 'projects');
}

/**
 * Codex CLI's session archive: `~/.codex/sessions/YYYY/MM/DD/rollout-<iso>-<uuid>.jsonl`.
 *
 * Partitioned by DATE, which is the whole reason Codex needs its own discovery path. Claude Code
 * names a directory after the project, so finding this repo's sessions is a directory match;
 * here every project's sessions are interleaved by the day they happened on, and the only record
 * of which project a session belongs to is `session_meta.payload.cwd` inside the file.
 */
export function defaultCodexSessionsDir(): string {
  return path.join(os.homedir(), '.codex', 'sessions');
}

/**
 * How deep below the sessions root the date partitioning goes: `YYYY/MM/DD`.
 *
 * A bound rather than a shape assertion, following `MAX_SUBAGENT_DEPTH`. If Codex adds or drops a
 * level the walk still finds the files; the bound only exists to stop an unbounded descent.
 */
const MAX_CODEX_DEPTH = 4;

/**
 * Bytes of a Codex transcript read to find its project.
 *
 * The first line is `session_meta`, and it is large -- it carries `base_instructions`, the whole
 * system prompt, which runs to tens of kilobytes. Reading it whole for every file on every scan
 * would be tens of megabytes of I/O to answer a question the first few hundred bytes settle:
 * `cwd` is written before `base_instructions` in that payload. So the common path reads a bounded
 * prefix, and only a file that does not yield its `cwd` there pays for a full line.
 */
const CODEX_META_PREFIX_BYTES = 8192;

/**
 * Ceiling on the fallback read, for a header that does not yield its `cwd` in the prefix.
 *
 * A bound is required rather than tidy: the fallback reads until it meets a newline, and a
 * corrupt or truncated file may not contain one before its end. Two megabytes is far past any
 * real `session_meta` -- the largest in a 477-file archive is tens of kilobytes -- so reaching it
 * means the file is not what it claims to be, and the right answer is to give up on it.
 */
const MAX_CODEX_META_BYTES = 2 * 1024 * 1024;

/** `"cwd":"<json string>"`, matched inside a prefix that may end mid-record. */
const CWD_IN_PREFIX = /"cwd"\s*:\s*("(?:[^"\\]|\\.)*")/;

/**
 * The project root a Codex session was recorded against, or null.
 *
 * Two reads at most. The prefix regex handles every well-formed session file; the fallback parses
 * a complete first line, for a file whose meta record is ordered differently than this archive's.
 */
async function codexSessionCwd(filePath: string): Promise<string | null> {
  let handle: import('node:fs/promises').FileHandle | undefined;
  try {
    handle = await fs.open(filePath, 'r');
    const buffer = Buffer.alloc(CODEX_META_PREFIX_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, CODEX_META_PREFIX_BYTES, 0);
    // Copied, not aliased: `buffer` is reused by the fallback reads below, so a subarray of it
    // would change under the bytes already collected.
    const head = Buffer.from(buffer.subarray(0, bytesRead));

    const matched = CWD_IN_PREFIX.exec(head.toString('utf8'));
    if (matched) {
      try {
        const cwd = JSON.parse(matched[1]) as unknown;
        if (typeof cwd === 'string' && cwd) return cwd;
      } catch {
        // Fall through to the whole-line parse below.
      }
    }

    // No `cwd` in the prefix. Either the record is ordered with `base_instructions` first, or the
    // line is simply longer than the prefix before reaching `cwd`. Both are answered by reading
    // on to the end of the first line -- which must genuinely continue reading, not re-inspect
    // the prefix: a header larger than the prefix contains no newline inside it at all.
    //
    // **Accumulated as BYTES and decoded once at the end**, never chunk by chunk. A read boundary
    // falls wherever 8 KB lands, which is routinely mid-character: decoding each chunk on its own
    // turns the two halves of one multi-byte sequence into two U+FFFD, and when the split lands
    // inside the `cwd` value itself the path comes back corrupted, matches no root, and every
    // session under it is silently dropped from discovery. `parse.ts` splits on 0x0a before
    // decoding for the same reason. Newlines are searched for in the bytes, which is safe: 0x0a
    // cannot occur inside a multi-byte UTF-8 sequence.
    const chunks: Buffer[] = [head];
    // Only the newest chunk is searched each time: every earlier one has already been checked and
    // held no newline, so rescanning them would make this quadratic in the header's size.
    let tail = head;
    let offset = bytesRead;
    while (tail.indexOf(0x0a) === -1 && offset < MAX_CODEX_META_BYTES) {
      const next = await handle.read(buffer, 0, CODEX_META_PREFIX_BYTES, offset);
      if (next.bytesRead === 0) break;
      tail = Buffer.from(buffer.subarray(0, next.bytesRead));
      chunks.push(tail);
      offset += next.bytesRead;
    }

    const whole = chunks.length === 1 ? head : Buffer.concat(chunks);
    const newline = whole.indexOf(0x0a);
    try {
      const record = JSON.parse(
        (newline === -1 ? whole : whole.subarray(0, newline)).toString('utf8'),
      ) as Record<string, unknown>;
      const payload = record.payload as Record<string, unknown> | undefined;
      const cwd = payload?.cwd;
      return typeof cwd === 'string' && cwd ? cwd : null;
    } catch {
      return null;
    }
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}

/** Every `.jsonl` under the date-partitioned sessions tree. */
async function collectCodexFiles(dir: string, found: string[], depth: number): Promise<boolean> {
  const entries = await readDir(dir);
  // Null is "could not look", which is a degraded scan rather than an empty one -- the same
  // distinction `readDir` exists to preserve for the Claude archive.
  if (entries === null) return true;

  let degraded = false;
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      found.push(full);
      continue;
    }
    if (entry.isDirectory() && depth < MAX_CODEX_DEPTH) {
      degraded = await collectCodexFiles(full, found, depth + 1) || degraded;
    }
  }
  return degraded;
}

/**
 * This repo's Codex sessions, matched on the project each file records for itself.
 *
 * **Every file is opened, because there is no cheaper filter.** The path carries a date and a
 * UUID and says nothing about the project, so the alternative to reading each header is not a
 * faster match -- it is no match at all. The read is bounded (`CODEX_META_PREFIX_BYTES`) and the
 * archive is small in file count; measured on a real 477-file archive this completes in about a
 * second.
 *
 * Roots are compared with `foldPath`, which the Claude path already needs for the same reason and
 * which matters more here: this archive records both `D:\coding\knowl` and `d:\coding\knowl` for
 * one repository, because the drive letter's case follows however the agent was launched.
 *
 * `uncanonicalise` is taken rather than skipped, and its absence here was a real gap. A `cwd` is
 * whatever the agent's shell had, so it is the UN-resolved form -- exactly what `realpath` cannot
 * produce from git's canonical answer. Without it a sibling worktree that git names only as
 * `/private/var/folders/X-wt` matched no Codex session recorded in `/var/folders/X-wt`, on the
 * same platforms and for the same reason the Claude path already handled.
 */
async function scanCodexArchive(
  sessionsDir: string,
  roots: string[],
  uncanonicalise: Uncanonicalise,
): Promise<TranscriptScan> {
  const paths: string[] = [];
  const degraded = await collectCodexFiles(sessionsDir, paths, 0);

  const wanted = new Set<string>();
  for (const root of roots) {
    for (const form of await rootSpellings(root, uncanonicalise)) wanted.add(foldPath(form));
  }

  const files: TranscriptFile[] = [];
  for (const filePath of paths) {
    const cwd = await codexSessionCwd(filePath);
    if (!cwd || !wanted.has(foldPath(cwd))) continue;
    files.push({
      path: filePath,
      // `rollout-2026-03-22T21-16-47-019d15e7-....jsonl`. The UUID is the session id Codex uses
      // in its own meta record; taking it from the name keeps this consistent with the Claude
      // path, where the basename *is* the session id, and costs no second read.
      sessionId: path.basename(filePath, '.jsonl').replace(/^rollout-\d{4}-\d{2}-\d{2}T[\d-]+?-(?=[0-9a-f]{8}-)/i, ''),
      // Codex records no subagent transcripts in this archive: every file is a top-level session.
      parentSessionId: null,
      harness: 'codex',
    });
  }

  return { files, degraded };
}

/** Every `worktree <path>` line from `git worktree list --porcelain`, in order. */
export function parseWorktreeList(stdout: string): string[] {
  return stdout
    .split(/\r?\n/)
    .filter(line => line.startsWith('worktree '))
    .map(line => line.slice('worktree '.length).trim())
    .filter(Boolean);
}

/** Windows and macOS paths compare case-insensitively; POSIX ones do not. */
const CASE_INSENSITIVE_PATHS = process.platform === 'win32' || process.platform === 'darwin';

const foldPath = (target: string) =>
  CASE_INSENSITIVE_PATHS ? path.resolve(target).toLowerCase() : path.resolve(target);

/**
 * The same case policy applied to a string that is *not* a whole path -- one character, or the
 * leading fragment of one.
 *
 * Separate from `foldPath` because that one resolves, and resolving a fragment answers a different
 * question than the caller asked: `path.resolve` of a single character returns it appended to the
 * working directory, so `/` and `\` both come back as the drive root and compare equal, and a
 * prefix with a trailing separator loses it. Neither of those changes the answer here today --
 * both sides of every comparison come from `path.resolve` already, so the separators agree -- but
 * it is true by luck rather than by construction, and it cost a `resolve` per character compared.
 */
const foldText = (text: string) => CASE_INSENSITIVE_PATHS ? text.toLowerCase() : text;

const samePath = (left: string, right: string) => foldPath(left) === foldPath(right);

/** Maps a canonical path back to the form an agent on this machine would have recorded. */
type Uncanonicalise = (target: string) => string | null;

/**
 * The inverse of `realpath` for this machine, or a function that always declines.
 *
 * `realpath` only maps TOWARD the real path, but an archive is often named for the UN-canonical
 * one: on macOS an agent launched in `/var/folders/X` records `/var/folders/X`, while
 * `git worktree list` reports its sibling worktree only as `/private/var/folders/X-wt`. No amount
 * of resolving git's answer produces the form the agent wrote. What is needed is the inverse
 * substitution, and the project root is what reveals it -- knowing `/private/var` stands for
 * `/var` here lets every canonical root be expressed the way the agent would have written it.
 *
 * Derived from the one pair we can see both halves of: the project root as given and as resolved,
 * by taking their longest common tail. What is left in front is the substitution -- `/private/var`
 * for `/var` on macOS, `C:\Users\runneradmin` for `C:\Users\RUNNER~1` on Windows. A whole-path
 * prefix would not do, because a worktree is a SIBLING of the repo rather than a child of it.
 *
 * Measured before it was relied on: without this, every worktree session went unindexed on macOS
 * and Windows while ubuntu, whose paths are already canonical, saw nothing wrong for months.
 */
async function deriveUncanonicalise(projectRoot: string): Promise<Uncanonicalise> {
  const givenRoot = path.resolve(projectRoot);
  const realGivenRoot = await fs.realpath(givenRoot).catch(() => givenRoot);
  if (foldPath(realGivenRoot) === foldPath(givenRoot)) return () => null;

  let shared = 0;
  while (
    shared < realGivenRoot.length && shared < givenRoot.length
    && foldText(realGivenRoot[realGivenRoot.length - 1 - shared]) === foldText(givenRoot[givenRoot.length - 1 - shared])
  ) shared += 1;
  const realHead = realGivenRoot.slice(0, realGivenRoot.length - shared);
  const givenHead = givenRoot.slice(0, givenRoot.length - shared);

  return (target: string) => {
    // `foldText`, because `realHead` is a leading fragment rather than a path and the slice below
    // indexes into `target` by its raw length -- a comparison that had normalised either side
    // would be measuring a different string than the one being cut.
    if (!foldText(target).startsWith(foldText(realHead))) return null;
    return givenHead + target.slice(realHead.length);
  };
}

/**
 * Every spelling of one root an agent might have recorded: as given, as resolved, and as
 * un-resolved.
 *
 * Shared by both archives rather than written twice, which is the point: the Claude half had all
 * three and the Codex half had only the first two, so a sibling worktree that git names only
 * canonically matched a Claude session and silently missed the Codex sessions beside it. The two
 * differ only in what they do with the forms -- Claude encodes them into a directory name, Codex
 * compares them against the `cwd` inside each file.
 */
async function rootSpellings(root: string, uncanonicalise: Uncanonicalise): Promise<string[]> {
  const resolved = path.resolve(root);
  const forms = [resolved, await fs.realpath(resolved).catch(() => null), uncanonicalise(resolved)];
  return forms.filter((form): form is string => Boolean(form));
}

/**
 * The path with every symlink and short name resolved away, or the path itself if it cannot be.
 *
 * Used ONLY to compare paths, never to produce one. git reports canonical paths while Node
 * reports whatever it was handed, and the two disagree on both platforms that are not Linux:
 * macOS `os.tmpdir()` is `/var/folders/...` which is really `/private/var/folders/...`, and a
 * Windows profile longer than eight characters shows up as `RUNNER~1` on CI and in full
 * elsewhere. Comparing the raw strings makes a repository look like a different repository.
 */
async function canonical(target: string): Promise<string> {
  return fs.realpath(target).catch(() => target);
}

export type RepoRootSet = {
  /** The project root, plus its worktrees when git could name them. */
  roots: string[];
  /**
   * True when the set may be *missing* roots for a transient reason -- git could not run at all.
   * Not set for a definitive answer ("this is not a checkout"), which misses nothing.
   *
   * The caller needs the distinction because acting on a shrunken root set is destructive: every
   * session under a root that dropped out looks deleted, and reclaiming a deleted transcript
   * drops its rows *and its embeddings*.
   */
  degraded: boolean;
};

/** git's own wording when the answer is "there is no repository here", not "I failed". */
const NOT_A_CHECKOUT = /not a git repository|not a working tree|does not exist/i;

/**
 * This repo's root and the roots of its worktrees.
 *
 * Asking git rather than pattern-matching directory names. A worktree lives wherever it was
 * created -- this repo's own is on a different drive from the main checkout -- so there is no
 * prefix, suffix or convention that finds them. The trade is that a *deleted* worktree stops
 * being discovered, which is correct: its rows are then cleaned up as dead files.
 *
 * **git answers for the enclosing repository, not for this directory.** A knowl project that is
 * a subdirectory of a larger checkout -- a package inside a monorepo, a tool vendored into an
 * app -- gets back that checkout's root and every one of its worktrees, and would then index
 * their transcripts as its own. With `share` on it serves them to workspace peers, which is
 * content the enclosing repo never opted into. So git's answer is only adopted when git agrees
 * that *this exact directory* is a worktree root; otherwise the project stands alone.
 *
 * Any failure degrades to the project root alone. This runs on every enabled session, and a
 * missing git binary or a non-checkout directory must never be the thing that breaks one.
 */
export async function resolveRepoRootSet(projectRoot: string): Promise<RepoRootSet> {
  const resolved = path.resolve(projectRoot);

  // A root that is not there has no worktrees and cannot acquire any; spawning git only to have
  // it fail on the missing cwd would report a transient failure where there is none.
  if (!(await fs.access(resolved).then(() => true, () => false))) {
    return { roots: [resolved], degraded: false };
  }

  try {
    const { stdout } = await run('git', ['worktree', 'list', '--porcelain'], { cwd: resolved });
    const roots = parseWorktreeList(stdout).map(root => path.resolve(root));

    // Compared canonically, returned verbatim. The membership test has to see through symlinks
    // and short names or git's own answer about this very directory reads as another repo's --
    // measured: on macOS and on Windows CI this guard dropped every worktree, so a session
    // recorded against one was never indexed. The RETURNED roots stay in the form the caller
    // gave and git reported, because they are encoded into archive directory names that a host
    // agent wrote using those same uncanonicalised paths.
    const here = await canonical(resolved);
    const canonicalRoots = await Promise.all(roots.map(canonical));
    if (!canonicalRoots.some(root => samePath(root, here))) {
      // git answered about some other repository this directory happens to sit inside.
      return { roots: [resolved], degraded: false };
    }
    return { roots: [...new Set([resolved, ...roots])], degraded: false };
  } catch (error) {
    const stderr = String((error as { stderr?: unknown }).stderr ?? '');
    return { roots: [resolved], degraded: !NOT_A_CHECKOUT.test(stderr) };
  }
}

/** The roots alone, for callers with nothing to decide about a degraded answer. */
export async function resolveRepoRoots(projectRoot: string): Promise<string[]> {
  return (await resolveRepoRootSet(projectRoot)).roots;
}

/**
 * `readdir`, distinguishing "nothing there" from "could not look".
 *
 * Null means the listing failed for a reason that is not absence -- a locked directory, a
 * network home that is not mounted right now. Absence is an empty list: a project with no
 * transcripts is an ordinary state, an unreadable one is a temporary blind spot.
 */
async function readDir(dir: string): Promise<import('node:fs').Dirent[] | null> {
  try {
    return await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === 'ENOENT' ? [] : null;
  }
}

async function readDirSafe(dir: string): Promise<import('node:fs').Dirent[]> {
  // A missing or unreadable directory means no transcripts, not a failure. This runs on every
  // enabled session; it must never be the thing that breaks one.
  return (await readDir(dir)) ?? [];
}

/**
 * How far below `subagents/` the descent goes.
 *
 * A bound rather than a shape list: the host has already added one level since this code was
 * written (`subagents/workflows/<wf_id>/`), and enumerating today's shapes is what left 34% of
 * the archive unindexed. Everything under `subagents/` is agent transcript by construction, so
 * the bound only exists to stop an unbounded walk on a pathological tree.
 */
const MAX_SUBAGENT_DEPTH = 4;

/** Every `.jsonl` in the `subagents/` subtree, at whatever depth the host put it. */
async function collectSubagentFiles(
  dir: string,
  parentSessionId: string,
  found: TranscriptFile[],
  depth: number,
): Promise<void> {
  for (const entry of await readDirSafe(dir)) {
    if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      found.push({
        path: path.join(dir, entry.name),
        sessionId: entry.name.slice(0, -'.jsonl'.length),
        parentSessionId,
        harness: 'claude',
      });
      continue;
    }
    if (entry.isDirectory() && depth < MAX_SUBAGENT_DEPTH) {
      await collectSubagentFiles(path.join(dir, entry.name), parentSessionId, found, depth + 1);
    }
  }
}

export type TranscriptScan = {
  files: TranscriptFile[];
  /**
   * True when this list may be missing files for a transient reason: the root set could not be
   * established, or a directory that should have been listed could not be. Callers that delete
   * on the strength of an absent file must not act on a degraded scan.
   */
  degraded: boolean;
};

/**
 * Every transcript belonging to this repo: its own sessions, its worktrees' sessions, and the
 * subagent transcripts under each parent session's UUID.
 *
 * The nesting is not optional to handle. Measured against this machine's archive on 2026-08-04,
 * for `d--Code-DuckPrep-server`: 83 files sit at the top level, 460 in `<uuid>/subagents/`, and
 * 282 in `<uuid>/subagents/workflows/<wf_id>/` -- so a scan that stops at the first two shapes
 * misses a third of the corpus, and one that stops at the top level misses 90% of it.
 *
 * The descent is whitelisted at the `subagents/` boundary and recursive *inside* it. A blind
 * recursive descent from the session UUID would sweep in `<uuid>/tool-results/`, which holds
 * fetched artifacts (PDFs here) and is precisely the tool output this feature exists to keep
 * out of the index -- and that directory is a sibling of `subagents/`, never a child, so
 * recursing within the subtree cannot reach it.
 *
 * Directory matching is exact (case-folded), never a prefix: `d--coding-knowl-cloud` is a
 * different repository that happens to start with this one's encoded name.
 */
export async function scanTranscriptArchive(
  projectRoot: string,
  options: { projectsDir?: string; codexSessionsDir?: string; roots?: string[] } = {},
): Promise<TranscriptScan> {
  const projectsDir = options.projectsDir ?? defaultProjectsDir();
  const rootSet = options.roots
    ? { roots: options.roots, degraded: false }
    : await resolveRepoRootSet(projectRoot);
  // Both encodings of every root, because only one of them is in the archive and which one
  // depends on how the host agent was launched.
  //
  // An archive directory is named for the path the AGENT had when it wrote the transcript; the
  // roots here come partly from the caller and partly from `git worktree list`, which always
  // answers canonically. Where a path has a symlink, a macOS `/var` -> `/private/var`, or a
  // Windows 8.3 short name in it, those two forms differ and an exact match finds nothing --
  // measured: every worktree session went unindexed on macOS and Windows while ubuntu, whose
  // paths are already canonical, saw nothing wrong for months.
  //
  // Case-folded because the drive letter's case is not stable across hosts: this archive holds
  // both `d--coding-knowl` and `D--coding-knowl-worktrees-pr-6`.
  // Canonicalising is not enough on its own, and this is the subtle half. `realpath` only maps
  // TOWARD the real path, but the archive is often named for the UN-canonical one: on macOS an
  // agent launched in `/var/folders/X` writes `-var-folders-X`, while `git worktree list`
  // reports its sibling worktree only as `/private/var/folders/X-wt`. No amount of resolving
  // git's answer produces `-var-folders-X-wt`. What is needed is the inverse substitution, and
  // the project root is what reveals it: knowing `/private/var` stands for `/var` here lets
  // every canonical root be expressed the way the agent would have written it.
  // Derived from the one pair we can see both halves of -- the project root as given and as
  // resolved -- by taking their longest common tail. What is left in front is the substitution:
  // `/private/var` stands for `/var` on macOS, `C:\Users\runneradmin` for `C:\Users\RUNNER~1`
  // on Windows. A whole-path prefix would not do, because a worktree is a SIBLING of the repo
  // rather than a child of it.
  const uncanonicalise = await deriveUncanonicalise(projectRoot);

  const wanted = new Set<string>();
  for (const root of rootSet.roots) {
    for (const form of await rootSpellings(root, uncanonicalise)) {
      wanted.add(encodeProjectDir(form).toLowerCase());
    }
  }
  const found: TranscriptFile[] = [];
  let degraded = rootSet.degraded;

  for (const repoDir of await readDirSafe(projectsDir)) {
    if (!repoDir.isDirectory() || !wanted.has(repoDir.name.toLowerCase())) continue;
    const repoPath = path.join(projectsDir, repoDir.name);

    // Checked rather than swallowed: a directory this repo owns that cannot be listed right now
    // is a blind spot, and its sessions must not be mistaken for deleted ones.
    const entries = await readDir(repoPath);
    if (entries === null) {
      degraded = true;
      continue;
    }

    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        found.push({
          path: path.join(repoPath, entry.name),
          sessionId: entry.name.slice(0, -'.jsonl'.length),
          parentSessionId: null,
          harness: 'claude',
        });
        continue;
      }

      // Only UUID-named directories hold subagent transcripts. `memory/` sits beside them
      // and contains no sessions.
      if (!entry.isDirectory() || !UUID.test(entry.name)) continue;
      const nestedPath = path.join(repoPath, entry.name);

      for (const nested of await readDirSafe(nestedPath)) {
        // The flat shape is cheap to support and the archive is not versioned.
        if (nested.isFile() && nested.name.endsWith('.jsonl')) {
          found.push({
            path: path.join(nestedPath, nested.name),
            sessionId: nested.name.slice(0, -'.jsonl'.length),
            parentSessionId: entry.name,
            harness: 'claude',
          });
          continue;
        }
        if (!nested.isDirectory() || nested.name.toLowerCase() !== SUBAGENT_DIR) continue;
        await collectSubagentFiles(path.join(nestedPath, nested.name), entry.name, found, 1);
      }
    }
  }

  // Codex, discovered by its own mechanism and merged into one list. A harness that is simply
  // not installed contributes nothing and is not a degradation: `collectCodexFiles` reports
  // degraded only when a directory that exists could not be listed.
  //
  // **Redirecting one archive redirects both.** A caller that passes `projectsDir` is pointing
  // discovery at a synthetic archive; letting the Codex half keep reading `~/.codex` would make
  // that caller's results depend on whatever the developer running it happens to have on disk.
  // That is not hypothetical -- it is what happened the first time this landed, and eight
  // discovery tests started returning 137 of this repository's real sessions alongside their
  // three fixtures. Production passes neither option and gets both real archives.
  const codexSessionsDir = options.codexSessionsDir
    ?? (options.projectsDir ? null : defaultCodexSessionsDir());
  if (codexSessionsDir) {
    const codex = await scanCodexArchive(codexSessionsDir, rootSet.roots, uncanonicalise);
    found.push(...codex.files);
    degraded = degraded || codex.degraded;
  }

  return { files: found, degraded };
}

/**
 * Whether either harness has an archive on this machine that this repo could index.
 *
 * **Two `stat` calls and no file is opened**, which is the entire design constraint. This answers
 * a question asked at the one moment a query has decided memory is empty, so it must cost
 * approximately nothing and must never throw. It reports *existence*, never a count: counting
 * Codex sessions means opening every file to read its `cwd`, and that is a scan, not a probe.
 *
 * The Claude check is repo-specific because its archive is keyed by project. The Codex check is
 * not -- the directory is shared across every project -- so this can answer true where a repo has
 * no Codex sessions of its own. That asymmetry is accepted: the notice it drives suggests turning
 * a feature on, and the cost of suggesting it to somebody with nothing to index is one line of
 * text, while the cost of staying silent is the cold start this exists to fix.
 */
export async function hasIndexableArchive(projectRoot: string): Promise<boolean> {
  const exists = (target: string) => fs.access(target).then(() => true, () => false);
  const claudeDir = path.join(defaultProjectsDir(), encodeProjectDir(path.resolve(projectRoot)));
  if (await exists(claudeDir)) return true;
  return exists(defaultCodexSessionsDir());
}

/** The file list alone, for callers with nothing to decide about a degraded scan. */
export async function discoverTranscriptFiles(
  projectRoot: string,
  options: { projectsDir?: string; codexSessionsDir?: string; roots?: string[] } = {},
): Promise<TranscriptFile[]> {
  return (await scanTranscriptArchive(projectRoot, options)).files;
}
