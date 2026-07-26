# Workspace Prerequisites Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the nine correctness preconditions that multi-repo workspaces depend on, each shippable on its own as a fix to current behavior.

**Architecture:** No workspace feature is built here. Every task closes a defect that exists today in the single-repo product and that a shared database would turn from "latent" into "data loss". Tasks 1–4 make retrieval and storage honest about scope; tasks 5–7 make the database addressable and versioned; tasks 8–9 add the two columns that ownership and visibility will hang from. The columns stay NULL/`'repo'` and inert until the v1 plan uses them.

**Tech Stack:** TypeScript (ESM, NodeNext), libSQL (`@libsql/client`) with Drizzle ORM, vitest, tsup, commander. MCP via `@modelcontextprotocol/sdk`.

**Source spec:** `docs/superpowers/specs/2026-07-26-multi-repo-workspace-design.md`, "Prerequisites" section (P1–P9).

## Global Constraints

- Windows dev machine. Use `npm.cmd` for every npm invocation. Prefer `rg` for search.
- Test command is `npm.cmd test` (`vitest run`). A single file: `npx.cmd vitest run tests/path/file.test.ts`.
- Build is `npm.cmd run build` (tsup, ESM only, emits `.d.ts`).
- All relative imports carry the `.js` extension, including from `.ts` sources. NodeNext resolution.
- Typecheck currently reports **15 pre-existing errors**. Do not fix unrelated ones; do not add new ones. Verify with `npx.cmd tsc --noEmit` and compare the count.
- `knowl_store`, `knowl_decide`, `knowl_ingest_atoms`, `knowl_query`, `knowl_state`, and `knowl_update` must stay usable with no AI provider or API key configured.
- Never store secrets in test fixtures. `validateKnowledgeWrite` rejects content matching `password`, `api_key`, `token`, `secret`, `private_key`, `credential`, `db_password`.
- Test databases go in a repo-root scratch directory named `./.knowl-<feature>-test`, created in `beforeAll` and removed in `afterAll`, following `tests/store/supersede-on-write.test.ts`.
- Every task ends with a commit. Conventional commit prefixes: `fix:`, `feat:`, `refactor:`, `test:`.
- Behavior for a project with **no workspace configured** must be unchanged by every task in this plan. That is the acceptance bar, and Task 9 adds an explicit regression test for it.

## File Structure

| File | Responsibility | Tasks |
| --- | --- | --- |
| `src/store/storage-roles.ts` | **New.** `resolveStorage(root, config)` — the single place that decides which database file serves which role | 5 |
| `src/store/connection-pool.ts` | **New.** Connection cache keyed by resolved path, plus read-only opens that suppress bootstrap | 6 |
| `src/store/schema-version.ts` | **New.** `PRAGMA user_version` read/write and the refuse-to-open guard | 7 |
| `src/store/embedding-identity.ts` | **New.** Resolve and compare the `(provider, model, dtype)` triple a database is embedded with | 1 |
| `src/store/database.ts` | Loses its role as path authority; gains an explicit config root and read-only support | 5, 6, 7 |
| `src/store/namespaces.ts` | Loses the config-free default argument; gains parameter parity | 2, 5 |
| `src/store/write-embedding.ts` | Stops deriving its config root from `getProjectRoot()` | 3 |
| `src/store/repository.ts` | `listKnowledgeItems` stops accepting a scope it ignores | 4 |
| `src/store/snapshots.ts` | Stops deriving the database path itself | 5 |
| `src/store/bootstrap.ts` | Additive columns for ownership and visibility; version stamping | 7, 8, 9 |
| `src/core/token-budget.ts` | `CompactKnowledgeItem` gains the fields provenance needs | 8 |
| `src/mcp/tools.ts` | Query path uses layered retrieval once parity exists | 2 |

Tasks 1–4 are independent of each other and of 5–7. Task 8 depends on nothing. Task 9 depends on Task 7 (version stamping) only.

---

### Task 1: Pin an embedding identity per database

**Why first:** `fc6171e` disclosed that vector search cannot span namespaces because `searchKnowledgeEmbeddings` filters on provider and model, and cosine similarity across differing dimensions is meaningless. Task 2 removes that disclosure. It cannot until a caller can ask "are these two databases embedded compatibly?"

**Files:**
- Create: `src/store/embedding-identity.ts`
- Test: `tests/store/embedding-identity.test.ts`

**Interfaces:**
- Consumes: `getVectorSearchConfig`, `isVectorSearchEnabled` from `src/ai/embeddings.js`; `ProjectConfig` from `src/core/types.js`
- Produces:
  - `type EmbeddingIdentity = { provider: string; model: string; dtype: string }`
  - `embeddingIdentityFromConfig(config: ProjectConfig): EmbeddingIdentity | null` — `null` when vector search is disabled
  - `sameEmbeddingIdentity(a: EmbeddingIdentity | null, b: EmbeddingIdentity | null): boolean`
  - `formatEmbeddingIdentity(identity: EmbeddingIdentity | null): string`

- [ ] **Step 1: Write the failing test**

Create `tests/store/embedding-identity.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import {
  embeddingIdentityFromConfig,
  sameEmbeddingIdentity,
  formatEmbeddingIdentity,
} from '../../src/store/embedding-identity.js';
import type { ProjectConfig } from '../../src/core/types.js';

const withVector = (overrides: Record<string, unknown> = {}): ProjectConfig => ({
  version: 1,
  search: { vector: { enabled: true, provider: 'local', model: 'Xenova/all-MiniLM-L6-v2', dtype: 'q8', ...overrides } },
} as unknown as ProjectConfig);

describe('embedding identity', () => {
  it('reads the provider, model and dtype triple from config', () => {
    expect(embeddingIdentityFromConfig(withVector())).toEqual({
      provider: 'local',
      model: 'Xenova/all-MiniLM-L6-v2',
      dtype: 'q8',
    });
  });

  it('is null when vector search is disabled', () => {
    expect(embeddingIdentityFromConfig(withVector({ enabled: false }))).toBeNull();
  });

  it('treats a different model as a different identity', () => {
    const a = embeddingIdentityFromConfig(withVector());
    const b = embeddingIdentityFromConfig(withVector({ model: 'Xenova/bge-small-en' }));
    expect(sameEmbeddingIdentity(a, b)).toBe(false);
  });

  it('treats a different dtype as a different identity, since it changes the vector', () => {
    const a = embeddingIdentityFromConfig(withVector());
    const b = embeddingIdentityFromConfig(withVector({ dtype: 'fp32' }));
    expect(sameEmbeddingIdentity(a, b)).toBe(false);
  });

  it('matches an identical triple', () => {
    expect(sameEmbeddingIdentity(embeddingIdentityFromConfig(withVector()), embeddingIdentityFromConfig(withVector()))).toBe(true);
  });

  it('treats two disabled configs as compatible, since neither writes vectors', () => {
    const off = embeddingIdentityFromConfig(withVector({ enabled: false }));
    expect(sameEmbeddingIdentity(off, off)).toBe(true);
  });

  it('treats enabled against disabled as incompatible', () => {
    expect(sameEmbeddingIdentity(embeddingIdentityFromConfig(withVector()), null)).toBe(false);
  });

  it('formats a null identity as a readable phrase rather than "null"', () => {
    expect(formatEmbeddingIdentity(null)).toBe('vector search disabled');
    expect(formatEmbeddingIdentity({ provider: 'local', model: 'm', dtype: 'q8' })).toBe('local/m (q8)');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx.cmd vitest run tests/store/embedding-identity.test.ts`
Expected: FAIL — `Failed to resolve import "../../src/store/embedding-identity.js"`

- [ ] **Step 3: Write minimal implementation**

