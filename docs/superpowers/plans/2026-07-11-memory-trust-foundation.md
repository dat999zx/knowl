# Memory Trust Foundation Implementation Plan

> **Status:** Completed 2026-07-11. Verification: `rtk npm.cmd test` (121 tests), `rtk npm.cmd run build`, `rtk git diff --check`.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every Knowl write pass one deterministic secret/safety guard, then add inspectable audit and safe database snapshot/restore operations.

**Architecture:** `validateKnowledgeWrite()` is a pure core service called by repository item creation/update and all ingestion paths. Audit and snapshot services use the initialized SQLite client, never bypassing repository validation for restored rows. Existing item IDs and commit history remain stable during normal writes.

**Tech Stack:** TypeScript, Zod-free pure validators, `@libsql/client`, Drizzle schema/bootstrap, Commander, Vitest.

---

### Task 1: Define the universal write-validation contract

**Files:**
- Create: `src/core/knowledge-validation.ts`
- Modify: `src/core/types.ts`
- Test: `tests/core/knowledge-validation.test.ts`

- [ ] **Step 1: Write failing validator tests**

Cover clean content, API-key-like values, PEM blocks, credential URLs, configured patterns, `.env` paths, oversized payloads, and error messages that do not include the rejected value.

```ts
it('rejects a credential-like token without echoing it', () => {
  const secret = 'sk-test-123456789012345678901234567890';
  expect(() => validateKnowledgeWrite({ title: 'x', content: secret })).toThrow(/secret/i);
});
```

Use a separate assertion for the safe error text so the test requires the secret not to appear:

```ts
try {
  validateKnowledgeWrite({ title: 'x', content: secret });
  throw new Error('expected rejection');
} catch (error) {
  expect(String(error)).not.toContain(secret);
}
```

- [ ] **Step 2: Run the focused test and verify failure**

Run: `rtk npm.cmd test -- tests/core/knowledge-validation.test.ts`

Expected: FAIL because the validator module and function do not exist.

- [ ] **Step 3: Implement the pure validator**

Define the input and result types in `src/core/types.ts`:

```ts
export type KnowledgeWriteInput = {
  title?: string | null;
  content?: string | null;
  reasoning?: string | null;
  source?: string | null;
  affectedPaths?: string[] | null;
  rawOutput?: string | null;
};

export type KnowledgeWriteValidationOptions = {
  rejectSecrets?: boolean;
  secretPatterns?: string[];
  maxFieldLength?: number;
  maxRawOutputLength?: number;
};
```

Implement `validateKnowledgeWrite(input, options?)` with deterministic checks for common bearer/API tokens, PEM headers, credential-bearing URLs, configured case-insensitive patterns, high-entropy token runs, `.env`/credential paths, and length limits. Return `{ pass: true }` or throw `KnowledgeValidationError` with a rule code and safe message. Never include matching text in the error.

- [ ] **Step 4: Run the focused test and verify pass**

Run: `rtk npm.cmd test -- tests/core/knowledge-validation.test.ts`

Expected: PASS for all clean/rejected cases.

- [ ] **Step 5: Commit the validator**

```bash
rtk git add src/core/knowledge-validation.ts src/core/types.ts tests/core/knowledge-validation.test.ts
rtk git commit -m "feat: add universal knowledge write validation"
```

### Task 2: Route all durable item writes through the guard

**Files:**
- Modify: `src/store/repository.ts`
- Modify: `src/store/knowledge-actions.ts`
- Modify: `src/store/knowledge-writer.ts`
- Modify: `src/pipeline/filter.ts`
- Modify: `src/mcp/tools.ts`
- Test: `tests/store/store.test.ts`
- Test: `tests/pipeline/pipeline.test.ts`
- Test: `tests/mcp/server.test.ts`

- [ ] **Step 1: Add regression tests for direct, pipeline, and MCP writes**

Create a project fixture with `security.rejectSecrets = true`. Assert that `repo.createKnowledgeItem`, `recordDecisionDirect`, `knowl_ingest_atoms`, and the raw-ingest path all reject the same secret payload. Assert a valid write still creates one item and one commit.

- [ ] **Step 2: Run the focused tests and verify failure**

Run: `rtk npm.cmd test -- tests/store/store.test.ts tests/pipeline/pipeline.test.ts tests/mcp/server.test.ts`

Expected: the direct structured-write test fails because repository writes currently bypass the filter.

- [ ] **Step 3: Add one repository boundary call**

