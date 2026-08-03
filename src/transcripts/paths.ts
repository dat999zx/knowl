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

/**
 * This repo's root and the roots of its worktrees.
 *
 * Asking git rather than pattern-matching directory names. A worktree lives wherever it was
 * created -- this repo's own is on a different drive from the main checkout -- so there is no
 * prefix, suffix or convention that finds them. The trade is that a *deleted* worktree stops
 * being discovered, which is correct: its rows are then cleaned up as dead files.
 *
 * Any failure degrades to the project root alone. This runs on every enabled session, and a
 * missing git binary or a non-checkout directory must never be the thing that breaks one.
 */
export async function resolveRepoRoots(projectRoot: string): Promise<string[]> {
  const resolved = path.resolve(projectRoot);
  try {
    const { stdout } = await run('git', ['worktree', 'list', '--porcelain'], { cwd: resolved });
    const roots = parseWorktreeList(stdout).map(root => path.resolve(root));
    return roots.length > 0 ? [...new Set([resolved, ...roots])] : [resolved];
  } catch {
    return [resolved];
  }
}

async function readDirSafe(dir: string): Promise<import('node:fs').Dirent[]> {
  try {
    return await fs.readdir(dir, { withFileTypes: true });
  } catch {
    // A missing or unreadable projects directory means no transcripts, not a failure. This
    // runs on every enabled session; it must never be the thing that breaks one.
    return [];
  }
}

/**
 * Every transcript belonging to this repo: its own sessions, its worktrees' sessions, and the
 * subagent transcripts nested one level under each parent session's UUID.
 *
 * The nesting is not optional to handle. In this repo's own archive, 52 of 75 transcript files
 * live in those subdirectories -- a top-level-only scan silently misses 69% of the corpus.
 *
 * Directory matching is exact (case-folded), never a prefix: `d--coding-knowl-cloud` is a
 * different repository that happens to start with this one's encoded name.
 */
export async function discoverTranscriptFiles(
  projectRoot: string,
  options: { projectsDir?: string; roots?: string[] } = {},
): Promise<TranscriptFile[]> {
  const projectsDir = options.projectsDir ?? defaultProjectsDir();
  const roots = options.roots ?? await resolveRepoRoots(projectRoot);
  // Case-folded because the drive letter's case is not stable across hosts: this archive holds
  // both `d--coding-knowl` and `D--coding-knowl-worktrees-pr-6`.
  const wanted = new Set(roots.map(root => encodeProjectDir(path.resolve(root)).toLowerCase()));
  const found: TranscriptFile[] = [];

  for (const repoDir of await readDirSafe(projectsDir)) {
    if (!repoDir.isDirectory() || !wanted.has(repoDir.name.toLowerCase())) continue;
    const repoPath = path.join(projectsDir, repoDir.name);

    for (const entry of await readDirSafe(repoPath)) {
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

      // Measured against this repo's own archive: the transcripts sit in a `subagents/`
      // child, not directly under the session UUID. Both levels are read because the
      // flat shape is cheap to support and the archive is not versioned -- but only
      // those two. A blind recursive descent would sweep in `<uuid>/tool-results/`,
      // which holds fetched artifacts (PDFs here) and is precisely the tool output this
      // feature exists to keep out of the index.
      for (const nested of await readDirSafe(nestedPath)) {
        if (nested.isFile() && nested.name.endsWith('.jsonl')) {
          found.push({
            path: path.join(nestedPath, nested.name),
            sessionId: nested.name.slice(0, -'.jsonl'.length),
            parentSessionId: entry.name,
          });
          continue;
        }
        if (!nested.isDirectory() || nested.name.toLowerCase() !== SUBAGENT_DIR) continue;
        const subagentPath = path.join(nestedPath, nested.name);
        for (const leaf of await readDirSafe(subagentPath)) {
          if (!leaf.isFile() || !leaf.name.endsWith('.jsonl')) continue;
          found.push({
            path: path.join(subagentPath, leaf.name),
            sessionId: leaf.name.slice(0, -'.jsonl'.length),
            parentSessionId: entry.name,
          });
        }
      }
    }
  }

  return found;
}
