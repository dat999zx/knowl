# Knowl 3.0.1 Security Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the five defects that survived the 3.0.0 audit remediation — imported-skill path traversal, skill identity confusion, cross-namespace write misrouting, a viewer that any malformed URL can kill, and a snapshot restore that trusts an absent manifest.

**Architecture:** Five independent surfaces. Import anchors every path to a fixed base and moves filesystem writes out of the database transaction. Skill reads make the directory name the sole identity. The database handle moves from process-global variables into an `AsyncLocalStorage` scope so overlapping requests stop overwriting each other. The viewer gets an error boundary, a per-launch token, and response headers. Snapshot restore verifies a mandatory manifest and the attached file's own integrity before it destroys anything.

**Tech Stack:** TypeScript (ESM, `node:` builtins including `node:async_hooks`), vitest, `@libsql/client`, SQLite.

## Global Constraints

- Baseline is **3.0.0** at commit `8a8aae4`. Every line reference below was read from that tree; re-check with `grep` before editing if the tree has moved again.
- Node `>=22`; no `engines` change.
- No new runtime dependency.
- The CLI lives in `src/cli/program.ts` (2222 lines), **not** `src/index.ts` (36 lines). A `const skillCommand` already exists at `src/cli/program.ts:1884` — extend it, never redeclare it.
- Test roots follow the existing convention: `path.resolve('./.knowl-<name>-test')` or `path.resolve('.knowl-<name>-test')`, created in `beforeAll`, removed in `afterAll`.
- Skill names are governed by `SAFE_SKILL_NAME = /^[a-z0-9][a-z0-9_-]*$/` (`src/skills/registry.ts:75`). Do not loosen it.
- Use `KNOWL_SCHEMA_VERSION` from `src/store/schema-version.ts`; never hardcode `1`.
- Commit messages use Conventional Commits.
- Development host is Windows; CI is `ubuntu-latest`. Gate any platform-specific test with `it.skipIf` / `it.runIf`.

## Already fixed in 3.0.0 — do not redo

Confirmed by probe against `8a8aae4`, listed so nobody re-opens them:

- **Shell-argument injection.** `quoteShellArg` is gone; `runShell` takes no arguments and `runSkillPackage` throws when a shell entrypoint is given runtime arguments (`src/skills/registry.ts:322-326`).
- **Snapshot restore data loss.** `restoreStatements` (`src/store/snapshots.ts:112-139`) derives the table set from `sqlite_schema` plus `PRAGMA foreign_key_list` and inserts only columns shared with the snapshot. Probed: assertions 1→1, evidence links 1→1, post-snapshot item gone.
- **Batch-script argument injection.** `.cmd` and `.bat` entrypoints are refused outright (`src/skills/registry.ts:84-93`, CVE-2024-24576).
- **`autoRun` now defaults to `false`** (`src/skills/registry.ts:150,159`) and execution requires `autoRun === true`.

---

## File Structure

| File | Responsibility | Change |
| --- | --- | --- |
| `src/skills/registry.ts` | Skill package creation, reading, execution | Modify: export two validators; require directory/manifest name agreement |
| `src/store/portability.ts` | JSONL export/import | Modify: validated, staged skill installation outside the transaction |
| `src/store/database.ts` | Connection handle and scoping | Modify: scope the handle to the async context |
| `src/viewer/server.ts` | Local viewer | Modify: error boundary, access token, Host check, security headers |
| `src/store/snapshots.ts` | Snapshot create/restore | Modify: mandatory manifest, real `schemaVersion`, attached-file integrity preflight |
| `tests/store/import-skill-safety.test.ts` | Traversal and staging regressions | Create |
| `tests/skills/identity.test.ts` | Directory/manifest identity regression | Create |
| `tests/store/namespace-concurrency.test.ts` | Overlapping namespace switch regression | Create |
| `tests/viewer/server.test.ts` | Viewer resilience, token, headers | Modify |
| `tests/store/snapshot-verification.test.ts` | Manifest and integrity preflight | Create |

---

### Task 1: Anchor imported skill paths to a fixed base and move the writes out of the transaction

`importKnowledge` parses `skill_package` records without validating `skill.name`, then derives *both* the containment root and the target from that untrusted name (`src/store/portability.ts:540-546`). Because both sides of the `startsWith` check move together, `../../escape` passes it. Reproduced against 3.0.0: importing a hand-built JSONL stream with a valid checksum wrote `proof.txt` to `<projectRoot>/escape/proof.txt`. The SHA-256 manifest does not prevent this — whoever builds the export computes the checksum.

Those `fs.writeFile` calls also sit inside the open transaction (`BEGIN;` at line 472, `COMMIT;` at line 561). Filesystem writes do not roll back, so a later failure leaves files behind after the database reverts.

Contents are staged to a temporary directory **before** `BEGIN`, and installed by rename **after** `COMMIT`. Staging first means the post-commit step is a sequence of renames rather than writes, which is the cheapest thing that can still fail; a rename that does fail is reported rather than swallowed, because at that point the database is already committed and silence would be the worst outcome.

**Files:**
- Modify: `src/skills/registry.ts:104,110` (export the two validators)
- Modify: `src/store/portability.ts:457,472,540-546,561-564`
- Test: `tests/store/import-skill-safety.test.ts` (create)

**Interfaces:**
- Consumes: `SAFE_SKILL_NAME` behaviour from `src/skills/registry.ts`.
- Produces: `export function validateSkillName(name: string): void` and `export function normalizeSkillFilePath(filePath: string): string` from `src/skills/registry.ts`. New module-private `type SkillInstall = { target: string; content: string }` and `function planSkillInstalls(projectRoot: string, skills: any[]): SkillInstall[]` in `src/store/portability.ts`.

- [ ] **Step 1: Write the failing test**

Create `tests/store/import-skill-safety.test.ts`:

