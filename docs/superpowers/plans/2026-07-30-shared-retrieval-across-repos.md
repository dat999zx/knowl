# Shared Retrieval Across Repos Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the local retrieval code runnable against a linked repo's database, so cross-repo search stops being a second implementation and cross-repo conflict detection becomes a small addition rather than a third one.

**Architecture:** Every read in the retrieval path currently reaches out for a process-wide database handle (`getDb()` / `getClient()`). This plan passes the handle in instead, as an optional trailing parameter that defaults to the current global — so omitting it changes nothing, and the existing suite is the regression test. `src/workspace/federated-query.ts` then deletes its parallel candidate scanner and calls the real ranker with a peer's read-only handle.

**Tech Stack:** TypeScript (ESM, NodeNext), libSQL + Drizzle, vitest, tsup.

**Why not inheritance:** local and peer must rank *identically* — any difference is the bug being fixed. Inheritance encodes "these behave differently"; passing the handle encodes "same code, different file", which is what is actually true. The one real difference, that a peer must be opened read-only, is a property of the connection rather than of the ranking logic.

## Global Constraints

- Windows dev machine. `npm.cmd`, `npx.cmd`. Grep tool rather than `rg`.
- Test `npm.cmd test`; build `npm.cmd run build`; typecheck baseline **15 pre-existing errors** — do not increase.
- Relative imports carry `.js`.
- **A peer's database is never written to.** `acquireClient(path, { readOnly: true })` sets `PRAGMA query_only = ON` and skips bootstrap; anything reachable from a peer handle must be read-only in fact, not by convention.
- **A peer's repo-private items must never enter this process.** The `visibility = 'workspace'` filter belongs in SQL, before any `LIMIT`.
- **The cross-repo eval baseline must not regress.** `docs/evals/cross-repo-baseline.json` records semantic MRR 1.0 / R@3 1.0 and positional MRR 0.833 / R@3 1.0, scored by `tests/workspace/cross-repo-eval.test.ts`. Task 5 is gated on it.
- A repo with no workspace behaves exactly as today. No task may change single-repo behaviour except Task 3, which fixes a filtering bug and says so.

## Background: what is duplicated today

`src/workspace/federated-query.ts` re-implements candidate selection and scoring because the ranker reads a global handle and pointing it at a peer would swap the caller's connection mid-query. The two have already drifted:

| | Local (`agent-query.ts`) | Peer (`federated-query.ts`) |
| --- | --- | --- |
| Candidate selection | FTS/BM25 + vector | raw `LIKE` scan + full vector scan |
| Scoring | cosine primary, BM25 bounded fallback | cosine, or `1/(RRF_K + position)` |
| Recency / confidence / freshness / exact-identifier boosts | yes | none |
| MMR diversity on the lexical path | yes | none |

There is already a scar from this shape: a second vector parser lived in `federated-query.ts`, and when local storage moved to a packed float32 BLOB every peer vector silently failed to parse. Peers still appeared through the lexical fallback, so nothing errored and cross-repo search just quietly got worse. The decoder is shared now (`federated-query.ts:141-152`); the rest is not.

`src/store/conflicts.ts:19,24` has the same shape, which is why cross-repo conflict detection would otherwise become the third parallel implementation.

## File Structure

| File | Responsibility | Tasks |
| --- | --- | --- |
| `src/store/store-handle.ts` | **New.** `StoreHandle`, `localStore()`, `openPeerStore()` | 1 |
| `src/store/search.ts` | FTS candidate selection; takes a handle; filters before capping | 2, 3 |
| `src/store/queries.ts` | `queryKnowledgeBase` takes a handle | 2 |
| `src/store/vector.ts` | Embedding search takes a handle; visibility filter in SQL | 2, 3 |
| `src/store/agent-query.ts` | `rankKnowledge` (pure, retargetable) split from telemetry | 4 |
| `src/workspace/federated-query.ts` | Deletes `peerCandidates`; calls the real ranker per peer | 5 |
| `src/store/conflicts.ts` | Conflict lookup takes a handle | 6 |
| `src/workspace/cross-repo-overlap.ts` | **New.** Reports peer conflicts and near-duplicates; never mutates | 6 |
| `src/store/knowledge-writer.ts` | Surfaces the cross-repo report on a write | 6 |

## Task order

```
1  store handle                    (no behaviour change)
2  thread the handle               (no behaviour change; needs 1)
3  filter before capping           (fixes a real bug; needs 2)
4  split ranking from telemetry    (no behaviour change; needs 2)
5  federated query uses the ranker (needs 3, 4; gated on the eval baseline)
6  cross-repo conflict reporting   (needs 1, 5)
```

Tasks 1–4 are behaviour-preserving groundwork and can be reviewed and merged without 5–6. Task 3 is the exception and is called out.

---

### Task 1: The store handle

**Files:**
- Create: `src/store/store-handle.ts`
- Test: `tests/store/store-handle.test.ts`

**Interfaces:**
- Produces: `type StoreHandle = { db: LibSQLDatabase<typeof schema>; client: Client }`
- Produces: `localStore(): StoreHandle`
- Produces: `openPeerStore(databasePath: string): Promise<StoreHandle>`

**Context the implementer needs:** the retrieval path uses two shapes of handle. `search.ts` and
`queries.ts` use the Drizzle instance (`getDb()`); `vector.ts` uses the raw libSQL client
(`getClient()`). A single parameter has to carry both, so `StoreHandle` is a pair rather than one
object.

`localStore()` must call `getDb()`/`getClient()` **lazily, inside the function**, not capture them
at module load. Both throw when no database is open, and every existing caller relies on that
happening at call time.

`drizzle(client, { schema })` is a thin wrapper over an existing client — no connection is opened by
it, so constructing one per peer per query is not a cost worth caching.

- [ ] **Step 1: Write the failing test**

Create `tests/store/store-handle.test.ts`:

```typescript
import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, getClient, getDb, initDb } from '../../src/store/database.js';
import { releaseAll } from '../../src/store/connection-pool.js';
import { localStore, openPeerStore } from '../../src/store/store-handle.js';
import { DEFAULT_CONFIG, saveConfig } from '../../src/core/config.js';

const ROOT = path.resolve('./.knowl-store-handle');
const PEER = path.resolve('./.knowl-store-handle-peer');

async function makeRepo(root: string) {
  await fs.mkdir(path.join(root, '.knowl'), { recursive: true });
  await saveConfig(root, { ...DEFAULT_CONFIG });
}

describe('store handle', () => {
  beforeEach(async () => {
    await closeDb();
    await releaseAll();
    for (const dir of [ROOT, PEER]) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    await makeRepo(ROOT);
    await makeRepo(PEER);
    // Give the peer a real database file with the full schema.
    await initDb(PEER);
    await closeDb();
  });

  afterEach(async () => {
    await closeDb();
    await releaseAll();
    for (const dir of [ROOT, PEER]) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  it('hands back the ambient database and client', async () => {
    await initDb(ROOT);
    const store = localStore();
    expect(store.client).toBe(getClient());
    expect(store.db).toBe(getDb());
  });

  it('throws when nothing is open, like the functions it wraps', async () => {
    expect(() => localStore()).toThrow(/not been initialized/i);
  });

  it('opens a peer read-only, so a write fails loudly instead of mutating it', async () => {
    await initDb(ROOT);
    const peer = await openPeerStore(path.join(PEER, '.knowl', 'knowl.db'));

    await expect(peer.client.execute(
      "INSERT INTO knowledge_items (id, category, status, title, content, confidence, version, created_at, updated_at) " +
      "VALUES ('x', 'fact', 'active', 't', 'c', 1.0, 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')",
    )).rejects.toThrow();
  });

  it('reads the peer, not the ambient database', async () => {
    await initDb(PEER);
    await getClient().execute(
      "INSERT INTO knowledge_items (id, category, status, title, content, confidence, version, created_at, updated_at) " +
      "VALUES ('peer-1', 'fact', 'active', 'Peer fact', 'Only in the peer.', 1.0, 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')",
    );
    await closeDb();

    await initDb(ROOT);
    const peer = await openPeerStore(path.join(PEER, '.knowl', 'knowl.db'));
    const mine = await getClient().execute('SELECT COUNT(*) AS n FROM knowledge_items');
    const theirs = await peer.client.execute('SELECT COUNT(*) AS n FROM knowledge_items');

    expect(Number(mine.rows[0].n)).toBe(0);
    expect(Number(theirs.rows[0].n)).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx.cmd vitest run tests/store/store-handle.test.ts`
