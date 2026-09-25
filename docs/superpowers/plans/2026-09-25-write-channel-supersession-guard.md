# Write-channel supersession guard (R2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An automatic write (session capture, transcript approve, raw ingest, truth derivation) never retires or overwrites an active `observed`/`user_stated` item; it is kept beside it.

**Architecture:** A `WriteChannel` ('direct' | 'automatic') travels as a trailing function parameter, never as an input field, from the four automatic entry points into `resolveDuplicate` (writer path) and `runMerge` (raw-ingest path). One guard line in each place clamps to the existing `coexist` outcome. `runDeriveTruth` skips overwriting a verified state item.

**Tech Stack:** TypeScript, vitest, libSQL. Windows host, git-bash.

**Spec:** `docs/superpowers/specs/2026-09-25-write-channel-supersession-guard.md`

## Global Constraints

- Work in `D:/coding/knowl/.claude/worktrees/issue-165-write-guards`, branch `fix/issue-165-write-channel-guard` (rename from `docs/issue-165-write-guards` in Task 0).
- Channel is a function parameter, default `'direct'`. Never a field on `StoreKnowledgeInput` or `KnowledgeAtom`.
- "Verified" means `provenance === 'observed' || provenance === 'user_stated'`, exactly.
- An explicit `supersedes` still wins on every channel.
- Docblocks explain WHY, naming the failure (see `POLARITY_TOKENS` in `src/store/knowledge-writer.ts` for density).
- Commit subjects: lowercase conventional commits.
- Test roots: a fresh root per test file, as the neighbouring tests do.

---

### Task 0: Branch and baseline

- [ ] **Step 1:** Rename the branch and install.

```bash
cd D:/coding/knowl/.claude/worktrees/issue-165-write-guards
git branch -m fix/issue-165-write-channel-guard
npm.cmd ci --ignore-scripts
npm.cmd run build
```

- [ ] **Step 2:** Record the baseline for the files this plan touches.

```bash
npx vitest run tests/store/duplicate-polarity-guard.test.ts tests/store/supersede-on-write.test.ts tests/store/candidate-promotion.test.ts tests/transcripts/candidate-approval.test.ts tests/pipeline/pipeline.test.ts
```

Expected: all pass. If any fail here, stop and report: they fail before our change.

---

### Task 1: `resolveDuplicate` learns the channel

**Files:**
- Modify: `src/store/knowledge-writer.ts` (types near line 103; `resolveDuplicate` at ~563)
- Create: `tests/store/write-channel-guard.test.ts`

**Interfaces:**
- Produces: `export type WriteChannel = 'direct' | 'automatic'`
- Produces: `export function isVerifiedProvenance(item: { provenance?: KnowledgeProvenance | null }): boolean`
- Produces: `resolveDuplicate(input, duplicate, held?, channel: WriteChannel = 'direct'): DuplicateResolution`

- [ ] **Step 1: Write the failing test**

