# Workspace v1 (Federation) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user link several repositories so an agent working in one can read workspace-visible knowledge from the others, with every result labelled by the repo that owns it.

**Architecture:** No shared database. Each repo keeps `<repo>/.knowl/knowl.db`; a workspace is a manifest outside every repo naming its members, and reads fan out across the members' existing databases using the read-only pooled connections from 2.4.0. Writes always go to the local repo. `visibility` (shipped inert in 2.4.0) decides what crosses: `repo` never leaves, `workspace` is readable by linked repos.

**Tech Stack:** TypeScript (ESM, NodeNext), libSQL + Drizzle, vitest, tsup, commander, MCP SDK.

**Source spec:** `docs/superpowers/specs/2026-07-26-multi-repo-workspace-design.md`, sections "v1 — linked repos read each other" and "Vocabulary".

**Depends on:** 2.4.0 (merge `6201718`). Specifically `resolveStorage`, `acquireClient(path, {readOnly})`, `assertSchemaSupported`, `compactKnowledgeItem(item, extras)`, `embeddingIdentityFromConfig`, and the `origin_repo` / `visibility` columns.

## Global Constraints

- Windows dev machine. `npm.cmd` for npm, `npx.cmd` for binaries. Use the Grep tool rather than `rg` — `rg` is not on PATH in the bash environment.
- Test: `npm.cmd test`. Single file: `npx.cmd vitest run tests/path/file.test.ts`. Build: `npm.cmd run build`.
- Relative imports carry `.js`, including from `.ts`.
- Typecheck baseline is **15 pre-existing errors** (`npx.cmd tsc --noEmit`). Do not add to it; do not fix unrelated ones.
- Every MCP tool must stay usable with no AI provider configured.
- Test databases live in `./.knowl-<feature>-test`, created in `beforeAll`, removed in `afterAll`.
- **Repo names** are `[a-z0-9][a-z0-9-]*`, unique within a workspace, immutable.
- **A repo with no workspace must behave exactly as it does today.** Every task carries this; Task 15 asserts it end to end.
- **v1 never writes to another repo's database.** Peer opens are `{ readOnly: true }` without exception.
- Conventional commits. Commit at the end of every task.

## File Structure

| File | Responsibility | Tasks |
| --- | --- | --- |
| `src/workspace/manifest.ts` | **New.** Read, write, validate `workspace.json`; repo-name rules; retired names | 1 |
| `src/workspace/paths.ts` | **New.** `KNOWL_HOME` resolution, workspace directory layout, registry of known workspaces | 1 |
| `src/workspace/membership.ts` | **New.** Two-sided join/leave, nesting rejection, tracked-config detection, `origin_repo` backfill | 2, 3 |
| `src/workspace/resolve.ts` | **New.** `resolveWorkspace(root)` → active workspace + this repo's name + peer descriptors | 4 |
| `src/workspace/federated-query.ts` | **New.** Fan-out, visibility filtering, per-repo caps, RRF fusion, skip reporting | 5, 6 |
| `src/workspace/promote.ts` | **New.** `visibility` promotion with dry-run | 7 |
| `src/store/namespaces.ts` | Peer descriptors join the namespace list | 4 |
| `src/store/knowledge-writer.ts` | Duplicate resolution clamped across owners | 8 |
| `src/store/synthesis.ts`, `recent-context.ts`, `context-bootstrap.ts`, `context-composer.ts`, `work-loop.ts` | Implicit reads take a required scope | 9 |
| `src/mcp/tools.ts` | `repos` filter, `repo` label, foreign-item refusals, workspace in `knowl_state` | 6, 10 |
| `src/cli/workspace-report.ts` | **New.** `knowl workspace list/status` rendering | 11 |
| `src/cli/status-report.ts`, `src/cli/doctor-report.ts` | Workspace sections | 11 |
| `src/core/knowl-guidance.ts` | One workspace paragraph in the managed section and subagent card | 12 |
| `src/index.ts` | `knowl workspace` command group | 13 |
| `docs/evals/` | Cross-repo retrieval cases | 14 |

Tasks 1–3 are sequential. Tasks 4–6 depend on 3. Tasks 7–12 depend on 4. Task 13 depends on 1–3 and 7. Tasks 14–15 are last.

---

### Task 1: Workspace manifest and paths

**Files:**
- Create: `src/workspace/paths.ts`, `src/workspace/manifest.ts`
- Test: `tests/workspace/manifest.test.ts`

**Interfaces:**
- Produces (`paths.ts`):
  - `knowlHome(): string` — `process.env.KNOWL_HOME` or `path.join(os.homedir(), '.knowl')`
  - `workspaceDir(name: string): string` — `<knowlHome>/workspaces/<name>`
  - `workspaceManifestPath(name: string): string`
  - `listKnownWorkspaces(): Promise<string[]>`
- Produces (`manifest.ts`):
  - `type WorkspaceRepo = { name: string; path?: string; git?: { remote?: string } }`
  - `type WorkspaceManifest = { version: 1; name: string; minKnowlVersion: string; embedding: EmbeddingIdentity | null; repos: WorkspaceRepo[]; retiredNames: string[] }`
  - `isValidRepoName(name: string): boolean`
  - `readManifest(manifestPath: string): Promise<WorkspaceManifest>`
  - `writeManifest(manifestPath: string, manifest: WorkspaceManifest): Promise<void>`
  - `createManifest(name: string, embedding: EmbeddingIdentity | null): WorkspaceManifest`
  - `assertNameAvailable(manifest: WorkspaceManifest, name: string): void` — throws on duplicate or retired

- [ ] **Step 1: Write the failing test**

Create `tests/workspace/manifest.test.ts`:

```typescript
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  assertNameAvailable, createManifest, isValidRepoName, readManifest, writeManifest,
} from '../../src/workspace/manifest.js';
import { knowlHome, workspaceDir, workspaceManifestPath } from '../../src/workspace/paths.js';

const HOME = path.resolve('./.knowl-manifest-test-home');

describe('workspace paths', () => {
  beforeAll(async () => { await fs.rm(HOME, { recursive: true, force: true }); });
  afterAll(async () => { delete process.env.KNOWL_HOME; await fs.rm(HOME, { recursive: true, force: true }).catch(() => {}); });

  it('defaults to ~/.knowl and honours KNOWL_HOME', () => {
    delete process.env.KNOWL_HOME;
    expect(knowlHome()).toBe(path.join(os.homedir(), '.knowl'));
    process.env.KNOWL_HOME = HOME;
    expect(knowlHome()).toBe(path.resolve(HOME));
  });

  it('places a workspace under workspaces/<name>', () => {
    process.env.KNOWL_HOME = HOME;
    expect(workspaceDir('duckprep')).toBe(path.join(path.resolve(HOME), 'workspaces', 'duckprep'));
    expect(workspaceManifestPath('duckprep')).toBe(path.join(path.resolve(HOME), 'workspaces', 'duckprep', 'workspace.json'));
  });
});

describe('repo names', () => {
  it('accepts lowercase, digits and hyphens', () => {
    expect(isValidRepoName('server')).toBe(true);
    expect(isValidRepoName('duckprep-web-2')).toBe(true);
  });

  it('rejects anything that could be mistaken for a path or a flag', () => {
    for (const bad of ['', '-leading', 'Upper', 'has space', 'has/slash', '..', 'has.dot', 'has_underscore']) {
      expect(isValidRepoName(bad)).toBe(false);
    }
  });
});

describe('manifest', () => {
  beforeAll(async () => { process.env.KNOWL_HOME = HOME; await fs.rm(HOME, { recursive: true, force: true }); });
  afterAll(async () => { delete process.env.KNOWL_HOME; await fs.rm(HOME, { recursive: true, force: true }).catch(() => {}); });

  it('round-trips through disk', async () => {
    const manifest = createManifest('duckprep', { provider: 'local', model: 'm', dtype: 'q8' });
    manifest.repos.push({ name: 'server', path: 'D:/coding/server' });
    const target = workspaceManifestPath('duckprep');
    await fs.mkdir(path.dirname(target), { recursive: true });
    await writeManifest(target, manifest);
    const loaded = await readManifest(target);
    expect(loaded.name).toBe('duckprep');
    expect(loaded.repos[0].name).toBe('server');
    expect(loaded.embedding).toEqual({ provider: 'local', model: 'm', dtype: 'q8' });
  });

  it('records the client version that wrote it, so an older build can refuse', async () => {
    const manifest = createManifest('versioned', null);
    expect(manifest.minKnowlVersion).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('rejects a duplicate repo name', () => {
    const manifest = createManifest('dup', null);
    manifest.repos.push({ name: 'server' });
    expect(() => assertNameAvailable(manifest, 'server')).toThrow(/already/i);
  });

  it('rejects a retired repo name, so re-adding cannot adopt orphaned knowledge', () => {
    const manifest = createManifest('retired', null);
    manifest.retiredNames.push('server');
    expect(() => assertNameAvailable(manifest, 'server')).toThrow(/retired/i);
  });

  it('rejects an invalid name before it can reach a manifest', () => {
    expect(() => assertNameAvailable(createManifest('x', null), 'Bad Name')).toThrow(/lowercase/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx.cmd vitest run tests/workspace/manifest.test.ts`