Create `src/store/embedding-identity.ts`:

```typescript
import type { ProjectConfig } from '../core/types.js';

/**
 * The triple that decides whether two sets of stored vectors are comparable.
 *
 * `searchKnowledgeEmbeddings` filters on provider and model because cosine similarity
 * between vectors of different dimensions is meaningless, and dtype belongs here for the
 * same reason: quantization changes the vector, so a q8 corpus and an fp32 corpus are not
 * one searchable space even under the same model name.
 */
export type EmbeddingIdentity = { provider: string; model: string; dtype: string };

/** Null means vector search is off, which is a valid state, not an error. */
export function embeddingIdentityFromConfig(config: ProjectConfig): EmbeddingIdentity | null {
  const vector = config?.search?.vector;
  if (!vector?.enabled) return null;
  return {
    provider: vector.provider ?? 'local',
    model: vector.model ?? '',
    dtype: vector.dtype ?? 'q8',
  };
}

export function sameEmbeddingIdentity(a: EmbeddingIdentity | null, b: EmbeddingIdentity | null): boolean {
  if (a === null && b === null) return true;
  if (a === null || b === null) return false;
  return a.provider === b.provider && a.model === b.model && a.dtype === b.dtype;
}

export function formatEmbeddingIdentity(identity: EmbeddingIdentity | null): string {
  return identity ? `${identity.provider}/${identity.model} (${identity.dtype})` : 'vector search disabled';
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx.cmd vitest run tests/store/embedding-identity.test.ts`
Expected: PASS, 8 tests

- [ ] **Step 5: Run the full suite and typecheck**

Run: `npm.cmd test`
Expected: all pass, count ≥ 436 (the suite total after `fc6171e`)

Run: `npx.cmd tsc --noEmit`
Expected: 15 errors, none in `src/store/embedding-identity.ts`

- [ ] **Step 6: Commit**

```bash
git add src/store/embedding-identity.ts tests/store/embedding-identity.test.ts
git commit -m "feat: describe the embedding identity a database is written with

searchKnowledgeEmbeddings filters on provider and model because cosine
similarity across differing dimensions is meaningless. Nothing could ask
whether two databases were embedded compatibly, so fc6171e had to disclose
the narrowed scope rather than span namespaces. This is the missing predicate.

dtype is part of the identity: quantization changes the vector, so a q8 corpus
and an fp32 corpus are not one searchable space under the same model name."
```

---

### Task 2: Give layered retrieval parameter parity

**Files:**
- Modify: `src/store/namespaces.ts:46-70`
- Test: `tests/store/namespaces.test.ts` (existing file, add cases)

**Interfaces:**
- Consumes: `queryKnowledgeForAgent` from `src/store/agent-query.js`
- Produces: `queryLayeredKnowledge(root, query, descriptors, limit, surface, filters?)` where
  `filters?: { category?: KnowledgeCategory; status?: KnowledgeStatus; tags?: string[] }`

**Context the implementer needs:** `queryLayeredKnowledge` currently passes only `{ query, limit, surface }` to each namespace. `knowl_query` accepts `category`, `status`, and `tags`. Today this is masked because the layered branch is bypassed whenever vector search is on — which is the default — so the dropped filters are invisible. Task 3 of the **v1 plan** removes that bypass; if parity does not land first, enabling it silently ignores `status: 'archived'` and every category filter.

- [ ] **Step 1: Write the failing test**

Append to `tests/store/namespaces.test.ts`, inside the existing top-level `describe`:

```typescript
  it('applies category, status and tag filters to every namespace it queries', async () => {
    const root = path.resolve('./.knowl-namespace-parity-test');
    await fs.rm(root, { recursive: true, force: true });
    await fs.mkdir(path.join(root, '.knowl'), { recursive: true });
    await initDb(root);
    const projectId = (await repo.createProject(root, 'parity')).id;

    await storeKnowledgeItemDeduped(projectId, {
      category: 'decision', title: 'Ranking uses reciprocal rank fusion',
      content: 'Fuse candidate lists by reciprocal rank rather than raw score.', tags: ['ranking'],
    });
    await storeKnowledgeItemDeduped(projectId, {
      category: 'fact', title: 'Ranking benchmark fixture count',
      content: 'The ranking benchmark fixture holds forty two labelled queries.', tags: ['ranking'],
    });

    const decisions = await queryLayeredKnowledge(
      root, 'ranking', defaultNamespaces(root), 5, 'test', { category: 'decision' },
    );
    expect(decisions.length).toBeGreaterThan(0);
    expect(decisions.every(item => item.category === 'decision')).toBe(true);

    const unfiltered = await queryLayeredKnowledge(root, 'ranking', defaultNamespaces(root), 5, 'test');
    expect(unfiltered.some(item => item.category === 'fact')).toBe(true);

    await closeDb();
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  });
```

Add any missing imports at the top of the file: `storeKnowledgeItemDeduped` from `../../src/store/knowledge-writer.js`, `repo` as `import * as repo from '../../src/store/repository.js'`, and `initDb`/`closeDb` from `../../src/store/database.js`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx.cmd vitest run tests/store/namespaces.test.ts`
Expected: FAIL — the filtered call returns items with `category: 'fact'`, because the filter is never forwarded

- [ ] **Step 3: Write minimal implementation**

In `src/store/namespaces.ts`, replace the `queryLayeredKnowledge` signature and its inner call:

```typescript
export type LayeredFilters = {
  category?: KnowledgeCategory;
  status?: KnowledgeStatus;
  tags?: string[];
};

export async function queryLayeredKnowledge(
  root: string,
  query: string,
  descriptors: NamespaceDescriptor[],
  limit = 3,
  surface = 'namespace_query',
  filters: LayeredFilters = {},
): Promise<NamespacedKnowledgeItem[]> {
  const results: NamespacedKnowledgeItem[] = [];
  const seen = new Set<string>();
  for (const descriptor of namespacePrecedence(descriptors)) {
    try {
      const items = await withNamespaceDatabase(descriptor, () => queryKnowledgeForAgent('local', {
        query,
        limit,
        surface,
        category: filters.category,
        status: filters.status,
        tags: filters.tags,
      }));
      for (const item of items) {
        const key = item.contentHash ?? `${item.title}\n${item.content}`;
        if (!seen.has(key)) {
          seen.add(key);
          results.push({ ...item, namespace: descriptor.namespace });
        }
      }
    } catch (error) {
      if (!descriptor.optional) throw error;
    }
  }
  return results.slice(0, limit);
}
```

Add `KnowledgeCategory` and `KnowledgeStatus` to the existing type import from `../core/types.js`.

Note the `descriptors` parameter has **lost its default value**. That is deliberate and is Task 5's concern; for now, fix the one call site the compiler flags in `src/store/context-composer.ts:19` by passing `defaultNamespaces(request.namespaceRoot)` explicitly.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx.cmd vitest run tests/store/namespaces.test.ts`
Expected: PASS

- [ ] **Step 5: Run the full suite and typecheck**

Run: `npm.cmd test`
Expected: all pass

Run: `npx.cmd tsc --noEmit`
Expected: 15 errors, none in `src/store/namespaces.ts` or `src/store/context-composer.ts`

- [ ] **Step 6: Commit**

```bash
git add src/store/namespaces.ts src/store/context-composer.ts tests/store/namespaces.test.ts
git commit -m "fix: layered retrieval silently dropped category, status and tag filters

queryLayeredKnowledge forwarded only query, limit and surface, so an agent
asking for archived items or a specific category got neither. It is invisible
today because vector search is on by default and bypasses the layered branch
entirely -- but that bypass is what a multi-repo read path has to remove, and
removing it first would have activated a path that ignores its own filters.

Also removes the descriptors default argument. A config-free default meant
context composition and MCP query could read different namespace sets, and the
one caller relying on it now passes its descriptors explicitly."
```