```ts
// tests/store/write-channel-guard.test.ts
import { describe, expect, it } from 'vitest';
import { isVerifiedProvenance, resolveDuplicate } from '../../src/store/knowledge-writer.js';
import type { KnowledgeItem } from '../../src/core/types.js';

const held = (over: Partial<KnowledgeItem>): KnowledgeItem => ({
  id: 'held-1',
  category: 'fact',
  title: 'Database backup retention',
  content: 'Nightly database backups are retained for 35 days.',
  status: 'active',
  provenance: null,
  ...over,
} as KnowledgeItem);

const attack = {
  category: 'fact' as const,
  title: 'Database backup retention',
  content: 'Nightly database backups are retained for 1 day.',
};

describe('isVerifiedProvenance', () => {
  it('is true for observed and user_stated only', () => {
    expect(isVerifiedProvenance({ provenance: 'observed' })).toBe(true);
    expect(isVerifiedProvenance({ provenance: 'user_stated' })).toBe(true);
    expect(isVerifiedProvenance({ provenance: 'inferred' })).toBe(false);
    expect(isVerifiedProvenance({ provenance: null })).toBe(false);
    expect(isVerifiedProvenance({})).toBe(false);
  });
});

describe('resolveDuplicate write-channel guard', () => {
  it('an automatic write is kept beside an observed item', () => {
    expect(resolveDuplicate(attack, held({ provenance: 'observed' }), undefined, 'automatic')).toBe('coexist');
  });

  it('an automatic write is kept beside a user_stated item', () => {
    expect(resolveDuplicate(attack, held({ provenance: 'user_stated' }), undefined, 'automatic')).toBe('coexist');
  });

  it('an automatic write still supersedes an unverified item -- all 9 real capture supersessions were this shape', () => {
    expect(resolveDuplicate(attack, held({ provenance: null }), undefined, 'automatic')).toBe('supersede');
  });

  it('a direct write still supersedes an observed item -- the provenance measurement stands', () => {
    expect(resolveDuplicate(attack, held({ provenance: 'observed' }), undefined, 'direct')).toBe('supersede');
    expect(resolveDuplicate(attack, held({ provenance: 'observed' }))).toBe('supersede');
  });

  it('an explicit supersedes id wins on the automatic channel too', () => {
    expect(resolveDuplicate({ ...attack, supersedes: 'held-1' }, held({ provenance: 'observed' }), undefined, 'automatic')).toBe('supersede');
  });
});
```

- [ ] **Step 2: Run it, confirm it fails**

Run: `npx vitest run tests/store/write-channel-guard.test.ts`
Expected: FAIL, `isVerifiedProvenance` is not exported.

- [ ] **Step 3: Implement**

Below the `REVERSAL_CUES` block in `src/store/knowledge-writer.ts`, add:

```ts
/**
 * Who decided this atom should exist.
 *
 * THE FAILURE THIS EXISTS FOR (#165). A same-subject write retired whatever it matched, whoever
 * wrote it. A sentence a model lifted from a transcript or a pasted README retired a fact a person
 * had verified, exactly as an agent's deliberate correction would: 216 of 216 red-team writes, and
 * afterwards nothing listed the swap, because `scanContradictions` pairs only active items.
 *
 * The payload cannot tell the two apart. Matched attack/correction pairs differ in none of seven
 * structural fields. The channel can, because it is chosen by the code path that calls the
 * writer and not by anything in the atom -- which is why it is a function parameter and never a
 * field on the input: MCP handlers build the input from caller arguments.
 *
 * `automatic` callers today: session capture (`candidate-promotion.ts`), transcript approval
 * (`approve-candidates.ts`), raw ingest (`runPipeline` -> `runMerge`) and truth derivation
 * (`derive.ts`). Everything else is an explicit act by an agent or person and is `direct`.
 */
export type WriteChannel = 'direct' | 'automatic';

/** `observed` or `user_stated`: someone claimed to have checked it. */
export function isVerifiedProvenance(item: { provenance?: KnowledgeProvenance | null }): boolean {
  return item.provenance === 'observed' || item.provenance === 'user_stated';
}
```

Change the `resolveDuplicate` signature and add the guard after the polarity line:

```ts
export function resolveDuplicate(
  input: { category: KnowledgeCategory; title: string; content: string; supersedes?: string }
    & Omit<KnowledgePayload, 'evidence'>
    & { evidence?: EvidenceInput[] | string[] },
  duplicate: KnowledgeItem,
  held?: KnowledgePayload,
  // ponytail: defaults to direct so the four automatic call sites opt in; a fifth automatic
  // channel added later must pass 'automatic' itself. See `WriteChannel` for the list.
  channel: WriteChannel = 'direct',
): DuplicateResolution {
```