At the start of `createKnowledgeItem` and `updateKnowledgeItem`, call `validateKnowledgeWrite` with project config loaded by the caller or the deterministic default. Keep hashing and transaction behavior unchanged. Route `knowledge-writer.ts` through these repository methods rather than adding a second detector.

- [ ] **Step 4: Preserve raw-ingest behavior without double rejection**

Keep `src/pipeline/filter.ts` as the early user-facing filter, but call the same validator there. Map `KnowledgeValidationError` to the existing `FilterResult` shape. MCP and CLI errors must expose the rule code and safe message only.

- [ ] **Step 5: Run focused and full tests**

Run: `rtk npm.cmd test -- tests/store/store.test.ts tests/pipeline/pipeline.test.ts tests/mcp/server.test.ts`

Expected: PASS; no rejected write leaves an item or commit behind.

- [ ] **Step 6: Commit the write-path integration**

```bash
rtk git add src/store/repository.ts src/store/knowledge-actions.ts src/store/knowledge-writer.ts src/pipeline/filter.ts src/mcp/tools.ts tests/store/store.test.ts tests/pipeline/pipeline.test.ts tests/mcp/server.test.ts
rtk git commit -m "fix: enforce validation on every knowledge write path"
```

### Task 3: Add audit and safe snapshots

**Files:**
- Create: `src/store/integrity.ts`
- Create: `src/store/snapshots.ts`
- Modify: `src/index.ts`
- Modify: `src/cli/doctor-report.ts`
- Test: `tests/store/integrity.test.ts`
- Test: `tests/cli/cli.test.ts`

- [ ] **Step 1: Write failing audit/snapshot tests**

Test `auditKnowledgeStore()` for clean data, secret-like legacy content, dangling skill rows, missing FTS rows, invalid JSON arrays, and embeddings pointing at deleted items. Test `createSnapshot()` writes a timestamped copy outside the database transaction, and `restoreSnapshot()` refuses a missing file, refuses a path inside the live DB path, and restores a valid copy after an explicit confirmation flag.

- [ ] **Step 2: Run focused tests and verify failure**

Run: `rtk npm.cmd test -- tests/store/integrity.test.ts tests/cli/cli.test.ts`

Expected: FAIL because audit/snapshot services and CLI commands do not exist.

- [ ] **Step 3: Implement deterministic audit**

Return structured findings:

```ts
export type IntegrityFinding = {
  code: 'secret' | 'dangling-reference' | 'missing-index-row' | 'invalid-json' | 'invalid-status';
  severity: 'error' | 'warning';
  itemId?: string;
  detail: string;
};
```

Audit every knowledge row through the validator in report-only mode, verify skill/embedding references, validate JSON fields, and compare item IDs against FTS rows. Do not mutate data.

- [ ] **Step 4: Implement snapshot/restore**

Use the SQLite client backup/copy facility or a filesystem copy after closing the client. Write snapshots under `.knowl/snapshots/` with a manifest containing schema version, creation time, byte size, and SHA-256. Restore only from a user-specified snapshot path after `--confirm`; create a pre-restore snapshot first; reopen and run bootstrap plus audit before reporting success.

- [ ] **Step 5: Add CLI commands and doctor checks**

Add `knowl audit`, `knowl snapshot create`, and `knowl snapshot restore <path> --confirm`. Doctor should report validation and integrity status without printing rejected values.

- [ ] **Step 6: Verify and commit**

Run: `rtk npm.cmd test -- tests/store/integrity.test.ts tests/cli/cli.test.ts`; `rtk npm.cmd run build`; `rtk git diff --check`

Expected: PASS; restore leaves the database open and queryable.

```bash
rtk git add src/store/integrity.ts src/store/snapshots.ts src/index.ts src/cli/doctor-report.ts tests/store/integrity.test.ts tests/cli/cli.test.ts
rtk git commit -m "feat: add Knowl integrity audit and safe snapshots"
```

### Task 4: Plan completion checkpoint

**Files:**
- Modify: `README.md`
- Modify: `src/core/agents-guidance.ts`

- [ ] **Step 1: Document the universal guard, audit, and snapshot commands**

State that all structured and raw writes are guarded, `knowl audit` is read-only, and restore requires an explicit confirmation plus a pre-restore snapshot.

- [ ] **Step 2: Run the complete verification set**

Run: `rtk npm.cmd test`; `rtk npm.cmd run build`; `rtk git diff --check`

Expected: PASS.

- [ ] **Step 3: Store the completed-plan outcome in Knowl**

Record a concise `state` item naming the guard module, audit/snapshot commands, verification commands, and commit hash. Do not store test logs or secret samples.
