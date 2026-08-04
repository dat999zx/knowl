import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  discoverTranscriptFiles,
  encodeProjectDir,
  parseWorktreeList,
  resolveRepoRoots,
  resolveRepoRootSet,
  scanTranscriptArchive,
} from '../../src/transcripts/paths.js';

const run = promisify(execFile);

let projectsDir: string;

/**
 * Roots and their encoded directory names, derived rather than hardcoded.
 *
 * Discovery resolves a root before encoding it, and `path.resolve` is platform-dependent:
 * on POSIX `d:\coding\knowl` is a *relative* path and resolves against the working directory,
 * so it encodes to something quite different there. CI runs ubuntu-latest, so hardcoding the
 * Windows spelling would pass locally and fail on every push. The literals stay
 * platform-realistic; only the expected encoding is computed.
 */
const ROOT = path.resolve(process.platform === 'win32' ? 'd:\\coding\\knowl' : '/coding/knowl');
const WORKTREE_ROOT = path.resolve(process.platform === 'win32'
  ? 'C:\\Users\\Admin\\AppData\\Local\\Temp\\claude\\knowl-pr7'
  : '/tmp/claude/knowl-pr7');
const ENCODED = encodeProjectDir(ROOT);
const ENCODED_WORKTREE = encodeProjectDir(WORKTREE_ROOT);

beforeEach(async () => {
  projectsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'knowl-transcripts-'));
});

afterEach(async () => {
  await fs.rm(projectsDir, { recursive: true, force: true });
});

async function write(relative: string, body = '{}\n') {
  const target = path.join(projectsDir, relative);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, body);
}

describe('encodeProjectDir', () => {
  it('encodes a Windows root the way Claude Code does', () => {
    expect(encodeProjectDir('d:\\coding\\knowl')).toBe('d--coding-knowl');
  });

  it('encodes a POSIX root', () => {
    expect(encodeProjectDir('/home/dev/knowl')).toBe('-home-dev-knowl');
  });
});

