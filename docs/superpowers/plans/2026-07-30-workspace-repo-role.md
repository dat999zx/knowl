# Workspace Repo Role and Default Visibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Record each repository's nature — free-text role, default write visibility, and kin group — in the workspace manifest, so sharing decisions follow from recorded fact instead of being re-derived by every agent.

**Architecture:** Three optional fields on `WorkspaceRepo`. `readManifest` normalizes them without ever throwing and without discarding unknown fields. Default visibility is resolved once per config root through the cache that already exists in `write-ownership.ts` and stamped at `createKnowledgeItem`, the single funnel every write passes through. Role and kin are read-only context surfaced in three places.

**Tech Stack:** TypeScript (ESM, NodeNext), vitest, commander, drizzle + libsql.

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-07-30-workspace-repo-role-design.md`. Read it before Task 1.
- **Branch:** `feat/workspace-repo-role`. Already created and checked out.
- **Manifest `version` stays `1`.** Every new field is optional. No migration.
- **Absent means today's behavior**, at every layer. An unlinked repository's behavior must stay byte-identical.
- **`readManifest` must never throw on a malformed entry.** `discoverRepos` reads every manifest on the machine to decide what `upgrade --all` visits.
- **Every unparseable value resolves toward private.** A garbled field means "shared less than intended", never "published without being asked".
- **No `DoctorRemedy` may change visibility.** Do not add a remedy kind in this plan.
- **No demote.** Do not add one.
- **Role cap: 200 characters**, collapsed to a single line.
- Run `npm run build` before any test that spawns the CLI — those suites run `dist/index.js`.
- Test command: `npx vitest run <path>`. Full suite: `npm test`.
- Commit after every task. Conventional commits, matching existing history (`feat(workspace): …`, `fix(store): …`).

## File Structure

**Create:**
- `src/workspace/repo-settings.ts` — read and write one repository's own manifest entry (`role`, `defaultVisibility`, `kin`), plus the lookup helpers other modules need. One responsibility: per-repo settings, kept out of `membership.ts` so that file stays about join/leave/ownership.
- `tests/workspace/repo-settings.test.ts`

**Modify:**
- `src/workspace/manifest.ts` — three fields on `WorkspaceRepo`, `normalizeRepoEntry`, wire into `readManifest`.
- `src/workspace/membership.ts` — `joinWorkspace` accepts and records the three fields.
- `src/workspace/resolve.ts` — `PeerRepo` carries `role`, `defaultVisibility`, `kin`.
- `src/store/write-ownership.ts` — `resolveWriteDefaults()`; `resolveWritingRepo()` becomes a wrapper.
- `src/store/repository.ts` — `createKnowledgeItem` stamps visibility in the row and the lifecycle hash from one variable.
- `src/cli/workspace-report.ts` — role and default visibility in `formatWorkspaceBlock`.
- `src/core/format.ts` — optional `workspace` section in `formatRecentContextToMarkdown`.
- `src/store/context-bootstrap.ts` — resolve the workspace and pass it in.
- `src/workspace/cross-repo-overlap.ts` — kin widens candidates; overlap carries `kin` and `role`.
- `src/mcp/tools.ts` — `describeWriteReconciliation` renders the kin marker and peer role.
- `src/index.ts` — `workspace add` flags, `workspace set` command.
- `CHANGELOG.md`

---

### Task 1: Manifest fields and normalization

**Files:**
- Modify: `src/workspace/manifest.ts:8-16` (type), `:53-64` (`readManifest`)
- Test: `tests/workspace/manifest.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `WorkspaceRepo.role?: string`, `WorkspaceRepo.defaultVisibility?: 'workspace'`, `WorkspaceRepo.kin?: string`; `normalizeRepoEntry(raw: unknown): WorkspaceRepo`; `ROLE_MAX_LENGTH: 200`.

Note the type of `defaultVisibility`: the **only** value ever stored is `'workspace'`. Absent means `'repo'`. Materializing `"defaultVisibility": "repo"` into every entry of every existing manifest on its next write would be noise, and "absent means repo" is the property the whole backward-compatibility story rests on.

- [ ] **Step 1: Write the failing tests**

Add to `tests/workspace/manifest.test.ts`, inside the existing `describe('manifest', …)` block:

```ts
  it('normalizes role, defaultVisibility and kin, resolving anything unparseable toward private', async () => {
    const target = workspaceManifestPath('shapes');
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, JSON.stringify({
      version: 1, name: 'shapes', minKnowlVersion: '2.7.1', embedding: null,
      repos: [
        { name: 'notes', role: '  my   notes\nand log  ', defaultVisibility: 'workspace', kin: 'forks' },
        { name: 'junk', role: 42, defaultVisibility: 'WORKSPACE', kin: 'Not A Name' },
        { name: 'bare' },
      ],
    }), 'utf8');

    const loaded = await readManifest(target);
    expect(loaded.repos[0]).toMatchObject({ role: 'my notes and log', defaultVisibility: 'workspace', kin: 'forks' });
    // Every unparseable value resolves toward private: no visibility, no role, no kin.
    expect(loaded.repos[1].defaultVisibility).toBeUndefined();
    expect(loaded.repos[1].role).toBeUndefined();
    expect(loaded.repos[1].kin).toBeUndefined();
    expect(loaded.repos[2].defaultVisibility).toBeUndefined();
  });

  it('caps role, because it renders into every session-start block', async () => {
    const target = workspaceManifestPath('capped');
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, JSON.stringify({
      version: 1, name: 'capped', minKnowlVersion: '2.7.1', embedding: null,
      repos: [{ name: 'wordy', role: 'x'.repeat(500) }],
    }), 'utf8');
    expect((await readManifest(target)).repos[0].role).toHaveLength(200);
  });

  it('preserves fields a newer version wrote, so a round trip through this build is lossless', async () => {
    const target = workspaceManifestPath('forward');
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, JSON.stringify({
      version: 1, name: 'forward', minKnowlVersion: '2.7.1', embedding: null,
      repos: [{ name: 'server', somethingNewer: { nested: true } }],
    }), 'utf8');

    await writeManifest(target, await readManifest(target));
    const raw = JSON.parse(await fs.readFile(target, 'utf8'));
    expect(raw.repos[0].somethingNewer).toEqual({ nested: true });
  });

  it('never throws on a malformed entry, because a machine-wide sweep reads every manifest', async () => {
    const target = workspaceManifestPath('malformed');
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, JSON.stringify({
      version: 1, name: 'malformed', minKnowlVersion: '2.7.1', embedding: null,
      repos: [null, 'not-an-object', { name: 'ok' }],
    }), 'utf8');
    const loaded = await readManifest(target);
    expect(loaded.repos).toHaveLength(3);
    expect(loaded.repos[2].name).toBe('ok');
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/workspace/manifest.test.ts`
Expected: the four new tests FAIL — `role` comes back as the raw uncollapsed string, `defaultVisibility` as `'WORKSPACE'`, and the malformed test throws or returns entries unchanged.

- [ ] **Step 3: Add the fields and the normalizer**

In `src/workspace/manifest.ts`, replace the `WorkspaceRepo` type (lines 8-16) with:

```ts
export type WorkspaceRepo = {
  /** Canonical identity. Immutable: it is the ownership key on every item this repo wrote. */
  name: string;
  /** Machine-local and optional. A manifest copied to another machine resolves paths there. */
  path?: string;
  /** Evidence for matching a repo on another machine, never authoritative. */
  git?: { remote?: string };
  addedAt?: string;
  /**
   * What this repo is, for an agent that has only the manifest. Free text: never parsed, and
   * no behavior is inferred from it. A repo is never published because of a word someone typed.
   */
  role?: string;
  /**
   * Visibility stamped on new writes here. Only ever `'workspace'` -- absent means `'repo'`,
   * which is both today's behavior and what every existing manifest already says by omission.
   */
  defaultVisibility?: 'workspace';
  /**
   * Repos sharing this group name are kin: same lineage, diverged conventions. Widens the
   * cross-repo write advisory for them; changes nothing about retrieval.
   */
  kin?: string;
};
```

Then add, after `isValidRepoName`:

```ts
/** Role renders into every session-start block in every linked repo, so it is a budget item. */
export const ROLE_MAX_LENGTH = 200;

function normalizeRole(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const collapsed = value.replace(/\s+/g, ' ').trim();
  if (!collapsed) return undefined;
  return collapsed.slice(0, ROLE_MAX_LENGTH);
}

/**
 * Normalize one repo entry without rebuilding it.
 *
 * Spread first and override known fields after, so a field written by a *newer* build survives
 * a pass through this one. Older builds already give these fields that property for free, by
 * passing `raw.repos` through untouched; rebuilding the entry here would break it in the one
 * direction that still worked.
 *
 * Never throws. `discoverRepos` reads every manifest on this machine to decide what
 * `upgrade --all` visits, so an entry rejected here would take down a machine-wide command
 * rather than one repo. Every unparseable value resolves toward private instead: the failure
 * mode must be "shared less than intended", never "published without being asked".
 */
export function normalizeRepoEntry(raw: unknown): WorkspaceRepo {
  const entry = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    ...entry,
    name: typeof entry.name === 'string' ? entry.name : '',
    role: normalizeRole(entry.role),
    defaultVisibility: entry.defaultVisibility === 'workspace' ? 'workspace' : undefined,
    kin: typeof entry.kin === 'string' && isValidRepoName(entry.kin) ? entry.kin : undefined,
  };
}
```

- [ ] **Step 4: Wire it into `readManifest`**

In `src/workspace/manifest.ts`, change the `repos` line inside `readManifest`:

```ts
    repos: (Array.isArray(raw.repos) ? raw.repos : []).map(normalizeRepoEntry),
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/workspace/manifest.test.ts`
Expected: PASS, all tests including the pre-existing ones.

- [ ] **Step 6: Commit**

```bash
git add src/workspace/manifest.ts tests/workspace/manifest.test.ts
git commit -m "feat(workspace): record role, default visibility and kin per repo in the manifest"
```

---

### Task 2: Per-repo settings module

**Files:**
- Create: `src/workspace/repo-settings.ts`
- Test: `tests/workspace/repo-settings.test.ts`

**Interfaces:**
- Consumes: `WorkspaceRepo`, `WorkspaceManifest`, `readManifest`, `writeManifest` from Task 1.
- Produces: `repoEntry(manifest, name): WorkspaceRepo | undefined`; `defaultVisibilityOf(manifest, name): 'repo' | 'workspace'`; `RepoSettings = { role?: string; defaultVisibility?: 'workspace'; kin?: string }`; `updateRepoSettings(input): Promise<WorkspaceRepo>`.

- [ ] **Step 1: Write the failing tests**

Create `tests/workspace/repo-settings.test.ts`:

```ts
import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createManifest, readManifest, writeManifest } from '../../src/workspace/manifest.js';
import { workspaceManifestPath } from '../../src/workspace/paths.js';
import { defaultVisibilityOf, repoEntry, updateRepoSettings } from '../../src/workspace/repo-settings.js';

const HOME = path.resolve('./.knowl-repo-settings-home');

describe('repo settings', () => {
  beforeAll(async () => { process.env.KNOWL_HOME = HOME; await fs.rm(HOME, { recursive: true, force: true }); });
  afterAll(async () => { delete process.env.KNOWL_HOME; await fs.rm(HOME, { recursive: true, force: true }).catch(() => {}); });

  async function seed(name: string) {
    const manifest = createManifest(name, null);
    manifest.repos.push({ name: 'server' }, { name: 'notes', defaultVisibility: 'workspace' });
    await writeManifest(workspaceManifestPath(name), manifest);
    return manifest;
  }

  it('reports absent default visibility as repo, which is what every existing manifest says', async () => {
    const manifest = await seed('reads');
    expect(defaultVisibilityOf(manifest, 'server')).toBe('repo');
    expect(defaultVisibilityOf(manifest, 'notes')).toBe('workspace');
    // A name in no entry is not a member; private is the only safe answer.
    expect(defaultVisibilityOf(manifest, 'ghost')).toBe('repo');
    expect(repoEntry(manifest, 'ghost')).toBeUndefined();
  });

  it('writes only the calling repo entry and leaves its neighbours untouched', async () => {
    await seed('writes');
    await updateRepoSettings({ workspaceName: 'writes', repoName: 'server', settings: { role: 'the API server', kin: 'forks' } });

    const loaded = await readManifest(workspaceManifestPath('writes'));
    expect(repoEntry(loaded, 'server')).toMatchObject({ role: 'the API server', kin: 'forks' });
    expect(repoEntry(loaded, 'notes')).toEqual({ name: 'notes', defaultVisibility: 'workspace' });
  });

  it('refuses to edit an entry this repo does not own', async () => {
    await seed('owned');
    await expect(updateRepoSettings({ workspaceName: 'owned', repoName: 'ghost', settings: { role: 'x' } }))
      .rejects.toThrow(/not a member/i);
  });

  it('leaves an unmentioned field alone, so setting one does not clear another', async () => {
    await seed('partial');
    await updateRepoSettings({ workspaceName: 'partial', repoName: 'server', settings: { role: 'first' } });
    await updateRepoSettings({ workspaceName: 'partial', repoName: 'server', settings: { kin: 'forks' } });
    expect(repoEntry(await readManifest(workspaceManifestPath('partial')), 'server'))
      .toMatchObject({ role: 'first', kin: 'forks' });
  });

  it('clears a field when given an empty string, which is the only way to unset one', async () => {
    await seed('clears');
    await updateRepoSettings({ workspaceName: 'clears', repoName: 'notes', settings: { role: 'notes' } });
    await updateRepoSettings({ workspaceName: 'clears', repoName: 'notes', settings: { role: '' } });
    expect(repoEntry(await readManifest(workspaceManifestPath('clears')), 'notes')?.role).toBeUndefined();
  });

  it('normalizes on the way in, so a bad value cannot reach the manifest', async () => {
    await seed('normal');
    await updateRepoSettings({ workspaceName: 'normal', repoName: 'server', settings: { role: '  spread   out  ', kin: 'Bad Name' } });
    const entry = repoEntry(await readManifest(workspaceManifestPath('normal')), 'server');
    expect(entry?.role).toBe('spread out');
    expect(entry?.kin).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/workspace/repo-settings.test.ts`
Expected: FAIL — `Cannot find module '../../src/workspace/repo-settings.js'`.

- [ ] **Step 3: Write the module**

Create `src/workspace/repo-settings.ts`:

```ts
import { normalizeRepoEntry, readManifest, writeManifest, WorkspaceManifest, WorkspaceRepo } from './manifest.js';
import { workspaceManifestPath } from './paths.js';

/** The three fields `workspace set` and `workspace add` can write. */
export type RepoSettings = {
  role?: string;
  defaultVisibility?: 'workspace' | 'repo';
  kin?: string;
};

export function repoEntry(manifest: WorkspaceManifest, name: string): WorkspaceRepo | undefined {
  return manifest.repos.find(entry => entry.name === name);
}

/**
 * What new writes in this repo are stamped with.
 *
 * Absent means `'repo'`, which is what every manifest written before this feature says by
 * omission. A name that is in no entry is not a member of this workspace, and private is the
 * only safe answer for a caller whose membership cannot be confirmed.
 */
export function defaultVisibilityOf(manifest: WorkspaceManifest, name: string): 'repo' | 'workspace' {
  return repoEntry(manifest, name)?.defaultVisibility === 'workspace' ? 'workspace' : 'repo';
}

/**
 * Rewrite one repo's own entry.
 *
 * Only the entry named by `repoName` is touched, and only fields present in `settings`. That
 * is the same rule that governs promote, update and retire: a repo may publish, correct or
 * retire its own knowledge and nothing else's, and its manifest entry is the same kind of
 * property. An absent field is left alone, so setting one does not silently clear another;
 * an empty string clears, which is the only way to unset a field from the CLI.
 *
 * Values go through `normalizeRepoEntry` on the way in, so the cap on role and the charset
 * rule on kin are enforced once, at the boundary, rather than at each caller.
 */
export async function updateRepoSettings(input: {
  workspaceName: string;
  repoName: string;
  settings: RepoSettings;
}): Promise<WorkspaceRepo> {
  const manifestPath = workspaceManifestPath(input.workspaceName);
  const manifest = await readManifest(manifestPath);
  const current = repoEntry(manifest, input.repoName);
  if (!current) {
    throw new Error(
      `"${input.repoName}" is not a member of workspace "${input.workspaceName}", so this repo cannot edit its entry.`,
    );
  }

  const merged: Record<string, unknown> = { ...current };
  if (input.settings.role !== undefined) merged.role = input.settings.role;
  if (input.settings.kin !== undefined) merged.kin = input.settings.kin;
  if (input.settings.defaultVisibility !== undefined) {
    // Stored only when it is 'workspace'. Setting it back to 'repo' removes the key rather
    // than writing a value that means the same as absence.
    merged.defaultVisibility = input.settings.defaultVisibility === 'workspace' ? 'workspace' : undefined;
  }

  const updated = normalizeRepoEntry(merged);
  manifest.repos = manifest.repos.map(entry => (entry.name === input.repoName ? updated : entry));
  await writeManifest(manifestPath, manifest);
  return updated;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/workspace/repo-settings.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/workspace/repo-settings.ts tests/workspace/repo-settings.test.ts
git commit -m "feat(workspace): read and write one repo's own manifest settings"
```