```ts
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, initDb } from '../../src/store/database.js';
import { importKnowledge } from '../../src/store/portability.js';

const TEST_ROOT = path.resolve('./.knowl-import-skill-safety-test');
const HEADER = { type: 'header', format: 'knowl-jsonl', version: 2, namespace: 'project' };

async function writeStream(name: string, records: unknown[]): Promise<string> {
  const body = `${records.map(record => JSON.stringify(record)).join('\n')}\n`;
  const sha256 = crypto.createHash('sha256').update(body).digest('hex');
  const streamPath = path.join(TEST_ROOT, name);
  await fs.writeFile(streamPath, `${body}${JSON.stringify({ type: 'manifest', sha256 })}\n`, 'utf8');
  return streamPath;
}

describe('imported skill package safety', () => {
  beforeAll(async () => {
    await fs.rm(TEST_ROOT, { recursive: true, force: true }).catch(() => {});
    await fs.mkdir(path.join(TEST_ROOT, '.knowl'), { recursive: true });
    await initDb(TEST_ROOT);
  });

  afterAll(async () => {
    await closeDb();
    await fs.rm(TEST_ROOT, { recursive: true, force: true }).catch(() => {});
  });

  it('rejects a skill name that escapes the skills directory', async () => {
    const streamPath = await writeStream('traversal-name.jsonl', [
      HEADER,
      { type: 'skill_package', name: '../../escape', files: [{ path: 'proof.txt', content: 'escaped' }] },
    ]);
    await expect(importKnowledge(streamPath, { projectRoot: TEST_ROOT })).rejects.toThrow(/skill name/i);
    await expect(fs.access(path.join(TEST_ROOT, 'escape', 'proof.txt'))).rejects.toThrow();
    await expect(fs.access(path.join(TEST_ROOT, '..', 'escape', 'proof.txt'))).rejects.toThrow();
  });

  it('rejects a skill file path that escapes its own package', async () => {
    const streamPath = await writeStream('traversal-file.jsonl', [
      HEADER,
      { type: 'skill_package', name: 'legit', files: [{ path: '../../../proof.txt', content: 'escaped' }] },
    ]);
    await expect(importKnowledge(streamPath, { projectRoot: TEST_ROOT })).rejects.toThrow(/skill file path/i);
    await expect(fs.access(path.join(TEST_ROOT, 'proof.txt'))).rejects.toThrow();
  });

  it('writes no skill file when any package in the stream is rejected', async () => {
    const streamPath = await writeStream('partial.jsonl', [
      HEADER,
      { type: 'skill_package', name: 'good_one', files: [{ path: 'ok.txt', content: 'fine' }] },
      { type: 'skill_package', name: 'BAD NAME', files: [{ path: 'ok.txt', content: 'fine' }] },
    ]);
    await expect(importKnowledge(streamPath, { projectRoot: TEST_ROOT })).rejects.toThrow(/skill name/i);
    await expect(fs.access(path.join(TEST_ROOT, '.knowl', 'skills', 'good_one', 'ok.txt'))).rejects.toThrow();
  });

  it('installs a well-formed skill package and leaves no staging directory', async () => {
    const streamPath = await writeStream('valid.jsonl', [
      HEADER,
      { type: 'skill_package', name: 'deploy_preview', files: [{ path: 'nested/run.sh', content: 'echo ok\n' }] },
    ]);
    const result = await importKnowledge(streamPath, { projectRoot: TEST_ROOT });
    expect(result.applied).toBe(true);
    const installed = path.join(TEST_ROOT, '.knowl', 'skills', 'deploy_preview', 'nested', 'run.sh');
    await expect(fs.readFile(installed, 'utf8')).resolves.toBe('echo ok\n');
    const leftovers = (await fs.readdir(path.join(TEST_ROOT, '.knowl')))
      .filter(entry => entry.startsWith('import-skills-'));
    expect(leftovers).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/store/import-skill-safety.test.ts`
Expected: FAIL — the first case does not throw, and `<TEST_ROOT>/escape/proof.txt` exists.

- [ ] **Step 3: Export the two validators**

In `src/skills/registry.ts`, add `export` to the declarations at lines 104 and 110 (bodies unchanged):

```ts
export function validateSkillName(name: string): void {
```

```ts
export function normalizeSkillFilePath(filePath: string): string {
```

- [ ] **Step 4: Add the install planner**

In `src/store/portability.ts`, add to the imports at the top of the file:

```ts
import { normalizeSkillFilePath, validateSkillName } from '../skills/registry.js';
```

Add this helper above `importKnowledge` (which begins at line 311):

```ts
type SkillInstall = { target: string; content: string };

/**
 * Every path anchored to one fixed base the record cannot influence.
 *
 * The previous check derived the containment root from the same untrusted `skill.name` as the
 * target, so both moved together and `../../escape` satisfied it. The name is now validated
 * with the same rule package creation uses -- no dots, no separators -- which makes traversal
 * unrepresentable rather than merely detected, and the base is computed once outside the loop.
 */
function planSkillInstalls(projectRoot: string, skills: any[]): SkillInstall[] {
  const base = path.resolve(projectRoot, '.knowl', 'skills');
  const installs: SkillInstall[] = [];
  for (const skill of skills) {
    validateSkillName(skill.name);
    const skillDir = path.resolve(base, skill.name);
    if (path.dirname(skillDir) !== base) throw new Error(`Invalid imported skill name "${skill.name}".`);
    for (const file of skill.files ?? []) {
      if (typeof file?.content !== 'string') {
        throw new Error(`Invalid imported skill file content for "${file?.path}".`);
      }
      const normalized = normalizeSkillFilePath(file.path);
      const target = path.resolve(skillDir, ...normalized.split('/'));
      const relative = path.relative(skillDir, target);
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
        throw new Error(`Invalid imported skill file path "${file.path}".`);
      }
      installs.push({ target, content: file.content });
    }
  }
  return installs;
}
```

- [ ] **Step 5: Plan before the transaction, install after it**

In `src/store/portability.ts`, replace line 457 with the guard plus the plan:

```ts
  if (!options.projectRoot && skills.length > 0) throw new Error('Skill package import requires a project root.');
  // Planned before anything is written, so a malformed package cannot leave a half-written
  // filesystem behind a rolled-back database.
  const skillInstalls = options.projectRoot ? planSkillInstalls(options.projectRoot, skills) : [];
  const staging = skillInstalls.length > 0
    ? await fs.mkdtemp(path.join(path.resolve(options.projectRoot!, '.knowl'), 'import-skills-'))
    : null;
  if (staging) {
    for (const [index, install] of skillInstalls.entries()) {
      await fs.writeFile(path.join(staging, String(index)), install.content, 'utf8');
    }
  }
```

Delete the loop at lines 540-546 entirely:

```ts
    for (const skill of skills) for (const file of skill.files) {
      const target = path.resolve(options.projectRoot!, '.knowl', 'skills', skill.name, file.path);
      const root = path.resolve(options.projectRoot!, '.knowl', 'skills', skill.name);
      if (!target.startsWith(`${root}${path.sep}`)) throw new Error('Invalid imported skill file path.');
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, file.content, 'utf8');
    }
```

Replace the `catch` block at lines 562-565 so staging is always cleaned up and installation happens after the commit:

```ts
  } catch (error) {
    await client.execute('ROLLBACK;').catch(() => {});
    if (staging) await fs.rm(staging, { recursive: true, force: true }).catch(() => {});
    throw error;
  }

  // After COMMIT, and by rename rather than write: the contents were staged before the
  // transaction opened, so the only work left is the cheapest step that can still fail. It is
  // not swallowed -- the database is already committed by this point, and an import that
  // silently omitted its skill files would look like a success.
  if (staging) {
    try {
      for (const [index, install] of skillInstalls.entries()) {
        await fs.mkdir(path.dirname(install.target), { recursive: true });
        await fs.rename(path.join(staging, String(index)), install.target);
      }
    } finally {
      await fs.rm(staging, { recursive: true, force: true }).catch(() => {});
    }
  }
```