Expected: FAIL — `Cannot find module '../../src/store/store-handle.js'`

- [ ] **Step 3: Write minimal implementation**

Create `src/store/store-handle.ts`:

```typescript
import { Client } from '@libsql/client';
import { drizzle, LibSQLDatabase } from 'drizzle-orm/libsql';
import * as schema from './schema.js';
import { getClient, getDb } from './database.js';
import { acquireClient } from './connection-pool.js';

/**
 * One database, in both the shapes the read path needs.
 *
 * `search.ts` and `queries.ts` use the Drizzle instance; `vector.ts` uses the raw client. A
 * single parameter has to carry both, or half the retrieval path stays pinned to the global.
 *
 * This exists so retrieval can run against a linked repo without swapping the caller's
 * connection. `src/workspace/federated-query.ts` previously re-implemented candidate selection
 * and scoring for exactly that reason, and the two drifted.
 */
export type StoreHandle = {
  db: LibSQLDatabase<typeof schema>;
  client: Client;
};

/**
 * The ambient database.
 *
 * Resolved on call, never captured at module load: `getDb`/`getClient` throw when nothing is
 * open, and every caller relies on that throw happening at call time.
 */
export function localStore(): StoreHandle {
  return { db: getDb(), client: getClient() };
}

/**
 * A linked repo's database, read-only.
 *
 * `query_only = ON` makes SQLite itself refuse every write this connection attempts, and the
 * read-only acquire skips bootstrap -- which would otherwise migrate a database this process
 * does not own. Both are properties of the connection rather than of the query, which is why
 * the ranking code needs no notion of "peer" at all.
 */
export async function openPeerStore(databasePath: string): Promise<StoreHandle> {
  const client = await acquireClient(databasePath, { readOnly: true });
  return { db: drizzle(client, { schema }), client };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx.cmd vitest run tests/store/store-handle.test.ts`
Expected: PASS, 4 tests

- [ ] **Step 5: Verify suite and typecheck**

Run: `npx.cmd vitest run` then `npx.cmd tsc --noEmit`
Expected: full suite green; exactly 15 typecheck errors

- [ ] **Step 6: Commit**

```bash
git add src/store/store-handle.ts tests/store/store-handle.test.ts
git commit -m "feat(store): add a store handle so reads can target another database

The retrieval path reaches for a process-wide handle, so pointing it at a
linked repo would swap the caller's connection mid-query. federated-query
re-implemented candidate selection and scoring for that reason, and the two
have drifted -- peers get no recency, confidence, freshness or category
boosts, and a raw LIKE scan instead of BM25.

A handle carries both shapes the read path needs: the Drizzle instance for
search and queries, the raw client for vector. Peer handles are read-only in
fact, not by convention -- query_only = ON, and no bootstrap, so reading a
database this process does not own cannot migrate it."
```

---

### Task 2: Thread the handle through the read path

**Files:**
- Modify: `src/store/search.ts:50-59`, `src/store/queries.ts:73-85`, `src/store/vector.ts:125-159`, `src/store/vector.ts:216-220`
- Test: `tests/store/retargetable-reads.test.ts`

**Interfaces:**
- Consumes: `StoreHandle`, `localStore`, `openPeerStore` from Task 1
- Produces: `searchKnowledgeItems(projectId, options, store?: StoreHandle)`
- Produces: `queryKnowledgeBase(projectId, options, store?: StoreHandle)`
- Produces: `searchKnowledgeEmbeddings(projectId, options, store?: StoreHandle)`
- Produces: `getEmbeddingsForItems(itemIds, store?: StoreHandle)`

**Context the implementer needs:** the parameter is **optional and trailing**, defaulting to
`localStore()`. A default parameter is evaluated at call time, not at definition, so an omitted
handle resolves exactly when `getDb()` does today — no call site changes, and the entire existing
suite is the regression test for this task.

Only these four functions are in the retrieval chain. `queries.ts` also has `getActiveKnowledgeByCategory`
(`:13`) and `getHierarchicalKnowledge` (`:38`) reading the global handle; **leave them alone**. They
are not on this path, and widening them now would be scope with no consumer.

`upsertKnowledgeEmbedding` (`vector.ts:97`) is a write and stays on the global handle. Peers are
never written to, so it has no reason to take one.

- [ ] **Step 1: Write the failing test**

Create `tests/store/retargetable-reads.test.ts`:

```typescript
import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, getClient, initDb } from '../../src/store/database.js';
import { releaseAll } from '../../src/store/connection-pool.js';
import * as repo from '../../src/store/repository.js';
import { storeKnowledgeItemDeduped } from '../../src/store/knowledge-writer.js';
import { searchKnowledgeItems } from '../../src/store/search.js';
import { queryKnowledgeBase } from '../../src/store/queries.js';
import { openPeerStore } from '../../src/store/store-handle.js';
import { DEFAULT_CONFIG, saveConfig } from '../../src/core/config.js';

const MINE = path.resolve('./.knowl-retarget-mine');
const THEIRS = path.resolve('./.knowl-retarget-theirs');
const peerDb = () => path.join(THEIRS, '.knowl', 'knowl.db');

async function makeRepo(root: string) {
  await fs.mkdir(path.join(root, '.knowl'), { recursive: true });
  await saveConfig(root, { ...DEFAULT_CONFIG });
}

async function seed(root: string, title: string, content: string) {
  await initDb(root);
  const projectId = (await repo.createProject(root, 'p')).id;
  await storeKnowledgeItemDeduped(projectId, { category: 'decision', title, content });
  await closeDb();
}

describe('reads can target another database', () => {
  beforeEach(async () => {
    await closeDb();
    await releaseAll();
    for (const dir of [MINE, THEIRS]) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    await makeRepo(MINE);
    await makeRepo(THEIRS);
    await seed(MINE, 'Local uses postgres', 'This repository stores data in postgres.');
    await seed(THEIRS, 'Peer uses cassandra', 'That repository stores data in cassandra.');
  });

  afterEach(async () => {
    await closeDb();
    await releaseAll();
    for (const dir of [MINE, THEIRS]) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  it('searches the ambient database when no handle is given', async () => {
    await initDb(MINE);
    try {
      const found = await searchKnowledgeItems('local', { query: 'postgres' });
      expect(found.map(item => item.title)).toEqual(['Local uses postgres']);
    } finally {
      await closeDb();
    }
  });

  it('searches the peer when its handle is given, without disturbing the ambient one', async () => {
    await initDb(MINE);
    try {
      const peer = await openPeerStore(peerDb());
      const theirs = await searchKnowledgeItems('local', { query: 'cassandra' }, peer);
      expect(theirs.map(item => item.title)).toEqual(['Peer uses cassandra']);

      // The caller's connection is untouched: the very next local read still works.
      const mine = await searchKnowledgeItems('local', { query: 'postgres' });
      expect(mine.map(item => item.title)).toEqual(['Local uses postgres']);
    } finally {
      await closeDb();
    }
  });

  it('runs queryKnowledgeBase against a peer', async () => {
    await initDb(MINE);
    try {
      const peer = await openPeerStore(peerDb());
      const found = await queryKnowledgeBase('local', { query: 'cassandra' }, peer);
      expect(found.map(item => item.title)).toEqual(['Peer uses cassandra']);
    } finally {
      await closeDb();
    }
  });

  it('leaves the peer database unchanged after being read', async () => {
    await initDb(MINE);
    try {
      const before = await fs.readFile(peerDb());
      const peer = await openPeerStore(peerDb());
      await queryKnowledgeBase('local', { query: 'cassandra' }, peer);
      await searchKnowledgeItems('local', { query: 'cassandra' }, peer);
      expect((await fs.readFile(peerDb())).equals(before)).toBe(true);
    } finally {
      await closeDb();
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx.cmd vitest run tests/store/retargetable-reads.test.ts`
Expected: FAIL — `searchKnowledgeItems` takes two arguments, so the peer handle is ignored and the
peer searches return the local item (or nothing).

