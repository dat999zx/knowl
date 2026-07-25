# Portable Memory Round Trip Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `knowl export` / `knowl import` survive more than one round between two machines, and let deletes travel.

**Architecture:** Import stops being insert-only and all-or-nothing. Each incoming item is classified `new` / `identical` / `divergent`, and divergent items are resolved by a `--on-divergence` policy defaulting to `newer` (latest `updated_at` wins, `version` breaks ties). A winner is written **verbatim** — same `content_hash`, `version` and `updated_at` as the peer — so both sides converge on byte-identical rows instead of manufacturing a fresh winner each round. Deletes leave a tombstone row that export carries and import replays. Every written item is handed to the existing best-effort embedding indexer, which import has never called.

**Tech Stack:** TypeScript (ESM, Node >= 22), libSQL/SQLite via `@libsql/client`, Drizzle ORM for schema typing, Vitest.

## Global Constraints

- Node >= 22, ESM only (`"type": "module"`); relative imports carry the `.js` extension.
- No new runtime dependencies.
- Existing exports must keep importing: the JSONL header stays `{ type: 'header', format: 'knowl-jsonl', version: 1 }` and unknown record types are ignored rather than rejected.
- `updateKnowledgeItem` must NOT be used to apply an incoming item. It sets `updatedAt = now` and bumps `version`, which makes the two machines ping-pong forever. Write peer values verbatim.
- POSIX paths are case-sensitive; do not fold path case outside win32.
- Never widen a `validateKnowledgeWrite` bypass. Import already validates each item; keep that call.
- Tests use Vitest and live under `tests/`, mirroring `src/` paths.

---

## Task 1: Tombstone table and recording deletes

**Files:**
- Modify: `src/store/bootstrap.ts` (add table to the schema statement list)
- Modify: `src/store/repository.ts:378-387` (`deleteKnowledgeItem`)
- Create: `src/store/tombstones.ts`
- Test: `tests/store/tombstones.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `recordTombstone(id: string, deletedAt: string, reason?: string, dbConnection?: DbConnection): Promise<void>`
  - `listTombstones(dbConnection?: DbConnection): Promise<Tombstone[]>` where `Tombstone = { id: string; deletedAt: string; reason: string | null }`
  - `pruneTombstones(olderThanDays: number, now?: Date, dbConnection?: DbConnection): Promise<number>` returning the number removed.

- [ ] **Step 1: Write the failing test**

Create `tests/store/tombstones.test.ts`:

```typescript
import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, initDb } from '../../src/store/database.js';
import * as repo from '../../src/store/repository.js';
import { listTombstones, pruneTombstones, recordTombstone } from '../../src/store/tombstones.js';

const ROOT = path.resolve('.knowl-tombstones-test');

