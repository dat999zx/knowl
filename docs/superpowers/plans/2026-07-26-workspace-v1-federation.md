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
| `src/mcp/tools.ts` | `repos` filter, `repo` label, foreign-item refusals, workspace in `knowl_state` | 6, 9 |
| `src/cli/workspace-report.ts` | **New.** `knowl workspace list/status` rendering | 10 |
| `src/cli/status-report.ts`, `src/cli/doctor-report.ts` | Workspace sections | 10 |
| `src/core/knowl-guidance.ts` | One workspace paragraph in the managed section and subagent card | 11 |
| `src/index.ts` | `knowl workspace` command group | 12 |
| `docs/evals/` | Cross-repo retrieval cases | 13 |

Tasks 1–3 are sequential. Tasks 4–6 depend on 3. Tasks 7–11 depend on 4. Task 12 depends on 1–3 and 7. Tasks 13–14 are last.

**Peers never join the generic namespace list.** This is the load-bearing structural decision
of v1 and it was wrong in the first draft of this plan. Federation is reachable only through
`queryFederated`, called explicitly from `knowl_query`. Because each repo's database holds
only its own items, that one restriction makes every implicit read — recent context, pinned
constraints, work-loop bootstrap, synthesis — naturally scoped, with no per-call-site
plumbing. Adding peers to `configuredNamespaces` instead would have leaked foreign knowledge
into auto-injected context through `composeContext`, which is exactly the injection channel
the spec forbids.

Two tasks the first draft listed are consequently gone: scoping implicit reads, and clamping
write-time duplicate resolution across owners. Neither can fire in v1 — a repo's database
contains no foreign items to leak or to supersede. Both are real, and both move to v2, where
one database holds every repo's knowledge. Task 8 pins the property so v2 cannot regress it
silently.

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

Run: `npx.cmd vitest run tests/mcp/workspace-query.test.ts`
Expected: FAIL — no `repo` on any item; `repos` is not an accepted argument

- [ ] **Step 3: Write minimal implementation**

First the tool schema, in the `knowl_query` entry of the tool list:

```typescript
              repos: {
                type: 'array',
                items: { type: 'string' },
                description: 'Restrict results to knowledge produced by these linked repos. Matches the owning repo only, not repos an item merely applies to.',
              },
```

Then the handler, after the existing item resolution and before the evidence/compaction step:

```typescript
        // Federation is reached only from here. Peers are deliberately absent from
        // configuredNamespaces so implicit context assembly cannot fan out (see the
        // federation-is-opt-in tests).
        const active = projectRoot ? await resolveWorkspace(projectRoot, config ?? undefined) : null;
        let federatedSkips: FederatedResult['skipped'] = [];
        let resolved: Array<KnowledgeItem & { repo?: string }> = items;
        if (active) {
          const federated = await queryFederated({
            workspace: active,
            localItems: items,
            query: query ?? '',
            limit: limit ?? 3,
            repos,
          });
          federatedSkips = federated.skipped;
          resolved = federated.items;
        }
```

and make the existing `compact` closure carry the label through — it must go via
`compactItemResponse`'s second argument, because the compact shape is an allowlist and a field
attached to the item alone would be dropped:

```typescript
        const compact = (item: KnowledgeItem & { repo?: string; explanation?: unknown }) => ({
          ...compactItemResponse(item, item.repo ? { repo: item.repo } : undefined),
          ...(explain && item.explanation ? { explanation: item.explanation } : {}),
        });
```

Finally the disclosure, appended only when something was skipped, built the same way as the
existing skipped-namespace block so both read alike:

```typescript
        const blocks: Array<{ type: 'text'; text: string }> = [{ type: 'text', text: compactMcpJson(payload) }];
        if (federatedSkips.length > 0) {
          const described = federatedSkips.map(skip => `${skip.repo} (${skip.reason})`).join(', ');
          blocks.push({
            type: 'text',
            text: `Linked repos not searched: ${described}. Their knowledge is absent from these results.`,
          });
        }
        return { content: blocks };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx.cmd vitest run tests/mcp/workspace-query.test.ts`
Expected: PASS, 4 tests

- [ ] **Step 5: Verify suite and typecheck**

Run: `npm.cmd test`; `npx.cmd tsc --noEmit` — 15 errors

- [ ] **Step 6: Commit**

```bash
git add src/mcp/tools.ts tests/mcp/workspace-query.test.ts
git commit -m "feat(workspace): knowl_query serves federated results with repo labels

Every item carries the repo that owns it, and a repos filter restricts results
to what a named repo produced -- matching origin only, never the repos an item
merely applies to, so a filtered result set stays explainable.

The label goes through compactItemResponse's provenance argument rather than
onto the item: the compact shape is an allowlist, so a field attached upstream
is dropped before serialization.

Skipped repos are disclosed in a second content block, leaving the first a bare
JSON array -- the shape fc6171e already established for skipped namespaces,
rather than a new one."
```

---
### Task 7: `knowl workspace promote`

**Files:**
- Create: `src/workspace/promote.ts`
- Test: `tests/workspace/promote.test.ts`

**Interfaces:**
- Consumes: `initDb`/`closeDb`/`getClient` from `src/store/database.js`
- Produces:
  - `type PromoteTarget = { id: string; title: string; category: string }`
  - `type PromoteResult = { items: PromoteTarget[]; applied: boolean; skippedForeign: number }`
  - `promoteItems(input: { projectRoot: string; repoName: string; categories?: KnowledgeCategory[]; ids?: string[]; apply?: boolean }): Promise<PromoteResult>`

**Context the implementer needs:** category-driven routing only affects *future* writes. Without
a backfill, linking shares nothing a team has already learned — including the wire-format
decision the whole design is motivated by, which already exists in someone's repo today.
`promote` sets `visibility = 'workspace'` on items this repo originated. It is a one-column
update, so it does not touch `content_hash`, does not create rows, and does not move anything
between databases.

Dry-run is the default. There is deliberately no `demote`: retracting knowledge other repos
have already read is a different problem with no mechanism behind it.

- [ ] **Step 1: Write the failing test**

Create `tests/workspace/promote.test.ts`:

```typescript
import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, getClient, initDb } from '../../src/store/database.js';
import * as repo from '../../src/store/repository.js';
import { storeKnowledgeItemDeduped } from '../../src/store/knowledge-writer.js';
import { promoteItems } from '../../src/workspace/promote.js';

const ROOT = path.resolve('./.knowl-promote-test');

async function seed(): Promise<{ decision: string; fact: string }> {
  await fs.rm(ROOT, { recursive: true, force: true });
  await fs.mkdir(path.join(ROOT, '.knowl'), { recursive: true });
  await initDb(ROOT);
  const projectId = (await repo.createProject(ROOT, 'promote')).id;
  const decision = await storeKnowledgeItemDeduped(projectId, {
    category: 'decision', title: 'Wire format is protobuf',
    content: 'Server and client exchange protobuf, not JSON.',
  });
  const fact = await storeKnowledgeItemDeduped(projectId, {
    category: 'fact', title: 'Local scratch note',
    content: 'A scratch observation that should stay in this repo.',
  });
  await getClient().execute("UPDATE knowledge_items SET origin_repo = 'server'");
  await closeDb();
  return { decision: decision.item.id, fact: fact.item.id };
}

describe('promote', () => {
  let ids: { decision: string; fact: string };
  beforeEach(async () => { ids = await seed(); });
  afterEach(async () => { await closeDb(); await fs.rm(ROOT, { recursive: true, force: true }).catch(() => {}); });

  it('dry-runs by default and changes nothing', async () => {
    const result = await promoteItems({ projectRoot: ROOT, repoName: 'server', categories: ['decision'] });
    expect(result.applied).toBe(false);
    expect(result.items.map(item => item.title)).toEqual(['Wire format is protobuf']);

    await initDb(ROOT);
    const rows = await getClient().execute("SELECT COUNT(*) AS n FROM knowledge_items WHERE visibility = 'workspace'");
    expect(Number(rows.rows[0].n)).toBe(0);
    await closeDb();
  });

  it('promotes by category when applied', async () => {
    await promoteItems({ projectRoot: ROOT, repoName: 'server', categories: ['decision'], apply: true });
    await initDb(ROOT);
    const rows = await getClient().execute("SELECT title FROM knowledge_items WHERE visibility = 'workspace'");
    expect(rows.rows.map(row => String(row.title))).toEqual(['Wire format is protobuf']);
    await closeDb();
  });

  it('promotes by id', async () => {
    await promoteItems({ projectRoot: ROOT, repoName: 'server', ids: [ids.fact], apply: true });
    await initDb(ROOT);
    const rows = await getClient().execute("SELECT title FROM knowledge_items WHERE visibility = 'workspace'");
    expect(rows.rows.map(row => String(row.title))).toEqual(['Local scratch note']);
    await closeDb();
  });

  it('refuses items this repo did not originate, and says how many', async () => {
    await initDb(ROOT);
    await getClient().execute("UPDATE knowledge_items SET origin_repo = 'web' WHERE category = 'decision'");
    await closeDb();

    const result = await promoteItems({ projectRoot: ROOT, repoName: 'server', categories: ['decision'], apply: true });
    expect(result.items).toEqual([]);
    expect(result.skippedForeign).toBe(1);
  });

  it('does not change content_hash or item count -- promotion is a visibility change', async () => {
    await initDb(ROOT);
    const before = await getClient().execute('SELECT id, content_hash FROM knowledge_items ORDER BY id');
    await closeDb();

    await promoteItems({ projectRoot: ROOT, repoName: 'server', categories: ['decision'], apply: true });

    await initDb(ROOT);
    const after = await getClient().execute('SELECT id, content_hash FROM knowledge_items ORDER BY id');
    expect(after.rows.length).toBe(before.rows.length);
    expect(after.rows.map(row => String(row.content_hash))).toEqual(before.rows.map(row => String(row.content_hash)));
    await closeDb();
  });

  it('is idempotent', async () => {
    await promoteItems({ projectRoot: ROOT, repoName: 'server', categories: ['decision'], apply: true });
    const second = await promoteItems({ projectRoot: ROOT, repoName: 'server', categories: ['decision'], apply: true });
    expect(second.items.length).toBe(0);
  });

  it('requires a category or an id, so a bare promote cannot publish everything', async () => {
    await expect(promoteItems({ projectRoot: ROOT, repoName: 'server', apply: true }))
      .rejects.toThrow(/--category|--id/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx.cmd vitest run tests/workspace/promote.test.ts`
Expected: FAIL — `Cannot find module '../../src/workspace/promote.js'`

- [ ] **Step 3: Write minimal implementation**

Create `src/workspace/promote.ts`:

```typescript
import type { KnowledgeCategory } from '../core/types.js';
import { closeDb, getClient, initDb } from '../store/database.js';

export type PromoteTarget = { id: string; title: string; category: string };
export type PromoteResult = { items: PromoteTarget[]; applied: boolean; skippedForeign: number };

/**
 * Backfill existing knowledge into workspace visibility.
 *
 * Category routing governs future writes only, so without this, linking shares nothing a
 * team already learned. Promotion is a one-column update: it does not touch `content_hash`,
 * create rows, or move anything between databases.
 *
 * Only items this repo originated can be promoted -- publishing another repo's knowledge is
 * that repo's decision. There is no `demote`: retracting something other repos have already
 * read needs a mechanism this design does not have.
 */
export async function promoteItems(input: {
  projectRoot: string;
  repoName: string;
  categories?: KnowledgeCategory[];
  ids?: string[];
  apply?: boolean;
}): Promise<PromoteResult> {
  const byCategory = input.categories?.length ? input.categories : null;
  const byId = input.ids?.length ? input.ids : null;
  if (!byCategory && !byId) {
    throw new Error('Specify what to promote with --category <list> or --id <id>. A bare promote would publish the whole repo.');
  }

  await initDb(input.projectRoot);
  try {
    const client = getClient();
    const selector = byId
      ? { clause: `id IN (${byId.map(() => '?').join(', ')})`, args: [...byId] as string[] }
      : { clause: `category IN (${byCategory!.map(() => '?').join(', ')})`, args: [...byCategory!] as string[] };

    // Counted separately so the caller can say "1 item belongs to web" rather than silently
    // returning fewer rows than the user asked for.
    const foreign = await client.execute({
      sql: `SELECT COUNT(*) AS n FROM knowledge_items
            WHERE ${selector.clause} AND status = 'active'
              AND visibility = 'repo' AND (origin_repo IS NULL OR origin_repo <> ?)`,
      args: [...selector.args, input.repoName],
    });

    const rows = await client.execute({
      sql: `SELECT id, title, category FROM knowledge_items
            WHERE ${selector.clause} AND status = 'active'
              AND visibility = 'repo' AND origin_repo = ?
            ORDER BY updated_at DESC`,
      args: [...selector.args, input.repoName],
    });

    const items: PromoteTarget[] = rows.rows.map(row => ({
      id: String(row.id), title: String(row.title), category: String(row.category),
    }));

    if (input.apply && items.length > 0) {
      await client.execute({
        sql: `UPDATE knowledge_items SET visibility = 'workspace'
              WHERE id IN (${items.map(() => '?').join(', ')})`,
        args: items.map(item => item.id),
      });
    }

    return { items, applied: Boolean(input.apply) && items.length > 0, skippedForeign: Number(foreign.rows[0]?.n ?? 0) };
  } finally {
    await closeDb();
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx.cmd vitest run tests/workspace/promote.test.ts`
Expected: PASS, 7 tests