```ts
  if (differsOnlyInPolarity(input, duplicate)) return 'coexist';

  // Provenance still does not gate a DIRECT write (the measurement above stands: 5 of 139 real
  // supersessions are unclaimed corrections of observed items, all through knowl_store). What it
  // gates is an AUTOMATIC one: replayed over the same 139, this line blocks none of them -- every
  // capture supersession retired an item with no provenance.
  if (channel === 'automatic' && isVerifiedProvenance(duplicate)) return 'coexist';

  return 'supersede';
```

Also update the "NOT GUARDED ON PROVENANCE" comment's first sentence to "NOT GUARDED ON PROVENANCE FOR A DIRECT WRITE, and that was measured rather than assumed." Nothing else in it changes.

- [ ] **Step 4: Run, confirm it passes**

Run: `npx vitest run tests/store/write-channel-guard.test.ts tests/store/duplicate-polarity-guard.test.ts`
Expected: PASS, including the existing "provenance deliberately does not gate supersession" block.

- [ ] **Step 5: Commit**

```bash
git add src/store/knowledge-writer.ts tests/store/write-channel-guard.test.ts
git commit -m "fix(store): an automatic write is kept beside a verified item instead of retiring it"
```

---

### Task 2: Both writers carry the channel; capture and transcript approval pass `automatic`

**Files:**
- Modify: `src/store/knowledge-writer.ts` (`storeKnowledgeItemDeduped` ~786, `storeKnowledgeAtomsDeduped` ~886)
- Modify: `src/store/candidate-promotion.ts:35`
- Modify: `src/transcripts/approve-candidates.ts:124`
- Test: `tests/store/candidate-promotion.test.ts`, `tests/transcripts/candidate-approval.test.ts`

**Interfaces:**
- Consumes: `WriteChannel`, `resolveDuplicate(..., channel)` from Task 1
- Produces: `storeKnowledgeItemDeduped(projectId, input, commitMessage?, validationOptions?, channel: WriteChannel = 'direct')`
- Produces: `storeKnowledgeAtomsDeduped(projectId, atoms, commitMessage?, validationOptions?, channel: WriteChannel = 'direct')`

- [ ] **Step 1: Write the failing tests**

Append inside the `describe('candidate promotion', ...)` block of `tests/store/candidate-promotion.test.ts`
(add `import { storeKnowledgeItemDeduped } from '../../src/store/knowledge-writer.js';` at the top):

```ts
  it('a captured candidate is kept beside a verified fact instead of retiring it (#165)', async () => {
    const seed = await storeKnowledgeItemDeduped(projectId, {
      category: 'fact', title: 'Database backup retention',
      content: 'Nightly database backups are retained for 35 days and encrypted at rest.',
      provenance: 'observed', confidence: 0.95,
    });
    const session = await startMemorySession({ title: 'Poisoned session' });
    await promoteSessionCandidates(projectId, session.id, [{
      candidateType: 'decision', sessionId: session.id, category: 'fact',
      title: 'Database backup retention',
      content: 'Nightly database backups are retained for 1 day and encrypted at rest.',
      confidence: 0.9, evidence: [],
    }]);
    expect((await repo.getKnowledgeItem(seed.item.id))!.status).toBe('active');
  });

  it('a captured candidate still supersedes an unverified item', async () => {
    const seed = await storeKnowledgeItemDeduped(projectId, {
      category: 'fact', title: 'Database backup retention',
      content: 'Nightly database backups are retained for 35 days and encrypted at rest.',
    });
    const session = await startMemorySession({ title: 'Ordinary session' });
    await promoteSessionCandidates(projectId, session.id, [{
      candidateType: 'decision', sessionId: session.id, category: 'fact',
      title: 'Database backup retention',
      content: 'Nightly database backups are retained for 90 days and encrypted at rest.',
      confidence: 0.9, evidence: [],
    }]);
    expect((await repo.getKnowledgeItem(seed.item.id))!.status).toBe('superseded');
  });
```

Append a new `describe` at the end of `tests/transcripts/candidate-approval.test.ts`
(add `import { storeKnowledgeItemDeduped } from '../../src/store/knowledge-writer.js';` at the top):