Expected: FAIL — `Cannot find module '../../src/workspace/manifest.js'`

- [ ] **Step 3: Write minimal implementation**

Create `src/workspace/paths.ts`:

```typescript
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/**
 * Root for machine-local Knowl state that is not tied to one project.
 *
 * A workspace lives here rather than inside any member repo: putting it in one would make
 * that repo special, break when it is deleted, and risk it being committed.
 */
export function knowlHome(): string {
  const override = process.env.KNOWL_HOME;
  return override ? path.resolve(override) : path.join(os.homedir(), '.knowl');
}

export function workspacesRoot(): string {
  return path.join(knowlHome(), 'workspaces');
}

export function workspaceDir(name: string): string {
  return path.join(workspacesRoot(), name);
}

export function workspaceManifestPath(name: string): string {
  return path.join(workspaceDir(name), 'workspace.json');
}

/** Registry lookup, not a filesystem scan: only workspaces this machine created. */
export async function listKnownWorkspaces(): Promise<string[]> {
  try {
    const entries = await fs.readdir(workspacesRoot(), { withFileTypes: true });
    return entries.filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
  } catch {
    return [];
  }
}
```

Create `src/workspace/manifest.ts`:

```typescript
import fs from 'node:fs/promises';
import path from 'node:path';
import type { EmbeddingIdentity } from '../store/embedding-identity.js';
import { PACKAGE_VERSION } from '../version.js';

export type WorkspaceRepo = {
  /** Canonical identity. Immutable: it is the ownership key on every item this repo wrote. */
  name: string;
  /** Machine-local and optional. A manifest copied to another machine resolves paths there. */
  path?: string;
  /** Evidence for matching a repo on another machine, never authoritative. */
  git?: { remote?: string };
  addedAt?: string;
};

export type WorkspaceManifest = {
  version: 1;
  name: string;
  /** Guards the manifest format, separately from the database's PRAGMA user_version. */
  minKnowlVersion: string;
  /** One embedding identity for the whole workspace; null when vector search is off. */
  embedding: EmbeddingIdentity | null;
  repos: WorkspaceRepo[];
  /** Names that were removed. Never reusable -- see assertNameAvailable. */
  retiredNames: string[];
};

const REPO_NAME = /^[a-z0-9][a-z0-9-]*$/;

export function isValidRepoName(name: string): boolean {
  return REPO_NAME.test(name);
}

export function createManifest(name: string, embedding: EmbeddingIdentity | null): WorkspaceManifest {
  return { version: 1, name, minKnowlVersion: PACKAGE_VERSION, embedding, repos: [], retiredNames: [] };
}

export async function readManifest(manifestPath: string): Promise<WorkspaceManifest> {
  const raw = JSON.parse(await fs.readFile(manifestPath, 'utf8')) as WorkspaceManifest;
  return { ...raw, repos: raw.repos ?? [], retiredNames: raw.retiredNames ?? [] };
}

export async function writeManifest(manifestPath: string, manifest: WorkspaceManifest): Promise<void> {
  await fs.mkdir(path.dirname(manifestPath), { recursive: true });
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

/**
 * A name is the ownership key on every item its repo wrote, so handing one to a different
 * repo silently transfers knowledge. Retired names are therefore never reusable, even
 * after the repo that held them is gone.
 */
export function assertNameAvailable(manifest: WorkspaceManifest, name: string): void {
  if (!isValidRepoName(name)) {
    throw new Error(`Repo name "${name}" must be lowercase letters, digits and hyphens, starting with a letter or digit.`);
  }
  if (manifest.repos.some(repo => repo.name === name)) {
    throw new Error(`Repo name "${name}" is already used in workspace "${manifest.name}".`);
  }
  if (manifest.retiredNames.includes(name)) {
    throw new Error(`Repo name "${name}" was retired from workspace "${manifest.name}" and cannot be reused; choose another.`);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx.cmd vitest run tests/workspace/manifest.test.ts`
Expected: PASS, 8 tests

- [ ] **Step 5: Verify suite and typecheck**

Run: `npm.cmd test` — all pass
Run: `npx.cmd tsc --noEmit` — 15 errors, none in `src/workspace/`

- [ ] **Step 6: Commit**

```bash
git add src/workspace/paths.ts src/workspace/manifest.ts tests/workspace/manifest.test.ts
git commit -m "feat(workspace): manifest, paths and repo-name rules

A workspace lives at ~/.knowl/workspaces/<name>/ -- outside every member repo,
because putting it inside one would make that repo special, break when it is
deleted, and risk it being committed.

Repo names are the ownership key on every item their repo wrote, so a name
handed to a different repo silently transfers knowledge. Retired names are
recorded and never reusable."
```

---

### Task 2: Two-sided membership

**Files:**
- Create: `src/workspace/membership.ts`
- Modify: `src/core/types.ts` (add `workspace` to `ProjectConfig`)
- Test: `tests/workspace/membership.test.ts`

**Interfaces:**
- Produces:
  - `type WorkspaceLink = { workspace: string; repo: string }` — stored at `config.workspace`
  - `joinWorkspace(input: { projectRoot: string; workspaceName: string; repoName: string; force?: boolean }): Promise<WorkspaceManifest>`
  - `leaveWorkspace(projectRoot: string): Promise<void>`
  - `isLinked(projectRoot: string, manifest: WorkspaceManifest, config: ProjectConfig): boolean`
  - `assertNotNested(projectRoot: string, manifest: WorkspaceManifest): void`
  - `isConfigTrackedByGit(projectRoot: string): boolean`

**Context:** a repo is linked only when **both** its `.knowl/config.json` names the workspace *and* the manifest lists the repo. `.knowl/` is gitignored on init, so a cloned repo normally cannot ship config — and even un-ignored and committed, the manifest outside the repo does not list it, so nothing is shared and nothing is read. `findProjectRoot` walks **up**, so a repo nested inside another member resolves to the outer root: reject the topology rather than detect its consequences.

- [ ] **Step 1: Write the failing test**

Create `tests/workspace/membership.test.ts`:

```typescript
import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createManifest, readManifest } from '../../src/workspace/manifest.js';
import { assertNotNested, isLinked, joinWorkspace, leaveWorkspace } from '../../src/workspace/membership.js';
import { workspaceManifestPath } from '../../src/workspace/paths.js';
import { loadConfig, saveConfig, DEFAULT_CONFIG } from '../../src/core/config.js';
import { writeManifest } from '../../src/workspace/manifest.js';

const HOME = path.resolve('./.knowl-membership-home');
const REPO_A = path.resolve('./.knowl-membership-a');
const REPO_B = path.resolve('./.knowl-membership-b');

async function makeRepo(root: string) {
  await fs.mkdir(path.join(root, '.knowl'), { recursive: true });
  await saveConfig(root, { ...DEFAULT_CONFIG });
}

describe('two-sided membership', () => {
  beforeEach(async () => {
    process.env.KNOWL_HOME = HOME;
    for (const dir of [HOME, REPO_A, REPO_B]) await fs.rm(dir, { recursive: true, force: true });
    await makeRepo(REPO_A);
    await makeRepo(REPO_B);
    await writeManifest(workspaceManifestPath('ws'), createManifest('ws', null));
  });
  afterEach(async () => {
    delete process.env.KNOWL_HOME;
    for (const dir of [HOME, REPO_A, REPO_B]) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  it('writes both sides on join', async () => {
    await joinWorkspace({ projectRoot: REPO_A, workspaceName: 'ws', repoName: 'a' });
    const manifest = await readManifest(workspaceManifestPath('ws'));
    const config = await loadConfig(REPO_A);
    expect(manifest.repos.map(repo => repo.name)).toEqual(['a']);
    expect(config.workspace).toEqual({ workspace: 'ws', repo: 'a' });
  });

  it('is not linked when only the config names the workspace', async () => {
    await saveConfig(REPO_A, { ...DEFAULT_CONFIG, workspace: { workspace: 'ws', repo: 'a' } });
    const manifest = await readManifest(workspaceManifestPath('ws'));
    expect(isLinked(REPO_A, manifest, await loadConfig(REPO_A))).toBe(false);
  });

  it('is not linked when only the manifest lists the repo', async () => {
    const manifest = createManifest('ws', null);
    manifest.repos.push({ name: 'a', path: REPO_A });
    await writeManifest(workspaceManifestPath('ws'), manifest);
    expect(isLinked(REPO_A, manifest, await loadConfig(REPO_A))).toBe(false);
  });

  it('removes both sides on leave', async () => {
    await joinWorkspace({ projectRoot: REPO_A, workspaceName: 'ws', repoName: 'a' });
    await leaveWorkspace(REPO_A);
    expect((await loadConfig(REPO_A)).workspace).toBeUndefined();
  });

  it('rejects a repo nested inside an existing member', async () => {
    const nested = path.join(REPO_A, 'packages', 'inner');
    await fs.mkdir(path.join(nested, '.knowl'), { recursive: true });
    const manifest = createManifest('ws', null);
    manifest.repos.push({ name: 'a', path: REPO_A });
    // findProjectRoot walks up, so the inner repo would resolve to the outer one --
    // wrong ownership and wrong session binding, silently.
    expect(() => assertNotNested(nested, manifest)).toThrow(/nested/i);
  });

  it('rejects a member that would contain an existing one', async () => {
    const manifest = createManifest('ws', null);
    manifest.repos.push({ name: 'inner', path: path.join(REPO_A, 'packages', 'inner') });
    expect(() => assertNotNested(REPO_A, manifest)).toThrow(/contains/i);
  });

  it('refuses to reuse a retired name', async () => {
    await joinWorkspace({ projectRoot: REPO_A, workspaceName: 'ws', repoName: 'a' });
    await leaveWorkspace(REPO_A);
    await expect(joinWorkspace({ projectRoot: REPO_B, workspaceName: 'ws', repoName: 'a' }))
      .rejects.toThrow(/retired/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx.cmd vitest run tests/workspace/membership.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write minimal implementation**

Add to `ProjectConfig` in `src/core/types.ts`:

```typescript
  workspace?: { workspace: string; repo: string };
```

Create `src/workspace/membership.ts`:

```typescript
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import type { ProjectConfig } from '../core/types.js';
import { loadConfig, saveConfig } from '../core/config.js';
import { assertNameAvailable, readManifest, writeManifest, WorkspaceManifest } from './manifest.js';
import { workspaceManifestPath } from './paths.js';
import { canonicalProjectRoot } from '../core/project-path.js';

export type WorkspaceLink = { workspace: string; repo: string };

function contains(parent: string, child: string): boolean {
  const a = canonicalProjectRoot(parent);
  const b = canonicalProjectRoot(child);
  return b !== a && b.startsWith(`${a}${path.sep}`);
}

/**
 * `findProjectRoot` walks upward to the first `.knowl`, so a repo nested inside another
 * member silently resolves to the outer root -- wrong ownership, wrong session binding,
 * and nothing reports it. Rejecting the topology is cheaper than detecting its effects.
 */
export function assertNotNested(projectRoot: string, manifest: WorkspaceManifest): void {
  for (const repo of manifest.repos) {
    if (!repo.path) continue;
    if (contains(repo.path, projectRoot)) {
      throw new Error(`This repo is nested inside linked repo "${repo.name}". Link the outer repo instead.`);
    }
    if (contains(projectRoot, repo.path)) {
      throw new Error(`This repo contains linked repo "${repo.name}". Link the inner repos individually, or remove "${repo.name}" first.`);
    }
  }
}

/** A committed `.knowl/config.json` means the workspace pointer arrived with a clone. */
export function isConfigTrackedByGit(projectRoot: string): boolean {
  const result = spawnSync('git', ['ls-files', '--error-unmatch', '.knowl/config.json'], {
    cwd: projectRoot, stdio: 'ignore',
  });
  return result.status === 0;
}

/** Both sides must agree. Either alone is not membership. */
export function isLinked(projectRoot: string, manifest: WorkspaceManifest, config: ProjectConfig): boolean {
  const link = config.workspace;
  if (!link || link.workspace !== manifest.name) return false;
  return manifest.repos.some(repo => repo.name === link.repo);
}

export async function joinWorkspace(input: {
  projectRoot: string;
  workspaceName: string;
  repoName: string;
  force?: boolean;
}): Promise<WorkspaceManifest> {
  const manifestPath = workspaceManifestPath(input.workspaceName);
  const manifest = await readManifest(manifestPath);
  assertNameAvailable(manifest, input.repoName);
  assertNotNested(input.projectRoot, manifest);

  if (!input.force && isConfigTrackedByGit(input.projectRoot)) {
    throw new Error(
      '.knowl/config.json is tracked by git, so this workspace pointer may have arrived with a clone. Re-run with --force to link anyway.',
    );
  }

  manifest.repos.push({
    name: input.repoName,
    path: path.resolve(input.projectRoot),
    addedAt: new Date().toISOString(),
  });
  await writeManifest(manifestPath, manifest);

  const config = await loadConfig(input.projectRoot);
  await saveConfig(input.projectRoot, { ...config, workspace: { workspace: input.workspaceName, repo: input.repoName } });
  return manifest;
}