- [ ] **Step 5: Verify suite and typecheck**

Run: `npm.cmd test`; `npx.cmd tsc --noEmit` — 15 errors

- [ ] **Step 6: Commit**

```bash
git add src/workspace/promote.ts tests/workspace/promote.test.ts
git commit -m "feat(workspace): promote existing knowledge into workspace visibility

Category routing governs future writes only, so linking would have shared
nothing a team already learned -- including the wire-format decision the whole
design is motivated by, which already exists in someone's repo today.

A one-column update: content_hash, item count and storage location all
unchanged. Dry-run by default, and a bare promote is refused so it cannot
publish an entire repo by accident. Only items this repo originated; no demote,
because retracting what other repos have read needs a mechanism that does not
exist."
```

---

### Task 8: Federation is opt-in — implicit reads never fan out

**Files:**
- Test: `tests/workspace/implicit-reads-scoped.test.ts`
- Modify: `src/store/namespaces.ts` only if a peer descriptor has leaked into `configuredNamespaces`

**Context the implementer needs:** this task is a **guard, not a feature**. In v1 each repo's
database holds only that repo's items, so recent context, pinned constraints, work-loop
bootstrap and synthesis are scoped for free — *provided* peers are never added to
`configuredNamespaces`. Task 4 deliberately keeps peers out of it and exposes them only through
`queryFederated`.

That property is worth pinning rather than assuming, for two reasons. Adding peers to the
namespace list is the obvious-looking shortcut a future change might take, and `composeContext`
calls `queryLayeredKnowledge`, so the leak would land straight in auto-injected context — the
injection channel the spec forbids. These tests fail loudly if anyone takes the shortcut.

The first draft of this plan listed "scope every implicit read" as v1 work with per-call-site
plumbing. That was wrong: there is nothing to scope until v2 puts every repo's items in one
database. The plumbing moves to v2; the guarantee gets pinned here.

- [ ] **Step 1: Write the failing test**

Create `tests/workspace/implicit-reads-scoped.test.ts`, reusing the two-repo fixture from Task 5
(repo `b` holds a `workspace`-visibility item titled `Auth token TTL is fifteen minutes`):

```typescript
  it('configuredNamespaces contains no peer database', async () => {
    // The structural guarantee. If a peer ever appears here, composeContext will inject
    // another repo's knowledge into auto-assembled context without anyone asking.
    const descriptors = configuredNamespaces(A, await loadConfig(A));
    expect(descriptors.map(entry => entry.databasePath)).not.toContain(resolveStorage(B).knowledge);
  });

  it('getRecentContext returns nothing from a linked repo', async () => {
    await initDb(A);
    const recent = await getRecentContext('local', { itemLimit: 20 });
    expect(recent.items.some(item => item.title.includes('Auth token TTL'))).toBe(false);
    await closeDb();
  });

  it('composeContext returns nothing from a linked repo', async () => {
    await initDb(A);
    const pack = await composeContext('local', { query: 'auth', tokenBudget: 2000, namespaceRoot: A });
    const titles = pack.sections.flatMap(section => section.items.map(item => item.title));
    expect(titles.some(title => title.includes('Auth token TTL'))).toBe(false);
    await closeDb();
  });

  it('startWorkLoop bootstrap returns nothing from a linked repo', async () => {
    await initDb(A);
    const started = await startWorkLoop('local', 'Investigate auth');
    expect(JSON.stringify(started)).not.toContain('fifteen minutes');
    await closeDb();
  });

  it('synthesize cannot draw on a linked repo', async () => {
    await initDb(A);
    const item = await synthesizeKnowledge('local', 'auth');
    expect(item.content).not.toContain('fifteen minutes');
    await closeDb();
  });

  it('knowl_query does fan out -- federation is opt-in, not absent', async () => {
    // The counterpart assertion. Without it this suite would pass if federation were
    // simply broken.
    await initDb(A);
    const local = await queryKnowledgeForAgent('local', { query: 'auth', limit: 5, surface: 'test' });
    const active = (await resolveWorkspace(A))!;
    const federated = await queryFederated({ workspace: active, localItems: local, query: 'auth', limit: 5 });
    expect(federated.items.some(item => item.repo === 'b')).toBe(true);
    await closeDb();
  });
```

The synthesize case needs two local `auth` sources to satisfy its minimum; seed repo `A` with a
second one in the fixture.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx.cmd vitest run tests/workspace/implicit-reads-scoped.test.ts`
Expected: the five scoping assertions **pass** and the sixth **fails** until Task 5 is wired
into this fixture. If any of the five fails, a peer has reached the namespace list and Task 4
must be fixed before continuing — that is the signal this task exists to raise.

- [ ] **Step 3: Implementation**

Expected to be **no production change**. If a scoping assertion fails, remove the peer
descriptor from `configuredNamespaces` and route it through `queryFederated` instead. Do not
add a filter to the implicit read — that would leave the leak one call site away.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx.cmd vitest run tests/workspace/implicit-reads-scoped.test.ts`
Expected: PASS, 6 tests

- [ ] **Step 5: Verify suite and typecheck**

Run: `npm.cmd test`; `npx.cmd tsc --noEmit` — 15 errors

- [ ] **Step 6: Commit**

```bash
git add tests/workspace/implicit-reads-scoped.test.ts
git commit -m "test(workspace): pin federation as opt-in

In v1 each repo's database holds only its own items, so implicit reads are
scoped for free -- provided peers never join configuredNamespaces. That is worth
pinning rather than assuming: adding peers to the namespace list is the
obvious-looking shortcut, and composeContext goes through queryLayeredKnowledge,
so the leak would land straight in auto-injected context.

Five assertions that recent context, pinned constraints, work-loop bootstrap and
synthesis see nothing foreign, plus one that knowl_query does fan out -- without
which the suite would pass if federation were simply broken."
```

---

### Task 9: Item-scoped tools refuse foreign items

**Files:**
- Create: `src/workspace/ownership.ts`
- Modify: `src/mcp/tools.ts` (`knowl_update`, `knowl_timeline`, `knowl_evidence_list`, `knowl_feedback`, and the evidence block of `knowl_query`)
- Test: `tests/mcp/foreign-item-refusal.test.ts`

