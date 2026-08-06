import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

export type TranscriptFile = {
  /** Absolute path to the `.jsonl`. */
  path: string;
  /** The file's basename without extension; Claude Code names it after the session. */
  sessionId: string;
  /** For a subagent transcript, the session that spawned it. Null for a main session. */
  parentSessionId: string | null;
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

/** Every `worktree <path>` line from `git worktree list --porcelain`, in order. */
export function parseWorktreeList(stdout: string): string[] {
  return stdout
    .split(/\r?\n/)
    .filter(line => line.startsWith('worktree '))
    .map(line => line.slice('worktree '.length).trim())
    .filter(Boolean);
}

/** Windows and macOS paths compare case-insensitively; POSIX ones do not. */
const foldPath = (target: string) =>
  process.platform === 'win32' || process.platform === 'darwin'
    ? path.resolve(target).toLowerCase()
    : path.resolve(target);

const samePath = (left: string, right: string) => foldPath(left) === foldPath(right);

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
  options: { projectsDir?: string; roots?: string[] } = {},
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
  const givenRoot = path.resolve(projectRoot);
  const realGivenRoot = await fs.realpath(givenRoot).catch(() => givenRoot);
  let realHead = '';
  let givenHead = '';
  if (foldPath(realGivenRoot) !== foldPath(givenRoot)) {
    let shared = 0;
    while (
      shared < realGivenRoot.length && shared < givenRoot.length
      && foldPath(realGivenRoot[realGivenRoot.length - 1 - shared]) === foldPath(givenRoot[givenRoot.length - 1 - shared])
    ) shared += 1;
    realHead = realGivenRoot.slice(0, realGivenRoot.length - shared);
    givenHead = givenRoot.slice(0, givenRoot.length - shared);
  }
  const uncanonicalise = (target: string): string | null => {
    if (!realHead) return null;
    if (!foldPath(target).startsWith(foldPath(realHead))) return null;
    return givenHead + target.slice(realHead.length);
  };

  const wanted = new Set<string>();
  for (const root of rootSet.roots) {
    const resolvedRoot = path.resolve(root);
    for (const form of [resolvedRoot, await fs.realpath(resolvedRoot).catch(() => null), uncanonicalise(resolvedRoot)]) {
      if (form) wanted.add(encodeProjectDir(form).toLowerCase());
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
          });
          continue;
        }
        if (!nested.isDirectory() || nested.name.toLowerCase() !== SUBAGENT_DIR) continue;
        await collectSubagentFiles(path.join(nestedPath, nested.name), entry.name, found, 1);
      }
    }
  }

  return { files: found, degraded };
}

/** The file list alone, for callers with nothing to decide about a degraded scan. */
export async function discoverTranscriptFiles(
  projectRoot: string,
  options: { projectsDir?: string; roots?: string[] } = {},
): Promise<TranscriptFile[]> {
  return (await scanTranscriptArchive(projectRoot, options)).files;
}