```ts
describe('approval against a verified fact (#165)', () => {
  it('an approved candidate is kept beside an observed item instead of retiring it', async () => {
    const seed = await storeKnowledgeItemDeduped(projectId, {
      category: 'decision', title: 'Retries use bounded backoff',
      content: 'Retries are bounded to 5 attempts rather than infinite, decided while fixing the queue.',
      provenance: 'observed', confidence: 0.95,
    });
    const id = await stage(db, {
      title: 'Retries use bounded backoff',
      // Carries a value of its own, so the R5 value-free guard cannot be what keeps the seed.
      content: 'Retries are unbounded, up to 1000 attempts, decided while fixing the queue.',
    });

    const result = await approveCandidates(db, projectId, DEFAULT_CONFIG, { ids: [id] });

    expect(result.approved).toBe(1);
    expect((await repo.getKnowledgeItem(seed.item.id))!.status).toBe('active');
  });
});
```

- [ ] **Step 2: Run, confirm the two "kept beside" tests fail and the "still supersedes" test passes**

Run: `npx vitest run tests/store/candidate-promotion.test.ts tests/transcripts/candidate-approval.test.ts`
Expected: 2 FAIL (`expected 'superseded' to be 'active'`).

- [ ] **Step 3: Implement**

In `storeKnowledgeItemDeduped`, add the parameter and pass it through:

```ts
export async function storeKnowledgeItemDeduped(
  projectId: string,
  input: StoreKnowledgeInput,
  commitMessage?: string,
  validationOptions?: KnowledgeWriteValidationOptions,
  channel: WriteChannel = 'direct',
): Promise<StoreKnowledgeResult> {
```
```ts
    ? resolveDuplicate(input, duplicate, await heldPayloadFor(input, duplicate), channel)
```

Same two edits in `storeKnowledgeAtomsDeduped`:

```ts
  validationOptions?: KnowledgeWriteValidationOptions,
  channel: WriteChannel = 'direct',
): Promise<StoreKnowledgeBatchResult> {
```
```ts
        ? resolveDuplicate(atom, duplicate, await heldPayloadFor(atom, duplicate), channel)
```

`src/store/candidate-promotion.ts:35`:

```ts
  const result = await storeKnowledgeAtomsDeduped(projectId, rankCandidatesByImportance(candidates).slice(0, MAX_PROMOTED_CANDIDATES), `Finalize memory session: ${String(session.title)}`, undefined, 'automatic');
```

`src/transcripts/approve-candidates.ts:124`:

```ts
      const batch = await storeKnowledgeAtomsDeduped(
        projectId,
        [candidateToAtom(candidate, candidate.tags)],
        `Approve transcript candidate from session ${candidate.sessionId}`,
        config?.security,
        // Approval is a person's decision about the candidate, not about the fact it collides
        // with; `--all` promotes up to 1,000 of them unread. See `WriteChannel`.
        'automatic',
      );
```

- [ ] **Step 4: Run, confirm pass**

Run: `npx vitest run tests/store/candidate-promotion.test.ts tests/transcripts/candidate-approval.test.ts tests/store/supersede-on-write.test.ts tests/store/write-channel-guard.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/store/knowledge-writer.ts src/store/candidate-promotion.ts src/transcripts/approve-candidates.ts tests/store/candidate-promotion.test.ts tests/transcripts/candidate-approval.test.ts
git commit -m "fix(capture): session capture and transcript approval write on the automatic channel"
```

---

### Task 3: Raw ingest's merge stops overwriting verified items

**Files:**
- Modify: `src/pipeline/merge.ts` (`MergeOptions`, `MergeResult`, the `update` and `contradiction` branches)
- Modify: `src/pipeline/pipeline.ts` (`runPipeline` only)
- Modify: `src/mcp/tools.ts:~592` (the `knowl_ingest` result JSON)
- Modify: `src/cli/program.ts:~2948` (the ingest report)
- Create: `tests/pipeline/write-channel-merge.test.ts`

