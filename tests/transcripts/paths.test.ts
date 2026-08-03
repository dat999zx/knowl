import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  discoverTranscriptFiles,
  encodeProjectDir,
  parseWorktreeList,
  resolveRepoRoots,
} from '../../src/transcripts/paths.js';

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
});