describe('discoverTranscriptFiles', () => {
  it('finds top-level session transcripts', async () => {
    await write(`${ENCODED}/aaa.jsonl`);
    await write(`${ENCODED}/bbb.jsonl`);

    const found = await discoverTranscriptFiles(ROOT, { projectsDir });

    expect(found.map(f => f.sessionId).sort()).toEqual(['aaa', 'bbb']);
    expect(found.every(f => f.parentSessionId === null)).toBe(true);
  });

  // The shape this repo's archive actually has, measured 2026-08-03: the transcripts are a
  // level deeper than the session UUID, inside `subagents/`. Reading only the UUID directory
  // finds 24 of 76 files here -- every top-level session and not one subagent.
  it('finds subagent transcripts inside the subagents/ directory', async () => {
    await write(`${ENCODED}/parent.jsonl`);
    await write(`${ENCODED}/78aed75d-4bed-4d1a-a93e-f3fd3eab4fb4/subagents/sub-one.jsonl`);
    await write(`${ENCODED}/78aed75d-4bed-4d1a-a93e-f3fd3eab4fb4/subagents/sub-two.jsonl`);

    const found = await discoverTranscriptFiles(ROOT, { projectsDir });

    expect(found).toHaveLength(3);
    const subagents = found.filter(f => f.parentSessionId !== null);
    expect(subagents.map(f => f.sessionId).sort()).toEqual(['sub-one', 'sub-two']);
    expect(subagents.every(f => f.parentSessionId === '78aed75d-4bed-4d1a-a93e-f3fd3eab4fb4')).toBe(true);
  });

  // `tool-results/` sits beside `subagents/` and holds fetched artifacts -- PDFs in this
  // archive. It is exactly the tool output this feature exists to keep out of the index, so
  // the descent names the one directory it wants rather than recursing.
  it('does not descend into tool-results/ beside the subagents directory', async () => {
    await write(`${ENCODED}/4488248f-c38c-403e-9fa2-7b11902405c7/tool-results/webfetch-1.jsonl`);
    await write(`${ENCODED}/4488248f-c38c-403e-9fa2-7b11902405c7/subagents/real.jsonl`);

    const found = await discoverTranscriptFiles(ROOT, { projectsDir });

    expect(found.map(f => f.sessionId)).toEqual(['real']);
  });

  it('ignores non-UUID subdirectories such as memory/', async () => {
    await write(`${ENCODED}/aaa.jsonl`);
    await write(`${ENCODED}/memory/notes.jsonl`);

    const found = await discoverTranscriptFiles(ROOT, { projectsDir });

    expect(found.map(f => f.sessionId)).toEqual(['aaa']);
  });

  it('includes a worktree whose path is nowhere near the main root', async () => {
    await write(`${ENCODED}/main.jsonl`);
    await write(`${ENCODED_WORKTREE}/wt.jsonl`);

    const found = await discoverTranscriptFiles(ROOT, {
      projectsDir,
      roots: [ROOT, WORKTREE_ROOT],
    });

    expect(found.map(f => f.sessionId).sort()).toEqual(['main', 'wt']);
  });

  it('excludes a different repo whose name merely shares a prefix', async () => {
    await write(`${ENCODED}/main.jsonl`);
    await write(`${ENCODED}-cloud/other.jsonl`);

    const found = await discoverTranscriptFiles(ROOT, { projectsDir });

    expect(found.map(f => f.sessionId)).toEqual(['main']);
  });

  it('matches case-insensitively, since the drive letter is not stable', async () => {
    await write(`${ENCODED.toUpperCase()}/main.jsonl`);

    const found = await discoverTranscriptFiles(ROOT, { projectsDir });

    expect(found.map(f => f.sessionId)).toEqual(['main']);
  });

  it('returns an empty list when the projects directory does not exist', async () => {
    const found = await discoverTranscriptFiles(ROOT, {
      projectsDir: path.join(projectsDir, 'nope'),
    });
    expect(found).toEqual([]);
  });

  // K-24. The archive nests a third level: a subagent spawned inside a workflow run lands in
  // `<uuid>/subagents/workflows/<wf_id>/`. Measured against this machine's archive on
  // 2026-08-04: 282 of 825 files in `d--Code-DuckPrep-server` -- 34.2% of that repo's corpus --
  // sit at that depth and were never indexed.
  it('finds a subagent transcript nested under subagents/workflows/', async () => {
    await write(`${ENCODED}/parent.jsonl`);
    await write(`${ENCODED}/78aed75d-4bed-4d1a-a93e-f3fd3eab4fb4/subagents/workflows/wf_1b6f540c-149/agent-a007.jsonl`);

    const found = await discoverTranscriptFiles(ROOT, { projectsDir });

    const nested = found.find(f => f.sessionId === 'agent-a007');
    expect(nested).toBeDefined();
    expect(nested!.parentSessionId).toBe('78aed75d-4bed-4d1a-a93e-f3fd3eab4fb4');
  });

  // The descent follows the `subagents/` subtree wherever it goes rather than enumerating the
  // shapes seen in one snapshot of the archive -- which is what left the level above unindexed.
  it('follows the subagents subtree however deep the host nests it', async () => {
    await write(`${ENCODED}/78aed75d-4bed-4d1a-a93e-f3fd3eab4fb4/subagents/workflows/wf_x/inner/deep.jsonl`);

    const found = await discoverTranscriptFiles(ROOT, { projectsDir });

    expect(found.map(f => f.sessionId)).toEqual(['deep']);
  });

  // Recursion stays inside `subagents/`, so the sibling that holds fetched artifacts is still
  // out of reach however deep it goes.
  it('still refuses to descend into tool-results/, at any depth', async () => {
    await write(`${ENCODED}/4488248f-c38c-403e-9fa2-7b11902405c7/tool-results/nested/deep/webfetch.jsonl`);
    await write(`${ENCODED}/4488248f-c38c-403e-9fa2-7b11902405c7/subagents/real.jsonl`);

    const found = await discoverTranscriptFiles(ROOT, { projectsDir });

    expect(found.map(f => f.sessionId)).toEqual(['real']);
  });
});