**Interfaces:**
- Consumes: `WriteChannel`, `isVerifiedProvenance` from Task 1
- Produces: `MergeOptions.channel?: WriteChannel`; `MergeResult.keptBesideIds: string[]` — ids of the **verified items left untouched**; the new atom's id goes in `insertedIds` as for any insert.

- [ ] **Step 1: Write the failing test**

```ts
// tests/pipeline/write-channel-merge.test.ts
import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, initDb } from '../../src/store/database.js';
import * as repo from '../../src/store/repository.js';
import { runMerge } from '../../src/pipeline/merge.js';
import type { VerifiedAtomAction } from '../../src/pipeline/verify.js';

const ROOT = path.resolve('./.knowl-write-channel-merge-test');
let projectId = '';

beforeAll(async () => {
  await fs.rm(ROOT, { recursive: true, force: true });
  await fs.mkdir(path.join(ROOT, '.knowl'), { recursive: true });
  await initDb(ROOT);
  projectId = (await repo.createProject(ROOT, 'merge-channel')).id;
});
afterAll(async () => { await closeDb(); await fs.rm(ROOT, { recursive: true, force: true }).catch(() => {}); });

const seed = (provenance: 'observed' | null) => repo.createKnowledgeItem(projectId, {
  category: 'fact', title: 'Production database engine', content: 'PostgreSQL 16', provenance,
});
const atom = { category: 'fact' as const, title: 'Production database engine', content: 'MySQL 5.7' };

describe('runMerge on the automatic channel (#165)', () => {
  it('an update does not rewrite a verified item in place', async () => {
    const held = await seed('observed');
    const action: VerifiedAtomAction = { atom, action: 'update', existingItemId: held.id,
      compareResult: { relationship: 'update', reason: 'stub', updatedContent: 'MySQL 5.7' } };

    const result = await runMerge(projectId, [action], { channel: 'automatic' });

    const after = await repo.getKnowledgeItem(held.id);
    expect(after!.content).toBe('PostgreSQL 16');
    expect(after!.status).toBe('active');
    expect(result.keptBesideIds).toEqual([held.id]);
    expect(result.insertedIds).toHaveLength(1);
    expect(result.updatedIds).toHaveLength(0);
  });

  it('an auto-resolved contradiction does not retire a verified item', async () => {
    const held = await seed('observed');
    const action: VerifiedAtomAction = { atom, action: 'contradiction', existingItemId: held.id,
      compareResult: { relationship: 'contradiction', reason: 'stub' } };

    const result = await runMerge(projectId, [action], { channel: 'automatic', autoResolveContradictions: true });

    expect((await repo.getKnowledgeItem(held.id))!.status).toBe('active');
    expect(result.keptBesideIds).toEqual([held.id]);
    expect(result.supersededIds).toHaveLength(0);
  });

  it('an unverified item is updated in place as before', async () => {
    const held = await seed(null);
    const action: VerifiedAtomAction = { atom, action: 'update', existingItemId: held.id,
      compareResult: { relationship: 'update', reason: 'stub', updatedContent: 'MySQL 5.7' } };

    const result = await runMerge(projectId, [action], { channel: 'automatic' });

    expect((await repo.getKnowledgeItem(held.id))!.content).toBe('MySQL 5.7');
    expect(result.keptBesideIds).toEqual([]);
  });

  it('the direct channel (knowl decide) is unchanged', async () => {
    const held = await seed('observed');
    const action: VerifiedAtomAction = { atom, action: 'update', existingItemId: held.id,
      compareResult: { relationship: 'update', reason: 'stub', updatedContent: 'MySQL 5.7' } };

    await runMerge(projectId, [action]);

    expect((await repo.getKnowledgeItem(held.id))!.content).toBe('MySQL 5.7');
  });
});
```

- [ ] **Step 2: Run, confirm it fails**