---

### Task 3: Default visibility on the write path

**Files:**
- Modify: `src/store/write-ownership.ts` (whole file), `src/store/repository.ts:130-161`
- Test: `tests/store/write-visibility.test.ts` (create)

**Interfaces:**
- Consumes: `defaultVisibilityOf` from Task 2.
- Produces: `WriteDefaults = { repo: string | null; visibility: 'repo' | 'workspace' }`; `resolveWriteDefaults(): Promise<WriteDefaults>`. `resolveWritingRepo()` and `resetWriteOwnershipCache()` keep their existing signatures.

This is the highest-risk task in the plan. Two hazards, both explicit in the spec:

1. `createKnowledgeItem` hardcodes `'repo'` **twice** — implicitly in the insert row (the column default, because `visibility` is absent from the literal) and literally inside `hashKnowledgeLifecycle`. Both must read one variable. A row saying `visibility = 'workspace'` whose hash was computed over `'repo'` is a permanent, silent divergence, because `lifecycle_hash` is exactly what `change-watermark.ts` and `import-policy.ts` compare.
2. The per-root cache **is** the 2.7.1 fix. Do not add a manifest read per write. Extend the existing resolution.

- [ ] **Step 1: Write the failing test**

Create `tests/store/write-visibility.test.ts`:

```ts
import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, saveConfig } from '../../src/core/config.js';
import { closeDb, getClient, initDb } from '../../src/store/database.js';
import { releaseAll } from '../../src/store/connection-pool.js';
import * as repo from '../../src/store/repository.js';
import { resetWriteOwnershipCache } from '../../src/store/write-ownership.js';
import { DEFAULT_FRESHNESS, hashKnowledgeLifecycle } from '../../src/store/freshness.js';
import { createManifest, writeManifest } from '../../src/workspace/manifest.js';
import { workspaceManifestPath } from '../../src/workspace/paths.js';

const HOME = path.resolve('./.knowl-write-visibility-home');
const ROOT = path.resolve('./.knowl-write-visibility-repo');

async function link(defaultVisibility?: 'workspace') {
  const manifest = createManifest('vis', null);
  manifest.repos.push({ name: 'notes', path: ROOT, defaultVisibility });
  await writeManifest(workspaceManifestPath('vis'), manifest);
  await saveConfig(ROOT, { ...DEFAULT_CONFIG, workspace: { workspace: 'vis', repo: 'notes' } });
  resetWriteOwnershipCache();
}

async function rowFor(id: string) {
  const result = await getClient().execute({
    sql: 'SELECT visibility, lifecycle_hash, origin_repo FROM knowledge_items WHERE id = ?',
    args: [id],
  });
  return result.rows[0] as any;
}

describe('default write visibility', { timeout: 60_000 }, () => {
  beforeAll(async () => {
    process.env.KNOWL_HOME = HOME;
    await closeDb();
    await releaseAll();
    for (const dir of [HOME, ROOT]) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    await fs.mkdir(path.join(ROOT, '.knowl'), { recursive: true });
  });

  afterAll(async () => {
    delete process.env.KNOWL_HOME;
    await closeDb();
    await releaseAll();
    resetWriteOwnershipCache();
    for (const dir of [HOME, ROOT]) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  it('stamps workspace visibility and a lifecycle hash that agrees with the row', async () => {
    await link('workspace');
    await initDb(ROOT);
    const project = await repo.createProject(ROOT, 'notes');
    const item = await repo.createKnowledgeItem(project.id, {
      category: 'fact', title: 'Shared by default', content: 'Everything here is cross-cutting.',
    });

    const row = await rowFor(item.id);
    expect(row.visibility).toBe('workspace');
    expect(row.origin_repo).toBe('notes');
    // The load-bearing assertion. The row and the hash are stamped at two different sites in
    // createKnowledgeItem; a hash computed over 'repo' beside a row saying 'workspace' is a
    // permanent divergence that change-watermark and import-policy would never reconcile.
    expect(row.lifecycle_hash).toBe(hashKnowledgeLifecycle({
      status: 'active', freshness: DEFAULT_FRESHNESS, supersededById: null,
      originRepo: 'notes', visibility: 'workspace',
    }));
    await closeDb();
  });

  it('stays private when the manifest does not say otherwise', async () => {
    await link(undefined);
    await initDb(ROOT);
    const project = await repo.getProjectByRootPath(ROOT);
    const item = await repo.createKnowledgeItem(project!.id, {
      category: 'fact', title: 'Private by default', content: 'Absent means repo.',
    });

    const row = await rowFor(item.id);
    expect(row.visibility).toBe('repo');
    expect(row.lifecycle_hash).toBe(hashKnowledgeLifecycle({
      status: 'active', freshness: DEFAULT_FRESHNESS, supersededById: null,
      originRepo: 'notes', visibility: 'repo',
    }));
    await closeDb();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/store/write-visibility.test.ts`
Expected: the first test FAILS — `expected 'repo' to be 'workspace'`. The second passes already, which is the point: it is the regression guard.

- [ ] **Step 3: Extend the ownership resolver**

In `src/store/write-ownership.ts`, replace the cache declaration and `resolveWritingRepo` with:

```ts
/** Everything `createKnowledgeItem` needs from the workspace, resolved together and cached once. */
export type WriteDefaults = { repo: string | null; visibility: 'repo' | 'workspace' };

const UNLINKED: WriteDefaults = { repo: null, visibility: 'repo' };

let cache: { root: string; defaults: WriteDefaults } | null = null;

/** Tests only: the cache is process-lifetime and would otherwise leak between fixtures. */
export function resetWriteOwnershipCache(): void {
  cache = null;
}

/**
 * Owner and default visibility for knowledge written right now.
 *
 * Both come from the same manifest entry, so they are resolved in one pass and cached
 * together. Resolving visibility separately would mean a second `loadConfig` read and JSON
 * parse per write -- which is exactly the 2.7.0 regression that killed the process at around
 * 2000 writes and that 2.7.1 fixed by caching this lookup per root.
 *
 * The cache is process-lifetime, so `workspace set --default-visibility` -- a separate CLI
 * process -- does not reach a long-lived MCP server until its next start. That is stated in
 * the command's output rather than fixed here: the stale window ends at the next session, and
 * it fails toward whichever value was already in effect.
 */
export async function resolveWriteDefaults(): Promise<WriteDefaults> {
  let root: string;
  try {
    root = getConfigRoot();
  } catch {
    return UNLINKED; // no open store: nothing to attribute
  }

  if (cache?.root === root) return cache.defaults;

  let defaults = UNLINKED;
  try {
    // Imported lazily so the store layer keeps no static dependency on the workspace layer,
    // and so an unlinked project never loads it at all.
    const { resolveWorkspace } = await import('../workspace/resolve.js');
    const { defaultVisibilityOf } = await import('../workspace/repo-settings.js');
    const active = await resolveWorkspace(root);
    if (active) {
      defaults = { repo: active.repo, visibility: defaultVisibilityOf(active.manifest, active.repo) };
    }
  } catch {
    defaults = UNLINKED; // a broken workspace must not block an ordinary write
  }

  cache = { root, defaults };
  return defaults;
}

export async function resolveWritingRepo(): Promise<string | null> {
  return (await resolveWriteDefaults()).repo;
}
```

Keep the existing file header comment above these; it still describes why ownership is stamped here.

- [ ] **Step 4: Stamp both sites from one variable**

In `src/store/repository.ts`, change the import on line 22-ish from `resolveWritingRepo` to `resolveWriteDefaults`, then replace lines 130-135:

```ts
  // Stamped at the one point where the answer is known without guessing. Joining a
  // workspace backfills what is already there, but nothing claimed items written
  // afterwards -- which left `workspace promote` unable to touch them, and would leave a
  // shared database unable to say who may edit or collect them.
  //
  // Visibility rides the same resolution: both come from this repo's manifest entry, and a
  // second lookup per write is the 2.7.0 regression 2.7.1 fixed.
  const { repo: originRepo, visibility } = await resolveWriteDefaults();
  const freshness = item.freshness || DEFAULT_FRESHNESS;
```

Then in the `newItem` literal, replace the `lifecycleHash` block (lines 157-161) with:

```ts
    // One variable, two sites. The row's `visibility` and the hash's must agree: lifecycle_hash
    // is exactly what change-watermark and import-policy compare to decide an item changed, so
    // a row saying 'workspace' beside a hash computed over 'repo' is a divergence nothing
    // reconciles and nothing reports.
    visibility,
    lifecycleHash: hashKnowledgeLifecycle({
      status: 'active', freshness, supersededById: null, originRepo, visibility,
    }),
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run tests/store/write-visibility.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Run the store and workspace suites for regressions**

Run: `npx vitest run tests/store tests/workspace`
Expected: PASS. `tests/store/lifecycle-hash.test.ts` and `tests/store/import-policy.test.ts` are the ones that would catch a mistake here.

- [ ] **Step 7: Commit**

```bash
git add src/store/write-ownership.ts src/store/repository.ts tests/store/write-visibility.test.ts
git commit -m "feat(store): stamp new writes with the repo's default visibility"
```

---

### Task 4: Carry the fields through `joinWorkspace` and expose peers

**Files:**
- Modify: `src/workspace/membership.ts:100-135`, `src/workspace/resolve.ts:10`, `:38-51`
- Test: `tests/workspace/repo-settings.test.ts` (extend)

**Interfaces:**
- Consumes: `RepoSettings` from Task 2.
- Produces: `joinWorkspace(input)` gains `settings?: RepoSettings`; `PeerRepo` gains `role?: string`, `kin?: string`, `defaultVisibility?: 'workspace'`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/workspace/repo-settings.test.ts`, as a new top-level `describe`:

```ts
describe('peers carry their recorded nature', () => {
  it('exposes role, kin and default visibility on each peer', async () => {
    const { resolveWorkspace } = await import('../../src/workspace/resolve.js');
    const HOME2 = path.resolve('./.knowl-peer-nature-home');
    const ROOT = path.resolve('./.knowl-peer-nature-repo');
    process.env.KNOWL_HOME = HOME2;
    await fs.rm(HOME2, { recursive: true, force: true }).catch(() => {});
    await fs.mkdir(path.join(ROOT, '.knowl'), { recursive: true });

    const manifest = createManifest('nature', null);
    manifest.repos.push(
      { name: 'here', path: ROOT },
      { name: 'duck', path: path.resolve('./.knowl-peer-nature-duck'), role: 'reading log', kin: 'forks', defaultVisibility: 'workspace' },
    );
    await writeManifest(workspaceManifestPath('nature'), manifest);

    const { DEFAULT_CONFIG: config, saveConfig } = await import('../../src/core/config.js');
    await saveConfig(ROOT, { ...config, workspace: { workspace: 'nature', repo: 'here' } });

    const active = await resolveWorkspace(ROOT);
    expect(active?.peers[0]).toMatchObject({ name: 'duck', role: 'reading log', kin: 'forks', defaultVisibility: 'workspace' });

    delete process.env.KNOWL_HOME;
    for (const dir of [HOME2, ROOT]) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/workspace/repo-settings.test.ts -t "role, kin and default visibility"`
Expected: FAIL — the peer object has only `name`, `root`, `databasePath`, `present`.

- [ ] **Step 3: Widen `PeerRepo`**

In `src/workspace/resolve.ts`, replace the `PeerRepo` type on line 10:

```ts
export type PeerRepo = {
  name: string;
  root: string;
  databasePath: string;
  present: boolean;
  /** Recorded nature, carried through so callers need not re-read the manifest per peer. */
  role?: string;
  kin?: string;
  defaultVisibility?: 'workspace';
};
```

And in the `.map` inside `resolveWorkspace`, add the three fields to the returned object:

```ts
      return {
        name: repo.name,
        root,
        databasePath: resolveStorage(root).knowledge,
        // A partial checkout is normal, not an error: two of five repos on a laptop works.
        present: existsSync(root),
        role: repo.role,
        kin: repo.kin,
        defaultVisibility: repo.defaultVisibility,
      };
```

- [ ] **Step 4: Accept settings in `joinWorkspace`**

In `src/workspace/membership.ts`, add the import:

```ts
import type { RepoSettings } from './repo-settings.js';
```

Change the `joinWorkspace` signature to accept `settings?: RepoSettings`, and replace the `manifest.repos.push({...})` call:

```ts
  manifest.repos.push(normalizeRepoEntry({
    name: input.repoName,
    path: path.resolve(input.projectRoot),
    addedAt: new Date().toISOString(),
    role: input.settings?.role,
    kin: input.settings?.kin,
    defaultVisibility: input.settings?.defaultVisibility,
  }));
```

Add `normalizeRepoEntry` to the existing import from `./manifest.js`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/workspace`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/workspace/membership.ts src/workspace/resolve.ts tests/workspace/repo-settings.test.ts
git commit -m "feat(workspace): carry recorded repo nature through join and onto peers"
```

---

### Task 5: `workspace add` flags, the gate, and the existing-items report

**Files:**
- Modify: `src/index.ts:421-438` (the `workspace add` action)
- Create: `src/cli/workspace-visibility-notice.ts`
- Test: `tests/cli/workspace-visibility-notice.test.ts` (create), `tests/cli/workspace-cli.test.ts` (extend)

**Interfaces:**
- Consumes: `joinWorkspace` with `settings` (Task 4), `countOwnedItems` (existing), `KNOWLEDGE_CATEGORIES` (existing).
- Produces: `visibilityGateNotice(repoName: string): string[]`; `existingItemsNotice(count: number): string[]`.

The notice text lives in its own module so it can be asserted without spawning the CLI — the CLI suite costs seconds per invocation, and this text is the safety gate, so it deserves cheap tests.

- [ ] **Step 1: Write the failing tests**

Create `tests/cli/workspace-visibility-notice.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { existingItemsNotice, visibilityGateNotice } from '../../src/cli/workspace-visibility-notice.js';

describe('visibility gate notice', () => {
  it('says what happens, that it cannot be undone, and how to stop future writes', () => {
    const text = visibilityGateNotice('duck').join('\n');
    expect(text).toContain('"duck"');
    expect(text).toMatch(/no review step/i);
    expect(text).toMatch(/cannot be undone/i);
    expect(text).toContain('knowl workspace set --default-visibility repo');
    expect(text).toMatch(/already shared stays shared/i);
  });
});

describe('existing items notice', () => {
  it('is silent when there is nothing already private', () => {
    expect(existingItemsNotice(0)).toEqual([]);
  });

  it('names the count and prints a command that survives cmd.exe', () => {
    const text = existingItemsNotice(500).join('\n');
    expect(text).toContain('500 existing items');
    // Quoted on purpose: knowl.cmd runs through cmd.exe, which splits an unquoted comma list.
    expect(text).toContain('--category "fact,decision,goal,constraint,architecture,state,skill"');
    expect(text).toContain('--apply');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/cli/workspace-visibility-notice.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the notice module**

Create `src/cli/workspace-visibility-notice.ts`:

```ts
import { KNOWLEDGE_CATEGORIES } from '../core/types.js';

/**
 * The gate on standing, automatic publishing.
 *
 * `promote` is explicit and per-batch; a default visibility of `workspace` keeps publishing
 * until someone notices, so it earns a louder warning than a flag normally would. There is no
 * demote and there should not be one: a peer may already have read the item, and the change
 * watermark may already have delivered a notification for it. Saying so here is the honest
 * alternative to an inverse that would only pretend to retract.
 */
export function visibilityGateNotice(repoName: string): string[] {
  return [
    `Repo "${repoName}" will write new knowledge at workspace visibility.`,
    'Every item written here becomes readable by all linked repos immediately, with no review step.',
    'This cannot be undone: there is no demote. `knowl workspace set --default-visibility repo`',
    'stops future writes only; anything already shared stays shared.',
    'An agent with an open session picks this up on its next session, not mid-session.',
  ];
}

/**
 * What linking leaves behind.
 *
 * A repo linked with `--default-visibility workspace` that already holds private knowledge is
 * half-shared, which is the original inconsistency in a new form. Reporting the count and
 * naming the command keeps bulk publishing an explicit gesture -- the rule `promoteItems`
 * already enforces by refusing a bare promote.
 *
 * The category list is quoted because `knowl.cmd` runs through `cmd.exe`, which splits an
 * unquoted comma list on the commas. Guidance that prints a command must print one that works
 * on the platform reading it.
 */
