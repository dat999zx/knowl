# Global Memory Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the global memory namespace real: a machine-wide personal-defaults store that a project can link to, that a session with no project can use alone, and that ordinary queries actually read.

**Architecture:** Almost every piece exists and is unreachable. `MemoryNamespace`, precedence, `externalNamespace`, `queryLayeredKnowledge` and per-row `profile_fingerprint` are already built; the layered read simply never runs, because it is gated on `!vector?.enabled` and vector search is the default. This plan adds a known store path, a project-less resolution mode, per-namespace query embedding so the layered read can run under vector search, and the CLI surface to create and link it.

**Tech Stack:** TypeScript (ESM, tsup), vitest, libsql/drizzle, commander.

**Spec:** `docs/superpowers/specs/2026-09-04-global-memory-layer-design.md`

## Global Constraints

- Governed by decision `d7bfb0ef36fe41d2`: global is a **cross-project personal-defaults layer, not merged project truth**. Project knowledge stays authoritative.
- Precedence is already correct and must not change: `RANK = { session: 1, project: 2, organization: 3, global: 4 }`.
- Never merge scores across namespaces. `interleaveByPrecedence` is round-robin because scores from different stores are not comparable.
- A namespace that cannot be served is **skipped and named**, never silently dropped — the existing `skippedNamespaces` rule.
- Global is machine-local: not synced, not pushed to a cloud workspace.
- A session that *has* a project must never fall back to global. Global is for when there is no project, not for when resolution failed.
- Verify with `npm run build`, `npm test`, `npx eslint .`, `npm run docs:check`.
- Branch `feat/global-memory` off `main`; commit after every task.

---

## File map

| File | Responsibility |
| --- | --- |
| `src/core/paths.ts` (modify) | `globalStorePath()` |
| `src/store/namespaces.ts` (modify) | `globalOnlyNamespaces()`, per-namespace embedding profile |
| `src/store/global-store.ts` (create) | create the global database, idempotently |
| `src/store/agent-query.ts` (modify) | accept an explicit profile fingerprint |
| `src/mcp/tools.ts` (modify) | run the layered path under vector search; report skips |
| `src/core/config.ts` (modify) | link/unlink helpers for `memory.global` |
| `src/cli/program.ts` (modify) | `knowl link global`, `store --namespace`, `init` picker, `--host-only` |
| `tests/store/global-namespace.test.ts` (create) | store creation, resolution, precedence |
| `tests/store/layered-vector.test.ts` (create) | layered read under vector search, skips |
| `tests/cli/global-link.test.ts` (create) | link/unlink, `--namespace global`, init picker |

---

### Task 0: Branch

- [ ] **Step 1: Create the branch**

```bash
git checkout -b feat/global-memory main
```

---

### Task 1: The global store path and its creation

**Files:**
- Modify: `src/core/paths.ts`
- Create: `src/store/global-store.ts`
- Test: `tests/store/global-namespace.test.ts`

**Interfaces:**
- Produces: `globalStorePath(): string` — `<knowlHome()>/global.db`.
- Produces: `ensureGlobalStore(): Promise<{ path: string; created: boolean }>` — creates the database and its schema if absent; `created: false` on every later call.

- [ ] **Step 1: Write the failing test**

`tests/store/global-namespace.test.ts`:

```ts
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb } from '../../src/store/database.js';
import { releaseAll } from '../../src/store/connection-pool.js';
import { globalStorePath } from '../../src/core/paths.js';
import { ensureGlobalStore } from '../../src/store/global-store.js';

const HOME = path.join(os.tmpdir(), 'knowl-global-home');

describe('the global store', () => {
  const saved = process.env.KNOWL_HOME;
  beforeEach(async () => {
    process.env.KNOWL_HOME = HOME;
    await closeDb().catch(() => {});
    await releaseAll().catch(() => {});
    await fs.rm(HOME, { recursive: true, force: true }).catch(() => {});
  });
  afterEach(async () => {
    await closeDb().catch(() => {});
    await releaseAll().catch(() => {});
    await fs.rm(HOME, { recursive: true, force: true }).catch(() => {});
    if (saved === undefined) delete process.env.KNOWL_HOME; else process.env.KNOWL_HOME = saved;
  });

  it('lives beside the machine home rather than being a project at it', () => {
    // `knowl init` at ~ would put a project store at ~/.knowl/knowl.db, on top of models/,
    // cache/, repos.json and credentials.json. Its own file, not its own project.
    expect(globalStorePath()).toBe(path.join(HOME, 'global.db'));
    expect(path.basename(globalStorePath())).not.toBe('knowl.db');
  });

  it('creates the database once and reports it as present afterwards', async () => {
    const first = await ensureGlobalStore();
    expect(first.created).toBe(true);
    await expect(fs.access(first.path)).resolves.toBeUndefined();

    const second = await ensureGlobalStore();
    expect(second.created).toBe(false);
    expect(second.path).toBe(first.path);
  });
});
```