---

### Task 3: Embeddings follow the database, not the process

**Files:**
- Modify: `src/store/database.ts:25-55` (thread a config root through), `src/store/write-embedding.ts:26-58`
- Test: `tests/store/write-embedding-root.test.ts`

**Interfaces:**
- Consumes: `initDbPath`, `getProjectRoot` from `src/store/database.js`
- Produces: `getConfigRoot(): string` on `database.ts` — the directory whose `.knowl/config.json` and `.knowl/models` govern the currently open database, which is **not** always `dirname(dirname(dbPath))`

**Context the implementer needs:** `resolveEmbedder` calls `getProjectRoot()`, then `loadConfig(root)` and reads the model cache at `<root>/.knowl/models`. `initDbPath` defaults `projectRoot` to `dirname(dirname(dbPath))`, which is only correct for the `<root>/.knowl/x.db` layout. Open a database anywhere else — which every namespace and every future workspace does — and `loadConfig` throws, the `catch` returns `null`, and the write is stored **with no embedding and no error**. Under vector-first ranking (`agent-query.ts:17-18`, `VECTOR_PRIMARY_WEIGHT = 1`) such an item cannot compete.

- [ ] **Step 1: Write the failing test**

Create `tests/store/write-embedding-root.test.ts`:

```typescript
import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, getConfigRoot, initDb, initDbPath } from '../../src/store/database.js';

const ROOT = path.resolve('./.knowl-embedding-root-test');
const ELSEWHERE = path.join(ROOT, 'not-a-project-layout');

describe('config root travels with the connection', () => {
  beforeAll(async () => {
    await fs.rm(ROOT, { recursive: true, force: true });
    await fs.mkdir(path.join(ROOT, '.knowl'), { recursive: true });
    await fs.mkdir(ELSEWHERE, { recursive: true });
  });
  afterAll(async () => { await closeDb(); await fs.rm(ROOT, { recursive: true, force: true }).catch(() => {}); });

  it('uses the project root for a normal project database', async () => {
    await initDb(ROOT);
    expect(getConfigRoot()).toBe(path.resolve(ROOT));
    await closeDb();
  });

  it('uses an explicitly supplied config root for a database outside the .knowl layout', async () => {
    await initDbPath(path.join(ELSEWHERE, 'shared.db'), { configRoot: ROOT });
    expect(getConfigRoot()).toBe(path.resolve(ROOT));
    await closeDb();
  });

  it('does not silently invent a config root from the database path', async () => {
    await initDbPath(path.join(ELSEWHERE, 'shared.db'), { configRoot: ROOT });
    expect(getConfigRoot()).not.toBe(path.resolve(ELSEWHERE));
    expect(getConfigRoot()).not.toBe(path.dirname(path.resolve(ELSEWHERE)));
    await closeDb();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx.cmd vitest run tests/store/write-embedding-root.test.ts`
Expected: FAIL — `getConfigRoot` is not exported, and `initDbPath` takes a positional `projectRoot`, not an options object

- [ ] **Step 3: Write minimal implementation**

In `src/store/database.ts`, add a module-level `configRootInstance`, change `initDbPath`'s second parameter to an options object, and export the accessor:

```typescript
let configRootInstance: string | null = null;

export type InitDbOptions = {
  /**
   * Directory whose `.knowl/config.json` and `.knowl/models` govern this connection.
   *
   * Deriving it from the database path only holds for the `<root>/.knowl/x.db` layout.
   * A namespace database elsewhere yielded a nonsense root, loadConfig threw, and the
   * embedding writer's catch turned that into a silent no-op -- storing items that
   * vector-first ranking can never surface.
   */
  configRoot?: string;
};

export async function initDbPath(dbPath: string, options: InitDbOptions = {}): Promise<LibSQLDatabase<typeof schema>> {
  const fileUrl = `file:${dbPath}`;
  const configRoot = options.configRoot ?? path.dirname(path.dirname(dbPath));

  try {
    const client = createClient({ url: fileUrl });
    clientInstance = client;
    await bootstrapSchema(client);
    dbInstance = drizzle(client, { schema });
    projectRootInstance = path.resolve(configRoot);
    configRootInstance = path.resolve(configRoot);
    databasePathInstance = path.resolve(dbPath);
    return dbInstance;
  } catch (error: any) {
    throw new DatabaseError(`Failed to initialize database at "${dbPath}": ${error.message}`);
  }
}

export function getConfigRoot(): string {
  if (!configRootInstance) {
    throw new DatabaseError('Config root has not been initialized. Run initDb() first.');
  }
  return configRootInstance;
}
```

Update `initDb` to pass the option:

```typescript
export async function initDb(projectRoot: string): Promise<LibSQLDatabase<typeof schema>> {
  const dbPath = path.join(projectRoot, '.knowl', 'knowl.db');
  return initDbPath(dbPath, { configRoot: projectRoot });
}
```

Update `withDbPath` to preserve and restore the config root:

```typescript
export async function withDbPath<T>(dbPath: string, run: () => Promise<T>): Promise<T> {
  const previousPath = databasePathInstance;
  const previousConfigRoot = configRootInstance;
  await closeDb();
  await initDbPath(dbPath, previousConfigRoot ? { configRoot: previousConfigRoot } : {});
  try {
    return await run();
  } finally {
    await closeDb();
    if (previousPath) await initDbPath(previousPath, previousConfigRoot ? { configRoot: previousConfigRoot } : {});
  }
}
```

Clear it in `closeDb` alongside the others: `configRootInstance = null;`

In `src/store/write-embedding.ts`, swap the accessor:

```typescript
import { getConfigRoot } from './database.js';
```

and inside `resolveEmbedder`, replace `root = getProjectRoot();` with `root = getConfigRoot();`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx.cmd vitest run tests/store/write-embedding-root.test.ts`
Expected: PASS, 3 tests

- [ ] **Step 5: Run the full suite and typecheck**

Run: `npm.cmd test`
Expected: all pass. If any test called `initDbPath(path, someRoot)` positionally, update it to `initDbPath(path, { configRoot: someRoot })`.

Run: `npx.cmd tsc --noEmit`
Expected: 15 errors, none in `src/store/database.ts` or `src/store/write-embedding.ts`

- [ ] **Step 6: Commit**

```bash
git add src/store/database.ts src/store/write-embedding.ts tests/store/write-embedding-root.test.ts
git commit -m "fix: writes outside the project layout were stored without embeddings

resolveEmbedder took its config root from getProjectRoot(), which initDbPath
derives as dirname(dirname(dbPath)). That is only right for <root>/.knowl/x.db.
Any database opened elsewhere produced a nonsense root, loadConfig threw, and
the best-effort catch swallowed it -- so the item was stored with no vector and
no error. Vector-first ranking then made it unretrievable.

