# Optional Transcript Search Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a repository's Claude Code session transcripts searchable from Knowl, off by default, storing pointers into the `.jsonl` files rather than a second copy of the archive.

**Architecture:** A self-contained `src/transcripts/` module owning its own SQLite file at `.knowl/transcripts.db`. Indexing streams each `.jsonl`, keeps only user/assistant prose, and writes `(session, line, role)` rows plus a contentless FTS5 term index and one int8 vector per message. Search fuses BM25 and cosine rankings with Reciprocal Rank Fusion; message bodies are read back from the source file on demand. Nothing is created and no MCP tools are registered unless `search.transcripts.enabled` is true.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), `@libsql/client` (SQLite 3.45.1), FTS5 with `content=''` and `contentless_delete=1`, `@huggingface/transformers` via the existing local embedding provider, Vitest, Commander.

**Spec:** [docs/superpowers/specs/2026-08-03-optional-transcript-search-design.md](../specs/2026-08-03-optional-transcript-search-design.md)

## Global Constraints

- **Off by default.** `search.transcripts.enabled` defaults to `false`. When false: no database file is created, no MCP tools are registered, no indexing runs.
- **Never copy message text into the database.** Rows are `(session_id, line, role, chars)`. Bodies are read from the `.jsonl` at query time.
- **Prose only.** Index `type: 'user'` and `type: 'assistant'` entries, taking only `content` blocks of `type: 'text'` (or a bare string `content`). Never index tool results or pasted file bodies.
- **Separate database.** `.knowl/transcripts.db`, never `knowl.db`. Do not use `getClient()` / `getDb()` from `src/store/database.ts` — those are the knowledge database.
- **Append-only resume.** All indexing resumes from `transcript_files.bytes_indexed`. Every pass must be interruptible and restartable with no double-indexing.
- **ESM imports.** All relative imports end in `.js`, e.g. `import { x } from './paths.js'`.
- **Vector dimensions:** 384. **Quantization scale:** `6 / Math.sqrt(dims)`. **RRF constant:** `k = 60`. **BM25 role weights:** user `2.0`, assistant `1.0`.
- **Test command:** `npx vitest run <path>` for one file; `npm test` for the suite.
- **Commit style:** Conventional Commits (`feat:`, `fix:`, `test:`, `docs:`), lowercase subject, no trailing period.

---

### Task 1: Config gate and storage path

Adds the `search.transcripts` config block, its two entries in the `knowl config` editor, and the `transcripts` storage role. Nothing reads them yet — this task exists so every later task has a real flag to gate on.

**Files:**
- Modify: `src/core/types.ts:235-247` (the `search` block of `ProjectConfig`)
- Modify: `src/store/storage-roles.ts:20-35`
- Modify: `src/cli/config/schema.ts` (append two fields to the `Search` category)
- Test: `tests/transcripts/config-gate.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `ProjectConfig['search']['transcripts']` → `{ enabled?: boolean; share?: boolean }`
  - `isTranscriptSearchEnabled(config: ProjectConfig): boolean`
  - `isTranscriptSharingEnabled(config: ProjectConfig): boolean`
  - `resolveStorage(root).transcripts` → `string` (absolute path to `<root>/.knowl/transcripts.db`)

- [ ] **Step 1: Write the failing test**

Create `tests/transcripts/config-gate.test.ts`:

```typescript
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveStorage } from '../../src/store/storage-roles.js';
import { isTranscriptSearchEnabled, isTranscriptSharingEnabled } from '../../src/transcripts/config.js';
import type { ProjectConfig } from '../../src/core/types.js';

const baseConfig = (): ProjectConfig => ({
  version: 1,
  security: { rejectSecrets: true, secretPatterns: [] },
});