Verify the exact surrounding text with `sed -n '450,575p' src/store/portability.ts` before editing — the `createKnowledgeCommit` call between the skill loop and `COMMIT;` must stay inside the transaction.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run tests/store/import-skill-safety.test.ts tests/store/portability.test.ts tests/store/import-policy.test.ts tests/store/import-commit-trail.test.ts tests/store/export-ownership.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/skills/registry.ts src/store/portability.ts tests/store/import-skill-safety.test.ts
git commit -m "fix(portability): anchor imported skill paths to a fixed base and install them outside the transaction"
```

---

### Task 2: Make the skill directory name the only identity

`readSkillPackage(projectRoot, name)` opens `.knowl/skills/<name>/` (`src/skills/registry.ts:248-253`), but `readManifest` (line 207) only validates the *shape* of `manifest.name`, never that it equals the directory it was read from. `runSkillPackage` then resolves the entrypoint script with `skill.manifest.name` (line 338). Reproduced against 3.0.0: a package at `.knowl/skills/foo/` whose manifest was edited to `"name": "bar"` was run as `foo` and executed `bar/run.js`, returning `bar-script`. An agent told to inspect a skill before running it is therefore not inspecting what runs — and `knowl skill read` (`src/cli/program.ts:1909`) has the same gap.

**Files:**
- Modify: `src/skills/registry.ts:207-213, 232, 250, 338`
- Test: `tests/skills/identity.test.ts` (create)

**Interfaces:**
- Consumes: `validateSkillName` exported in Task 1.
- Produces: `readManifest(skillDir: string, expectedName: string): Promise<SkillManifest>` — module-private, second parameter now required. `readSkillPackage`, `listSkillPackages`, and `runSkillPackage` keep their exported signatures.

- [ ] **Step 1: Write the failing test**

Create `tests/skills/identity.test.ts`:

```ts
import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createSkillPackage,
  listSkillPackages,
  readSkillPackage,
  runSkillPackage,
} from '../../src/skills/registry.js';

const TEST_ROOT = path.resolve('./.knowl-skill-identity-test');