**Interfaces:**
- Produces:
  - `class ForeignItemError extends Error`
  - `assertOwnedItem(itemId: string, workspace: ActiveWorkspace | null): Promise<void>`

**Context the implementer needs:** these tools take a bare item id and resolve it against the
current database. A federated result now carries a `repo` label, so an agent can ask about an
item that is not in this database — and today's handlers would answer from the wrong one, or
compute evidence staleness against the wrong filesystem (`tools.ts:740` uses the current
`projectRoot`). A confident wrong answer is worse than a refusal: it tells an agent to
re-verify knowledge that is perfectly current, or reports success for an update that changed
nothing.

v1 is read-only across repos, so refusal is the correct terminal behavior, not a placeholder.
v2 keeps it, for ownership reasons rather than storage ones.

**Check before writing:** 2.4.0 added the `origin_repo` column and the Drizzle field, but
`mapRowToKnowledgeItem` in `src/store/repository.ts` may not read it. If `originRepo` comes back
`undefined`, `assertOwnedItem` refuses every local item. Verify first.

- [ ] **Step 1: Write the failing test**

Create `tests/mcp/foreign-item-refusal.test.ts`, using the Task 5 two-repo fixture plus the
tool-call harness from `tests/mcp/server.test.ts`:

```typescript
  it('knowl_update refuses an item this repo does not own, naming the owner', async () => {
    const foreignId = await idOfPeerItem('Auth token TTL is fifteen minutes');
    const response = await callTool('knowl_update', { id: foreignId, content: 'Rewritten from the wrong repo.' });
    expect(response.content[0].text).toMatch(/belongs to repo "b"/);
  });

  it('the refused update really did not write', async () => {
    const foreignId = await idOfPeerItem('Auth token TTL is fifteen minutes');
    const before = await peerItemContent(foreignId);
    await callTool('knowl_update', { id: foreignId, content: 'Rewritten from the wrong repo.' });
    expect(await peerItemContent(foreignId)).toBe(before);
  });

  it('knowl_timeline, knowl_evidence_list and knowl_feedback refuse a foreign id', async () => {
    const foreignId = await idOfPeerItem('Auth token TTL is fifteen minutes');
    for (const tool of ['knowl_timeline', 'knowl_evidence_list']) {
      expect((await callTool(tool, { itemId: foreignId })).content[0].text).toMatch(/belongs to repo "b"/);
    }
    expect((await callTool('knowl_feedback', { itemId: foreignId, used: true })).content[0].text)
      .toMatch(/belongs to repo "b"/);
  });

  it('knowl_query omits evidence for foreign items rather than computing it here', async () => {
    // Staleness resolved against this repo's filesystem would report "stale" for a file
    // that simply lives in another checkout -- a wrong answer, not a missing one.
    const response = await callTool('knowl_query', { query: 'auth', limit: 5, includeEvidence: true });
    const foreign = JSON.parse(response.content[0].text).find((item: any) => item.repo === 'b');
    expect(foreign.evidence).toBeUndefined();
  });

  it('local items are unaffected', async () => {
    const localId = await idOfLocalItem('Local auth note');
    const response = await callTool('knowl_update', { id: localId, content: 'Updated locally, which is allowed.' });
    expect(response.content[0].text).not.toMatch(/belongs to repo/);
  });

  it('an unlinked repo behaves exactly as before', async () => {
    const response = await callToolInUnlinkedRepo('knowl_update', { id: unlinkedItemId, content: 'Fine.' });
    expect(response.content[0].text).not.toMatch(/belongs to repo/);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx.cmd vitest run tests/mcp/foreign-item-refusal.test.ts`
Expected: FAIL — the handlers answer instead of refusing

- [ ] **Step 3: Write minimal implementation**

Create `src/workspace/ownership.ts`:

```typescript
import { getKnowledgeItem } from '../store/repository.js';
import { acquireClient } from '../store/connection-pool.js';
import type { ActiveWorkspace } from './resolve.js';

export class ForeignItemError extends Error {
  constructor(itemId: string, repo: string) {
    super(`Item ${itemId} belongs to repo "${repo}" and was not changed. Run this from that repo.`);
    this.name = 'ForeignItemError';
  }
}

async function ownerFromPeers(itemId: string, workspace: ActiveWorkspace): Promise<string | null> {
  for (const peer of workspace.peers) {
    if (!peer.present) continue;
    try {
      const client = await acquireClient(peer.databasePath, { readOnly: true });
      const rows = await client.execute({ sql: 'SELECT 1 FROM knowledge_items WHERE id = ? LIMIT 1', args: [itemId] });
      if (rows.rows.length > 0) return peer.name;
    } catch {
      // An unreadable peer cannot claim the item; keep looking.
    }
  }
  return null;
}

/**
 * An item-scoped tool takes a bare id and resolves it against the current database. Now that
 * federated results carry a repo label, an agent can ask about an item that is not here --
 * and answering from the wrong database, or computing staleness against the wrong
 * filesystem, is a confident wrong answer rather than a missing one.
 *
 * A null origin means the item predates workspace ownership and is local by definition.
 */
export async function assertOwnedItem(itemId: string, workspace: ActiveWorkspace | null): Promise<void> {
  if (!workspace) return; // no workspace: every id is local
  const local = await getKnowledgeItem(itemId);
  if (local && (local.originRepo == null || local.originRepo === workspace.repo)) return;

  const owner = local?.originRepo ?? await ownerFromPeers(itemId, workspace);
  throw new ForeignItemError(itemId, owner ?? 'another linked repo');
}
```

In `src/mcp/tools.ts`, guard each item-scoped handler:

```typescript
        const active = projectRoot ? await resolveWorkspace(projectRoot, config ?? undefined) : null;
        try {
          await assertOwnedItem(id, active);
        } catch (error) {
          return { content: [{ type: 'text', text: (error as Error).message }] };
        }
```

and in the `knowl_query` evidence path, skip evidence resolution when the item's `repo` is not
the current repo.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx.cmd vitest run tests/mcp/foreign-item-refusal.test.ts`
Expected: PASS, 6 tests

- [ ] **Step 5: Verify suite and typecheck**

Run: `npm.cmd test`; `npx.cmd tsc --noEmit` — 15 errors

- [ ] **Step 6: Commit**

```bash
git add src/workspace/ownership.ts src/mcp/tools.ts src/store/repository.ts tests/mcp/foreign-item-refusal.test.ts
git commit -m "feat(workspace): item-scoped tools refuse items they do not own