describe('scanTranscriptArchive', () => {
  it('reports a healthy scan as not degraded', async () => {
    await write(`${ENCODED}/aaa.jsonl`);

    const scan = await scanTranscriptArchive(ROOT, { projectsDir, roots: [ROOT] });

    expect(scan.files.map(f => f.sessionId)).toEqual(['aaa']);
    expect(scan.degraded).toBe(false);
  });

  // K-11. The root set is answered by `git`, and a missing binary is indistinguishable from
  // "this project has no worktrees" by the file list alone. The caller has to be told, because
  // acting on the shrunken list deletes rows and embeddings that were never stale.
  it('reports degraded when the root set could not be established', async () => {
    const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'knowl-degraded-'));
    const emptyPath = await fs.mkdtemp(path.join(os.tmpdir(), 'knowl-nogit-'));
    const savedPath = process.env.PATH;
    try {
      process.env.PATH = emptyPath; // git becomes unresolvable: ENOENT on spawn
      const scan = await scanTranscriptArchive(repo, { projectsDir });
      expect(scan.degraded).toBe(true);
    } finally {
      process.env.PATH = savedPath;
      await fs.rm(repo, { recursive: true, force: true });
      await fs.rm(emptyPath, { recursive: true, force: true });
    }
  });
});

describe('parseWorktreeList', () => {
  it('extracts every worktree path from porcelain output', () => {
    const stdout = [
      'worktree D:/coding/knowl',
      'HEAD 1cae2ba0000000000000000000000000000000aa',
      'branch refs/heads/main',
      '',
      'worktree C:/Users/Admin/AppData/Local/Temp/claude/knowl-pr7',
      'HEAD 8f9e5560000000000000000000000000000000bb',
      'branch refs/heads/pr-7',
      '',
    ].join('\n');

    expect(parseWorktreeList(stdout)).toEqual([
      'D:/coding/knowl',
      'C:/Users/Admin/AppData/Local/Temp/claude/knowl-pr7',
    ]);
  });

  it('handles a bare worktree entry with no branch line', () => {
    const stdout = 'worktree /srv/repo\nbare\n\n';
    expect(parseWorktreeList(stdout)).toEqual(['/srv/repo']);
  });

  it('returns an empty list for empty output', () => {
    expect(parseWorktreeList('')).toEqual([]);
  });
});

describe('resolveRepoRoots', () => {
  it('falls back to the project root when the directory is not a git checkout', async () => {
    const roots = await resolveRepoRoots(projectsDir);
    expect(roots).toEqual([path.resolve(projectsDir)]);
  });

  it('lists this repository and its worktrees when run inside a real checkout', async () => {
    const roots = await resolveRepoRoots(process.cwd());
    expect(roots.length).toBeGreaterThanOrEqual(1);
    expect(roots.map(r => path.resolve(r))).toContain(path.resolve(process.cwd()));
  });

  // K-09 privacy leak. `git worktree list` answers for the *enclosing* repository, so a knowl
  // project that is a subdirectory of a larger checkout was told its roots were that checkout
  // and every one of its worktrees -- and then indexed their transcripts. With sharing on it
  // serves peers content the enclosing repo never opted into.
  it('does not adopt the enclosing repository when the project root is a subdirectory', async () => {
    const inner = path.join(process.cwd(), 'src', 'transcripts');

    // The premise: git really does answer for the enclosing checkout from in here.
    const { stdout } = await run('git', ['worktree', 'list', '--porcelain'], { cwd: inner });
    expect(parseWorktreeList(stdout).length).toBeGreaterThan(0);
    expect(parseWorktreeList(stdout).map(r => path.resolve(r))).not.toContain(path.resolve(inner));

    expect(await resolveRepoRoots(inner)).toEqual([path.resolve(inner)]);
  });

  it('is not degraded when the directory is definitively not a checkout', async () => {
    // "fatal: not a git repository" is an answer, not a failure: there are no worktrees to miss,
    // so reclaiming rows for deleted transcripts stays safe.
    const result = await resolveRepoRootSet(projectsDir);
    expect(result).toEqual({ roots: [path.resolve(projectsDir)], degraded: false });
  });

  it('degrades when git cannot be run at all', async () => {
    const emptyPath = await fs.mkdtemp(path.join(os.tmpdir(), 'knowl-nogit-'));
    const savedPath = process.env.PATH;
    try {
      process.env.PATH = emptyPath;
      const result = await resolveRepoRootSet(projectsDir);
      expect(result).toEqual({ roots: [path.resolve(projectsDir)], degraded: true });
    } finally {
      process.env.PATH = savedPath;
      await fs.rm(emptyPath, { recursive: true, force: true });
    }
  });
});