describe('skill package identity', () => {
  beforeAll(async () => {
    await fs.rm(TEST_ROOT, { recursive: true, force: true }).catch(() => {});
    await fs.mkdir(path.join(TEST_ROOT, '.knowl'), { recursive: true });
    for (const name of ['honest', 'imposter']) {
      await createSkillPackage(TEST_ROOT, {
        name,
        purpose: `Report as ${name}`,
        files: [{ path: 'run.js', content: `console.log('${name}-script')` }],
        entrypoints: { default: { type: 'script', path: 'run.js', autoRun: true } },
      });
    }
    const manifestPath = path.join(TEST_ROOT, '.knowl', 'skills', 'honest', 'skill.json');
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf-8'));
    manifest.name = 'imposter';
    await fs.writeFile(manifestPath, JSON.stringify(manifest), 'utf-8');
  });

  afterAll(async () => {
    await fs.rm(TEST_ROOT, { recursive: true, force: true }).catch(() => {});
  });

  it('refuses to read a package whose manifest name disagrees with its directory', async () => {
    await expect(readSkillPackage(TEST_ROOT, 'honest')).rejects.toThrow(/directory name/i);
  });

  it('refuses to run a package whose manifest name disagrees with its directory', async () => {
    await expect(runSkillPackage(TEST_ROOT, 'honest')).rejects.toThrow(/directory name/i);
  });

  it('omits the disagreeing package from the listing rather than listing it under the wrong name', async () => {
    const listed = (await listSkillPackages(TEST_ROOT)).map(entry => entry.name);
    expect(listed).toContain('imposter');
    expect(listed.filter(name => name === 'imposter')).toHaveLength(1);
    expect(listed).not.toContain('honest');
  });

  it('still runs a package whose names agree', async () => {
    const result = await runSkillPackage(TEST_ROOT, 'imposter');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('imposter-script');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/skills/identity.test.ts`
Expected: FAIL — the read resolves, the run returns `bar`-style output from the wrong package, and the listing contains `imposter` twice.

- [ ] **Step 3: Write the implementation**

In `src/skills/registry.ts`, replace `readManifest` (lines 207-213):

```ts
/**
 * The directory name is the identity. A manifest claiming a different one is rejected rather
 * than trusted, because entrypoint resolution followed the manifest: a package inspected as
 * `foo` could execute the files of `bar`, so `knowl skill read` and `knowl_skill_run` could
 * disagree about what the agent had just approved.
 */
async function readManifest(skillDir: string, expectedName: string): Promise<SkillManifest> {
  const manifest = JSON.parse(await fs.readFile(path.join(skillDir, 'skill.json'), 'utf-8')) as SkillManifest;
  validateSkillName(manifest.name);
  if (manifest.name !== expectedName) {
    throw new Error(
      `Skill package in "${expectedName}" declares the name "${manifest.name}". The directory name ` +
      'is the identity Knowl runs; rename one so the two agree.',
    );
  }
  manifest.entrypoints = normalizeEntrypoints(manifest.entrypoints);
  manifest.triggers = manifest.triggers || [];
  return manifest;
}
```

At line 232, inside `listSkillPackages`, pass the directory entry:

```ts
      const manifest = await readManifest(skillDir, entry);
```

At line 250, inside `readSkillPackage`, pass the requested name:

```ts
  const manifest = await readManifest(skillDir, name);
```

At line 338, inside `runSkillPackage`, resolve the entrypoint against the requested directory so the invariant is not load-bearing twice:

```ts
          resolveSkillFile(projectRoot, name, entrypoint.path),
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/skills/ tests/store/skill-surface.test.ts tests/store/skill-loop-integration.test.ts tests/store/skill-capture.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/skills/registry.ts tests/skills/identity.test.ts
git commit -m "fix(skills): require a package manifest name to match its directory"
```

---

### Task 3: Scope the database handle to the async context

`withDbPath` (`src/store/database.ts:95-118`) swaps the active handle by calling `initDbPath`, which assigns the five process-global variables at lines 68-73. 3.0.0 removed the `closeDb()` thrash — a real improvement, and the reason the pool now survives a namespace hop — but the handle is still global, so any operation overlapping the switch sees the switched-in database.

Reproduced against 3.0.0: a `createKnowledgeItem` issued against the project while `withDbPath(sessionPath, …)` was in flight landed in the **session** database. The project listing came back empty. This is silent cross-namespace misrouting, and it is reachable in production — `withNamespaceDatabase` is called from `src/mcp/tools.ts` inside a long-lived stdio MCP server whose requests are not serialized.

`AsyncLocalStorage` is already imported in this file for `transactionScope` (line 135). Adding a second store for the handle fixes the race without touching a single call site: `getDb()` and `getClient()` resolve the scoped context when one exists and fall back to the global otherwise.

**Files:**
- Modify: `src/store/database.ts:14-18, 62-77, 95-118, 209-259`
- Test: `tests/store/namespace-concurrency.test.ts` (create)

**Interfaces:**
- Consumes: `acquireClient`, `releaseAll`, `releaseClient` from `src/store/connection-pool.ts` (all three already imported at line 8).
- Produces: `getDb()`, `getClient()`, `getProjectRoot()`, `getConfigRoot()`, `initDb()`, `initDbPath()`, `withDbPath()`, `withClientTransaction()`, `closeDb()` all keep their exported signatures. New module-private `type DbContext` and `const scopedContext = new AsyncLocalStorage<DbContext>()`.

- [ ] **Step 1: Write the failing test**

Create `tests/store/namespace-concurrency.test.ts`:

```ts
import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, getClient, initDb, withDbPath } from '../../src/store/database.js';
import * as repo from '../../src/store/repository.js';

const TEST_ROOT = path.resolve('./.knowl-namespace-concurrency-test');
const SESSION_DB = path.resolve('./.knowl-namespace-concurrency-session.db');

async function openFile(): Promise<string> {
  return String((await getClient().execute('PRAGMA database_list')).rows[0]?.file ?? '');
}

describe('namespace switching under concurrency', () => {
  beforeAll(async () => {
    await fs.rm(TEST_ROOT, { recursive: true, force: true }).catch(() => {});
    for (const suffix of ['', '-wal', '-shm']) await fs.rm(`${SESSION_DB}${suffix}`, { force: true }).catch(() => {});
    await fs.mkdir(path.join(TEST_ROOT, '.knowl'), { recursive: true });
    await initDb(TEST_ROOT);
  });

  afterAll(async () => {
    await closeDb();
    await fs.rm(TEST_ROOT, { recursive: true, force: true }).catch(() => {});
    for (const suffix of ['', '-wal', '-shm']) await fs.rm(`${SESSION_DB}${suffix}`, { force: true }).catch(() => {});
  });

  it('keeps a project write in the project database while a namespace switch is in flight', async () => {
    const project = await repo.createProject(TEST_ROOT, 'Concurrency');

    let entered!: () => void;
    let release!: () => void;
    const enteredPromise = new Promise<void>(resolve => { entered = resolve; });
    const releasePromise = new Promise<void>(resolve => { release = resolve; });

    const switched = withDbPath(SESSION_DB, async () => {
      entered();
      await releasePromise;
    });

    await enteredPromise;
    await repo.createKnowledgeItem(project.id, {
      category: 'fact',
      title: 'Expected project write',
      content: 'Issued while a namespace switch was open.',
    });
    release();
    await switched;

    expect((await repo.listKnowledgeItems()).map(entry => entry.title)).toContain('Expected project write');

    let sessionTitles: string[] = [];
    await withDbPath(SESSION_DB, async () => {
      sessionTitles = (await repo.listKnowledgeItems()).map(entry => entry.title);
    });
    expect(sessionTitles).not.toContain('Expected project write');
  });

  it('reads the switched database inside the callback and the project database outside it', async () => {
    let inside = '';
    await withDbPath(SESSION_DB, async () => { inside = await openFile(); });
    expect(inside).toContain('namespace-concurrency-session');
    expect(await openFile()).toContain('.knowl-namespace-concurrency-test');
  });

  it('runs a transaction inside a namespace scope against that namespace', async () => {
    const { withClientTransaction } = await import('../../src/store/database.js');
    let inside = '';
    await withDbPath(SESSION_DB, async () => {
      await withClientTransaction(async () => { inside = await openFile(); });
    });
    expect(inside).toContain('namespace-concurrency-session');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/store/namespace-concurrency.test.ts`
Expected: FAIL on the first case — the project listing does not contain the item and the session listing does.

- [ ] **Step 3: Write the implementation**

In `src/store/database.ts`, replace the five `let` declarations (lines 14-18):

```ts
type DbContext = {
  db: LibSQLDatabase<typeof schema>;
  client: Client;
  projectRoot: string;
  configRoot: string;
  databasePath: string;
};

/**
 * Which database the *current* async operation is using.
 *
 * `withDbPath` used to swap five process-global variables for the duration of a callback. Two
 * MCP requests overlapping a namespace switch is not hypothetical -- the stdio server does not
 * serialize requests, and a project write issued during an open switch landed in the session
 * database, silently, with no error anywhere. A scoped store gives each async chain its own
 * handle, so no call site has to thread one through.
 */
const scopedContext = new AsyncLocalStorage<DbContext>();
let globalContext: DbContext | null = null;

function activeContext(): DbContext | null {
  return scopedContext.getStore() ?? globalContext;
}
```

Replace the body of `initDbPath`'s `try` block (lines 62-77):

```ts
  try {
    // Pooled: the same path is not reopened, and bootstrap runs once per file rather than
    // on every namespace swap.
    const client = await acquireClient(dbPath, {
      profileFingerprint: await currentProfileFingerprint(configRoot),
    });
    globalContext = {
      db: drizzle(client, { schema }),
      client,
      projectRoot: path.resolve(configRoot),
      configRoot: path.resolve(configRoot),
      databasePath: path.resolve(dbPath),
    };
    return globalContext.db;
  } catch (error: any) {
    throw new DatabaseError(`Failed to initialize database at "${dbPath}": ${error.message}`);
  }
```

Replace `withDbPath` (lines 80-118) in full, keeping the existing doc comment's account of why nothing is closed:

```ts
/**
 * Run `run` against a different database, without disturbing anyone else's.
 *
 * This is a swap of the *active handle*, not a shutdown, and it used to be written as one:
 * `closeDb` on the way in and again on the way out, each of which releases the entire pool and
 * WAL-checkpoints every writable client in it. `queryLayeredKnowledge` walks every namespace on
 * every agent query, inside a long-lived MCP server, so that was the pool being defeated on each
 * hop rather than in some edge case.
 *
 * The swap is now scoped rather than global. Reassigning the module handle made the switch
 * visible to every concurrent operation in the process, so a write issued against the project
 * during a session-namespace hop was executed against the session database. Both databases stay
 * pooled afterwards: the next hop is then free.
 */
export async function withDbPath<T>(dbPath: string, run: () => Promise<T>): Promise<T> {
  const previous = activeContext();
  // The swapped-in database keeps the caller's config root. A namespace store lives outside
  // the `<root>/.knowl/` layout, so deriving one from its path would point at nothing.
  const configRoot = previous ? previous.configRoot : path.dirname(path.dirname(dbPath));
  const client = await acquireClient(dbPath, {
    profileFingerprint: await currentProfileFingerprint(configRoot),
  });
  const context: DbContext = {
    db: drizzle(client, { schema }),
    client,
    projectRoot: path.resolve(configRoot),
    configRoot: path.resolve(configRoot),
    databasePath: path.resolve(dbPath),
  };
  try {
    return await scopedContext.run(context, run);
  } finally {
    // Nothing was open before, so leaving this one pooled would be a handle the caller never
    // asked for. Only this database is released; whatever else the pool holds is not ours.
    if (!previous) await releaseClient(dbPath);
  }
}
```

Replace the four accessors and `closeDb` (lines 209-259):

```ts
/**
 * Gets the current database instance. Throws if not initialized.
 */
export function getDb(): LibSQLDatabase<typeof schema> {
  const context = activeContext();
  if (!context) throw new DatabaseError('Database has not been initialized. Run initDb() first.');
  return context.db;
}

export function getClient(): Client {
  const context = activeContext();
  if (!context) throw new DatabaseError('Database has not been initialized. Run initDb() first.');
  return context.client;
}

export function getProjectRoot(): string {
  const context = activeContext();
  if (!context) throw new DatabaseError('Project root has not been initialized. Run initDb() first.');
  return context.projectRoot;
}

/**
 * The directory whose `.knowl/config.json` and `.knowl/models` govern the open database.
 *
 * Distinct from the database's own location: a namespace or shared store sits outside any
 * `<root>/.knowl/` layout, and config still has to come from the project the caller is
 * working in.
 */
export function getConfigRoot(): string {
  const context = activeContext();
  if (!context) throw new DatabaseError('Config root has not been initialized. Run initDb() first.');
  return context.configRoot;
}

/**
 * Closes the database connection.
 */
export async function closeDb(): Promise<void> {
  if (globalContext) {
    // Release the whole pool, not just the active handle. Tests and CLI commands delete
    // their project directory after closing, and a client still holding the file would
    // keep the WAL sidecars open.
    await releaseAll();
    globalContext = null;
  }
}
```

- [ ] **Step 4: Record why the transaction queue stays global**

`withClientTransaction` (line 172) serializes on one process-wide `transactionQueue`, and its comment justifies that with "this process holds exactly one connection". Once handles are scoped, that premise no longer holds — two scopes can hold two connections. Serializing them together is still *correct*, only conservative: no two `BEGIN`s can interleave on any connection. Append to that function's doc comment so the next reader does not conclude the queue is now wrong:

```ts
 * The queue is process-wide even though handles are now scoped per async context. Two
 * transactions on genuinely different connections therefore wait on each other unnecessarily.
 * That is deliberate: the cost is serialization the local CLI and a single MCP server never
 * notice, and the alternative -- a queue per connection -- has to be right about which
 * connection a queued caller will resolve *after* its wait, which is exactly the reasoning
 * that produced the misrouting bug this scoping fixes.
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/store/namespace-concurrency.test.ts tests/store/namespaces.test.ts tests/store/connection-pool.test.ts tests/store/write-transaction.test.ts tests/store/retargetable-reads.test.ts tests/store/store-handle.test.ts`
Expected: PASS.

- [ ] **Step 6: Run the whole suite**

Run: `npm test`
Expected: PASS. This change alters what `getClient()` returns inside a namespace scope, so anything that depended on the global leaking out of `withDbPath` surfaces here rather than in production.

- [ ] **Step 7: Commit**

```bash
git add src/store/database.ts tests/store/namespace-concurrency.test.ts
git commit -m "fix(store): scope the database handle to the async context so namespace switches stop misrouting writes"
```

---

### Task 4: Give the viewer an error boundary, an access token, and response headers

`startViewer` hands an `async` listener straight to `http.createServer` (`src/viewer/server.ts:92`) with no `try`/`catch`. Node does not turn a rejected listener promise into a 500 — it raises `unhandledRejection`, which `installProcessHooks` (`src/core/startup-trace.ts:231`) deliberately rethrows and which Node has crashed on by default since v15.

Reproduced against 3.0.0: `GET /api/evidence/%` reaches `decodeURIComponent` (line 104), throws `URIError: URI malformed`, and the request never returns. The same probe read `/api/brain` with a 200 and no credential of any kind. The viewer is GET-only and bound to `127.0.0.1` — both good — but any page the user visits can reach a loopback port from their browser.

The token is returned alongside the URL rather than embedded in it, because `ViewerServer.url` is concatenated as an origin by existing callers (`tests/viewer/server.test.ts` does `${running.url}/api/brain`) and a query string in that position would break them silently.

**Files:**
- Modify: `src/viewer/server.ts:14-17, 90-113`
- Modify: `src/cli/program.ts:859` (`view` command output)
- Modify: `tests/viewer/server.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `export type ViewerServer = { url: string; token: string; browseUrl: string; close: () => Promise<void> }` — `url` keeps its current meaning (origin, no trailing slash, no query), `token` is the per-launch secret, `browseUrl` is `${url}/?token=${token}` and is what a human should open.

- [ ] **Step 1: Write the failing test**

Add to `tests/viewer/server.test.ts` inside the existing `describe`, after the current case. It reuses the already-started server through a module-level handle, so hoist `let running: any;` beside the existing `let stop` and assign it in the first case:

```ts
  it('answers a malformed percent-escape with 400 instead of hanging or crashing', async () => {
    const response = await fetch(`${running.url}/api/evidence/%?token=${running.token}`);
    expect(response.status).toBe(400);
    await response.json();
  });

  it('refuses an API request with no token', async () => {
    expect((await fetch(`${running.url}/api/brain`)).status).toBe(401);
  });

  it('refuses a request whose Host header is not the bound loopback address', async () => {
    const response = await fetch(`${running.url}/api/brain?token=${running.token}`, {
      headers: { host: 'knowl.example.com' },
    });
    expect(response.status).toBe(400);
  });

  it('serves the page with hardening headers and a session cookie', async () => {
    const response = await fetch(running.browseUrl);
    expect(response.status).toBe(200);
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(response.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(response.headers.get('set-cookie') ?? '').toContain('knowl_viewer=');
  });
```

Then update the existing case: every `fetch(\`${running.url}/api/...\`)` in it needs `?token=${running.token}` appended (and `&token=` for `/api/retrieval?q=viewer`).

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/viewer/server.test.ts`
Expected: FAIL — the malformed-escape request times out or kills the worker; `running.token` is `undefined`; the header assertions fail.

- [ ] **Step 3: Write the implementation**

In `src/viewer/server.ts`, add `import crypto from 'node:crypto';` to the imports and replace the `ViewerServer` type (line 12):

```ts
export type ViewerServer = {
  /** Origin only, no trailing slash and no query: callers concatenate paths onto it. */
  url: string;
  token: string;
  /** What a human opens. The token is in the URL so a copied link authenticates. */
  browseUrl: string;
  close: () => Promise<void>;
};

const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'content-security-policy':
    "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; " +
    "img-src data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
};
```

Replace `json` (lines 14-17):

```ts
function json(response: http.ServerResponse, value: unknown, status = 200) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...SECURITY_HEADERS,
  });
  response.end(JSON.stringify(value));
}
```

Add above `startViewer`:

```ts
/** `decodeURIComponent` throws on a malformed escape; that has to be a 400, not a dead process. */
function segment(pathname: string, prefix: string): string {
  return decodeURIComponent(pathname.slice(prefix.length));
}

function tokenMatches(presented: string, expected: string): boolean {
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
```

Replace the body of `startViewer` (lines 90-113):

```ts
export async function startViewer(projectRoot: string, options: { port?: number } = {}): Promise<ViewerServer> {
  await initDb(projectRoot);
  // A fresh secret per launch. Binding to 127.0.0.1 keeps other machines out; it does not keep
  // out a page the user is already viewing, which can reach loopback ports from their browser.
  const token = crypto.randomBytes(24).toString('base64url');

  async function route(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    if (request.method !== 'GET') { response.writeHead(405, { allow: 'GET', ...SECURITY_HEADERS }); response.end(); return; }

    const bound = server.address();
    const port = bound && typeof bound !== 'string' ? bound.port : 0;
    const host = request.headers.host ?? '';
    // A browser sends the hostname it dialled. Only the loopback literals are ours; a name that
    // merely resolves to 127.0.0.1 belongs to whoever controls that name.
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}` && host !== `[::1]:${port}`) {
      json(response, { error: 'Unexpected Host header.' }, 400);
      return;
    }

    const url = new URL(request.url ?? '/', `http://127.0.0.1:${port}`);
    const cookie = /(?:^|;\s*)knowl_viewer=([^;]+)/.exec(request.headers.cookie ?? '')?.[1];
    if (!tokenMatches(url.searchParams.get('token') ?? cookie ?? '', token)) {
      json(response, { error: 'Missing or invalid viewer token.' }, 401);
      return;
    }

    const pathname = url.pathname;
    if (pathname === '/api/graph') return json(response, await buildGraph());
    if (pathname === '/api/brain') return json(response, await listKnowledgeItems());
    if (pathname === '/api/decisions') return json(response, (await listKnowledgeItems()).filter(item => item.category === 'decision'));
    if (pathname === '/api/stale') return json(response, (await listKnowledgeItems()).filter(item => item.freshness !== 'fresh'));
    if (pathname === '/api/conflicts') return json(response, await listActiveConflictKeys());
    if (pathname === '/api/access') return json(response, await getKnowledgeAccessReport());
    if (pathname === '/api/skills') return json(response, await listSkillPackages(projectRoot));
    if (pathname === '/api/retrieval') return json(response, await queryKnowledgeForAgentExplained('local', { query: url.searchParams.get('q') ?? '', limit: 10, surface: 'viewer' }));
    if (pathname.startsWith('/api/evidence/')) return json(response, await listEvidenceForItem(segment(pathname, '/api/evidence/')));
    if (pathname.startsWith('/api/timeline/')) return json(response, await listAssertions(segment(pathname, '/api/timeline/')));
    if (pathname === '/') {
      response.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        // The page then reaches the API on its own, without the token in every URL it builds.
        'set-cookie': `knowl_viewer=${token}; Path=/; HttpOnly; SameSite=Strict`,
        ...SECURITY_HEADERS,
      });
      response.end(VIEWER_HTML);
      return;
    }
    json(response, { error: 'Not found.' }, 404);
  }

  const server = http.createServer((request, response) => {
    // Node does not convert a rejected listener promise into a 500 -- it raises
    // `unhandledRejection`, which this process is configured to die on. One malformed
    // percent-escape in a URL was enough to take the viewer down.
    void route(request, response).catch(error => {
      const status = error instanceof URIError ? 400 : 500;
      if (!response.headersSent) {
        response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...SECURITY_HEADERS });
      }
      response.end(JSON.stringify({ error: status === 400 ? 'Malformed request.' : 'Internal viewer error.' }));
    });
  });

  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(options.port ?? 0, '127.0.0.1', resolve); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Viewer failed to bind a local port.');
  const url = `http://127.0.0.1:${address.port}`;
  return {
    url,
    token,
    browseUrl: `${url}/?token=${token}`,
    close: async () => { await new Promise<void>(resolve => server.close(() => resolve())); await closeDb(); },
  };
}
```

- [ ] **Step 4: Print the browse URL from the CLI**

Run: `grep -n "startViewer" -A 8 src/cli/program.ts`

Change whatever it prints from `.url` to `.browseUrl`, so a user who copies the printed link is authenticated and one who guesses the port is not.

- [ ] **Step 5: Confirm the browser UI still reaches the API**

`src/viewer/ui.ts:645` is `fetch(url)` with relative paths and default credentials, so the `SameSite=Strict` cookie set on the page response is sent automatically. No change needed — but confirm no call passes `credentials: 'omit'`:

Run: `grep -n "credentials" src/viewer/ui.ts`
Expected: no matches.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run tests/viewer/server.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/viewer/server.ts src/cli/program.ts tests/viewer/server.test.ts
git commit -m "fix(viewer): catch route rejections and require a per-launch token, Host check, and security headers"
```