describe('tombstones', () => {
  let projectId = '';

  beforeAll(async () => {
    await fs.rm(ROOT, { recursive: true, force: true });
    await fs.mkdir(path.join(ROOT, '.knowl'), { recursive: true });
    await initDb(ROOT);
    projectId = (await repo.createProject(ROOT, 'Tombstones')).id;
  });

  afterAll(async () => {
    await closeDb();
    await fs.rm(ROOT, { recursive: true, force: true }).catch(() => {});
  });

  it('records a tombstone when an item is deleted', async () => {
    const item = await repo.createKnowledgeItem(projectId, {
      category: 'fact', title: 'Doomed fact', content: 'This will be purged.',
    });

    await repo.deleteKnowledgeItem(item.id);

    const tombstones = await listTombstones();
    expect(tombstones.map(entry => entry.id)).toContain(item.id);
  });

  it('prunes tombstones older than the retention window', async () => {
    await recordTombstone('ancient-id', '2020-01-01T00:00:00.000Z');
    await recordTombstone('recent-id', new Date().toISOString());

    const removed = await pruneTombstones(90);

    expect(removed).toBe(1);
    const ids = (await listTombstones()).map(entry => entry.id);
    expect(ids).toContain('recent-id');
    expect(ids).not.toContain('ancient-id');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/store/tombstones.test.ts`
Expected: FAIL — cannot resolve `../../src/store/tombstones.js`.

- [ ] **Step 3: Add the schema statement**

In `src/store/bootstrap.ts`, add to the array of `CREATE TABLE` statements, directly after the `host_session_bindings` statement:

```typescript
  `CREATE TABLE IF NOT EXISTS knowledge_tombstones (
    id TEXT PRIMARY KEY,
    deleted_at TEXT NOT NULL,
    reason TEXT
  );`,
```

`CREATE TABLE IF NOT EXISTS` runs on every open, so existing databases pick the table up with no separate migration.

- [ ] **Step 4: Create the tombstone module**

Create `src/store/tombstones.ts`:

```typescript
import { sql } from 'drizzle-orm';
import { DbConnection, getDb } from './database.js';

export type Tombstone = { id: string; deletedAt: string; reason: string | null };

/**
 * A hard delete leaves no trace in `knowledge_items`, so a peer that imports a later
 * export cannot tell the item was removed from one that never existed. The tombstone is
 * the only record that a delete happened.
 */
export async function recordTombstone(
  id: string,
  deletedAt: string,
  reason?: string,
  dbConnection?: DbConnection,
): Promise<void> {
  const conn = (dbConnection ?? getDb()) as any;
  await conn.run(sql`
    INSERT INTO knowledge_tombstones (id, deleted_at, reason)
    VALUES (${id}, ${deletedAt}, ${reason ?? null})
    ON CONFLICT(id) DO UPDATE SET deleted_at = excluded.deleted_at, reason = excluded.reason
  `);
}

export async function listTombstones(dbConnection?: DbConnection): Promise<Tombstone[]> {
  const conn = (dbConnection ?? getDb()) as any;
  const rows = await conn.all(sql`SELECT id, deleted_at, reason FROM knowledge_tombstones ORDER BY id`);
  return rows.map((row: any) => ({
    id: String(row.id),
    deletedAt: String(row.deleted_at),
    reason: row.reason === null || row.reason === undefined ? null : String(row.reason),
  }));
}

/**
 * Tombstones are unbounded otherwise. One older than any plausible export round is dead
 * weight, so retention is bounded rather than infinite.
 */
export async function pruneTombstones(
  olderThanDays: number,
  now: Date = new Date(),
  dbConnection?: DbConnection,
): Promise<number> {
  const conn = (dbConnection ?? getDb()) as any;
  const cutoff = new Date(now.getTime() - olderThanDays * 24 * 60 * 60 * 1000).toISOString();
  const result = await conn.run(sql`DELETE FROM knowledge_tombstones WHERE deleted_at < ${cutoff}`);
  return Number(result?.rowsAffected ?? 0);
}
```

- [ ] **Step 5: Record a tombstone on delete**

In `src/store/repository.ts`, replace the body of `deleteKnowledgeItem` (currently lines 378-387):

```typescript
export async function deleteKnowledgeItem(id: string, dbConnection?: DbConnection): Promise<void> {
  const conn = dbConnection || getDb();
  try {
    await conn
      .delete(schema.knowledgeItems)
      .where(eq(schema.knowledgeItems.id, id));
    // Written in the same connection (and therefore the same transaction when GC passes
    // one) so a purge can never lose its tombstone.
    await recordTombstone(id, new Date().toISOString(), 'purged', conn);
  } catch (error: any) {
    throw new DatabaseError(`Failed to delete knowledge item: ${error.message}`);
  }
}
```

Add the import at the top of `src/store/repository.ts`:

```typescript
import { recordTombstone } from './tombstones.js';
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run tests/store/tombstones.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 7: Verify no regression in GC, which owns the only delete call site**

Run: `npx vitest run tests/store/gc-access.test.ts tests/store/store.test.ts`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add src/store/tombstones.ts src/store/bootstrap.ts src/store/repository.ts tests/store/tombstones.test.ts
git commit -m "feat(store): record a tombstone when a knowledge item is purged"
```

---

## Task 2: Divergence classification and policy

**Files:**
- Create: `src/store/import-policy.ts`
- Test: `tests/store/import-policy.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces:
  - `export type DivergencePolicy = 'newer' | 'skip' | 'theirs' | 'fail'`
  - `export const DIVERGENCE_POLICIES: readonly DivergencePolicy[]`
  - `export const DEFAULT_DIVERGENCE_POLICY: DivergencePolicy` (value `'newer'`)
  - `classifyIncomingItem(incoming: ImportCandidate, local: LocalItemRow | undefined): 'new' | 'identical' | 'divergent'`
  - `resolveDivergence(policy: DivergencePolicy, incoming: ImportCandidate, local: LocalItemRow): 'incoming' | 'local'`
  - `export type ImportCandidate = { id: string; contentHash?: string | null; updatedAt: string; version: number }`
  - `export type LocalItemRow = { id: string; contentHash: string | null; updatedAt: string; version: number }`

- [ ] **Step 1: Write the failing test**

Create `tests/store/import-policy.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import {
  classifyIncomingItem,
  DEFAULT_DIVERGENCE_POLICY,
  resolveDivergence,
} from '../../src/store/import-policy.js';

const local = { id: 'a', contentHash: 'hash-local', updatedAt: '2026-07-01T00:00:00.000Z', version: 3 };

describe('import classification', () => {
  it('classifies an unseen id as new', () => {
    expect(classifyIncomingItem({ id: 'b', contentHash: 'x', updatedAt: local.updatedAt, version: 1 }, undefined))
      .toBe('new');
  });

  it('classifies a matching content hash as identical', () => {
    expect(classifyIncomingItem({ id: 'a', contentHash: 'hash-local', updatedAt: '2026-07-09T00:00:00.000Z', version: 9 }, local))
      .toBe('identical');
  });

  it('classifies a differing content hash as divergent', () => {
    expect(classifyIncomingItem({ id: 'a', contentHash: 'hash-remote', updatedAt: local.updatedAt, version: 3 }, local))
      .toBe('divergent');
  });
});

describe('divergence resolution', () => {
  const newer = { id: 'a', contentHash: 'hash-remote', updatedAt: '2026-07-09T00:00:00.000Z', version: 4 };
  const older = { id: 'a', contentHash: 'hash-remote', updatedAt: '2026-06-01T00:00:00.000Z', version: 1 };

  it('defaults to newer', () => {
    expect(DEFAULT_DIVERGENCE_POLICY).toBe('newer');
  });

  it('newer takes the later updatedAt', () => {
    expect(resolveDivergence('newer', newer, local)).toBe('incoming');
    expect(resolveDivergence('newer', older, local)).toBe('local');
  });

  it('newer breaks an updatedAt tie on version, then keeps local', () => {
    const tie = { ...newer, updatedAt: local.updatedAt };
    expect(resolveDivergence('newer', { ...tie, version: 9 }, local)).toBe('incoming');
    expect(resolveDivergence('newer', { ...tie, version: 1 }, local)).toBe('local');
    expect(resolveDivergence('newer', { ...tie, version: local.version }, local)).toBe('local');
  });

  it('skip always keeps local and theirs always takes incoming', () => {
    expect(resolveDivergence('skip', newer, local)).toBe('local');
    expect(resolveDivergence('theirs', older, local)).toBe('incoming');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/store/import-policy.test.ts`
Expected: FAIL — cannot resolve `../../src/store/import-policy.js`.

- [ ] **Step 3: Implement the policy module**

Create `src/store/import-policy.ts`:

```typescript
export type DivergencePolicy = 'newer' | 'skip' | 'theirs' | 'fail';

export const DIVERGENCE_POLICIES: readonly DivergencePolicy[] = ['newer', 'skip', 'theirs', 'fail'];

/**
 * The dominant case is one person's two machines, where trust is total and divergence
 * means "I edited this in both places". Silently keeping the older copy is the surprising
 * outcome, and every loser is reported either way.
 */
export const DEFAULT_DIVERGENCE_POLICY: DivergencePolicy = 'newer';

export type ImportCandidate = { id: string; contentHash?: string | null; updatedAt: string; version: number };
export type LocalItemRow = { id: string; contentHash: string | null; updatedAt: string; version: number };

export function classifyIncomingItem(
  incoming: ImportCandidate,
  local: LocalItemRow | undefined,
): 'new' | 'identical' | 'divergent' {
  if (!local) return 'new';
  return String(incoming.contentHash ?? '') === String(local.contentHash ?? '') ? 'identical' : 'divergent';
}

export function resolveDivergence(
  policy: DivergencePolicy,
  incoming: ImportCandidate,
  local: LocalItemRow,
): 'incoming' | 'local' {
  if (policy === 'theirs') return 'incoming';
  if (policy === 'skip' || policy === 'fail') return 'local';

  // `newer`: latest write wins, with `version` breaking an identical timestamp. Ties keep
  // local so an import is never gratuitously destructive.
  if (incoming.updatedAt > local.updatedAt) return 'incoming';
  if (incoming.updatedAt < local.updatedAt) return 'local';
  return incoming.version > local.version ? 'incoming' : 'local';
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/store/import-policy.test.ts`
Expected: PASS (7 tests)

- [ ] **Step 5: Commit**

```bash
git add src/store/import-policy.ts tests/store/import-policy.test.ts
git commit -m "feat(store): classify incoming import items and resolve divergence by policy"
```

---

## Task 3: Export tombstones

**Files:**
- Modify: `src/store/portability.ts:20-43` (`exportKnowledge`)
- Test: `tests/store/portability.test.ts`

**Conventions in `tests/store/portability.test.ts` — every snippet in Tasks 3-6 follows these:**
- Portability functions are reached through a namespace import that already exists:
  `import * as portability from '../../src/store/portability.js'` → call
  `portability.exportKnowledge(...)` and `portability.importKnowledge(...)`.
- There is no `projectId` variable and no `repo` namespace in this file. Items are created
  with the directly-imported `createKnowledgeItem('local', { ... })`, where `'local'` is the
  literal project id the file already uses.
- Add these to the existing import block once, before writing the Task 3 test:

```typescript
import { createHash } from 'node:crypto';
import { vi } from 'vitest';
import {
  createKnowledgeItem,
  deleteKnowledgeItem,
  getKnowledgeItem,
  listKnowledgeItems,
  updateKnowledgeItem,
} from '../../src/store/repository.js';
import * as writeEmbedding from '../../src/store/write-embedding.js';
```

(`createKnowledgeItem` and `listKnowledgeItems` are already imported — extend that line
rather than adding a second import from the same module.)

**Interfaces:**
- Consumes: `listTombstones` from Task 1.
- Produces: JSONL records of shape `{ type: 'tombstone', tombstone: { id, deletedAt, reason } }`, emitted after all item records and before the manifest. `exportKnowledge` return value gains `tombstones: number`.

- [ ] **Step 1: Write the failing test**

Append to `tests/store/portability.test.ts`, inside the existing top-level `describe`:

```typescript
  it('exports tombstones so deletes can travel', async () => {
    const doomed = await createKnowledgeItem('local', {
      category: 'fact', title: 'Temporary fact', content: 'Removed before export.',
    });
    await deleteKnowledgeItem(doomed.id);

    const target = path.join(ROOT, 'with-tombstone.jsonl');
    const result = await portability.exportKnowledge('local', target, ROOT);

    expect(result.tombstones).toBeGreaterThanOrEqual(1);
    const records = (await fs.readFile(target, 'utf8'))
      .split('\n').filter(Boolean).map(line => JSON.parse(line));
    const tombstones = records.filter(record => record.type === 'tombstone');
    expect(tombstones.map(record => record.tombstone.id)).toContain(doomed.id);
  });
```

The `fs`, `path` and `portability` imports already exist in this file.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/store/portability.test.ts -t "tombstones"`
Expected: FAIL — `result.tombstones` is `undefined`.

- [ ] **Step 3: Emit tombstone records**

In `src/store/portability.ts`, add the import:

```typescript
import { listTombstones } from './tombstones.js';
```

Then, inside `exportKnowledge`, immediately after the `if (projectRoot) { ... }` skill-package block and before `const body = ...`:

```typescript
  const tombstones = await listTombstones();
  for (const tombstone of tombstones) records.push({ type: 'tombstone', tombstone });
```

And change the return statement to:

```typescript
  return { items: items.length, tombstones: tombstones.length, sha256: manifest };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/store/portability.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/store/portability.ts tests/store/portability.test.ts
git commit -m "feat(portability): carry tombstones in the exported JSONL stream"
```

---

## Task 4: Repeatable import

**Files:**
- Modify: `src/store/portability.ts:45-99` (`ImportResult`, `importKnowledge`)
- Test: `tests/store/portability.test.ts`

**Interfaces:**
- Consumes: `classifyIncomingItem`, `resolveDivergence`, `DivergencePolicy`, `DEFAULT_DIVERGENCE_POLICY` (Task 2); `recordTombstone` (Task 1); tombstone records (Task 3).
- Produces:
  ```typescript
  export type ImportResult = {
    inserted: number;
    identical: number;
    updated: number;
    keptLocal: number;
    deleted: number;
    conflicts: number;
    applied: boolean;
    divergent: Array<{ id: string; title: string; taken: 'incoming' | 'local' }>;
    /** Present only on a dry run: what the counts WOULD have been. */
    wouldApply?: { inserted: number; identical: number; updated: number; keptLocal: number };
  };
  ```
  `importKnowledge(inputPath, options)` where `options` gains `onDivergence?: DivergencePolicy`.

- [ ] **Step 1: Write the failing test**

Append to `tests/store/portability.test.ts`:

```typescript
  it('applies new items even when another item diverged', async () => {
    // The defect this replaces: one divergent item discarded the whole import, so
    // unrelated new knowledge could never land on a machine that had done any work.
    const shared = await createKnowledgeItem('local', {
      category: 'fact', title: 'Shared fact', content: 'Original content.',
    });
    const target = path.join(ROOT, 'round-trip.jsonl');
    await portability.exportKnowledge('local', target, ROOT);

    // Diverge locally, and add a record the peer has but we do not.
    await updateKnowledgeItem(shared.id, { content: 'Edited locally.' });

    const result = await portability.importKnowledge(target, { projectRoot: ROOT, onDivergence: 'skip' });

    expect(result.applied).toBe(true);
    expect(result.conflicts).toBe(0);
    expect(result.keptLocal).toBe(1);
    expect(result.divergent[0]).toMatchObject({ id: shared.id, taken: 'local' });
    const local = await getKnowledgeItem(shared.id);
    expect(local!.content).toBe('Edited locally.');
  });

  it('adopts a newer incoming item verbatim so both sides converge', async () => {
    const item = await createKnowledgeItem('local', {
      category: 'fact', title: 'Convergent fact', content: 'Peer wrote this.',
    });
    const target = path.join(ROOT, 'converge.jsonl');
    await portability.exportKnowledge('local', target, ROOT);
    const exported = (await fs.readFile(target, 'utf8'))
      .split('\n').filter(Boolean).map(line => JSON.parse(line))
      .find(record => record.type === 'item' && record.item.id === item.id)!.item;

    // Local copy is older and different.
    await updateKnowledgeItem(item.id, { content: 'Stale local copy.' });
    await getClient().execute({
      sql: 'UPDATE knowledge_items SET updated_at = ? WHERE id = ?',
      args: ['2020-01-01T00:00:00.000Z', item.id],
    });

    const result = await portability.importKnowledge(target, { projectRoot: ROOT, onDivergence: 'newer' });

    expect(result.applied).toBe(true);
    expect(result.updated).toBe(1);
    // Verbatim adoption is what makes a second round classify this as identical instead of
    // manufacturing a new winner and ping-ponging forever.
    const local = await getKnowledgeItem(item.id);
    expect(local!.contentHash).toBe(exported.contentHash);
    expect(local!.updatedAt).toBe(exported.updatedAt);
    expect(local!.version).toBe(exported.version);

    const second = await portability.importKnowledge(target, { projectRoot: ROOT, onDivergence: 'newer' });
    expect(second.updated).toBe(0);
    expect(second.identical).toBeGreaterThan(0);
  });

  it('fails the whole import only under the fail policy', async () => {
    const item = await createKnowledgeItem('local', {
      category: 'fact', title: 'Fail policy fact', content: 'Original.',
    });
    const target = path.join(ROOT, 'fail-policy.jsonl');
    await portability.exportKnowledge('local', target, ROOT);
    await updateKnowledgeItem(item.id, { content: 'Diverged.' });

    const result = await portability.importKnowledge(target, { projectRoot: ROOT, onDivergence: 'fail' });

    expect(result.applied).toBe(false);
    expect(result.conflicts).toBe(1);
  });

  it('replays a tombstone only when the local copy is older than the delete', async () => {
    const removed = await createKnowledgeItem('local', {
      category: 'fact', title: 'Deleted on peer', content: 'Gone over there.',
    });
    const target = path.join(ROOT, 'tombstone-replay.jsonl');
    await portability.exportKnowledge('local', target, ROOT);
    const stream = (await fs.readFile(target, 'utf8')).split('\n').filter(Boolean);
    const body = stream.slice(0, -1)
      .concat(JSON.stringify({
        type: 'tombstone',
        tombstone: { id: removed.id, deletedAt: new Date().toISOString(), reason: 'purged' },
      }));
    const rebuilt = path.join(ROOT, 'tombstone-replay-2.jsonl');
    const joined = `${body.join('\n')}\n`;
    const sha = createHash('sha256').update(joined).digest('hex');
    await fs.writeFile(rebuilt, `${joined}${JSON.stringify({ type: 'manifest', sha256: sha })}\n`, 'utf8');

    const result = await portability.importKnowledge(rebuilt, { projectRoot: ROOT, onDivergence: 'newer' });

    expect(result.deleted).toBe(1);
    await expect(getKnowledgeItem(removed.id)).resolves.toBeNull();
  });
```

Add these imports to the test file if absent:

```typescript
import { createHash } from 'node:crypto';
import { getClient } from '../../src/store/database.js';
import { exportKnowledge, importKnowledge } from '../../src/store/portability.js';
```

`getKnowledgeItem` returns `null` for a missing id in this codebase; if it throws instead, assert with `await expect(...).rejects.toThrow()`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/store/portability.test.ts`
Expected: FAIL — `onDivergence` is not accepted and `result.updated` is `undefined`.

- [ ] **Step 3: Rewrite the import classification and apply loop**

In `src/store/portability.ts`, add imports:

```typescript
import {
  classifyIncomingItem,
  DEFAULT_DIVERGENCE_POLICY,
  DivergencePolicy,
  resolveDivergence,
} from './import-policy.js';
import { recordTombstone } from './tombstones.js';
```

Replace the `ImportResult` type and everything from `const client = getClient();` to the end of `importKnowledge` with:

```typescript
export type ImportResult = {
  inserted: number;
  identical: number;
  updated: number;
  keptLocal: number;
  deleted: number;
  conflicts: number;
  applied: boolean;
  divergent: Array<{ id: string; title: string; taken: 'incoming' | 'local' }>;
  /** Present only on a dry run: what the counts WOULD have been. */
  wouldApply?: { inserted: number; identical: number; updated: number; keptLocal: number };
};

const ITEM_COLUMNS = 'id, category, status, title, content, reasoning, alternatives, tags, source, source_commit, affected_paths, content_hash, freshness, confidence, conflict_key, conflict_scope, conflict_exclusive, superseded_by_id, version, created_at, updated_at';

function itemArgs(item: any): unknown[] {
  return [
    item.id, item.category, item.status, item.title, item.content, item.reasoning ?? null,
    item.alternatives ? JSON.stringify(item.alternatives) : null,
    item.tags ? JSON.stringify(item.tags) : null,
    item.source ?? null, item.sourceCommit ?? null,
    item.affectedPaths ? JSON.stringify(item.affectedPaths) : null,
    item.contentHash ?? null, item.freshness, item.confidence, item.conflictKey ?? null,
    item.conflictScope ? JSON.stringify(item.conflictScope) : null,
    item.conflictExclusive ? 1 : 0, item.supersededById ?? null, item.version,
    item.createdAt, item.updatedAt,
  ];
}
```

Then, inside `importKnowledge`, after the existing `const skills = ...` line, add tombstone parsing:

```typescript
  const tombstones = records.filter(record => record.type === 'tombstone').map(record => record.tombstone);
  const policy: DivergencePolicy = options.onDivergence ?? DEFAULT_DIVERGENCE_POLICY;
```

Replace the classification loop and the guard (current lines 63-75) with:

```typescript
  const client = getClient();
  const plan: Array<{ item: any; action: 'insert' | 'update' | 'identical' | 'keep-local' }> = [];
  const divergent: ImportResult['divergent'] = [];
  let conflicts = 0;

  for (const item of items) {
    validateKnowledgeWrite({ title: item.title, content: item.content, reasoning: item.reasoning, source: item.source, affectedPaths: item.affectedPaths });
    const existing = (await client.execute({
      sql: 'SELECT id, content_hash, updated_at, version FROM knowledge_items WHERE id = ?',
      args: [item.id],
    })).rows[0];

    const local = existing
      ? {
        id: String(existing.id),
        contentHash: existing.content_hash === null ? null : String(existing.content_hash),
        updatedAt: String(existing.updated_at),
        version: Number(existing.version),
      }
      : undefined;

    const classification = classifyIncomingItem(item, local);
    if (classification === 'new') { plan.push({ item, action: 'insert' }); continue; }
    if (classification === 'identical') { plan.push({ item, action: 'identical' }); continue; }

    // Divergent. `fail` is the only policy that abandons the whole import; every other
    // policy resolves per item so unrelated new knowledge still lands.
    if (policy === 'fail') { conflicts += 1; plan.push({ item, action: 'keep-local' }); continue; }
    const taken = resolveDivergence(policy, item, local!);
    divergent.push({ id: item.id, title: String(item.title ?? ''), taken });
    plan.push({ item, action: taken === 'incoming' ? 'update' : 'keep-local' });
  }

  const counts = {
    inserted: plan.filter(entry => entry.action === 'insert').length,
    identical: plan.filter(entry => entry.action === 'identical').length,
    updated: plan.filter(entry => entry.action === 'update').length,
    keptLocal: plan.filter(entry => entry.action === 'keep-local').length,
  };

  // Dry run and the `fail` policy both write nothing, so every count is reported as zero
  // rather than describing writes that did not happen.
  if (conflicts > 0 || options.dryRun) {
    return {
      inserted: 0, identical: 0, updated: 0, keptLocal: 0, deleted: 0,
      conflicts, applied: false,
      divergent: options.dryRun ? divergent : [],
      ...(options.dryRun ? { wouldApply: counts } : {}),
    };
  }

  if (!options.projectRoot && skills.length > 0) throw new Error('Skill package import requires a project root.');

  let deleted = 0;
  await client.execute('BEGIN;');
  try {
    for (const entry of plan) {
      if (entry.action === 'insert') {
        await client.execute({
          sql: `INSERT INTO knowledge_items (${ITEM_COLUMNS}) VALUES (${new Array(21).fill('?').join(', ')})`,
          args: itemArgs(entry.item) as any[],
        });
      } else if (entry.action === 'update') {
        // Verbatim: same content_hash, version and updated_at as the peer, so the next
        // round classifies this as identical instead of manufacturing a fresh winner.
        await client.execute({
          sql: `UPDATE knowledge_items SET category = ?, status = ?, title = ?, content = ?, reasoning = ?,
            alternatives = ?, tags = ?, source = ?, source_commit = ?, affected_paths = ?, content_hash = ?,
            freshness = ?, confidence = ?, conflict_key = ?, conflict_scope = ?, conflict_exclusive = ?,
            superseded_by_id = ?, version = ?, created_at = ?, updated_at = ? WHERE id = ?`,
          args: [...itemArgs(entry.item).slice(1), entry.item.id] as any[],
        });
      }
    }

    for (const entry of evidence) await client.execute({ sql: 'INSERT OR IGNORE INTO evidence (id, type, locator, content_hash, excerpt, observed_at, metadata) VALUES (?, ?, ?, ?, ?, ?, ?)', args: [entry.id, entry.type, entry.locator, entry.contentHash ?? null, entry.excerpt ?? null, entry.observedAt, entry.metadata ? JSON.stringify(entry.metadata) : null] });
    for (const assertion of assertions) await client.execute({ sql: 'INSERT OR IGNORE INTO knowledge_assertions (id, knowledge_item_id, content, valid_from, valid_to, recorded_at, replaced_at, confidence, source_evidence_id, conflict_key, conflict_scope, conflict_exclusive) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', args: [assertion.id, assertion.knowledgeItemId, assertion.content, assertion.validFrom, assertion.validTo ?? null, assertion.recordedAt, assertion.replacedAt ?? null, assertion.confidence, assertion.sourceEvidenceId ?? null, assertion.conflictKey ?? null, assertion.conflictScope ? JSON.stringify(assertion.conflictScope) : null, assertion.conflictExclusive ? 1 : 0] });
    for (const link of links) await client.execute({ sql: 'INSERT OR IGNORE INTO knowledge_evidence (knowledge_item_id, evidence_id, relationship) VALUES (?, ?, ?)', args: [link.knowledgeItemId, link.evidenceId, link.relationship] });

    // A local edit made after the remote delete wins; the tombstone is still recorded so
    // the decision does not have to be made again next round.
    for (const tombstone of tombstones) {
      const local = (await client.execute({
        sql: 'SELECT updated_at FROM knowledge_items WHERE id = ?',
        args: [tombstone.id],
      })).rows[0];
      if (local && String(local.updated_at) < String(tombstone.deletedAt)) {
        await client.execute({ sql: 'DELETE FROM knowledge_items WHERE id = ?', args: [tombstone.id] });
        deleted += 1;
      }
      await recordTombstone(tombstone.id, tombstone.deletedAt, tombstone.reason ?? undefined);
    }

    for (const skill of skills) for (const file of skill.files) {
      const target = path.resolve(options.projectRoot!, '.knowl', 'skills', skill.name, file.path);
      const root = path.resolve(options.projectRoot!, '.knowl', 'skills', skill.name);
      if (!target.startsWith(`${root}${path.sep}`)) throw new Error('Invalid imported skill file path.');
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, file.content, 'utf8');
    }
    await client.execute('COMMIT;');
  } catch (error) {
    await client.execute('ROLLBACK;');
    throw error;
  }

  return { ...counts, deleted, conflicts: 0, applied: true, divergent };
}
```

Update the signature line to accept the policy:

```typescript
export async function importKnowledge(
  inputPath: string,
  options: { dryRun?: boolean; projectRoot?: string; onDivergence?: DivergencePolicy } = {},
): Promise<ImportResult> {
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/store/portability.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/store/portability.ts tests/store/portability.test.ts
git commit -m "feat(portability): resolve divergence per item instead of discarding the import"
```

---

## Task 5: Index imported items for vector search

**Files:**
- Modify: `src/store/portability.ts` (`importKnowledge`, after the transaction commits)
- Test: `tests/store/portability.test.ts`

**Interfaces:**
- Consumes: the `plan` array from Task 4.
- Produces: no new exports; `importKnowledge` now leaves `knowledge_embeddings` rows for written items when vectors are enabled.

- [ ] **Step 1: Write the failing test**

Append to `tests/store/portability.test.ts`:

```typescript
  it('hands imported items to the embedding indexer', async () => {
    // Import wrote raw SQL and never called the indexer, so imported knowledge was
    // invisible to vector search -- the primary retrieval path -- until a manual reindex.
    const indexed: string[] = [];
    vi.spyOn(writeEmbedding, 'indexKnowledgeItemsBestEffort').mockImplementation(async (_projectId, items) => {
      indexed.push(...items.map(item => item.id));
    });

    const fresh = await createKnowledgeItem('local', {
      category: 'fact', title: 'Indexable fact', content: 'Should reach the indexer.',
    });
    const target = path.join(ROOT, 'indexing.jsonl');
    await portability.exportKnowledge('local', target, ROOT);
    await deleteKnowledgeItem(fresh.id);

    await portability.importKnowledge(target, { projectRoot: ROOT, onDivergence: 'newer' });

    expect(indexed).toContain(fresh.id);
    vi.restoreAllMocks();
  });
```

Add to the test file's imports:

```typescript
import { vi } from 'vitest';
import * as writeEmbedding from '../../src/store/write-embedding.js';
```

Note: `deleteKnowledgeItem` now writes a tombstone (Task 1), and this export was taken before the delete, so the stream contains the item but not its tombstone — the item re-inserts.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/store/portability.test.ts -t "embedding indexer"`
Expected: FAIL — `indexed` is empty.

- [ ] **Step 3: Call the indexer after commit**

In `src/store/portability.ts`, add the import:

```typescript
import { indexKnowledgeItemsBestEffort } from './write-embedding.js';
import { getProjectByRootPath } from './repository.js';
```

Then, after `await client.execute('COMMIT;');` succeeds and before the `return`, add:

```typescript
  // Every other write path indexes on write; import writing raw SQL is the reason
  // imported knowledge was invisible to vector search. Best-effort by design: a project
  // with vectors disabled simply stays on the BM25 path.
  const written = plan
    .filter(entry => entry.action === 'insert' || entry.action === 'update')
    .map(entry => entry.item);
  if (written.length > 0 && options.projectRoot) {
    const project = await getProjectByRootPath(options.projectRoot);
    if (project) await indexKnowledgeItemsBestEffort(project.id, written as any);
  }
```

Place this after the `try/catch` block so a failed transaction never indexes.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/store/portability.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/store/portability.ts tests/store/portability.test.ts
git commit -m "fix(portability): index imported items so they reach vector search"
```

---

## Task 6: CLI surface, GC pruning, and the full round-trip test

**Files:**
- Modify: `src/index.ts:389` (`import` command), `src/index.ts` `gc` command
- Modify: `src/store/gc.ts` (prune tombstones during GC)
- Test: `tests/store/portability.test.ts`, `tests/cli/cli.test.ts`

**Interfaces:**
- Consumes: `DIVERGENCE_POLICIES`, `DEFAULT_DIVERGENCE_POLICY` (Task 2); `pruneTombstones` (Task 1).
- Produces: `knowl import <path> [--dry-run] [--on-divergence <policy>]`; GC removes tombstones older than `--tombstone-days` (default 90).

- [ ] **Step 1: Write the failing round-trip test**

Append to `tests/store/portability.test.ts`:

```typescript
  it('converges two databases across a full round trip', async () => {
    // The acceptance criterion from the spec: A -> B, both diverge, B -> A, and every
    // shared item agrees on content_hash with deletes reflected on both sides.
    const shared = await createKnowledgeItem('local', {
      category: 'fact', title: 'Round trip fact', content: 'Initial content.',
    });
    const first = path.join(ROOT, 'rt-1.jsonl');
    await portability.exportKnowledge('local', first, ROOT);

    // Peer edits the shared item later than we did, and adds one of its own.
    const stream = (await fs.readFile(first, 'utf8')).split('\n').filter(Boolean);
    const records = stream.slice(0, -1).map(line => JSON.parse(line));
    for (const record of records) {
      if (record.type === 'item' && record.item.id === shared.id) {
        record.item.content = 'Peer content.';
        record.item.contentHash = 'peer-hash';
        record.item.updatedAt = '2030-01-01T00:00:00.000Z';
        record.item.version = record.item.version + 1;
      }
    }
    records.push({ type: 'item', item: { ...shared, id: 'peer-only-item', title: 'Peer only', content: 'From the peer.', contentHash: 'peer-only-hash', updatedAt: '2030-01-01T00:00:00.000Z' } });
    const joined = `${records.map(record => JSON.stringify(record)).join('\n')}\n`;
    const sha = createHash('sha256').update(joined).digest('hex');
    const second = path.join(ROOT, 'rt-2.jsonl');
    await fs.writeFile(second, `${joined}${JSON.stringify({ type: 'manifest', sha256: sha })}\n`, 'utf8');

    const result = await portability.importKnowledge(second, { projectRoot: ROOT, onDivergence: 'newer' });

    expect(result.applied).toBe(true);
    expect(result.inserted).toBe(1);
    expect(result.updated).toBe(1);
    const converged = await getKnowledgeItem(shared.id);
    expect(converged!.contentHash).toBe('peer-hash');
    expect(await getKnowledgeItem('peer-only-item')).not.toBeNull();

    // A second identical import is a no-op, which is what convergence means.
    const repeat = await portability.importKnowledge(second, { projectRoot: ROOT, onDivergence: 'newer' });
    expect(repeat.updated).toBe(0);
    expect(repeat.inserted).toBe(0);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/store/portability.test.ts -t "round trip"`
Expected: FAIL until Tasks 4 and 5 are in place; if they are, this should already pass and the remaining steps are CLI wiring.

- [ ] **Step 3: Add the CLI option**

In `src/index.ts`, replace the `import` command definition at line 389:

```typescript
program.command('import').description('Load portable JSONL memory from a file').argument('<path>').option('--dry-run')
  .option('--on-divergence <policy>', `How to resolve items that differ locally: ${DIVERGENCE_POLICIES.join(', ')}`, DEFAULT_DIVERGENCE_POLICY)
  .action(async (inputPath, options) => {
    try {
      if (!DIVERGENCE_POLICIES.includes(options.onDivergence)) {
        throw new Error(`Unknown --on-divergence policy: ${options.onDivergence}. Expected one of: ${DIVERGENCE_POLICIES.join(', ')}`);
      }
      const root = await findProjectRoot(process.cwd());
      await initDb(root);
      console.log(JSON.stringify(await portability.importKnowledge(path.resolve(inputPath), { dryRun: options.dryRun, projectRoot: root, onDivergence: options.onDivergence }), null, 2));
      await closeDb();
    } catch (error: any) {
      await closeDb().catch(() => {});
      console.error(`Error importing knowledge: ${error.message}`);
      process.exit(1);
    }
  });
```

Add to the imports at the top of `src/index.ts`:

```typescript
import { DEFAULT_DIVERGENCE_POLICY, DIVERGENCE_POLICIES } from './store/import-policy.js';
```

- [ ] **Step 4: Prune tombstones during GC**

In `src/store/gc.ts`, add the import:

```typescript
import { pruneTombstones } from './tombstones.js';
```

Add a `tombstoneDays` option (default 90) to the GC options type alongside `staleDays`, and inside the apply path, after the existing archive/purge loop completes, add:

```typescript
    // Tombstones are unbounded otherwise. One older than any plausible export round
    // cannot affect a future import.
    const prunedTombstones = await pruneTombstones(options.tombstoneDays ?? 90, undefined, tx);
```

Include `prunedTombstones` in the GC result object so `knowl gc` reports it.

In `src/index.ts`, add to the `gc` command:

```typescript
  .option('--tombstone-days <days>', 'Remove delete records older than this many days (default 90)')
```

and pass `tombstoneDays: options.tombstoneDays === undefined ? undefined : Number(options.tombstoneDays)` through to the GC call.

- [ ] **Step 5: Add a CLI integration assertion**

In `tests/cli/cli.test.ts`, extend the existing `'should export and dry-run import portable JSONL memory'` test, or add alongside it:

```typescript
  it('rejects an unknown divergence policy', async () => {
    const result = await runCli(['import', 'memory.jsonl', '--on-divergence', 'whatever'], projectDir);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/Unknown --on-divergence policy/);
  });
```

Match the helper name and signature already used in `tests/cli/cli.test.ts` for invoking the CLI; do not introduce a new helper.

- [ ] **Step 6: Run the full suite**

Run: `npx vitest run`
Expected: PASS, with no reduction from the current 409 tests.

- [ ] **Step 7: Verify the real round trip by hand**

The unit tests use synthetic streams. Repeat the experiment that proved the defect, which uses a real multi-hundred-item export:

```bash
npm run build
mkdir -p /tmp/rt/a /tmp/rt/b
cd /path/to/a/real/knowl/project && knowl export /tmp/rt/memory.jsonl
cd /tmp/rt/a && knowl init --yes && knowl import /tmp/rt/memory.jsonl
cd /tmp/rt/b && knowl init --yes && knowl import /tmp/rt/memory.jsonl
cd /tmp/rt/b && knowl decide "Peer decision" "Added only on B." && knowl export /tmp/rt/from-b.jsonl
cd /tmp/rt/a && knowl import /tmp/rt/from-b.jsonl
```

Expected: `applied: true`, `inserted: 1`, and the peer decision present on A. Before this work the same sequence produced `applied: false` with nothing written.

- [ ] **Step 8: Commit**

```bash
git add src/index.ts src/store/gc.ts tests/store/portability.test.ts tests/cli/cli.test.ts
git commit -m "feat(cli): expose --on-divergence and prune tombstones during gc"
```

---

## Spec coverage

| Spec section | Tasks |
| --- | --- |
| Per-record classification, never wholesale abort | 2 (classification), 4 (apply loop) |
| `--on-divergence` policies `newer` / `skip` / `theirs` / `fail` | 2 (resolution), 6 (CLI) |
| Divergent losers reported by id and title | 4 (`divergent` array) |
| Verbatim adoption so both sides converge | 4 (update path), 6 (round-trip assertion) |
| Tombstone table and delete recording | 1 |
| Tombstones exported | 3 |
| Tombstone replay, local-edit-wins rule | 4 |
| Tombstone retention pruning | 1 (`pruneTombstones`), 6 (GC wiring) |
| Imported items indexed for vector search | 5 |
| Counts describe what happened | 4 (zeroed counts when nothing is written) |
| Round-trip test as acceptance criterion | 6 (Steps 1 and 7) |

Not implemented, by design — all listed as spec non-goals: convergent merge, CRDTs, replica identity, vector clocks, real-time sync, any server or transport, field-level merge, and reconciliation of session, `knowledge_access`, or embedding rows.