- [ ] **Step 3: Write minimal implementation**

In `src/store/search.ts`, add the import and the parameter:

```typescript
import { localStore, type StoreHandle } from './store-handle.js';

export async function searchKnowledgeItems(
  projectId: string,
  options: {
    category?: KnowledgeCategory;
    status?: KnowledgeStatus;
    tags?: string[];
    query: string;
    limit?: number;
  },
  // Optional and trailing, so every existing call site is unchanged and the whole suite is
  // the regression test. Evaluated at call time, exactly like the getDb() it replaces.
  store: StoreHandle = localStore(),
): Promise<KnowledgeItem[]> {
  const db = store.db;
  // ...body unchanged...
}
```

Replace the `const db = getDb();` at `search.ts:59` with the line above, and drop the now-unused
`getDb` import if nothing else in the file uses it.

In `src/store/queries.ts`, do the same for `queryKnowledgeBase` only, and **pass the handle down**
to `searchKnowledgeItems`:

```typescript
export async function queryKnowledgeBase(
  projectId: string,
  options: { /* unchanged */ },
  store: StoreHandle = localStore(),
): Promise<KnowledgeItem[]> {
  const resultLimit = options.limit;
  const db = store.db;
  try {
    if (options.query) {
      const ftsResults = await searchKnowledgeItems(projectId, {
        category: options.category,
        status: options.status,
        tags: options.tags,
        query: options.query,
        limit: options.limit,
      }, store);
      // ...rest unchanged...
```

Leave `getActiveKnowledgeByCategory` and `getHierarchicalKnowledge` untouched.

In `src/store/vector.ts`, the same for the two read functions, replacing `getClient()` with
`store.client`:

```typescript
export async function searchKnowledgeEmbeddings(
  projectId: string,
  options: { /* unchanged */ },
  store: StoreHandle = localStore(),
): Promise<VectorSearchResult[]> {
```

```typescript
export async function getEmbeddingsForItems(
  itemIds: string[],
  store: StoreHandle = localStore(),
): Promise<Map<string, number[]>> {
```

`upsertKnowledgeEmbedding` keeps `getClient()`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx.cmd vitest run tests/store/retargetable-reads.test.ts`
Expected: PASS, 4 tests

- [ ] **Step 5: Verify suite and typecheck**

Run: `npx.cmd vitest run` then `npx.cmd tsc --noEmit`
Expected: full suite green — **this is the real check for this task.** Every existing caller omits
the new parameter, so any failure means the default is not equivalent to the old global read.
Typecheck: exactly 15 errors.

- [ ] **Step 6: Commit**

```bash
git add src/store/search.ts src/store/queries.ts src/store/vector.ts tests/store/retargetable-reads.test.ts
git commit -m "refactor(store): let the retrieval reads take a database handle

Four functions on the retrieval path read a process-wide handle:
searchKnowledgeItems, queryKnowledgeBase, searchKnowledgeEmbeddings and
getEmbeddingsForItems. Each now takes an optional trailing handle defaulting
to the ambient one, so no call site changes and the existing suite is the
regression test.

getActiveKnowledgeByCategory and getHierarchicalKnowledge are deliberately
left alone -- not on this path, no consumer. upsertKnowledgeEmbedding stays
on the global handle because peers are never written to."
```

---

### Task 3: Filter before capping

**Files:**
- Modify: `src/store/search.ts:59-72`, `src/store/vector.ts:139-160`
- Test: `tests/store/filter-before-cap.test.ts`

**Interfaces:**
- Consumes: everything from Task 2
- Produces: `searchKnowledgeItems` and `searchKnowledgeEmbeddings` both accept `visibility?: 'repo' | 'workspace'`

**Context the implementer needs: this task changes single-repo behaviour, deliberately, because
the current behaviour is a bug.**

`searchKnowledgeItems` applies `LIMIT` inside the FTS SQL and then filters by status in JavaScript
(`search.ts:63-72`). So a query whose top 20 lexical hits are all archived returns nothing, even
when an active match sits at rank 21. That is wrong today for one repo.

It becomes *load-bearing* for peers. A peer's repo-private items must never enter this process, so
`visibility = 'workspace'` cannot be a post-filter — a chatty peer would fill the candidate window
with private items, which would then be discarded, and the caller would get nothing rather than the
peer's shared knowledge.

The fix is to join `knowledge_items` inside the FTS query and filter there, above the `LIMIT`. FTS5
exposes `item_id`, so the join is direct. `tags` stays in JavaScript — it is a JSON array, not a
column — and that is acceptable because tags narrow an already-correct candidate set rather than
deciding whether a row may be seen at all.

`searchKnowledgeEmbeddings` already filters status, category, provider and model in SQL
(`vector.ts:139-160`); it needs `visibility` added to the same `where` array and nothing else.

- [ ] **Step 1: Write the failing test**

Create `tests/store/filter-before-cap.test.ts`:

```typescript
import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, getClient, initDb } from '../../src/store/database.js';
import { releaseAll } from '../../src/store/connection-pool.js';
import * as repo from '../../src/store/repository.js';
import { storeKnowledgeItemDeduped } from '../../src/store/knowledge-writer.js';
import { searchKnowledgeItems } from '../../src/store/search.js';
import { DEFAULT_CONFIG, saveConfig } from '../../src/core/config.js';

const ROOT = path.resolve('./.knowl-filter-cap');

