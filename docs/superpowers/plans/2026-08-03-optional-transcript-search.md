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

Finds which `.jsonl` files belong to this repo. Two things make this non-obvious and both are load-bearing: worktrees get their own top-level directory, and subagent transcripts are nested one level deep under the parent session's UUID.

**Files:**
- Create: `src/transcripts/paths.ts`
- Test: `tests/transcripts/paths.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `encodeProjectDir(projectRoot: string): string`
  - `type TranscriptFile = { path: string; sessionId: string; parentSessionId: string | null }`
  - `discoverTranscriptFiles(projectRoot: string, options?: { projectsDir?: string }): Promise<TranscriptFile[]>`

- [ ] **Step 1: Write the failing test**

Create `tests/transcripts/paths.test.ts`:

```typescript
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { discoverTranscriptFiles, encodeProjectDir } from '../../src/transcripts/paths.js';

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

  it('includes worktree directories of the same repo', async () => {
    await write('d--coding-knowl/main.jsonl');
    await write('D--coding-knowl-worktrees-pr-6/wt.jsonl');

    const found = await discoverTranscriptFiles('d:\\coding\\knowl', { projectsDir });

    expect(found.map(f => f.sessionId).sort()).toEqual(['main', 'wt']);
  });

  it('excludes a different repo whose name merely shares a prefix', async () => {
    await write('d--coding-knowl/main.jsonl');
    await write('d--coding-knowl-cloud/other.jsonl');

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/transcripts/paths.test.ts`
Expected: FAIL — `Cannot find module '../../src/transcripts/paths.js'`

Note the two tests that encode the real trap: `d--coding-knowl-cloud` is a **different repo**, while `D--coding-knowl-worktrees-pr-6` is **this repo**. Both share the prefix `d--coding-knowl`, so a plain `startsWith` is wrong. The rule below is `startsWith(encoded + '-worktrees-')` plus exact match.

- [ ] **Step 3: Write the implementation**

Create `src/transcripts/paths.ts`:

```typescript
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

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

/**
 * Whether `candidate` is this repo's transcript directory.
 *
 * Case-insensitive because the drive letter's case is not stable -- the same repo has produced
 * both `d--coding-knowl` and `D--coding-knowl-worktrees-pr-6`.
 *
 * A worktree lives at `<root>/worktrees/<name>`, which encodes to `<encoded>-worktrees-<name>`.
 * Matching on the bare prefix instead would swallow `d--coding-knowl-cloud`, a different repo.
 */
function belongsToRepo(candidate: string, encodedRoot: string): boolean {
  const name = candidate.toLowerCase();
  const root = encodedRoot.toLowerCase();
  return name === root || name.startsWith(`${root}-worktrees-`);
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
 */
export async function discoverTranscriptFiles(
  projectRoot: string,
  options: { projectsDir?: string } = {},
): Promise<TranscriptFile[]> {
  const projectsDir = options.projectsDir ?? defaultProjectsDir();
  const encodedRoot = encodeProjectDir(path.resolve(projectRoot));
  const found: TranscriptFile[] = [];

  for (const repoDir of await readDirSafe(projectsDir)) {
    if (!repoDir.isDirectory() || !belongsToRepo(repoDir.name, encodedRoot)) continue;
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
Expected: PASS, 8 tests

- [ ] **Step 5: Commit**

```bash
git add src/transcripts/paths.ts tests/transcripts/paths.test.ts
git commit -m "feat(transcripts): discover session files including worktrees and subagents"
```

---

### Task 3: Prose extraction

Streams a `.jsonl` and yields only what a person said, with the byte offset and line number needed to resume and to point back.

**Files:**
- Create: `src/transcripts/parse.ts`
- Test: `tests/transcripts/parse.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `type ProseMessage = { line: number; role: 'user' | 'assistant'; text: string; timestamp: string | null }`
  - `extractProse(entry: unknown): { role: 'user' | 'assistant'; text: string; timestamp: string | null } | null`
  - `readProseFrom(filePath: string, startByte: number, startLine: number): Promise<{ messages: ProseMessage[]; bytesRead: number; linesRead: number }>`

- [ ] **Step 1: Write the failing test**

Create `tests/transcripts/parse.test.ts`:

```typescript
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { extractProse, readProseFrom } from '../../src/transcripts/parse.js';

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/transcripts/parse.test.ts`
Expected: FAIL — `Cannot find module '../../src/transcripts/parse.js'`

- [ ] **Step 3: Write the implementation**

Create `src/transcripts/parse.ts`:

```typescript
import fs from 'node:fs/promises';

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

/**
 * Read prose from `startByte`, continuing line numbering from `startLine`.
 *
 * Returns the byte offset of the last complete line rather than the file length. A transcript
 * being appended to while this runs will have a partial final record; committing a watermark
 * past it would skip that message forever once the rest arrives.
 */
export async function readProseFrom(
  filePath: string,
  startByte: number,
  startLine: number,
): Promise<{ messages: ProseMessage[]; bytesRead: number; linesRead: number }> {
  const handle = await fs.open(filePath, 'r');
  let buffer: Buffer;
  try {
    const stat = await handle.stat();
    const length = Math.max(0, stat.size - startByte);
    if (length === 0) return { messages: [], bytesRead: startByte, linesRead: startLine };
    buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, startByte);
  } finally {
    await handle.close();
  }

  const messages: ProseMessage[] = [];
  let line = startLine;
  let consumed = startByte;
  let cursor = 0;

  while (cursor < buffer.length) {
    const newline = buffer.indexOf(0x0a, cursor);
    if (newline === -1) break; // Partial trailing line: leave it for the next pass.

    const raw = buffer.subarray(cursor, newline).toString('utf8');
    cursor = newline + 1;
    consumed = startByte + cursor;
    line++;

    const trimmed = raw.trim();
    if (!trimmed) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      // One unreadable line must not cost the rest of the file.
      continue;
    }

    const prose = extractProse(parsed);
    if (prose) messages.push({ line, ...prose });
  }

  return { messages, bytesRead: consumed, linesRead: line };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/transcripts/parse.test.ts`
Expected: PASS, 10 tests

- [ ] **Step 5: Commit**

```bash
git add src/transcripts/parse.ts tests/transcripts/parse.test.ts
git commit -m "feat(transcripts): stream prose out of session jsonl with resumable offsets"
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

### Task 5: Incremental index pass

Walks discovered files, indexes new prose from each watermark, handles rewrites and deletions, and respects a time budget.

**Files:**
- Create: `src/transcripts/index-pass.ts`
- Test: `tests/transcripts/index-pass.test.ts`

**Interfaces:**
- Consumes: `discoverTranscriptFiles` (Task 2), `readProseFrom` (Task 3), `openTranscriptDb` (Task 4)
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
import { openTranscriptDb } from './database.js';
import { readProseFrom } from './parse.js';
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

async function readFileState(client: Client, filePath: string): Promise<FileState | null> {
  const rows = (await client.execute({
    sql: 'SELECT bytes_indexed, lines_indexed, size_at_index FROM transcript_files WHERE path = ?',
    args: [filePath],
  })).rows;
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
async function dropFileRows(client: Client, filePath: string): Promise<void> {
  const ids = (await client.execute({
    sql: 'SELECT id FROM transcript_messages WHERE path = ?',
    args: [filePath],
  })).rows.map(row => Number(row.id));

  for (let start = 0; start < ids.length; start += WRITE_BATCH) {
    const slice = ids.slice(start, start + WRITE_BATCH);
    await client.execute('BEGIN');
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
  }

  await client.execute({ sql: 'DELETE FROM transcript_messages WHERE path = ?', args: [filePath] });
}

async function indexOneFile(
  client: Client,
  file: TranscriptFile,
  size: number,
  state: FileState | null,
): Promise<{ indexed: number; rebuilt: boolean }> {
  // A file that shrank was rewritten, not appended to. Its old line numbers no longer point
  // anywhere, so the only safe move is to rebuild it.
  const rewritten = state !== null && size < state.bytesIndexed;
  if (rewritten) await dropFileRows(client, file.path);

  const from = rewritten || !state ? { bytes: 0, lines: 0 } : { bytes: state.bytesIndexed, lines: state.linesIndexed };
  const { messages, bytesRead, linesRead } = await readProseFrom(file.path, from.bytes, from.lines);

  for (let start = 0; start < messages.length; start += WRITE_BATCH) {
    const slice = messages.slice(start, start + WRITE_BATCH);
    await client.execute('BEGIN');
    try {
      for (const message of slice) {
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
      await client.execute('COMMIT');
    } catch (error) {
      await client.execute('ROLLBACK').catch(() => {});
      throw error;
    }
  }

  await client.execute({
    sql: `INSERT INTO transcript_files (path, session_id, parent_session_id, bytes_indexed, lines_indexed, size_at_index, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(path) DO UPDATE SET
            bytes_indexed = excluded.bytes_indexed,
            lines_indexed = excluded.lines_indexed,
            size_at_index = excluded.size_at_index,
            updated_at = excluded.updated_at`,
    args: [file.path, file.sessionId, file.parentSessionId, bytesRead, linesRead, size, new Date().toISOString()],
  });

  return { indexed: messages.length, rebuilt: rewritten };
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
  const client = await openTranscriptDb(input.dbPath);
  const files = await discoverTranscriptFiles(input.projectRoot, { projectsDir: input.projectsDir });
  const onDisk = new Set(files.map(file => file.path));

  const result: IndexPassResult = { indexed: 0, rebuilt: 0, removed: 0, filesTouched: 0, complete: true };

  // Deleted transcripts first: their pointers are dead, and a search that returns them wastes a
  // file read to discover it. Cheap when nothing vanished, which is the usual case.
  const known = (await client.execute('SELECT path FROM transcript_files')).rows.map(row => String(row.path));
  for (const knownPath of known) {
    if (onDisk.has(knownPath)) continue;
    await dropFileRows(client, knownPath);
    await client.execute({ sql: 'DELETE FROM transcript_files WHERE path = ?', args: [knownPath] });
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

    const state = await readFileState(client, file.path);
    if (state && size === state.sizeAtIndex && size === state.bytesIndexed) continue;

    const { indexed, rebuilt } = await indexOneFile(client, file, size, state);
    result.indexed += indexed;
    result.filesTouched++;
    if (rebuilt) result.rebuilt++;
  }

  return result;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/transcripts/index-pass.test.ts`
Expected: PASS, 9 tests

- [ ] **Step 5: Commit**

```bash
git add src/transcripts/index-pass.ts tests/transcripts/index-pass.test.ts
git commit -m "feat(transcripts): incremental index pass with rewrite and deletion handling"
```

---

### Task 6: Reading messages back from disk

The counterpart to storing pointers. A hit is `(path, line)`; this turns it into text.

**Files:**
- Create: `src/transcripts/read.ts`
- Test: `tests/transcripts/read.test.ts`

**Interfaces:**
- Consumes: `extractProse` (Task 3)
- Produces:
  - `type TranscriptExcerpt = { line: number; role: 'user' | 'assistant'; text: string; timestamp: string | null }`
  - `readMessageAt(filePath: string, line: number): Promise<TranscriptExcerpt | null>`
  - `readWithContext(filePath: string, line: number, context: number): Promise<TranscriptExcerpt[]>`

- [ ] **Step 1: Write the failing test**

Create `tests/transcripts/read.test.ts`:

```typescript
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readMessageAt, readWithContext } from '../../src/transcripts/read.js';

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
import fs from 'node:fs/promises';
import { extractProse } from './parse.js';

export type TranscriptExcerpt = {
  line: number;
  role: 'user' | 'assistant';
  text: string;
  timestamp: string | null;
};

/**
 * Prose from a line range, 1-indexed and inclusive.
 *
 * Reads the whole file. Transcripts are single-digit megabytes and this runs once per search
 * result set, not per candidate -- the ranking never touches disk.
 */
async function readRange(filePath: string, from: number, to: number): Promise<TranscriptExcerpt[]> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf8');
  } catch {
    // The transcript was deleted since it was indexed. A dead pointer is a miss, not an error;
    // the next index pass drops its rows.
    return [];
  }

  const excerpts: TranscriptExcerpt[] = [];
  const lines = raw.split('\n');
  for (let index = from - 1; index <= to - 1 && index < lines.length; index++) {
    if (index < 0) continue;
    const text = lines[index]?.trim();
    if (!text) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      continue;
    }
    const prose = extractProse(parsed);
    if (prose) excerpts.push({ line: index + 1, ...prose });
  }
  return excerpts;
}

export async function readMessageAt(filePath: string, line: number): Promise<TranscriptExcerpt | null> {
  const excerpts = await readRange(filePath, line, line);
  return excerpts[0] ?? null;
}

export async function readWithContext(
  filePath: string,
  line: number,
  context: number,
): Promise<TranscriptExcerpt[]> {
  return readRange(filePath, Math.max(1, line - context), line + context);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/transcripts/read.test.ts`
Expected: PASS, 7 tests

- [ ] **Step 5: Commit**

```bash
git add src/transcripts/read.ts tests/transcripts/read.test.ts
git commit -m "feat(transcripts): read message bodies back from the source jsonl"
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

**Interfaces:**
- Consumes: `lexicalRank`, `TranscriptHit` (Task 7), `quantizeVector`, `dotQuantized` (Task 8), `KnowledgeEmbedder` from `src/store/vector-index.js`
- Produces:
  - `RRF_K = 60`
  - `fuseRankings(rankings: TranscriptHit[][], limit: number): TranscriptHit[]`
  - `semanticRank(client: Client, queryVector: number[], fingerprint: string, limit: number, sessionId?: string): Promise<TranscriptHit[]>`
  - `searchTranscripts(input: SearchInput): Promise<{ hits: TranscriptHit[]; coverage: { embedded: number; indexed: number } }>`
  - `embedPendingMessages(input: { client: Client; embedder: KnowledgeEmbedder; deadline?: number }): Promise<{ embedded: number; complete: boolean }>`

- [ ] **Step 1: Write the failing test**

Create `tests/transcripts/search-semantic.test.ts`:

```typescript
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
  if (embedder) await embedPendingMessages({ client, embedder });
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

    const second = await embedPendingMessages({ client, embedder: stubEmbedder() });

    expect(second.embedded).toBe(0);
    expect(second.complete).toBe(true);
  });

  it('drops vectors belonging to a superseded model', async () => {
    await seed('a', line('user', 'memory note'));
    const client = await buildIndex(stubEmbedder());

    const other: KnowledgeEmbedder = { ...stubEmbedder(), profileFingerprint: 'stub:different' };
    await embedPendingMessages({ client, embedder: other });

    const rows = (await client.execute('SELECT DISTINCT fingerprint FROM transcript_vectors')).rows;
    expect(rows.map(r => String(r.fingerprint))).toEqual(['stub:different']);
  });

  it('stops at a deadline and reports itself incomplete', async () => {
    await seed('a', Array.from({ length: 5 }, (_, i) => line('user', `memory note ${i}`)).join(''));
    await runIndexPass({ projectRoot: PROJECT_ROOT, dbPath, projectsDir });
    const client = await openTranscriptDb(dbPath);

    const result = await embedPendingMessages({ client, embedder: stubEmbedder(), deadline: Date.now() - 1 });

    expect(result.complete).toBe(false);
    expect(result.embedded).toBe(0);
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
import { quantizeVector } from './quantize.js';
import { readMessageAt } from './read.js';

/** Messages per embedding call. The provider re-batches by text length underneath. */
const EMBED_BATCH = 32;

/**
 * Give every indexed message a vector under the embedder's current profile.
 *
 * Resumable by construction: "messages with no vector for this fingerprint" *is* the resume
 * state, so an interrupted pass leaves no bookkeeping to repair. Newest first, so the session
 * you are in is covered before the archive's tail.
 */
export async function embedPendingMessages(input: {
  client: Client;
  embedder: KnowledgeEmbedder;
  /** `Date.now()` value after which the pass stops between batches. */
  deadline?: number;
}): Promise<{ embedded: number; complete: boolean }> {
  const { client, embedder } = input;

  // Vectors from a superseded model are a full dead duplicate of the archive, not a few stale
  // rows -- there is one vector per message, not per re-ranked candidate.
  await client.execute({
    sql: 'DELETE FROM transcript_vectors WHERE fingerprint <> ?',
    args: [embedder.profileFingerprint],
  });

  let embedded = 0;

  for (;;) {
    if (input.deadline !== undefined && Date.now() >= input.deadline) {
      return { embedded, complete: false };
    }

    const pending = (await client.execute({
      sql: `SELECT m.id, m.path, m.line
            FROM transcript_messages m
            LEFT JOIN transcript_vectors v ON v.message_id = m.id
            WHERE v.message_id IS NULL
            ORDER BY m.id DESC
            LIMIT ?`,
      args: [EMBED_BATCH],
    })).rows;

    if (pending.length === 0) return { embedded, complete: true };

    const targets: Array<{ id: number; text: string }> = [];
    for (const row of pending) {
      const excerpt = await readMessageAt(String(row.path), Number(row.line));
      // A pointer whose file vanished cannot be embedded. Leave it; the next index pass
      // removes the row entirely.
      if (excerpt) targets.push({ id: Number(row.id), text: excerpt.text });
    }

    if (targets.length === 0) return { embedded, complete: true };

    const vectors = await embedder.embed(targets.map(target => target.text));

    await client.execute('BEGIN');
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
  }
}
```

- [ ] **Step 4: Append fusion and the search entry point**

Add to the end of `src/transcripts/search.ts`:

```typescript
import type { KnowledgeEmbedder } from '../store/vector-index.js';
import { dotQuantized } from './quantize.js';
import { readMessageAt } from './read.js';

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
export function fuseRankings(rankings: TranscriptHit[][], limit: number): TranscriptHit[] {
  const scores = new Map<number, number>();
  const byId = new Map<number, TranscriptHit>();

  for (const ranking of rankings) {
    ranking.forEach((hit, index) => {
      scores.set(hit.messageId, (scores.get(hit.messageId) ?? 0) + 1 / (RRF_K + index + 1));
      if (!byId.has(hit.messageId)) byId.set(hit.messageId, hit);
    });
  }

  return [...scores.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, limit)
    .map(([messageId, score]) => ({ ...byId.get(messageId)!, score }));
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

  // Bodies are read only for what is actually returned -- ranking never touches disk.
  for (const hit of fused) {
    const excerpt = await readMessageAt(hit.path, hit.line);
    if (excerpt) hit.text = excerpt.text;
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
Expected: PASS, 11 tests

The first `searchTranscripts` test is the one that matters: it queries `OOM`, a token absent from the entire corpus, and still returns the memory-exhaustion message. Delete `semanticRank` from the fusion and it fails.

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

**Interfaces:**
- Consumes: `runIndexPass` (Task 5), `embedPendingMessages` (Task 9), `isTranscriptSearchEnabled` (Task 1)
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
    const client = await openTranscriptDb(dbPath);
    const result = await embedPendingMessages({ client, embedder, deadline });
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

### Task 11: MCP tools, registered only when enabled

**Files:**
- Modify: `src/mcp/tools.ts` (the `ListToolsRequestSchema` handler and the call dispatcher)
- Modify: `src/core/knowl-guidance.ts:92-109`
- Modify: `src/mcp/server.ts:36`
- Test: `tests/transcripts/mcp-gating.test.ts`

**Interfaces:**
- Consumes: `isTranscriptSearchEnabled` (Task 1), `searchTranscripts` (Task 9), `readWithContext` (Task 6)
- Produces: MCP tools `knowl_transcript_search` and `knowl_transcript_read`; `mcpServerInstructions(config: ProjectConfig | null): string` in `knowl-guidance.ts`

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
              query: { type: 'string', description: 'What to look for, in your own words. Semantic search covers the whole archive, so the exact wording need not match.' },
              sessionId: { type: 'string', description: 'Restrict to one session. Accepts a full id or a unique prefix.' },
              repos: { type: 'array', items: { type: 'string' }, description: 'Restrict to these linked workspace repos. Omit to search this repo only.' },
              limit: { type: 'number', description: 'Maximum hits; defaults to 5.' },
            },
            required: ['query'],
          },
        },
        {
          name: 'knowl_transcript_read',
          description: 'Read one transcript message and the turns around it, using a locator returned by knowl_transcript_search.',
          inputSchema: {
            type: 'object',
            properties: {
              sessionId: { type: 'string', description: 'Session id from a search hit.' },
              line: { type: 'number', description: 'Line number from a search hit.' },
              context: { type: 'number', description: 'Turns to include on each side; defaults to 2.' },
            },
            required: ['sessionId', 'line'],
          },
        },
      );
    }

    return { tools };
```

In the call dispatcher, add both handlers. Each must re-check the gate — a client that cached an older tool list could still call them:

```typescript
    if (name === 'knowl_transcript_search' || name === 'knowl_transcript_read') {
      const config = getConfig();
      const projectRoot = getProjectRoot();
      if (!config || !projectRoot || !isTranscriptSearchEnabled(config)) {
        return textResult('Transcript search is not enabled for this repository. Enable search.transcripts.enabled with `knowl config`, then run `knowl reindex --transcripts`.');
      }
      // ...dispatch to searchTranscripts / readWithContext, formatting each hit as
      // `transcript://<sessionId>#L<line>` followed by its text, and appending the
      // coverage line `Semantic coverage: <embedded>/<indexed> messages.`
    }
```

The coverage line is required, not decorative: "BM25 + semantic" over 8% of an archive is a different claim from the same words over all of it, and only one of them justifies trusting a near-miss.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/transcripts/mcp-gating.test.ts`
Expected: PASS, 6 tests

Run: `npx vitest run tests/core/knowl-guidance.test.ts tests/mcp/server.test.ts`
Expected: PASS **with no edits to either file**. `tests/core/knowl-guidance.test.ts:63-64` asserts the cards are exactly 1,695 and 1,746 characters, and `tests/mcp/server.test.ts:141` asserts the handshake returns `KNOWL_MCP_SERVER_INSTRUCTIONS` verbatim. Those are the off-by-default guarantee stated as tests. If either fails, the change leaked into the disabled path — fix the code, do not update the assertion.

- [ ] **Step 6: Commit**

```bash
git add src/mcp/tools.ts src/core/knowl-guidance.ts tests/transcripts/mcp-gating.test.ts
git commit -m "feat(transcripts): register the two MCP tools only when the feature is on"
```

---

### Task 12: Keep the index current from the lifecycle hook

**Files:**
- Modify: `src/index.ts:1552-1580` (the `agent-hook` command action)
- Create: `src/transcripts/catch-up.ts`
- Test: `tests/transcripts/catch-up.test.ts`

**Interfaces:**
- Consumes: `runIndexPass` (Task 5), `isTranscriptSearchEnabled` (Task 1)
- Produces: `catchUpTranscripts(projectRoot: string, options?: { budgetMs?: number; projectsDir?: string }): Promise<{ indexed: number } | null>`

- [ ] **Step 1: Write the failing test**

Create `tests/transcripts/catch-up.test.ts`:

```typescript
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { catchUpTranscripts } from '../../src/transcripts/catch-up.js';
import { closeTranscriptDbs } from '../../src/transcripts/database.js';

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

async function writeConfig(enabled: boolean) {
  await fs.writeFile(
    path.join(dir, '.knowl', 'config.json'),
    JSON.stringify({ version: 1, security: { rejectSecrets: true, secretPatterns: [] }, search: { transcripts: { enabled } } }),
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
 * Bring the index up to date at the end of an agent turn.
 *
 * Once per turn rather than once per message: transcripts are append-only, so catching up twenty
 * messages costs the same as catching up one, and a write every few seconds is exactly what
 * produced the SQLITE_BUSY failures this design separates databases to avoid.
 *
 * Returns null when the feature is off, and swallows every failure. This runs inside a lifecycle
 * hook; an optional index must never be the reason a turn errors.
 */
export async function catchUpTranscripts(
  projectRoot: string,
  options: { budgetMs?: number; projectsDir?: string } = {},
): Promise<{ indexed: number } | null> {
  try {
    const config = await loadConfig(projectRoot);
    if (!isTranscriptSearchEnabled(config)) return null;

    const result = await runIndexPass({
      projectRoot,
      dbPath: resolveStorage(projectRoot).transcripts,
      projectsDir: options.projectsDir,
      deadline: Date.now() + (options.budgetMs ?? DEFAULT_BUDGET_MS),
    });
    return { indexed: result.indexed };
  } catch {
    return null;
  } finally {
    await closeTranscriptDbs().catch(() => {});
  }
}
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

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/transcripts/catch-up.test.ts`
Expected: PASS, 4 tests

Run: `npx vitest run tests/cli`
Expected: PASS — the hook path is exercised there and must be unaffected when the feature is off.

- [ ] **Step 6: Commit**

```bash
git add src/transcripts/catch-up.ts src/index.ts tests/transcripts/catch-up.test.ts
git commit -m "feat(transcripts): catch the index up once per agent turn"
```

---

### Task 13: Workspace fan-out

**Files:**
- Create: `src/transcripts/federate.ts`
- Modify: `src/mcp/tools.ts` (pass `repos` through to the federated search)
- Test: `tests/transcripts/federate.test.ts`

**Interfaces:**
- Consumes: `searchTranscripts` (Task 9), `openTranscriptDb` (Task 4), `isTranscriptSharingEnabled` (Task 1), `resolveWorkspace` / `ActiveWorkspace` from `src/workspace/resolve.js`
- Produces:
  - `type FederatedTranscriptHit = TranscriptHit & { repo: string }`
  - `searchTranscriptsFederated(input): Promise<{ hits: FederatedTranscriptHit[]; skipped: Array<{ repo: string; reason: 'absent' | 'not-shared' | 'unreadable' }> }>`

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
import { searchTranscripts, type TranscriptHit } from './search.js';

export type FederatedTranscriptHit = TranscriptHit & { repo: string };
export type TranscriptSkipReason = 'absent' | 'not-shared' | 'unreadable';

async function exists(target: string): Promise<boolean> {
  return fs.access(target).then(() => true).catch(() => false);
}

/**
 * Search this repo's transcripts and, where a peer has opted in, its linked repos'.
 *
 * Each repo owns its own `transcripts.db` and a peer's is opened read-only -- nothing is copied
 * and nothing is promoted, so revoking access is one config flag with no residue to chase.
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
}): Promise<{ hits: FederatedTranscriptHit[]; skipped: Array<{ repo: string; reason: TranscriptSkipReason }> }> {
  const localName = input.localRepoName ?? input.workspace?.repo ?? 'local';
  const wanted = input.repos?.length ? new Set(input.repos) : null;
  const skipped: Array<{ repo: string; reason: TranscriptSkipReason }> = [];
  const hits: FederatedTranscriptHit[] = [];

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
    for (const hit of result.hits) hits.push({ ...hit, repo });
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

  hits.sort((left, right) => right.score - left.score);
  return { hits: hits.slice(0, input.limit), skipped };
}
```

If `PeerRepo` in `src/workspace/resolve.ts` names its filesystem field something other than `path` or `root`, use that name directly and delete the fallback — read the type before writing this.

- [ ] **Step 4: Route the MCP tool through it**

In `src/mcp/tools.ts`, change the `knowl_transcript_search` handler to call `searchTranscriptsFederated` with the resolved workspace and the caller's `repos`, and render each hit as:

```
[<repo>] transcript://<sessionId>#L<line>  (<role>)
<text>
```

Append the coverage line, and one line per skipped repo, so an empty result is distinguishable from a repo that was never searched.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/transcripts/federate.test.ts`
Expected: PASS, 5 tests

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

## Self-review notes

**Spec coverage.** §1 config gate → Task 1. §2 separate database → Task 4. §3 prose only → Task 3, enforced by `extractProse`. §3a subagents → Task 2. §4 pointers → Task 4 schema (no body column) plus Task 6 read-back. §5 byte-offset resume → Task 5, triggers in Tasks 10 and 12. §6 BM25 + whole-corpus semantic + RRF → Tasks 7–9. §7 coverage and promotion nudge → Tasks 9 and 11. §8 workspace sharing → Task 13.

**Deferred deliberately.** The spec's `knowl config` toggle ships in Task 1 as schema entries; if the editor needs a `ConfigCategory` addition beyond `Search`, do it there rather than in a later task.

**Resolved during review.** Task 11 originally assumed a `buildGuidanceCard(config)` function. No such function exists: the cards are module-level constants built by a private renderer, the compact card's Route section is hand-written rather than generated from `KNOWL_MCP_TOOL_GROUPS`, and two existing tests assert the cards' exact byte lengths. Task 11 was rewritten against the real API and now treats those length assertions as the off-by-default guarantee rather than as obstacles to update.

**Verified, not assumed:** SQLite 3.45.1 with working `contentless_delete=1` and `snippet()` returning null on a contentless table (Task 4 depends on both); card sizes 1,695 / 1,746 chars and 24 tools, measured against the real module; 3,717 prose messages in 2.2 MB across 75 transcript files, 52 of them nested subagent files (Tasks 2 and 3).