- [ ] **Step 2: Run, expect failure**

Run: `npx vitest run tests/store/global-namespace.test.ts`
Expected: FAIL — `globalStorePath` is not exported.

- [ ] **Step 3: Add the path**

In `src/core/paths.ts`, after `knowlHome()`:

```ts
/**
 * The machine-wide personal-defaults store.
 *
 * A file under the home rather than a project at it: `knowlHome()` IS `~/.knowl`, so a project
 * rooted at `~` would put its store at `~/.knowl/knowl.db`, in the directory that already holds
 * `models/`, `cache/`, `repos.json`, `fleet.db` and `credentials.json`. `scaffoldTarget` refuses
 * that case by name, and this is the shape `externalNamespace` already expects: an explicit path,
 * outside any project.
 */
export function globalStorePath(): string {
  return path.join(knowlHome(), 'global.db');
}
```

- [ ] **Step 4: Create the store module**

`src/store/global-store.ts`:

```ts
import fs from 'node:fs/promises';
import path from 'node:path';
import { globalStorePath } from '../core/paths.js';
import { initDbPath } from './database.js';

/**
 * Create the global store if it is missing, and say which happened.
 *
 * Idempotent because every entry point calls it: `knowl init`, `knowl link global`, and the
 * project-less resolution path. The caller reports "created" only on the first one, so a second
 * `knowl init` does not claim to have made something that was already there.
 *
 * The config root is the Knowl home, so the store reads and writes with one embedding profile of
 * its own -- the property the layered reader depends on (see `namespaceFingerprint`).
 */
export async function ensureGlobalStore(): Promise<{ path: string; created: boolean }> {
  const target = globalStorePath();
  const existed = await fs.access(target).then(() => true, () => false);
  await fs.mkdir(path.dirname(target), { recursive: true });
  // Opening runs schema bootstrap; closing leaves a file the namespace reader can attach to.
  await initDbPath(target, { configRoot: path.dirname(target) });
  return { path: target, created: !existed };
}
```

- [ ] **Step 5: Run, expect pass**

Run: `npx vitest run tests/store/global-namespace.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add src/core/paths.ts src/store/global-store.ts tests/store/global-namespace.test.ts
git commit -m "feat(store): the global store path, created idempotently"
```

---

### Task 2: Resolution with no project

**Files:**
- Modify: `src/store/namespaces.ts`
- Test: `tests/store/global-namespace.test.ts` (extend)

**Interfaces:**
- Produces: `globalNamespaceDescriptor(): NamespaceDescriptor` — the global store by its known path, precedence `RANK.global`.
- Produces: `globalOnlyNamespaces(): NamespaceDescriptor[]` — `[global]` when the store exists, `[]` when it does not.

- [ ] **Step 1: Write the failing test**

Append to `tests/store/global-namespace.test.ts`:

```ts
import { globalOnlyNamespaces } from '../../src/store/namespaces.js';

describe('resolution with no project', () => {
  it('is empty before the store exists, and global-only after', async () => {
    expect(globalOnlyNamespaces()).toEqual([]);
    await ensureGlobalStore();
    const namespaces = globalOnlyNamespaces();
    expect(namespaces).toHaveLength(1);
    expect(namespaces[0].namespace).toBe('global');
    expect(namespaces[0].databasePath).toBe(globalStorePath());
    // Optional everywhere else; here it is the only store, so a failure to open is a real error.
    expect(namespaces[0].optional).toBeFalsy();
  });
});
```