describe('search filters before it caps', () => {
  beforeEach(async () => {
    await closeDb();
    await releaseAll();
    await fs.rm(ROOT, { recursive: true, force: true }).catch(() => {});
    await fs.mkdir(path.join(ROOT, '.knowl'), { recursive: true });
    await saveConfig(ROOT, { ...DEFAULT_CONFIG });

    await initDb(ROOT);
    const projectId = (await repo.createProject(ROOT, 'p')).id;
    // 25 archived matches, then one active one. The active item is well past any
    // reasonable candidate window.
    for (let index = 0; index < 25; index += 1) {
      const stored = await storeKnowledgeItemDeduped(projectId, {
        category: 'fact',
        title: `Retention policy note ${index}`,
        content: `Retention policy detail number ${index} for the archive.`,
      });
      await repo.updateKnowledgeItem(stored.item.id, { status: 'archived' });
    }
    await storeKnowledgeItemDeduped(projectId, {
      category: 'fact',
      title: 'Retention policy is ninety days',
      content: 'Retention policy keeps records for ninety days.',
    });
    await closeDb();
  });

  afterEach(async () => {
    await closeDb();
    await releaseAll();
    await fs.rm(ROOT, { recursive: true, force: true }).catch(() => {});
  });

  it('finds the one active match behind a wall of archived ones', async () => {
    // Cap-then-filter returns nothing here: the LIMIT is spent on archived rows and the
    // status filter then discards all of them.
    await initDb(ROOT);
    try {
      const found = await searchKnowledgeItems('local', { query: 'retention policy', limit: 5 });
      expect(found.map(item => item.title)).toContain('Retention policy is ninety days');
    } finally {
      await closeDb();
    }
  });

  it('returns only workspace-visible items when asked for them', async () => {
    await initDb(ROOT);
    try {
      const items = await getClient().execute(
        "SELECT id FROM knowledge_items WHERE status = 'active' LIMIT 1",
      );
      await getClient().execute({
        sql: "UPDATE knowledge_items SET visibility = 'workspace' WHERE id = ?",
        args: [String(items.rows[0].id)],
      });

      const shared = await searchKnowledgeItems('local', {
        query: 'retention policy', limit: 5, visibility: 'workspace',
      });
      expect(shared).toHaveLength(1);
      expect(shared[0].visibility).toBe('workspace');
    } finally {
      await closeDb();
    }
  });

  it('excludes private items even when they would fill the whole candidate window', async () => {
    // The peer case: 25 private items rank above the one shared item. A post-filter would
    // return nothing, which reads as "that repo knows nothing about this".
    await initDb(ROOT);
    try {
      await getClient().execute(
        "UPDATE knowledge_items SET status = 'active' WHERE status = 'archived'",
      );
      await getClient().execute(
        "UPDATE knowledge_items SET visibility = 'workspace' WHERE title = 'Retention policy is ninety days'",
      );

      const shared = await searchKnowledgeItems('local', {
        query: 'retention policy', limit: 3, visibility: 'workspace',
      });
      expect(shared.map(item => item.title)).toEqual(['Retention policy is ninety days']);
    } finally {
      await closeDb();
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx.cmd vitest run tests/store/filter-before-cap.test.ts`
Expected: FAIL — the first test returns an empty array (cap spent on archived rows), and the other
two fail because `visibility` is not an accepted option.

- [ ] **Step 3: Write minimal implementation**

In `src/store/search.ts`, add `visibility` to the options and move the filters into the SQL:

```typescript
export async function searchKnowledgeItems(
  projectId: string,
  options: {
    category?: KnowledgeCategory;
    status?: KnowledgeStatus;
    tags?: string[];
    query: string;
    limit?: number;
    /** Restricts to shared items. Required for peers: a private row must not be read at all. */
    visibility?: 'repo' | 'workspace';
  },
  store: StoreHandle = localStore(),
): Promise<KnowledgeItem[]> {
  const db = store.db;
  const ftsQuery = buildFtsQuery(options.query);
  if (!ftsQuery) return [];
  const status = options.status || 'active';

  // Joined and filtered above the LIMIT. Filtering afterwards spends the candidate window on
  // rows that can never be returned: a query whose top hits are all archived came back empty
  // even with an active match just past the cap. For a peer it is worse than empty -- a
  // private row would have to be read into this process before being discarded.
  const rows = await (db as any).all(sql`
    SELECT f.item_id AS itemId, bm25(knowledge_items_fts) AS score
    FROM knowledge_items_fts f
    JOIN knowledge_items i ON i.id = f.item_id
    WHERE knowledge_items_fts MATCH ${ftsQuery}
      AND i.status = ${status}
      ${options.category ? sql`AND i.category = ${options.category}` : sql``}
      ${options.visibility ? sql`AND i.visibility = ${options.visibility}` : sql``}
    ORDER BY score ASC
    LIMIT ${options.limit ?? 20}
  `) as { itemId: string; score: number }[];

  // ...existing row hydration, minus the status filter it no longer needs...
}
```

Keep the existing tag filtering in JavaScript, and keep whatever hydration follows; only the status
predicate is removed from it, because SQL now guarantees it.

In `src/store/vector.ts`, add the option and one clause to the existing `where` array:

```typescript
    if (options.visibility) {
      where.push('i.visibility = ?');
      args.push(options.visibility);
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx.cmd vitest run tests/store/filter-before-cap.test.ts`
Expected: PASS, 3 tests

- [ ] **Step 5: Verify suite and typecheck**

Run: `npx.cmd vitest run` then `npx.cmd tsc --noEmit`
Expected: full suite green; 15 typecheck errors. **If a retrieval test changes result order here,
stop and read it** — this task legitimately changes which candidates survive the cap, and a
changed ranking may be the fix working rather than a regression. Record which test changed and why
in the commit message.

- [ ] **Step 6: Commit**

```bash
git add src/store/search.ts src/store/vector.ts tests/store/filter-before-cap.test.ts
git commit -m "fix(search): filter inside the FTS query instead of after the cap

searchKnowledgeItems applied LIMIT in SQL and filtered status in JavaScript,
so a query whose top lexical hits were all archived returned nothing even
with an active match just past the cap. That is wrong for one repo today.

It is disqualifying for peers: repo-private rows must never be read into this
process, and a post-filter would spend the whole candidate window on them and
return nothing -- which reads as the peer knowing nothing about the subject.

Status, category and the new visibility predicate now sit in the FTS join,
above the LIMIT. Tags stay in JavaScript: a JSON array, and it narrows an
already-correct candidate set rather than deciding what may be seen."
```

---

### Task 4: Split ranking from telemetry

**Files:**
- Modify: `src/store/agent-query.ts:112-251`
- Test: `tests/store/rank-knowledge.test.ts`

**Interfaces:**
- Consumes: `StoreHandle` from Task 1, retargetable reads from Task 2
- Produces: `rankKnowledge(projectId, options, store?: StoreHandle): Promise<ExplainedKnowledgeItem[]>` — pure read, writes nothing
- `queryKnowledgeForAgent` and `queryKnowledgeForAgentExplained` keep their exact signatures and behaviour

**Context the implementer needs:** `queryKnowledgeForAgentExplained` ends by writing access
telemetry (`agent-query.ts:244-249`). That write is why the ranker cannot simply be pointed at a
peer:

- the peer handle is `query_only = ON`, so the write fails;
- and `knowledge_access` has a foreign key to `knowledge_items`, so recording a peer's item in the
  *local* database fails too — the row is not there.

Peer access telemetry therefore cannot be recorded at all under the current schema, and that is
correct rather than a gap: the reads belong to the querying repo, and the item belongs to another.

So the split is not a workaround. Ranking is a pure read that can run against any database;
recording that you used something is the caller's business and stays local.

`options` gains `visibility` so it can be passed to the two searches, from Task 3.

- [ ] **Step 1: Write the failing test**

Create `tests/store/rank-knowledge.test.ts`:

```typescript
import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, getClient, initDb } from '../../src/store/database.js';
import { releaseAll } from '../../src/store/connection-pool.js';
import * as repo from '../../src/store/repository.js';
import { storeKnowledgeItemDeduped } from '../../src/store/knowledge-writer.js';
import { rankKnowledge, queryKnowledgeForAgent } from '../../src/store/agent-query.js';
import { openPeerStore } from '../../src/store/store-handle.js';
import { DEFAULT_CONFIG, saveConfig } from '../../src/core/config.js';

const MINE = path.resolve('./.knowl-rank-mine');
const THEIRS = path.resolve('./.knowl-rank-theirs');
const peerDb = () => path.join(THEIRS, '.knowl', 'knowl.db');

async function makeRepo(root: string) {
  await fs.mkdir(path.join(root, '.knowl'), { recursive: true });
  await saveConfig(root, { ...DEFAULT_CONFIG });
}

async function accessCount(): Promise<number> {
  const rows = await getClient().execute('SELECT COUNT(*) AS n FROM knowledge_access');
  return Number(rows.rows[0].n);
}

describe('rankKnowledge', () => {
  beforeEach(async () => {
    await closeDb();
    await releaseAll();
    for (const dir of [MINE, THEIRS]) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    await makeRepo(MINE);
    await makeRepo(THEIRS);

    await initDb(MINE);
    const mine = (await repo.createProject(MINE, 'p')).id;
    await storeKnowledgeItemDeduped(mine, {
      category: 'decision', title: 'Local uses postgres', content: 'This repository stores data in postgres.',
    });
    await closeDb();

    await initDb(THEIRS);
    const theirs = (await repo.createProject(THEIRS, 'p')).id;
    const stored = await storeKnowledgeItemDeduped(theirs, {
      category: 'decision', title: 'Peer uses cassandra', content: 'That repository stores data in cassandra.',
    });
    await getClient().execute({
      sql: "UPDATE knowledge_items SET visibility = 'workspace' WHERE id = ?", args: [stored.item.id],
    });
    await closeDb();
  });

  afterEach(async () => {
    await closeDb();
    await releaseAll();
    for (const dir of [MINE, THEIRS]) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  it('records no access telemetry, so it can run on a read-only database', async () => {
    await initDb(MINE);
    try {
      const before = await accessCount();
      const ranked = await rankKnowledge('local', { query: 'postgres' });
      expect(ranked).not.toHaveLength(0);
      expect(await accessCount()).toBe(before);
    } finally {
      await closeDb();
    }
  });

  it('still records telemetry through the public entry point', async () => {
    await initDb(MINE);
    try {
      const before = await accessCount();
      await queryKnowledgeForAgent('local', { query: 'postgres' });
      expect(await accessCount()).toBeGreaterThan(before);
    } finally {
      await closeDb();
    }
  });

  it('ranks a peer database without writing to it', async () => {
    await initDb(MINE);
    try {
      const before = await fs.readFile(peerDb());
      const peer = await openPeerStore(peerDb());
      const ranked = await rankKnowledge('local', { query: 'cassandra', visibility: 'workspace' }, peer);

      expect(ranked.map(item => item.title)).toEqual(['Peer uses cassandra']);
      expect((await fs.readFile(peerDb())).equals(before)).toBe(true);
    } finally {
      await closeDb();
    }
  });

  it('gives peer items the same boosts local items get', async () => {
    // The drift this whole plan removes: the old peer scanner applied no recency,
    // confidence, freshness, category or exact-identifier boost at all.
    await initDb(MINE);
    try {
      const peer = await openPeerStore(peerDb());
      const [ranked] = await rankKnowledge('local', { query: 'cassandra', visibility: 'workspace' }, peer);
      expect(ranked.explanation.contributions).toHaveProperty('recency');
      expect(ranked.explanation.contributions).toHaveProperty('confidence');
      expect(ranked.explanation.contributions).toHaveProperty('freshness');
    } finally {
      await closeDb();
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx.cmd vitest run tests/store/rank-knowledge.test.ts`
Expected: FAIL — `rankKnowledge` is not exported from `agent-query.js`

- [ ] **Step 3: Write minimal implementation**

In `src/store/agent-query.ts`, rename `queryKnowledgeForAgentExplained` to `rankKnowledge`, give it
the handle and the `visibility` option, delete the telemetry block from its end, and pass the handle
to both searches:

```typescript
/**
 * Score and order candidates. Reads only.
 *
 * Split from `queryKnowledgeForAgentExplained` so it can run against any database. Recording
 * that an item was used cannot: a peer handle is read-only, and `knowledge_access` has a
 * foreign key to `knowledge_items`, so a peer's item cannot be recorded in the local database
 * either. Peer access telemetry is therefore not merely unimplemented -- it has nowhere
 * correct to go, and the reads belong to the querying repo regardless.
 */
export async function rankKnowledge(
  projectId: string,
  options: {
    category?: KnowledgeCategory;
    status?: KnowledgeStatus;
    tags?: string[];
    query?: string;
    surface?: string;
    limit?: number;
    visibility?: 'repo' | 'workspace';
    vector?: { enabled?: boolean; provider?: string; model?: string; embedding?: number[] };
  },
  store: StoreHandle = localStore(),
): Promise<ExplainedKnowledgeItem[]> {
  const limit = options.limit ?? DEFAULT_AGENT_QUERY_LIMIT;
  const { vector, ...textOptions } = options;
  const candidateLimit = Math.max(limit * 3, 10);
  const bm25Results = await queryKnowledgeBase(projectId, {
    ...textOptions,
    category: undefined,
    limit: candidateLimit,
  }, store);

  // ...body unchanged through the `items` mapping...

  return items;   // telemetry block removed
}
```

The vector branch passes the handle too:

```typescript
    const vectorResults = await searchKnowledgeEmbeddings(projectId, {
      vector: vector!.embedding!,
      category: undefined,
      status: options.status,
      tags: options.tags,
      visibility: options.visibility,
      provider: vector!.provider,
      model: vector!.model,
      limit: candidateLimit,
    }, store);
```

`queryKnowledgeBase` must forward `visibility` to `searchKnowledgeItems`; add it to the options it
passes through in Task 2's edit.

Then restore the public entry point as rank-plus-record:

```typescript
export async function queryKnowledgeForAgentExplained(
  projectId: string,
  options: { /* the same shape as before, unchanged for callers */ },
): Promise<ExplainedKnowledgeItem[]> {
  const items = await rankKnowledge(projectId, options);
  await Promise.all(items.map((item, index) => recordKnowledgeAccessBestEffort({
    itemId: item.id,
    query: options.query,
    surface: options.surface ?? 'agent_query',
    rank: index + 1,
  })));
  return items;
}
```

`queryKnowledgeForAgent` is unchanged — it already delegates.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx.cmd vitest run tests/store/rank-knowledge.test.ts`
Expected: PASS, 4 tests

- [ ] **Step 5: Verify suite and typecheck**

Run: `npx.cmd vitest run` then `npx.cmd tsc --noEmit`
Expected: full suite green; 15 typecheck errors

- [ ] **Step 6: Commit**

```bash
git add src/store/agent-query.ts tests/store/rank-knowledge.test.ts
git commit -m "refactor(store): separate ranking from access telemetry

Ranking is a pure read and can run against any database. Recording that an
item was used cannot: a peer handle is query_only, and knowledge_access has a
foreign key to knowledge_items, so a peer's item cannot be recorded locally
either. Peer telemetry has nowhere correct to go, and the reads belong to the
querying repo regardless -- so the split is the right shape, not a workaround.

rankKnowledge is the pure half. queryKnowledgeForAgentExplained keeps its
signature and becomes rank-plus-record, so no caller changes."
```

---

### Task 5: Federated query uses the real ranker

**Files:**
- Modify: `src/workspace/federated-query.ts` — delete `peerCandidates`, `toCandidate`, `queryTokens`, `ITEM_COLUMNS`
- Test: `tests/workspace/federated-query.test.ts` (existing, extend), `tests/workspace/cross-repo-eval.test.ts` (existing, must not regress)

**Interfaces:**
- Consumes: `rankKnowledge` (Task 4), `openPeerStore` (Task 1)
- Produces: `queryFederated` keeps its exact signature and return type

**Context the implementer needs:** this is the task the previous four exist for. About 100 lines of
parallel implementation are deleted and replaced with a call per peer.

**The fusion still needs the semantic/positional split.** Scores from different corpora are only
comparable when they are cosine, because cosine depends on the query and the item, not on the
corpus. A BM25-derived score does depend on the corpus and is not comparable across repos. The
existing `semantic` partition (`federated-query.ts:187-201`) handles this and must stay — but it is
now driven by the ranker's own output rather than by a locally computed flag:
`item.explanation.vectorRank !== undefined` means the item was scored semantically.

**Do not add weights or boosts in the fusion.** This repo justifies retrieval changes with a
checked-in ablation, and the existing rule — ties break toward the local repo, nothing else — is
what the baseline was measured against.

Two behaviour changes are expected and are the point:

1. Peer candidate selection becomes FTS rather than a `LIKE` scan.
2. Peer items receive the recency, confidence, freshness, category and exact-identifier boosts.

**The gate:** `tests/workspace/cross-repo-eval.test.ts` scores `docs/evals/cross-repo-suite.json`
against `docs/evals/cross-repo-baseline.json` — semantic MRR 1.0 / R@3 1.0, positional MRR 0.833 /
R@3 1.0. If either path drops, the task is not done. If either path *improves*, update the baseline
file in the same commit and say so in the message; an unexplained baseline edit is indistinguishable
from moving the goalposts.

- [ ] **Step 1: Write the failing test**

Add to `tests/workspace/federated-query.test.ts`:

```typescript
  it('gives a peer item the same explanation a local item gets', async () => {
    // The drift this replaces: the old peer scanner produced items with no explanation at
    // all, so peer results could not be compared to local ones on anything but position.
    const result = await queryFederated({
      workspace: active,
      localItems: [],
      query: 'wire format protobuf',
      limit: 3,
    });

    const peerItem = result.items.find(item => item.repo !== active.repo);
    expect(peerItem).toBeDefined();
    expect((peerItem as any).explanation?.contributions).toHaveProperty('recency');
  });

  it('never returns a peer item that is repo-private', async () => {
    // Enforced in SQL by the visibility filter, so a private row is not read into this
    // process at all -- not read and then dropped.
    const result = await queryFederated({
      workspace: active,
      localItems: [],
      query: 'private',
      limit: 10,
    });
    expect(result.items.every(item => item.repo === active.repo || item.visibility === 'workspace')).toBe(true);
  });
```

Reuse whatever `active` fixture the existing file already builds; do not construct a second one.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx.cmd vitest run tests/workspace/federated-query.test.ts`
Expected: FAIL on the explanation assertion — `peerCandidates` builds items by hand and attaches no
explanation.

- [ ] **Step 3: Write minimal implementation**

Delete `peerCandidates`, `toCandidate`, `queryTokens` and `ITEM_COLUMNS` from
`src/workspace/federated-query.ts`. Keep `parseVector` only if the vector map is still needed for
local scoring; otherwise delete it too.

Replace the peer loop body:

```typescript
  for (const peer of input.workspace.peers) {
    if (wanted && !wanted.has(peer.name)) continue;
    if (!peer.present) {
      skipped.push({ repo: peer.name, reason: 'absent' });
      continue;
    }
    try {
      const store = await openPeerStore(peer.databasePath);
      // The local ranker, pointed at the peer. Same selection, same scoring, same boosts --
      // there is no "peer ranking" any more, only ranking against a different file.
      const items = await rankKnowledge('local', {
        query: input.query,
        status: 'active',
        // Not a post-filter: the predicate is in the SQL, so a peer's private row is never
        // read into this process.
        visibility: 'workspace',
        limit: cap,
        vector: embedding
          ? { enabled: true, embedding, provider: input.provider, model: input.model }
          : undefined,
      }, store);

      items.forEach((item, index) => {
        // Cosine is comparable across corpora; a BM25-derived score is not, because it
        // depends on each corpus's term statistics. The partition keeps the two scales
        // apart, exactly as before -- only the flag now comes from the ranker itself.
        const semantic = item.explanation.vectorRank !== undefined;
        const score = semantic ? item.explanation.finalScore : 1 / (RRF_K + index + 1);
        ranked.push({ item: { ...item, repo: peer.name }, score, local: false, semantic });
      });
    } catch (error) {
      skipped.push({ repo: peer.name, reason: error instanceof SchemaTooNewError ? 'schema-too-new' : 'unreadable' });
    }
  }
```

Score local items the same way, by ranking them through the same function rather than accepting
pre-ranked `localItems`, **if** the caller can supply a handle; otherwise keep the existing
`localItems` path and apply the same `semantic`/`score` rule to it so both sides use one formula.

`queryFederated` gains optional `provider` and `model` inputs so the peer vector search filters on
the workspace's pinned embedding identity. `workspace add`/`join` guarantee every member shares it
(`assertSafeToLink`), so passing the local values is correct.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx.cmd vitest run tests/workspace/federated-query.test.ts`
Expected: PASS

- [ ] **Step 5: Verify the eval baseline, then the suite**

Run: `npx.cmd vitest run tests/workspace/cross-repo-eval.test.ts`
Expected: semantic MRR ≥ 1.0, R@3 ≥ 1.0; positional MRR ≥ 0.833, R@3 ≥ 1.0; forbidden 0 on both.

Then: `npx.cmd vitest run` and `npx.cmd tsc --noEmit`
Expected: full suite green; 15 typecheck errors.

- [ ] **Step 6: Commit**

```bash
git add src/workspace/federated-query.ts tests/workspace/federated-query.test.ts
git commit -m "refactor(workspace): rank peers with the local ranker

Deletes the parallel candidate scanner. Peers were selected with a raw LIKE
scan and scored by cosine or bare rank position, with none of the recency,
confidence, freshness, category or exact-identifier boosts local items get --
so a linked repo's results were ranked by an older, simpler set of rules than
your own, and every future ranking change would have had to be made twice.

Peer selection is now FTS and peer items carry a full explanation. The
semantic/positional partition stays, because a BM25-derived score depends on
its corpus and is not comparable across repos; it is now driven by the
ranker's own vectorRank rather than a locally recomputed flag.

Cross-repo eval unchanged: semantic MRR 1.0, positional MRR 0.833."
```

---

### Task 6: Report conflicts and duplicates across linked repos

**Files:**
- Modify: `src/store/conflicts.ts:15-25`, `src/store/knowledge-writer.ts:195-247`
- Create: `src/workspace/cross-repo-overlap.ts`
- Test: `tests/workspace/cross-repo-overlap.test.ts`

**Interfaces:**
- Consumes: `openPeerStore` (Task 1), `rankKnowledge` (Task 4), retargetable `checkKnowledgeConflict` (this task)
- Produces: `checkKnowledgeConflict(input, store?: StoreHandle)`
- Produces: `listActiveConflictKeys(store?: StoreHandle)`
- Produces: `findCrossRepoOverlap(input: { workspace: ActiveWorkspace; item: { category; title; content; reasoning?; tags?; conflictKey?; conflictScope?; conflictExclusive? } }): Promise<CrossRepoOverlap[]>`
- Produces: `type CrossRepoOverlap = { repo: string; id: string; title: string; kind: 'conflict' | 'duplicate' }`
- Produces: `StoreKnowledgeResult` gains `crossRepo?: CrossRepoOverlap[]`

**Context the implementer needs: this reports, it never mutates.** Two local mechanisms have a
cross-repo counterpart:

| Local | Cross-repo |
| --- | --- |
| `checkKnowledgeConflict` throws `KnowledgeConflictError` on an exclusive key collision | report it — the colliding item belongs to another repo and only that repo can retire it |
| `findLikelyDuplicateKnowledgeItem` may resolve to `supersede` | report it — never supersede a foreign item |

Refusing to mutate is not a limitation to work around. A write in repo A silently retiring repo B's
knowledge is the failure a single owner per item exists to prevent, and `assertOwnedItem`
(`src/mcp/tools.ts:972`) already enforces it on the update path.

**Cost control.** This runs on every write inside a workspace, so it must be cheap and it must never
fail a write. Peers are scanned only when a workspace is active; an unreadable peer is skipped, not
raised; and the whole thing is wrapped so a failure degrades to "no cross-repo report" rather than a
failed store. Outside a workspace it does nothing and costs one null check.

- [ ] **Step 1: Write the failing test**

Create `tests/workspace/cross-repo-overlap.test.ts`:

```typescript
import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, getClient, initDb } from '../../src/store/database.js';
import { releaseAll } from '../../src/store/connection-pool.js';
import * as repo from '../../src/store/repository.js';
import { storeKnowledgeItemDeduped } from '../../src/store/knowledge-writer.js';
import { createManifest, writeManifest } from '../../src/workspace/manifest.js';
import { workspaceManifestPath } from '../../src/workspace/paths.js';
import { joinWorkspace } from '../../src/workspace/membership.js';
import { promoteItems } from '../../src/workspace/promote.js';
import { resolveWorkspace } from '../../src/workspace/resolve.js';
import { findCrossRepoOverlap } from '../../src/workspace/cross-repo-overlap.js';
import { resetWriteOwnershipCache } from '../../src/store/write-ownership.js';
import { DEFAULT_CONFIG, saveConfig } from '../../src/core/config.js';

const HOME = path.resolve('./.knowl-overlap-home');
const API = path.resolve('./.knowl-overlap-api');
const WEB = path.resolve('./.knowl-overlap-web');

async function makeRepo(root: string) {
  await fs.mkdir(path.join(root, '.knowl'), { recursive: true });
  await saveConfig(root, { ...DEFAULT_CONFIG });
}

describe('cross-repo overlap', () => {
  beforeEach(async () => {
    process.env.KNOWL_HOME = HOME;
    await closeDb();
    await releaseAll();
    resetWriteOwnershipCache();
    for (const dir of [HOME, API, WEB]) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    await makeRepo(API);
    await makeRepo(WEB);
    await writeManifest(workspaceManifestPath('ws'), createManifest('ws', null));
    await joinWorkspace({ projectRoot: WEB, workspaceName: 'ws', repoName: 'web' });
    await joinWorkspace({ projectRoot: API, workspaceName: 'ws', repoName: 'api' });
    resetWriteOwnershipCache();

    // web records and shares a fact that api is about to record differently.
    await initDb(WEB);
    const webProject = (await repo.createProject(WEB, 'web')).id;
    const stored = await storeKnowledgeItemDeduped(webProject, {
      category: 'decision',
      title: 'Session store is redis',
      content: 'Sessions are kept in redis with a thirty minute expiry.',
    });
    await closeDb();
    await promoteItems({ projectRoot: WEB, repoName: 'web', ids: [stored.item.id], apply: true });
    resetWriteOwnershipCache();
  });

  afterEach(async () => {
    delete process.env.KNOWL_HOME;
    await closeDb();
    await releaseAll();
    resetWriteOwnershipCache();
    for (const dir of [HOME, API, WEB]) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  it('reports a shared peer item covering the same subject', async () => {
    await initDb(API);
    try {
      const workspace = (await resolveWorkspace(API))!;
      const overlap = await findCrossRepoOverlap({
        workspace,
        item: {
          category: 'decision',
          title: 'Session store is redis',
          content: 'Sessions live in redis and expire after thirty minutes.',
        },
      });

      expect(overlap).toHaveLength(1);
      expect(overlap[0]).toMatchObject({ repo: 'web', title: 'Session store is redis', kind: 'duplicate' });
    } finally {
      await closeDb();
    }
  });

  it('does not report a peer item the other repo kept private', async () => {
    await initDb(WEB);
    await getClient().execute("UPDATE knowledge_items SET visibility = 'repo'");
    await closeDb();

    await initDb(API);
    try {
      const workspace = (await resolveWorkspace(API))!;
      const overlap = await findCrossRepoOverlap({
        workspace,
        item: {
          category: 'decision',
          title: 'Session store is redis',
          content: 'Sessions live in redis and expire after thirty minutes.',
        },
      });
      expect(overlap).toEqual([]);
    } finally {
      await closeDb();
    }
  });

  it('reports an exclusive conflict key held by another repo', async () => {
    await initDb(WEB);
    await getClient().execute(
      "UPDATE knowledge_items SET conflict_key = 'session.store', conflict_exclusive = 1, visibility = 'workspace'",
    );
    await closeDb();

    await initDb(API);
    try {
      const workspace = (await resolveWorkspace(API))!;
      const overlap = await findCrossRepoOverlap({
        workspace,
        item: {
          category: 'decision',
          title: 'Session store is memcached',
          content: 'Sessions are kept in memcached.',
          conflictKey: 'session.store',
          conflictExclusive: true,
        },
      });

      expect(overlap.some(entry => entry.kind === 'conflict' && entry.repo === 'web')).toBe(true);
    } finally {
      await closeDb();
    }
  });

  it('returns nothing and costs nothing outside a workspace', async () => {
    await initDb(API);
    try {
      const overlap = await findCrossRepoOverlap({
        workspace: null as never,
        item: { category: 'fact', title: 'Anything', content: 'Any content at all.' },
      });
      expect(overlap).toEqual([]);
    } finally {
      await closeDb();
    }
  });

  it('never mutates a peer, and never throws when a peer is unreadable', async () => {
    await initDb(API);
    try {
      const workspace = (await resolveWorkspace(API))!;
      // Point the peer at a path that does not exist.
      const broken = { ...workspace, peers: workspace.peers.map(peer => ({ ...peer, databasePath: 'C:/nope/none.db' })) };
      await expect(findCrossRepoOverlap({
        workspace: broken,
        item: { category: 'fact', title: 'Anything', content: 'Any content at all.' },
      })).resolves.toEqual([]);
    } finally {
      await closeDb();
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx.cmd vitest run tests/workspace/cross-repo-overlap.test.ts`
Expected: FAIL — `Cannot find module '../../src/workspace/cross-repo-overlap.js'`

- [ ] **Step 3: Write minimal implementation**

First give `conflicts.ts` the handle, matching Task 2's pattern:

```typescript
import { localStore, type StoreHandle } from './store-handle.js';

export async function checkKnowledgeConflict(
  input: { conflictKey?: string | null; conflictScope?: Record<string, unknown> | null; conflictExclusive?: boolean },
  store: StoreHandle = localStore(),
) {
  if (!input.conflictExclusive || !input.conflictKey) return [];
  const key = normalizeConflictKey(input.conflictKey);
  const scope = normalizeConflictScope(input.conflictScope);
  const rows = await store.db.select().from(schema.knowledgeItems).where(and(
    eq(schema.knowledgeItems.status, 'active'),
    eq(schema.knowledgeItems.conflictExclusive, true),
    eq(schema.knowledgeItems.conflictKey, key),
    eq(schema.knowledgeItems.conflictScope, scope),
  ));
  return rows.map(mapRowToKnowledgeItem);
}

export async function listActiveConflictKeys(store: StoreHandle = localStore()) {
  const rows = await store.db.select().from(schema.knowledgeItems).where(and(
    eq(schema.knowledgeItems.status, 'active'),
    eq(schema.knowledgeItems.conflictExclusive, true),
  ));
  return rows.map(mapRowToKnowledgeItem);
}
```

Create `src/workspace/cross-repo-overlap.ts`:

```typescript
import { rankKnowledge } from '../store/agent-query.js';
import { checkKnowledgeConflict } from '../store/conflicts.js';
import { sameSubjectTitle } from '../store/knowledge-writer.js';
import { openPeerStore } from '../store/store-handle.js';
import type { ActiveWorkspace } from './resolve.js';

export type CrossRepoOverlap = {
  repo: string;
  id: string;
  title: string;
  kind: 'conflict' | 'duplicate';
};

const PEER_CANDIDATES = 3;

/**
 * What the linked repos already say about this subject.
 *
 * Reports only. The colliding item belongs to another repo, and only that repo can retire it --
 * a write here silently superseding it is the failure a single owner per item exists to
 * prevent, and `assertOwnedItem` already refuses it on the update path.
 *
 * Runs on every write inside a workspace, so it is bounded and never fatal: a handful of
 * candidates per peer, an unreadable peer skipped rather than raised, and any failure degrading
 * to "no report" rather than a failed store. Outside a workspace it costs one null check.
 */
export async function findCrossRepoOverlap(input: {
  workspace: ActiveWorkspace | null;
  item: {
    category: string;
    title: string;
    content: string;
    reasoning?: string | null;
    tags?: string[] | null;
    conflictKey?: string | null;
    conflictScope?: Record<string, unknown> | null;
    conflictExclusive?: boolean;
  };
}): Promise<CrossRepoOverlap[]> {
  const workspace = input.workspace;
  if (!workspace || workspace.peers.length === 0) return [];

  const query = [
    input.item.title,
    input.item.content,
    input.item.reasoning ?? '',
    ...(input.item.tags ?? []),
  ].join(' ');

  const found: CrossRepoOverlap[] = [];

  for (const peer of workspace.peers) {
    if (!peer.present) continue;
    try {
      const store = await openPeerStore(peer.databasePath);

      // An exclusive key held by another repo is a genuine contradiction, not a near miss.
      for (const conflict of await checkKnowledgeConflict(input.item, store)) {
        if (conflict.visibility !== 'workspace') continue;
        found.push({ repo: peer.name, id: conflict.id, title: conflict.title, kind: 'conflict' });
      }

      // Same ranker the local duplicate check uses, pointed at the peer.
      const candidates = await rankKnowledge('local', {
        query,
        status: 'active',
        visibility: 'workspace',
        limit: PEER_CANDIDATES,
      }, store);

      for (const candidate of candidates) {
        if (found.some(entry => entry.id === candidate.id)) continue;
        // The local matcher, reused rather than restated. Writing a second title comparison
        // here would be the exact duplication this plan exists to remove, and the two would
        // drift the moment either is tuned.
        if (!sameSubjectTitle(input.item, candidate)) continue;
        found.push({ repo: peer.name, id: candidate.id, title: candidate.title, kind: 'duplicate' });
      }
    } catch {
      // A peer that cannot be read must never fail the write it was consulted for.
    }
  }

  return found;
}
```

`sameSubjectTitle` is currently a module-private function in `src/store/knowledge-writer.ts:141`.
**Export it** and import it here. Do not copy it: it is a tuned matcher — its own comment cites
"Database is SQLite" against "Project database uses SQLite" — and a second copy would drift from the
local duplicate check it is supposed to agree with.

Exporting it creates an import from `workspace/` into `store/`, which the codebase already does
elsewhere (`workspace/promote.ts` imports from `store/repository.js`). It does not create a cycle:
`knowledge-writer` will import `cross-repo-overlap` lazily, inside the function, exactly as it
already does for `resolveWorkspace`.

Then surface it from the writer. In `src/store/knowledge-writer.ts`, first export the matcher and
add the one missing import — the file does not currently import `getConfigRoot`:

```typescript
import { getConfigRoot } from './database.js';
import type { CrossRepoOverlap } from '../workspace/cross-repo-overlap.js';

export function sameSubjectTitle(a: { title: string }, b: { title: string }): boolean {
```

The `CrossRepoOverlap` import is `import type`, so it is erased at build time and creates no runtime
cycle with the lazy `import()` below.

Then, inside `storeKnowledgeItemDeduped`, after the local `nearDuplicate` is resolved:

```typescript
  // Advisory and non-fatal. The workspace is resolved lazily so an unlinked project pays
  // nothing, matching how `resolveWritingRepo` handles the same question.
  let crossRepo: CrossRepoOverlap[] = [];
  try {
    const root = getConfigRoot();
    const { resolveWorkspace } = await import('../workspace/resolve.js');
    const { findCrossRepoOverlap } = await import('../workspace/cross-repo-overlap.js');
    crossRepo = await findCrossRepoOverlap({ workspace: await resolveWorkspace(root), item: input });
  } catch {
    crossRepo = [];
  }
```

and add `crossRepo: crossRepo.length ? crossRepo : undefined` to the returned
`StoreKnowledgeResult`, with the field declared optional on the type.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx.cmd vitest run tests/workspace/cross-repo-overlap.test.ts`
Expected: PASS, 5 tests

- [ ] **Step 5: Verify suite and typecheck**

Run: `npx.cmd vitest run` then `npx.cmd tsc --noEmit`
Expected: full suite green; 15 typecheck errors. Watch `tests/workspace/no-workspace-regression.test.ts`
in particular — it asserts an unlinked project is untouched, which is exactly what the lazy
resolution above is protecting.

- [ ] **Step 6: Commit**

```bash
git add src/store/conflicts.ts src/workspace/cross-repo-overlap.ts src/store/knowledge-writer.ts tests/workspace/cross-repo-overlap.test.ts
git commit -m "feat(workspace): report conflicts and duplicates across linked repos

Duplicate and conflict detection only ever looked in the writing repo's own
database, so two linked repos could hold contradictory active knowledge with
nothing noticing. This is the capability the shared-database design was going
to provide, and it needs no shared database -- only the ranker and the
conflict lookup pointed at a peer, which the preceding tasks made possible.

Reports, never mutates. The colliding item belongs to another repo and only
that repo can retire it; a write here superseding it is the failure a single
owner per item exists to prevent. Bounded and non-fatal: a few candidates per
peer, unreadable peers skipped, any failure degrading to no report rather than
a failed write. Outside a workspace it costs one null check."
```

---

## Self-review

**Coverage.** The three things this plan set out to do: stop duplicating retrieval (Tasks 1, 2, 4,
5), fix the filtering bug that blocks peer visibility (Task 3), add cross-repo conflict detection
(Task 6). Nothing in the brief is unaddressed.

**What this plan deliberately does not do.**

- *No shared database.* Every repo keeps its own file. Decision `0221ddf59f834b76` records why.
- *No cross-repo editing.* Task 6 reports and stops. The plan that promised editing also forbade
  it, which is what killed it.
- *No per-repo visibility config.* Discussed and deferred: it belongs after this, because it is a
  filter on the read path and this plan is what makes there be one read path to filter.
- *No ranking changes.* No new weights or boosts. Peer items start receiving the boosts local items
  already get, which is a consequence of removing the duplicate, not a tuning change.
- *`getActiveKnowledgeByCategory` and `getHierarchicalKnowledge` keep the global handle.* Not on
  this path; widening them would be scope with no consumer.

**Risks, and what covers each.**

| Risk | Cover |
| --- | --- |
| The default parameter is not equivalent to the old global read | Task 2 Step 5: the entire existing suite runs with every call site omitting the parameter |
| Ranking changes silently | Task 5 is gated on a checked-in eval baseline with recorded numbers |
| A peer's private knowledge leaks into this process | Task 3 puts the predicate in SQL above the `LIMIT`; Task 5 and Task 6 both assert it |
| A peer's database is modified by being read | `openPeerStore` sets `query_only = ON` and skips bootstrap; Tasks 1, 2 and 4 each assert the file is byte-identical after a read |
| Cross-repo checking slows every write | Task 6 bounds it to `PEER_CANDIDATES` per peer, skips absent peers, and resolves the workspace lazily |
| An unreadable peer breaks a write | Task 6 wraps the whole thing; a failure yields no report rather than an error |

**Known flake, unrelated but likely to be seen while running these.**
`tests/store/connection-pool.test.ts > leaves a peer database byte-identical when only read`
compares raw file bytes and has failed once in several full-suite runs under load, while passing 9
of 9 standalone. Cause not established. If it fails during this work, re-run it alone before
treating it as a regression — and note that Tasks 1–5 add read paths against peer databases, so if
its failure rate rises, that is a signal worth chasing rather than dismissing.