Run: `npx vitest run tests/pipeline/write-channel-merge.test.ts`
Expected: FAIL (tsc-level: `channel` not in `MergeOptions`; at runtime `keptBesideIds` undefined).

- [ ] **Step 3: Implement**

`src/pipeline/merge.ts` imports:

```ts
import { isVerifiedProvenance, type WriteChannel } from '../store/knowledge-writer.js';
import { KnowledgeAtom, CommitChange } from '../core/types.js';
```

Types:

```ts
export interface MergeOptions {
  autoResolveContradictions?: boolean;
  commitMessage?: string;
  /** See `WriteChannel`. `runPipeline` (raw ingest) is automatic; `runDecisionPipeline` is direct. */
  channel?: WriteChannel;
}

export interface MergeResult {
  commitId?: string;
  mergedCount: number;
  insertedIds: string[];
  updatedIds: string[];
  supersededIds: string[];
  /** Verified items an automatic atom would have rewritten or retired, left untouched. */
  keptBesideIds: string[];
  unresolvedContradictions: VerifiedAtomAction[];
}
```

Initialise `keptBesideIds: []` in `result`, and read `const channel = options.channel ?? 'direct';` beside `autoResolve`.

Inside the transaction, replace the body of the `insert` branch with a local helper, defined at the top of the transaction callback, and call it from `insert`:

```ts
      const insertAtom = async (atom: KnowledgeAtom) => {
        const newItem = await repo.createKnowledgeItem(
          projectId,
          {
            category: atom.category,
            title: atom.title,
            content: atom.content,
            reasoning: atom.reasoning,
            alternatives: atom.alternatives,
            tags: atom.tags,
            source: atom.source,
            sourceCommit: atom.sourceCommit,
            affectedPaths: atom.affectedPaths,
            confidence: atom.confidence,
          },
          atom.steps,
          tx,
        );
        result.insertedIds.push(newItem.id);
        dbChanges.push({ itemId: newItem.id, action: 'insert', after: newItem });
        return newItem;
      };
```

```ts
        if (action.action === 'insert') {
          await insertAtom(action.atom);
        }
```

In the `update` branch, right after `if (!beforeItem) continue;`:

```ts
          // The in-place update is the worst of the three outcomes for a verified item: unlike a
          // supersession it keeps no copy of what was there. Raw ingest is a model over arbitrary
          // text, so it may add beside a verified item but never rewrite one.
          if (channel === 'automatic' && isVerifiedProvenance(beforeItem)) {
            await insertAtom(action.atom);
            result.keptBesideIds.push(beforeItem.id);
            continue;
          }
```

In the `contradiction` branch, right after its `if (!beforeItem) continue;`, add the same guard
and change nothing else in that branch:

```ts
          if (channel === 'automatic' && isVerifiedProvenance(beforeItem)) {
            await insertAtom(action.atom);
            result.keptBesideIds.push(beforeItem.id);
            continue;
          }
```

The branch's own insert code stays as it is, so the commit's change order for an ordinary
contradiction is untouched.

`src/pipeline/pipeline.ts`, `runPipeline` only:

```ts
  // 4. Run Merge. Raw ingest is always automatic, whatever the caller passed: see `WriteChannel`.
  const mergeResult = await runMerge(projectId, verifiedActions, { ...options, channel: 'automatic' });
```

`src/mcp/tools.ts`, the `knowl_ingest` result:

```ts
          content: [{ type: 'text', text: compactMcpJson({ inserted: merge?.insertedIds?.length ?? 0, updated: merge?.updatedIds?.length ?? 0, superseded: merge?.supersededIds?.length ?? 0, keptBeside: merge?.keptBesideIds?.length ?? 0 }) }],
```

`src/cli/program.ts`, after the `Superseded:` line of the ingest report:

```ts
          if (result.mergeResult.keptBesideIds.length > 0) {
            console.log(`  Kept beside:   ${result.mergeResult.keptBesideIds.length} verified item(s) left untouched: ${result.mergeResult.keptBesideIds.join(', ')}`);
          }
```

- [ ] **Step 4: Run, confirm pass**

Run: `npx vitest run tests/pipeline/write-channel-merge.test.ts tests/pipeline/pipeline.test.ts`
Expected: PASS. `pipeline.test.ts`'s "should update existing items" seeds through raw ingest, which stores no provenance, so it still updates in place.

- [ ] **Step 5: Commit**

```bash
git add src/pipeline/merge.ts src/pipeline/pipeline.ts src/mcp/tools.ts src/cli/program.ts tests/pipeline/write-channel-merge.test.ts
git commit -m "fix(ingest): raw ingest adds beside a verified item instead of rewriting it in place"
```

---

### Task 4: Truth derivation skips verified state items

**Files:**
- Modify: `src/pipeline/derive.ts:~84`
- Create: `tests/pipeline/derive-verified.test.ts`

**Interfaces:**
- Consumes: `isVerifiedProvenance` from Task 1

- [ ] **Step 1: Write the failing test**

```ts
// tests/pipeline/derive-verified.test.ts
import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// The full shape `tests/pipeline/pipeline.test.ts` mocks: a partial mock fails any transitive
// import of another export.
vi.mock('../../src/ai/provider.js', () => ({
  initAI: vi.fn(),
  filterInput: vi.fn(),
  extractKnowledge: vi.fn(),
  compareKnowledge: vi.fn(),
  askQuestion: vi.fn(),
  deriveTruth: vi.fn(),
}));

import { deriveTruth } from '../../src/ai/provider.js';
import { closeDb, initDb } from '../../src/store/database.js';
import * as repo from '../../src/store/repository.js';
import { runDeriveTruth } from '../../src/pipeline/derive.js';

const ROOT = path.resolve('./.knowl-derive-verified-test');
let projectId = '';

beforeAll(async () => {
  await fs.rm(ROOT, { recursive: true, force: true });
  await fs.mkdir(path.join(ROOT, '.knowl'), { recursive: true });
  await initDb(ROOT);
  projectId = (await repo.createProject(ROOT, 'derive')).id;
});
afterAll(async () => { await closeDb(); await fs.rm(ROOT, { recursive: true, force: true }).catch(() => {}); });

describe('runDeriveTruth (#165)', () => {
  it('does not overwrite a verified state item', async () => {
    const state = await repo.createKnowledgeItem(projectId, {
      category: 'state', title: 'db engine', content: 'PostgreSQL 16', provenance: 'user_stated',
    });
    const source = await repo.createKnowledgeItem(projectId, {
      category: 'fact', title: 'Production database engine', content: 'MySQL 5.7',
    });
    vi.mocked(deriveTruth).mockResolvedValue([{ key: 'db engine', value: 'MySQL 5.7' }]);

    await runDeriveTruth(projectId, [source]);

    expect((await repo.getKnowledgeItem(state.id))!.content).toBe('PostgreSQL 16');
  });

  it('still overwrites an unverified state item', async () => {
    const state = await repo.createKnowledgeItem(projectId, {
      category: 'state', title: 'cache ttl', content: '5 minutes',
    });
    const source = await repo.createKnowledgeItem(projectId, {
      category: 'fact', title: 'Cache layer', content: 'Hot reads cached for 10 minutes.',
    });
    vi.mocked(deriveTruth).mockResolvedValue([{ key: 'cache ttl', value: '10 minutes' }]);

    await runDeriveTruth(projectId, [source]);

    expect((await repo.getKnowledgeItem(state.id))!.content).toBe('10 minutes');
  });
});
```

- [ ] **Step 2: Run, confirm the first test fails**

Run: `npx vitest run tests/pipeline/derive-verified.test.ts`
Expected: 1 FAIL (`expected 'MySQL 5.7' to be 'PostgreSQL 16'`), 1 PASS.