knowl_update, knowl_timeline, knowl_evidence_list and knowl_feedback take a bare
id and resolve it against the current database. Federated results now carry a
repo label, so an agent can ask about an item that is not here -- and the
handlers would have answered from the wrong database, or computed evidence
staleness against the wrong filesystem, reporting 'stale' for a file that simply
lives in another checkout.

Each refuses by naming the owning repo, and knowl_query omits evidence for
foreign items rather than computing it here. A wrong answer is worse than an
absent one: it sends an agent to re-verify knowledge that is current."
```

---

### Task 10: Visibility — status, doctor, explain

**Files:**
- Create: `src/cli/workspace-report.ts`
- Modify: `src/cli/status-report.ts`, `src/cli/doctor-report.ts`, `src/mcp/tools.ts` (`knowl_state`, `explain`)
- Test: `tests/cli/workspace-report.test.ts`

**Interfaces:**
- Produces:
  - `type DoctorCheck = { status: 'OK' | 'WARN' | 'FAIL'; message: string; fix?: string }`
  - `formatWorkspaceBlock(active: ActiveWorkspace | null, options?: { verbose?: boolean }): string[]`
  - `workspaceDoctorChecks(active: ActiveWorkspace | null, config: ProjectConfig): DoctorCheck[]`

**Context the implementer needs:** every failure mode of query-time fan-out is silent. A peer
whose path is gone, a manifest that moved, a repo whose vector config drifted, a nesting
violation created by moving a directory — each degrades retrieval with no error. "Why did my
cross-repo query return nothing" is the support question this feature will generate most, and
the answer has to be one command away.

Repo names by default; absolute paths only under `--verbose`, matching the existing decision to
keep resolved roots out of routine output.

- [ ] **Step 1: Write the failing test**

Create `tests/cli/workspace-report.test.ts`:

```typescript
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { formatWorkspaceBlock, workspaceDoctorChecks } from '../../src/cli/workspace-report.js';
import { createManifest } from '../../src/workspace/manifest.js';
import type { ActiveWorkspace } from '../../src/workspace/resolve.js';
import { DEFAULT_CONFIG } from '../../src/core/config.js';

const active = (overrides: Partial<ActiveWorkspace> = {}): ActiveWorkspace => ({
  name: 'duckprep',
  repo: 'server',
  manifest: createManifest('duckprep', { provider: 'local', model: 'Xenova/all-MiniLM-L6-v2', dtype: 'q8' }),
  peers: [
    { name: 'web', root: path.resolve('/repos/web'), databasePath: path.resolve('/repos/web/.knowl/knowl.db'), present: true },
    { name: 'protocol', root: path.resolve('/repos/protocol'), databasePath: path.resolve('/repos/protocol/.knowl/knowl.db'), present: false },
  ],
  ...overrides,
});

describe('workspace status block', () => {
  it('is empty when there is no workspace, so unlinked output is unchanged', () => {
    expect(formatWorkspaceBlock(null)).toEqual([]);
  });

  it('names the workspace, this repo, and each peer', () => {
    const text = formatWorkspaceBlock(active()).join('\n');
    expect(text).toContain('duckprep');
    expect(text).toContain('server');
    expect(text).toContain('web');
  });

  it('marks a peer that is missing from this machine', () => {
    expect(formatWorkspaceBlock(active()).join('\n')).toMatch(/protocol.*(missing|not on this machine)/i);
  });

  it('shows names, not absolute paths, unless verbose', () => {
    expect(formatWorkspaceBlock(active()).join('\n')).not.toContain(path.resolve('/repos/web'));
    expect(formatWorkspaceBlock(active(), { verbose: true }).join('\n')).toContain(path.resolve('/repos/web'));
  });
});

describe('workspace doctor checks', () => {
  it('returns nothing for an unlinked project', () => {
    expect(workspaceDoctorChecks(null, DEFAULT_CONFIG)).toEqual([]);
  });

  it('warns about an absent peer rather than reporting OK', () => {
    const checks = workspaceDoctorChecks(active(), DEFAULT_CONFIG);
    expect(checks.some(check => check.status === 'WARN' && /protocol/.test(check.message))).toBe(true);
  });

  it('warns when this repo embeds differently from the workspace', () => {
    const drifted = {
      ...DEFAULT_CONFIG,
      search: { vector: { enabled: true, provider: 'local', model: 'other', dtype: 'q8' } },
    } as typeof DEFAULT_CONFIG;
    // A mismatched embedding makes items mutually invisible, and a filtered-out embedding
    // looks exactly like no embedding -- nothing else would report this.
    expect(workspaceDoctorChecks(active(), drifted).some(check => check.status === 'WARN' && /embed/i.test(check.message))).toBe(true);
  });

  it('reports OK when every peer is present and the identity matches', () => {
    const healthy = active({
      peers: [{ name: 'web', root: '/repos/web', databasePath: '/repos/web/.knowl/knowl.db', present: true }],
    });
    expect(workspaceDoctorChecks(healthy, DEFAULT_CONFIG).every(check => check.status === 'OK')).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx.cmd vitest run tests/cli/workspace-report.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write minimal implementation**

Create `src/cli/workspace-report.ts`:

```typescript
import type { ProjectConfig } from '../core/types.js';
import type { ActiveWorkspace } from '../workspace/resolve.js';
import { embeddingIdentityFromConfig, formatEmbeddingIdentity, sameEmbeddingIdentity } from '../store/embedding-identity.js';

export type DoctorCheck = { status: 'OK' | 'WARN' | 'FAIL'; message: string; fix?: string };

const LINE = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━';

/** Empty for an unlinked project, so existing status output stays byte-identical. */
export function formatWorkspaceBlock(active: ActiveWorkspace | null, options: { verbose?: boolean } = {}): string[] {
  if (!active) return [];
  const lines = [LINE, '🔗 WORKSPACE', `  Workspace:     ${active.name}`, `  This repo:     ${active.repo}`];
  if (active.peers.length === 0) {
    lines.push('  Linked repos:  none yet');
    return lines;
  }
  lines.push('  Linked repos:');
  for (const peer of active.peers) {
    const state = peer.present ? 'present' : 'missing from this machine';
    // Names by default; resolved roots stay out of routine output.
    lines.push(`    ${peer.name.padEnd(16)} ${state}${options.verbose ? ` (${peer.root})` : ''}`);
  }
  return lines;
}

/**
 * Every failure mode of query-time fan-out is silent, so these checks are the answer to
 * "why did my cross-repo query return nothing".
 */
export function workspaceDoctorChecks(active: ActiveWorkspace | null, config: ProjectConfig): DoctorCheck[] {
  if (!active) return [];
  const checks: DoctorCheck[] = [
    { status: 'OK', message: `Workspace "${active.name}" reachable; this repo is "${active.repo}"` },
  ];

  for (const peer of active.peers) {
    checks.push(peer.present
      ? { status: 'OK', message: `Linked repo "${peer.name}" present` }
      : {
        status: 'WARN',
        message: `Linked repo "${peer.name}" is missing from this machine; its knowledge is skipped`,
        fix: `re-add it with \`knowl workspace add <path> --name ${peer.name}\`, or remove it`,
      });
  }

  const local = embeddingIdentityFromConfig(config);
  if (!sameEmbeddingIdentity(local, active.manifest.embedding)) {
    checks.push({
      status: 'WARN',
      message: `This repo embeds with ${formatEmbeddingIdentity(local)} but the workspace uses ${formatEmbeddingIdentity(active.manifest.embedding)}; vector search filters on provider and model, so the two sets of items are invisible to each other`,
      fix: 'align `search.vector` with the workspace, then run `knowl reindex --vectors`',
    });
  }

  return checks;
}
```

Wire `formatWorkspaceBlock` into `formatStatusReport` (an optional `workspace` input, absent for
unlinked projects), append `workspaceDoctorChecks` to the doctor's check list, add a workspace
section to `knowl_state`, and extend `knowl_query`'s `explain` payload with per-repo `reached` /
`skipped` / `candidates` counts derived from `FederatedResult`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx.cmd vitest run tests/cli/workspace-report.test.ts`
Expected: PASS, 8 tests