The config root is now carried with the connection instead of inferred from
where the file happens to sit."
```

---

### Task 4: Stop `listKnowledgeItems` accepting a scope it ignores

**Files:**
- Modify: `src/store/repository.ts:336-350`, plus every call site
- Test: `tests/store/store.test.ts` (existing file, add one case)

**Interfaces:**
- Produces: `listKnowledgeItems(dbConnection?: DbConnection): Promise<KnowledgeItem[]>` — the `projectId` parameter is **removed**, not honored

**Context the implementer needs:** the function takes `projectId` and never uses it; `getProjectByRootPath` returns a synthetic `{ id: 'local' }` (`repository.ts:97-99`), so the argument carries no information. GC, synthesis, integrity, and export all call it and all appear scoped while scanning the whole table. Removing the parameter is the honest fix — a later plan adds real filtering, and it must not be confused with a parameter that already looks like filtering.

Find call sites with: `rg "listKnowledgeItems\(" src tests`

- [ ] **Step 1: Write the failing test**

Append to `tests/store/store.test.ts`, inside the existing top-level `describe`:

```typescript
  it('lists every item in the database, and does not pretend to scope', async () => {
    const all = await repo.listKnowledgeItems();
    expect(Array.isArray(all)).toBe(true);
    expect(repo.listKnowledgeItems.length).toBeLessThanOrEqual(1);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx.cmd vitest run tests/store/store.test.ts`
Expected: FAIL — TypeScript reports `Expected 1-2 arguments, but got 0`

- [ ] **Step 3: Write minimal implementation**

In `src/store/repository.ts`:

```typescript
/**
 * Every knowledge item in the currently open database.
 *
 * This deliberately takes no scope argument. It used to accept a projectId and ignore
 * it, which read as scoping at every call site -- GC, synthesis, integrity and export
 * all looked bounded while scanning the whole table. Real filtering belongs in the
 * caller until the schema can express it.
 */
export async function listKnowledgeItems(dbConnection?: DbConnection): Promise<KnowledgeItem[]> {
  const conn = dbConnection || getDb();
  try {
    const result = await conn.select().from(schema.knowledgeItems);
    return result.map(mapRowToKnowledgeItem);
  } catch (error: any) {
    throw new DatabaseError(`Failed to list knowledge items: ${error.message}`);
  }
}
```

Then update each call site found by the `rg` above, dropping the first argument. Expect them in `src/store/gc.ts`, `src/store/synthesis.ts`, `src/store/integrity.ts`, and `src/store/portability.ts`. In `gc.ts` the call is `repo.listKnowledgeItems(projectId, tx)` → `repo.listKnowledgeItems(tx)`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx.cmd vitest run tests/store/store.test.ts`
Expected: PASS

- [ ] **Step 5: Run the full suite and typecheck**

Run: `npm.cmd test`
Expected: all pass

Run: `npx.cmd tsc --noEmit`
Expected: 15 errors, none introduced by this change

- [ ] **Step 6: Commit**

```bash
git add src/store/repository.ts src/store/gc.ts src/store/synthesis.ts src/store/integrity.ts src/store/portability.ts tests/store/store.test.ts
git commit -m "refactor: drop the scope argument listKnowledgeItems never honored

It accepted a projectId and selected the whole table. getProjectByRootPath
returns a synthetic {id: 'local'}, so the argument carried no information --
but every call site read as though it were scoped, GC most consequentially.

Removing it is the honest state. Real filtering lands with the schema that can
express it, and must not be mistaken for a parameter that already looks like
filtering."
```

---

### Task 5: One resolver for storage roles

**Files:**
- Create: `src/store/storage-roles.ts`
- Modify: `src/store/namespaces.ts:12-13`, `src/store/snapshots.ts:16-18`
- Test: `tests/store/storage-roles.test.ts`

**Interfaces:**
- Consumes: `ProjectConfig` from `src/core/types.js`
- Produces:
  - `type StorageRole = 'local' | 'session' | 'knowledge'`
  - `type ResolvedStorage = { local: string; session: string; knowledge: string }`
  - `resolveStorage(root: string, config?: ProjectConfig): ResolvedStorage`

**Context the implementer needs:** the database path is derived independently in three places — `database.ts:21`, `namespaces.ts:12`, and `snapshots.ts:17`. Today they agree. The moment any of them can point somewhere else they must all consult one function, or `knowl_query` and `knowl_context` will read different files. This task introduces the resolver and routes the two easy call sites through it; `database.ts` keeps its own `path.join` for now because Task 6 restructures how it opens connections.

- [ ] **Step 1: Write the failing test**

Create `tests/store/storage-roles.test.ts`:

```typescript
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveStorage } from '../../src/store/storage-roles.js';
import { projectNamespace, sessionNamespace } from '../../src/store/namespaces.js';

const ROOT = path.resolve('./some-project');

describe('resolveStorage', () => {
  it('places every role under the project .knowl directory by default', () => {
    const storage = resolveStorage(ROOT);
    expect(storage.local).toBe(path.join(ROOT, '.knowl', 'knowl.db'));
    expect(storage.session).toBe(path.join(ROOT, '.knowl', 'session.db'));
    expect(storage.knowledge).toBe(path.join(ROOT, '.knowl', 'knowl.db'));
  });

  it('agrees with the namespace descriptors, so query and context cannot diverge', () => {
    const storage = resolveStorage(ROOT);
    expect(projectNamespace(ROOT).databasePath).toBe(storage.knowledge);
    expect(sessionNamespace(ROOT).databasePath).toBe(storage.session);
  });

  it('keeps the local role at the canonical path even when knowledge moves', () => {
    // Knowledge redirection arrives with workspaces; local must never follow it,
    // because the code index and host bindings live there.
    const storage = resolveStorage(ROOT);
    expect(storage.local).toBe(path.join(ROOT, '.knowl', 'knowl.db'));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx.cmd vitest run tests/store/storage-roles.test.ts`
Expected: FAIL — `Failed to resolve import "../../src/store/storage-roles.js"`

- [ ] **Step 3: Write minimal implementation**

Create `src/store/storage-roles.ts`:

```typescript
import path from 'node:path';
import type { ProjectConfig } from '../core/types.js';

/**
 * Which database file serves which purpose for a given project root.
 *
 * `local` is the code index, host session bindings, drift watermarks and caches. It is
 * anchored to the project and never redirected, whatever else changes.
 * `session` is the short-lived session namespace.
 * `knowledge` is knowledge_items and everything keyed to it, including access telemetry
 * -- telemetry has a same-database foreign key, so it cannot be separated from the items
 * it references.
 *
 * Today all three resolve inside the project. The value of naming them is that the path
 * is decided once: it was previously derived independently in database.ts, namespaces.ts
 * and snapshots.ts, so any divergence would have been silent.
 */
export type StorageRole = 'local' | 'session' | 'knowledge';

export type ResolvedStorage = {
  local: string;
  session: string;
  knowledge: string;
};

export function resolveStorage(root: string, _config?: ProjectConfig): ResolvedStorage {
  const knowlDir = path.join(root, '.knowl');
  return {
    local: path.join(knowlDir, 'knowl.db'),
    session: path.join(knowlDir, 'session.db'),
    knowledge: path.join(knowlDir, 'knowl.db'),
  };
}
```

In `src/store/namespaces.ts`, route the two descriptor builders through it:

```typescript
import { resolveStorage } from './storage-roles.js';

export function projectNamespace(root: string): NamespaceDescriptor {
  return { namespace: 'project', databasePath: resolveStorage(root).knowledge, precedence: RANK.project };
}
export function sessionNamespace(root: string): NamespaceDescriptor {
  return { namespace: 'session', databasePath: resolveStorage(root).session, precedence: RANK.session };
}
```

In `src/store/snapshots.ts`, replace the private helper's body:

```typescript
import { resolveStorage } from './storage-roles.js';

function databasePath(projectRoot: string): string {
  return path.resolve(resolveStorage(projectRoot).knowledge);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx.cmd vitest run tests/store/storage-roles.test.ts`
Expected: PASS, 3 tests

- [ ] **Step 5: Run the full suite and typecheck**

Run: `npm.cmd test`
Expected: all pass — this task is behavior-preserving by construction

Run: `npx.cmd tsc --noEmit`
Expected: 15 errors, none in the touched files

- [ ] **Step 6: Commit**

```bash
git add src/store/storage-roles.ts src/store/namespaces.ts src/store/snapshots.ts tests/store/storage-roles.test.ts
git commit -m "refactor: decide database paths in one place

The path was derived independently in database.ts, namespaces.ts and
snapshots.ts. They agree today, so this changes no behavior -- but they agree
by coincidence, and the first time one of them can point elsewhere the others
follow silently. knowl_query and knowl_context reading different files is not
a failure anything would report.

Names the three roles while it is here: local is anchored to the project and
never redirected, knowledge carries access telemetry with it because the
telemetry foreign key is same-database."
```

---

### Task 6: Connection cache and read-only opens

**Files:**
- Create: `src/store/connection-pool.ts`
- Modify: `src/store/database.ts` (use the pool in `initDbPath`/`closeDb`)
- Test: `tests/store/connection-pool.test.ts`

**Interfaces:**
- Consumes: `createClient` from `@libsql/client`; `bootstrapSchema` from `src/store/bootstrap.js`
- Produces:
  - `acquireClient(dbPath: string, options?: { readOnly?: boolean }): Promise<Client>`
  - `releaseAll(): Promise<void>`
  - `poolSize(): number`

**Context the implementer needs:** `withDbPath` closes and reopens the database twice per namespace query, and `bootstrapSchema` runs on **every** open — including `migrateLegacyProjectSchema`, which toggles `PRAGMA foreign_keys = OFF` and renames, copies and drops tables outside a transaction. Reading another database therefore migrates it. A read-only open that suppresses bootstrap is what makes reading someone else's database a safe operation, and the cache removes the open/close churn that made it expensive.

- [ ] **Step 1: Write the failing test**

Create `tests/store/connection-pool.test.ts`:

```typescript
import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { acquireClient, poolSize, releaseAll } from '../../src/store/connection-pool.js';

const ROOT = path.resolve('./.knowl-pool-test');
const DB = path.join(ROOT, 'a.db');
const OTHER = path.join(ROOT, 'b.db');

describe('connection pool', () => {
  beforeAll(async () => {
    await fs.rm(ROOT, { recursive: true, force: true });
    await fs.mkdir(ROOT, { recursive: true });
  });
  afterAll(async () => { await releaseAll(); await fs.rm(ROOT, { recursive: true, force: true }).catch(() => {}); });

  it('returns the same client for the same path', async () => {
    const first = await acquireClient(DB);
    const second = await acquireClient(DB);
    expect(second).toBe(first);
    expect(poolSize()).toBe(1);
  });

  it('keys on the resolved path, so two paths are two clients', async () => {
    await acquireClient(DB);
    await acquireClient(OTHER);
    expect(poolSize()).toBe(2);
  });

  it('bootstraps a writable open, so the schema exists', async () => {
    const client = await acquireClient(DB);
    const result = await client.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='knowledge_items'");
    expect(result.rows.length).toBe(1);
  });

  it('does not bootstrap a read-only open', async () => {
    const fresh = path.join(ROOT, 'read-only.db');
    const client = await acquireClient(fresh, { readOnly: true });
    const result = await client.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='knowledge_items'");
    expect(result.rows.length).toBe(0);
  });

  it('does not hand a writable client back for a read-only request, or the reverse', async () => {
    const shared = path.join(ROOT, 'mode.db');
    const writable = await acquireClient(shared);
    const readOnly = await acquireClient(shared, { readOnly: true });
    expect(readOnly).not.toBe(writable);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx.cmd vitest run tests/store/connection-pool.test.ts`
Expected: FAIL — `Failed to resolve import "../../src/store/connection-pool.js"`

- [ ] **Step 3: Write minimal implementation**

Create `src/store/connection-pool.ts`:

```typescript
import path from 'node:path';
import { createClient, Client } from '@libsql/client';
import { bootstrapSchema } from './bootstrap.js';

/**
 * Clients keyed by resolved path and open mode.
 *
 * Two problems this solves. First, withDbPath closed and reopened the database twice per
 * namespace query, which is pure overhead that grows with the number of namespaces.
 *
 * Second, and more important: bootstrapSchema runs on every open and includes
 * migrateLegacyProjectSchema, which toggles foreign keys off and renames, copies and drops
 * tables outside a transaction. Reading a database therefore migrated it. A read-only
 * acquire suppresses bootstrap entirely, which is what makes reading a database you do not
 * own a safe thing to do.
 *
 * The mode is part of the key. Handing a bootstrapped client back to a read-only caller
 * would defeat the guarantee, and handing an un-bootstrapped one to a writer would fail.
 */
const clients = new Map<string, Client>();

const keyFor = (dbPath: string, readOnly: boolean) =>
  `${readOnly ? 'ro' : 'rw'}:${path.resolve(dbPath)}`;

export async function acquireClient(dbPath: string, options: { readOnly?: boolean } = {}): Promise<Client> {
  const readOnly = options.readOnly === true;
  const key = keyFor(dbPath, readOnly);
  const existing = clients.get(key);
  if (existing) return existing;

  const client = createClient({ url: `file:${path.resolve(dbPath)}` });
  if (!readOnly) await bootstrapSchema(client);
  clients.set(key, client);
  return client;
}

export function poolSize(): number {
  return clients.size;
}

export async function releaseAll(): Promise<void> {
  for (const client of clients.values()) client.close();
  clients.clear();
}
```

In `src/store/database.ts`, use the pool inside `initDbPath` in place of the direct `createClient` + `bootstrapSchema` pair, and make `closeDb` release rather than close directly:

```typescript
import { acquireClient, releaseAll } from './connection-pool.js';

// inside initDbPath, replacing `const client = createClient(...)` and `await bootstrapSchema(client)`:
const client = await acquireClient(dbPath);
clientInstance = client;

// closeDb:
export async function closeDb(): Promise<void> {
  if (clientInstance) {
    await releaseAll();
    clientInstance = null;
    dbInstance = null;
    projectRootInstance = null;
    configRootInstance = null;
    databasePathInstance = null;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx.cmd vitest run tests/store/connection-pool.test.ts`
Expected: PASS, 5 tests

- [ ] **Step 5: Run the full suite and typecheck**

Run: `npm.cmd test`
Expected: all pass. Tests that delete a database directory in `afterAll` still work because `closeDb` releases every pooled client.

Run: `npx.cmd tsc --noEmit`
Expected: 15 errors, none in `src/store/connection-pool.ts` or `src/store/database.ts`

- [ ] **Step 6: Commit**

```bash
git add src/store/connection-pool.ts src/store/database.ts tests/store/connection-pool.test.ts
git commit -m "feat: pool connections and add a read-only open that skips bootstrap

bootstrapSchema runs on every open and includes migrateLegacyProjectSchema,
which toggles foreign keys off and renames, copies and drops tables outside a
transaction. So reading a database migrated it -- fine when you only ever open
your own, disqualifying for reading anyone else's.

A read-only acquire suppresses bootstrap, and the mode is part of the cache key
so a bootstrapped client is never handed to a read-only caller. The cache also
removes the close-and-reopen pair withDbPath performed on every namespace
query."
```

---

### Task 7: Schema version guard

**Files:**
- Create: `src/store/schema-version.ts`
- Modify: `src/store/bootstrap.ts:521-532` (stamp the version), `src/store/connection-pool.ts` (check before use)
- Test: `tests/store/schema-version.test.ts`

**Interfaces:**
- Consumes: `Client` from `@libsql/client`
- Produces:
  - `KNOWL_SCHEMA_VERSION: number` — currently `1`
  - `readSchemaVersion(client: Client): Promise<number>`
  - `stampSchemaVersion(client: Client): Promise<void>`
  - `assertSchemaSupported(client: Client, dbPath: string): Promise<void>` — throws `SchemaTooNewError`
  - `class SchemaTooNewError extends Error`

**Context the implementer needs:** there is no schema version marker anywhere in the tree — `rg "user_version|schema_version" src` returns nothing. Because the schema is built from `CREATE TABLE IF NOT EXISTS` plus additive `ALTER`s, an older client opening a newer database sees every table it expects, finds nothing missing, and proceeds. This must ship in a release **before** anything writes a database that two Knowl versions can reach, or the guard has nothing to guard.

- [ ] **Step 1: Write the failing test**

Create `tests/store/schema-version.test.ts`:

```typescript
import fs from 'node:fs/promises';
import path from 'node:path';
import { createClient } from '@libsql/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  KNOWL_SCHEMA_VERSION,
  SchemaTooNewError,
  assertSchemaSupported,
  readSchemaVersion,
  stampSchemaVersion,
} from '../../src/store/schema-version.js';
import { bootstrapSchema } from '../../src/store/bootstrap.js';

const ROOT = path.resolve('./.knowl-schema-version-test');

describe('schema version guard', () => {
  beforeAll(async () => {
    await fs.rm(ROOT, { recursive: true, force: true });
    await fs.mkdir(ROOT, { recursive: true });
  });
  afterAll(async () => { await fs.rm(ROOT, { recursive: true, force: true }).catch(() => {}); });

  it('reads zero from a database nothing has stamped', async () => {
    const client = createClient({ url: `file:${path.join(ROOT, 'blank.db')}` });
    expect(await readSchemaVersion(client)).toBe(0);
    client.close();
  });

  it('bootstrap stamps the current version', async () => {
    const client = createClient({ url: `file:${path.join(ROOT, 'stamped.db')}` });
    await bootstrapSchema(client);
    expect(await readSchemaVersion(client)).toBe(KNOWL_SCHEMA_VERSION);
    client.close();
  });

  it('accepts a database at or below the version this client understands', async () => {
    const client = createClient({ url: `file:${path.join(ROOT, 'current.db')}` });
    await bootstrapSchema(client);
    await expect(assertSchemaSupported(client, 'current.db')).resolves.toBeUndefined();
    client.close();
  });

  it('refuses a database written by a newer client', async () => {
    const dbPath = path.join(ROOT, 'future.db');
    const client = createClient({ url: `file:${dbPath}` });
    await bootstrapSchema(client);
    await client.execute(`PRAGMA user_version = ${KNOWL_SCHEMA_VERSION + 7}`);
    await expect(assertSchemaSupported(client, dbPath)).rejects.toThrow(SchemaTooNewError);
    client.close();
  });

  it('names the versions in the refusal, so the user knows to upgrade', async () => {
    const dbPath = path.join(ROOT, 'future-message.db');
    const client = createClient({ url: `file:${dbPath}` });
    await bootstrapSchema(client);
    await client.execute(`PRAGMA user_version = ${KNOWL_SCHEMA_VERSION + 1}`);
    await expect(assertSchemaSupported(client, dbPath)).rejects.toThrow(
      new RegExp(`${KNOWL_SCHEMA_VERSION + 1}.*${KNOWL_SCHEMA_VERSION}|${KNOWL_SCHEMA_VERSION}.*${KNOWL_SCHEMA_VERSION + 1}`),
    );
    client.close();
  });

  it('stamping is idempotent', async () => {
    const client = createClient({ url: `file:${path.join(ROOT, 'twice.db')}` });
    await stampSchemaVersion(client);
    await stampSchemaVersion(client);
    expect(await readSchemaVersion(client)).toBe(KNOWL_SCHEMA_VERSION);
    client.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx.cmd vitest run tests/store/schema-version.test.ts`
Expected: FAIL — `Failed to resolve import "../../src/store/schema-version.js"`

- [ ] **Step 3: Write minimal implementation**

Create `src/store/schema-version.ts`:

```typescript
import { Client } from '@libsql/client';

/**
 * Bump when a schema change makes a database unreadable by older clients.
 *
 * Additive columns do not need a bump -- an older client ignores them. A bump is for
 * changes that would make an older client corrupt or misread the data: a primary key
 * change, a table rebuild, or a column an older writer would leave NULL where a newer
 * reader requires it.
 */
export const KNOWL_SCHEMA_VERSION = 1;

export class SchemaTooNewError extends Error {
  constructor(dbPath: string, found: number, supported: number) {
    super(
      `The knowledge database at "${dbPath}" was written by a newer Knowl (schema ${found}); ` +
      `this build understands schema ${supported}. Upgrade Knowl to open it.`,
    );
    this.name = 'SchemaTooNewError';
  }
}

export async function readSchemaVersion(client: Client): Promise<number> {
  const result = await client.execute('PRAGMA user_version');
  return Number(result.rows[0]?.user_version ?? 0);
}

export async function stampSchemaVersion(client: Client): Promise<void> {
  // PRAGMA does not accept bound parameters, and the value is a module constant.
  await client.execute(`PRAGMA user_version = ${KNOWL_SCHEMA_VERSION}`);
}

/**
 * Refuse rather than proceed. The schema is built from CREATE TABLE IF NOT EXISTS plus
 * additive ALTERs, so an older client opening a newer database sees every table it expects
 * and finds nothing missing. Without this check it proceeds confidently and writes rows
 * that the newer schema's invariants do not hold for.
 */
export async function assertSchemaSupported(client: Client, dbPath: string): Promise<void> {
  const found = await readSchemaVersion(client);
  if (found > KNOWL_SCHEMA_VERSION) throw new SchemaTooNewError(dbPath, found, KNOWL_SCHEMA_VERSION);
}
```

In `src/store/bootstrap.ts`, import and stamp at the end of `bootstrapSchema`:

```typescript
import { assertSchemaSupported, stampSchemaVersion } from './schema-version.js';

export async function bootstrapSchema(client: Client): Promise<void> {
  await executeAll(client, BASE_STATEMENTS);
  await assertSchemaSupported(client, '(open database)');
  await migrateLegacyProjectSchema(client);
  await executeAll(client, SCHEMA_STATEMENTS);
  await ensureFreshnessColumns(client);
  await ensureConflictColumns(client);
  await ensureMemorySessionColumns(client);
  await ensureHostSessionBindingColumns(client);
  await ensureCodeIndexColumns(client);
  await backfillKnowledgeAssertions(client);
  await repairSkillForeignKeys(client);
  await stampSchemaVersion(client);
}
```

In `src/store/connection-pool.ts`, check read-only opens too — they skip bootstrap and so would skip the guard:

```typescript
import { assertSchemaSupported } from './schema-version.js';

// in acquireClient, after createClient:
  const client = createClient({ url: `file:${path.resolve(dbPath)}` });
  if (readOnly) await assertSchemaSupported(client, dbPath);
  else await bootstrapSchema(client);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx.cmd vitest run tests/store/schema-version.test.ts`
Expected: PASS, 6 tests

- [ ] **Step 5: Run the full suite and typecheck**

Run: `npm.cmd test`
Expected: all pass

Run: `npx.cmd tsc --noEmit`
Expected: 15 errors, none in the touched files

- [ ] **Step 6: Commit**

```bash
git add src/store/schema-version.ts src/store/bootstrap.ts src/store/connection-pool.ts tests/store/schema-version.test.ts
git commit -m "feat: refuse to open a database written by a newer Knowl

There was no schema version marker anywhere: rg user_version returned nothing.
Because the schema is CREATE TABLE IF NOT EXISTS plus additive ALTERs, an older
client opening a newer database sees every table it expects, finds nothing
missing, and proceeds -- writing rows the newer schema's invariants do not hold
for.

This has to ship before anything writes a database two Knowl versions can
reach, since a guard added afterwards has nothing to guard. Read-only opens are
checked explicitly: they skip bootstrap, and so would skip the guard with it."
```

---

### Task 8: Provenance survives compaction

**Files:**
- Modify: `src/core/token-budget.ts:11-13, 25-36`
- Test: `tests/core/token-budget.test.ts` (create if absent)

**Interfaces:**
- Produces: `CompactKnowledgeItem` gains optional `repo?: string` and `namespace?: string`; `compactKnowledgeItem(item, extras?: { repo?: string; namespace?: string })`

**Context the implementer needs:** `compactKnowledgeItem` is a hard allowlist. Every MCP query result passes through it (`response-format.ts:6`, `tools.ts:744`), and `queryLayeredKnowledge` already attaches a `namespace` label that is silently discarded there. Any per-item provenance that does not pass this boundary does not exist as far as an agent is concerned. Both fields stay absent unless supplied, so a single-repo project's payload is byte-identical.

- [ ] **Step 1: Write the failing test**

Create `tests/core/token-budget.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { compactKnowledgeItem } from '../../src/core/token-budget.js';
import type { KnowledgeItem } from '../../src/core/types.js';

const item = {
  id: 'abc123', category: 'decision', status: 'active',
  title: 'Ranking uses reciprocal rank fusion',
  content: 'Fuse candidate lists by reciprocal rank rather than raw score.',
  reasoning: null, alternatives: null, tags: ['ranking'], source: null, sourceCommit: null,
  affectedPaths: ['src/store/agent-query.ts'], contentHash: 'hash', freshness: 'fresh', confidence: 1,
  conflictKey: null, conflictScope: null, conflictExclusive: false, supersededById: null,
  version: 1, createdAt: '2026-07-26T00:00:00.000Z', updatedAt: '2026-07-26T00:00:00.000Z',
} as unknown as KnowledgeItem;

describe('compactKnowledgeItem', () => {
  it('omits provenance when none is supplied, so single-repo output is unchanged', () => {
    const compact = compactKnowledgeItem(item);
    expect('repo' in compact).toBe(false);
    expect('namespace' in compact).toBe(false);
  });

  it('carries the repo label through to the compact shape', () => {
    const compact = compactKnowledgeItem(item, { repo: 'server' });
    expect(compact.repo).toBe('server');
  });

  it('carries the namespace label, which layered queries already attach and lost here', () => {
    expect(compactKnowledgeItem(item, { namespace: 'organization' }).namespace).toBe('organization');
  });

  it('survives JSON serialization, which is the boundary that matters', () => {
    const serialized = JSON.parse(JSON.stringify(compactKnowledgeItem(item, { repo: 'server' })));
    expect(serialized.repo).toBe('server');
  });

  it('still truncates and still keeps the existing fields', () => {
    const compact = compactKnowledgeItem(item, { repo: 'server' });
    expect(compact.id).toBe('abc123');
    expect(compact.category).toBe('decision');
    expect(compact.freshness).toBe('fresh');
    expect(compact.tags).toEqual(['ranking']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx.cmd vitest run tests/core/token-budget.test.ts`
Expected: FAIL — `compactKnowledgeItem` takes one argument; `compact.repo` is a type error and `undefined` at runtime

- [ ] **Step 3: Write minimal implementation**

In `src/core/token-budget.ts`:

```typescript
export type CompactKnowledgeItem = Pick<KnowledgeItem, 'id' | 'category' | 'title' | 'content' | 'freshness' | 'confidence'> & {
  tags?: string[];
  /** Owning repo, when a workspace is active. Absent otherwise. */
  repo?: string;
  /** Namespace the item came from. queryLayeredKnowledge attaches this and it was dropped here. */
  namespace?: string;
};

/**
 * This is an allowlist, not a projection: a field absent here never reaches the agent, no
 * matter what upstream attaches. Provenance therefore has to be declared, and both fields
 * stay absent unless supplied so a single-repo payload is byte-identical to before.
 */
export function compactKnowledgeItem(
  item: KnowledgeItem,
  extras: { repo?: string; namespace?: string } = {},
): CompactKnowledgeItem {
  const tags = item.tags?.slice(0, MAX_TAGS).map(tag => truncateText(tag, MAX_TAG_CHARS));
  return {
    id: item.id,
    category: item.category as KnowledgeCategory,
    title: truncateText(item.title, MAX_ITEM_CONTENT_CHARS),
    content: truncateText(item.content, MAX_ITEM_CONTENT_CHARS),
    freshness: item.freshness as KnowledgeFreshness,
    confidence: item.confidence,
    ...(tags?.length ? { tags } : {}),
    ...(extras.repo ? { repo: extras.repo } : {}),
    ...(extras.namespace ? { namespace: extras.namespace } : {}),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx.cmd vitest run tests/core/token-budget.test.ts`
Expected: PASS, 5 tests

- [ ] **Step 5: Run the full suite and typecheck**

Run: `npm.cmd test`
Expected: all pass — the second parameter is optional, so no call site changes

Run: `npx.cmd tsc --noEmit`
Expected: 15 errors, none in `src/core/token-budget.ts`

- [ ] **Step 6: Commit**

```bash
git add src/core/token-budget.ts tests/core/token-budget.test.ts
git commit -m "feat: let provenance through the compaction boundary

compactKnowledgeItem is an allowlist, so a field absent from it never reaches
the agent regardless of what upstream attaches -- queryLayeredKnowledge has
been labelling results with their namespace and having it dropped here.

Declares repo and namespace as optional. Both stay absent unless supplied, so a
single-repo payload is byte-identical. Tested on the serialized output, since
that is the boundary that actually matters."
```

---

### Task 9: Ownership and visibility columns

**Files:**
- Modify: `src/store/schema.ts:3-23`, `src/store/bootstrap.ts` (new `ensureOwnershipColumns`)
- Test: `tests/store/ownership-columns.test.ts`

**Interfaces:**
- Produces: `knowledge_items.origin_repo TEXT` (nullable) and `knowledge_items.visibility TEXT NOT NULL DEFAULT 'repo'`; Drizzle fields `originRepo` and `visibility`

**Context the implementer needs:** these are the two fields ownership and visibility hang from. Nothing reads them yet — the v1 plan does. They land here because `bootstrapSchema` receives only a client and cannot know whether a workspace exists, so conditional creation is not expressible; the columns exist everywhere and stay inert. The acceptance bar is that a project with no workspace behaves identically, which this task's final test asserts directly.

- [ ] **Step 1: Write the failing test**

Create `tests/store/ownership-columns.test.ts`:

```typescript
import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, getClient, initDb } from '../../src/store/database.js';
import * as repo from '../../src/store/repository.js';
import { storeKnowledgeItemDeduped } from '../../src/store/knowledge-writer.js';

const ROOT = path.resolve('./.knowl-ownership-test');

describe('ownership and visibility columns', () => {
  let projectId = '';
  beforeAll(async () => {
    await fs.rm(ROOT, { recursive: true, force: true });
    await fs.mkdir(path.join(ROOT, '.knowl'), { recursive: true });
    await initDb(ROOT);
    projectId = (await repo.createProject(ROOT, 'ownership')).id;
  });
  afterAll(async () => { await closeDb(); await fs.rm(ROOT, { recursive: true, force: true }).catch(() => {}); });

  it('adds both columns to knowledge_items', async () => {
    const result = await getClient().execute('PRAGMA table_info(knowledge_items)');
    const columns = result.rows.map(row => String(row.name));
    expect(columns).toContain('origin_repo');
    expect(columns).toContain('visibility');
  });

  it('leaves a write with no owner and repo visibility outside a workspace', async () => {
    const stored = await storeKnowledgeItemDeduped(projectId, {
      category: 'fact', title: 'Bootstrap runs on every open',
      content: 'bootstrapSchema is invoked by initDbPath for each connection.',
    });
    const row = (await getClient().execute({
      sql: 'SELECT origin_repo, visibility FROM knowledge_items WHERE id = ?',
      args: [stored.item.id],
    })).rows[0];
    expect(row.origin_repo).toBeNull();
    expect(row.visibility).toBe('repo');
  });

  it('is idempotent across repeated bootstraps', async () => {
    await closeDb();
    await initDb(ROOT);
    const result = await getClient().execute('PRAGMA table_info(knowledge_items)');
    const visibility = result.rows.filter(row => String(row.name) === 'visibility');
    expect(visibility.length).toBe(1);
  });

  it('backfills visibility on rows that predate the column', async () => {
    const row = (await getClient().execute(
      "SELECT COUNT(*) AS n FROM knowledge_items WHERE visibility IS NULL OR visibility = ''",
    )).rows[0];
    expect(Number(row.n)).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx.cmd vitest run tests/store/ownership-columns.test.ts`
Expected: FAIL — `expect(columns).toContain('origin_repo')` fails; the column does not exist

- [ ] **Step 3: Write minimal implementation**

In `src/store/schema.ts`, add both fields to `knowledgeItems` after `contentHash`:

```typescript
  originRepo: text('origin_repo'),
  visibility: text('visibility').notNull().default('repo'),
```

In `src/store/bootstrap.ts`, add the migration function and call it from `bootstrapSchema`:

```typescript
/**
 * Ownership and visibility for multi-repo workspaces.
 *
 * Created unconditionally. bootstrapSchema receives only a client -- no root, no config --
 * so it cannot know whether a workspace exists, which makes conditional creation
 * inexpressible. Outside a workspace origin_repo stays NULL and visibility stays 'repo',
 * which is exactly today's behavior; the columns cost one page and keep a single code path.
 */
async function ensureOwnershipColumns(client: Client): Promise<void> {
  if (!(await tableExists(client, 'knowledge_items'))) return;
  const columns = await tableColumns(client, 'knowledge_items');
  if (!columns.includes('origin_repo')) {
    await client.execute('ALTER TABLE knowledge_items ADD COLUMN origin_repo TEXT;');
  }
  if (!columns.includes('visibility')) {
    await client.execute("ALTER TABLE knowledge_items ADD COLUMN visibility TEXT NOT NULL DEFAULT 'repo';");
  }
  // A row written before the column existed can hold NULL despite the NOT NULL default.
  await client.execute("UPDATE knowledge_items SET visibility = 'repo' WHERE visibility IS NULL OR visibility = '';");
  await client.execute('CREATE INDEX IF NOT EXISTS idx_knowledge_items_origin ON knowledge_items(origin_repo, visibility, status);');
}
```

Call it in `bootstrapSchema`, after `ensureConflictColumns(client)`:

```typescript
  await ensureOwnershipColumns(client);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx.cmd vitest run tests/store/ownership-columns.test.ts`
Expected: PASS, 4 tests

- [ ] **Step 5: Write the no-workspace regression test**

Append to `tests/store/ownership-columns.test.ts`:

```typescript
  it('returns the same results it would have before the columns existed', async () => {
    const { queryKnowledgeForAgent } = await import('../../src/store/agent-query.js');
    await storeKnowledgeItemDeduped(projectId, {
      category: 'decision', title: 'Connections are pooled by resolved path',
      content: 'Clients are cached per resolved path and open mode.',
    });
    const items = await queryKnowledgeForAgent('local', { query: 'connections pooled', limit: 3, surface: 'test' });
    expect(items.length).toBeGreaterThan(0);
    expect(items.every(item => (item as any).origin_repo === undefined)).toBe(true);
  });
```

- [ ] **Step 6: Run the full suite and typecheck**

Run: `npx.cmd vitest run tests/store/ownership-columns.test.ts`
Expected: PASS, 5 tests

Run: `npm.cmd test`
Expected: all pass

Run: `npx.cmd tsc --noEmit`
Expected: 15 errors, none in `src/store/schema.ts` or `src/store/bootstrap.ts`

- [ ] **Step 7: Build, to confirm the schema change emits cleanly**

Run: `npm.cmd run build`
Expected: tsup succeeds, `dist/index.js` and declarations emitted

- [ ] **Step 8: Commit**

```bash
git add src/store/schema.ts src/store/bootstrap.ts tests/store/ownership-columns.test.ts
git commit -m "feat: add origin_repo and visibility to knowledge items

The two fields multi-repo ownership and visibility hang from. Nothing reads
them yet.

Created unconditionally, because bootstrapSchema receives only a client -- no
root, no config -- so 'only when a workspace exists' is not expressible.
Outside a workspace origin_repo stays NULL and visibility stays 'repo', which
is today's behavior, and a regression test pins that. Rows written before the
column existed are backfilled, since a NOT NULL default does not apply
retroactively."
```

---

## What this plan does not cover

Deliberately out of scope, each needing its own plan once these land:

- **v1 federation** — the workspace manifest, repo names, two-sided membership, `knowl workspace` commands, read fan-out with rank fusion, `promote`, and the status/doctor/explain surfaces. Depends on Tasks 1–9.
- **v2 shared database** — the workspace database, `namespace: 'workspace'` writes with category routing, the advisory applies-to table, migration with a write fence and journalled activation, `lifecycle_hash`, and tombstone monotonicity.
- **Removing the `fc6171e` disclosure.** Task 1 supplies the predicate; actually spanning namespaces under vector search belongs to the v1 read path, where there is a second corpus to span to.
- **The FTS column addition.** The spec calls for `origin_repo` and `visibility` as `UNINDEXED` FTS columns, which needs a versioned drop, recreate and backfill — `CREATE VIRTUAL TABLE IF NOT EXISTS` ignores a changed declaration. It belongs with the v1 filtering that needs it, and Task 7's version guard is its precondition.
- **Clamping cross-repo duplicate resolution to `coexist`.** Needs `origin_repo` to be populated, which happens in v1.

## Self-review

**Spec coverage.** P1 → Task 1. P2 → Task 2. P3 → Task 5. P4 → Task 6. P5 → Task 8. P6 → Task 7. P7 → Task 3. P8 → Task 4. P9 → Task 9. All nine prerequisites have a task. The v1 and v2 sections are explicitly deferred above.

**Ordering.** Tasks 1–4 are mutually independent. Task 6 depends on Task 3 (`configRootInstance` exists before `closeDb` clears it). Task 7 depends on Task 6 (it modifies `acquireClient`). Task 5 is independent but should precede any v1 work. Tasks 8 and 9 are independent of everything.

**Type consistency.** `resolveStorage` returns `{ local, session, knowledge }` in Task 5 and is consumed with those names in `namespaces.ts` and `snapshots.ts`. `acquireClient(dbPath, { readOnly })` in Task 6 is called with that signature in Task 7. `compactKnowledgeItem(item, extras)` in Task 8 keeps its first parameter positional, so existing single-argument call sites compile unchanged. `initDbPath(dbPath, { configRoot })` in Task 3 changes an existing signature — Task 3 Step 5 calls out fixing positional call sites in tests.

**Known deviation.** Task 5 does not route `database.ts` through `resolveStorage`, because Task 6 restructures how that file opens connections and doing both at once would make either task's diff hard to review. `initDb` keeps its `path.join`, which resolves identically. A v1 task closes this once `knowledge` can point elsewhere.