---

### Task 5: Verify the snapshot before destroying the store

3.0.0 fixed *what* restore copies. It did not fix *whether it should have started*. `restoreSnapshot` (`src/store/snapshots.ts:182-188`) reads the manifest inside a `try` that swallows `ENOENT`, so a snapshot with no manifest restores with no verification at all — reproduced: deleting the manifest and restoring returned `ACCEPTED-WITHOUT-MANIFEST`. `createSnapshot` writes `schemaVersion: 1` as a literal (line 49) and `byteSize` (line 51); neither is ever read.

The checks run against the file and against the already-attached database, so no second connection is opened and no sidecar of the source is touched.

**Files:**
- Modify: `src/store/snapshots.ts:37-55, 182-193`
- Test: `tests/store/snapshot-verification.test.ts` (create)

**Interfaces:**
- Consumes: `KNOWL_SCHEMA_VERSION` from `src/store/schema-version.ts`.
- Produces: `createSnapshot` and `restoreSnapshot` keep their signatures. `SnapshotManifest.schemaVersion` now carries `KNOWL_SCHEMA_VERSION` rather than a literal. New module-private `async function verifySnapshotManifest(source: string): Promise<SnapshotManifest>`.

- [ ] **Step 1: Write the failing test**

Create `tests/store/snapshot-verification.test.ts`:

```ts
import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, initDb } from '../../src/store/database.js';
import * as repo from '../../src/store/repository.js';
import { createSnapshot, restoreSnapshot } from '../../src/store/snapshots.js';
import { KNOWL_SCHEMA_VERSION } from '../../src/store/schema-version.js';

const TEST_ROOT = path.resolve('./.knowl-snapshot-verification-test');

describe('snapshot verification', () => {
  beforeAll(async () => {
    await fs.rm(TEST_ROOT, { recursive: true, force: true }).catch(() => {});
    await fs.mkdir(path.join(TEST_ROOT, '.knowl'), { recursive: true });
    await initDb(TEST_ROOT);
    const project = await repo.createProject(TEST_ROOT, 'Verification');
    await repo.createKnowledgeItem(project.id, { category: 'fact', title: 'Survivor', content: 'Still here.' });
  });

  beforeEach(async () => {
    await fs.rm(path.join(TEST_ROOT, '.knowl', 'snapshots'), { recursive: true, force: true });
  });

  afterAll(async () => {
    await closeDb();
    await fs.rm(TEST_ROOT, { recursive: true, force: true }).catch(() => {});
  });

  it('records the real schema version in the manifest', async () => {
    const snapshot = await createSnapshot(TEST_ROOT);
    expect(snapshot.manifest.schemaVersion).toBe(KNOWL_SCHEMA_VERSION);
  });

  it('refuses a snapshot with no manifest', async () => {
    const snapshot = await createSnapshot(TEST_ROOT);
    await fs.rm(snapshot.manifestPath);
    await expect(restoreSnapshot(TEST_ROOT, snapshot.path, { confirm: true })).rejects.toThrow(/manifest/i);
  });

  it('refuses a snapshot whose byte size disagrees with its manifest', async () => {
    const snapshot = await createSnapshot(TEST_ROOT);
    const manifest = JSON.parse(await fs.readFile(snapshot.manifestPath, 'utf8'));
    manifest.byteSize += 1;
    await fs.writeFile(snapshot.manifestPath, JSON.stringify(manifest), 'utf8');
    await expect(restoreSnapshot(TEST_ROOT, snapshot.path, { confirm: true })).rejects.toThrow(/size/i);
  });

  it('refuses a snapshot recorded by a newer schema', async () => {
    const snapshot = await createSnapshot(TEST_ROOT);
    const manifest = JSON.parse(await fs.readFile(snapshot.manifestPath, 'utf8'));
    manifest.schemaVersion += 1;
    await fs.writeFile(snapshot.manifestPath, JSON.stringify(manifest), 'utf8');
    await expect(restoreSnapshot(TEST_ROOT, snapshot.path, { confirm: true })).rejects.toThrow(/schema version/i);
  });

  it('refuses a corrupted snapshot and leaves the live store usable', async () => {
    const snapshot = await createSnapshot(TEST_ROOT);
    const bytes = await fs.readFile(snapshot.path);
    bytes.fill(0, 200, Math.min(4096, bytes.length));
    await fs.writeFile(snapshot.path, bytes);
    await expect(restoreSnapshot(TEST_ROOT, snapshot.path, { confirm: true })).rejects.toThrow();
    expect((await repo.listKnowledgeItems()).map(entry => entry.title)).toContain('Survivor');
  });

  it('still restores a well-formed snapshot', async () => {
    const snapshot = await createSnapshot(TEST_ROOT);
    const project = (await repo.listProjects?.())?.[0];
    await repo.createKnowledgeItem(project?.id ?? 'local', {
      category: 'fact', title: 'After snapshot', content: 'Must disappear.',
    });
    await restoreSnapshot(TEST_ROOT, snapshot.path, { confirm: true });
    const titles = (await repo.listKnowledgeItems()).map(entry => entry.title);
    expect(titles).toContain('Survivor');
    expect(titles).not.toContain('After snapshot');
  });
});
```