(Move the `beforeEach`/`afterEach` above into a shared scope so both `describe` blocks get the temporary home — simplest is to wrap both in one outer `describe`.)

- [ ] **Step 2: Run, expect failure**

Run: `npx vitest run tests/store/global-namespace.test.ts`
Expected: FAIL — `globalOnlyNamespaces` is not exported.

- [ ] **Step 3: Implement**

In `src/store/namespaces.ts`:

```ts
import fsSync from 'node:fs';
import { globalStorePath } from '../core/paths.js';

/** The global store as a namespace, addressed by its known path rather than a project's config. */
export function globalNamespaceDescriptor(): NamespaceDescriptor {
  return { namespace: 'global', databasePath: globalStorePath(), precedence: RANK.global };
}

/**
 * The namespaces available when there is no project at all -- `knowl` outside a repository, or a
 * host session with no folder open.
 *
 * Global alone, and only when it exists: a machine that never created one has no memory here, and
 * saying so is better than an empty answer from a store that was never made.
 *
 * Deliberately NOT a fallback. Nothing calls this when a project was found and failed to open --
 * a broken project is an error, and answering it from the personal-defaults layer would be the
 * cross-project contamination this layer exists to avoid.
 */
export function globalOnlyNamespaces(): NamespaceDescriptor[] {
  const descriptor = globalNamespaceDescriptor();
  // `optional` is what lets the layered reader swallow a namespace's failure. Here it is the only
  // store, so a failure has to surface.
  return fsSync.existsSync(descriptor.databasePath) ? [{ ...descriptor, optional: false }] : [];
}
```

- [ ] **Step 4: Run, expect pass**

Run: `npx vitest run tests/store/global-namespace.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/store/namespaces.ts tests/store/global-namespace.test.ts
git commit -m "feat(store): resolve to the global namespace when there is no project"
```

---

### Task 3: Per-namespace embedding, so the layered read can run under vector search

**Files:**
- Modify: `src/store/namespaces.ts`
- Modify: `src/store/agent-query.ts`
- Test: `tests/store/layered-vector.test.ts`

**Interfaces:**
- Produces: `namespaceFingerprint(descriptor: NamespaceDescriptor): Promise<string | null>` — the embedding profile fingerprint for that namespace's own config root (the project root for `project`/`session`, the Knowl home for `global`/`organization`). `null` when it cannot be resolved.
- Changes: `queryLayeredKnowledge(root, query, descriptors, limit, surface, filters, vector?)` gains an optional `vector` option, forwarded per namespace with that namespace's fingerprint.

**Why it matters:** `searchKnowledgeEmbeddings` requires `profileFingerprint` and filters on it, because scoring a 768-dimension query vector against 384-dimension rows is meaningless. Each namespace must therefore be searched with its own identity, not the caller's.

- [ ] **Step 1: Write the failing test**

`tests/store/layered-vector.test.ts`:

```ts
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb } from '../../src/store/database.js';
import { releaseAll } from '../../src/store/connection-pool.js';
import { ensureGlobalStore } from '../../src/store/global-store.js';
import { globalNamespaceDescriptor, projectNamespace, queryLayeredKnowledge } from '../../src/store/namespaces.js';
import { DEFAULT_CONFIG, saveConfig } from '../../src/core/config.js';
import { initDb } from '../../src/store/database.js';
import * as repo from '../../src/store/repository.js';
import { storeKnowledgeItemDeduped } from '../../src/store/knowledge-writer.js';

const HOME = path.join(os.tmpdir(), 'knowl-lv-home');
const PROJECT = path.join(os.tmpdir(), 'knowl-lv-project');

describe('the layered read spans namespaces', () => {
  const saved = process.env.KNOWL_HOME;
  beforeEach(async () => {
    process.env.KNOWL_HOME = HOME;
    await closeDb().catch(() => {});
    await releaseAll().catch(() => {});
    for (const dir of [HOME, PROJECT]) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    await fs.mkdir(path.join(PROJECT, '.knowl'), { recursive: true });
    await saveConfig(PROJECT, { ...DEFAULT_CONFIG });
    await initDb(PROJECT);
    const project = await repo.createProject(PROJECT, 'lv-project');
    await storeKnowledgeItemDeduped(project.id, {
      category: 'decision',
      title: 'This project deploys on Tuesday',
      content: 'The deploy window for this repository is Tuesday.',
    });
    await closeDb();
    await releaseAll();
    // One personal default, in the global store.
    await ensureGlobalStore();
  });
  afterEach(async () => {
    await closeDb().catch(() => {});
    await releaseAll().catch(() => {});
    for (const dir of [HOME, PROJECT]) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    if (saved === undefined) delete process.env.KNOWL_HOME; else process.env.KNOWL_HOME = saved;
  });

  it('returns the project item ahead of the global one, both labelled', async () => {
    const items = await queryLayeredKnowledge(
      PROJECT, 'deploy window', [projectNamespace(PROJECT), globalNamespaceDescriptor()], 5, 'test', {},
    );
    expect(items.length).toBeGreaterThan(0);
    expect(items[0].namespace).toBe('project');
    expect(items.every(item => typeof item.namespace === 'string')).toBe(true);
  });

  it('gives each namespace its own embedding identity', async () => {
    const { namespaceFingerprint } = await import('../../src/store/namespaces.js');
    const project = await namespaceFingerprint(projectNamespace(PROJECT));
    const global = await namespaceFingerprint(globalNamespaceDescriptor());
    // Both resolvable, and each derived from its OWN config root rather than the caller's.
    expect(project).toBeTruthy();
    expect(global).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run, expect failure**

Run: `npx vitest run tests/store/layered-vector.test.ts`
Expected: FAIL — `namespaceFingerprint` is not exported.

- [ ] **Step 3: Implement the fingerprint**

In `src/store/namespaces.ts`:

```ts
import { knowlHome } from '../core/paths.js';

/**
 * The config root a namespace's embeddings were written under.
 *
 * `session` and `project` live inside a checkout and read that project's config. `global` and
 * `organization` are standalone files, so their profile comes from the Knowl home -- which is what
 * makes a global store internally consistent: every read and every write resolves the same
 * profile, whatever the project that happened to open it uses.
 */
function namespaceConfigRoot(descriptor: NamespaceDescriptor, projectRoot: string): string {
  return descriptor.namespace === 'session' || descriptor.namespace === 'project'
    ? projectRoot
    : knowlHome();
}

/**
 * The embedding identity to search a namespace with.
 *
 * Required rather than convenient: `searchKnowledgeEmbeddings` filters on it, and that predicate
 * is load-bearing because cosine similarity between vectors of different dimensions is
 * meaningless. A namespace whose profile cannot be resolved returns null, and the caller skips it
 * and says so rather than scoring it with someone else's identity.
 */