export function existingItemsNotice(count: number): string[] {
  if (count <= 0) return [];
  return [
    `${count} existing item${count === 1 ? '' : 's'} ${count === 1 ? 'is' : 'are'} still private.`,
    'Share them with:',
    `  knowl workspace promote --category "${KNOWLEDGE_CATEGORIES.join(',')}" --apply`,
    'Or re-run add with --promote-existing to do it in one step.',
  ];
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/cli/workspace-visibility-notice.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Wire the flags into `workspace add`**

In `src/index.ts`, replace the `workspace add` command block (currently lines 421-438) with:

```ts
workspaceCommand
  .command('add')
  .argument('<workspace>')
  .description('Link this repo into a workspace')
  .option('--name <repo-name>', 'Name this repo carries inside the workspace; defaults to the directory name')
  .option('--role <text>', 'What this repo is, for agents that have only the manifest')
  .option('--default-visibility <repo|workspace>', 'Visibility stamped on new writes here (default: repo)')
  .option('--kin <group>', 'Group name shared with repos of the same lineage')
  .option('--force', 'Link even though .knowl/config.json is tracked by git')
  .action(async (workspaceName: string, options: { name?: string; role?: string; defaultVisibility?: string; kin?: string; force?: boolean }) => {
    try {
      const root = await findProjectRoot(process.cwd());
      const repoName = options.name ?? path.basename(root).toLowerCase().replace(/[^a-z0-9-]+/g, '-');
      const visibility = parseDefaultVisibility(options.defaultVisibility);

      await joinWorkspace({
        projectRoot: root, workspaceName, repoName, force: options.force,
        settings: { role: options.role, kin: options.kin, defaultVisibility: visibility },
      });
      console.log(`Linked this repo as "${repoName}" in workspace "${workspaceName}".`);

      if (visibility === 'workspace') {
        console.log('');
        for (const line of visibilityGateNotice(repoName)) console.log(line);
        console.log('');
        for (const line of existingItemsNotice(await countOwnedItems(root, repoName))) console.log(line);
      } else {
        console.log('Its existing knowledge is now owned by that name and stays private until you run knowl workspace promote.');
      }
    } catch (error: any) {
      console.error(`Error linking repo: ${error.message}`);
      process.exit(1);
    }
  });
```

Add near the other helpers in `src/index.ts`:

```ts
/**
 * Rejected rather than coerced. A misspelled `--default-visibility` that fell back to `repo`
 * would look like it worked and quietly keep publishing nothing; one that fell back to
 * `workspace` would publish without being asked. Neither default is safe, so there is none.
 */
function parseDefaultVisibility(value: string | undefined): 'workspace' | 'repo' | undefined {
  if (value === undefined) return undefined;
  if (value === 'workspace' || value === 'repo') return value;
  throw new Error(`--default-visibility must be "repo" or "workspace", not "${value}".`);
}
```

And add the import:

```ts
import { existingItemsNotice, visibilityGateNotice } from './cli/workspace-visibility-notice.js';
```

- [ ] **Step 6: Add the CLI test**

Append to `tests/cli/workspace-cli.test.ts`, inside the existing `describe`:

```ts
  it('records repo nature and gates a workspace default behind a warning', () => {
    expect(knowl(A, 'workspace', 'init', 'gated').status).toBe(0);
    const added = knowl(A, 'workspace', 'add', 'gated', '--name', 'notes',
      '--role', 'personal notes and reading log', '--default-visibility', 'workspace', '--kin', 'forks');
    expect(added.status).toBe(0);
    expect(added.stdout).toMatch(/cannot be undone/i);
    expect(added.stdout).toMatch(/still private/i);

    const status = knowl(A, 'workspace', 'status');
    expect(status.stdout).toContain('personal notes and reading log');
  });

  it('refuses a default visibility it does not recognise instead of guessing', () => {
    expect(knowl(A, 'workspace', 'init', 'typo').status).toBe(0);
    const bad = knowl(A, 'workspace', 'add', 'typo', '--name', 'oops', '--default-visibility', 'wokspace');
    expect(bad.status).toBe(1);
    expect(bad.stderr).toMatch(/must be "repo" or "workspace"/);
  });
```

Note: the `workspace status` assertion depends on Task 6. If running tasks strictly in order, expect that one line to fail until Task 6 lands — move it there if you prefer a clean gate.

- [ ] **Step 7: Build, then run the CLI suite**

Run: `npm run build && npx vitest run tests/cli/workspace-cli.test.ts`
Expected: PASS, except the `workspace status` role assertion noted above.

- [ ] **Step 8: Commit**

```bash
git add src/index.ts src/cli/workspace-visibility-notice.ts tests/cli/workspace-visibility-notice.test.ts tests/cli/workspace-cli.test.ts
git commit -m "feat(workspace): record repo nature at add time and gate a workspace default"
```

---

### Task 6: `workspace set`

**Files:**
- Modify: `src/index.ts` (new subcommand after `workspace add`)
- Test: `tests/cli/workspace-cli.test.ts` (extend)

**Interfaces:**
- Consumes: `updateRepoSettings`, `repoEntry` (Task 2), `visibilityGateNotice` (Task 5), `parseDefaultVisibility` (Task 5).
- Produces: the `knowl workspace set` command.

- [ ] **Step 1: Write the failing test**

Append to `tests/cli/workspace-cli.test.ts`:

```ts
  it('reads settings with no flags and changes only this repo entry', () => {
    expect(knowl(A, 'workspace', 'init', 'settable').status).toBe(0);
    expect(knowl(A, 'workspace', 'add', 'settable', '--name', 'main').status).toBe(0);

    const shown = knowl(A, 'workspace', 'set');
    expect(shown.status).toBe(0);
    expect(shown.stdout).toMatch(/role:\s+\(none\)/i);
    expect(shown.stdout).toMatch(/default visibility:\s+repo/i);

    const changed = knowl(A, 'workspace', 'set', '--role', 'the main app', '--default-visibility', 'workspace');
    expect(changed.status).toBe(0);
    // The gate fires here too: `set` is the other way into standing automatic publishing.
    expect(changed.stdout).toMatch(/cannot be undone/i);

    expect(knowl(A, 'workspace', 'set').stdout).toContain('the main app');
  });

  it('refuses to set anything when this repo is not linked', () => {
    const unlinked = knowl(path.resolve('.'), 'workspace', 'set', '--role', 'nope');
    expect(unlinked.status).toBe(1);
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run build && npx vitest run tests/cli/workspace-cli.test.ts -t "reads settings with no flags"`
Expected: FAIL — `error: unknown command 'set'`.

- [ ] **Step 3: Add the command**

In `src/index.ts`, after the `workspace add` block:

```ts
workspaceCommand
  .command('set')
  .description("Change this repo's recorded nature in the workspace manifest")
  .option('--role <text>', 'What this repo is; pass an empty string to clear')
  .option('--default-visibility <repo|workspace>', 'Visibility stamped on new writes here')
  .option('--kin <group>', 'Group name shared with repos of the same lineage; pass an empty string to clear')
  .action(async (options: { role?: string; defaultVisibility?: string; kin?: string }) => {
    try {
      const root = await findProjectRoot(process.cwd());
      const active = await resolveWorkspace(root, await loadConfig(root));
      if (!active) throw new Error('This repo is not linked to a workspace.');

      const visibility = parseDefaultVisibility(options.defaultVisibility);
      const nothingToSet = options.role === undefined && options.kin === undefined && visibility === undefined;

      // No flags reads rather than errors, so this doubles as the way to see the values.
      const entry = nothingToSet
        ? repoEntry(active.manifest, active.repo)
        : await updateRepoSettings({
          workspaceName: active.name, repoName: active.repo,
          settings: { role: options.role, kin: options.kin, defaultVisibility: visibility },
        });

      console.log(`Repo "${active.repo}" in workspace "${active.name}":`);
      console.log(`  role:               ${entry?.role ?? '(none)'}`);
      console.log(`  default visibility: ${entry?.defaultVisibility ?? 'repo'}`);
      console.log(`  kin:                ${entry?.kin ?? '(none)'}`);

      if (!nothingToSet && visibility === 'workspace') {
        console.log('');
        for (const line of visibilityGateNotice(active.repo)) console.log(line);
      }
    } catch (error: any) {
      console.error(`Error updating workspace settings: ${error.message}`);
      process.exit(1);
    }
  });
```

Add the import:

```ts
import { repoEntry, updateRepoSettings } from './workspace/repo-settings.js';
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run build && npx vitest run tests/cli/workspace-cli.test.ts`
Expected: PASS, except the Task 5 `workspace status` role assertion.

- [ ] **Step 5: Commit**

```bash
git add src/index.ts tests/cli/workspace-cli.test.ts
git commit -m "feat(workspace): add workspace set for changing a repo's recorded nature"
```

---

### Task 7: Surface nature in `knowl status`

**Files:**
- Modify: `src/cli/workspace-report.ts:12-26`
- Test: `tests/cli/workspace-report.test.ts`

**Interfaces:**
- Consumes: `PeerRepo.role`, `.kin`, `.defaultVisibility` (Task 4).
- Produces: no new exports; `formatWorkspaceBlock` output gains lines.

- [ ] **Step 1: Write the failing test**

Append to `tests/cli/workspace-report.test.ts` inside the existing describe for `formatWorkspaceBlock`:

```ts
  it('shows each peer\'s recorded nature beside its presence', () => {
    const lines = formatWorkspaceBlock({
      name: 'ws', repo: 'here', manifest: {} as any,
      peers: [
        { name: 'duck', root: '/d', databasePath: '/d/db', present: true, role: 'reading log', kin: 'forks', defaultVisibility: 'workspace' },
        { name: 'plain', root: '/p', databasePath: '/p/db', present: true },
      ],
    });
    const text = lines.join('\n');
    expect(text).toContain('reading log');
    expect(text).toContain('kin: forks');
    expect(text).toMatch(/duck.*workspace-visible/s);
    // A repo with nothing recorded reads exactly as it did before.
    expect(text).toMatch(/plain\s+present\s*$/m);
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/cli/workspace-report.test.ts`
Expected: FAIL — none of `reading log`, `kin: forks`, `workspace-visible` appear.

- [ ] **Step 3: Render the fields**

In `src/cli/workspace-report.ts`, replace the peer loop inside `formatWorkspaceBlock`:

```ts
  lines.push('  Linked repos:');
  for (const peer of active.peers) {
    const state = peer.present ? 'present' : 'missing from this machine';
    // Names by default; resolved roots stay out of routine output.
    lines.push(`    ${peer.name.padEnd(16)} ${state}${options.verbose ? ` (${peer.root})` : ''}`);

    // Appended as their own lines rather than widened into the row above, so a repo with
    // nothing recorded produces byte-identical output to before this feature.
    const nature: string[] = [];
    if (peer.role) nature.push(peer.role);
    if (peer.kin) nature.push(`kin: ${peer.kin}`);
    if (peer.defaultVisibility === 'workspace') nature.push('new writes are workspace-visible');
    if (nature.length) lines.push(`      ${nature.join(' — ')}`);
  }
  return lines;
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/cli/workspace-report.test.ts`
Expected: PASS.

- [ ] **Step 5: Verify the Task 5 CLI assertion now passes too**

Run: `npm run build && npx vitest run tests/cli/workspace-cli.test.ts`
Expected: PASS, including the `workspace status` role assertion deferred from Task 5.

- [ ] **Step 6: Commit**

```bash
git add src/cli/workspace-report.ts tests/cli/workspace-report.test.ts
git commit -m "feat(cli): show each linked repo's recorded nature in status"
```

---

### Task 8: Surface nature in the session-start context block

**Files:**
- Modify: `src/core/format.ts:90-96`, `src/store/context-bootstrap.ts`
- Test: `tests/core/format-workspace.test.ts` (create)

**Interfaces:**
- Consumes: `ActiveWorkspace` (Task 4).
- Produces: `formatRecentContextToMarkdown(context, options)` where `options` gains `workspace?: WorkspaceContext`; `WorkspaceContext = { name: string; repo: string; peers: Array<{ name: string; role?: string; kin?: string; defaultVisibility?: 'workspace' }>; selfRole?: string; selfDefaultVisibility?: 'workspace' }`.

This is the surface that addresses the stated problem: an agent gets repository natures *before* it makes its first sharing decision.

- [ ] **Step 1: Write the failing test**

Create `tests/core/format-workspace.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { formatRecentContextToMarkdown } from '../../src/core/format.js';

const EMPTY = { items: [], commits: [] };

describe('workspace section in the session-start block', () => {
  it('is absent entirely for an unlinked project', () => {
    expect(formatRecentContextToMarkdown(EMPTY)).not.toMatch(/## Workspace/);
  });

  it('names each repo, its role and whether its writes are shared', () => {
    const md = formatRecentContextToMarkdown(EMPTY, {
      workspace: {
        name: 'knowl-ws', repo: 'knowl',
        selfRole: 'the Knowl CLI and MCP server',
        peers: [{ name: 'duck', role: 'personal notes and reading log', kin: 'forks', defaultVisibility: 'workspace' }],
      },
    });
    expect(md).toContain('## Workspace: knowl-ws');
    expect(md).toContain('knowl (this repo) — the Knowl CLI and MCP server — new writes stay private');
    expect(md).toContain('duck [kin: forks] — personal notes and reading log — new writes are workspace-visible');
  });

  it('still renders a repo that has recorded nothing', () => {
    const md = formatRecentContextToMarkdown(EMPTY, {
      workspace: { name: 'ws', repo: 'here', peers: [{ name: 'bare' }] },
    });
    expect(md).toContain('- bare — new writes stay private');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/core/format-workspace.test.ts`
Expected: FAIL — no `## Workspace` section is produced.

- [ ] **Step 3: Render the section**

In `src/core/format.ts`, add above `formatRecentContextToMarkdown`:

```ts
export type WorkspaceContextRepo = {
  name: string;
  role?: string;
  kin?: string;
  defaultVisibility?: 'workspace';
};

export type WorkspaceContext = {
  name: string;
  repo: string;
  peers: WorkspaceContextRepo[];
  selfRole?: string;
  selfDefaultVisibility?: 'workspace';
};

/**
 * What each repo in this workspace is, before the agent makes its first sharing decision.
 *
 * Without it, repo nature is re-derived from whatever happens to be visible, and re-derived
 * the same wrong way every time: one uniform "share selectively" posture across repos that do
 * not share a nature. A notes repo whose entire content is cross-cutting looks exactly like a
 * code repo with private internals when all you have is a name.
 */
function workspaceSection(workspace: WorkspaceContext): string {
  const line = (repo: WorkspaceContextRepo, isSelf: boolean): string => {
    const parts = [`- ${repo.name}${isSelf ? ' (this repo)' : ''}${repo.kin ? ` [kin: ${repo.kin}]` : ''}`];
    if (repo.role) parts.push(repo.role);
    parts.push(repo.defaultVisibility === 'workspace' ? 'new writes are workspace-visible' : 'new writes stay private');
    return parts.join(' — ');
  };

  const self: WorkspaceContextRepo = {
    name: workspace.repo, role: workspace.selfRole, defaultVisibility: workspace.selfDefaultVisibility,
  };
  return [
    `## Workspace: ${workspace.name}`,
    '',
    line(self, true),
    ...workspace.peers.map(peer => line(peer, false)),
    '',
    '',
  ].join('\n');
}
```

Then change the signature and the header assembly:

```ts
export function formatRecentContextToMarkdown(context: {
  items: KnowledgeItem[];
  commits: KnowledgeCommit[];
}, options: { maxChars?: number; maxItemChars?: number; includeTags?: boolean; includeCommitDetails?: boolean; workspace?: WorkspaceContext } = {}): string {
  const maxChars = options.maxChars ?? DEFAULT_CONTEXT_MAX_CHARS;
  const maxItemChars = options.maxItemChars ?? MAX_ITEM_CONTENT_CHARS;
  let md = '# KNOWL - RECENT SESSION CONTEXT\n\n';

  // Absent produces byte-identical output, the same rule formatWorkspaceBlock already holds
  // for an unlinked project.
  if (options.workspace) md += workspaceSection(options.workspace);

  md += '## Recent Active Knowledge\n\n';
```

- [ ] **Step 4: Pass the workspace in from the bootstrap**

In `src/store/context-bootstrap.ts`, replace the context-building block (lines 26-34):

```ts
  if (options.includeContext === false) return { session, context: undefined, truncated: false };
  const recent = await getRecentContext(input.projectId);
  const fallback = formatRecentContextToMarkdown(recent, {
    maxChars: Number.MAX_SAFE_INTEGER,
    workspace: await workspaceContext(),
  });
```

And add above `bootstrapAgentSession`:

```ts
/**
 * The active workspace, shaped for the context block, or undefined.
 *
 * Resolved from the open store's root rather than a passed-in path, because bootstrap is
 * given a project id and the root is what `resolveWorkspace` needs. Never fatal: a workspace
 * that cannot be read degrades to no section, exactly as an unlinked repo does.
 */
async function workspaceContext(): Promise<WorkspaceContext | undefined> {
  try {
    const { getConfigRoot } = await import('./database.js');
    const { resolveWorkspace } = await import('../workspace/resolve.js');
    const { repoEntry } = await import('../workspace/repo-settings.js');
    const active = await resolveWorkspace(getConfigRoot());
    if (!active) return undefined;

    const self = repoEntry(active.manifest, active.repo);
    return {
      name: active.name,
      repo: active.repo,
      selfRole: self?.role,
      selfDefaultVisibility: self?.defaultVisibility,
      peers: active.peers.map(peer => ({
        name: peer.name, role: peer.role, kin: peer.kin, defaultVisibility: peer.defaultVisibility,
      })),
    };
  } catch {
    return undefined;
  }
}
```

Add to the imports at the top of the file:

```ts
import { formatRecentContextToMarkdown, type WorkspaceContext } from '../core/format.js';
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/core/format-workspace.test.ts tests/store/context-bootstrap.test.ts`
Expected: PASS. `context-bootstrap.test.ts` is the guard that an unlinked project's block is unchanged.

- [ ] **Step 6: Commit**

```bash
git add src/core/format.ts src/store/context-bootstrap.ts tests/core/format-workspace.test.ts
git commit -m "feat(core): tell agents what each linked repo is at session start"
```

---

### Task 9: Kin weighting in the cross-repo write advisory

**Files:**
- Modify: `src/workspace/cross-repo-overlap.ts`, `src/mcp/tools.ts:39-62`
- Test: `tests/mcp/cross-repo-advisory.test.ts` (extend)

**Interfaces:**
- Consumes: `PeerRepo.kin`, `.role` (Task 4); `ActiveWorkspace.manifest` (existing).
- Produces: `CrossRepoOverlap` gains `kin?: boolean` and `role?: string`; `KIN_PEER_CANDIDATES = 6`.

`sameSubjectTitle` is **not** touched. The decision was to annotate, not to loosen — a lower threshold for kin peers would surface near-miss titles at the cost of noise on every write in a kin pair.

- [ ] **Step 1: Write the failing test**

Append to `tests/mcp/cross-repo-advisory.test.ts`:

```ts
  it('marks a kin repo and names what it is, so a same-subject hit reads as divergence', () => {
    const note = describeWriteReconciliation({
      item: { id: 'new-1' },
      crossRepo: [{
        repo: 'duck', id: 'peer-1', title: 'Wire format is JSON',
        kind: 'conflict', kin: true, role: 'the other fork of this service',
      }],
    });
    expect(note).toContain('"duck"');
    expect(note).toContain('the other fork of this service');
    expect(note).toMatch(/shares this repo's lineage/i);
  });

  it('leaves an unrelated repo advisory exactly as it was', () => {
    const note = describeWriteReconciliation({
      item: { id: 'new-2' },
      crossRepo: [{ repo: 'other', id: 'peer-2', title: 'Something', kind: 'duplicate' }],
    });
    expect(note).not.toMatch(/lineage/i);
    expect(note).toContain('OVERLAPS linked repo "other"');
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/mcp/cross-repo-advisory.test.ts`
Expected: FAIL — the first test finds no role text and no lineage clause (and TypeScript rejects `kin` on the literal).

- [ ] **Step 3: Widen the overlap type and weight kin peers**

In `src/workspace/cross-repo-overlap.ts`, replace the type and the candidate constant:

```ts
export type CrossRepoOverlap = {
  repo: string;
  id: string;
  title: string;
  kind: 'conflict' | 'duplicate';
  /** The peer shares this repo's `kin` group: same lineage, diverged conventions. */
  kin?: boolean;
  /** The peer's recorded role, so the advisory can say what the other repo is. */
  role?: string;
};

/** Per peer, per write. Bounded because this runs on every knowledge write in a workspace. */
const PEER_CANDIDATES = 3;

/**
 * Kin peers are checked wider.
 *
 * Two repos of the same lineage hold genuinely overlapping subjects with diverged conventions,
 * so a same-subject item is likelier to exist and likelier to matter. The matcher itself is
 * deliberately untouched: loosening `sameSubjectTitle` for kin would surface near-miss titles
 * on every write in a kin pair, and the decision here was to look wider, not to match looser.
 */
const KIN_PEER_CANDIDATES = 6;
```

Then, inside `findCrossRepoOverlap`, before the peer loop:

```ts
  const selfKin = workspace.manifest.repos.find(entry => entry.name === workspace.repo)?.kin;
```

And inside the loop, replace the body's candidate call and both `found.push` sites:

```ts
    if (!peer.present) continue;
    const isKin = Boolean(selfKin && peer.kin === selfKin);
    try {
      const store = await openPeerStore(peer.databasePath);

      // An exclusive key held by another repo is a genuine contradiction, not a near miss.
      // `visibility` goes into the query rather than being checked on the way out: a peer's
      // private row must not be read into this process at all.
      const conflicts = await checkKnowledgeConflict({ ...input.item, visibility: 'workspace' }, store);
      for (const conflict of conflicts) {
        found.push({ repo: peer.name, id: conflict.id, title: conflict.title, kind: 'conflict', kin: isKin, role: peer.role });
      }

      // The same ranker the local duplicate check uses, pointed at the peer.
      const candidates = await rankKnowledge('local', {
        query,
        status: 'active',
        visibility: 'workspace',
        limit: isKin ? KIN_PEER_CANDIDATES : PEER_CANDIDATES,
      }, store);

      for (const candidate of candidates) {
        if (found.some(entry => entry.id === candidate.id)) continue;
        // The local matcher, reused rather than restated. A second title comparison here
        // would be the duplication this whole change removes, and the two would drift the
        // moment either is tuned.
        if (!sameSubjectTitle(input.item, candidate)) continue;
        found.push({ repo: peer.name, id: candidate.id, title: candidate.title, kind: 'duplicate', kin: isKin, role: peer.role });
      }
```

- [ ] **Step 4: Render it in the advisory**

In `src/mcp/tools.ts`, widen the `crossRepo` parameter type on line 43 and the loop below it:

```ts
  crossRepo?: Array<{ repo: string; id: string; title: string; kind: 'conflict' | 'duplicate'; kin?: boolean; role?: string }>;
}): string {
```

```ts
  for (const overlap of result.crossRepo ?? []) {
    const what = overlap.kind === 'conflict'
      ? `CONTRADICTS linked repo "${overlap.repo}"`
      : `OVERLAPS linked repo "${overlap.repo}"`;
    const describes = overlap.role ? ` (${overlap.role})` : '';
    // Only for kin. An unrelated repo's advisory must stay exactly as it was, or every
    // cross-repo note grows a clause that means nothing.
    const lineage = overlap.kin
      ? ` That repo shares this repo's lineage, so a same-subject item is more likely a real divergence in convention than a coincidence of wording.`
      : '';
    notes.push(`${what}${describes}: item ${overlap.id} ("${overlap.title}"). You cannot retire or edit it from this repo -- it belongs to "${overlap.repo}". Your write stands; if the two genuinely disagree, raise it with whoever owns that repo.${lineage}`);
  }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/mcp/cross-repo-advisory.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/workspace/cross-repo-overlap.ts src/mcp/tools.ts tests/mcp/cross-repo-advisory.test.ts
git commit -m "feat(workspace): check kin repos wider and say what they are in the advisory"
```

---

### Task 10: `--promote-existing`

**Files:**
- Modify: `src/index.ts` (the `workspace add` action from Task 5)
- Test: `tests/cli/workspace-cli.test.ts` (extend)

**Interfaces:**
- Consumes: `promoteItems` (existing), `KNOWLEDGE_CATEGORIES` (existing), the `add` action from Task 5.
- Produces: the `--promote-existing` flag.

Ordering matters: `promoteItems` selects on ownership, and `joinWorkspace` stamps ownership via `backfillOriginRepo`. Promote must run after the join or it selects nothing.

- [ ] **Step 1: Write the failing test**

Append to `tests/cli/workspace-cli.test.ts`:

```ts
  it('refuses --promote-existing without a workspace default, instead of ignoring it', () => {
    expect(knowl(A, 'workspace', 'init', 'noflag').status).toBe(0);
    const bad = knowl(A, 'workspace', 'add', 'noflag', '--name', 'nf', '--promote-existing');
    expect(bad.status).toBe(1);
    expect(bad.stderr).toMatch(/--promote-existing/);
    expect(bad.stderr).toMatch(/--default-visibility workspace/);
  });

  it('promotes what is already there when asked, in the same command', () => {
    expect(knowl(A, 'workspace', 'init', 'oneshot').status).toBe(0);
    const added = knowl(A, 'workspace', 'add', 'oneshot', '--name', 'os',
      '--default-visibility', 'workspace', '--promote-existing');
    expect(added.status).toBe(0);
    expect(added.stdout).toMatch(/Promoted \d+ existing item/);
    // Nothing is left private, so the "still private" notice must not also print.
    expect(added.stdout).not.toMatch(/still private/i);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run build && npx vitest run tests/cli/workspace-cli.test.ts -t "promote-existing"`
Expected: FAIL — `error: unknown option '--promote-existing'`.

- [ ] **Step 3: Add the flag**

In `src/index.ts`, add the option to `workspace add`:

```ts
  .option('--promote-existing', 'Also share knowledge already in this repo; requires --default-visibility workspace')
```

Widen the action's options type with `promoteExisting?: boolean`, and insert this check immediately after `const visibility = parseDefaultVisibility(...)`:

```ts
      // Rejected rather than ignored. A flag that silently does nothing is how you end up
      // believing a whole repo was shared when none of it was -- the same rule `knowl upgrade`
      // applies to its --all-only flags.
      if (options.promoteExisting && visibility !== 'workspace') {
        throw new Error('--promote-existing only applies with --default-visibility workspace, because it publishes everything this repo already knows.');
      }
```

Then replace the reporting branch so promotion runs before the notice:

```ts
      if (visibility === 'workspace') {
        console.log('');
        for (const line of visibilityGateNotice(repoName)) console.log(line);
        console.log('');

        if (options.promoteExisting) {
          // After joinWorkspace, never before: promote selects on ownership, and the join's
          // backfill is what stamps it. Run first, it would match nothing and report success.
          const promoted = await promoteItems({
            projectRoot: root, repoName,
            categories: [...KNOWLEDGE_CATEGORIES], apply: true,
          });
          console.log(`Promoted ${promoted.items.length} existing item(s) to workspace visibility.`);
        } else {
          for (const line of existingItemsNotice(await countOwnedItems(root, repoName))) console.log(line);
        }
      } else {
```

Add `KNOWLEDGE_CATEGORIES` to the existing `./core/types.js` import in `src/index.ts`.

Note the spread: `KNOWLEDGE_CATEGORIES` is a `readonly` tuple and `promoteItems` takes a mutable `KnowledgeCategory[]`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run build && npx vitest run tests/cli/workspace-cli.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/index.ts tests/cli/workspace-cli.test.ts
git commit -m "feat(workspace): share what a repo already knows with --promote-existing"
```

---

### Task 11: Orthogonality guard, full suite, and CHANGELOG

**Files:**
- Test: `tests/cli/upgrade.test.ts` (extend)
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes: everything above.
- Produces: nothing new.

- [ ] **Step 1: Write the orthogonality test**

The spec requires proof that the ownership sweep added in `543ae67` cannot publish anything. Append to `tests/cli/upgrade.test.ts`:

```ts
  it('claims ownership of old rows without touching their visibility', async () => {
    // The upgrade sweep and the default-visibility feature both write to knowledge_items in a
    // workspace. They must stay orthogonal: claiming an unowned row says who wrote it, never
    // who may read it, and promotion has no reverse.
    await initDb(ROOT);
    const project = await repo.getProjectByRootPath(ROOT);
    const item = await repo.createKnowledgeItem(project!.id, {
      category: 'fact', title: 'Predates ownership', content: 'Written before stamping existed.',
    });
    await getClient().execute({
      sql: "UPDATE knowledge_items SET origin_repo = NULL, visibility = 'repo' WHERE id = ?",
      args: [item.id],
    });
    await closeDb();

    await upgradeExistingRepository(ROOT, 'swept');

    await initDb(ROOT);
    const row = (await getClient().execute({
      sql: 'SELECT origin_repo, visibility FROM knowledge_items WHERE id = ?',
      args: [item.id],
    })).rows[0] as any;
    expect(row.origin_repo).not.toBeNull();
    expect(row.visibility).toBe('repo');
    await closeDb();
  });
```

Adjust `ROOT` and the imports to match whatever the existing `tests/cli/upgrade.test.ts` fixture already sets up — read that file first and reuse its `beforeAll`. The test requires the fixture repo to be linked to a workspace; if the existing fixture is unlinked, link it inside this test with the same `saveConfig` + `writeManifest` pattern used in `tests/store/write-visibility.test.ts` from Task 3.

- [ ] **Step 2: Run the test**

Run: `npx vitest run tests/cli/upgrade.test.ts`
Expected: PASS. If it fails on `origin_repo` being null, the fixture repo is not linked — fix the fixture, not the assertion.

- [ ] **Step 3: Run the full suite**

Run: `npm run build && npm test`
Expected: PASS, all files. Compare the count against the 778 tests / 106 files baseline at `543ae67` — the total should have grown by roughly 25, and nothing should have gone from passing to failing.

- [ ] **Step 4: Write the CHANGELOG entry**

Add under the existing `## Unreleased` → `### Added` in `CHANGELOG.md`, above the `upgrade --all` entry:

```markdown
- **A repository can record what it is, and whether its knowledge is shared by default.**
  `knowl workspace add` stored a name and a path, so a repository's nature — code with private
  internals, notes that are cross-cutting by definition, one of two diverged forks — lived
  nowhere. Every agent re-derived it, and got it wrong the same way each time: one uniform
  "share selectively" posture applied across repositories that do not share a nature.

  `--role` is free text describing the repository, carried in the manifest so an agent that
  joined on another machine has it too. It is never parsed and no behavior is inferred from it.
  `--default-visibility workspace` stamps new writes as workspace-visible, so a notes
  repository stops depending on someone remembering to promote each item; `--promote-existing`
  shares what it already knows in the same command. `--kin` groups repositories of shared
  lineage, and the cross-repo write advisory checks them wider and says what they are — a
  same-subject hit between two forks is likelier a real divergence than a coincidence.

  `knowl workspace set` changes any of the three afterwards, and with no flags prints them.
  Every repository's role and default visibility now appears in `knowl status` and at the top
  of the session-start context block, so an agent has them before its first sharing decision.

  A workspace default is gated at both entry points, because it is standing automatic
  publishing rather than an explicit per-batch promote: it states that sharing cannot be
  undone, that there is no demote, and that turning it off stops future writes only. Absent
  fields mean current behavior, so existing manifests need no migration.
```

- [ ] **Step 5: Commit**

```bash
git add CHANGELOG.md tests/cli/upgrade.test.ts
git commit -m "docs(changelog): record per-repo role and default visibility"
```

---

## Self-Review

**Spec coverage**

| Spec section | Task |
| --- | --- |
| §1 Manifest schema, normalization, round-trip safety | 1 |
| §2 Write path, one cache, both stamp sites | 3 |
| §3 Safety posture: gate at `add` and `set` | 5, 6 |
| §3 No `DoctorRemedy` changes visibility | Global constraint; guarded by Task 11's orthogonality test |
| §4 CLI: `add` flags | 5 |
| §4 CLI: `set`, own entry only, no-flags reads | 2, 6 |
| §4 CLI: `join` inherits, gains no flags | 4 (no flags added, by construction) |
| §4 `--promote-existing`, rejected not ignored, runs after backfill | 10 |
| §5 Session-start block | 8 |
| §5 `formatWorkspaceBlock` | 7 |
| §5 `describeWriteReconciliation` | 9 |
| §6 Kin weighting, matcher untouched | 9 |
| Testing table, all eight rows | 1, 2, 3, 6, 7, 8, 10, 11 |
| Backward compatibility | 1 (normalization), 7 and 8 (byte-identical when absent) |

**Deferred assertion, flagged deliberately:** the `workspace status` role check written in Task 5 Step 6 depends on Task 7. Both the step and Task 7 Step 5 say so.

**Fixture dependency, flagged deliberately:** Task 11 Step 1 depends on the shape of the existing `tests/cli/upgrade.test.ts` fixture, which the implementer must read first. The step says what to do in either case rather than guessing.

**Type consistency:** `defaultVisibility` is `'workspace' | undefined` on `WorkspaceRepo`, `PeerRepo` and `WorkspaceContextRepo` throughout, and `'workspace' | 'repo' | undefined` only on `RepoSettings` (Task 2) and `parseDefaultVisibility` (Task 5), where `'repo'` is the explicit instruction to clear. `defaultVisibilityOf` and `WriteDefaults.visibility` return the resolved `'repo' | 'workspace'`. `normalizeRepoEntry`, `repoEntry`, `updateRepoSettings`, `resolveWriteDefaults`, `visibilityGateNotice`, `existingItemsNotice` and `parseDefaultVisibility` are each defined once and used under the same name everywhere after.