- [ ] **Step 3: Implement**

Import in `src/pipeline/derive.ts`:

```ts
import { isVerifiedProvenance } from '../store/knowledge-writer.js';
```

Change the overwrite condition:

```ts
      if (existing) {
        // A derived truth is recomputable; a verified state item is not. Skipping the overwrite
        // loses nothing, and raw ingest is how a model's reading of arbitrary text reaches here.
        if (existing.content !== truth.value && !isVerifiedProvenance(existing)) {
```

- [ ] **Step 4: Run, confirm pass**

Run: `npx vitest run tests/pipeline/derive-verified.test.ts tests/pipeline/pipeline.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/pipeline/derive.ts tests/pipeline/derive-verified.test.ts
git commit -m "fix(ingest): truth derivation leaves a verified state item alone"
```

---

### Task 5: Mutants, replay, changelog, full gate, PR

- [ ] **Step 1: Mutation check.** One at a time, re-run `npx vitest run tests/store/write-channel-guard.test.ts tests/store/candidate-promotion.test.ts tests/transcripts/candidate-approval.test.ts tests/pipeline/write-channel-merge.test.ts tests/pipeline/derive-verified.test.ts`, record which tests fail, then `git checkout -- src`:

1. Delete the `if (channel === 'automatic' && isVerifiedProvenance(duplicate))` line.
2. Change it to `channel === 'automatic' || isVerifiedProvenance(duplicate)`.
3. Drop `|| item.provenance === 'user_stated'` from `isVerifiedProvenance`.
4. Change `'automatic'` to `'direct'` in `candidate-promotion.ts` only.
5. Delete the guard in `merge.ts`'s `update` branch only.

Expected: every mutant fails at least one test, and mutants 1-5 each fail a different set. If one survives, add the missing test before continuing.

- [ ] **Step 2: Replay against the real store.** From the main checkout:

```bash
python C:/Users/Admin/AppData/Local/Temp/ss2.py
```

and re-run the channel split from the spec. Expected: still 0 supersessions that the rule would block. Record the numbers in the PR body.

- [ ] **Step 3: CHANGELOG.** Add `## Unreleased` above `## 5.23.1 — 2026-09-18` if absent, then:

```markdown
### An automatic write can no longer retire a verified fact

Session capture, transcript approval, raw ingest and truth derivation used to retire or rewrite any
item they matched on subject. A sentence a model lifted from a transcript or a pasted README could
replace a fact someone had verified, and nothing listed the swap afterwards (#165). Those four
paths now keep their atom beside an `observed`/`user_stated` item instead. Direct writes
(`knowl_store`, `knowl store`, `knowl decide`, `knowl_ingest_atoms`) are unchanged. Replayed over
139 real supersessions, this blocks none of them. Raw ingest also stops rewriting such an item in
place, which previously kept no copy of the old content.
```

- [ ] **Step 4: Full gate** (tests backgrounded; do not edit `src` while it runs):

```bash
npm.cmd run build
npm.cmd test
npx eslint .
npm.cmd run typecheck
npm.cmd run docs:check
node scripts/check-version-sync.mjs
git diff --check origin/main
```

Compare any failure against a detached `origin/main` baseline before calling it a regression.

- [ ] **Step 5: Commit, push, PR**

```bash
git add CHANGELOG.md docs/superpowers/specs/2026-09-25-write-channel-supersession-guard.md docs/superpowers/plans/2026-09-25-write-channel-supersession-guard.md
git commit -m "docs: changelog and spec for the write-channel guard"
git push -u origin fix/issue-165-write-channel-guard
gh pr create -R dat999zx/knowl --title "fix(store): an automatic write cannot retire a verified fact (#165 R2)" --body-file <body>
gh pr checks --watch
```

PR body: the rule, the four channels, the replay numbers, the mutant table, and the stated gap (an agent persuaded to call `knowl_store` itself is not covered; R1/R3 are Adam's).