export async function leaveWorkspace(projectRoot: string): Promise<void> {
  const config = await loadConfig(projectRoot);
  const link = config.workspace;
  if (!link) return;

  const manifestPath = workspaceManifestPath(link.workspace);
  const manifest = await readManifest(manifestPath);
  manifest.repos = manifest.repos.filter(repo => repo.name !== link.repo);
  if (!manifest.retiredNames.includes(link.repo)) manifest.retiredNames.push(link.repo);
  await writeManifest(manifestPath, manifest);

  const { workspace: _removed, ...rest } = config;
  await saveConfig(projectRoot, rest as ProjectConfig);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx.cmd vitest run tests/workspace/membership.test.ts`
Expected: PASS, 7 tests

- [ ] **Step 5: Verify suite and typecheck**

Run: `npm.cmd test`; `npx.cmd tsc --noEmit` — 15

- [ ] **Step 6: Commit**

```bash
git add src/workspace/membership.ts src/core/types.ts tests/workspace/membership.test.ts
git commit -m "feat(workspace): two-sided membership with nesting and clone guards

A repo is linked only when its config names the workspace AND the manifest
lists the repo. Either alone is not membership, which is what makes linkage
un-forgeable by a cloned repository: .knowl/ is gitignored, and even
un-ignored and committed, the manifest outside the repo does not list it.

Rejects nesting outright. findProjectRoot walks up, so a repo inside another
member resolves to the outer root -- wrong ownership and wrong session binding,
with nothing reporting it."
```

---

### Task 3: `workspace add` backfills ownership

**Files:**
- Modify: `src/workspace/membership.ts`
- Test: `tests/workspace/backfill.test.ts`

**Interfaces:**
- Produces: `backfillOriginRepo(projectRoot: string, repoName: string): Promise<number>` — rows updated
- `joinWorkspace` calls it after writing both sides

**Context:** `origin_repo` shipped nullable in 2.4.0. Every pre-existing item in a joining repo is unowned, which means unfilterable, unlabelled, and outside the ownership rules. Joining is the one moment when the answer is unambiguous: everything already in this database was written by this repo. Also verify the repo's embedding identity matches the workspace's, since a mismatch makes items mutually invisible to vector search.

- [ ] **Step 1: Write the failing test**

Create `tests/workspace/backfill.test.ts`:

```typescript
import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, getClient, initDb } from '../../src/store/database.js';
import * as repo from '../../src/store/repository.js';
import { storeKnowledgeItemDeduped } from '../../src/store/knowledge-writer.js';
import { createManifest, writeManifest, readManifest } from '../../src/workspace/manifest.js';
import { workspaceManifestPath } from '../../src/workspace/paths.js';
import { joinWorkspace } from '../../src/workspace/membership.js';
import { DEFAULT_CONFIG, saveConfig } from '../../src/core/config.js';

const HOME = path.resolve('./.knowl-backfill-home');
const REPO = path.resolve('./.knowl-backfill-repo');