If `repo.listProjects` does not exist, capture the project id in `beforeAll` into a module-level `let projectId: string` and use that instead — check with `grep -n "export async function listProjects" src/store/repository.ts`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/store/snapshot-verification.test.ts`
Expected: FAIL — `schemaVersion` is `1` rather than the constant, and the missing-manifest, size, and schema cases all resolve instead of rejecting.

- [ ] **Step 3: Write the implementation**

In `src/store/snapshots.ts`, add to the imports:

```ts
import { KNOWL_SCHEMA_VERSION } from './schema-version.js';
```

At line 49, replace the literal:

```ts
    // The real constant, not a literal. A manifest that records "1" forever cannot be checked
    // for compatibility once the schema moves.
    schemaVersion: KNOWL_SCHEMA_VERSION,
```

Add above `restoreSnapshot`:

```ts
/**
 * Verify the manifest before anything destructive happens.
 *
 * A checksum proves the bytes are intact, not who wrote them: whoever produces a snapshot can
 * compute a valid checksum for it. This is an integrity check against corruption and truncated
 * copies, and it does not claim more. What it must not do is pass silently -- the manifest was
 * previously optional, so a snapshot with none was restored with no verification at all, which
 * is the one situation where the previous state is already gone.
 */
async function verifySnapshotManifest(source: string): Promise<SnapshotManifest> {
  const manifestPath = `${source}.manifest.json`;
  let manifest: SnapshotManifest;
  try {
    manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8')) as SnapshotManifest;
  } catch (error: any) {
    throw new Error(error.code === 'ENOENT'
      ? `Snapshot manifest "${manifestPath}" was not found. Restore requires the manifest written beside the snapshot.`
      : `Snapshot manifest "${manifestPath}" is unreadable: ${error.message}`);
  }

  if (!Number.isInteger(manifest.schemaVersion) || manifest.schemaVersion > KNOWL_SCHEMA_VERSION) {
    throw new Error(
      `Snapshot was written with schema version ${manifest.schemaVersion}; this build reads up to ` +
      `${KNOWL_SCHEMA_VERSION}. Upgrade Knowl before restoring it.`,
    );
  }

  const stat = await fs.stat(source);
  if (stat.size !== manifest.byteSize) {
    throw new Error(`Snapshot size ${stat.size} does not match its manifest size ${manifest.byteSize}.`);
  }
  if (manifest.sha256 !== await sha256(source)) {
    throw new Error('Snapshot checksum does not match its manifest.');
  }
  return manifest;
}
```

Replace the optional-manifest block at lines 182-188 with the mandatory call, and add the attached-database preflight after the `ATTACH` at line 193:

```ts
  await verifySnapshotManifest(source);

  const preRestore = await createSnapshot(root);
  const client = getClient();
  // ATTACH cannot run inside a transaction, so it stays outside the wrapper on both sides.
  await client.execute(`ATTACH DATABASE '${quoteSqlPath(source)}' AS snapshot_restore`);
  try {
    // Asked of the attachment rather than a second connection: opening the snapshot separately
    // would create WAL sidecars beside a file this function is only supposed to read.
    const integrity = await client.execute('PRAGMA snapshot_restore.integrity_check');
    const verdict = String(integrity.rows[0]?.integrity_check ?? '');
    if (verdict !== 'ok') throw new Error(`Snapshot failed SQLite integrity_check: ${verdict}`);

    const stamped = Number((await client.execute('PRAGMA snapshot_restore.user_version')).rows[0]?.user_version ?? 0);
    if (stamped > KNOWL_SCHEMA_VERSION) {
      throw new Error(
        `Snapshot database is stamped with schema version ${stamped}; this build reads up to ` +
        `${KNOWL_SCHEMA_VERSION}. Upgrade Knowl before restoring it.`,
      );
    }
```

Keep the existing `withClientTransaction` block, `finally { DETACH }`, audit, and `SnapshotRestoreAuditError` exactly as they are. Verify the resulting structure with `sed -n '175,230p' src/store/snapshots.ts` — the `try` you are extending must still `DETACH` in its `finally`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/store/snapshot-verification.test.ts tests/store/integrity.test.ts tests/store/retention.test.ts`
Expected: PASS. If `tests/store/integrity.test.ts` creates a snapshot by hand without a manifest, update it to use `createSnapshot`.

- [ ] **Step 5: Commit**

```bash
git add src/store/snapshots.ts tests/store/snapshot-verification.test.ts
git commit -m "fix(snapshots): require and check the manifest, and preflight the attached file before restoring"
```

---

### Task 6: Correct the README and ship 3.0.1

Six README claims are wrong, and the version drift is now three majors wide.

**Files:**
- Modify: `README.md` lines 39, 181, 349, 496, 1050, 1053, 1074
- Modify: `CHANGELOG.md`, `package.json`

- [ ] **Step 1: Remove the version branding**

At `README.md:39` and `README.md:496`, change `Knowl 2.5` to `Knowl`. Both sentences describe a capability that has not changed; a version number in prose is drift with a delay fuse. Task 4 of the hardening plan generates this from `package.json` instead.

- [ ] **Step 2: Fix the default embedding model contradiction**

`README.md:181` says retrieval uses "a local MiniLM q8 model"; the table at line 208 marks `granite-small-en-r2` as the default. Replace the sentence beginning "Agent retrieval through MCP":

```markdown
Agent retrieval through MCP `knowl_query` is vector-primary by default, using the repository's
configured local embedding profile. New repositories default to Granite Small English R2. Its
project candidate set is reranked with bounded BM25 lexical results plus exact-identifier,
freshness, status, confidence, and recency adjustments.
```

- [ ] **Step 3: Stop publishing an exact MCP tool count**

`README.md:1074` says "Knowl exposes exactly 24 MCP tools" above a 27-row table, while `src/mcp/tools.ts` registers 30 names. Replace that line:

```markdown
Knowl exposes the core tools below. Two transcript search tools and a session listing tool are
registered in addition when transcript indexing is enabled for the repository.
```

- [ ] **Step 4: Correct the reindex and snapshot rows**

`README.md:1053`:

```markdown
| `knowl reindex --vectors` | Prepare the local model and embed items that have no current vector; `--force` re-embeds every item |
```

`README.md:1050`:

```markdown
| `knowl snapshot create` / `knowl snapshot restore <path> --confirm` | Create a checksummed SQLite snapshot, or restore one after verifying its manifest, size, checksum, and SQLite integrity |
```

- [ ] **Step 5: Disambiguate the transcript wording**

`README.md:349`, replacing the sentence beginning "Bounded lifecycle capture does not retain":

```markdown
Lifecycle capture itself stores no raw prompts, transcripts, stdout, stderr, or environment
variables. When transcript indexing is explicitly enabled, the separate transcript index reads
supported host transcript files already present on the machine; it does not create them.
```

- [ ] **Step 6: Document the viewer token**

In the viewer section (`grep -n "knowl view" README.md`), add:

```markdown
The viewer binds to `127.0.0.1`, answers only `GET`, and mints a fresh access token per launch.
The printed URL carries that token; knowing the port is not enough to read anything.
```

- [ ] **Step 7: Verify the whole tree**

Run: `npm test`
Expected: PASS.

Run: `npm run build`
Expected: clean `tsup` build, no type errors.

- [ ] **Step 8: Version, changelog, commit**

Set `"version": "3.0.1"` in `package.json`. Add to `CHANGELOG.md`:

```markdown
## 3.0.1

### Fixed

- **Imported skill packages can no longer write outside `.knowl/skills`.** Both sides of the
  containment check were derived from the untrusted skill name, so a traversal name satisfied it.
  Names and paths are now anchored to a fixed base, contents are staged before the transaction
  opens, and files are installed by rename after it commits rather than written inside it.
- **A skill package's directory name is now its only identity.** A manifest could declare a
  different name and entrypoint resolution followed the manifest, so a package inspected through
  `knowl skill read` as one skill could execute another's files.
- **Namespace switches no longer misroute concurrent writes.** The database handle was a set of
  process-global variables, so a project write issued while a session-namespace switch was open
  was executed against the session database — silently. The handle is now scoped to the async
  context; nothing else changes for callers.
- **The viewer survives a malformed URL and requires a token.** An async route handler with no
  error boundary turned `GET /api/evidence/%` into an unhandled rejection, which this process is
  configured to die on. Routes now answer 400, and every request needs the per-launch token
  carried by the printed URL. Responses also send CSP, `X-Content-Type-Options`,
  `Referrer-Policy`, and validate the `Host` header.
- **Snapshot restore verifies before it destroys.** A missing manifest was silently accepted, and
  the recorded `schemaVersion` and `byteSize` were written but never read. The manifest is now
  required and fully checked, the snapshot's own `integrity_check` and `user_version` are
  preflighted through the existing attachment, and `schemaVersion` records the real constant.

### Documentation

- Corrected the version branding, default embedding model, MCP tool count, `reindex --vectors`
  behaviour, snapshot guarantee, and transcript retention wording in the README.
```

```bash
git add README.md CHANGELOG.md package.json
git commit -m "docs: correct model, tool-count, reindex, snapshot, and transcript claims for 3.0.1"
```

---

## Self-Review Notes

- **Superseded by 3.0.0, deliberately dropped:** the shell-argument rewrite and the whole-file snapshot restore from the earlier 2.17.0 plans. Both were fixed upstream, the second by a different and better design — a schema-derived table set cannot drift as tables are added, and `SnapshotRestoreAuditError` naming the pre-restore path is more useful to an operator than a silent automatic rollback. Task 5 only adds the verification that design still lacks.
- **Earlier review blockers, resolved here:** the snapshot verification no longer opens the source writable or deletes its sidecars (it uses the existing `ATTACH`); the `user_version` preflight is actually performed rather than merely cited; imported skill contents are staged *before* the transaction so the post-commit step is renames rather than writes; and no task redeclares `skillCommand`, which lives at `src/cli/program.ts:1884`.
- **Not covered here:** skill execution limits and environment filtering, hash-pinned skill approval, import ceilings, atomic config writes, diagnostics permissions, generated documentation, and CI gates. Those are `2026-08-04-hardening-and-ci-3.2.0.md`.
- **Task 3 is the riskiest change in this plan.** It alters what `getClient()` returns inside a namespace scope. Step 6 runs the full suite for exactly that reason; do not skip it.