export async function namespaceFingerprint(
  descriptor: NamespaceDescriptor,
  projectRoot: string = knowlHome(),
): Promise<string | null> {
  try {
    const [{ loadConfig }, { fingerprintProfile, resolveVectorProfile }] = await Promise.all([
      import('../core/config.js'),
      import('../core/vector-profile.js'),
    ]);
    const root = namespaceConfigRoot(descriptor, projectRoot);
    return fingerprintProfile(resolveVectorProfile(await loadConfig(root)));
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Forward the vector options per namespace**

Change `queryLayeredKnowledge` to accept and use them:

```ts
export async function queryLayeredKnowledge(
  root: string,
  query: string,
  descriptors: NamespaceDescriptor[],
  limit = 3,
  surface = 'namespace_query',
  filters: LayeredFilters = {},
  // Absent keeps the old lexical behaviour, so every existing caller is unchanged.
  vector?: { enabled: boolean },
): Promise<{ items: NamespacedKnowledgeItem[]; skipped: MemoryNamespace[] }> {
  const ranked: NamespacedKnowledgeItem[][] = [];
  const skipped: MemoryNamespace[] = [];
  const seen = new Set<string>();
  for (const descriptor of namespacePrecedence(descriptors)) {
    try {
      // Each namespace is searched with ITS identity. A namespace whose profile cannot be
      // resolved is skipped and named -- never scored against the caller's vectors.
      const fingerprint = vector?.enabled ? await namespaceFingerprint(descriptor, root) : null;
      if (vector?.enabled && !fingerprint) {
        skipped.push(descriptor.namespace);
        continue;
      }
      const items = await withNamespaceDatabase(descriptor, () => queryKnowledgeForAgent('local', {
        query,
        limit,
        surface,
        category: filters.category,
        status: filters.status,
        tags: filters.tags,
        ...(fingerprint ? { vector: { enabled: true, profileFingerprint: fingerprint } } : {}),
      }));
      const kept: NamespacedKnowledgeItem[] = [];
      for (const item of items) {
        const key = item.contentHash ?? `${item.title}\n${item.content}`;
        if (!seen.has(key)) {
          seen.add(key);
          kept.push({ ...item, namespace: descriptor.namespace });
        }
      }
      ranked.push(kept);
    } catch (error) {
      if (!descriptor.optional) throw error;
      skipped.push(descriptor.namespace);
    }
  }
  return { items: interleaveByPrecedence(ranked, limit), skipped };
}
```

Update the two existing call sites (`src/mcp/tools.ts`, and any test) to read `.items`. `queryKnowledgeForAgent` must accept the `vector.profileFingerprint` it forwards — check its options type and thread it to `searchKnowledgeEmbeddings`; it already takes a `vector` option, so this is adding the fingerprint to that shape rather than a new parameter.

- [ ] **Step 5: Run, expect pass**

Run: `npx vitest run tests/store/layered-vector.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add src/store/namespaces.ts src/store/agent-query.ts tests/store/layered-vector.test.ts
git commit -m "feat(store): search each namespace with its own embedding identity"
```

---

### Task 4: Run the layered path under vector search

**Files:**
- Modify: `src/mcp/tools.ts` (the `layered` branch around line 885)
- Test: `tests/store/layered-vector.test.ts` (extend)

**Interfaces:**
- Consumes: `queryLayeredKnowledge(...) -> { items, skipped }` from Task 3.

- [ ] **Step 1: Write the failing test**

Append to `tests/store/layered-vector.test.ts`:

```ts
it('names the namespaces it could not search instead of narrowing silently', async () => {
  const unreachable = { namespace: 'organization' as const, databasePath: path.join(HOME, 'nope.db'), precedence: 3, optional: true };
  const { skipped } = await queryLayeredKnowledge(
    PROJECT, 'deploy', [projectNamespace(PROJECT), unreachable], 5, 'test', {},
  );
  expect(skipped).toContain('organization');
});
```

- [ ] **Step 2: Run, expect failure**

Run: `npx vitest run tests/store/layered-vector.test.ts`
Expected: FAIL until Task 3's `skipped` is returned; if Task 3 is complete this passes and the real change is the caller below.

- [ ] **Step 3: Take the gate off the layered path**

In `src/mcp/tools.ts`, replace the `layered` condition and its branch:

```ts
        // Was `Boolean(projectRoot) && !explain && !vector?.enabled` -- which meant the layered
        // read never ran in the default configuration, so a linked global or organization
        // namespace was written to and never read from. Each namespace now carries its own
        // embedding identity (`namespaceFingerprint`), so vector search spans them; `explain`
        // still falls through, because its per-term reporting is single-store by construction.
        const layered = Boolean(projectRoot) && !explain;
        const layeredResult = layered
          ? await queryLayeredKnowledge(
            projectRoot!, query ?? '', configuredNamespaces(projectRoot!, config ?? undefined),
            limit ?? DEFAULT_RESULT_LIMIT, 'mcp',
            { category: category as KnowledgeCategory, status: status as KnowledgeStatus, tags },
            vector,
          )
          : null;
        const items = layeredResult
          ? layeredResult.items
          : await queryKnowledgeForAgentExplained(projectId!, queryOptions);
```

and replace the `skippedNamespaces` block with the value the reader now reports:

```ts
        // Reported by the reader rather than inferred here: it is the only code that knows which
        // namespaces it actually reached.
        let skippedNamespaces: string[] = layeredResult ? layeredResult.skipped : [];
        if (!layered && projectRoot) {
          try {
            skippedNamespaces = configuredNamespaces(projectRoot, config ?? undefined)
              .filter(descriptor => descriptor.namespace !== 'project')
              .map(descriptor => descriptor.namespace);
          } catch {
            // A misconfigured optional namespace must not fail an otherwise good query.
          }
        }
```

- [ ] **Step 4: Run, expect pass**

Run: `npx vitest run tests/store/ tests/mcp/`
Expected: PASS. Existing MCP query tests exercise the layered path for the first time; if any assert on lexical-only ordering, fix the assertion, not the reader.

- [ ] **Step 5: Commit**

```bash
git add src/mcp/tools.ts tests/store/layered-vector.test.ts
git commit -m "feat(mcp): the layered read runs under vector search, so linked namespaces are read"
```

---

### Task 5: Linking a project to global

**Files:**
- Modify: `src/core/config.ts`
- Modify: `src/cli/program.ts`
- Test: `tests/cli/global-link.test.ts`

**Interfaces:**
- Produces: `setGlobalNamespace(root: string, enabled: boolean): Promise<void>` — writes `memory.global = { enabled, path: globalStorePath() }`, creating the store when enabling.
- Produces CLI: `knowl link global` and `knowl link global --off`.

- [ ] **Step 1: Write the failing test**

`tests/cli/global-link.test.ts`:

```ts
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, loadConfig, saveConfig } from '../../src/core/config.js';
import { setGlobalNamespace } from '../../src/core/config.js';
import { globalStorePath } from '../../src/core/paths.js';
import { configuredNamespaces } from '../../src/store/namespaces.js';

const HOME = path.join(os.tmpdir(), 'knowl-link-home');
const PROJECT = path.join(os.tmpdir(), 'knowl-link-project');

describe('linking a project to the global store', () => {
  const saved = process.env.KNOWL_HOME;
  beforeEach(async () => {
    process.env.KNOWL_HOME = HOME;
    for (const dir of [HOME, PROJECT]) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    await fs.mkdir(path.join(PROJECT, '.knowl'), { recursive: true });
    await saveConfig(PROJECT, { ...DEFAULT_CONFIG });
  });
  afterEach(async () => {
    for (const dir of [HOME, PROJECT]) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    if (saved === undefined) delete process.env.KNOWL_HOME; else process.env.KNOWL_HOME = saved;
  });

  it('adds the namespace on link and removes it on unlink', async () => {
    expect(configuredNamespaces(PROJECT, await loadConfig(PROJECT)).map(d => d.namespace)).not.toContain('global');

    await setGlobalNamespace(PROJECT, true);
    const linked = await loadConfig(PROJECT);
    expect(linked.memory?.global).toEqual({ enabled: true, path: globalStorePath() });
    expect(configuredNamespaces(PROJECT, linked).map(d => d.namespace)).toContain('global');
    // Linking creates the store, so the very next query has something to read.
    await expect(fs.access(globalStorePath())).resolves.toBeUndefined();

    await setGlobalNamespace(PROJECT, false);
    const unlinked = await loadConfig(PROJECT);
    expect(unlinked.memory?.global?.enabled).toBe(false);
    expect(configuredNamespaces(PROJECT, unlinked).map(d => d.namespace)).not.toContain('global');
    // Unlinking is reversible and never destroys the store.
    await expect(fs.access(globalStorePath())).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run, expect failure**

Run: `npx vitest run tests/cli/global-link.test.ts`
Expected: FAIL — `setGlobalNamespace` is not exported.

- [ ] **Step 3: Implement the config helper**

In `src/core/config.ts`:

```ts
/**
 * Link this project to the machine's global store, or unlink it.
 *
 * Per project on purpose. A machine-wide "every project sees global" default would make one
 * careless write visible everywhere, which is the contamination the governing decision rejected
 * when it turned down a single merged cross-project pool.
 *
 * Unlinking sets `enabled: false` rather than deleting the key, and never touches the store: the
 * decision is meant to be reversible, and a store deleted by a config change would not be.
 */
export async function setGlobalNamespace(root: string, enabled: boolean): Promise<void> {
  const { globalStorePath } = await import('./paths.js');
  if (enabled) {
    const { ensureGlobalStore } = await import('../store/global-store.js');
    await ensureGlobalStore();
  }
  const config = await loadConfig(root);
  await saveConfig(root, {
    ...config,
    memory: { ...config.memory, global: { enabled, path: globalStorePath() } },
  });
}
```

- [ ] **Step 4: Add the CLI command**

In `src/cli/program.ts`, beside the other top-level commands:

```ts
const linkCommand = program
  .command('link')
  .description('Link this project to a shared memory layer');

linkCommand
  .command('global')
  .description('Read and write the machine-wide personal-defaults store from this project')
  .option('--off', 'Unlink; the store itself is left alone')
  .action(async (options: { off?: boolean }) => {
    try {
      const root = await findProjectRoot(process.cwd());
      await setGlobalNamespace(root, !options.off);
      const { globalStorePath } = await import('../core/paths.js');
      console.log(options.off
        ? `Unlinked from ${globalStorePath()}. The store was not changed.`
        : `Linked to ${globalStorePath()}. Project knowledge still answers first.`);
    } catch (error: any) {
      console.error(`Error: ${error.message}`);
      process.exit(1);
    }
  });
```

- [ ] **Step 5: Run, expect pass**

Run: `npx vitest run tests/cli/global-link.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/core/config.ts src/cli/program.ts tests/cli/global-link.test.ts
git commit -m "feat(cli): knowl link global, reversibly"
```

---

### Task 6: Writing to the global namespace

**Files:**
- Modify: `src/cli/program.ts` (the `store` command, line ~2492)
- Test: `tests/cli/global-link.test.ts` (extend)

**Interfaces:**
- Produces CLI: `knowl store <content> --namespace global`, defaulting to `project`.
- Rule: with `--namespace global`, every `--path` must be absolute, and the result says the paths are not indexed.

- [ ] **Step 1: Write the failing test**

Append to `tests/cli/global-link.test.ts`:

```ts
import { assertGlobalWrite } from '../../src/store/global-store.js';

describe('writing to the global namespace', () => {
  it('demands absolute paths and says they are not indexed', () => {
    // A relative path in a store that spans repositories names nothing.
    expect(() => assertGlobalWrite(['src/auth.ts'])).toThrow(/absolute/i);
    expect(assertGlobalWrite([path.join(PROJECT, 'src/auth.ts')])).toMatch(/not indexed/i);
    expect(assertGlobalWrite([])).toMatch(/not indexed/i);
  });
});
```

- [ ] **Step 2: Run, expect failure**

Run: `npx vitest run tests/cli/global-link.test.ts`
Expected: FAIL — `assertGlobalWrite` is not exported.

- [ ] **Step 3: Implement the rule**

In `src/store/global-store.ts`:

```ts
/**
 * Check the paths on a global write, and return the note the caller prints.
 *
 * Two rules, both about honesty. A relative path in a store that spans repositories names
 * nothing, so it is refused. And nothing in `src/session/` reads the namespace query -- impact
 * detection, drift and evidence staleness are all project-store only -- so a path here is
 * provenance for a reader, never an index entry, and the write says so. A path that looks wired
 * up and is not is worse than no path at all.
 */
export function assertGlobalWrite(paths: string[]): string {
  const relative = paths.filter(entry => !path.isAbsolute(entry));
  if (relative.length > 0) {
    throw new Error(
      `Paths on a global atom must be absolute; the global store spans repositories, so `
      + `"${relative[0]}" names nothing. Use the full path, or store this in the project it belongs to.`,
    );
  }
  return 'Stored in the global namespace. Any paths are recorded for reference and are not indexed: '
    + 'impact detection and drift read the project store only.';
}
```

- [ ] **Step 4: Wire the CLI option**

Add to the `store` command:

```ts
  .option('--namespace <namespace>', 'project (default) or global', 'project')
```

and in its action, before writing:

```ts
      if (options.namespace === 'global') {
        const { assertGlobalWrite, ensureGlobalStore } = await import('../store/global-store.js');
        const note = assertGlobalWrite(options.path ?? []);
        const { path: storePath } = await ensureGlobalStore();
        const { withDbPath } = await import('../store/database.js');
        // The namespace named is the namespace written. No fallback: naming global and getting
        // the project store is the contamination this layer exists to avoid.
        await withDbPath(storePath, async () => { /* existing write call, unchanged */ });
        console.log(note);
        return;
      }
```

- [ ] **Step 5: Run, expect pass**

Run: `npx vitest run tests/cli/global-link.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/store/global-store.ts src/cli/program.ts tests/cli/global-link.test.ts
git commit -m "feat(cli): knowl store --namespace global, with absolute paths"
```

---

### Task 7: Setup outside a repository

**Files:**
- Modify: `src/cli/program.ts` (the `init` command)
- Modify: `src/cli/agents/*` as needed for `--host-only`
- Test: `tests/cli/global-link.test.ts` (extend)

**Interfaces:**
- Produces CLI: `knowl init` runnable outside a repository, offering **Project** or **Global**; `--global` and `--host-only` skip the prompt.

- [ ] **Step 1: Write the failing test**

```ts
describe('setup outside a repository', () => {
  it('creates only the global store under --global', async () => {
    const { runGlobalInit } = await import('../../src/cli/global-init.js');
    const result = await runGlobalInit();
    expect(result.created).toBe(true);
    await expect(fs.access(globalStorePath())).resolves.toBeUndefined();
    // No project was made anywhere.
    await expect(fs.access(path.join(HOME, '.knowl'))).rejects.toThrow();
    expect((await runGlobalInit()).created).toBe(false);
  });
});
```

- [ ] **Step 2: Run, expect failure**

Run: `npx vitest run tests/cli/global-link.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`src/cli/global-init.ts`:

```ts
import { ensureGlobalStore } from '../store/global-store.js';

/** `knowl init --global`: the machine-wide store, and nothing about any checkout. */
export async function runGlobalInit(): Promise<{ path: string; created: boolean }> {
  return ensureGlobalStore();
}
```

In the `init` command: add `--global` and `--host-only`; when the cwd is not a project and neither flag is given, prompt with the two options (reuse the existing `@clack/prompts` picker), preselecting **Project** inside a repository. `--host-only` configures the named host integrations and returns before any store work — which is what a machine-global host such as Hermes actually needs.

- [ ] **Step 4: Run, expect pass**

Run: `npx vitest run tests/cli/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cli/ tests/cli/global-link.test.ts
git commit -m "feat(cli): knowl init runs outside a repository, for the global store and hosts"
```

---

### Task 8: Documentation

**Files:**
- Modify: `docs/reference.md`, `README.md`, `CHANGELOG.md`

- [ ] **Step 1: Reference**

Document, under memory: the four namespaces and their precedence; `~/.knowl/global.db`; `knowl link global [--off]`; `knowl store --namespace global` and the absolute-path rule; that a session with no project resolves to global alone; and that impact, drift and evidence stay project-only.

- [ ] **Step 2: Changelog**

Recreate `## Unreleased` if the last release consumed it, then describe the layer, being explicit that the layered read previously never ran under vector search.

- [ ] **Step 3: Verify and commit**

```bash
npm run docs:check
git add docs/ README.md CHANGELOG.md
git commit -m "docs: the global memory layer"
```

---

### Task 9: Full verification

- [ ] **Step 1:** `npm run build` — exit 0
- [ ] **Step 2:** `npm test` — all green. Expect churn in MCP query tests: the layered path now runs where it never did.
- [ ] **Step 3:** `npx eslint .` — clean
- [ ] **Step 4:** `npm run docs:check` — regions current
- [ ] **Step 5:** Manual: in a repo, `knowl link global`; `knowl store "I prefer pnpm" --title "Package manager" --category constraint --namespace global`; query from that repo and see it labelled `global` behind the project's own answers; `cd` somewhere with no project and query again.
- [ ] **Step 6:** Open the PR.