- [ ] **Step 5: Verify suite and typecheck**

Run: `npm.cmd test`; `npx.cmd tsc --noEmit` — 15 errors

- [ ] **Step 6: Commit**

```bash
git add src/cli/workspace-report.ts src/cli/status-report.ts src/cli/doctor-report.ts src/mcp/tools.ts tests/cli/workspace-report.test.ts
git commit -m "feat(workspace): make fan-out failures visible in status, doctor and explain

Every failure mode of query-time fan-out is silent: a peer whose path is gone, a
manifest that moved, a repo whose vector config drifted. 'Why did my cross-repo
query return nothing' is the support question this generates most, and the
answer is now one command away.

Embedding drift gets its own check because nothing else would report it -- a
filtered-out embedding looks exactly like no embedding. Names by default,
resolved roots only under --verbose."
```

---

### Task 11: Agent guidance

**Files:**
- Modify: `src/core/knowl-guidance.ts`, `README.md` (token-overhead table)
- Test: `tests/core/knowl-guidance.test.ts`

**Context the implementer needs:** the MCP `instructions` block **does not reach subagents** —
this repo probed it live and documented the finding at `knowl-guidance.ts:120`, which is why
`KNOWL_SUBAGENT_BOOTSTRAP_CARD` exists. Putting workspace guidance only in the server
instructions would leave every subagent unaware of it. It goes in `renderFullKnowlGuidance()`
(the managed `KNOWL.md` / `AGENTS.md` section) and in the subagent card.

One paragraph, because guidance is charged to every agent on every session. The README
publishes measured token overhead; update the figure rather than invalidating it.

- [ ] **Step 1: Write the failing test**

Add to `tests/core/knowl-guidance.test.ts`:

```typescript
  it('tells agents what a repo label means, in the surfaces that reach them', () => {
    // The MCP instructions block does not reach subagents (probed; see knowl-guidance.ts).
    // These two do.
    for (const text of [renderFullKnowlGuidance(), KNOWL_SUBAGENT_BOOTSTRAP_CARD]) {
      expect(text).toMatch(/repo/i);
      expect(text).toMatch(/applies (to that repo|there)/i);
    }
  });

  it('names the command that shares knowledge across repos', () => {
    expect(renderFullKnowlGuidance()).toContain('knowl workspace promote');
  });

  it('stays within the published guidance budget', () => {
    expect(estimateTokens(renderFullKnowlGuidance())).toBeLessThan(GUIDANCE_TOKEN_BUDGET);
  });
```

Set `GUIDANCE_TOKEN_BUDGET` from the README's current published figure plus the new paragraph's
measured cost, and update the README table in the same commit.

- [ ] **Step 2: Run test to verify it fails** — `npx.cmd vitest run tests/core/knowl-guidance.test.ts`
- [ ] **Step 3: Implement** the paragraph in `renderFullKnowlGuidance()` and `KNOWL_SUBAGENT_BOOTSTRAP_CARD`
- [ ] **Step 4: Run test to verify it passes**
- [ ] **Step 5: Verify suite and typecheck** — 15 errors
- [ ] **Step 6: Commit**

```bash
git add src/core/knowl-guidance.ts README.md tests/core/knowl-guidance.test.ts
git commit -m "docs(workspace): tell agents what a repo label means

Guidance goes in the managed KNOWL.md section and the subagent bootstrap card,
not the MCP instructions block -- this repo probed that block and found it does
not reach subagents, which is why the card exists.

One paragraph, because guidance is charged to every agent on every session, and
the README's published token overhead is updated rather than invalidated."
```

---

### Task 12: The `knowl workspace` command group

**Files:**
- Modify: `src/index.ts`
- Test: `tests/cli/workspace-cli.test.ts`

```
knowl workspace init <name> [--path <dir>]
knowl workspace add [<path>] [--name <repo-name>] [--force]
knowl workspace join <manifest-path>
knowl workspace list
knowl workspace status
knowl workspace remove <repo-name> [--transfer-to <repo> | --export-first]
knowl workspace promote --category <list> | --id <id>... [--apply]
```

**Context the implementer needs:** follow the `codeCommand` pattern at `src/index.ts:384` — a
`program.command('workspace')` group whose subcommands resolve the project root, do their work,
and close the database in a `finally`.

`knowl init` offers to join a workspace already registered for a sibling path, via
`listKnownWorkspaces()`. That is a **registry lookup, not a filesystem scan** — scanning is a
stated non-goal, and the first draft of the design contradicted itself on exactly this point.

`remove` refuses while the named repo still owns items, offering `--transfer-to` or
`--export-first`. A name is the ownership key on every item its repo wrote, so removing it
without deciding what happens to those items orphans them.

- [ ] **Step 1: Write the failing test** covering: each subcommand's happy path; `add` refusing
  without `--force` when `.knowl/config.json` is tracked by git; `remove` refusing while items
  remain and succeeding after `--export-first`; `promote` defaulting to dry-run; `list` on a
  machine with no workspaces printing a useful empty state rather than erroring.