describe('transcript search config gate', () => {
  it('is disabled when the config says nothing', () => {
    expect(isTranscriptSearchEnabled(baseConfig())).toBe(false);
  });

  it('is disabled when the search block exists but transcripts does not', () => {
    const config = { ...baseConfig(), search: { vector: { enabled: true } } };
    expect(isTranscriptSearchEnabled(config)).toBe(false);
  });

  it('requires the literal true, not any truthy value', () => {
    const config = { ...baseConfig(), search: { transcripts: { enabled: 1 as unknown as boolean } } };
    expect(isTranscriptSearchEnabled(config)).toBe(false);
  });

  it('is enabled only when explicitly set', () => {
    const config = { ...baseConfig(), search: { transcripts: { enabled: true } } };
    expect(isTranscriptSearchEnabled(config)).toBe(true);
  });

  it('does not share by default, even when enabled', () => {
    const config = { ...baseConfig(), search: { transcripts: { enabled: true } } };
    expect(isTranscriptSharingEnabled(config)).toBe(false);
  });

  it('shares only when both enabled and share are true', () => {
    const shareOnly = { ...baseConfig(), search: { transcripts: { share: true } } };
    expect(isTranscriptSharingEnabled(shareOnly)).toBe(false);

    const both = { ...baseConfig(), search: { transcripts: { enabled: true, share: true } } };
    expect(isTranscriptSharingEnabled(both)).toBe(true);
  });

  it('resolves the transcripts database beside the knowledge database', () => {
    const storage = resolveStorage('/tmp/proj');
    expect(storage.transcripts).toBe(path.join('/tmp/proj', '.knowl', 'transcripts.db'));
    expect(storage.transcripts).not.toBe(storage.knowledge);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/transcripts/config-gate.test.ts`
Expected: FAIL — `Cannot find module '../../src/transcripts/config.js'`

- [ ] **Step 3: Add the config type**

In `src/core/types.ts`, extend the `search` block of `ProjectConfig` (currently ends at line 247) so it reads:

```typescript
  search?: {
    vector?: {
      enabled?: boolean;
      provider?: 'local';
      /** Named profile bundling model, dtype and pooling. See resolveVectorProfile. */
      preset?: string;
      model?: string;
      dtype?: 'q4' | 'q8' | 'fp32' | 'fp16';
      /** Only read when the preset is `custom` or absent; a preset carries its own. */
      pooling?: 'mean' | 'cls';
      cacheDir?: string;
    };
    /**
     * Searchable session transcripts. Off by default: enabling it creates a second
     * database and registers two more MCP tools, which costs guidance-card space in
     * every session of every user -- including those who never search a transcript.
     */
    transcripts?: {
      enabled?: boolean;
      /** Let linked workspace repos open this index read-only. Requires `enabled`. */
      share?: boolean;
    };
  };
```

- [ ] **Step 4: Create the predicate module**

Create `src/transcripts/config.ts`:

```typescript
import type { ProjectConfig } from '../core/types.js';

export function isTranscriptSearchEnabled(config: ProjectConfig): boolean {
  return config.search?.transcripts?.enabled === true;
}

/**
 * Sharing is meaningless without a local index, so it is an AND rather than its own flag.
 * A repo that turned search off but left `share: true` behind would otherwise advertise an
 * index that no longer exists, and every peer would take an `absent` skip for it.
 */
export function isTranscriptSharingEnabled(config: ProjectConfig): boolean {
  return isTranscriptSearchEnabled(config) && config.search?.transcripts?.share === true;
}
```

- [ ] **Step 5: Add the storage role**

In `src/store/storage-roles.ts`, add `transcripts` to both the type and the resolver:

```typescript
export type StorageRole = 'local' | 'session' | 'knowledge' | 'transcripts';

export type ResolvedStorage = {
  local: string;
  session: string;
  knowledge: string;
  /**
   * Searchable session transcripts. Deliberately its own file: a backfill of tens of
   * thousands of rows must not contend for a write lock with the live session writing
   * knowledge, and "feature off" should mean a file that does not exist.
   */
  transcripts: string;
};

export function resolveStorage(root: string, _config?: ProjectConfig): ResolvedStorage {
  const knowlDir = path.join(root, '.knowl');
  return {
    local: path.join(knowlDir, 'knowl.db'),
    session: path.join(knowlDir, 'session.db'),
    knowledge: path.join(knowlDir, 'knowl.db'),
    transcripts: path.join(knowlDir, 'transcripts.db'),
  };
}
```

- [ ] **Step 6: Add the config editor fields**

In `src/cli/config/schema.ts`, append these two entries to the fields array immediately after the `search.vector.cacheDir` entry (which ends around line 125). Match the surrounding entries' shape exactly:

```typescript
  {
    key: 'search.transcripts.enabled', category: 'Search', type: 'boolean',
    parse: booleanValue, defaultValue: false,
    label: 'Transcript search',
    description: 'Search this repo\'s past Claude Code sessions. Builds a separate index the first time you run `knowl reindex --transcripts`.',
  },
  {
    key: 'search.transcripts.share', category: 'Search', type: 'boolean',
    parse: booleanValue, defaultValue: false,
    label: 'Share transcripts with workspace',
    description: 'Let linked workspace repos search this repo\'s transcripts, read-only. Has no effect unless transcript search is on.',
  },
```

Then add both keys to the `ConfigKey` union in the same file, alongside the existing `search.vector.*` keys.

- [ ] **Step 7: Run tests to verify they pass**

Run: `npx vitest run tests/transcripts/config-gate.test.ts`
Expected: PASS, 7 tests

Run: `npx tsc --noEmit`
Expected: no errors. If `resolveStorage` callers break, they should not — the return type only gained a property.

- [ ] **Step 8: Commit**

```bash
git add src/core/types.ts src/store/storage-roles.ts src/cli/config/schema.ts src/transcripts/config.ts tests/transcripts/config-gate.test.ts
git commit -m "feat(transcripts): add the off-by-default config gate and storage path"
```

---

### Task 2: Transcript file discovery

Finds which `.jsonl` files belong to this repo. Three things make this non-obvious and all are load-bearing: worktrees live at arbitrary paths, subagent transcripts are nested one level deep under the parent session's UUID, and a sibling repo can share a name prefix.

**Do not infer a worktree path convention.** An earlier draft matched `<encoded-root>-worktrees-*`, generalising from the one worktree in this repo's archive. It is wrong — verify for yourself with `git worktree list`:

```
D:/coding/knowl                                     [main]
C:/Users/Admin/AppData/Local/Temp/claude/knowl-pr7  [pr-7]
```

The second is on a different drive and shares no prefix with the first. Roots come from git; each is encoded independently; matching is **exact**, which also drops the `d--coding-knowl-cloud` false positive for free.

**Files:**
- Create: `src/transcripts/paths.ts`
- Test: `tests/transcripts/paths.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `encodeProjectDir(projectRoot: string): string`
  - `parseWorktreeList(stdout: string): string[]`
  - `resolveRepoRoots(projectRoot: string): Promise<string[]>`
  - `type TranscriptFile = { path: string; sessionId: string; parentSessionId: string | null }`
  - `discoverTranscriptFiles(projectRoot: string, options?: { projectsDir?: string; roots?: string[] }): Promise<TranscriptFile[]>`

- [ ] **Step 1: Write the failing test**

Create `tests/transcripts/paths.test.ts`:

```typescript
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
    await write('d--coding-knowl/aaa.jsonl');
    await write('d--coding-knowl/bbb.jsonl');

    const found = await discoverTranscriptFiles('d:\\coding\\knowl', { projectsDir });

    expect(found.map(f => f.sessionId).sort()).toEqual(['aaa', 'bbb']);
    expect(found.every(f => f.parentSessionId === null)).toBe(true);
  });

  it('finds subagent transcripts nested under the parent session UUID', async () => {
    await write('d--coding-knowl/parent.jsonl');
    await write('d--coding-knowl/78aed75d-4bed-4d1a-a93e-f3fd3eab4fb4/sub-one.jsonl');
    await write('d--coding-knowl/78aed75d-4bed-4d1a-a93e-f3fd3eab4fb4/sub-two.jsonl');

    const found = await discoverTranscriptFiles('d:\\coding\\knowl', { projectsDir });

    expect(found).toHaveLength(3);
    const subagents = found.filter(f => f.parentSessionId !== null);
    expect(subagents).toHaveLength(2);
    expect(subagents[0].parentSessionId).toBe('78aed75d-4bed-4d1a-a93e-f3fd3eab4fb4');
  });

  it('ignores non-UUID subdirectories such as memory/', async () => {
    await write('d--coding-knowl/aaa.jsonl');
    await write('d--coding-knowl/memory/notes.jsonl');

    const found = await discoverTranscriptFiles('d:\\coding\\knowl', { projectsDir });

    expect(found.map(f => f.sessionId)).toEqual(['aaa']);
  });

  it('includes a worktree whose path is nowhere near the main root', async () => {
    await write('d--coding-knowl/main.jsonl');
    await write('C--Users-Admin-AppData-Local-Temp-claude-knowl-pr7/wt.jsonl');

    const found = await discoverTranscriptFiles('d:\\coding\\knowl', {
      projectsDir,
      roots: ['d:\\coding\\knowl', 'C:\\Users\\Admin\\AppData\\Local\\Temp\\claude\\knowl-pr7'],
    });

    expect(found.map(f => f.sessionId).sort()).toEqual(['main', 'wt']);
  });

  it('excludes a different repo whose name merely shares a prefix', async () => {
    await write('d--coding-knowl/main.jsonl');
    await write('d--coding-knowl-cloud/other.jsonl');

    const found = await discoverTranscriptFiles('d:\\coding\\knowl', { projectsDir });

    expect(found.map(f => f.sessionId)).toEqual(['main']);
  });

  it('matches case-insensitively, since the drive letter is not stable', async () => {
    await write('D--coding-knowl/main.jsonl');

    const found = await discoverTranscriptFiles('d:\\coding\\knowl', { projectsDir });

    expect(found.map(f => f.sessionId)).toEqual(['main']);
  });

  it('returns an empty list when the projects directory does not exist', async () => {
    const found = await discoverTranscriptFiles('d:\\coding\\knowl', {
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/transcripts/paths.test.ts`
Expected: FAIL — `Cannot find module '../../src/transcripts/paths.js'`

Two tests encode the real traps. `d--coding-knowl-cloud` is a **different repo** that shares a prefix, so any `startsWith` rule is wrong. And the worktree test uses a root on another drive, which is what a path convention cannot reach.

- [ ] **Step 3: Write the implementation**

Create `src/transcripts/paths.ts`:

```typescript
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
      for (const nested of await readDirSafe(nestedPath)) {
        if (!nested.isFile() || !nested.name.endsWith('.jsonl')) continue;
        found.push({
          path: path.join(nestedPath, nested.name),
          sessionId: nested.name.slice(0, -'.jsonl'.length),
          parentSessionId: entry.name,
        });
      }
    }
  }

  return found;
}
```

Note the encoding test expects `d:\coding\knowl` → `d--coding-knowl`, but `path.resolve` on POSIX will not alter a Windows-style string, and on Windows it returns `d:\coding\knowl`. Both encode identically, so the test passes on either platform.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/transcripts/paths.test.ts`
Expected: PASS, 14 tests

- [ ] **Step 5: Verify against the real archive**

This is the step that would have caught the original bug. Run:

```bash
node -e "
const { discoverTranscriptFiles, resolveRepoRoots } = require('./dist/index.js');
" 2>/dev/null || npx tsx -e "
import { discoverTranscriptFiles, resolveRepoRoots } from './src/transcripts/paths.js';
const roots = await resolveRepoRoots(process.cwd());
console.log('roots:', roots);
const files = await discoverTranscriptFiles(process.cwd());
console.log('transcripts found:', files.length);
console.log('subagent files:', files.filter(f => f.parentSessionId).length);
"
```

Expected: more than one root if a worktree exists, and a file count in the same order as `find ~/.claude/projects/<encoded> -name '*.jsonl' | wc -l`. A count that matches only the top-level file count means the subagent descent is broken.

- [ ] **Step 6: Commit**

```bash
git add src/transcripts/paths.ts tests/transcripts/paths.test.ts
git commit -m "feat(transcripts): discover session files via git worktree roots"
```

---

### Task 3: Prose extraction

Streams a `.jsonl` and yields only what a person said, with the byte offset and line number needed to resume and to point back.

**This must actually stream.** The largest sessions here are several megabytes, and the caller enforces a 1.5s hook budget and a `--budget` flag against it. Reading the remainder of a file into one buffer makes both unenforceable and scales memory with session length. Peak memory below is one 64 KB chunk plus one partial line, regardless of file size.

Each yielded message carries the watermark that becomes valid *once that message is committed*, which is what lets Task 5 advance `bytes_indexed` inside the same transaction as the rows.

**Files:**
- Create: `src/transcripts/parse.ts`
- Test: `tests/transcripts/parse.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `type ProseMessage = { line: number; role: 'user' | 'assistant'; text: string; timestamp: string | null }`
  - `type ProseChunk = { message: ProseMessage; bytesConsumed: number; linesConsumed: number }`
  - `type ProseWatermark = { bytesConsumed: number; linesConsumed: number }`
  - `extractProse(entry: unknown): { role: 'user' | 'assistant'; text: string; timestamp: string | null } | null`
  - `streamProseFrom(filePath: string, startByte: number, startLine: number): AsyncGenerator<ProseChunk, ProseWatermark>`
  - `readProseFrom(filePath: string, startByte: number, startLine: number): Promise<{ messages: ProseMessage[]; bytesRead: number; linesRead: number }>` — thin wrapper that drains the generator; used by tests, not by the index pass

- [ ] **Step 1: Write the failing test**

Create `tests/transcripts/parse.test.ts`:

```typescript
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { extractProse, readProseFrom, streamProseFrom } from '../../src/transcripts/parse.js';

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'knowl-parse-'));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const userLine = (text: string) =>
  JSON.stringify({ type: 'user', timestamp: '2026-08-03T10:00:00Z', message: { content: text } });

const assistantLine = (blocks: unknown[]) =>
  JSON.stringify({ type: 'assistant', timestamp: '2026-08-03T10:00:01Z', message: { content: blocks } });

describe('extractProse', () => {
  it('reads a bare string user message', () => {
    expect(extractProse(JSON.parse(userLine('why did it crash?')))).toEqual({
      role: 'user',
      text: 'why did it crash?',
      timestamp: '2026-08-03T10:00:00Z',
    });
  });

  it('keeps only text blocks from an assistant message', () => {
    const entry = JSON.parse(assistantLine([
      { type: 'text', text: 'The batch size was wrong.' },
      { type: 'tool_use', name: 'Bash', input: { command: 'npm test' } },
      { type: 'text', text: ' It was a page size.' },
    ]));
    expect(extractProse(entry)?.text).toBe('The batch size was wrong. It was a page size.');
  });

  it('drops a message that is only tool output', () => {
    const entry = JSON.parse(JSON.stringify({
      type: 'user',
      message: { content: [{ type: 'tool_result', content: 'x'.repeat(5000) }] },
    }));
    expect(extractProse(entry)).toBeNull();
  });

  it('drops entries that are neither user nor assistant', () => {
    expect(extractProse({ type: 'system', message: { content: 'hello' } })).toBeNull();
    expect(extractProse({ type: 'summary', summary: 'hello' })).toBeNull();
  });

  it('drops a message whose text is only whitespace', () => {
    expect(extractProse(JSON.parse(userLine('   \n  ')))).toBeNull();
  });

  it('tolerates a missing message object', () => {
    expect(extractProse({ type: 'user' })).toBeNull();
  });
});

describe('readProseFrom', () => {
  it('numbers lines from 1 and skips non-prose', async () => {
    const file = path.join(dir, 's.jsonl');
    await fs.writeFile(file, [
      JSON.stringify({ type: 'system', message: { content: 'boot' } }),
      userLine('first question'),
      assistantLine([{ type: 'text', text: 'first answer' }]),
    ].join('\n') + '\n');

    const result = await readProseFrom(file, 0, 0);

    expect(result.messages).toHaveLength(2);
    expect(result.messages[0]).toMatchObject({ line: 2, role: 'user', text: 'first question' });
    expect(result.messages[1]).toMatchObject({ line: 3, role: 'assistant', text: 'first answer' });
    expect(result.linesRead).toBe(3);
  });

  it('resumes from a byte offset and continues line numbering', async () => {
    const file = path.join(dir, 's.jsonl');
    const head = userLine('first') + '\n';
    await fs.writeFile(file, head);

    const first = await readProseFrom(file, 0, 0);
    expect(first.messages[0].line).toBe(1);
    expect(first.bytesRead).toBe(Buffer.byteLength(head));

    await fs.appendFile(file, userLine('second') + '\n');
    const second = await readProseFrom(file, first.bytesRead, first.linesRead);

    expect(second.messages).toHaveLength(1);
    expect(second.messages[0]).toMatchObject({ line: 2, text: 'second' });
  });

  it('stops before a trailing partial line so a half-written record is re-read next pass', async () => {
    const file = path.join(dir, 's.jsonl');
    const complete = userLine('done') + '\n';
    await fs.writeFile(file, complete + '{"type":"user","mess');

    const result = await readProseFrom(file, 0, 0);

    expect(result.messages).toHaveLength(1);
    expect(result.bytesRead).toBe(Buffer.byteLength(complete));
  });

  it('skips a corrupt line without aborting the file', async () => {
    const file = path.join(dir, 's.jsonl');
    await fs.writeFile(file, ['not json at all', userLine('still here')].join('\n') + '\n');

    const result = await readProseFrom(file, 0, 0);

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].line).toBe(2);
  });
});

describe('streamProseFrom', () => {
  it('carries a per-message watermark that resumes exactly after it', async () => {
    const file = path.join(dir, 's.jsonl');
    const first = userLine('one') + '\n';
    const second = userLine('two') + '\n';
    await fs.writeFile(file, first + second);

    const chunks = [];
    for await (const chunk of streamProseFrom(file, 0, 0)) chunks.push(chunk);

    expect(chunks[0].bytesConsumed).toBe(Buffer.byteLength(first));
    expect(chunks[0].linesConsumed).toBe(1);

    // Resuming from the first message's watermark must yield exactly the second.
    const resumed = [];
    for await (const chunk of streamProseFrom(file, chunks[0].bytesConsumed, chunks[0].linesConsumed)) {
      resumed.push(chunk.message.text);
    }
    expect(resumed).toEqual(['two']);
  });

  it('returns a final watermark covering trailing non-prose lines', async () => {
    const file = path.join(dir, 's.jsonl');
    const body = userLine('prose') + '\n' + JSON.stringify({ type: 'system', message: { content: 'x' } }) + '\n';
    await fs.writeFile(file, body);

    const iterator = streamProseFrom(file, 0, 0);
    let final;
    for (;;) {
      const next = await iterator.next();
      if (next.done) { final = next.value; break; }
    }

    // Past the system line, not stopped at the last prose message.
    expect(final.bytesConsumed).toBe(Buffer.byteLength(body));
    expect(final.linesConsumed).toBe(2);
  });

  it('does not load the file into memory', async () => {
    const file = path.join(dir, 'big.jsonl');
    // 20 MB of prose across 2,000 lines. A whole-file read would allocate all of it.
    await fs.writeFile(file, userLine('x'.repeat(10_000)).repeat(1) + '\n');
    for (let i = 0; i < 2_000; i++) await fs.appendFile(file, userLine('y'.repeat(10_000)) + '\n');

    const before = process.memoryUsage().heapUsed;
    let count = 0;
    for await (const _ of streamProseFrom(file, 0, 0)) count++;
    const growth = process.memoryUsage().heapUsed - before;

    expect(count).toBe(2_001);
    // Generous bound: the point is that growth is unrelated to the 20 MB file size.
    expect(growth).toBeLessThan(8 * 1024 * 1024);
  });

  it('decodes a multibyte character split across chunk boundaries', async () => {
    const file = path.join(dir, 'utf8.jsonl');
    // Long enough to span several 64 KB reads, with multibyte characters throughout.
    await fs.writeFile(file, userLine('π'.repeat(100_000)) + '\n');

    const chunks = [];
    for await (const chunk of streamProseFrom(file, 0, 0)) chunks.push(chunk);

    expect(chunks[0].message.text).toBe('π'.repeat(100_000));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/transcripts/parse.test.ts`
Expected: FAIL — `Cannot find module '../../src/transcripts/parse.js'`

- [ ] **Step 3: Write the implementation**

Create `src/transcripts/parse.ts`:

```typescript
import { createReadStream } from 'node:fs';

export type ProseMessage = {
  /** 1-indexed line within the `.jsonl`. This is the pointer stored instead of the text. */
  line: number;
  role: 'user' | 'assistant';
  text: string;
  timestamp: string | null;
};

type Extracted = Omit<ProseMessage, 'line'>;

/**
 * The prose in one transcript entry, or null if it holds none.
 *
 * `tool_use` and `tool_result` blocks are dropped rather than down-weighted. They are the bulk
 * of the archive by bytes -- prose is 2.7% of it -- and almost none of the value; a search for
 * "embedding crash" should hit the discussion, not forty log lines containing the word.
 */
export function extractProse(entry: unknown): Extracted | null {
  if (!entry || typeof entry !== 'object') return null;
  const record = entry as Record<string, unknown>;
  const role = record.type;
  if (role !== 'user' && role !== 'assistant') return null;

  const message = record.message;
  if (!message || typeof message !== 'object') return null;
  const content = (message as Record<string, unknown>).content;

  let text = '';
  if (typeof content === 'string') {
    text = content;
  } else if (Array.isArray(content)) {
    for (const block of content) {
      if (!block || typeof block !== 'object') continue;
      const typed = block as Record<string, unknown>;
      if (typed.type === 'text' && typeof typed.text === 'string') text += typed.text;
    }
  }

  text = text.trim();
  if (!text) return null;

  const timestamp = typeof record.timestamp === 'string' ? record.timestamp : null;
  return { role, text, timestamp };
}

export type ProseWatermark = { bytesConsumed: number; linesConsumed: number };

export type ProseChunk = {
  message: ProseMessage;
  /**
   * The watermark that becomes correct once this message is committed: the byte offset just
   * past its line, and the line count including it.
   *
   * Carried per message so the indexer can advance `bytes_indexed` in the *same* transaction
   * as the rows. Committing rows and the watermark separately is not crash-safe -- a crash
   * between them replays those lines into `UNIQUE(path, line)` on the next pass.
   */
  bytesConsumed: number;
  linesConsumed: number;
};

/**
 * Stream prose from `startByte`, continuing line numbering from `startLine`.
 *
 * Peak memory is one read chunk plus one partial line, whatever the file's size. Buffering the
 * remainder instead would scale with session length and make the caller's time budgets
 * unenforceable -- a multi-megabyte allocation happens before any budget can be checked.
 *
 * The returned watermark is the offset of the last *complete* line, never the file length. A
 * transcript being appended to while this runs has a partial final record; committing past it
 * would skip that message forever once the rest arrives.
 */
export async function* streamProseFrom(
  filePath: string,
  startByte: number,
  startLine: number,
): AsyncGenerator<ProseChunk, ProseWatermark> {
  let carry = Buffer.alloc(0);
  /** Absolute file offset of `carry[0]`. */
  let consumed = startByte;
  let line = startLine;

  let stream: import('node:fs').ReadStream;
  try {
    stream = createReadStream(filePath, { start: startByte });
  } catch {
    return { bytesConsumed: startByte, linesConsumed: startLine };
  }

  for await (const chunk of stream) {
    carry = carry.length === 0 ? Buffer.from(chunk) : Buffer.concat([carry, Buffer.from(chunk)]);
    let cursor = 0;

    for (;;) {
      const newline = carry.indexOf(0x0a, cursor);
      if (newline === -1) break;

      // Safe to decode here: 0x0a cannot occur inside a multi-byte UTF-8 sequence, so a
      // complete line is always a complete sequence of characters.
      const raw = carry.subarray(cursor, newline).toString('utf8');
      cursor = newline + 1;
      line++;

      const trimmed = raw.trim();
      if (trimmed) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(trimmed);
        } catch {
          // One unreadable line must not cost the rest of the file.
          parsed = undefined;
        }
        const prose = parsed === undefined ? null : extractProse(parsed);
        if (prose) {
          yield { message: { line, ...prose }, bytesConsumed: consumed + cursor, linesConsumed: line };
        }
      }
    }

    consumed += cursor;
    carry = carry.subarray(cursor);
  }

  // Past any trailing non-prose lines, which advanced the watermark without yielding.
  return { bytesConsumed: consumed, linesConsumed: line };
}

/** Drain `streamProseFrom` into an array. For tests and small files; the indexer streams. */
export async function readProseFrom(
  filePath: string,
  startByte: number,
  startLine: number,
): Promise<{ messages: ProseMessage[]; bytesRead: number; linesRead: number }> {
  const messages: ProseMessage[] = [];
  const iterator = streamProseFrom(filePath, startByte, startLine);
  for (;;) {
    const next = await iterator.next();
    if (next.done) {
      return { messages, bytesRead: next.value.bytesConsumed, linesRead: next.value.linesConsumed };
    }
    messages.push(next.value.message);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/transcripts/parse.test.ts`
Expected: PASS, 14 tests

The memory test is the one guarding the design. If it fails, something reintroduced a whole-file read.

- [ ] **Step 5: Commit**

```bash
git add src/transcripts/parse.ts tests/transcripts/parse.test.ts
git commit -m "feat(transcripts): stream prose with a per-message resumable watermark"
```

---

### Task 4: The transcripts database

Its own schema, its own connection, deliberately not routed through `src/store/database.ts`.

**Files:**
- Create: `src/transcripts/database.ts`
- Test: `tests/transcripts/database.test.ts`

**Interfaces:**
- Consumes: `resolveStorage(root).transcripts` (Task 1)
- Produces:
  - `openTranscriptDb(dbPath: string, options?: { readOnly?: boolean }): Promise<Client>`
  - `closeTranscriptDbs(): Promise<void>`
  - `TRANSCRIPT_SCHEMA_STATEMENTS: string[]`

- [ ] **Step 1: Write the failing test**

Create `tests/transcripts/database.test.ts`:

```typescript
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeTranscriptDbs, openTranscriptDb } from '../../src/transcripts/database.js';

let dir: string;
let dbPath: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'knowl-tdb-'));
  dbPath = path.join(dir, 'transcripts.db');
});

afterEach(async () => {
  await closeTranscriptDbs();
  await fs.rm(dir, { recursive: true, force: true });
});

describe('transcript database', () => {
  it('creates every table on first open', async () => {
    const client = await openTranscriptDb(dbPath);
    const names = (await client.execute(
      "SELECT name FROM sqlite_master WHERE type IN ('table','view') ORDER BY name",
    )).rows.map(r => String(r.name));

    expect(names).toContain('transcript_files');
    expect(names).toContain('transcript_messages');
    expect(names).toContain('transcript_fts');
    expect(names).toContain('transcript_vectors');
  });

  it('is idempotent across opens', async () => {
    await openTranscriptDb(dbPath);
    await closeTranscriptDbs();
    await expect(openTranscriptDb(dbPath)).resolves.toBeDefined();
  });

  it('supports contentless FTS5 deletion', async () => {
    const client = await openTranscriptDb(dbPath);
    await client.execute({ sql: 'INSERT INTO transcript_fts(rowid, body) VALUES (?, ?)', args: [1, 'hello world'] });
    await client.execute({ sql: 'DELETE FROM transcript_fts WHERE rowid = ?', args: [1] });

    const rows = (await client.execute("SELECT rowid FROM transcript_fts WHERE transcript_fts MATCH 'hello'")).rows;
    expect(rows).toHaveLength(0);
  });

  it('sets a busy timeout so a concurrent writer waits instead of failing', async () => {
    const client = await openTranscriptDb(dbPath);
    const value = (await client.execute('PRAGMA busy_timeout')).rows[0];
    expect(Number(Object.values(value)[0])).toBeGreaterThan(0);
  });

  it('refuses writes on a read-only open', async () => {
    await openTranscriptDb(dbPath);
    await closeTranscriptDbs();

    const peer = await openTranscriptDb(dbPath, { readOnly: true });
    await expect(
      peer.execute({ sql: 'INSERT INTO transcript_fts(rowid, body) VALUES (?, ?)', args: [9, 'x'] }),
    ).rejects.toThrow();
  });

  it('does not bootstrap a database it opens read-only', async () => {
    const missing = path.join(dir, 'absent.db');
    const peer = await openTranscriptDb(missing, { readOnly: true });
    const names = (await peer.execute("SELECT name FROM sqlite_master WHERE type='table'")).rows;
    expect(names).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/transcripts/database.test.ts`
Expected: FAIL — `Cannot find module '../../src/transcripts/database.js'`

- [ ] **Step 3: Write the implementation**

Create `src/transcripts/database.ts`:

```typescript
import path from 'node:path';
import { createClient, type Client } from '@libsql/client';

/**
 * Schema for `.knowl/transcripts.db`.
 *
 * Deliberately not part of `src/store/bootstrap.ts`. This file is optional, is deleted when the
 * feature is turned off, and must never be migrated by a knowledge-database open.
 */
export const TRANSCRIPT_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS transcript_files (
    path TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    parent_session_id TEXT,
    bytes_indexed INTEGER NOT NULL DEFAULT 0,
    lines_indexed INTEGER NOT NULL DEFAULT 0,
    size_at_index INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL
  );`,

  // No `body` column anywhere: a row is a pointer. The text stays in the .jsonl.
  `CREATE TABLE IF NOT EXISTS transcript_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    path TEXT NOT NULL,
    session_id TEXT NOT NULL,
    parent_session_id TEXT,
    line INTEGER NOT NULL,
    role TEXT NOT NULL,
    chars INTEGER NOT NULL,
    ts TEXT
  );`,

  `CREATE INDEX IF NOT EXISTS idx_transcript_messages_path ON transcript_messages(path);`,
  `CREATE INDEX IF NOT EXISTS idx_transcript_messages_session ON transcript_messages(session_id);`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_transcript_messages_line ON transcript_messages(path, line);`,

  // contentless_delete=1 needs SQLite >= 3.43; @libsql/client ships 3.45.1. Without it a
  // rebuilt file would leave its old terms matchable forever.
  `CREATE VIRTUAL TABLE IF NOT EXISTS transcript_fts USING fts5(
    body,
    content='',
    contentless_delete=1
  );`,

  `CREATE TABLE IF NOT EXISTS transcript_vectors (
    message_id INTEGER PRIMARY KEY,
    fingerprint TEXT NOT NULL,
    dims INTEGER NOT NULL,
    scale REAL NOT NULL,
    vec BLOB NOT NULL
  );`,

  `CREATE INDEX IF NOT EXISTS idx_transcript_vectors_fingerprint ON transcript_vectors(fingerprint);`,
];

const BASE_STATEMENTS = [
  // First, for the same reason as the knowledge database: journal_mode takes a lock, and a
  // connection's default busy_timeout is 0, so a concurrent writer would fail the open outright.
  'PRAGMA busy_timeout = 10000;',
  'PRAGMA journal_mode = WAL;',
];

const clients = new Map<string, Client>();

const keyFor = (dbPath: string, readOnly: boolean) => `${readOnly ? 'ro' : 'rw'}:${path.resolve(dbPath)}`;

/**
 * Open (and on a writable open, create) a transcripts database.
 *
 * A read-only open never bootstraps: it is used to search a linked workspace repo's index, and
 * reading a peer must not create or migrate anything it owns. `query_only` makes SQLite itself
 * enforce that rather than leaving it to convention.
 */
export async function openTranscriptDb(
  dbPath: string,
  options: { readOnly?: boolean } = {},
): Promise<Client> {
  const readOnly = options.readOnly === true;
  const key = keyFor(dbPath, readOnly);
  const existing = clients.get(key);
  if (existing) return existing;

  const client = createClient({ url: `file:${path.resolve(dbPath)}` });
  try {
    if (readOnly) {
      await client.execute('PRAGMA busy_timeout = 10000;');
      await client.execute('PRAGMA query_only = ON;');
    } else {
      for (const statement of BASE_STATEMENTS) await client.execute(statement);
      for (const statement of TRANSCRIPT_SCHEMA_STATEMENTS) await client.execute(statement);
    }
  } catch (error) {
    // An un-closed client on a failed open keeps whatever lock its partial bootstrap took, and
    // nothing else here ever closes it -- every later acquire would contend with this process.
    await client.close();
    throw error;
  }

  clients.set(key, client);
  return client;
}

export async function closeTranscriptDbs(): Promise<void> {
  const entries = [...clients.entries()];
  clients.clear();
  for (const [key, client] of entries) {
    if (key.startsWith('rw:')) {
      // Fold the WAL back in so the file is stable when this resolves -- Windows otherwise
      // holds the sidecars and a test's directory removal fails.
      await client.execute('PRAGMA wal_checkpoint(TRUNCATE)').catch(() => {});
    }
    client.close();
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/transcripts/database.test.ts`
Expected: PASS, 6 tests

If the read-only-open-of-a-missing-file test fails because libSQL creates an empty file, that is acceptable — assert instead that no tables exist, which the test already does.

- [ ] **Step 5: Commit**

```bash
git add src/transcripts/database.ts tests/transcripts/database.test.ts
git commit -m "feat(transcripts): add the separate transcripts database and schema"
```

---

### Task 4b: Surviving a second writer

Two writers on this database is the normal case, not an edge case: a `--budget` backfill can be running while a live session's per-turn hook fires. PR #11 needed all three of the mitigations below against a real 41k-message job — none were theoretical.

**`busy_timeout` alone is not enough.** `SQLITE_BUSY_SNAPSHOT` is returned when a connection is pinned to a stale read snapshot, and it is **permanent for that connection** — backing off waits for a condition only a reconnect clears. PR #11 measured a fresh process writing the same database in **71 ms** while a long-lived job had been failing on it for **fourteen minutes**.

**Files:**
- Modify: `src/transcripts/database.ts`
- Test: `tests/transcripts/concurrency.test.ts`

**Interfaces:**
- Consumes: `openTranscriptDb` (Task 4)
- Produces:
  - `closeTranscriptDb(dbPath: string): Promise<void>` — evict one cached client
  - `withWriteRetry<T>(dbPath: string, run: (client: Client) => Promise<T>, options?: { attempts?: number }): Promise<T>`

- [ ] **Step 1: Write the failing test**

Create `tests/transcripts/concurrency.test.ts`:

```typescript
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createClient } from '@libsql/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeTranscriptDbs, openTranscriptDb, withWriteRetry } from '../../src/transcripts/database.js';

let dir: string;
let dbPath: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'knowl-conc-'));
  dbPath = path.join(dir, 'transcripts.db');
});

afterEach(async () => {
  await closeTranscriptDbs();
  await fs.rm(dir, { recursive: true, force: true });
});

describe('withWriteRetry', () => {
  it('returns the callback result when nothing goes wrong', async () => {
    const value = await withWriteRetry(dbPath, async client => {
      await client.execute({ sql: 'INSERT INTO transcript_fts(rowid, body) VALUES (?, ?)', args: [1, 'x'] });
      return 'done';
    });
    expect(value).toBe('done');
  });

  it('reopens the connection on SQLITE_BUSY_SNAPSHOT and retries', async () => {
    let attempts = 0;
    const clients: unknown[] = [];

    const value = await withWriteRetry(dbPath, async client => {
      attempts++;
      clients.push(client);
      if (attempts === 1) {
        const error = new Error('database is locked (SQLITE_BUSY_SNAPSHOT)');
        (error as { code?: string }).code = 'SQLITE_BUSY_SNAPSHOT';
        throw error;
      }
      return 'recovered';
    });

    expect(value).toBe('recovered');
    expect(attempts).toBe(2);
    // A retry that reuses the pinned connection would fail forever; it must be a new one.
    expect(clients[0]).not.toBe(clients[1]);
  });

  it('retries a plain SQLITE_BUSY without reopening', async () => {
    let attempts = 0;
    await withWriteRetry(dbPath, async () => {
      attempts++;
      if (attempts < 3) {
        const error = new Error('database is locked');
        (error as { code?: string }).code = 'SQLITE_BUSY';
        throw error;
      }
    });
    expect(attempts).toBe(3);
  });

  it('gives up after the attempt limit rather than looping forever', async () => {
    await expect(
      withWriteRetry(dbPath, async () => {
        const error = new Error('database is locked');
        (error as { code?: string }).code = 'SQLITE_BUSY';
        throw error;
      }, { attempts: 3 }),
    ).rejects.toThrow(/locked/);
  });

  it('does not retry an error that is not a lock', async () => {
    let attempts = 0;
    await expect(
      withWriteRetry(dbPath, async () => {
        attempts++;
        throw new Error('UNIQUE constraint failed: transcript_messages.line');
      }),
    ).rejects.toThrow(/UNIQUE/);
    expect(attempts).toBe(1);
  });
});

describe('two concurrent writers', () => {
  // `openTranscriptDb` caches by path, so two "writers" that both go through it share ONE
  // connection and contend for nothing. A real test has to bypass the cache -- otherwise it
  // passes against a database layer with no concurrency handling whatsoever.
  it('both complete without a lost update or a uniqueness collision', async () => {
    await openTranscriptDb(dbPath); // bootstrap the schema once
    await closeTranscriptDbs();

    const independent = () => {
      const client = createClient({ url: `file:${dbPath}` });
      return client;
    };

    const writer = async (base: number) => {
      const client = independent();
      try {
        await client.execute('PRAGMA busy_timeout = 10000;');
        for (let i = 0; i < 50; i++) {
          await client.execute('BEGIN IMMEDIATE');
          await client.execute({
            sql: 'INSERT INTO transcript_fts(rowid, body) VALUES (?, ?)',
            args: [base + i, `row ${base + i}`],
          });
          await client.execute('COMMIT');
        }
      } finally {
        client.close();
      }
    };

    await Promise.all([writer(1_000), writer(2_000)]);

    const client = await openTranscriptDb(dbPath);
    const n = (await client.execute("SELECT rowid FROM transcript_fts WHERE transcript_fts MATCH 'row'")).rows.length;
    expect(n).toBe(100);
  });

  it('a reconnect inside withWriteRetry does not leave an earlier handle in use', async () => {
    // The bug this guards: a caller that captured a client before the retry kept using it after
    // withWriteRetry closed and replaced it. Nothing may hold a handle across the boundary.
    const first = await openTranscriptDb(dbPath);

    let attempts = 0;
    await withWriteRetry(dbPath, async () => {
      attempts++;
      if (attempts === 1) {
        const error = new Error('SQLITE_BUSY_SNAPSHOT');
        (error as { code?: string }).code = 'SQLITE_BUSY_SNAPSHOT';
        throw error;
      }
    });

    const second = await openTranscriptDb(dbPath);
    expect(second).not.toBe(first);
    // And the replacement is usable, which a closed handle would not be.
    await expect(second.execute('SELECT 1')).resolves.toBeDefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/transcripts/concurrency.test.ts`
Expected: FAIL — `withWriteRetry` is not exported.

- [ ] **Step 3: Write the implementation**

Append to `src/transcripts/database.ts`:

```typescript
/** Drop one cached client so the next acquire reconnects. */
export async function closeTranscriptDb(dbPath: string): Promise<void> {
  for (const readOnly of [false, true]) {
    const key = keyFor(dbPath, readOnly);
    const client = clients.get(key);
    if (!client) continue;
    clients.delete(key);
    if (!readOnly) await client.execute('PRAGMA wal_checkpoint(TRUNCATE)').catch(() => {});
    client.close();
  }
}

function errorCode(error: unknown): string {
  const raw = error as { code?: unknown; message?: unknown };
  const code = typeof raw?.code === 'string' ? raw.code : '';
  const message = typeof raw?.message === 'string' ? raw.message : '';
  return `${code} ${message}`.toUpperCase();
}

const isSnapshotStall = (error: unknown) => errorCode(error).includes('BUSY_SNAPSHOT');
const isBusy = (error: unknown) => {
  const text = errorCode(error);
  return text.includes('SQLITE_BUSY') || text.includes('DATABASE IS LOCKED');
};

/**
 * Run a write against the transcripts database, surviving a concurrent writer.
 *
 * Retry granularity is one transaction, which is what makes this safe: SQLite guarantees a
 * failed `COMMIT` rolled back, so re-running the callback cannot double-write.
 *
 * `SQLITE_BUSY_SNAPSHOT` is handled differently from `SQLITE_BUSY` on purpose. It is permanent
 * for a connection pinned to a stale read snapshot -- no amount of waiting clears it, only a
 * reconnect does. PR #11 measured a fresh process writing in 71 ms while a long-lived job had
 * been failing on the same database for fourteen minutes.
 */
export async function withWriteRetry<T>(
  dbPath: string,
  run: (client: Client) => Promise<T>,
  options: { attempts?: number } = {},
): Promise<T> {
  const attempts = options.attempts ?? 5;
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    const client = await openTranscriptDb(dbPath);
    try {
      return await run(client);
    } catch (error) {
      lastError = error;
      if (isSnapshotStall(error)) {
        await closeTranscriptDb(dbPath);
      } else if (isBusy(error)) {
        // busy_timeout already waited; a short extra pause lets the other writer's
        // transaction land rather than spinning against it.
        await new Promise(resolve => setTimeout(resolve, 25 * attempt));
      } else {
        throw error; // Not a lock. A constraint violation is a bug, not something to retry.
      }
    }
  }

  throw lastError;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/transcripts/concurrency.test.ts`
Expected: PASS, 7 tests

The two-writers test opens raw `createClient` connections on purpose. Routed through `openTranscriptDb` they would share one cached client, contend for nothing, and pass against a database layer with no concurrency handling at all.

- [ ] **Step 5: Commit**

```bash
git add src/transcripts/database.ts tests/transcripts/concurrency.test.ts
git commit -m "feat(transcripts): reconnect on BUSY_SNAPSHOT and retry contended writes"
```

---

### Task 5: Incremental index pass

Walks discovered files, indexes new prose from each watermark, handles rewrites and deletions, and respects a time budget.

**The one rule this task exists to enforce:** a batch of message rows and the watermark those rows justify are written in **one transaction**. Writing rows and then updating `bytes_indexed` separately leaves a window where a crash produces durable rows behind a stale watermark — the next pass re-reads those lines and dies on `UNIQUE(path, line)`, leaving an index that cannot repair itself. The budget is also checked only *between* committed batches, so stopping is always at a consistent point.

**Files:**
- Create: `src/transcripts/index-pass.ts`
- Test: `tests/transcripts/index-pass.test.ts`

**Interfaces:**
- Consumes: `discoverTranscriptFiles` (Task 2), `streamProseFrom` / `ProseChunk` (Task 3), `openTranscriptDb` (Task 4)
- Produces:
  - `type IndexPassResult = { indexed: number; rebuilt: number; removed: number; filesTouched: number; complete: boolean }`
  - `runIndexPass(input: { projectRoot: string; dbPath: string; projectsDir?: string; deadline?: number }): Promise<IndexPassResult>`

- [ ] **Step 1: Write the failing test**

Create `tests/transcripts/index-pass.test.ts`:

```typescript
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeTranscriptDbs, openTranscriptDb } from '../../src/transcripts/database.js';
import { runIndexPass } from '../../src/transcripts/index-pass.js';

let dir: string;
let projectsDir: string;
let dbPath: string;
const PROJECT_ROOT = '/repo/knowl';

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'knowl-pass-'));
  projectsDir = path.join(dir, 'projects');
  dbPath = path.join(dir, 'transcripts.db');
  await fs.mkdir(path.join(projectsDir, '-repo-knowl'), { recursive: true });
});

afterEach(async () => {
  await closeTranscriptDbs();
  await fs.rm(dir, { recursive: true, force: true });
});

const line = (role: 'user' | 'assistant', text: string) =>
  JSON.stringify({ type: role, timestamp: '2026-08-03T10:00:00Z', message: { content: text } }) + '\n';

const sessionFile = (name: string) => path.join(projectsDir, '-repo-knowl', `${name}.jsonl`);

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
    const nested = path.join(projectsDir, '-repo-knowl', '78aed75d-4bed-4d1a-a93e-f3fd3eab4fb4');
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
    // 500 messages: comfortably more than one WRITE_BATCH of 200.
    await fs.writeFile(
      sessionFile('a'),
      Array.from({ length: 500 }, (_, i) => line('user', `message ${i}`)).join(''),
    );

    // Simulate a crash by aborting the pass partway: the deadline fires between batches.
    const partial = await runIndexPass({
      projectRoot: PROJECT_ROOT, dbPath, projectsDir, deadline: Date.now() + 1,
    });
    expect(partial.complete).toBe(false);

    const client = await openTranscriptDb(dbPath);
    const committed = Number((await client.execute('SELECT COUNT(*) AS n FROM transcript_messages')).rows[0].n);
    const watermark = (await client.execute('SELECT lines_indexed FROM transcript_files')).rows[0];

    // Whatever was committed, the watermark agrees with it. This is the invariant.
    expect(Number(watermark.lines_indexed)).toBe(committed);

    // And a full pass finishes rather than colliding on the unique index.
    const finished = await pass();
    expect(finished.complete).toBe(true);
    expect(await countMessages()).toBe(500);
  });

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
  });

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/transcripts/index-pass.test.ts`
Expected: FAIL — `Cannot find module '../../src/transcripts/index-pass.js'`

- [ ] **Step 3: Write the implementation**

Create `src/transcripts/index-pass.ts`:

```typescript
import fs from 'node:fs/promises';
import type { Client } from '@libsql/client';
import { openTranscriptDb, withWriteRetry } from './database.js';
import { streamProseFrom, type ProseChunk } from './parse.js';
import { discoverTranscriptFiles, type TranscriptFile } from './paths.js';

export type IndexPassResult = {
  indexed: number;
  rebuilt: number;
  removed: number;
  filesTouched: number;
  /** False when a deadline cut the pass short. The watermarks are still valid; just resume. */
  complete: boolean;
};

/** Rows per write transaction. Small on purpose: a long transaction starves a live session. */
const WRITE_BATCH = 200;

type FileState = { bytesIndexed: number; linesIndexed: number; sizeAtIndex: number };

async function readFileState(dbPath: string, filePath: string): Promise<FileState | null> {
  const rows = await withWriteRetry(dbPath, async client => (await client.execute({
    sql: 'SELECT bytes_indexed, lines_indexed, size_at_index FROM transcript_files WHERE path = ?',
    args: [filePath],
  })).rows);
  if (rows.length === 0) return null;
  return {
    bytesIndexed: Number(rows[0].bytes_indexed),
    linesIndexed: Number(rows[0].lines_indexed),
    sizeAtIndex: Number(rows[0].size_at_index),
  };
}

/**
 * Delete a file's rows from every table.
 *
 * The FTS delete is driven off the message ids rather than a join, because a contentless FTS5
 * table cannot be queried by anything but rowid and MATCH.
 */
async function dropFileRows(dbPath: string, filePath: string): Promise<void> {
  const ids = await withWriteRetry(dbPath, async client => (await client.execute({
    sql: 'SELECT id FROM transcript_messages WHERE path = ?',
    args: [filePath],
  })).rows.map(row => Number(row.id)));

  for (let start = 0; start < ids.length; start += WRITE_BATCH) {
    const slice = ids.slice(start, start + WRITE_BATCH);
    await withWriteRetry(dbPath, async client => {
      await client.execute('BEGIN IMMEDIATE');
      try {
        for (const id of slice) {
          await client.execute({ sql: 'DELETE FROM transcript_fts WHERE rowid = ?', args: [id] });
          await client.execute({ sql: 'DELETE FROM transcript_vectors WHERE message_id = ?', args: [id] });
        }
        await client.execute('COMMIT');
      } catch (error) {
        await client.execute('ROLLBACK').catch(() => {});
        throw error;
      }
    });
  }

  await withWriteRetry(dbPath, client =>
    client.execute({ sql: 'DELETE FROM transcript_messages WHERE path = ?', args: [filePath] }));
}

/**
 * Write one batch of messages and the watermark they justify, in a single transaction.
 *
 * The atomicity is the entire point. Committing rows and then updating `bytes_indexed`
 * separately leaves a window where a crash -- or a killed CLI, or a machine sleeping -- has
 * durable rows behind a stale watermark. The next pass re-reads those lines and dies on
 * `UNIQUE(path, line)`, so the index is not merely stale but unrepairable without manual
 * intervention. "Resumable" has to mean both facts move together or neither does.
 */
async function commitBatch(
  dbPath: string,
  file: TranscriptFile,
  size: number,
  batch: ProseChunk[],
): Promise<number> {
  return withWriteRetry(dbPath, async client => commitBatchOn(client, file, size, batch));
}

async function commitBatchOn(
  client: Client,
  file: TranscriptFile,
  size: number,
  batch: ProseChunk[],
): Promise<number> {
  const watermark = batch[batch.length - 1];

  await client.execute('BEGIN IMMEDIATE');
  try {
    // Re-read the watermark *inside* the transaction. The caller read it before streaming, and
    // a second writer -- a hook firing during a backfill -- may have advanced it since. Without
    // this, both parse the same lines and the loser dies on UNIQUE(path, line). BEGIN IMMEDIATE
    // serializes the writes; only this re-read makes them agree on what is left to do.
    const current = (await client.execute({
      sql: 'SELECT lines_indexed FROM transcript_files WHERE path = ?',
      args: [file.path],
    })).rows[0];
    const already = current ? Number(current.lines_indexed) : 0;

    if (already >= watermark.linesConsumed) {
      // Another writer covered this batch entirely.
      await client.execute('COMMIT');
      return 0;
    }

    const fresh = batch.filter(chunk => chunk.message.line > already);

    for (const { message } of fresh) {
      const inserted = await client.execute({
        sql: `INSERT INTO transcript_messages (path, session_id, parent_session_id, line, role, chars, ts)
              VALUES (?, ?, ?, ?, ?, ?, ?)`,
        args: [file.path, file.sessionId, file.parentSessionId, message.line, message.role, message.text.length, message.timestamp],
      });
      // The FTS rowid is the message id, which is how a hit maps back to a pointer.
      await client.execute({
        sql: 'INSERT INTO transcript_fts(rowid, body) VALUES (?, ?)',
        args: [Number(inserted.lastInsertRowid), message.text],
      });
    }

    await client.execute({
      sql: `INSERT INTO transcript_files (path, session_id, parent_session_id, bytes_indexed, lines_indexed, size_at_index, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(path) DO UPDATE SET
              bytes_indexed = excluded.bytes_indexed,
              lines_indexed = excluded.lines_indexed,
              size_at_index = excluded.size_at_index,
              updated_at = excluded.updated_at`,
      args: [
        file.path, file.sessionId, file.parentSessionId,
        watermark.bytesConsumed, watermark.linesConsumed, size, new Date().toISOString(),
      ],
    });

    await client.execute('COMMIT');
    return fresh.length;
  } catch (error) {
    await client.execute('ROLLBACK').catch(() => {});
    throw error;
  }
}

async function indexOneFile(
  dbPath: string,
  file: TranscriptFile,
  size: number,
  state: FileState | null,
  deadline?: number,
): Promise<{ indexed: number; rebuilt: boolean; complete: boolean }> {
  // A file that shrank was rewritten, not appended to. Its old line numbers no longer point
  // anywhere, so the only safe move is to rebuild it.
  const rewritten = state !== null && size < state.bytesIndexed;
  if (rewritten) await dropFileRows(dbPath, file.path);

  const from = rewritten || !state
    ? { bytes: 0, lines: 0 }
    : { bytes: state.bytesIndexed, lines: state.linesIndexed };

  let indexed = 0;
  let batch: ProseChunk[] = [];
  const iterator = streamProseFrom(file.path, from.bytes, from.lines);

  for (;;) {
    const next = await iterator.next();

    if (next.done) {
      if (batch.length > 0) {
        indexed += await commitBatch(dbPath, file, size, batch);
      }
      // Trailing non-prose lines advanced the stream without yielding, so the final watermark
      // can be past the last committed batch. Recording it stops the next pass re-reading them.
      // Guarded against going backwards: a concurrent writer may already be further ahead.
      await withWriteRetry(dbPath, client => client.execute({
        sql: `INSERT INTO transcript_files (path, session_id, parent_session_id, bytes_indexed, lines_indexed, size_at_index, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(path) DO UPDATE SET
                bytes_indexed = MAX(transcript_files.bytes_indexed, excluded.bytes_indexed),
                lines_indexed = MAX(transcript_files.lines_indexed, excluded.lines_indexed),
                size_at_index = excluded.size_at_index,
                updated_at = excluded.updated_at`,
        args: [
          file.path, file.sessionId, file.parentSessionId,
          next.value.bytesConsumed, next.value.linesConsumed, size, new Date().toISOString(),
        ],
      }));
      return { indexed, rebuilt: rewritten, complete: true };
    }

    batch.push(next.value);
    if (batch.length < WRITE_BATCH) continue;

    indexed += await commitBatch(dbPath, file, size, batch);
    batch = [];

    // Checked between committed batches, so stopping here is always at a consistent point.
    if (deadline !== undefined && Date.now() >= deadline) {
      return { indexed, rebuilt: rewritten, complete: false };
    }
  }
}

/**
 * Bring the index up to date with what is on disk.
 *
 * Every unit of work is idempotent against the stored watermark, so an interrupted pass leaves
 * nothing to repair -- "how far did we get" is already a column.
 */
export async function runIndexPass(input: {
  projectRoot: string;
  dbPath: string;
  projectsDir?: string;
  /** `Date.now()` value after which the pass stops between files. */
  deadline?: number;
}): Promise<IndexPassResult> {
  // Deliberately no long-lived `client` local. `withWriteRetry` closes and reopens the cached
  // connection when it hits SQLITE_BUSY_SNAPSHOT, so any handle captured up here would be a
  // closed one for the rest of the pass. Every operation re-acquires through the helper.
  await openTranscriptDb(input.dbPath);
  const files = await discoverTranscriptFiles(input.projectRoot, { projectsDir: input.projectsDir });
  const onDisk = new Set(files.map(file => file.path));

  const result: IndexPassResult = { indexed: 0, rebuilt: 0, removed: 0, filesTouched: 0, complete: true };

  // Deleted transcripts first: their pointers are dead, and a search that returns them wastes a
  // file read to discover it. Cheap when nothing vanished, which is the usual case.
  const known = await withWriteRetry(input.dbPath, async client =>
    (await client.execute('SELECT path FROM transcript_files')).rows.map(row => String(row.path)));

  for (const knownPath of known) {
    if (onDisk.has(knownPath)) continue;
    await dropFileRows(input.dbPath, knownPath);
    await withWriteRetry(input.dbPath, client =>
      client.execute({ sql: 'DELETE FROM transcript_files WHERE path = ?', args: [knownPath] }));
    result.removed++;
  }

  for (const file of files) {
    if (input.deadline !== undefined && Date.now() >= input.deadline) {
      result.complete = false;
      break;
    }

    let size: number;
    try {
      size = (await fs.stat(file.path)).size;
    } catch {
      continue; // Vanished between discovery and now; the next pass cleans it up.
    }

    const state = await readFileState(input.dbPath, file.path);
    if (state && size === state.sizeAtIndex && size === state.bytesIndexed) continue;

    const { indexed, rebuilt, complete } = await indexOneFile(input.dbPath, file, size, state, input.deadline);
    result.indexed += indexed;
    result.filesTouched++;
    if (rebuilt) result.rebuilt++;
    // Mid-file stop: the watermark is committed, so the next pass resumes inside this file.
    if (!complete) {
      result.complete = false;
      break;
    }
  }

  return result;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/transcripts/index-pass.test.ts`
Expected: PASS, 12 tests

Three tests carry this task's shape. The two crash tests fail the moment `commitBatchOn` is split back into "write rows, then write watermark". The concurrent-passes test fails if the watermark re-read is hoisted out of the transaction.

- [ ] **Step 5: Commit**

```bash
git add src/transcripts/index-pass.ts tests/transcripts/index-pass.test.ts
git commit -m "feat(transcripts): commit each batch and its watermark atomically"
```

---

### Task 6: Reading messages back from disk

The counterpart to storing pointers. A hit is `(path, line)`; this turns it into text.

**The batch API is the important one.** Every caller that needs more than one line from a file must use `readMessagesAt` with all of them at once. Reading per message means re-reading a multi-megabyte transcript once per message — for a 3,717-message backfill that is roughly **11 GB of file I/O**, and it makes both the hook budget and `--budget` meaningless. Search does this too: five hits in one session is five whole-file reads if each is fetched alone.

**Files:**
- Create: `src/transcripts/read.ts`
- Test: `tests/transcripts/read.test.ts`

**Interfaces:**
- Consumes: `streamProseFrom` (Task 3)
- Produces:
  - `type TranscriptExcerpt = { line: number; role: 'user' | 'assistant'; text: string; timestamp: string | null }`
  - `readMessagesAt(filePath: string, lines: number[]): Promise<Map<number, TranscriptExcerpt>>`
  - `readMessageAt(filePath: string, line: number): Promise<TranscriptExcerpt | null>`
  - `readWithContext(filePath: string, line: number, context: number): Promise<TranscriptExcerpt[]>` — `context` counts **prose turns**, not physical lines

**`context` means turns.** A line window filtered for prose afterwards is not the same thing: in a real transcript nearly every prose message is separated from the next by tool-result lines, so `context: 2` would routinely return the target alone. The caller asked for surrounding conversation.

- [ ] **Step 1: Write the failing test**

Create `tests/transcripts/read.test.ts`:

```typescript
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readMessageAt, readMessagesAt, readWithContext } from '../../src/transcripts/read.js';

let dir: string;
let file: string;

const line = (role: 'user' | 'assistant', text: string) =>
  JSON.stringify({ type: role, timestamp: '2026-08-03T10:00:00Z', message: { content: text } });

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'knowl-read-'));
  file = path.join(dir, 's.jsonl');
  await fs.writeFile(file, [
    line('user', 'one'),
    line('assistant', 'two'),
    line('user', 'three'),
    line('assistant', 'four'),
    line('user', 'five'),
  ].join('\n') + '\n');
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('readMessagesAt', () => {
  it('returns every requested line in one pass', async () => {
    const found = await readMessagesAt(file, [1, 3, 5]);
    expect([...found.keys()].sort((a, b) => a - b)).toEqual([1, 3, 5]);
    expect(found.get(3)?.text).toBe('three');
  });

  it('omits lines that hold no prose instead of returning null entries', async () => {
    const found = await readMessagesAt(file, [3, 99]);
    expect(found.has(99)).toBe(false);
    expect(found.size).toBe(1);
  });

  it('returns an empty map for a missing file', async () => {
    expect((await readMessagesAt(path.join(dir, 'gone.jsonl'), [1])).size).toBe(0);
  });

  it('returns an empty map when asked for nothing', async () => {
    expect((await readMessagesAt(file, [])).size).toBe(0);
  });

  it('reads the file once regardless of how many lines are requested', async () => {
    const spy = vi.spyOn(fsSync, 'createReadStream');
    await readMessagesAt(file, [1, 2, 3, 4, 5]);
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });
});

describe('readMessageAt', () => {
  it('returns the message at a 1-indexed line', async () => {
    expect(await readMessageAt(file, 3)).toMatchObject({ line: 3, role: 'user', text: 'three' });
  });

  it('returns null past the end of the file', async () => {
    expect(await readMessageAt(file, 99)).toBeNull();
  });

  it('returns null for a file that no longer exists', async () => {
    expect(await readMessageAt(path.join(dir, 'gone.jsonl'), 1)).toBeNull();
  });
});

describe('readWithContext', () => {
  it('returns the target plus surrounding turns', async () => {
    const excerpts = await readWithContext(file, 3, 1);
    expect(excerpts.map(e => e.text)).toEqual(['two', 'three', 'four']);
  });

  // The regression test for the semantics blocker: a line window filtered afterwards returns
  // the target alone here, because every prose turn is separated by tool-result lines -- which
  // is what a real transcript looks like.
  it('counts turns, not physical lines, when tool output sits between them', async () => {
    const noisy = path.join(dir, 'noisy.jsonl');
    const toolLine = JSON.stringify({
      type: 'user',
      message: { content: [{ type: 'tool_result', content: 'x'.repeat(200) }] },
    });
    await fs.writeFile(noisy, [
      line('user', 'first'), toolLine, toolLine,
      line('assistant', 'second'), toolLine, toolLine,
      line('user', 'third'), toolLine, toolLine,
      line('assistant', 'fourth'),
    ].join('\n') + '\n');

    // "second" is on physical line 4; one turn either side is "first" and "third".
    const excerpts = await readWithContext(noisy, 4, 1);
    expect(excerpts.map(e => e.text)).toEqual(['first', 'second', 'third']);
  });

  it('returns nothing when the requested line holds no prose', async () => {
    const noisy = path.join(dir, 'noprose.jsonl');
    await fs.writeFile(noisy, [
      line('user', 'first'),
      JSON.stringify({ type: 'system', message: { content: 'boot' } }),
      line('user', 'second'),
    ].join('\n') + '\n');

    expect(await readWithContext(noisy, 2, 2)).toEqual([]);
  });

  it('clamps at the start of the file', async () => {
    const excerpts = await readWithContext(file, 1, 2);
    expect(excerpts.map(e => e.text)).toEqual(['one', 'two', 'three']);
  });

  it('clamps at the end of the file', async () => {
    const excerpts = await readWithContext(file, 5, 2);
    expect(excerpts.map(e => e.text)).toEqual(['three', 'four', 'five']);
  });

  it('returns just the target when context is zero', async () => {
    const excerpts = await readWithContext(file, 2, 0);
    expect(excerpts.map(e => e.text)).toEqual(['two']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/transcripts/read.test.ts`
Expected: FAIL — `Cannot find module '../../src/transcripts/read.js'`

- [ ] **Step 3: Write the implementation**

Create `src/transcripts/read.ts`:

```typescript
import { streamProseFrom } from './parse.js';

export type TranscriptExcerpt = {
  line: number;
  role: 'user' | 'assistant';
  text: string;
  timestamp: string | null;
};

/**
 * Prose at the given 1-indexed lines, in a single streaming pass.
 *
 * The batch shape is the whole point. Fetching one line at a time re-reads the transcript per
 * message: a 3,717-message backfill against ~3 MB files is roughly 11 GB of I/O, and it makes
 * every time budget in the system unenforceable. Callers with more than one line to fetch --
 * search rendering its hits, the embedder filling a batch -- must group by file and come here
 * once.
 *
 * Lines holding no prose are simply absent from the map rather than present and null, so
 * `size` is a truthful count of what was found.
 */
export async function readMessagesAt(
  filePath: string,
  lines: number[],
): Promise<Map<number, TranscriptExcerpt>> {
  const found = new Map<number, TranscriptExcerpt>();
  if (lines.length === 0) return found;

  const wanted = new Set(lines);
  const last = Math.max(...lines);

  try {
    for await (const chunk of streamProseFrom(filePath, 0, 0)) {
      if (wanted.has(chunk.message.line)) {
        const { line, role, text, timestamp } = chunk.message;
        found.set(line, { line, role, text, timestamp });
        if (found.size === wanted.size) break;
      }
      // Nothing further can match; stop rather than stream the rest of the file.
      if (chunk.message.line >= last) break;
    }
  } catch {
    // The transcript was deleted since it was indexed. A dead pointer is a miss, not an error;
    // the next index pass drops its rows.
    return found;
  }

  return found;
}

export async function readMessageAt(filePath: string, line: number): Promise<TranscriptExcerpt | null> {
  return (await readMessagesAt(filePath, [line])).get(line) ?? null;
}

/**
 * The target message plus `context` prose turns on each side.
 *
 * Counts *turns*, not physical lines. Taking a line window and filtering it afterwards is what
 * an earlier draft did, and in a real transcript almost every prose message is separated from
 * the next by tool-result lines -- so `context: 2` routinely returned the target alone. The
 * caller asked for surrounding conversation, not for a slice of the file.
 *
 * One streaming pass: prose before the target is kept in a ring of at most `context` entries,
 * and the walk stops once `context` messages after it have been collected.
 */
export async function readWithContext(
  filePath: string,
  line: number,
  context: number,
): Promise<TranscriptExcerpt[]> {
  const before: TranscriptExcerpt[] = [];
  const after: TranscriptExcerpt[] = [];
  let target: TranscriptExcerpt | null = null;

  try {
    for await (const chunk of streamProseFrom(filePath, 0, 0)) {
      const { line: at, role, text, timestamp } = chunk.message;
      const excerpt: TranscriptExcerpt = { line: at, role, text, timestamp };

      if (at < line) {
        if (context > 0) {
          before.push(excerpt);
          if (before.length > context) before.shift();
        }
        continue;
      }

      if (at === line) { target = excerpt; continue; }

      // Past the target. Only reached once it has been seen, or when the requested line holds
      // no prose -- in which case there is nothing to anchor on and the walk should stop.
      if (!target) break;
      after.push(excerpt);
      if (after.length >= context) break;
    }
  } catch {
    return [];
  }

  return target ? [...before, target, ...after] : [];
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/transcripts/read.test.ts`
Expected: PASS, 15 tests

The turn-counting test is the one that pins the semantics. A line-window implementation returns `['second']` alone and fails it.

- [ ] **Step 5: Commit**

```bash
git add src/transcripts/read.ts tests/transcripts/read.test.ts
git commit -m "feat(transcripts): batch read message bodies in one streaming pass"
```

---

### Task 7: Lexical search

BM25 with role weighting. Ships as a complete, useful feature on its own; Task 9 adds the semantic half on top.

**Files:**
- Create: `src/transcripts/search.ts`
- Test: `tests/transcripts/search-lexical.test.ts`

**Interfaces:**
- Consumes: `openTranscriptDb` (Task 4), `readMessageAt` (Task 6)
- Produces:
  - `toMatchQuery(query: string): string | null`
  - `type TranscriptHit = { messageId: number; path: string; sessionId: string; parentSessionId: string | null; line: number; role: 'user' | 'assistant'; score: number; text?: string }`
  - `lexicalRank(client: Client, query: string, limit: number, sessionId?: string): Promise<TranscriptHit[]>`
  - `ROLE_WEIGHTS: Record<'user' | 'assistant', number>`

- [ ] **Step 1: Write the failing test**

Create `tests/transcripts/search-lexical.test.ts`:

```typescript
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeTranscriptDbs, openTranscriptDb } from '../../src/transcripts/database.js';
import { runIndexPass } from '../../src/transcripts/index-pass.js';
import { lexicalRank, toMatchQuery } from '../../src/transcripts/search.js';

let dir: string;
let projectsDir: string;
let dbPath: string;
const PROJECT_ROOT = '/repo/knowl';

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'knowl-lex-'));
  projectsDir = path.join(dir, 'projects');
  dbPath = path.join(dir, 'transcripts.db');
  await fs.mkdir(path.join(projectsDir, '-repo-knowl'), { recursive: true });
});

afterEach(async () => {
  await closeTranscriptDbs();
  await fs.rm(dir, { recursive: true, force: true });
});

const line = (role: 'user' | 'assistant', text: string) =>
  JSON.stringify({ type: role, timestamp: '2026-08-03T10:00:00Z', message: { content: text } }) + '\n';

async function seed(session: string, lines: string) {
  await fs.writeFile(path.join(projectsDir, '-repo-knowl', `${session}.jsonl`), lines);
}

async function indexed() {
  await runIndexPass({ projectRoot: PROJECT_ROOT, dbPath, projectsDir });
  return openTranscriptDb(dbPath);
}

describe('toMatchQuery', () => {
  it('quotes each token so punctuation cannot become FTS5 syntax', () => {
    expect(toMatchQuery('embedding crash')).toBe('"embedding" OR "crash"');
  });

  it('strips characters FTS5 would treat as operators', () => {
    expect(toMatchQuery('OOM: why "now"?')).toBe('"OOM" OR "why" OR "now"');
  });

  it('returns null when nothing searchable remains', () => {
    expect(toMatchQuery('   ***   ')).toBeNull();
  });
});

describe('lexicalRank', () => {
  it('finds a message by its words', async () => {
    await seed('a', line('user', 'the reindex ran out of memory'));
    const client = await indexed();

    const hits = await lexicalRank(client, 'reindex memory', 10);

    expect(hits).toHaveLength(1);
    expect(hits[0].line).toBe(1);
    expect(hits[0].sessionId).toBe('a');
  });

  it('ranks a user message above an assistant message of equal relevance', async () => {
    await seed('a', line('assistant', 'quantization tradeoffs matter') + line('user', 'quantization tradeoffs matter'));
    const client = await indexed();

    const hits = await lexicalRank(client, 'quantization tradeoffs', 10);

    expect(hits[0].role).toBe('user');
    expect(hits[0].score).toBeGreaterThan(hits[1].score);
  });

  it('scopes to one session by full id', async () => {
    await seed('alpha', line('user', 'shared subject matter'));
    await seed('beta', line('user', 'shared subject matter'));
    const client = await indexed();

    const hits = await lexicalRank(client, 'shared subject', 10, 'alpha');

    expect(hits).toHaveLength(1);
    expect(hits[0].sessionId).toBe('alpha');
  });

  it('scopes to one session by unique id prefix', async () => {
    await seed('alpha', line('user', 'shared subject matter'));
    await seed('beta', line('user', 'shared subject matter'));
    const client = await indexed();

    const hits = await lexicalRank(client, 'shared subject', 10, 'alp');

    expect(hits).toHaveLength(1);
    expect(hits[0].sessionId).toBe('alpha');
  });

  it('respects the limit', async () => {
    await seed('a', Array.from({ length: 10 }, (_, i) => line('user', `repeated topic number ${i}`)).join(''));
    const client = await indexed();

    expect(await lexicalRank(client, 'repeated topic', 3)).toHaveLength(3);
  });

  it('returns nothing for a query with no searchable tokens', async () => {
    await seed('a', line('user', 'anything'));
    const client = await indexed();

    expect(await lexicalRank(client, '***', 10)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/transcripts/search-lexical.test.ts`
Expected: FAIL — `Cannot find module '../../src/transcripts/search.js'`

- [ ] **Step 3: Write the implementation**

Create `src/transcripts/search.ts`:

```typescript
import type { Client } from '@libsql/client';

export type TranscriptHit = {
  messageId: number;
  path: string;
  sessionId: string;
  parentSessionId: string | null;
  line: number;
  role: 'user' | 'assistant';
  score: number;
  /** Filled in by the caller from the source file; never stored. */
  text?: string;
};

/**
 * What a message's rank is multiplied by.
 *
 * PR #7 needed a third weight -- 0.3 for anything more than half tool output -- to stop pasted
 * files winning on volume. Tool output is not indexed at all here, so that weight has no work
 * to do and does not exist.
 */
export const ROLE_WEIGHTS: Record<'user' | 'assistant', number> = {
  user: 2.0,
  assistant: 1.0,
};

/**
 * Turn a human query into an FTS5 MATCH expression.
 *
 * Every token is stripped to word characters and quoted. Unquoted user input is FTS5 *syntax*:
 * a stray `"` or `*` is a query error, and `NOT` is an operator.
 */
export function toMatchQuery(query: string): string | null {
  const tokens = query
    .split(/\s+/)
    .map(token => token.replace(/[^\p{L}\p{N}_]/gu, ''))
    .filter(token => token.length > 0);
  if (tokens.length === 0) return null;
  return tokens.map(token => `"${token}"`).join(' OR ');
}

/**
 * Resolve a session id or unique prefix to the paths it covers.
 *
 * A prefix that matches nothing yields an empty list, which correctly produces no hits rather
 * than silently widening to the whole archive.
 */
async function pathsForSession(client: Client, sessionId: string): Promise<string[]> {
  const rows = (await client.execute({
    sql: 'SELECT DISTINCT path FROM transcript_messages WHERE session_id = ? OR session_id LIKE ?',
    args: [sessionId, `${sessionId}%`],
  })).rows;
  return rows.map(row => String(row.path));
}

/**
 * BM25 ranking with role weighting.
 *
 * `bm25()` is negative-is-better, so it is negated before the weight is applied. The candidate
 * window is wider than `limit` because re-weighting can promote a row FTS5 ranked lower.
 */
export async function lexicalRank(
  client: Client,
  query: string,
  limit: number,
  sessionId?: string,
): Promise<TranscriptHit[]> {
  const match = toMatchQuery(query);
  if (!match) return [];

  const args: unknown[] = [match];
  let scope = '';
  if (sessionId) {
    const paths = await pathsForSession(client, sessionId);
    if (paths.length === 0) return [];
    scope = ` AND m.path IN (${paths.map(() => '?').join(', ')})`;
    args.push(...paths);
  }
  args.push(limit * 4);

  const rows = (await client.execute({
    sql: `SELECT m.id, m.path, m.session_id, m.parent_session_id, m.line, m.role,
                 bm25(transcript_fts) AS rank
          FROM transcript_fts
          JOIN transcript_messages m ON m.id = transcript_fts.rowid
          WHERE transcript_fts MATCH ?${scope}
          ORDER BY rank
          LIMIT ?`,
    args: args as never[],
  })).rows;

  return rows
    .map(row => {
      const role = String(row.role) as 'user' | 'assistant';
      return {
        messageId: Number(row.id),
        path: String(row.path),
        sessionId: String(row.session_id),
        parentSessionId: row.parent_session_id === null ? null : String(row.parent_session_id),
        line: Number(row.line),
        role,
        score: -Number(row.rank) * (ROLE_WEIGHTS[role] ?? 1),
      };
    })
    .sort((left, right) => right.score - left.score)
    .slice(0, limit);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/transcripts/search-lexical.test.ts`
Expected: PASS, 9 tests

- [ ] **Step 5: Commit**

```bash
git add src/transcripts/search.ts tests/transcripts/search-lexical.test.ts
git commit -m "feat(transcripts): BM25 ranking with user-over-assistant weighting"
```

---

### Task 8: int8 quantization

**Files:**
- Create: `src/transcripts/quantize.ts`
- Test: `tests/transcripts/quantize.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `quantizeScale(dims: number): number`
  - `quantizeVector(vector: number[]): { scale: number; bytes: Uint8Array }`
  - `dequantizeVector(bytes: Uint8Array, scale: number): number[]`
  - `dotQuantized(query: number[], bytes: Uint8Array, scale: number): number`

- [ ] **Step 1: Write the failing test**

Create `tests/transcripts/quantize.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { dequantizeVector, dotQuantized, quantizeScale, quantizeVector } from '../../src/transcripts/quantize.js';

/** A unit-length vector, which is what the embedder produces (`normalize: true`). */
function unitVector(dims: number, seed: number): number[] {
  const raw = Array.from({ length: dims }, (_, i) => Math.sin(seed * (i + 1)));
  const norm = Math.hypot(...raw);
  return raw.map(v => v / norm);
}

describe('quantizeScale', () => {
  it('clips at roughly six sigma for the given dimensionality', () => {
    // L2-normalised components have RMS 1/sqrt(dims), so 6/sqrt(dims) is a ~6 sigma clip.
    expect(quantizeScale(384)).toBeCloseTo(6 / Math.sqrt(384), 10);
    expect(quantizeScale(1024)).toBeCloseTo(6 / Math.sqrt(1024), 10);
  });

  it('shrinks as dimensionality grows, because components do', () => {
    expect(quantizeScale(1024)).toBeLessThan(quantizeScale(384));
  });
});

describe('quantizeVector', () => {
  it('produces one byte per dimension', () => {
    const { bytes } = quantizeVector(unitVector(384, 1));
    expect(bytes.byteLength).toBe(384);
  });

  it('round-trips within quantization error', () => {
    const original = unitVector(384, 3);
    const { scale, bytes } = quantizeVector(original);
    const restored = dequantizeVector(bytes, scale);

    for (let i = 0; i < original.length; i++) {
      expect(Math.abs(restored[i] - original[i])).toBeLessThan(scale / 127);
    }
  });

  it('clamps a component beyond the clip range instead of wrapping', () => {
    const dims = 4;
    const scale = quantizeScale(dims);
    const { bytes } = quantizeVector([scale * 10, -scale * 10, 0, 0]);
    const signed = new Int8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);

    expect(signed[0]).toBe(127);
    expect(signed[1]).toBe(-127);
  });
});

describe('dotQuantized', () => {
  it('preserves cosine similarity to three decimal places', () => {
    const a = unitVector(384, 5);
    const b = unitVector(384, 9);
    const exact = a.reduce((sum, value, i) => sum + value * b[i], 0);

    const { scale, bytes } = quantizeVector(b);

    expect(dotQuantized(a, bytes, scale)).toBeCloseTo(exact, 3);
  });

  it('scores a vector against itself near 1', () => {
    const a = unitVector(384, 7);
    const { scale, bytes } = quantizeVector(a);
    expect(dotQuantized(a, bytes, scale)).toBeCloseTo(1, 2);
  });

  it('returns 0 when dimensions disagree', () => {
    const { scale, bytes } = quantizeVector(unitVector(384, 2));
    expect(dotQuantized(unitVector(16, 2), bytes, scale)).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/transcripts/quantize.test.ts`
Expected: FAIL — `Cannot find module '../../src/transcripts/quantize.js'`

- [ ] **Step 3: Write the implementation**

Create `src/transcripts/quantize.ts`:

```typescript
/**
 * int8 vectors, at a quarter of float32's size and no measured loss.
 *
 * Measured at 384 dims over 350 atoms and 17 recall queries: float32 MRR 0.662 at 106 MB per
 * 69k messages; int8 0.668 at 27 MB; binary 0.310. Binary collapses at this dimensionality --
 * one sign bit per dimension cannot hold the ranking -- and recovering it needs a float32
 * rescoring pass, which means storing float32 as well. int8 needs no rescoring stage at all.
 */

/**
 * The magnitude that maps to +/-127.
 *
 * `6 / sqrt(dims)` rather than a constant: L2-normalised components have RMS `1/sqrt(dims)`, so
 * this clips at about 6 sigma and adapts to any model's dimensionality. For 384-dim Granite it
 * gives 0.306, against a measured largest component of 0.327 and a p99.9 of 0.262.
 */
export function quantizeScale(dims: number): number {
  return 6 / Math.sqrt(dims);
}

export function quantizeVector(vector: number[]): { scale: number; bytes: Uint8Array } {
  const scale = quantizeScale(vector.length);
  const signed = new Int8Array(vector.length);
  for (let i = 0; i < vector.length; i++) {
    const scaled = Math.round((vector[i] / scale) * 127);
    // Clamp rather than let the Int8Array assignment wrap: an outlier component would
    // otherwise flip sign, which is far worse than clipping it.
    signed[i] = Math.max(-127, Math.min(127, scaled));
  }
  return { scale, bytes: new Uint8Array(signed.buffer, signed.byteOffset, signed.byteLength) };
}

export function dequantizeVector(bytes: Uint8Array, scale: number): number[] {
  const signed = new Int8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const vector = new Array<number>(signed.length);
  for (let i = 0; i < signed.length; i++) vector[i] = (signed[i] * scale) / 127;
  return vector;
}

/**
 * Dot product of a float query against a stored int8 vector.
 *
 * Both sides are unit-length, so this is cosine similarity. Dequantizing inline avoids
 * allocating an array per candidate during a full scan.
 */
export function dotQuantized(query: number[], bytes: Uint8Array, scale: number): number {
  const signed = new Int8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (signed.length !== query.length) return 0;

  let total = 0;
  for (let i = 0; i < signed.length; i++) total += query[i] * signed[i];
  return (total * scale) / 127;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/transcripts/quantize.test.ts`
Expected: PASS, 8 tests

- [ ] **Step 5: Commit**

```bash
git add src/transcripts/quantize.ts tests/transcripts/quantize.test.ts
git commit -m "feat(transcripts): int8 vector quantization with dimension-adaptive scale"
```

---

### Task 9: Semantic search and RRF fusion

The reason the feature exists. The critical test is the word-mismatch case — a query sharing no term with its target — which fails against any design that re-ranks a keyword shortlist.

**Files:**
- Modify: `src/transcripts/search.ts` (append; do not alter `lexicalRank`)
- Create: `src/transcripts/embed-pass.ts`
- Test: `tests/transcripts/search-semantic.test.ts`

**Both file-reading paths here must batch by file** — `readMessagesAt`, never `readMessageAt` in a loop. The embedder selects one file's pending messages together; search groups its hits by path before rendering. Per-message reads are what made a backfill ~11 GB of I/O and the deadline unenforceable.

**Interfaces:**
- Consumes: `lexicalRank`, `TranscriptHit` (Task 7), `quantizeVector`, `dotQuantized` (Task 8), `readMessagesAt` (Task 6), `KnowledgeEmbedder` from `src/store/vector-index.js`
- Produces:
  - `RRF_K = 60`
  - `fuseRankings(rankings: TranscriptHit[][], limit: number): TranscriptHit[]`
  - `semanticRank(client: Client, queryVector: number[], fingerprint: string, limit: number, sessionId?: string): Promise<TranscriptHit[]>`
  - `searchTranscripts(input: SearchInput): Promise<{ hits: TranscriptHit[]; coverage: { embedded: number; indexed: number } }>`
  - `embedPendingMessages(input: { dbPath: string; embedder: KnowledgeEmbedder; deadline?: number }): Promise<{ embedded: number; complete: boolean }>`

- [ ] **Step 1: Write the failing test**

Create `tests/transcripts/search-semantic.test.ts`:

```typescript
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeTranscriptDbs, openTranscriptDb } from '../../src/transcripts/database.js';
import { embedPendingMessages } from '../../src/transcripts/embed-pass.js';
import { runIndexPass } from '../../src/transcripts/index-pass.js';
import { fuseRankings, searchTranscripts } from '../../src/transcripts/search.js';
import type { KnowledgeEmbedder } from '../../src/store/vector-index.js';

let dir: string;
let projectsDir: string;
let dbPath: string;
const PROJECT_ROOT = '/repo/knowl';

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'knowl-sem-'));
  projectsDir = path.join(dir, 'projects');
  dbPath = path.join(dir, 'transcripts.db');
  await fs.mkdir(path.join(projectsDir, '-repo-knowl'), { recursive: true });
});

afterEach(async () => {
  await closeTranscriptDbs();
  await fs.rm(dir, { recursive: true, force: true });
});

const line = (role: 'user' | 'assistant', text: string) =>
  JSON.stringify({ type: role, timestamp: '2026-08-03T10:00:00Z', message: { content: text } }) + '\n';

/**
 * A deterministic stand-in for the real model: it maps a fixed vocabulary of *concepts* to
 * orthogonal directions, so "ran out of memory" and "OOM" embed identically while sharing no
 * word. That is precisely the retrieval the feature exists for.
 */
const CONCEPTS: Record<string, number> = { memory: 0, ordering: 1, network: 2 };
const CONCEPT_WORDS: Record<string, string> = {
  oom: 'memory', memory: 'memory', ram: 'memory', allocation: 'memory',
  sort: 'ordering', order: 'ordering', ordering: 'ordering', tiebreak: 'ordering',
  timeout: 'network', socket: 'network', network: 'network',
};

function conceptVector(text: string): number[] {
  const vector = new Array(8).fill(0);
  for (const word of text.toLowerCase().split(/\W+/)) {
    const concept = CONCEPT_WORDS[word];
    if (concept) vector[CONCEPTS[concept]] += 1;
  }
  const norm = Math.hypot(...vector) || 1;
  return vector.map(v => v / norm);
}

const stubEmbedder = (): KnowledgeEmbedder => ({
  provider: 'stub',
  model: 'concept',
  pooling: 'mean',
  profileFingerprint: 'stub:concept',
  embed: async (texts: string[]) => texts.map(conceptVector),
});

async function seed(session: string, lines: string) {
  await fs.writeFile(path.join(projectsDir, '-repo-knowl', `${session}.jsonl`), lines);
}

async function buildIndex(embedder?: KnowledgeEmbedder) {
  await runIndexPass({ projectRoot: PROJECT_ROOT, dbPath, projectsDir });
  const client = await openTranscriptDb(dbPath);
  if (embedder) await embedPendingMessages({ dbPath, embedder });
  return client;
}

describe('fuseRankings', () => {
  const hit = (id: number, score: number) => ({
    messageId: id, path: '/p', sessionId: 's', parentSessionId: null,
    line: id, role: 'user' as const, score,
  });

  it('ranks a message found by both lists above one found by either alone', () => {
    const lexical = [hit(1, 9), hit(2, 8)];
    const semantic = [hit(3, 9), hit(1, 8)];

    const fused = fuseRankings([lexical, semantic], 3);

    expect(fused[0].messageId).toBe(1);
  });

  it('keeps a message that only one ranking found', () => {
    const fused = fuseRankings([[hit(1, 9)], [hit(2, 9)]], 5);
    expect(fused.map(h => h.messageId).sort()).toEqual([1, 2]);
  });

  it('ignores an empty ranking', () => {
    const fused = fuseRankings([[hit(1, 9)], []], 5);
    expect(fused.map(h => h.messageId)).toEqual([1]);
  });

  it('respects the limit', () => {
    const many = Array.from({ length: 10 }, (_, i) => hit(i + 1, 10 - i));
    expect(fuseRankings([many], 4)).toHaveLength(4);
  });
});

describe('searchTranscripts', () => {
  it('finds a message that shares no word with the query', async () => {
    await seed('a', line('user', 'the process ran out of memory during allocation'));
    await seed('b', line('user', 'a socket timeout on the network call'));
    const client = await buildIndex(stubEmbedder());

    const result = await searchTranscripts({
      client, query: 'OOM', limit: 5,
      embedder: stubEmbedder(), projectRoot: PROJECT_ROOT,
    });

    // "OOM" appears nowhere in the corpus, so BM25 alone returns nothing.
    expect(result.hits.length).toBeGreaterThan(0);
    expect(result.hits[0].sessionId).toBe('a');
  });

  it('still works lexically when no embedder is supplied', async () => {
    await seed('a', line('user', 'the reindex ran out of memory'));
    const client = await buildIndex();

    const result = await searchTranscripts({ client, query: 'reindex', limit: 5, projectRoot: PROJECT_ROOT });

    expect(result.hits).toHaveLength(1);
    expect(result.coverage.embedded).toBe(0);
  });

  it('degrades to lexical when the embedder throws', async () => {
    await seed('a', line('user', 'the reindex ran out of memory'));
    const client = await buildIndex(stubEmbedder());
    const broken: KnowledgeEmbedder = {
      ...stubEmbedder(),
      embed: async () => { throw new Error('model missing'); },
    };

    const result = await searchTranscripts({
      client, query: 'reindex', limit: 5, embedder: broken, projectRoot: PROJECT_ROOT,
    });

    expect(result.hits).toHaveLength(1);
  });

  it('reports coverage as embedded over indexed', async () => {
    await seed('a', line('user', 'first memory note') + line('user', 'second memory note'));
    const client = await buildIndex(stubEmbedder());

    const result = await searchTranscripts({
      client, query: 'memory', limit: 5, embedder: stubEmbedder(), projectRoot: PROJECT_ROOT,
    });

    expect(result.coverage).toEqual({ embedded: 2, indexed: 2 });
  });

  it('attaches the message text read back from the source file', async () => {
    await seed('a', line('user', 'the reindex ran out of memory'));
    const client = await buildIndex();

    const result = await searchTranscripts({ client, query: 'reindex', limit: 5, projectRoot: PROJECT_ROOT });

    expect(result.hits[0].text).toBe('the reindex ran out of memory');
  });
});

describe('embedPendingMessages', () => {
  it('embeds only messages that have no vector yet', async () => {
    await seed('a', line('user', 'memory note'));
    const client = await buildIndex(stubEmbedder());

    const second = await embedPendingMessages({ dbPath, embedder: stubEmbedder() });

    expect(second.embedded).toBe(0);
    expect(second.complete).toBe(true);
  });

  it('drops vectors belonging to a superseded model', async () => {
    await seed('a', line('user', 'memory note'));
    const client = await buildIndex(stubEmbedder());

    const other: KnowledgeEmbedder = { ...stubEmbedder(), profileFingerprint: 'stub:different' };
    await embedPendingMessages({ dbPath, embedder: other });

    const rows = (await client.execute('SELECT DISTINCT fingerprint FROM transcript_vectors')).rows;
    expect(rows.map(r => String(r.fingerprint))).toEqual(['stub:different']);
  });

  it('stops at a deadline and reports itself incomplete', async () => {
    await seed('a', Array.from({ length: 5 }, (_, i) => line('user', `memory note ${i}`)).join(''));
    await runIndexPass({ projectRoot: PROJECT_ROOT, dbPath, projectsDir });
    const client = await openTranscriptDb(dbPath);

    const result = await embedPendingMessages({ dbPath, embedder: stubEmbedder(), deadline: Date.now() - 1 });

    expect(result.complete).toBe(false);
    expect(result.embedded).toBe(0);
  });

  // The regression test for the I/O blocker. Reading per message re-read the whole transcript
  // each time: ~11 GB for a real backfill, and a deadline that could not be honoured.
  it('reads each transcript once, not once per message', async () => {
    await seed('a', Array.from({ length: 120 }, (_, i) => line('user', `memory note ${i}`)).join(''));
    await seed('b', Array.from({ length: 120 }, (_, i) => line('user', `network note ${i}`)).join(''));
    await runIndexPass({ projectRoot: PROJECT_ROOT, dbPath, projectsDir });
    const client = await openTranscriptDb(dbPath);

    const spy = vi.spyOn(fsSync, 'createReadStream');
    await embedPendingMessages({ dbPath, embedder: stubEmbedder() });

    // Two files, so two passes -- not 240.
    expect(spy.mock.calls.length).toBeLessThanOrEqual(2);
    spy.mockRestore();
  });

  it('embeds every message across several batches of the same file', async () => {
    await seed('a', Array.from({ length: 100 }, (_, i) => line('user', `memory note ${i}`)).join(''));
    await runIndexPass({ projectRoot: PROJECT_ROOT, dbPath, projectsDir });
    const client = await openTranscriptDb(dbPath);

    const result = await embedPendingMessages({ dbPath, embedder: stubEmbedder() });

    expect(result.embedded).toBe(100);
    expect(result.complete).toBe(true);
    const n = Number((await client.execute('SELECT COUNT(*) AS n FROM transcript_vectors')).rows[0].n);
    expect(n).toBe(100);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/transcripts/search-semantic.test.ts`
Expected: FAIL — `Cannot find module '../../src/transcripts/embed-pass.js'`

- [ ] **Step 3: Write the embedding pass**

Create `src/transcripts/embed-pass.ts`:

```typescript
import type { Client } from '@libsql/client';
import type { KnowledgeEmbedder } from '../store/vector-index.js';
import { withWriteRetry } from './database.js';
import { quantizeVector } from './quantize.js';
import { readMessagesAt } from './read.js';

/** Messages per embedding call. The provider re-batches by text length underneath. */
const EMBED_BATCH = 32;

/**
 * Give every indexed message a vector under the embedder's current profile.
 *
 * Resumable by construction: "messages with no vector for this fingerprint" *is* the resume
 * state, so an interrupted pass leaves no bookkeeping to repair.
 *
 * **Grouped by source file, not newest-first.** Reading each message individually re-reads its
 * whole transcript: at ~3 MB per file and 3,717 messages that is roughly 11 GB of I/O for one
 * backfill, and it makes the deadline unenforceable because a single batch can take seconds.
 * Selecting a file's pending messages together turns that into one streaming pass per file.
 * Files are taken newest-message-first so the session you are in is covered before the tail.
 */
export async function embedPendingMessages(input: {
  /**
   * The database path, not a client. `withWriteRetry` reopens the cached connection on
   * SQLITE_BUSY_SNAPSHOT, so a handle captured for the length of a backfill would be a closed
   * one after the first recovery.
   */
  dbPath: string;
  embedder: KnowledgeEmbedder;
  /** `Date.now()` value after which the pass stops between batches. */
  deadline?: number;
}): Promise<{ embedded: number; complete: boolean }> {
  const { dbPath, embedder } = input;
  const read = <T>(run: (client: Client) => Promise<T>) => withWriteRetry(dbPath, run);

  // Vectors from a superseded model are a full dead duplicate of the archive, not a few stale
  // rows -- there is one vector per message, not per re-ranked candidate.
  await read(client => client.execute({
    sql: 'DELETE FROM transcript_vectors WHERE fingerprint <> ?',
    args: [embedder.profileFingerprint],
  }));

  let embedded = 0;

  for (;;) {
    if (input.deadline !== undefined && Date.now() >= input.deadline) {
      return { embedded, complete: false };
    }

    // The file holding the newest unembedded message, and every pending message in it. One
    // file per round keeps the read to a single pass while still making progress newest-first.
    const nextFile = await read(async client => (await client.execute(`
      SELECT m.path
      FROM transcript_messages m
      LEFT JOIN transcript_vectors v ON v.message_id = m.id
      WHERE v.message_id IS NULL
      ORDER BY m.id DESC
      LIMIT 1
    `)).rows[0]);

    if (!nextFile) return { embedded, complete: true };

    const pending = await read(async client => (await client.execute({
      sql: `SELECT m.id, m.line
            FROM transcript_messages m
            LEFT JOIN transcript_vectors v ON v.message_id = m.id
            WHERE v.message_id IS NULL AND m.path = ?
            ORDER BY m.line ASC`,
      args: [String(nextFile.path)],
    })).rows);

    const filePath = String(nextFile.path);
    const bodies = await readMessagesAt(filePath, pending.map(row => Number(row.line)));

    const targets: Array<{ id: number; text: string }> = [];
    for (const row of pending) {
      const excerpt = bodies.get(Number(row.line));
      // A pointer whose file vanished cannot be embedded. Leave it; the next index pass
      // removes the row entirely.
      if (excerpt) targets.push({ id: Number(row.id), text: excerpt.text });
    }

    if (targets.length === 0) {
      // Nothing readable in this file -- its rows are dead pointers. Marking them with a
      // zero-length vector would corrupt ranking, so instead stop rather than spin forever
      // selecting the same file. The next index pass removes them.
      return { embedded, complete: false };
    }

    for (let start = 0; start < targets.length; start += EMBED_BATCH) {
      const slice = targets.slice(start, start + EMBED_BATCH);
      embedded += await embedBatch(dbPath, embedder, slice);
      if (input.deadline !== undefined && Date.now() >= input.deadline) {
        return { embedded, complete: false };
      }
    }
  }
}

async function embedBatch(
  dbPath: string,
  embedder: KnowledgeEmbedder,
  targets: Array<{ id: number; text: string }>,
): Promise<number> {
  // Embedding happens outside the retry: it is the expensive part and it touches no database,
  // so a contended write must not pay for a second forward pass.
  const vectors = await embedder.embed(targets.map(target => target.text));

  return withWriteRetry(dbPath, async client => embedVectorBatch(client, embedder, targets, vectors));
}

async function embedVectorBatch(
  client: Client,
  embedder: KnowledgeEmbedder,
  targets: Array<{ id: number; text: string }>,
  vectors: number[][],
): Promise<number> {
  let embedded = 0;

  await client.execute('BEGIN IMMEDIATE');
  try {
    for (let i = 0; i < targets.length; i++) {
      const vector = vectors[i];
      if (!vector || vector.length === 0) continue;
      const { scale, bytes } = quantizeVector(vector);
      await client.execute({
        sql: `INSERT INTO transcript_vectors (message_id, fingerprint, dims, scale, vec)
              VALUES (?, ?, ?, ?, ?)
              ON CONFLICT(message_id) DO UPDATE SET
                fingerprint = excluded.fingerprint, dims = excluded.dims,
                scale = excluded.scale, vec = excluded.vec`,
        args: [targets[i].id, embedder.profileFingerprint, vector.length, scale, bytes],
      });
      embedded++;
    }
    await client.execute('COMMIT');
  } catch (error) {
    await client.execute('ROLLBACK').catch(() => {});
    throw error;
  }

  return embedded;
}
```

- [ ] **Step 4: Append fusion and the search entry point**

Add to the end of `src/transcripts/search.ts`:

```typescript
import type { KnowledgeEmbedder } from '../store/vector-index.js';
import { dotQuantized } from './quantize.js';
import { readMessagesAt } from './read.js';

/**
 * RRF's rank constant. 60 is the value from the original paper and what the knowledge-side
 * fusion uses; keeping them equal means one number to reason about, not two.
 */
export const RRF_K = 60;

/**
 * Reciprocal Rank Fusion.
 *
 * Combines *positions* rather than scores. BM25 magnitudes and cosine similarities are not on a
 * comparable scale, so any weighted sum of the raw numbers is arbitrary.
 */
export function fuseRankings<T extends TranscriptHit>(
  rankings: T[][],
  limit: number,
  /**
   * Identity across rankings. Defaults to the message id, which is unique within one database
   * but NOT across repos -- federation must pass a repo-qualified key or two repos' message 5
   * would merge into one hit.
   */
  keyOf: (hit: T) => string = hit => String(hit.messageId),
): T[] {
  const scores = new Map<string, number>();
  const byKey = new Map<string, T>();

  for (const ranking of rankings) {
    ranking.forEach((hit, index) => {
      const key = keyOf(hit);
      scores.set(key, (scores.get(key) ?? 0) + 1 / (RRF_K + index + 1));
      if (!byKey.has(key)) byKey.set(key, hit);
    });
  }

  return [...scores.entries()]
    .sort((left, right) => right[1] - left[1] || compareTieKeys(left[0], right[0]))
    .slice(0, limit)
    .map(([key, score]) => ({ ...byKey.get(key)!, score }));
}

/**
 * Deterministic tiebreak for equal RRF scores.
 *
 * Ties are not rare here, they are the normal case in federation: a hit appears in exactly one
 * repo's ranking, so every repo's rank-1 scores exactly 1/(60+1). `Array.prototype.sort` is
 * stable, so without this the merged order is insertion order -- and with `limit: 1` the repo
 * that happened to be visited first always wins. That is iteration order dressed as relevance.
 *
 * Hashing the key gives an arbitrary but *stable* order that does not correlate with which repo
 * was searched first, so reversing the peer list cannot change the answer.
 */
function compareTieKeys(left: string, right: string): number {
  const hash = (value: string) => {
    let h = 2166136261;
    for (let i = 0; i < value.length; i++) {
      h ^= value.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  };
  const difference = hash(left) - hash(right);
  // Fall back to the key itself so two colliding hashes still order deterministically.
  return difference !== 0 ? difference : (left < right ? -1 : left > right ? 1 : 0);
}

/**
 * Cosine ranking over every stored vector.
 *
 * A full scan, not an ANN index: a few thousand int8 vectors is single-digit milliseconds, and
 * an index would cost rebuilds, a recall knob, and a native extension `@libsql/client` cannot
 * load. Crucially this covers the *whole* corpus -- re-ranking a lexical shortlist could never
 * surface a message whose words differ from the query, which is the query this exists for.
 */
export async function semanticRank(
  client: Client,
  queryVector: number[],
  fingerprint: string,
  limit: number,
  sessionId?: string,
): Promise<TranscriptHit[]> {
  const args: unknown[] = [fingerprint];
  let scope = '';
  if (sessionId) {
    scope = ' AND (m.session_id = ? OR m.session_id LIKE ?)';
    args.push(sessionId, `${sessionId}%`);
  }

  const rows = (await client.execute({
    sql: `SELECT m.id, m.path, m.session_id, m.parent_session_id, m.line, m.role, v.scale, v.vec
          FROM transcript_vectors v
          JOIN transcript_messages m ON m.id = v.message_id
          WHERE v.fingerprint = ?${scope}`,
    args: args as never[],
  })).rows;

  return rows
    .map(row => ({
      messageId: Number(row.id),
      path: String(row.path),
      sessionId: String(row.session_id),
      parentSessionId: row.parent_session_id === null ? null : String(row.parent_session_id),
      line: Number(row.line),
      role: String(row.role) as 'user' | 'assistant',
      score: dotQuantized(queryVector, new Uint8Array(row.vec as ArrayBuffer), Number(row.scale)),
    }))
    .sort((left, right) => right.score - left.score)
    .slice(0, limit);
}

export type SearchInput = {
  client: Client;
  query: string;
  limit: number;
  projectRoot: string;
  sessionId?: string;
  embedder?: KnowledgeEmbedder;
};

export async function searchTranscripts(
  input: SearchInput,
): Promise<{ hits: TranscriptHit[]; coverage: { embedded: number; indexed: number } }> {
  const { client, query, limit, sessionId } = input;

  const rankings: TranscriptHit[][] = [await lexicalRank(client, query, limit * 2, sessionId)];

  let fingerprint: string | null = null;
  if (input.embedder) {
    try {
      const [vector] = await input.embedder.embed([query]);
      if (vector?.length) {
        fingerprint = input.embedder.profileFingerprint;
        rankings.push(await semanticRank(client, vector, fingerprint, limit * 2, sessionId));
      }
    } catch {
      // A missing model or a failed load degrades to lexical. Returning nothing because the
      // optional half broke would be worse than returning the half that works.
    }
  }

  const fused = fuseRankings(rankings, limit);

  // Bodies are read only for what is actually returned -- ranking never touches disk. Grouped
  // by file: five hits in one session is one pass, not five whole-file reads.
  const byFile = new Map<string, TranscriptHit[]>();
  for (const hit of fused) {
    const group = byFile.get(hit.path);
    if (group) group.push(hit);
    else byFile.set(hit.path, [hit]);
  }
  for (const [filePath, group] of byFile) {
    const bodies = await readMessagesAt(filePath, group.map(hit => hit.line));
    for (const hit of group) hit.text = bodies.get(hit.line)?.text;
  }

  const indexed = Number((await client.execute('SELECT COUNT(*) AS n FROM transcript_messages')).rows[0].n);
  const embedded = fingerprint
    ? Number((await client.execute({
        sql: 'SELECT COUNT(*) AS n FROM transcript_vectors WHERE fingerprint = ?',
        args: [fingerprint],
      })).rows[0].n)
    : 0;

  return { hits: fused, coverage: { embedded, indexed } };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/transcripts/search-semantic.test.ts`
Expected: PASS, 13 tests

Two tests carry the design. The `OOM` query is a token absent from the entire corpus and still returns the memory-exhaustion message — delete `semanticRank` from the fusion and it fails. And `reads each transcript once` pins the batching: reverting to a per-message read turns 2 file passes into 240.

- [ ] **Step 6: Commit**

```bash
git add src/transcripts/search.ts src/transcripts/embed-pass.ts tests/transcripts/search-semantic.test.ts
git commit -m "feat(transcripts): whole-corpus semantic ranking fused with BM25 via RRF"
```

---

### Task 10: The `knowl reindex --transcripts` command

**Files:**
- Modify: `src/index.ts:1172-1190` (the reindex command)
- Create: `src/transcripts/backfill.ts`
- Test: `tests/transcripts/backfill.test.ts`

**Semantic ranking follows `search.vector.enabled` — decided, not inherited.** The model, dtype and pooling all come from `search.vector.preset`, so embedding transcripts while the config says vector search is off would mean one flag denying what another is doing. With vectors off, transcript search is keyword-only and every result says so. Vector search is on by default, so most repos never see this.

**Interfaces:**
- Consumes: `runIndexPass` (Task 5), `embedPendingMessages` (Task 9), `isTranscriptSearchEnabled` (Task 1), `isVectorSearchEnabled` from `src/ai/embeddings.js`
- Produces:
  - `type BackfillResult = { indexed: number; embedded: number; removed: number; complete: boolean; skippedEmbedding: string | null }`
  - `rebuildTranscriptIndex(projectRoot: string, options?: { budgetMinutes?: number; projectsDir?: string }): Promise<BackfillResult>`

- [ ] **Step 1: Write the failing test**

Create `tests/transcripts/backfill.test.ts`:

```typescript
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeTranscriptDbs } from '../../src/transcripts/database.js';
import { rebuildTranscriptIndex } from '../../src/transcripts/backfill.js';

let dir: string;
let projectsDir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'knowl-backfill-'));
  projectsDir = path.join(dir, 'projects');
  await fs.mkdir(path.join(dir, '.knowl'), { recursive: true });
  await fs.mkdir(path.join(projectsDir, encodeURIComponent('x')), { recursive: true });
});

afterEach(async () => {
  await closeTranscriptDbs();
  await fs.rm(dir, { recursive: true, force: true });
});

const line = (text: string) =>
  JSON.stringify({ type: 'user', timestamp: '2026-08-03T10:00:00Z', message: { content: text } }) + '\n';

async function writeConfig(enabled: boolean) {
  await fs.writeFile(
    path.join(dir, '.knowl', 'config.json'),
    JSON.stringify({
      version: 1,
      security: { rejectSecrets: true, secretPatterns: [] },
      search: { transcripts: { enabled }, vector: { enabled: false } },
    }),
  );
}

async function seedTranscript() {
  const encoded = path.resolve(dir).replace(/[^A-Za-z0-9]/g, '-');
  const repoDir = path.join(projectsDir, encoded);
  await fs.mkdir(repoDir, { recursive: true });
  await fs.writeFile(path.join(repoDir, 'a.jsonl'), line('a durable finding'));
}

describe('rebuildTranscriptIndex', () => {
  it('refuses when the feature is disabled', async () => {
    await writeConfig(false);
    await seedTranscript();

    await expect(rebuildTranscriptIndex(dir, { projectsDir })).rejects.toThrow(/not enabled/i);
  });

  it('creates no database file when the feature is disabled', async () => {
    await writeConfig(false);
    await rebuildTranscriptIndex(dir, { projectsDir }).catch(() => {});

    await expect(fs.access(path.join(dir, '.knowl', 'transcripts.db'))).rejects.toThrow();
  });

  it('indexes transcripts when enabled', async () => {
    await writeConfig(true);
    await seedTranscript();

    const result = await rebuildTranscriptIndex(dir, { projectsDir });

    expect(result.indexed).toBe(1);
    expect(result.complete).toBe(true);
  });

  it('reports why embedding was skipped when vector search is off', async () => {
    await writeConfig(true);
    await seedTranscript();

    const result = await rebuildTranscriptIndex(dir, { projectsDir });

    expect(result.embedded).toBe(0);
    expect(result.skippedEmbedding).toMatch(/vector search/i);
  });

  it('is idempotent', async () => {
    await writeConfig(true);
    await seedTranscript();

    await rebuildTranscriptIndex(dir, { projectsDir });
    const second = await rebuildTranscriptIndex(dir, { projectsDir });

    expect(second.indexed).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/transcripts/backfill.test.ts`
Expected: FAIL — `Cannot find module '../../src/transcripts/backfill.js'`

- [ ] **Step 3: Write the implementation**

Create `src/transcripts/backfill.ts`:

```typescript
import { loadConfig } from '../core/config.js';
import { createLocalEmbeddingProvider, isVectorSearchEnabled } from '../ai/embeddings.js';
import { resolveStorage } from '../store/storage-roles.js';
import { isTranscriptSearchEnabled } from './config.js';
import { openTranscriptDb } from './database.js';
import { embedPendingMessages } from './embed-pass.js';
import { runIndexPass } from './index-pass.js';

export type BackfillResult = {
  indexed: number;
  embedded: number;
  removed: number;
  complete: boolean;
  /** Human-readable reason the semantic half did not run, or null when it did. */
  skippedEmbedding: string | null;
};

/**
 * Index every transcript, then embed everything still lacking a vector.
 *
 * Both halves are resumable, so `--budget` is a real stopping point rather than a rollback: what
 * finished stays, and the next run picks up from the watermark.
 */
export async function rebuildTranscriptIndex(
  projectRoot: string,
  options: { budgetMinutes?: number; projectsDir?: string } = {},
): Promise<BackfillResult> {
  const config = await loadConfig(projectRoot);
  if (!isTranscriptSearchEnabled(config)) {
    throw new Error(
      'Transcript search is not enabled for this repository. Set search.transcripts.enabled to true first (knowl config).',
    );
  }

  const deadline = options.budgetMinutes !== undefined
    ? Date.now() + options.budgetMinutes * 60_000
    : undefined;

  const dbPath = resolveStorage(projectRoot).transcripts;
  const pass = await runIndexPass({ projectRoot, dbPath, projectsDir: options.projectsDir, deadline });

  if (!isVectorSearchEnabled(config)) {
    return {
      indexed: pass.indexed,
      embedded: 0,
      removed: pass.removed,
      complete: pass.complete,
      skippedEmbedding: 'Vector search is off, so results will be keyword-only. Enable search.vector.enabled for semantic search.',
    };
  }

  let embedded = 0;
  let complete = pass.complete;
  let skippedEmbedding: string | null = null;
  try {
    const embedder = await createLocalEmbeddingProvider(config, projectRoot);
    const result = await embedPendingMessages({ dbPath, embedder, deadline });
    embedded = result.embedded;
    complete = complete && result.complete;
  } catch (error) {
    // A missing model must not throw away a completed lexical index.
    skippedEmbedding = `Embedding skipped: ${(error as Error).message}`;
    complete = false;
  }

  return { indexed: pass.indexed, embedded, removed: pass.removed, complete, skippedEmbedding };
}
```

- [ ] **Step 4: Wire up the CLI**

In `src/index.ts`, replace the reindex command block at lines 1173–1190 with:

```typescript
program
  .command('reindex')
  .description('Rebuild derived search indexes')
  .option('--vectors', 'Rebuild optional vector embeddings')
  .option('--transcripts', 'Build or update the optional session transcript index')
  .option('--budget <minutes>', 'Stop after this many minutes; the next run resumes', parseFloat)
  .action(async (options) => {
    try {
      if (!options.vectors && !options.transcripts) {
        throw new Error('Nothing to reindex. Pass --vectors or --transcripts.');
      }

      const root = await findProjectRoot(process.cwd());
      if (options.vectors) await rebuildVectorEmbeddings(root);

      if (options.transcripts) {
        const result = await rebuildTranscriptIndex(root, { budgetMinutes: options.budget });
        console.log(`Indexed ${result.indexed} transcript message(s).`);
        if (result.embedded > 0) console.log(`Embedded ${result.embedded} message(s).`);
        if (result.removed > 0) console.log(`Removed ${result.removed} deleted transcript(s).`);
        if (result.skippedEmbedding) console.log(result.skippedEmbedding);
        if (!result.complete) console.log('Stopped early. Run the same command again to resume.');
        await closeTranscriptDbs();
      }
    } catch (error: any) {
      console.error(`Error reindexing: ${error.message}`);
      process.exit(1);
    }
  });
```

Add the imports near the other `src/transcripts` imports at the top of `src/index.ts`:

```typescript
import { rebuildTranscriptIndex } from './transcripts/backfill.js';
import { closeTranscriptDbs } from './transcripts/database.js';
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/transcripts/backfill.test.ts`
Expected: PASS, 5 tests

Run: `npm run build && node dist/index.js reindex`
Expected: `Error reindexing: Nothing to reindex. Pass --vectors or --transcripts.`

- [ ] **Step 6: Commit**

```bash
git add src/transcripts/backfill.ts src/index.ts tests/transcripts/backfill.test.ts
git commit -m "feat(transcripts): add knowl reindex --transcripts with a resumable budget"
```

---

### Task 11: Workspace fan-out

**Files:**
- Create: `src/transcripts/federate.ts`
- Modify: `src/mcp/tools.ts` (pass `repos` through to the federated search)
- Test: `tests/transcripts/federate.test.ts`

**Two things do not follow from "search each repo and concatenate":**

- **Ranking.** RRF scores are computed *within* one repo's candidate set and are not comparable across repos. Sorting the merged list by them makes ties fall in repo iteration order — a bias dressed as a ranking, systematically favouring whichever repo was visited first. The per-repo orders are re-fused by a second RRF over *positions*.
- **Coverage.** Reported per repo, never summed. A peer at 12% and a local index at 100% average to a number describing neither, and the point of the signal is to say whether a near-miss can be trusted.

**Interfaces:**
- Consumes: `searchTranscripts`, `fuseRankings` (Task 9), `openTranscriptDb` (Task 4), `isTranscriptSharingEnabled` (Task 1), `resolveWorkspace` / `ActiveWorkspace` from `src/workspace/resolve.js`
- Produces:
  - `type FederatedTranscriptHit = TranscriptHit & { repo: string }`
  - `type RepoCoverage = { repo: string; embedded: number; indexed: number }`
  - `searchTranscriptsFederated(input): Promise<{ hits: FederatedTranscriptHit[]; skipped: Array<{ repo: string; reason: 'absent' | 'not-shared' | 'unreadable' }>; coverage: RepoCoverage[] }>`

- [ ] **Step 1: Write the failing test**

Create `tests/transcripts/federate.test.ts`:

```typescript
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeTranscriptDbs } from '../../src/transcripts/database.js';
import { searchTranscriptsFederated } from '../../src/transcripts/federate.js';
import { runIndexPass } from '../../src/transcripts/index-pass.js';

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'knowl-fed-'));
});

afterEach(async () => {
  await closeTranscriptDbs();
  await fs.rm(dir, { recursive: true, force: true });
});

const line = (text: string) =>
  JSON.stringify({ type: 'user', message: { content: text } }) + '\n';

/** Build a repo with its own transcripts and its own config, and index it. */
async function makeRepo(name: string, body: string, share: boolean) {
  const root = path.join(dir, name);
  const projectsDir = path.join(dir, `${name}-projects`);
  const encoded = path.resolve(root).replace(/[^A-Za-z0-9]/g, '-');
  await fs.mkdir(path.join(root, '.knowl'), { recursive: true });
  await fs.mkdir(path.join(projectsDir, encoded), { recursive: true });
  await fs.writeFile(path.join(projectsDir, encoded, 's.jsonl'), line(body));
  await fs.writeFile(
    path.join(root, '.knowl', 'config.json'),
    JSON.stringify({
      version: 1,
      security: { rejectSecrets: true, secretPatterns: [] },
      search: { transcripts: { enabled: true, share } },
    }),
  );
  const dbPath = path.join(root, '.knowl', 'transcripts.db');
  await runIndexPass({ projectRoot: root, dbPath, projectsDir });
  return { name, root, dbPath };
}

const workspaceOf = (peers: Array<{ name: string; root: string }>) => ({
  name: 'ws',
  repo: 'local',
  manifest: {} as never,
  peers: peers.map(p => ({ name: p.name, path: p.root })) as never,
});

describe('searchTranscriptsFederated', () => {
  it('returns hits from a sharing peer, tagged with its repo', async () => {
    const local = await makeRepo('local', 'local finding about caching', true);
    const peer = await makeRepo('peer', 'peer finding about caching', true);

    const result = await searchTranscriptsFederated({
      projectRoot: local.root,
      workspace: workspaceOf([peer]),
      query: 'caching',
      limit: 10,
    });

    expect(result.hits.map(h => h.repo).sort()).toEqual(['local', 'peer']);
  });

  it('skips a peer that has not opted into sharing', async () => {
    const local = await makeRepo('local', 'local finding about caching', true);
    const peer = await makeRepo('peer', 'peer finding about caching', false);

    const result = await searchTranscriptsFederated({
      projectRoot: local.root,
      workspace: workspaceOf([peer]),
      query: 'caching',
      limit: 10,
    });

    expect(result.hits.every(h => h.repo === 'local')).toBe(true);
    expect(result.skipped).toContainEqual({ repo: 'peer', reason: 'not-shared' });
  });

  it('narrows to the named repos', async () => {
    const local = await makeRepo('local', 'local finding about caching', true);
    const peer = await makeRepo('peer', 'peer finding about caching', true);

    const result = await searchTranscriptsFederated({
      projectRoot: local.root,
      workspace: workspaceOf([peer]),
      query: 'caching',
      limit: 10,
      repos: ['peer'],
    });

    expect(result.hits.every(h => h.repo === 'peer')).toBe(true);
  });

  it('skips a peer with no index rather than failing the search', async () => {
    const local = await makeRepo('local', 'local finding about caching', true);

    const result = await searchTranscriptsFederated({
      projectRoot: local.root,
      workspace: workspaceOf([{ name: 'ghost', root: path.join(dir, 'ghost') }]),
      query: 'caching',
      limit: 10,
    });

    expect(result.hits).toHaveLength(1);
    expect(result.skipped).toContainEqual({ repo: 'ghost', reason: 'absent' });
  });

  it('searches only the local repo when there is no workspace', async () => {
    const local = await makeRepo('local', 'local finding about caching', true);

    const result = await searchTranscriptsFederated({
      projectRoot: local.root, workspace: null, query: 'caching', limit: 10,
    });

    expect(result.hits).toHaveLength(1);
    expect(result.hits[0].repo).toBe('local');
  });

  it('reports coverage per repo rather than summing it', async () => {
    const local = await makeRepo('local', 'local finding about caching', true);
    const peer = await makeRepo('peer', 'peer finding about caching', true);

    const result = await searchTranscriptsFederated({
      projectRoot: local.root, workspace: workspaceOf([peer]), query: 'caching', limit: 10,
    });

    expect(result.coverage.map(c => c.repo).sort()).toEqual(['local', 'peer']);
    for (const entry of result.coverage) expect(entry.indexed).toBeGreaterThan(0);
  });

  it('does not merge two repos\' hits that share a message id', async () => {
    // Both indexes are built identically, so both hold message_id 1. Keying fusion on the bare
    // message id would collapse them into a single hit.
    const local = await makeRepo('local', 'identical wording here', true);
    const peer = await makeRepo('peer', 'identical wording here', true);

    const result = await searchTranscriptsFederated({
      projectRoot: local.root, workspace: workspaceOf([peer]), query: 'identical wording', limit: 10,
    });

    expect(result.hits).toHaveLength(2);
    expect(result.hits.map(h => h.repo).sort()).toEqual(['local', 'peer']);
  });

  it('does not rank by repo order when both repos match equally well', async () => {
    // Identical corpora: whichever repo is visited first must not win by construction. RRF over
    // positions gives both rank-1 hits the same score, so neither is systematically ahead.
    const local = await makeRepo('local', 'symmetric content about caching', true);
    const peer = await makeRepo('peer', 'symmetric content about caching', true);

    const result = await searchTranscriptsFederated({
      projectRoot: local.root, workspace: workspaceOf([peer]), query: 'symmetric caching', limit: 10,
    });

    expect(result.hits).toHaveLength(2);
    expect(result.hits[0].score).toBeCloseTo(result.hits[1].score, 10);
  });

  // Equal scores are the normal case in federation, so the cutoff is where bias actually shows.
  // Asserting score equality alone passes even when local always wins.
  it('does not let the local repo win the cutoff purely by being searched first', async () => {
    const local = await makeRepo('local', 'symmetric content about caching', true);
    const peerA = await makeRepo('peer-a', 'symmetric content about caching', true);
    const peerB = await makeRepo('peer-b', 'symmetric content about caching', true);

    const winners = new Set<string>();
    for (const peers of [[peerA, peerB], [peerB, peerA]]) {
      const result = await searchTranscriptsFederated({
        projectRoot: local.root, workspace: workspaceOf(peers),
        query: 'symmetric caching', limit: 1,
      });
      expect(result.hits).toHaveLength(1);
      winners.add(result.hits[0].repo);
    }

    // Reversing the peer order must not change the winner -- the tiebreak is on the hit's
    // identity, not on which repo was visited first.
    expect(winners.size).toBe(1);
  });

  it('returns the same order whatever order the peers are listed in', async () => {
    const local = await makeRepo('local', 'symmetric content about caching', true);
    const peerA = await makeRepo('peer-a', 'symmetric content about caching', true);
    const peerB = await makeRepo('peer-b', 'symmetric content about caching', true);

    const order = async (peers: Array<{ name: string; root: string }>) =>
      (await searchTranscriptsFederated({
        projectRoot: local.root, workspace: workspaceOf(peers), query: 'symmetric caching', limit: 10,
      })).hits.map(hit => hit.repo);

    expect(await order([peerA, peerB])).toEqual(await order([peerB, peerA]));
  });

  it('names the local repo so a caller can omit it from a locator', async () => {
    const local = await makeRepo('local', 'local finding about caching', true);

    const result = await searchTranscriptsFederated({
      projectRoot: local.root, workspace: null, query: 'caching', limit: 10,
    });

    expect(result.localRepo).toBe('local');
    expect(result.hits[0].repo).toBe(result.localRepo);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/transcripts/federate.test.ts`
Expected: FAIL — `Cannot find module '../../src/transcripts/federate.js'`

- [ ] **Step 3: Write the implementation**

Create `src/transcripts/federate.ts`:

```typescript
import fs from 'node:fs/promises';
import path from 'node:path';
import type { KnowledgeEmbedder } from '../store/vector-index.js';
import { loadConfig } from '../core/config.js';
import { resolveStorage } from '../store/storage-roles.js';
import type { ActiveWorkspace } from '../workspace/resolve.js';
import { isTranscriptSharingEnabled } from './config.js';
import { openTranscriptDb } from './database.js';
import { fuseRankings, searchTranscripts, type TranscriptHit } from './search.js';

export type FederatedTranscriptHit = TranscriptHit & { repo: string };
export type TranscriptSkipReason = 'absent' | 'not-shared' | 'unreadable';
export type RepoCoverage = { repo: string; embedded: number; indexed: number };

async function exists(target: string): Promise<boolean> {
  return fs.access(target).then(() => true).catch(() => false);
}

/**
 * Search this repo's transcripts and, where a peer has opted in, its linked repos'.
 *
 * Each repo owns its own `transcripts.db` and a peer's is opened read-only -- nothing is copied
 * and nothing is promoted, so revoking access is one config flag with no residue to chase.
 *
 * Two things do NOT follow from "search each repo and concatenate":
 *
 * **Ranking.** A repo's RRF scores are computed within its own candidate set and are not
 * comparable across repos. Sorting the merged list by them makes ties fall in repo iteration
 * order -- a bias dressed as a ranking, and one that systematically favours whichever repo was
 * visited first. Instead the per-repo orders are re-fused by a second RRF over *positions*, so
 * one repo's rank-1 competes with another's rank-1 on equal terms whatever their corpus sizes.
 *
 * **Coverage.** Reported per repo, never summed. A peer at 12% and a local index at 100%
 * average to a number describing neither, and the whole point of the signal is to say whether a
 * near-miss can be trusted.
 */
export async function searchTranscriptsFederated(input: {
  projectRoot: string;
  workspace: ActiveWorkspace | null;
  query: string;
  limit: number;
  sessionId?: string;
  repos?: string[];
  embedder?: KnowledgeEmbedder;
  localRepoName?: string;
}): Promise<{
  hits: FederatedTranscriptHit[];
  skipped: Array<{ repo: string; reason: TranscriptSkipReason }>;
  coverage: RepoCoverage[];
  /**
   * Which repo name means "here". Returned rather than assumed: the caller must omit it when
   * formatting a locator, or a local hit becomes `transcript://local/...` and the reader --
   * which resolves a named repo against the workspace peer list -- answers "Unknown repo".
   */
  localRepo: string;
}> {
  const localName = input.localRepoName ?? input.workspace?.repo ?? 'local';
  const wanted = input.repos?.length ? new Set(input.repos) : null;
  const skipped: Array<{ repo: string; reason: TranscriptSkipReason }> = [];
  const coverage: RepoCoverage[] = [];
  /** One ordered list per repo, kept separate so RRF can fuse positions rather than scores. */
  const rankings: FederatedTranscriptHit[][] = [];

  const search = async (repo: string, dbPath: string, readOnly: boolean) => {
    const client = await openTranscriptDb(dbPath, { readOnly });
    const result = await searchTranscripts({
      client,
      query: input.query,
      limit: input.limit,
      sessionId: input.sessionId,
      projectRoot: input.projectRoot,
      embedder: input.embedder,
    });
    rankings.push(result.hits.map(hit => ({ ...hit, repo })));
    coverage.push({ repo, ...result.coverage });
  };

  if (!wanted || wanted.has(localName)) {
    const localDb = resolveStorage(input.projectRoot).transcripts;
    if (await exists(localDb)) await search(localName, localDb, false);
    else skipped.push({ repo: localName, reason: 'absent' });
  }

  for (const peer of input.workspace?.peers ?? []) {
    if (wanted && !wanted.has(peer.name)) continue;

    const peerRoot = (peer as { path?: string; root?: string }).path ?? (peer as { root?: string }).root;
    if (!peerRoot) {
      skipped.push({ repo: peer.name, reason: 'absent' });
      continue;
    }

    const peerDb = path.join(peerRoot, '.knowl', 'transcripts.db');
    if (!(await exists(peerDb))) {
      skipped.push({ repo: peer.name, reason: 'absent' });
      continue;
    }

    try {
      // The peer's own config decides, not ours. Sharing is theirs to grant.
      const peerConfig = await loadConfig(peerRoot);
      if (!isTranscriptSharingEnabled(peerConfig)) {
        skipped.push({ repo: peer.name, reason: 'not-shared' });
        continue;
      }
      await search(peer.name, peerDb, true);
    } catch {
      skipped.push({ repo: peer.name, reason: 'unreadable' });
    }
  }

  // Repo-qualified key: message ids are unique within a database, not across them, so the
  // default key would silently merge two repos' message 5 into one hit.
  const hits = fuseRankings(rankings, input.limit, hit => `${hit.repo}:${hit.messageId}`);

  return { hits, skipped, coverage, localRepo: localName };
}
```

If `PeerRepo` in `src/workspace/resolve.ts` names its filesystem field something other than `path` or `root`, use that name directly and delete the fallback — read the type before writing this.

- [ ] **Step 4: Verify the handler consumes the contract**

Nothing consumes this yet. Task 13 builds `handleTranscriptSearch` against exactly this shape: it destructures `{ hits, skipped, coverage }` and emits one `Coverage [repo]: n/m` line per repo plus one `Skipped [repo]: reason` line. Keep the return type stable or that task will not compile.

Run: `npx tsc --noEmit`
Expected: no errors. A mismatch here means the two tasks disagree about the contract.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/transcripts/federate.test.ts`
Expected: PASS, 9 tests

The last three are the review's P2: per-repo coverage, no message-id collision across repos, and no repo-order bias on equal scores.

Run: `npm test`
Expected: PASS. Note from PR #7: the full suite is load-sensitive on a busy machine — `query-command`, `workspace-query` and `foreign-item-refusal` can time out under a large parallel run and pass in isolation. Re-run any failure on its own before treating it as real, and confirm the same behaviour on `main`.

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/transcripts/federate.ts src/mcp/tools.ts tests/transcripts/federate.test.ts
git commit -m "feat(transcripts): opt-in read-only workspace fan-out"
```

---
### Task 12: Lifecycle: catch-up on every turn, teardown on disable

**The catch-up must embed, not only index.** A trigger that writes lexical rows and stops leaves every new message permanently unvectored until somebody remembers to run a manual reindex, so coverage decays silently from 100% as the archive grows. Whole-corpus semantic ranking is the design's central claim; a catch-up path that quietly erodes it is worse than none.

**Disabling deletes the database.** Not "stops using it". An index left behind after the feature is off is term and vector data nothing will ever refresh, belonging to the one user who explicitly declined to keep it.

**Files:**
- Modify: `src/index.ts:1552-1580` (the `agent-hook` command action)
- Modify: `src/cli/config/ui.ts` (act on the `search.transcripts.enabled` true→false transition)
- Create: `src/transcripts/catch-up.ts`
- Create: `src/transcripts/teardown.ts`
- Test: `tests/transcripts/catch-up.test.ts`, `tests/transcripts/teardown.test.ts`

**Interfaces:**
- Consumes: `runIndexPass` (Task 5), `embedPendingMessages` (Task 9), `isTranscriptSearchEnabled` (Task 1)
- Produces:
  - `catchUpTranscripts(projectRoot, options?: { budgetMs?: number; projectsDir?: string }): Promise<{ indexed: number; embedded: number } | null>`
  - `removeTranscriptIndex(projectRoot: string): Promise<{ removed: boolean; messages: number }>`

- [ ] **Step 1: Write the failing test**

Create `tests/transcripts/catch-up.test.ts`:

```typescript
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { catchUpTranscripts } from '../../src/transcripts/catch-up.js';
import { closeTranscriptDbs, openTranscriptDb } from '../../src/transcripts/database.js';
import type { KnowledgeEmbedder } from '../../src/store/vector-index.js';

/** Deterministic 8-dim stand-in; the real model is not needed to prove vectors were written. */
const stubEmbedder = (): KnowledgeEmbedder => ({
  provider: 'stub',
  model: 'stub',
  pooling: 'mean',
  profileFingerprint: 'stub:catchup',
  embed: async (texts: string[]) => texts.map(() => [1, 0, 0, 0, 0, 0, 0, 0]),
});

let dir: string;
let projectsDir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'knowl-catchup-'));
  projectsDir = path.join(dir, 'projects');
  await fs.mkdir(path.join(dir, '.knowl'), { recursive: true });
});

afterEach(async () => {
  await closeTranscriptDbs();
  await fs.rm(dir, { recursive: true, force: true });
});

async function writeConfig(enabled: boolean, options: { vector?: boolean } = {}) {
  await fs.writeFile(
    path.join(dir, '.knowl', 'config.json'),
    JSON.stringify({
      version: 1,
      security: { rejectSecrets: true, secretPatterns: [] },
      search: { transcripts: { enabled }, vector: { enabled: options.vector === true } },
    }),
  );
}

async function seed() {
  const encoded = path.resolve(dir).replace(/[^A-Za-z0-9]/g, '-');
  await fs.mkdir(path.join(projectsDir, encoded), { recursive: true });
  await fs.writeFile(
    path.join(projectsDir, encoded, 'a.jsonl'),
    JSON.stringify({ type: 'user', message: { content: 'a turn happened' } }) + '\n',
  );
}

describe('catchUpTranscripts', () => {
  it('returns null and creates nothing when disabled', async () => {
    await writeConfig(false);
    await seed();

    expect(await catchUpTranscripts(dir, { projectsDir })).toBeNull();
    await expect(fs.access(path.join(dir, '.knowl', 'transcripts.db'))).rejects.toThrow();
  });

  it('indexes new turns when enabled', async () => {
    await writeConfig(true);
    await seed();

    const result = await catchUpTranscripts(dir, { projectsDir });
    expect(result?.indexed).toBe(1);
  });

  // The regression test for the blocker: catching up lexically but never embedding meant
  // coverage decayed from 100% with every new turn, with no signal that it had.
  it('embeds what it indexes, so coverage stays complete', async () => {
    await writeConfig(true, { vector: true });
    await seed();

    await catchUpTranscripts(dir, { projectsDir, embedder: stubEmbedder() });

    const client = await openTranscriptDb(path.join(dir, '.knowl', 'transcripts.db'));
    const indexed = Number((await client.execute('SELECT COUNT(*) AS n FROM transcript_messages')).rows[0].n);
    const embedded = Number((await client.execute('SELECT COUNT(*) AS n FROM transcript_vectors')).rows[0].n);

    expect(indexed).toBe(1);
    expect(embedded).toBe(indexed);
  });

  it('still indexes when vector search is off, and embeds nothing', async () => {
    await writeConfig(true, { vector: false });
    await seed();

    const result = await catchUpTranscripts(dir, { projectsDir });

    expect(result?.indexed).toBe(1);
    expect(result?.embedded).toBe(0);
  });

  it('returns null rather than throwing when the config is unreadable', async () => {
    await seed();
    expect(await catchUpTranscripts(dir, { projectsDir })).toBeNull();
  });

  it('never throws, whatever indexing does', async () => {
    await writeConfig(true);
    // No projects directory at all.
    await expect(catchUpTranscripts(dir, { projectsDir: path.join(dir, 'absent') })).resolves.not.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/transcripts/catch-up.test.ts`
Expected: FAIL — `Cannot find module '../../src/transcripts/catch-up.js'`

- [ ] **Step 3: Write the implementation**

Create `src/transcripts/catch-up.ts`:

```typescript
import { loadConfig } from '../core/config.js';
import { resolveStorage } from '../store/storage-roles.js';
import { isTranscriptSearchEnabled } from './config.js';
import { closeTranscriptDbs } from './database.js';
import { runIndexPass } from './index-pass.js';

/** How long a hook-driven pass may take. A hook that delays a turn is worse than a stale index. */
const DEFAULT_BUDGET_MS = 1_500;

/**
 * Bring the index up to date at the end of an agent turn -- both halves.
 *
 * Once per turn rather than once per message: transcripts are append-only, so catching up twenty
 * messages costs the same as catching up one, and a write every few seconds is exactly what
 * produced the SQLITE_BUSY failures this design separates databases to avoid.
 *
 * Indexing and embedding share the one deadline, indexing first: a lexical row is useful on its
 * own, an orphaned vector is not. Embedding what was just indexed is not optional -- skipping it
 * lets coverage decay from 100% with every new turn, silently invalidating the whole-corpus
 * claim that justifies ranking semantically at all.
 *
 * Returns null when the feature is off, and swallows every failure. This runs inside a lifecycle
 * hook; an optional index must never be the reason a turn errors.
 */
export async function catchUpTranscripts(
  projectRoot: string,
  options: {
    budgetMs?: number;
    projectsDir?: string;
    /** Injected by tests; production resolves it from config. */
    embedder?: KnowledgeEmbedder;
    /**
     * Whether to release connections afterwards. True for the hook, which is a short-lived
     * process; false for the search-time top-up, whose caller is about to query the very
     * connections this would close.
     */
    closeWhenDone?: boolean;
  } = {},
): Promise<{ indexed: number; embedded: number } | null> {
  try {
    const config = await loadConfig(projectRoot);
    if (!isTranscriptSearchEnabled(config)) return null;

    const dbPath = resolveStorage(projectRoot).transcripts;
    const deadline = Date.now() + (options.budgetMs ?? DEFAULT_BUDGET_MS);

    const pass = await runIndexPass({
      projectRoot, dbPath, projectsDir: options.projectsDir, deadline,
    });

    let embedded = 0;
    if (isVectorSearchEnabled(config)) {
      try {
        const embedder = options.embedder ?? await createLocalEmbeddingProvider(config, projectRoot);
        embedded = (await embedPendingMessages({ dbPath, embedder, deadline })).embedded;
      } catch {
        // No model on disk yet, or it failed to load. The lexical index still landed; the next
        // turn or an explicit reindex fills the vectors in.
      }
    }

    return { indexed: pass.indexed, embedded };
  } catch {
    return null;
  } finally {
    if (options.closeWhenDone !== false) await closeTranscriptDbs().catch(() => {});
  }
}
```

Imports for this file:

```typescript
import { loadConfig } from '../core/config.js';
import { createLocalEmbeddingProvider, isVectorSearchEnabled } from '../ai/embeddings.js';
import { resolveStorage } from '../store/storage-roles.js';
import type { KnowledgeEmbedder } from '../store/vector-index.js';
import { isTranscriptSearchEnabled } from './config.js';
import { closeTranscriptDbs, openTranscriptDb } from './database.js';
import { embedPendingMessages } from './embed-pass.js';
import { runIndexPass } from './index-pass.js';
```

- [ ] **Step 4: Call it from the hook**

In `src/index.ts`, in the `agent-hook` action, add the catch-up immediately after `handleHostLifecycleEvent` and before `closeDb()`:

```typescript
      const result = await handleHostLifecycleEvent(project.id, normalized);

      // Best-effort and gated: returns null when transcript search is off, and never throws.
      if (normalized.event === 'turn-stop' || normalized.event === 'session-stop') {
        await catchUpTranscripts(root);
      }

      if (result.hostOutput) console.log(JSON.stringify(result.hostOutput));
```

Add the import alongside the other transcript imports:

```typescript
import { catchUpTranscripts } from './transcripts/catch-up.js';
```

- [ ] **Step 5: Delete the database when the feature is turned off**

Create `src/transcripts/teardown.ts`:

```typescript
import fs from 'node:fs/promises';
import { resolveStorage } from '../store/storage-roles.js';
import { closeTranscriptDb, openTranscriptDb } from './database.js';

/**
 * Remove `.knowl/transcripts.db` and its WAL sidecars.
 *
 * Called on the `search.transcripts.enabled` true -> false transition. Leaving the file behind
 * would keep a copy of the archive's terms and vectors that nothing will ever refresh, belonging
 * to the one user who explicitly declined to keep it. "Off" has to mean the file is gone.
 *
 * Reports the message count first so the caller can say what was discarded rather than deleting
 * silently.
 */
export async function removeTranscriptIndex(
  projectRoot: string,
): Promise<{ removed: boolean; messages: number }> {
  const dbPath = resolveStorage(projectRoot).transcripts;

  // Existence decides whether there is anything to remove. Counting is only for the report --
  // folding the two together meant a corrupt or unreadable database threw during the count and
  // was then left on disk forever, which is the one case where deletion matters most.
  try {
    await fs.access(dbPath);
  } catch {
    return { removed: false, messages: 0 };
  }

  let messages = 0;
  try {
    const client = await openTranscriptDb(dbPath);
    messages = Number((await client.execute('SELECT COUNT(*) AS n FROM transcript_messages')).rows[0].n);
  } catch {
    // Unreadable. Delete it anyway and report an unknown count.
    messages = -1;
  }

  // Close first: Windows refuses to unlink a file this process still holds open, and the WAL
  // sidecars would survive the main file's removal.
  await closeTranscriptDb(dbPath);

  for (const suffix of ['', '-wal', '-shm']) {
    await fs.rm(`${dbPath}${suffix}`, { force: true });
  }

  return { removed: true, messages };
}

/**
 * Apply whatever a config change implies for the transcript index.
 *
 * Every mutation path routes through here -- the interactive editor, `knowl config set`, and
 * `knowl config reset`. Wiring only the editor would mean `knowl config set
 * search.transcripts.enabled false` leaves the index on disk, which is the same bug in a
 * different command.
 */
export async function applyTranscriptConfigTransition(
  projectRoot: string,
  before: ProjectConfig,
  after: ProjectConfig,
): Promise<{ removed: boolean; messages: number }> {
  const wasOn = isTranscriptSearchEnabled(before);
  const isOn = isTranscriptSearchEnabled(after);
  if (!wasOn || isOn) return { removed: false, messages: 0 };
  return removeTranscriptIndex(projectRoot);
}

/** One line for the CLI to print, or null when nothing happened. */
export function describeTranscriptTeardown(result: { removed: boolean; messages: number }): string | null {
  if (!result.removed) return null;
  return result.messages < 0
    ? 'Removed the transcript index (it was unreadable).'
    : `Removed the transcript index (${result.messages} messages).`;
}
```

Imports for this file:

```typescript
import fs from 'node:fs/promises';
import type { ProjectConfig } from '../core/types.js';
import { resolveStorage } from '../store/storage-roles.js';
import { isTranscriptSearchEnabled } from './config.js';
import { closeTranscriptDb, openTranscriptDb } from './database.js';
```

Create `tests/transcripts/teardown.test.ts`:

```typescript
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeTranscriptDbs, openTranscriptDb } from '../../src/transcripts/database.js';
import {
  applyTranscriptConfigTransition,
  removeTranscriptIndex,
} from '../../src/transcripts/teardown.js';
import type { ProjectConfig } from '../../src/core/types.js';

let dir: string;
let dbPath: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'knowl-teardown-'));
  await fs.mkdir(path.join(dir, '.knowl'), { recursive: true });
  dbPath = path.join(dir, '.knowl', 'transcripts.db');
});

afterEach(async () => {
  await closeTranscriptDbs();
  await fs.rm(dir, { recursive: true, force: true });
});

describe('removeTranscriptIndex', () => {
  it('deletes the database and reports what was discarded', async () => {
    const client = await openTranscriptDb(dbPath);
    await client.execute({
      sql: `INSERT INTO transcript_messages (path, session_id, parent_session_id, line, role, chars, ts)
            VALUES ('/x.jsonl', 's', NULL, 1, 'user', 4, NULL)`,
      args: [],
    });

    const result = await removeTranscriptIndex(dir);

    expect(result).toEqual({ removed: true, messages: 1 });
    await expect(fs.access(dbPath)).rejects.toThrow();
  });

  it('removes the WAL sidecars too', async () => {
    await openTranscriptDb(dbPath);
    await removeTranscriptIndex(dir);

    for (const suffix of ['-wal', '-shm']) {
      await expect(fs.access(`${dbPath}${suffix}`)).rejects.toThrow();
    }
  });

  it('is a no-op when there is no index', async () => {
    expect(await removeTranscriptIndex(dir)).toEqual({ removed: false, messages: 0 });
  });

  it('deletes a corrupt database instead of leaving it behind', async () => {
    // The case that matters most: an unreadable index is exactly what a user wants gone, and
    // counting-before-deciding used to abandon it on disk.
    await fs.writeFile(dbPath, 'this is not a sqlite file');

    const result = await removeTranscriptIndex(dir);

    expect(result.removed).toBe(true);
    expect(result.messages).toBe(-1);
    await expect(fs.access(dbPath)).rejects.toThrow();
  });
});

describe('applyTranscriptConfigTransition', () => {
  const configWith = (enabled: boolean): ProjectConfig => ({
    version: 1,
    security: { rejectSecrets: true, secretPatterns: [] },
    search: { transcripts: { enabled } },
  });

  it('removes the index on the true -> false transition', async () => {
    await openTranscriptDb(dbPath);
    const result = await applyTranscriptConfigTransition(dir, configWith(true), configWith(false));

    expect(result.removed).toBe(true);
    await expect(fs.access(dbPath)).rejects.toThrow();
  });

  it('leaves the index alone when it stays enabled', async () => {
    await openTranscriptDb(dbPath);
    const result = await applyTranscriptConfigTransition(dir, configWith(true), configWith(true));

    expect(result.removed).toBe(false);
    await expect(fs.access(dbPath)).resolves.toBeUndefined();
  });

  it('does nothing when it was already off', async () => {
    const result = await applyTranscriptConfigTransition(dir, configWith(false), configWith(false));
    expect(result).toEqual({ removed: false, messages: 0 });
  });
});
```

Then wire `applyTranscriptConfigTransition` into **all three** mutation paths. Wiring only the interactive editor leaves `knowl config set search.transcripts.enabled false` silently keeping the index — the same bug in a different command.

1. **`src/cli/config/ui.ts`** — after a successful save. The file already reads the config before editing (see the comment at line 335 about reading before any edit) and calls `offerReindex(root, configBefore, prompts)` around line 431; add the symmetric call beside it.
2. **`knowl config set`** ([src/index.ts:1077](../../../src/index.ts#L1077)) — load the config before the write, then compare after.
3. **`knowl config reset`** ([src/index.ts:1138](../../../src/index.ts#L1138)) — same, and note that a whole-config reset turns the feature off implicitly rather than by naming the key, which is exactly the case a key-name check would miss.

In each, print `describeTranscriptTeardown(result)` when it returns non-null. Read `offerReindex` and the `ConfigChange` shape before writing this, and follow whatever they do rather than adding a parallel mechanism.

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run tests/transcripts/catch-up.test.ts tests/transcripts/teardown.test.ts`
Expected: PASS, 6 + 3 tests

Run: `npx vitest run tests/cli`
Expected: PASS — the hook and config paths are exercised there and must be unaffected when the feature is off.

- [ ] **Step 7: Commit**

```bash
git add src/transcripts/catch-up.ts src/transcripts/teardown.ts src/index.ts src/cli/config/ui.ts \
        tests/transcripts/catch-up.test.ts tests/transcripts/teardown.test.ts
git commit -m "feat(transcripts): embed on catch-up, and delete the index when disabled"
```

---


### Task 13: MCP tools, registered only when enabled

**Files:**
- Create: `src/transcripts/locator.ts`
- Create: `src/transcripts/mcp-handlers.ts`
- Modify: `src/mcp/tools.ts` (the `ListToolsRequestSchema` handler and the call dispatcher)
- Modify: `src/core/knowl-guidance.ts:92-109`
- Modify: `src/mcp/server.ts:36`
- Test: `tests/transcripts/locator.test.ts`, `tests/transcripts/mcp-gating.test.ts`

**Interfaces:**
- Consumes: `isTranscriptSearchEnabled` (Task 1), `searchTranscriptsFederated` (Task 11), `catchUpTranscripts` (Task 12), `readWithContext` (Task 6)
- Produces:
  - `formatLocator(hit: { repo?: string; sessionId: string; line: number }): string`
  - `parseLocator(raw: string): { repo: string | null; sessionId: string; line: number } | null`
  - `handleTranscriptSearch(input): Promise<string>` and `handleTranscriptRead(input): Promise<string>` in `mcp-handlers.ts`
  - MCP tools `knowl_transcript_search` and `knowl_transcript_read`
  - `mcpServerInstructions(config: ProjectConfig | null): string` in `knowl-guidance.ts`

**Why a locator and not `(sessionId, line)`:** the reader needs a filesystem path, which requires knowing which repo owns the session — and in a workspace two repos can hold sessions with the same id. Handing the caller a single opaque string it passes straight back removes the chance to reassemble identity wrongly and open the wrong file.

**No pseudocode in this task.** An earlier draft left the dispatcher as a comment. Every branch below is written out, and the gating tests drive a real `tools/list` and a real `tools/call` through the server rather than inspecting guidance strings.

**Read this before writing any code — the obvious approach does not work:**

- There is no `buildGuidanceCard`. `renderCompactKnowlGuidance(modeLine)` is **private** ([src/core/knowl-guidance.ts:92](../../../src/core/knowl-guidance.ts#L92)), and the cards are **module-level constants** evaluated at import: `KNOWL_CLAUDE_OPERATIONAL_CARD` and `KNOWL_MCP_SERVER_INSTRUCTIONS` (lines 108–109). A constant cannot depend on config.
- The compact card's Route section is **hand-written prose, not generated** from `KNOWL_MCP_TOOL_GROUPS`. Adding a group there changes `renderFullKnowlGuidance()` (the KNOWL.md table) and `KNOWL_MCP_TOOL_NAMES` — but not the compact card. So the two need separate handling, and `KNOWL_MCP_TOOL_GROUPS` must stay unchanged or the tool-name list grows unconditionally.
- `tests/core/knowl-guidance.test.ts:63-64` asserts **exact lengths**. Keeping the existing constants as the disabled-state values means those assertions keep passing untouched, which is the correct outcome: off by default must change nothing.

**Measured on this branch** (`npx vitest` against the real module):

| | chars |
|---|---|
| `KNOWL_CLAUDE_OPERATIONAL_CARD` | 1,695 |
| `KNOWL_MCP_SERVER_INSTRUCTIONS` | 1,746 |
| `KNOWL_MCP_TOOL_NAMES` | 24 tools |
| + the transcript Route bullet below | **1,885 / 2,000** |

115 characters of headroom with the feature on. The spec cites 1,917 from PR #8 — that is PR #8's branch, which adds a tool this design does not.

- [ ] **Step 1: Write the failing test**

Create `tests/transcripts/mcp-gating.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import {
  KNOWL_MCP_SERVER_INSTRUCTIONS,
  KNOWL_MCP_TOOL_GROUPS,
  KNOWL_MCP_TOOL_NAMES,
  mcpServerInstructions,
} from '../../src/core/knowl-guidance.js';
import type { ProjectConfig } from '../../src/core/types.js';

const config = (enabled: boolean): ProjectConfig => ({
  version: 1,
  security: { rejectSecrets: true, secretPatterns: [] },
  search: { transcripts: { enabled } },
});

describe('transcript tool gating', () => {
  it('keeps both tools out of the unconditional inventory', () => {
    const names = KNOWL_MCP_TOOL_GROUPS.flatMap(group => group.tools);
    expect(names).not.toContain('knowl_transcript_search');
    expect(names).not.toContain('knowl_transcript_read');
    expect(KNOWL_MCP_TOOL_NAMES).toHaveLength(24);
  });

  it('returns the untouched constant when disabled', () => {
    expect(mcpServerInstructions(config(false))).toBe(KNOWL_MCP_SERVER_INSTRUCTIONS);
  });

  it('returns the untouched constant when there is no config at all', () => {
    expect(mcpServerInstructions(null)).toBe(KNOWL_MCP_SERVER_INSTRUCTIONS);
  });

  it('names both tools when enabled', () => {
    const card = mcpServerInstructions(config(true));
    expect(card).toContain('knowl_transcript_search');
    expect(card).toContain('knowl_transcript_read');
  });

  it('adds exactly one line when enabled', () => {
    const off = mcpServerInstructions(config(false)).split('\n').length;
    const on = mcpServerInstructions(config(true)).split('\n').length;
    expect(on).toBe(off + 1);
  });

  it('stays inside the 2000-character ceiling with the feature on', () => {
    expect(mcpServerInstructions(config(true)).length).toBeLessThanOrEqual(2000);
  });
});

// The guidance assertions above are necessary but not sufficient: they check what the agent is
// *told*, not what the server actually exposes. These drive the real protocol.
describe('MCP surface', () => {
  const TEST_ROOT = path.resolve('./.knowl-transcript-mcp-test');

  async function toolNames(cfg: ProjectConfig): Promise<string[]> {
    const response = await rpc(cfg, 'tools/list', {});
    return response.result.tools.map((tool: { name: string }) => tool.name);
  }

  it('does not list either tool when disabled', async () => {
    const names = await toolNames(config(false));
    expect(names).not.toContain('knowl_transcript_search');
    expect(names).not.toContain('knowl_transcript_read');
  });

  it('lists both tools when enabled', async () => {
    const names = await toolNames(config(true));
    expect(names).toContain('knowl_transcript_search');
    expect(names).toContain('knowl_transcript_read');
  });

  it('refuses a call to a disabled tool instead of crashing', async () => {
    // A client that cached an older tool list can still call it. The gate must hold at
    // dispatch, not only at listing.
    const response = await rpc(config(false), 'tools/call', {
      name: 'knowl_transcript_search',
      arguments: { query: 'anything' },
    });

    const text = JSON.stringify(response.result ?? response.error);
    expect(text).toMatch(/not enabled/i);
    expect(text).not.toMatch(/undefined|cannot read|ENOENT/i);
  });

  it('rejects a malformed locator with a usable message', async () => {
    const response = await rpc(config(true), 'tools/call', {
      name: 'knowl_transcript_read',
      arguments: { locator: 'not-a-locator' },
    });

    expect(JSON.stringify(response.result ?? response.error)).toMatch(/locator/i);
  });
});
```

Create `tests/transcripts/mcp-handlers.test.ts` for the behaviour the protocol tests cannot reach. These use a real indexed repo on disk:

```typescript
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeTranscriptDbs } from '../../src/transcripts/database.js';
import { handleTranscriptRead, handleTranscriptSearch, clampInteger } from '../../src/transcripts/mcp-handlers.js';
import { runIndexPass } from '../../src/transcripts/index-pass.js';
import type { ProjectConfig } from '../../src/core/types.js';

let dir: string;

const config = (over: Partial<{ enabled: boolean; share: boolean }> = {}): ProjectConfig => ({
  version: 1,
  security: { rejectSecrets: true, secretPatterns: [] },
  search: { transcripts: { enabled: true, ...over }, vector: { enabled: false } },
});

const line = (text: string) => JSON.stringify({ type: 'user', message: { content: text } }) + '\n';

async function makeRepo(name: string, body: string, share: boolean) {
  const root = path.join(dir, name);
  const projectsDir = path.join(dir, `${name}-projects`);
  const encoded = path.resolve(root).replace(/[^A-Za-z0-9]/g, '-');
  await fs.mkdir(path.join(root, '.knowl'), { recursive: true });
  await fs.mkdir(path.join(projectsDir, encoded), { recursive: true });
  await fs.writeFile(path.join(projectsDir, encoded, 'session-abc.jsonl'), body);
  await fs.writeFile(
    path.join(root, '.knowl', 'config.json'),
    JSON.stringify({ ...config({ share }), search: { transcripts: { enabled: true, share }, vector: { enabled: false } } }),
  );
  await runIndexPass({ projectRoot: root, dbPath: path.join(root, '.knowl', 'transcripts.db'), projectsDir });
  return { name, root };
}

beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'knowl-handlers-')); });
afterEach(async () => {
  await closeTranscriptDbs();
  await fs.rm(dir, { recursive: true, force: true });
});

describe('clampInteger', () => {
  it('falls back for non-numbers, NaN and Infinity', () => {
    for (const bad of [undefined, null, 'five', NaN, Infinity, -Infinity]) {
      expect(clampInteger(bad, 5, 1, 25)).toBe(5);
    }
  });

  it('clamps rather than rejecting, and truncates fractions', () => {
    expect(clampInteger(1e9, 5, 1, 25)).toBe(25);
    expect(clampInteger(-7, 2, 0, 10)).toBe(0);
    expect(clampInteger(3.9, 2, 0, 10)).toBe(3);
  });
});

describe('search to read round trip', () => {
  // The blocker this guards: a local hit rendered as transcript://local/... and the reader
  // rejected it as an unknown repo, so no local search result could be read at all.
  it('produces a local locator that read accepts', async () => {
    const local = await makeRepo('local', line('a durable finding about caching'), false);

    const output = await handleTranscriptSearch({
      config: config(), projectRoot: local.root, query: 'caching',
    });

    const locator = /transcript:\/\/\S+/.exec(output)?.[0];
    expect(locator).toBeDefined();
    expect(locator).not.toMatch(/transcript:\/\/local\//);

    const read = await handleTranscriptRead({
      config: config(), projectRoot: local.root, locator: locator!,
    });

    expect(read).toContain('a durable finding about caching');
    expect(read).not.toMatch(/unknown repo/i);
  });

  it('reports coverage and the promotion nudge', async () => {
    const local = await makeRepo('local', line('a durable finding about caching'), false);
    const output = await handleTranscriptSearch({
      config: config(), projectRoot: local.root, query: 'caching',
    });

    expect(output).toMatch(/Coverage \[.+\]: \d+\/\d+/);
    expect(output).toMatch(/knowl_store/);
  });

  it('refuses an empty query instead of scanning everything', async () => {
    const local = await makeRepo('local', line('anything'), false);
    expect(await handleTranscriptSearch({
      config: config(), projectRoot: local.root, query: '   ',
    })).toMatch(/empty query/i);
  });
});

describe('read authorization', () => {
  it('refuses a peer locator once that peer stops sharing', async () => {
    // A locator is a durable string: cached from an earlier turn, pasted, or fabricated.
    // Checking sharing only at search time would mean revocation does not revoke.
    const local = await makeRepo('local', line('local content'), false);
    const peer = await makeRepo('peer', line('peer content about caching'), false); // share: false

    const output = await handleTranscriptRead({
      config: config(),
      projectRoot: local.root,
      locator: 'transcript://peer/session-abc#L1',
    });

    expect(output).toMatch(/not sharing/i);
    expect(output).not.toContain('peer content');
  });

  it('refuses a locator naming a repo that is not linked at all', async () => {
    const local = await makeRepo('local', line('local content'), false);

    expect(await handleTranscriptRead({
      config: config(), projectRoot: local.root, locator: 'transcript://stranger/session-abc#L1',
    })).toMatch(/unknown repo/i);
  });
});

describe('session prefix resolution', () => {
  it('treats LIKE wildcards as literal characters', async () => {
    const local = await makeRepo('local', line('content here'), false);

    // `%` must not match everything; there is no session whose id contains it.
    expect(await handleTranscriptRead({
      config: config(), projectRoot: local.root, locator: 'transcript://%25#L1',
    })).toMatch(/no indexed session/i);
  });
});
```

Add the harness this file needs. `InMemoryTransport` is copied from `tests/mcp/server.test.ts:37-53` rather than inventing a second pattern; the rest is the same handshake that file performs, written out because a plan may not leave steps as prose:

```typescript
import path from 'node:path';
import fs from 'node:fs/promises';
import { createMcpServer } from '../../src/mcp/server.js';
import * as repo from '../../src/store/repository.js';
import { closeDb, initDb } from '../../src/store/database.js';

class InMemoryTransport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: any) => void;
  onSend?: (message: any) => void;
  async start(): Promise<void> {}
  async send(message: any): Promise<void> { this.onSend?.(message); }
  async close(): Promise<void> { this.onclose?.(); }
}

const TEST_ROOT = path.resolve('./.knowl-transcript-mcp-test');
let projectId: string;

beforeAll(async () => {
  await fs.rm(TEST_ROOT, { recursive: true, force: true });
  await fs.mkdir(path.join(TEST_ROOT, '.knowl'), { recursive: true });
  await initDb(TEST_ROOT);
  projectId = (await repo.createProject(TEST_ROOT, 'Transcript MCP Test')).id;
});

afterAll(async () => {
  await closeDb();
  await fs.rm(TEST_ROOT, { recursive: true, force: true });
});

/** One JSON-RPC round trip against a server built with the given config. */
async function rpc(cfg: ProjectConfig, method: string, params: unknown): Promise<any> {
  const server = createMcpServer(projectId, TEST_ROOT, cfg);
  const transport = new InMemoryTransport();
  await server.connect(transport as never);

  const waitFor = (id: string) => new Promise<any>(resolve => {
    transport.onSend = message => { if (message.id === id) resolve(message); };
  });

  const initialized = waitFor('init-id');
  transport.onmessage!({
    jsonrpc: '2.0', id: 'init-id', method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'transcript-test', version: '1.0' },
    },
  });
  await initialized;
  transport.onmessage!({ jsonrpc: '2.0', method: 'notifications/initialized' });

  const answered = waitFor('req-id');
  transport.onmessage!({ jsonrpc: '2.0', id: 'req-id', method, params });
  const response = await answered;

  await server.close();
  return response;
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/transcripts/mcp-gating.test.ts`
Expected: FAIL — `mcpServerInstructions` is not exported from `knowl-guidance.js`.

- [ ] **Step 3: Make the compact card conditional without touching the constants**

In `src/core/knowl-guidance.ts`, change the private renderer to take an options bag, and add the new export. Leave `KNOWL_MCP_TOOL_GROUPS`, `KNOWL_CLAUDE_OPERATIONAL_CARD` and `KNOWL_MCP_SERVER_INSTRUCTIONS` exactly as they are — they are the disabled-state values, and the existing exact-length assertions must keep passing untouched.

```typescript
/**
 * One extra Route line, only when transcript search is on.
 *
 * The card is a token cost paid by every session of every user. Measured: 1,746 chars for the
 * server card today, 1,885 with this line, against a 2,000 ceiling. Everyone who leaves the
 * feature off keeps their 1,746 and never learns these tools exist.
 */
const TRANSCRIPT_ROUTE_LINE =
  '- transcripts: knowl_transcript_search after a knowl_query miss; knowl_transcript_read opens a hit. Promote what you use with knowl_store.';

function renderCompactKnowlGuidance(modeLine: string, options: { transcripts?: boolean } = {}): string {
  return [
    // ...every existing line, unchanged, through the '- special: ...' bullet...
    ...(options.transcripts ? [TRANSCRIPT_ROUTE_LINE] : []),
    'During work, store or update verified durable findings; never store raw transcripts, secrets, or routine command noise.',
  ].join('\n');
}

export const KNOWL_CLAUDE_OPERATIONAL_CARD = renderCompactKnowlGuidance(KNOWL_CLAUDE_MODE_LINE);
export const KNOWL_MCP_SERVER_INSTRUCTIONS = renderCompactKnowlGuidance(KNOWL_HOST_NEUTRAL_MODE_LINE);

/**
 * The server handshake card for a given project.
 *
 * Returns the shared constant when the feature is off, so the common case allocates nothing and
 * stays byte-identical to what every existing test asserts.
 */
export function mcpServerInstructions(config: ProjectConfig | null): string {
  if (!config || !isTranscriptSearchEnabled(config)) return KNOWL_MCP_SERVER_INSTRUCTIONS;
  return renderCompactKnowlGuidance(KNOWL_HOST_NEUTRAL_MODE_LINE, { transcripts: true });
}
```

Add the two imports this needs at the top of the file:

```typescript
import type { ProjectConfig } from './types.js';
import { isTranscriptSearchEnabled } from '../transcripts/config.js';
```

Then in `src/mcp/server.ts`, replace the constant at line 36 with the call — `config` is already a parameter of `createMcpServer`:

```typescript
      instructions: mcpServerInstructions(config),
```

and update its import on line 11 from `KNOWL_MCP_SERVER_INSTRUCTIONS` to `mcpServerInstructions`.

Leave `renderFullKnowlGuidance()` alone. It renders the KNOWL.md table from `KNOWL_MCP_TOOL_GROUPS`, that file is committed per-repo, and documenting two tools a reader may not have enabled is worse than omitting them.

- [ ] **Step 4: Register the tools conditionally**

In `src/mcp/tools.ts`, inside the `ListToolsRequestSchema` handler, build the array and append conditionally before returning:

```typescript
    const tools = [ /* ...every existing tool literal, unchanged... */ ];

    const config = getConfig();
    if (config && isTranscriptSearchEnabled(config)) {
      tools.push(
        {
          name: 'knowl_transcript_search',
          description: 'Search this repo\'s past Claude Code session transcripts. Use after knowl_query misses. Returns pointers into the session files; store anything worth keeping with knowl_store.',
          inputSchema: {
            type: 'object',
            properties: {
              query: {
                type: 'string', minLength: 1, maxLength: 500,
                description: 'What to look for, in your own words. Semantic search covers the whole archive, so the exact wording need not match.',
              },
              sessionId: { type: 'string', description: 'Restrict to one session. Accepts a full id or an unambiguous prefix.' },
              repos: {
                type: 'array', items: { type: 'string' }, maxItems: 20,
                description: 'Restrict to these repos by name. Omit to search this repo plus every linked workspace repo that shares its transcripts.',
              },
              limit: { type: 'integer', minimum: 1, maximum: 25, description: 'Maximum hits; defaults to 5.' },
            },
            required: ['query'],
          },
        },
        {
          name: 'knowl_transcript_read',
          description: 'Read one transcript message and the turns around it. Pass a locator from knowl_transcript_search exactly as it was returned.',
          inputSchema: {
            type: 'object',
            properties: {
              locator: {
                type: 'string', minLength: 1, maxLength: 500,
                description: 'A transcript://<repo>/<session>#L<line> locator from a search hit, verbatim.',
              },
              context: { type: 'integer', minimum: 0, maximum: 10, description: 'Prose turns to include on each side; defaults to 2.' },
            },
            required: ['locator'],
          },
        },
      );
    }

    return { tools };
```

- [ ] **Step 4a: Write the locator module**

Create `src/transcripts/locator.ts`:

```typescript
/**
 * `transcript://<repo>/<session>#L<line>`, with `<repo>/` omitted for a local hit.
 *
 * A locator is handed to the agent and handed straight back. Session id plus line is not enough
 * to open a file -- the reader needs a path, which needs the owning repo, and in a workspace two
 * repos can hold sessions with the same id.
 */
export function formatLocator(hit: { repo?: string | null; sessionId: string; line: number }): string {
  const repo = hit.repo ? `${encodeURIComponent(hit.repo)}/` : '';
  return `transcript://${repo}${hit.sessionId}#L${hit.line}`;
}

const LOCATOR = /^transcript:\/\/(?:([^/]+)\/)?([^/#]+)#L(\d+)$/;

/** Null rather than a throw: a malformed locator is caller error, answered with a message. */
export function parseLocator(raw: string): { repo: string | null; sessionId: string; line: number } | null {
  if (typeof raw !== 'string') return null;
  const match = LOCATOR.exec(raw.trim());
  if (!match) return null;

  const line = Number(match[3]);
  // The regex already restricts this to digits, so the guard is about magnitude: a locator of
  // `#L99999999999999999999` parses to a float and would index nothing sensible.
  if (!Number.isSafeInteger(line) || line < 1) return null;

  let repo: string | null = null;
  if (match[1]) {
    try {
      repo = decodeURIComponent(match[1]);
    } catch {
      // `decodeURIComponent('%')` throws URIError on a lone or truncated escape. The contract
      // here is null-rather-than-throw, so a bad escape is just a malformed locator.
      return null;
    }
  }

  return { repo, sessionId: match[2], line };
}
```

Create `tests/transcripts/locator.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { formatLocator, parseLocator } from '../../src/transcripts/locator.js';

describe('locator', () => {
  it('omits the repo for a local hit', () => {
    expect(formatLocator({ sessionId: 'abc', line: 42 })).toBe('transcript://abc#L42');
  });

  it('includes the repo for a federated hit', () => {
    expect(formatLocator({ repo: 'knowl-cloud', sessionId: 'abc', line: 42 }))
      .toBe('transcript://knowl-cloud/abc#L42');
  });

  it('round-trips both shapes', () => {
    for (const hit of [{ sessionId: 'abc', line: 7 }, { repo: 'peer', sessionId: 'abc', line: 7 }]) {
      const parsed = parseLocator(formatLocator(hit));
      expect(parsed?.sessionId).toBe('abc');
      expect(parsed?.line).toBe(7);
      expect(parsed?.repo).toBe(hit.repo ?? null);
    }
  });

  it('survives a repo name containing a slash', () => {
    const parsed = parseLocator(formatLocator({ repo: 'group/repo', sessionId: 'abc', line: 1 }));
    expect(parsed?.repo).toBe('group/repo');
  });

  it('returns null for anything malformed', () => {
    for (const bad of ['', 'not-a-locator', 'transcript://abc', 'transcript://abc#L0', 'transcript://abc#Lx']) {
      expect(parseLocator(bad)).toBeNull();
    }
  });

  it('returns null rather than throwing on a bad percent-escape', () => {
    // decodeURIComponent('%') throws URIError. The contract here is null-not-throw.
    for (const bad of ['transcript://%/abc#L1', 'transcript://%zz/abc#L1', 'transcript://a%/abc#L1']) {
      expect(() => parseLocator(bad)).not.toThrow();
      expect(parseLocator(bad)).toBeNull();
    }
  });

  it('rejects a line number too large to be an exact integer', () => {
    expect(parseLocator('transcript://abc#L99999999999999999999')).toBeNull();
  });
});
```

- [ ] **Step 4b: Write the handlers**

Create `src/transcripts/mcp-handlers.ts`. These are plain functions returning strings, so they are testable without a server:

```typescript
import type { ProjectConfig } from '../core/types.js';
import { loadConfig } from '../core/config.js';
import { createLocalEmbeddingProvider, isVectorSearchEnabled } from '../ai/embeddings.js';
import { resolveStorage } from '../store/storage-roles.js';
import { resolveWorkspace } from '../workspace/resolve.js';
import { catchUpTranscripts } from './catch-up.js';
import { isTranscriptSearchEnabled, isTranscriptSharingEnabled } from './config.js';
import { openTranscriptDb } from './database.js';
import { searchTranscriptsFederated } from './federate.js';
import { formatLocator, parseLocator } from './locator.js';
import { readWithContext } from './read.js';

export const DISABLED_MESSAGE =
  'Transcript search is not enabled for this repository. Enable search.transcripts.enabled with `knowl config`, then run `knowl reindex --transcripts`.';

/**
 * Bounds on agent-supplied input.
 *
 * An MCP argument is whatever the model emitted; nothing upstream validates it. Unbounded
 * `limit` scans and returns arbitrarily much, unbounded `context` allocates a line range of any
 * size, and a negative `context` silently produces an empty read rather than an error.
 */
export const MAX_LIMIT = 25;
export const MAX_CONTEXT = 10;
export const MAX_QUERY_CHARS = 500;
/** Cap on the rendered reply, so one search cannot flood the agent's context window. */
export const MAX_RESPONSE_CHARS = 12_000;

/** Coerce to a finite integer inside [min, max], falling back for NaN/Infinity/undefined. */
export function clampInteger(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n\n[truncated at ${max} characters -- narrow the query or lower limit]`;
}

/** The search-time top-up budget. Small enough that a search still feels immediate. */
const SEARCH_TOPUP_MS = 1_000;

/** The embedder, or null when vectors are off or the model is unavailable. Never throws. */
async function optionalEmbedder(config: ProjectConfig, projectRoot: string) {
  if (!isVectorSearchEnabled(config)) return null;
  try {
    return await createLocalEmbeddingProvider(config, projectRoot);
  } catch {
    return null;
  }
}

export async function handleTranscriptSearch(input: {
  config: ProjectConfig | null;
  projectRoot: string | null;
  query: string;
  sessionId?: string;
  repos?: string[];
  limit?: number;
}): Promise<string> {
  const { config, projectRoot } = input;
  if (!config || !projectRoot || !isTranscriptSearchEnabled(config)) return DISABLED_MESSAGE;

  const query = String(input.query ?? '').slice(0, MAX_QUERY_CHARS).trim();
  if (!query) return 'Empty query. Give knowl_transcript_search a few words to look for.';

  const limit = clampInteger(input.limit, 5, 1, MAX_LIMIT);

  // The third indexing trigger from the design: a short top-up so a search reflects the turn
  // that just happened. Best-effort and bounded -- a stale index is a worse answer, but a slow
  // search is a worse tool. `closeWhenDone: false` keeps the connections this search is about
  // to use.
  await catchUpTranscripts(projectRoot, { budgetMs: SEARCH_TOPUP_MS, closeWhenDone: false })
    .catch(() => null);

  const embedder = await optionalEmbedder(config, projectRoot);
  const workspace = await resolveWorkspace(projectRoot, config).catch(() => null);

  const { hits, skipped, coverage, localRepo } = await searchTranscriptsFederated({
    projectRoot, workspace, query, limit,
    sessionId: input.sessionId, repos: input.repos,
    embedder: embedder ?? undefined,
  });

  const lines: string[] = [];
  if (hits.length === 0) {
    lines.push(`No transcript matches for "${query}".`);
  } else {
    for (const hit of hits) {
      const parent = hit.parentSessionId ? ` (subagent of ${hit.parentSessionId})` : '';
      // The local repo is omitted from the locator. Including it would produce
      // `transcript://local/...`, which the reader resolves against the workspace peer list
      // and rejects as an unknown repo -- a search result that cannot be read.
      const locator = formatLocator({
        repo: hit.repo === localRepo ? null : hit.repo,
        sessionId: hit.sessionId,
        line: hit.line,
      });
      lines.push(`${locator}  [${hit.role}]${parent}`);
      lines.push(hit.text ?? '(message body unavailable -- the transcript file was removed)');
      lines.push('');
    }
  }

  // Required, not decorative. "BM25 + semantic" over 8% of an archive is a different claim
  // from the same words over all of it, and only one justifies trusting a near-miss.
  for (const entry of coverage) {
    const semantic = entry.embedded === 0 && !embedder
      ? ' (semantic off: search.vector.enabled is false)'
      : '';
    lines.push(`Coverage [${entry.repo}]: ${entry.embedded}/${entry.indexed} messages embedded${semantic}.`);
  }
  for (const entry of skipped) {
    lines.push(`Skipped [${entry.repo}]: ${entry.reason}.`);
  }

  lines.push('If you used any of this, store it with knowl_store so the next session does not have to dig for it again.');
  return truncate(lines.join('\n'), MAX_RESPONSE_CHARS);
}

export async function handleTranscriptRead(input: {
  config: ProjectConfig | null;
  projectRoot: string | null;
  locator: string;
  context?: number;
}): Promise<string> {
  const { config, projectRoot } = input;
  if (!config || !projectRoot || !isTranscriptSearchEnabled(config)) return DISABLED_MESSAGE;

  const parsed = parseLocator(input.locator);
  if (!parsed) {
    return `Malformed locator "${input.locator}". Expected transcript://<repo>/<session>#L<line>, exactly as knowl_transcript_search returned it.`;
  }

  const context = clampInteger(input.context, 2, 0, MAX_CONTEXT);
  const workspace = await resolveWorkspace(projectRoot, config).catch(() => null);
  const localRepo = workspace?.repo ?? 'local';

  // Resolve the owning repo's root before resolving the session's file. A locator from another
  // repo must not be looked up against this one's transcripts.
  let root = projectRoot;
  const isPeer = parsed.repo !== null && parsed.repo !== localRepo;

  if (isPeer) {
    const peer = workspace?.peers.find(candidate => candidate.name === parsed.repo);
    if (!peer) return `Unknown repo "${parsed.repo}" in locator. It is not a linked workspace repo.`;

    const peerRoot = (peer as { path?: string; root?: string }).path ?? (peer as { root?: string }).root;
    if (!peerRoot) return `Cannot locate repo "${parsed.repo}" on disk.`;

    // Re-check sharing here, not only at search time. A locator is a durable string: it can be
    // cached from an earlier turn, pasted, or fabricated. Trusting "it is a linked repo" would
    // mean revoking `share` stops new searches while old locators keep working, which is not
    // revocation at all.
    const peerConfig = await loadConfig(peerRoot).catch(() => null);
    if (!peerConfig || !isTranscriptSharingEnabled(peerConfig)) {
      return `Repo "${parsed.repo}" is not sharing its transcripts. Nothing to read.`;
    }
    root = peerRoot;
  }

  const client = await openTranscriptDb(resolveStorage(root).transcripts, { readOnly: isPeer });

  // `%` and `_` are LIKE wildcards, and a session id is agent-supplied. Escaping them keeps a
  // prefix a prefix rather than a pattern that matches something else entirely.
  const escaped = parsed.sessionId.replace(/[\\%_]/g, character => `\\${character}`);
  const matches = (await client.execute({
    sql: `SELECT DISTINCT session_id, path FROM transcript_messages
          WHERE session_id = ? OR session_id LIKE ? ESCAPE '\\'
          LIMIT 5`,
    args: [parsed.sessionId, `${escaped}%`],
  })).rows;

  if (matches.length === 0) return `No indexed session matches "${parsed.sessionId}".`;

  // An exact id always wins; otherwise an ambiguous prefix must say so rather than silently
  // picking whichever row the database returned first.
  const exact = matches.find(row => String(row.session_id) === parsed.sessionId);
  if (!exact && matches.length > 1) {
    const names = matches.map(row => String(row.session_id)).join(', ');
    return `Session prefix "${parsed.sessionId}" is ambiguous: ${names}. Use a longer prefix.`;
  }
  const row = exact ?? matches[0];

  const excerpts = await readWithContext(String(row.path), parsed.line, context);
  if (excerpts.length === 0) {
    return `Nothing readable at ${input.locator}. The transcript file has probably been deleted; its rows are dropped on the next index pass.`;
  }

  return truncate(
    excerpts
      .map(excerpt => `${excerpt.line === parsed.line ? '>' : ' '} [${excerpt.role}] ${excerpt.text}`)
      .join('\n\n'),
    MAX_RESPONSE_CHARS,
  );
}
```

- [ ] **Step 4c: Dispatch to them**

In `src/mcp/tools.ts`, add both branches to the call dispatcher. Each re-checks the gate, because a client that cached an older tool list can still call:

```typescript
    if (name === 'knowl_transcript_search') {
      const text = await handleTranscriptSearch({
        config: getConfig(),
        projectRoot: getProjectRoot(),
        query: String(args.query ?? ''),
        sessionId: args.sessionId ? String(args.sessionId) : undefined,
        repos: Array.isArray(args.repos) ? args.repos.map(String) : undefined,
        limit: typeof args.limit === 'number' ? args.limit : undefined,
      });
      return { content: [{ type: 'text', text }] };
    }

    if (name === 'knowl_transcript_read') {
      const text = await handleTranscriptRead({
        config: getConfig(),
        projectRoot: getProjectRoot(),
        locator: String(args.locator ?? ''),
        context: typeof args.context === 'number' ? args.context : undefined,
      });
      return { content: [{ type: 'text', text }] };
    }
```

Match the surrounding handlers' exact return shape — read two neighbours before writing these, and use whatever result helper they use rather than the literal above if one exists.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/transcripts/locator.test.ts tests/transcripts/mcp-gating.test.ts tests/transcripts/mcp-handlers.test.ts`
Expected: PASS, 7 + 10 + 9 tests

Three groups matter most. The `MCP surface` tests exercise a real `tools/list` and `tools/call`, which is where "off by default" either holds or does not. The round-trip test catches a search result that cannot be read. And the authorization tests catch a locator outliving the sharing flag that authorized it.

Note that JSON Schema `minimum`/`maximum` in the tool definitions is advisory — the MCP SDK does not necessarily enforce it, which is why `clampInteger` exists and is tested separately.

Run: `npx vitest run tests/core/knowl-guidance.test.ts tests/mcp/server.test.ts`
Expected: PASS **with no edits to either file**. `tests/core/knowl-guidance.test.ts:63-64` asserts the cards are exactly 1,695 and 1,746 characters, and `tests/mcp/server.test.ts:141` asserts the handshake returns `KNOWL_MCP_SERVER_INSTRUCTIONS` verbatim. Those are the off-by-default guarantee stated as tests. If either fails, the change leaked into the disabled path — fix the code, do not update the assertion.

- [ ] **Step 6: Commit**

```bash
git add src/transcripts/locator.ts src/transcripts/mcp-handlers.ts src/mcp/tools.ts \
        src/mcp/server.ts src/core/knowl-guidance.ts \
        tests/transcripts/locator.test.ts tests/transcripts/mcp-gating.test.ts \
        tests/transcripts/mcp-handlers.test.ts
git commit -m "feat(transcripts): expose the two MCP tools behind the enabled gate"
```

---

## Self-review notes

**Spec coverage.** §1 config gate → Task 1; disable-deletes-database → Task 12. §2 separate database → Task 4; concurrency → Task 4b. §3 prose only → Task 3, enforced by `extractProse`. §3a subagents → Task 2. §3b git worktree roots → Task 2. §4 pointers → Task 4 schema (no body column) plus Task 6 read-back. §5 byte-offset resume and atomic watermark → Task 5; all three triggers — backfill (Task 10), hook (Task 12), search top-up (Task 13) — index and embed. §6 BM25 + whole-corpus semantic + RRF → Tasks 7–9. §7 coverage and promotion nudge → Tasks 9 and 13. §8 workspace sharing and federation contract → Task 11. §9 locators → Task 13.

**Deferred deliberately.** The spec's `knowl config` toggle ships in Task 1 as schema entries; if the editor needs a `ConfigCategory` addition beyond `Search`, do it there rather than in a later task.

## Revision history

**Round 1 — self-review.** The MCP task originally assumed a `buildGuidanceCard(config)` function. No such function exists: the cards are module-level constants built by a private renderer, the compact card's Route section is hand-written rather than generated from `KNOWL_MCP_TOOL_GROUPS`, and two existing tests assert the cards' exact byte lengths. Rewritten against the real API; those length assertions now serve as the off-by-default guarantee.

**Round 2 — external review (Codex).** Nine blockers, all confirmed against this machine:

| | Was | Now |
|---|---|---|
| Crash safety | Rows committed, watermark written after → a crash replays lines into `UNIQUE(path, line)` | One transaction per batch, watermark included (Task 5) |
| I/O | Whole-file read per message; ~11 GB per backfill, budgets unenforceable | Streaming parser + `readMessagesAt` batched by file (Tasks 3, 6, 9) |
| Worktrees | Matched `<encoded-root>-worktrees-*`, a convention inferred from one directory | `git worktree list` (Task 2) — this repo's worktree is on another drive |
| Disable | Never deleted the database | `removeTranscriptIndex` on every config mutation path (Task 12) |
| Catch-up | Indexed but never embedded, so coverage decayed silently | Both halves under one deadline (Task 12) |
| Concurrency | `busy_timeout` only; two writers could race the watermark | `withWriteRetry` with `BUSY_SNAPSHOT` reconnect + in-transaction watermark re-read (Tasks 4b, 5) |
| MCP read | `(sessionId, line)` — insufficient to resolve a file, ambiguous across repos | `transcript://<repo>/<session>#L<line>` locators (Task 13) |
| Dispatcher | Left as pseudocode, violating this plan's own No Placeholders rule | Written out; gating tested through real `tools/list` and `tools/call` (Task 13) |
| Federation | Dropped coverage; sorted incomparable cross-repo RRF scores | Per-repo coverage; second RRF over positions with repo-qualified keys (Task 11) |

Also settled: "excludes pasted file bodies" was unenforceable and is now narrowed to exclusion by block type (spec §3), and semantic transcript ranking follows `search.vector.enabled` by decision rather than by accident (Task 10).

**Round 3 — external review (Codex).** Ten more, all confirmed:

| | Was | Now |
|---|---|---|
| Local locators | Federation tagged local hits too, so search emitted `transcript://local/...` and read answered "Unknown repo" — no local hit was readable | `localRepo` returned and omitted when formatting; read also resolves the local name locally (Tasks 11, 13) |
| Revocation | Read checked only that a repo was *linked*, so a cached locator outlived `share: false` | `share` re-checked on every read (Task 13) |
| Search top-up | Spec required it; nothing called it | `catchUpTranscripts` with a 1s budget and `closeWhenDone: false` (Task 13) |
| Retry scope | Deletion, final watermark and embedding bypassed retry; `runIndexPass` held a client that reconnection closed | Everything routes through `withWriteRetry`; no handle spans the boundary (Tasks 5, 9) |
| Concurrency test | Both "writers" shared one cached client, so it contended for nothing | Raw `createClient` connections, plus a reconnect-invalidation test (Task 4b) |
| Teardown | Wired only into the interactive editor; a corrupt database was never deleted | `applyTranscriptConfigTransition` across editor, `config set`, `config reset`; existence decides, counting only reports (Task 12) |
| Cutoff bias | Every rank-1 ties, stable sort kept insertion order, so `limit: 1` always returned local | Hash tiebreak on repo-qualified identity; tested at `limit: 1` with reversed peer order (Task 9) |
| Input bounds | `limit` and `context` unbounded and unclamped | `clampInteger` plus query-length and response-size caps; schema bounds treated as advisory (Task 13) |
| Locator safety | `decodeURIComponent` could throw despite a null-not-throw contract; `LIKE` prefix unescaped and `LIMIT 1` picked arbitrarily | Escapes caught; `%`/`_` escaped with `ESCAPE`; ambiguous prefixes named rather than guessed (Tasks 13) |
| Context semantics | Counted physical lines, so tool output between turns made `context: 2` return the target alone | Counts prose turns in one streaming pass (Task 6) |

**Pushed back on one item.** The review noted the plan reports dead pointers rather than dropping their rows during a read, as the spec's failure table said. The spec was wrong, not the plan: a peer's database is opened `query_only`, so the write is impossible there, and a search that mutates the index takes a write lock for a read operation — the contention §2 exists to avoid. The spec now says dead pointers are reported on read and reclaimed by the next index pass.

Task order changed twice for real forward dependencies: federation ahead of MCP (round 2), then lifecycle ahead of MCP (round 3, since the search top-up calls `catchUpTranscripts`).

**Verified on this machine, not assumed:** SQLite 3.45.1 with working `contentless_delete=1` and `snippet()` returning null on a contentless table; card sizes 1,695 / 1,746 chars and 24 tools; 3,717 prose messages in 2.2 MB across 75 transcript files, 52 of them nested subagent files; prose is 2.7% of the archive by bytes; the live worktree at `C:/Users/Admin/AppData/Local/Temp/claude/knowl-pr7`; and across 8 sessions, 2,005 `tool_result` blocks against 126 `text` blocks with exactly one string user message over 4,000 characters.