describe('origin_repo backfill on join', () => {
  beforeEach(async () => {
    process.env.KNOWL_HOME = HOME;
    await fs.rm(HOME, { recursive: true, force: true });
    await fs.rm(REPO, { recursive: true, force: true });
    await fs.mkdir(path.join(REPO, '.knowl'), { recursive: true });
    await saveConfig(REPO, { ...DEFAULT_CONFIG });
    await writeManifest(workspaceManifestPath('ws'), createManifest('ws', null));
    await initDb(REPO);
    const projectId = (await repo.createProject(REPO, 'backfill')).id;
    await storeKnowledgeItemDeduped(projectId, {
      category: 'decision', title: 'Wire format is protobuf',
      content: 'The server and client exchange protobuf, not JSON.',
    });
    await closeDb();
  });
  afterEach(async () => {
    delete process.env.KNOWL_HOME;
    await closeDb();
    await fs.rm(HOME, { recursive: true, force: true }).catch(() => {});
    await fs.rm(REPO, { recursive: true, force: true }).catch(() => {});
  });

  it('claims every pre-existing item for the joining repo', async () => {
    await joinWorkspace({ projectRoot: REPO, workspaceName: 'ws', repoName: 'server' });
    await initDb(REPO);
    const rows = await getClient().execute('SELECT origin_repo, visibility FROM knowledge_items');
    expect(rows.rows.length).toBeGreaterThan(0);
    expect(rows.rows.every(row => row.origin_repo === 'server')).toBe(true);
    // Backfill claims ownership; it does not publish. Sharing is an explicit promote.
    expect(rows.rows.every(row => row.visibility === 'repo')).toBe(true);
    await closeDb();
  });

  it('records the workspace embedding identity when the first repo joins', async () => {
    await joinWorkspace({ projectRoot: REPO, workspaceName: 'ws', repoName: 'server' });
    const manifest = await readManifest(workspaceManifestPath('ws'));
    expect(manifest.embedding).toEqual({ provider: 'local', model: 'Xenova/all-MiniLM-L6-v2', dtype: 'q8' });
  });

  it('refuses a repo whose embedding identity differs from the workspace', async () => {
    const manifest = createManifest('ws', { provider: 'local', model: 'Xenova/bge-small-en', dtype: 'q8' });
    manifest.repos.push({ name: 'other', path: path.resolve('./elsewhere') });
    await writeManifest(workspaceManifestPath('ws'), manifest);
    // Vector search filters on provider and model, so a mismatched repo's items would be
    // invisible -- and a filtered-out embedding looks exactly like no embedding.
    await expect(joinWorkspace({ projectRoot: REPO, workspaceName: 'ws', repoName: 'server' }))
      .rejects.toThrow(/embedding/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx.cmd vitest run tests/workspace/backfill.test.ts`
Expected: FAIL — `origin_repo` stays null; no embedding check

- [ ] **Step 3: Write minimal implementation**

Add to `src/workspace/membership.ts`:

```typescript
import { closeDb, getClient, initDb } from '../store/database.js';
import { embeddingIdentityFromConfig, formatEmbeddingIdentity, sameEmbeddingIdentity } from '../store/embedding-identity.js';

/**
 * Claim every existing item for the joining repo.
 *
 * origin_repo is nullable, and an unowned item is unfilterable, unlabelled and outside
 * every ownership rule. Joining is the one moment when the answer is unambiguous:
 * everything already in this database was written by this repo.
 *
 * Ownership only. Visibility stays 'repo' -- claiming is not publishing, and sharing
 * existing knowledge is an explicit `knowl workspace promote`.
 */
export async function backfillOriginRepo(projectRoot: string, repoName: string): Promise<number> {
  await initDb(projectRoot);
  try {
    const result = await getClient().execute({
      sql: 'UPDATE knowledge_items SET origin_repo = ? WHERE origin_repo IS NULL',
      args: [repoName],
    });
    return Number(result.rowsAffected ?? 0);
  } finally {
    await closeDb();
  }
}
```

In `joinWorkspace`, before mutating the manifest:

```typescript
  const config = await loadConfig(input.projectRoot);
  const identity = embeddingIdentityFromConfig(config);
  if (manifest.repos.length === 0) {
    manifest.embedding = identity;
  } else if (!sameEmbeddingIdentity(manifest.embedding, identity)) {
    throw new Error(
      `This repo embeds with ${formatEmbeddingIdentity(identity)} but workspace "${manifest.name}" uses ` +
      `${formatEmbeddingIdentity(manifest.embedding)}. Vector search filters on provider and model, so the ` +
      'two sets of items would be invisible to each other. Align the repo\'s search.vector config first.',
    );
  }
```

and after writing both sides:

```typescript
  await backfillOriginRepo(input.projectRoot, input.repoName);
```

(Reuse the `config` already loaded rather than loading twice.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx.cmd vitest run tests/workspace/backfill.test.ts`
Expected: PASS, 3 tests

- [ ] **Step 5: Verify suite and typecheck**

Run: `npm.cmd test`; `npx.cmd tsc --noEmit` — 15

- [ ] **Step 6: Commit**

```bash
git add src/workspace/membership.ts tests/workspace/backfill.test.ts
git commit -m "feat(workspace): claim existing knowledge on join, and pin embedding identity

origin_repo shipped nullable, and an unowned item is unfilterable, unlabelled
and outside every ownership rule. Joining is the one unambiguous moment:
everything already in this database was written by this repo. Ownership only --
visibility stays 'repo', because claiming is not publishing.

Also refuses a repo whose vector config differs from the workspace's.
searchKnowledgeEmbeddings filters on provider and model, so mismatched items
are mutually invisible -- and a filtered-out embedding looks identical to no
embedding, so the failure would be silent."
```

---

### Task 4: Resolve the active workspace and its peers

**Files:**
- Create: `src/workspace/resolve.ts`
- Test: `tests/workspace/resolve.test.ts`

**Interfaces:**
- Produces:
  - `type PeerRepo = { name: string; root: string; databasePath: string; present: boolean }`
  - `type ActiveWorkspace = { name: string; repo: string; manifest: WorkspaceManifest; peers: PeerRepo[] }`
  - `resolveWorkspace(projectRoot: string, config?: ProjectConfig): Promise<ActiveWorkspace | null>` — `null` when unlinked

**Context:** returns `null` for an unlinked repo, and every caller treats `null` as "behave exactly as before". `present` is false for a peer whose path does not exist on this machine — a partial checkout is normal and must never be an error.

- [ ] **Step 1: Write the failing test**

Create `tests/workspace/resolve.test.ts`:

```typescript
import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveWorkspace } from '../../src/workspace/resolve.js';
import { createManifest, writeManifest } from '../../src/workspace/manifest.js';
import { workspaceManifestPath } from '../../src/workspace/paths.js';
import { joinWorkspace } from '../../src/workspace/membership.js';
import { DEFAULT_CONFIG, saveConfig } from '../../src/core/config.js';
import { resolveStorage } from '../../src/store/storage-roles.js';

const HOME = path.resolve('./.knowl-resolve-home');
const A = path.resolve('./.knowl-resolve-a');
const B = path.resolve('./.knowl-resolve-b');

async function makeRepo(root: string) {
  await fs.mkdir(path.join(root, '.knowl'), { recursive: true });
  await saveConfig(root, { ...DEFAULT_CONFIG });
}

describe('resolveWorkspace', () => {
  beforeEach(async () => {
    process.env.KNOWL_HOME = HOME;
    for (const dir of [HOME, A, B]) await fs.rm(dir, { recursive: true, force: true });
    await makeRepo(A);
    await makeRepo(B);
    await writeManifest(workspaceManifestPath('ws'), createManifest('ws', null));
  });
  afterEach(async () => {
    delete process.env.KNOWL_HOME;
    for (const dir of [HOME, A, B]) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  it('returns null for an unlinked repo, so callers can behave exactly as before', async () => {
    expect(await resolveWorkspace(A)).toBeNull();
  });

  it('names this repo and lists the others as peers', async () => {
    await joinWorkspace({ projectRoot: A, workspaceName: 'ws', repoName: 'a' });
    await joinWorkspace({ projectRoot: B, workspaceName: 'ws', repoName: 'b' });

    const active = await resolveWorkspace(A);
    expect(active!.repo).toBe('a');
    expect(active!.peers.map(peer => peer.name)).toEqual(['b']);
    expect(active!.peers[0].databasePath).toBe(resolveStorage(B).knowledge);
    expect(active!.peers[0].present).toBe(true);
  });

  it('marks a peer missing from this machine rather than failing', async () => {
    await joinWorkspace({ projectRoot: A, workspaceName: 'ws', repoName: 'a' });
    await joinWorkspace({ projectRoot: B, workspaceName: 'ws', repoName: 'b' });
    await fs.rm(B, { recursive: true, force: true });

    const active = await resolveWorkspace(A);
    // A partial checkout is normal. Two of five repos on a laptop must work.
    expect(active!.peers[0].present).toBe(false);
  });

  it('returns null when only one side of membership agrees', async () => {
    await saveConfig(A, { ...DEFAULT_CONFIG, workspace: { workspace: 'ws', repo: 'a' } });
    expect(await resolveWorkspace(A)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx.cmd vitest run tests/workspace/resolve.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write minimal implementation**

Create `src/workspace/resolve.ts`:

```typescript
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { ProjectConfig } from '../core/types.js';
import { loadConfig } from '../core/config.js';
import { resolveStorage } from '../store/storage-roles.js';
import { readManifest, WorkspaceManifest } from './manifest.js';
import { workspaceManifestPath } from './paths.js';
import { isLinked } from './membership.js';

export type PeerRepo = { name: string; root: string; databasePath: string; present: boolean };
export type ActiveWorkspace = { name: string; repo: string; manifest: WorkspaceManifest; peers: PeerRepo[] };

/**
 * The single entry point for "am I in a workspace, and who else is".
 *
 * Returns null for an unlinked repo -- every caller treats that as "behave exactly as
 * before", which is how the no-workspace guarantee stays cheap to hold.
 */
export async function resolveWorkspace(projectRoot: string, config?: ProjectConfig): Promise<ActiveWorkspace | null> {
  const effective = config ?? await loadConfig(projectRoot).catch(() => null);
  const link = effective?.workspace;
  if (!link) return null;

  let manifest: WorkspaceManifest;
  try {
    manifest = await readManifest(workspaceManifestPath(link.workspace));
  } catch {
    return null; // manifest gone or unreadable: fall back to single-repo behavior
  }
  if (!isLinked(projectRoot, manifest, effective!)) return null;

  const peers = manifest.repos
    .filter(repo => repo.name !== link.repo && repo.path)
    .map(repo => {
      const root = path.resolve(repo.path!);
      return {
        name: repo.name,
        root,
        databasePath: resolveStorage(root).knowledge,
        // A partial checkout is normal, not an error: two of five repos on a laptop works.
        present: existsSync(root),
      };
    });

  return { name: manifest.name, repo: link.repo, manifest, peers };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx.cmd vitest run tests/workspace/resolve.test.ts`
Expected: PASS, 4 tests

- [ ] **Step 5: Verify suite and typecheck**

Run: `npm.cmd test`; `npx.cmd tsc --noEmit` — 15

- [ ] **Step 6: Commit**

```bash
git add src/workspace/resolve.ts tests/workspace/resolve.test.ts
git commit -m "feat(workspace): resolve the active workspace and its peers

One entry point for 'am I in a workspace, and who else is'. Returns null for an
unlinked repo so every caller treats that as unchanged behavior, which is how
the no-workspace guarantee stays cheap to hold.

A peer whose path is missing on this machine is marked absent rather than
raising: a partial checkout is normal, and two of five repos on a laptop has to
keep working."
```

---

### Task 5: Federated read with visibility and caps

**Files:**
- Create: `src/workspace/federated-query.ts`
- Test: `tests/workspace/federated-query.test.ts`

**Interfaces:**
- Produces:
  - `type FederatedItem = KnowledgeItem & { repo: string }`
  - `type FederatedResult = { items: FederatedItem[]; skipped: Array<{ repo: string; reason: 'absent' | 'unreadable' | 'schema-too-new' }> }`
  - `queryFederated(input: { workspace: ActiveWorkspace; localItems: KnowledgeItem[]; query: string; limit: number; repos?: string[]; perRepoCap?: number }): Promise<FederatedResult>`

**Context — the visibility matrix, implemented once:**

| Item | Own repo | Another linked repo | Under `repos: ["<its repo>"]` |
| --- | --- | --- | --- |
| `visibility = 'repo'` | returned | **never** | **never** |
| `visibility = 'workspace'` | returned | returned, labelled | returned |

Fusion is reciprocal rank across corpora, because BM25 scores from different databases are not comparable. Reuse `RRF_K` from `agent-query.ts`. **No weights and no boosts** — ties break toward the local repo and nothing else, because this repo justifies retrieval changes with checked-in ablations and three tunables cannot be evaluated without one.

- [ ] **Step 1: Write the failing test**

Create `tests/workspace/federated-query.test.ts`:

```typescript
import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, getClient, initDb } from '../../src/store/database.js';
import * as repo from '../../src/store/repository.js';
import { storeKnowledgeItemDeduped } from '../../src/store/knowledge-writer.js';
import { queryKnowledgeForAgent } from '../../src/store/agent-query.js';
import { queryFederated } from '../../src/workspace/federated-query.js';
import { resolveWorkspace } from '../../src/workspace/resolve.js';
import { createManifest, writeManifest } from '../../src/workspace/manifest.js';
import { workspaceManifestPath } from '../../src/workspace/paths.js';
import { joinWorkspace } from '../../src/workspace/membership.js';
import { DEFAULT_CONFIG, saveConfig } from '../../src/core/config.js';

const HOME = path.resolve('./.knowl-fed-home');
const A = path.resolve('./.knowl-fed-a');
const B = path.resolve('./.knowl-fed-b');

async function seed(root: string, name: string, items: Array<{ title: string; content: string; visibility: string }>) {
  await fs.mkdir(path.join(root, '.knowl'), { recursive: true });
  await saveConfig(root, { ...DEFAULT_CONFIG });
  await initDb(root);
  const projectId = (await repo.createProject(root, name)).id;
  for (const item of items) {
    const stored = await storeKnowledgeItemDeduped(projectId, { category: 'decision', title: item.title, content: item.content });
    await getClient().execute({
      sql: 'UPDATE knowledge_items SET visibility = ?, origin_repo = ? WHERE id = ?',
      args: [item.visibility, name, stored.item.id],
    });
  }
  await closeDb();
}

describe('federated read', () => {
  beforeEach(async () => {
    process.env.KNOWL_HOME = HOME;
    for (const dir of [HOME, A, B]) await fs.rm(dir, { recursive: true, force: true });
    await writeManifest(workspaceManifestPath('ws'), createManifest('ws', null));
    await seed(A, 'a', [{ title: 'Local auth note', content: 'Auth tokens expire locally.', visibility: 'repo' }]);
    await seed(B, 'b', [
      { title: 'Auth token TTL is fifteen minutes', content: 'Auth tokens expire after fifteen minutes.', visibility: 'workspace' },
      { title: 'Auth scratch note', content: 'Auth debugging scratch, not for sharing.', visibility: 'repo' },
    ]);
    await joinWorkspace({ projectRoot: A, workspaceName: 'ws', repoName: 'a' });
    await joinWorkspace({ projectRoot: B, workspaceName: 'ws', repoName: 'b' });
  });
  afterEach(async () => {
    delete process.env.KNOWL_HOME;
    await closeDb();
    for (const dir of [HOME, A, B]) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  it('returns a peer workspace-visible item, labelled with its repo', async () => {
    await initDb(A);
    const local = await queryKnowledgeForAgent('local', { query: 'auth', limit: 5, surface: 'test' });
    const active = (await resolveWorkspace(A))!;
    const result = await queryFederated({ workspace: active, localItems: local, query: 'auth', limit: 5 });

    const fromB = result.items.find(item => item.repo === 'b');
    expect(fromB).toBeDefined();
    expect(fromB!.title).toBe('Auth token TTL is fifteen minutes');
    await closeDb();
  });

  it('never returns a peer repo-private item', async () => {
    await initDb(A);
    const local = await queryKnowledgeForAgent('local', { query: 'auth', limit: 5, surface: 'test' });
    const active = (await resolveWorkspace(A))!;
    const result = await queryFederated({ workspace: active, localItems: local, query: 'auth', limit: 5 });
    expect(result.items.some(item => item.title === 'Auth scratch note')).toBe(false);
    await closeDb();
  });

  it('returns local repo-private items, which only leave their own repo', async () => {
    await initDb(A);
    const local = await queryKnowledgeForAgent('local', { query: 'auth', limit: 5, surface: 'test' });
    const active = (await resolveWorkspace(A))!;
    const result = await queryFederated({ workspace: active, localItems: local, query: 'auth', limit: 5 });
    expect(result.items.some(item => item.title === 'Local auth note' && item.repo === 'a')).toBe(true);
    await closeDb();
  });

  it('filters hard on origin repo, not on where an item might apply', async () => {
    await initDb(A);
    const local = await queryKnowledgeForAgent('local', { query: 'auth', limit: 5, surface: 'test' });
    const active = (await resolveWorkspace(A))!;
    const result = await queryFederated({ workspace: active, localItems: local, query: 'auth', limit: 5, repos: ['b'] });
    expect(result.items.length).toBeGreaterThan(0);
    expect(result.items.every(item => item.repo === 'b')).toBe(true);
    await closeDb();
  });

  it('reports an absent peer instead of swallowing it', async () => {
    await fs.rm(B, { recursive: true, force: true });
    await initDb(A);
    const local = await queryKnowledgeForAgent('local', { query: 'auth', limit: 5, surface: 'test' });
    const active = (await resolveWorkspace(A))!;
    const result = await queryFederated({ workspace: active, localItems: local, query: 'auth', limit: 5 });
    // "absent" and "empty" must not look the same -- that ambiguity is the support
    // question this feature will generate most.
    expect(result.skipped).toEqual([{ repo: 'b', reason: 'absent' }]);
    await closeDb();
  });

  it('never returns more than the limit, however many repos are linked', async () => {
    await initDb(A);
    const local = await queryKnowledgeForAgent('local', { query: 'auth', limit: 5, surface: 'test' });
    const active = (await resolveWorkspace(A))!;
    const result = await queryFederated({ workspace: active, localItems: local, query: 'auth', limit: 1 });
    expect(result.items.length).toBe(1);
    await closeDb();
  });

  it('leaves the peer database byte-identical', async () => {
    const peerDb = path.join(B, '.knowl', 'knowl.db');
    const before = await fs.readFile(peerDb);
    await initDb(A);
    const local = await queryKnowledgeForAgent('local', { query: 'auth', limit: 5, surface: 'test' });
    const active = (await resolveWorkspace(A))!;
    await queryFederated({ workspace: active, localItems: local, query: 'auth', limit: 5 });
    await closeDb();
    expect((await fs.readFile(peerDb)).equals(before)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx.cmd vitest run tests/workspace/federated-query.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write minimal implementation**

Create `src/workspace/federated-query.ts`:

```typescript
import { acquireClient } from '../store/connection-pool.js';
import { SchemaTooNewError } from '../store/schema-version.js';
import type { KnowledgeItem } from '../core/types.js';
import type { ActiveWorkspace, PeerRepo } from './resolve.js';

/** Same constant the agent ranker uses; imported rather than restated. */
import { RRF_K } from '../store/agent-query.js';

export type FederatedItem = KnowledgeItem & { repo: string };
export type SkipReason = 'absent' | 'unreadable' | 'schema-too-new';
export type FederatedResult = { items: FederatedItem[]; skipped: Array<{ repo: string; reason: SkipReason }> };

const DEFAULT_PER_REPO_CAP = 10;

/**
 * Peer knowledge is read with a plain FTS-free LIKE scan rather than the agent ranker,
 * because the ranker needs an initialized ambient database and this must not disturb the
 * caller's. Candidates are capped per repo and fused by rank, so a cheap peer scan cannot
 * outrank a properly scored local result -- only interleave with it.
 */
async function peerCandidates(peer: PeerRepo, query: string, cap: number): Promise<KnowledgeItem[]> {
  const client = await acquireClient(peer.databasePath, { readOnly: true });
  const like = `%${query.toLowerCase()}%`;
  const rows = await client.execute({
    sql: `SELECT id, category, status, title, content, reasoning, tags, source, content_hash,
                 freshness, confidence, version, created_at, updated_at
          FROM knowledge_items
          WHERE status = 'active' AND visibility = 'workspace'
            AND (lower(title) LIKE ? OR lower(content) LIKE ?)
          ORDER BY updated_at DESC
          LIMIT ?`,
    args: [like, like, cap],
  });
  return rows.rows.map(row => ({
    id: String(row.id),
    category: String(row.category),
    status: String(row.status),
    title: String(row.title),
    content: String(row.content),
    reasoning: row.reasoning === null ? null : String(row.reasoning),
    tags: row.tags ? JSON.parse(String(row.tags)) : null,
    source: row.source === null ? null : String(row.source),
    contentHash: row.content_hash === null ? null : String(row.content_hash),
    freshness: String(row.freshness),
    confidence: Number(row.confidence),
    version: Number(row.version),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  })) as unknown as KnowledgeItem[];
}

/**
 * Reciprocal-rank fusion across corpora.
 *
 * BM25 scores from different databases are not comparable -- they depend on each corpus's
 * term statistics -- so raw-score fusion would let one repo dominate or vanish arbitrarily
 * for reasons unrelated to relevance. Rank sidesteps that entirely.
 *
 * No weights and no boosts. This repo justifies retrieval changes with a checked-in
 * ablation, and tunables that arrive without one cannot be evaluated. Ties break toward the
 * local repo; that is the whole of the local preference.
 */
export async function queryFederated(input: {
  workspace: ActiveWorkspace;
  localItems: KnowledgeItem[];
  query: string;
  limit: number;
  repos?: string[];
  perRepoCap?: number;
}): Promise<FederatedResult> {
  const cap = input.perRepoCap ?? DEFAULT_PER_REPO_CAP;
  const wanted = input.repos && input.repos.length > 0 ? new Set(input.repos) : null;
  const skipped: FederatedResult['skipped'] = [];

  const ranked: Array<{ item: FederatedItem; score: number; local: boolean }> = [];

  if (!wanted || wanted.has(input.workspace.repo)) {
    input.localItems.slice(0, cap).forEach((item, index) => {
      ranked.push({ item: { ...item, repo: input.workspace.repo }, score: 1 / (RRF_K + index + 1), local: true });
    });
  }

  for (const peer of input.workspace.peers) {
    if (wanted && !wanted.has(peer.name)) continue;
    if (!peer.present) { skipped.push({ repo: peer.name, reason: 'absent' }); continue; }
    try {
      const candidates = await peerCandidates(peer, input.query, cap);
      candidates.forEach((item, index) => {
        ranked.push({ item: { ...item, repo: peer.name }, score: 1 / (RRF_K + index + 1), local: false });
      });
    } catch (error) {
      skipped.push({ repo: peer.name, reason: error instanceof SchemaTooNewError ? 'schema-too-new' : 'unreadable' });
    }
  }

  const seen = new Set<string>();
  const items = ranked
    .sort((a, b) => (b.score - a.score) || (Number(b.local) - Number(a.local)))
    .filter(entry => {
      const key = entry.item.contentHash ?? `${entry.item.title}\n${entry.item.content}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, input.limit)
    .map(entry => entry.item);

  return { items, skipped };
}
```

Export `RRF_K` from `src/store/agent-query.ts` if it is not already exported.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx.cmd vitest run tests/workspace/federated-query.test.ts`
Expected: PASS, 7 tests

- [ ] **Step 5: Verify suite and typecheck**

Run: `npm.cmd test`; `npx.cmd tsc --noEmit` — 15

- [ ] **Step 6: Commit**

```bash
git add src/workspace/federated-query.ts src/store/agent-query.ts tests/workspace/federated-query.test.ts
git commit -m "feat(workspace): federated read with visibility, caps and rank fusion

Reads fan out across linked repos' own databases, read-only. A peer's
repo-private items never cross; workspace-visible ones do, labelled with the
repo that owns them.

Fusion is reciprocal rank because BM25 scores from different databases are not
comparable -- they depend on each corpus's term statistics, so raw-score fusion
would let one repo dominate for reasons unrelated to relevance. No weights and
no boosts: this repo justifies retrieval changes with a checked-in ablation, and
tunables arriving without one cannot be evaluated.

Absent peers are reported, not swallowed. 'Absent' and 'empty' looking the same
is the support question this feature would otherwise generate most."
```

---

### Task 6: `knowl_query` serves federated results

**Files:**
- Modify: `src/mcp/tools.ts` (query handler, tool schema)
- Test: `tests/mcp/workspace-query.test.ts`

**Interfaces:**
- Consumes: `resolveWorkspace`, `queryFederated`, `compactItemResponse(item, { repo })`
- Produces: `knowl_query` accepts `repos?: string[]`; each item carries `repo`; skipped repos are disclosed in a second content block

**Context:** follow the `fc6171e` disclosure pattern exactly — the first content block stays a bare JSON array so existing callers are unaffected, and the second names what was skipped. Do not invent a new shape.

- [ ] **Step 1: Write the failing test**

Create `tests/mcp/workspace-query.test.ts` modelled on the fixture in Task 5, asserting:

```typescript
  it('labels every item with its repo in the serialized payload', async () => {
    const response = await callTool('knowl_query', { query: 'auth', limit: 5 });
    const items = JSON.parse(response.content[0].text);
    expect(items.every((item: any) => typeof item.repo === 'string')).toBe(true);
  });

  it('accepts a repos filter', async () => {
    const response = await callTool('knowl_query', { query: 'auth', limit: 5, repos: ['b'] });
    const items = JSON.parse(response.content[0].text);
    expect(items.every((item: any) => item.repo === 'b')).toBe(true);
  });

  it('discloses a skipped repo in a second block, leaving the first a bare array', async () => {
    // Same shape fc6171e established for skipped namespaces.
    const response = await callTool('knowl_query', { query: 'auth', limit: 5 });
    expect(Array.isArray(JSON.parse(response.content[0].text))).toBe(true);
    expect(response.content[1].text).toContain('b');
  });

  it('omits repo entirely when the project has no workspace', async () => {
    const response = await callToolInUnlinkedRepo('knowl_query', { query: 'auth', limit: 5 });
    const items = JSON.parse(response.content[0].text);
    expect(items.every((item: any) => item.repo === undefined)).toBe(true);
    expect(response.content.length).toBe(1);
  });
```

Reuse the existing `tests/mcp/server.test.ts` harness for constructing the server and calling tools.

- [ ] **Step 2: Run test to verify it fails**
- [ ] **Step 3: Implement** — in the `knowl_query` handler, after the existing item resolution:

```typescript
        const active = projectRoot ? await resolveWorkspace(projectRoot, config ?? undefined) : null;
        let federatedSkips: FederatedResult['skipped'] = [];
        let labelled = items.map(item => compactItemResponse(item));
        if (active) {
          const federated = await queryFederated({
            workspace: active, localItems: items, query: query ?? '', limit: limit ?? 3, repos,
          });
          federatedSkips = federated.skipped;
          labelled = federated.items.map(item => compactItemResponse(item, { repo: item.repo }));
        }
```

and append the disclosure block when `federatedSkips.length > 0`, matching the existing skipped-namespace block's construction.

- [ ] **Step 4: Verify** — `npx.cmd vitest run tests/mcp/workspace-query.test.ts` passes
- [ ] **Step 5: Full suite and typecheck** — 15 errors
- [ ] **Step 6: Commit** `feat(workspace): knowl_query serves federated results with repo labels`

---

### Task 7: `knowl workspace promote`

**Files:** Create `src/workspace/promote.ts`; Test `tests/workspace/promote.test.ts`

**Interfaces:**
- `promoteItems(input: { projectRoot: string; repoName: string; categories?: KnowledgeCategory[]; ids?: string[]; apply?: boolean }): Promise<{ items: Array<{ id: string; title: string }>; applied: boolean }>`

**Context:** category routing only affects future writes, so without a backfill, linking shares nothing a team has already learned — including the wire-format decision the whole design is motivated by. `promote` sets `visibility = 'workspace'` on items **this repo originated**. Dry-run by default. No `demote`: retracting knowledge other repos have read needs a mechanism that does not exist.

Tests to write: promotes by category; promotes by id; refuses an item this repo did not originate; dry-run changes nothing; `content_hash` and item count are unchanged by a promote.

- [ ] Steps 1–6 following the established pattern.

---

### Task 8: Clamp duplicate resolution across owners

**Files:** Modify `src/store/knowledge-writer.ts`; Test `tests/store/cross-repo-dedup.test.ts`

**Context:** `resolveDuplicate` supersedes on `sameSubjectTitle` — a title-token subset, whose own documented example is "Database is SQLite" against "Project database uses SQLite". Across two repos of one product that is ordinary. Detection may span owners (an overlapping item elsewhere is exactly the signal a workspace provides); **resolution is forced to `coexist` when the detected duplicate has a different `origin_repo`**, including when an explicit `supersedes` names a foreign item.

Tests: a write in repo A does not supersede an item owned by repo B; the `nearDuplicate` report names the owning repo; an explicit `supersedes` targeting a foreign item is refused; same-owner supersession is unchanged.

- [ ] Steps 1–6 following the established pattern.

---

### Task 9: Scope every implicit read

**Files:** Modify `src/store/recent-context.ts`, `context-bootstrap.ts`, `context-composer.ts`, `work-loop.ts`, `synthesis.ts`; Test `tests/workspace/implicit-reads.test.ts`

**Context:** auto-injected context must never contain another repo's knowledge. These are separate call sites, so one shared assertion would pass while individual surfaces leak — **one test per surface**. Implicit reads resolve to `origin_repo = <current>` only, *not* `visibility = 'workspace'`: workspace knowledge arrives through an explicit query where the agent asked for it. Synthesis additionally restricts its sources to the current repo and inherits the most restrictive source visibility.

- [ ] Steps 1–6, with five separate assertions.

---

### Task 10: Item-scoped tools refuse foreign items

**Files:** Modify `src/mcp/tools.ts`; Test `tests/mcp/foreign-item-refusal.test.ts`

**Context:** `knowl_update`, `knowl_timeline`, `knowl_evidence_list` and `knowl_feedback` take a bare item id and resolve it against the current database; evidence staleness is evaluated against the current `projectRoot`. Left alone they answer confidently about the wrong repo. Each refuses a foreign item naming the owning repo, and `knowl_query` omits `evidence`/`stale` for foreign items rather than computing them against the wrong filesystem. **A wrong answer is worse than an absent one here.**

- [ ] Steps 1–6.

---

### Task 11: Visibility — status, doctor, explain

**Files:** Create `src/cli/workspace-report.ts`; modify `src/cli/status-report.ts`, `src/cli/doctor-report.ts`, `src/mcp/tools.ts`; Test `tests/cli/workspace-report.test.ts`

**Context:** every failure mode of query-time fan-out is silent. `knowl status` gains a workspace block; `knowl doctor` gains manifest reachability, repos present/missing, version agreement, nesting violations, and embedding-identity drift; `knowl_query --explain` reports per-repo reached/skipped/candidate counts. Repo names by default, absolute paths only under `--verbose`.

- [ ] Steps 1–6.

---

### Task 12: Agent guidance

**Files:** Modify `src/core/knowl-guidance.ts`; Test `tests/core/knowl-guidance.test.ts`

**Context:** the MCP `instructions` block does not reach subagents — this repo probed it and documented the finding at `knowl-guidance.ts:120`, which is why `KNOWL_SUBAGENT_BOOTSTRAP_CARD` exists. Workspace guidance goes in `renderFullKnowlGuidance()` and the subagent card. One paragraph: knowledge from another repo is labelled with its repo name and applies *there* unless it says otherwise; cross-repo knowledge is shared with `knowl workspace promote`. Update the README's token-overhead table rather than invalidating it.

- [ ] Steps 1–6.

---

### Task 13: The `knowl workspace` command group

**Files:** Modify `src/index.ts`; Test `tests/cli/workspace-cli.test.ts`

```
knowl workspace init <name> [--path <dir>]
knowl workspace add [<path>] [--name <repo-name>] [--force]
knowl workspace join <manifest-path>
knowl workspace list
knowl workspace status
knowl workspace remove <repo-name> [--transfer-to <repo> | --export-first]
knowl workspace promote --category <list> | --id <id>... [--apply]
```

`knowl init` offers to join a workspace already registered for a sibling path — a registry lookup via `listKnownWorkspaces`, not a filesystem scan.

- [ ] Steps 1–6.

---

### Task 14: Cross-repo eval cases

**Files:** Add fixtures under `docs/evals/`; Test via the existing benchmark runner

**Context:** Task 5 ships fusion with no tunables specifically so that weights can later be justified by measurement. This task supplies the measurement: cross-repo cases in the eval set, and a recorded baseline for cross-repo MRR and R@3 so a future weighting change can be shown to help or hurt.

- [ ] Steps 1–6.

---

### Task 15: The no-workspace guarantee, end to end

**Files:** Test `tests/workspace/no-workspace-regression.test.ts`

Assert on a project with no workspace: `knowl_query` output is byte-identical to a recorded baseline (no `repo` field, one content block); `origin_repo` stays NULL and `visibility` stays `'repo'` on every write; `knowl status` and `knowl doctor` output contain no workspace section; implicit reads return what they returned before; `resolveWorkspace` returns null and no manifest is read.

**This is the contract that makes the feature safe to ship.** It goes last so it runs against everything.

- [ ] Steps 1–6.

---

## Self-review

**Spec coverage.** Manifest and paths → 1. Two-sided membership, nesting, tracked-config → 2. Ownership backfill and embedding pinning → 3. Workspace resolution → 4. Visibility matrix, fusion, caps, skip reporting → 5. MCP query surface → 6. `promote` → 7. Cross-owner dedup clamp → 8. Implicit read scoping → 9. Foreign-item refusals → 10. Status/doctor/explain → 11. Guidance → 12. CLI → 13. Evals → 14. No-workspace guarantee → 15.

**Deliberately out of scope:** the shared workspace database, `namespace: 'workspace'` writes, the advisory applies-to table, migration, `lifecycle_hash`, tombstone monotonicity, purge disabling, snapshot/export scoping. All v2.

**Known gap.** Tasks 7–15 are specified with context, interfaces and test intent but not full code. Tasks 1–6 carry the load-bearing design and are written out completely; the later tasks follow established patterns in this codebase and should be expanded to full TDD steps by the implementer before starting each one, or by a follow-up pass on this document. This is called out rather than hidden — a plan that claims completeness it does not have is worse than one that says where it thins out.

**Type consistency.** `ActiveWorkspace`/`PeerRepo` from Task 4 are consumed with those field names in Tasks 5, 6 and 11. `FederatedResult.skipped` from Task 5 is consumed in Task 6. `compactItemResponse(item, { repo })` matches the 2.4.0 signature. `RRF_K` is imported from `agent-query.ts`, not restated.