- [ ] **Step 2: Run test to verify it fails**
- [ ] **Step 3: Implement** the command group, delegating to Tasks 1–3, 7 and 10
- [ ] **Step 4: Run test to verify it passes**
- [ ] **Step 5: Verify suite, typecheck and `npm.cmd run build`**
- [ ] **Step 6: Commit** — `feat(workspace): knowl workspace command group`

---

### Task 13: Cross-repo eval cases

**Files:**
- Modify: `docs/evals/retrieval-suite.json`, `docs/evals/retrieval-baseline.json`
- Test: the existing benchmark runner

**Context the implementer needs:** Task 5 ships fusion with **no weights and no boosts**
specifically so a later weighting change can be justified by measurement. This task supplies
the measurement. Without it there is no way to tell whether cross-repo retrieval helps or
quietly degrades single-repo quality — and this repo has a standing convention of justifying
retrieval changes with a checked-in ablation (the README records equal-weight fusion →
vector-first lifting MRR from 78.4% to 96.1%).

- [ ] **Step 1: Read the existing suite shape**

Run: `npx.cmd tsx -e "console.log(Object.keys(require('./docs/evals/retrieval-suite.json')))"`
or simply open `docs/evals/retrieval-suite.json`. Match its case shape exactly rather than
inventing a parallel format — the benchmark runner reads it directly.

- [ ] **Step 2: Add the three case shapes**

Append to `docs/evals/retrieval-suite.json`, tagged so cross-repo cases can be scored separately:

```jsonc
{
  "id": "xrepo-answer-elsewhere",
  "tags": ["cross-repo"],
  "repos": {
    "web": [{ "category": "fact", "title": "Client retry budget", "content": "The web client retries idempotent calls three times.", "visibility": "repo" }],
    "server": [{ "category": "decision", "title": "Auth token TTL is fifteen minutes", "content": "Auth tokens expire after fifteen minutes.", "visibility": "workspace" }]
  },
  "queryFrom": "web",
  "query": "how long do auth tokens last",
  "expectedItemTitle": "Auth token TTL is fifteen minutes",
  "expectedRepo": "server"
},
{
  "id": "xrepo-local-wins-on-tie",
  "tags": ["cross-repo"],
  "repos": {
    "web": [{ "category": "decision", "title": "Retry policy", "content": "Retry idempotent calls three times with jitter.", "visibility": "repo" }],
    "server": [{ "category": "decision", "title": "Retry policy", "content": "Retry idempotent calls three times with jitter.", "visibility": "workspace" }]
  },
  "queryFrom": "web",
  "query": "retry policy",
  "expectedRepo": "web"
},
{
  "id": "xrepo-foreign-distractor",
  "tags": ["cross-repo"],
  "repos": {
    "web": [{ "category": "fact", "title": "Web build output directory", "content": "The web build emits to dist/web.", "visibility": "repo" }],
    "server": [{ "category": "fact", "title": "Server build output directory", "content": "The server build emits to dist/server.", "visibility": "workspace" }]
  },
  "queryFrom": "web",
  "query": "where does the build output go",
  "expectedItemTitle": "Web build output directory",
  "expectedRepo": "web"
}
```

The second and third cases matter more than the first. Anyone can make cross-repo retrieval
return *something*; the risk this feature actually carries is a foreign item outranking the
local answer, and these two are the cases that would catch it.

- [ ] **Step 3: Teach the runner to build a two-repo fixture**

The runner currently seeds one database. For a case with a `repos` key it seeds one temporary
repo per entry, links them into a scratch workspace under a temporary `KNOWL_HOME`, and issues
the query from `queryFrom` through `queryFederated`. Reuse the fixture helper from Task 5's test
rather than writing a second one.

- [ ] **Step 4: Run the benchmark and record the baseline**

Run: `npm.cmd run benchmark` (or whatever `package.json` exposes — check `scripts`).
Record cross-repo MRR and R@3 into `docs/evals/retrieval-baseline.json` under a `crossRepo` key,
kept separate from the single-repo figures so a regression in either is visible on its own.

- [ ] **Step 5: Verify single-repo numbers did not move**

Compare the single-repo MRR and R@3 against the existing baseline. **They must be unchanged** —
federation adds a code path that unlinked projects never enter, so any movement here means
something leaked into the default path and Task 8's guard missed it.

- [ ] **Step 6: Commit**

```bash
git add docs/evals/retrieval-suite.json docs/evals/retrieval-baseline.json
git commit -m "test(evals): cross-repo retrieval cases and baseline

Task 5 ships fusion with no weights and no boosts specifically so a later
weighting change can be justified by measurement. This is the measurement.

The two cases that matter are not 'does a linked repo's answer come back' --
anyone can make that work. They are 'does the local answer still win on a tie'
and 'does a plausible foreign distractor outrank the correct local answer',
which is the failure this feature actually risks.

Single-repo figures are asserted unchanged: federation is a path unlinked
projects never enter, so any movement means something leaked into the default."
```

---

### Task 14: The no-workspace guarantee, end to end

**Files:**
- Test: `tests/workspace/no-workspace-regression.test.ts`

Assert, on a project with no workspace:

- `knowl_query` output is byte-identical to a recorded baseline — no `repo` field, exactly one
  content block.
- Every write leaves `origin_repo` NULL and `visibility` `'repo'`.
- `knowl status` and `knowl doctor` output contain no workspace section.
- `getRecentContext`, `composeContext`, `startWorkLoop` and `synthesizeKnowledge` return what
  they returned before.
- `resolveWorkspace` returns null without opening a manifest — assert by pointing `KNOWL_HOME`
  at a path that does not exist, so an attempted read would throw.

**This is the contract that makes the feature safe to ship**, and it goes last so it runs
against every other task's changes rather than a subset.

- [ ] **Step 1: Write the test**

Create `tests/workspace/no-workspace-regression.test.ts`:

```typescript
import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, getClient, initDb } from '../../src/store/database.js';
import * as repo from '../../src/store/repository.js';
import { storeKnowledgeItemDeduped } from '../../src/store/knowledge-writer.js';
import { queryKnowledgeForAgent } from '../../src/store/agent-query.js';
import { compactItemResponse, compactMcpJson } from '../../src/mcp/response-format.js';
import { resolveWorkspace } from '../../src/workspace/resolve.js';
import { formatWorkspaceBlock, workspaceDoctorChecks } from '../../src/cli/workspace-report.js';
import { getRecentContext } from '../../src/store/recent-context.js';
import { composeContext } from '../../src/store/context-composer.js';
import { DEFAULT_CONFIG } from '../../src/core/config.js';

const ROOT = path.resolve('./.knowl-no-workspace-test');

describe('a project with no workspace is untouched by v1', () => {
  let projectId = '';
  beforeAll(async () => {
    // KNOWL_HOME points somewhere that does not exist. Any attempt to read a manifest
    // would throw, so this also proves nothing tries.
    process.env.KNOWL_HOME = path.resolve('./.knowl-does-not-exist');
    await fs.rm(ROOT, { recursive: true, force: true });
    await fs.mkdir(path.join(ROOT, '.knowl'), { recursive: true });
    await initDb(ROOT);
    projectId = (await repo.createProject(ROOT, 'no-workspace')).id;
    await storeKnowledgeItemDeduped(projectId, {
      category: 'decision', title: 'Storage is libSQL',
      content: 'Knowledge is stored in a libSQL database under .knowl.',
    });
  });
  afterAll(async () => {
    delete process.env.KNOWL_HOME;
    await closeDb();
    await fs.rm(ROOT, { recursive: true, force: true }).catch(() => {});
  });

  it('resolves no workspace, without reading a manifest', async () => {
    await expect(resolveWorkspace(ROOT, DEFAULT_CONFIG)).resolves.toBeNull();
  });

  it('serializes query results with no repo field and no second block', async () => {
    const items = await queryKnowledgeForAgent('local', { query: 'storage', limit: 3, surface: 'test' });
    const serialized = JSON.parse(compactMcpJson(items.map(item => compactItemResponse(item))));
    expect(serialized.length).toBeGreaterThan(0);
    expect(serialized.every((item: Record<string, unknown>) => !('repo' in item))).toBe(true);
    expect(serialized.every((item: Record<string, unknown>) => !('namespace' in item))).toBe(true);
  });

  it('leaves every write unowned and repo-visible', async () => {
    await storeKnowledgeItemDeduped(projectId, {
      category: 'fact', title: 'Vector search is on by default',
      content: 'search.vector.enabled defaults to true.',
    });
    const rows = await getClient().execute('SELECT origin_repo, visibility FROM knowledge_items');
    expect(rows.rows.every(row => row.origin_repo === null)).toBe(true);
    expect(rows.rows.every(row => row.visibility === 'repo')).toBe(true);
  });

  it('renders no workspace section in status or doctor', () => {
    expect(formatWorkspaceBlock(null)).toEqual([]);
    expect(workspaceDoctorChecks(null, DEFAULT_CONFIG)).toEqual([]);
  });

  it('leaves implicit reads returning exactly what they returned before', async () => {
    const recent = await getRecentContext('local', { itemLimit: 5 });
    expect(recent.items.length).toBeGreaterThan(0);
    const pack = await composeContext('local', { query: 'storage', tokenBudget: 2000, namespaceRoot: ROOT });
    expect(pack.sections.flatMap(section => section.items).length).toBeGreaterThan(0);
  });

  it('creates no workspace files anywhere', async () => {
    await expect(fs.access(path.resolve('./.knowl-does-not-exist'))).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run it**

Run: `npx.cmd vitest run tests/workspace/no-workspace-regression.test.ts`
Expected: PASS, 6 tests. **If any assertion fails, that is a v1 bug, not a test bug** — trace it
to the task that introduced it rather than adjusting the expectation.

- [ ] **Step 3: Run the whole suite**

Run: `npm.cmd test`
Expected: all pass

- [ ] **Step 4: Typecheck and build**

Run: `npx.cmd tsc --noEmit` — 15 errors
Run: `npm.cmd run build` — clean

- [ ] **Step 5: Confirm the unlinked path really is untouched**

Run: `git diff --stat main -- src/` and read the list. Every changed file should either be new
(`src/workspace/*`, `src/cli/workspace-report.ts`) or contain a workspace branch guarded by
`resolveWorkspace(...) === null`. A change on the unconditional path is the thing this task
exists to catch, and the diff is faster to audit than the test suite is to reason about.

- [ ] **Step 6: Commit**

```bash
git add tests/workspace/no-workspace-regression.test.ts
git commit -m "test(workspace): pin the no-workspace guarantee end to end

The contract that makes this feature safe to ship: a project with no workspace
returns the same results, writes no ownership, renders no workspace section,
and creates no files.

KNOWL_HOME points at a path that does not exist, so the suite also proves
nothing attempts to read a manifest -- an attempt would throw rather than
quietly returning null.

Runs last, against every other task's changes rather than a subset."
```

---

## Self-review

**Spec coverage.** Manifest and paths → 1. Two-sided membership, nesting, tracked-config → 2.
Ownership backfill and embedding pinning → 3. Workspace resolution → 4. Visibility matrix,
fusion, caps, skip reporting → 5. MCP query surface → 6. `promote` → 7. Federation opt-in
guarantee → 8. Foreign-item refusals → 9. Status/doctor/explain → 10. Guidance → 11. CLI → 12.
Evals → 13. No-workspace guarantee → 14.

**Correction made while finishing this plan.** The first draft had a task for scoping implicit
reads and a task for clamping cross-owner duplicate resolution. Neither can fire in v1: a repo's
database contains no foreign items to leak or to supersede. Both were symptoms of one unstated
assumption — that peers would join `configuredNamespaces` — which would have leaked foreign
knowledge into auto-injected context through `composeContext`. Peers are now explicitly kept out
of the namespace list, Task 8 pins that as a property, and the two tasks move to v2 where one
database really does hold every repo's items.

**Scope boundary.** No shared database, no `namespace: 'workspace'` writes, no applies-to table,
no migration, no `lifecycle_hash`, no tombstone monotonicity, no purge disabling, no
snapshot/export scoping. All v2.

**Type consistency.** `ActiveWorkspace` / `PeerRepo` (Task 4) are consumed with those field names
in 5, 6, 9 and 10. `FederatedResult.skipped` (Task 5) is consumed in 6 and 10.
`compactItemResponse(item, { repo })` matches the 2.4.0 signature. `PromoteResult` (Task 7) is
consumed by the CLI in 12. `DoctorCheck` (Task 10) matches the doctor's existing check shape.
`RRF_K` is imported from `agent-query.ts`, never restated.

**Known risk.** Task 9 depends on `mapRowToKnowledgeItem` exposing `originRepo`. 2.4.0 added the
column and the Drizzle field, but the row mapper may not read it — the task says to check first
rather than assume, because the failure mode is `undefined === workspace.repo` evaluating false
and refusing every local item.

**Placeholder scan.** Every task carries executable steps. Tasks 12 and 13 name their test
obligations rather than printing full fixture code — the CLI group because it is mechanical
delegation to Tasks 1–3, 7 and 10, and the eval task because its case shapes are given as
literal JSON and the runner change depends on a fixture helper Task 5 already produces. No
"TBD", no "add error handling", no task deferred to the reader.
