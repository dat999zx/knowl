# Command Surface 5.0 — Plan C: Automatic Staging

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Knowledge written in a connected repo stages itself, corrections to published atoms re-stage themselves, and the irreversible step — sending — stays deliberate and cannot send anything a human was not shown.

**Architecture:** One post-commit seam in the repository layer fires `maybeAutoStage`, which is gated on config, exclusions and namespace. Push gains a snapshot: the confirmation prompt computes item ids plus both hashes, and the send refuses anything that moved. Auto-push consent lives in `knowlHome()`, never in committable config.

**Tech Stack:** TypeScript (ESM, Node ≥22), Vitest. **No new runtime dependencies.**

**Spec:** `docs/superpowers/specs/2026-08-11-command-surface-redesign-design.md` §4.3, §6.1, §6.1.1, §6.2, §6.4. Read §6.1.1 and §6.4 before Task 1.

**Depends on:** Plan A (`filterExcluded`, `unstagePublish`, `stage_state`), Plan B (the `knowl cloud` namespace, `cloud status`).

## Global Constraints

- Node `>=22`. ESM only — relative imports end in `.js`. **No new runtime dependencies.**
- Verification is `npm.cmd run build` **then** `npm.cmd test`. Finish with `git diff --check`.
- **`remote_version` is written by push and cleared only by retraction.** Nothing in this plan may touch it.
- **The auto-stage hook must never throw into its caller.** A write that succeeded must not report failure because a ledger row could not be added — the atom is durable by then, and the caller cannot tell what to retry. Swallow, and let `knowl doctor` report the drift. This mirrors `maybeAutoSync`, which swallows for the same reason.
- **Auto-push consent is machine-local.** `.knowl/config.json` is force-committable (`src/core/types.ts:282`), so a consent flag stored there would enable irreversible publishing for every clone and for CI.
- **The seam fires after the row commits, never inside the transaction.** A crash between them leaves an unstaged atom, which `knowl cloud stage` repairs. The reverse — a ledger row pointing at an item that was never committed — would push a phantom.

## File Structure

| File | Responsibility |
| --- | --- |
| `src/cloud/auto-stage.ts` | Create: the gate and the ledger write; returns what it staged |
| `src/store/knowledge-writer.ts` | Modify: fire the hook after `storeKnowledgeItemDeduped` and `storeKnowledgeAtomsDeduped` commit |
| `src/store/knowledge-actions.ts` | Modify: fire the hook after `updateKnowledgeItemWithCommit` writes its commit record |
| `src/cloud/consent.ts` | Create: machine-local auto-push consent under `knowlHome()` |
| `src/cloud/publish.ts` | Modify: snapshot binding with captured payloads, `MAX_BATCH` |
| `src/cloud/api-client.ts` | Modify: a publish-specific timeout, so a bulk write is not bounded by an auth number |
| `src/cli/auto-push.ts` | Create: the auto-push gate chain, CLI-only |
| `src/cli/program.ts` | Modify: `--yes` on push, `knowl cloud autopush`, `connect --no-auto-stage` |
| `src/core/doctor.ts` | Modify: report auto-stage drift, since the seam swallows its own failures |
| `src/core/types.ts` | Modify: `cloud.autoStage?: boolean` |

**`src/store/repository.ts` is deliberately absent from this table.** Task 2 explains why at length: it is called inside other people's transactions, and far more writers reach it than should ever stage.

---

### Task 1: The auto-stage gate

**Files:**
- Create: `src/cloud/auto-stage.ts`
- Modify: `src/core/types.ts` — add `autoStage?: boolean` to the `cloud` block
- Test: `tests/cloud/auto-stage.test.ts`

**Interfaces:**
- Consumes: `filterExcluded` (Plan A Task 2), `stageForPublish` / `restageForPublish` (Plan A Task 4)
- Produces: `maybeAutoStage(input: { projectRoot: string; config: ProjectConfig; itemId: string; namespace?: string; alreadyPublished: boolean }): Promise<void>`

`alreadyPublished` decides which ledger writer runs: a never-published atom takes `stageForPublish`, a published one takes `restageForPublish`, which is the only path that sends a correction (`ba85bbbc98964d68`).

- [ ] **Step 1: Write the failing test**

Create `tests/cloud/auto-stage.test.ts`:

```ts
import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, initDb } from '../../src/store/database.js';
import { listStaged } from '../../src/cloud/ledger.js';

const ROOT = path.resolve('./.knowl-auto-stage-root');
const WS = 'ws-auto';

const connected = (overrides: Record<string, unknown> = {}) => ({
  cloud: { apiHost: 'https://api.example.com', workspaceId: WS, repo: 'r', ...overrides },
}) as any;

describe('maybeAutoStage', () => {
  beforeEach(async () => {
    await fs.rm(ROOT, { recursive: true, force: true });
    await fs.mkdir(ROOT, { recursive: true });
    await initDb(ROOT);
  });

  afterEach(async () => {
    await closeDb();
    await fs.rm(ROOT, { recursive: true, force: true });
  });

  it('stages a new atom in a connected repo', async () => {
    const { maybeAutoStage } = await import('../../src/cloud/auto-stage.js');
    await maybeAutoStage({ projectRoot: ROOT, config: connected(), itemId: 'a', alreadyPublished: false });
    expect((await listStaged(WS)).map(r => r.itemId)).toEqual(['a']);
  });

  it('stages nothing when the repo is not connected', async () => {
    const { maybeAutoStage } = await import('../../src/cloud/auto-stage.js');
    await maybeAutoStage({ projectRoot: ROOT, config: {} as any, itemId: 'a', alreadyPublished: false });
    expect(await listStaged(WS)).toEqual([]);
  });

  it('stages nothing when autoStage is off', async () => {
    const { maybeAutoStage } = await import('../../src/cloud/auto-stage.js');
    await maybeAutoStage({
      projectRoot: ROOT, config: connected({ autoStage: false }), itemId: 'a', alreadyPublished: false,
    });
    expect(await listStaged(WS)).toEqual([]);
  });

  it('stages nothing for an excluded atom', async () => {
    const { excludeFromPublish } = await import('../../src/cloud/exclusions.js');
    await excludeFromPublish('a', 'machine-local');

    const { maybeAutoStage } = await import('../../src/cloud/auto-stage.js');
    await maybeAutoStage({ projectRoot: ROOT, config: connected(), itemId: 'a', alreadyPublished: false });
    expect(await listStaged(WS)).toEqual([]);
  });

  it('stages nothing for a session-namespace write', async () => {
    const { maybeAutoStage } = await import('../../src/cloud/auto-stage.js');
    await maybeAutoStage({
      projectRoot: ROOT, config: connected(), itemId: 'a', namespace: 'session', alreadyPublished: false,
    });
    expect(await listStaged(WS)).toEqual([]);
  });

  it('re-stages a published atom as a correction, preserving its version', async () => {
    const { publishedVersion, recordPushed, stageForPublish } = await import('../../src/cloud/ledger.js');
    await stageForPublish(['a'], WS, 'main');
    await recordPushed('a', WS, 5);

    const { maybeAutoStage } = await import('../../src/cloud/auto-stage.js');
    await maybeAutoStage({ projectRoot: ROOT, config: connected(), itemId: 'a', alreadyPublished: true });

    expect((await listStaged(WS)).map(r => r.itemId)).toEqual(['a']);
    expect(await publishedVersion('a', WS)).toBe(5);
  });

  it('queues nothing that already existed when the repo connected', async () => {
    // Spec §5.4 and §12.4. This is the regression that would break decision `ee191dd7db024bec`'s
    // promise -- "items already at workspace visibility stay local until an explicit publish.
    // There is nothing to migrate" -- and on this machine it would queue 171 already-promoted
    // atoms for the company the moment a repo connected.
    const { createKnowledgeItem } = await import('../../src/store/repository.js');
    await createKnowledgeItem(/* an item written while config has no `cloud` pointer */);

    // Now connect: write the pointer, and stage nothing as a side effect of it.
    const { runConnect } = await import('../../src/cloud/connect.js');
    await runConnect({ projectRoot: ROOT, apiHost: 'https://api.example.com', workspaceId: WS, api: stubApi() });

    expect(await listStaged(WS)).toEqual([]);
  });

  it('never throws, whatever goes wrong underneath', async () => {
    const { maybeAutoStage } = await import('../../src/cloud/auto-stage.js');
    // A workspace id that is not a string is the cheapest way to provoke a driver-level failure.
    await expect(maybeAutoStage({
      projectRoot: ROOT, config: connected({ workspaceId: null }), itemId: 'a', alreadyPublished: false,
    })).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm.cmd test -- tests/cloud/auto-stage.test.ts`
Expected: FAIL — cannot resolve `../../src/cloud/auto-stage.js`.

- [ ] **Step 3: Implement**

Add to `src/core/types.ts`, inside the `cloud` block after `remote`:

```ts
    /**
     * Stage new knowledge as it is written. Defaults to on when a repo is connected.
     *
     * Safe to commit, unlike auto-push consent: staging sends nothing, is visible in
     * `knowl cloud status`, and is reversible with `knowl cloud unstage`.
     */
    autoStage?: boolean;
```

Create `src/cloud/auto-stage.ts`:

```ts
import type { ProjectConfig } from '../core/types.js';
import { currentBranch } from './publish-gate.js';
import { filterExcluded } from './exclusions.js';
import { restageForPublish, stageForPublish } from './ledger.js';

/**
 * Queue an atom for the team, if this repo is connected and nothing says otherwise.
 *
 * Runs AFTER the item's own write has committed. A crash between the two leaves an atom that is
 * not staged, which `knowl cloud stage` repairs; staging first and crashing would leave a ledger
 * row pointing at an item that does not exist, which a push would send as a phantom.
 *
 * Never throws. The write that triggered this already succeeded and is durable, so reporting a
 * failure here would tell the caller to retry something that worked. `knowl doctor` reports the
 * drift instead -- the same trade `maybeAutoSync` makes, for the same reason.
 */
export async function maybeAutoStage(input: {
  projectRoot: string;
  config: ProjectConfig;
  itemId: string;
  namespace?: string;
  alreadyPublished: boolean;
}): Promise<void> {
  try {
    const pointer = input.config.cloud;
    if (!pointer) return;
    // Absent means on. Only an explicit false turns it off, so a repo connected before this
    // setting existed behaves like one connected after.
    if (input.config.cloud?.autoStage === false) return;
    // Session knowledge is transient by construction and expires on its own.
    if (input.namespace === 'session') return;

    const allowed = await filterExcluded([input.itemId]);
    if (allowed.length === 0) return;

    const branch = currentBranch(input.projectRoot);
    if (input.alreadyPublished) {
      await restageForPublish(allowed, pointer.workspaceId, branch);
    } else {
      await stageForPublish(allowed, pointer.workspaceId, branch);
    }
  } catch {
    // Deliberately swallowed. See the docblock.
  }
}
```

If `publish-gate.ts` exports the branch reader under a different name, use that name — read the module rather than assuming `currentBranch`.

- [ ] **Step 4: Run it and watch it pass**

Run: `npm.cmd test -- tests/cloud/auto-stage.test.ts`
Expected: PASS, all seven cases.

- [ ] **Step 5: Commit**

```bash
git add src/cloud/auto-stage.ts src/core/types.ts tests/cloud/auto-stage.test.ts
git commit -m "feat(cloud): the auto-stage gate, which stages nothing it was not asked to"
```

---

### Task 2: Fire the seam at the transaction owner, and prove what it does not cover

**Files:**
- Modify: `src/store/knowledge-writer.ts` — after `storeKnowledgeItemDeduped`'s transaction (line 439) and `storeKnowledgeAtomsDeduped`'s (line 516) commit
- Modify: `src/store/knowledge-actions.ts` — after `updateKnowledgeItemWithCommit` (line 125) writes its commit record; check `recordDecisionDirect` in the same file
- **Not** `src/store/repository.ts`
- Test: `tests/cloud/auto-stage-seam.test.ts`

**Interfaces:**
- Consumes: `maybeAutoStage` (Task 1)

**The repository layer is the wrong seam, on two independent counts. Both were checked in the code.**

**1. It is not post-commit.** `repository.ts:481-486` ends every write with

```ts
  if (dbConnection) {
    return await operation(dbConnection);       // <- the CALLER's open transaction
  } else {
    return await withClientTransaction(operation);
  }
```

so when a caller passes `dbConnection` the function returns *inside* that caller's transaction, which has not committed and may still roll back. And the main write path does exactly that: `storeKnowledgeItemDeduped` opens `withClientTransaction` at `knowledge-writer.ts:439` and passes `conn` into `repo.createKnowledgeItem` at `:459`. So a hook in `createKnowledgeItem` fires mid-transaction, every time, on the path that matters most — violating this plan's own global constraint and staging atoms a rollback would then erase. The ledger row would survive, because it is written on a different connection, and the push would send a phantom.

**2. Far more writers reach it than should stage.** `repo.updateKnowledgeItem` is called directly by `gc.ts:346,354` (archival), `drift.ts:114`, `blast-radius.ts:176` (`freshness: 'needs_review'`), `merge.ts:90,140`, `derive.ts:86`, and `session-handoff.ts:380,508`. Every one of those moves the lifecycle hash, so the `changed` guard would not stop them: garbage collection archiving an atom, a drift sweep marking one stale, and a session handoff being recorded would each queue something for the team. §6.1.1's exclusion list is not expressible at this layer at all.

**The transaction owners are the seam.** Three sites, each of which returns only after its own commit:

| Site | Covers | Seam point |
| --- | --- | --- |
| `storeKnowledgeItemDeduped` (`knowledge-writer.ts:418`) | `knowl_store`, `knowl store`, every single-atom write | after the `withClientTransaction` at `:439` returns |
| `storeKnowledgeAtomsDeduped` (`knowledge-writer.ts:502`) | `knowl_ingest_atoms` | after the `withClientTransaction` at `:516` returns |
| `updateKnowledgeItemWithCommit` (`knowledge-actions.ts:125`) | `knowl_update` | after `createKnowledgeCommit` at `:183` — `repo.updateKnowledgeItem` is called at `:163` with `dbConnection` undefined, so it has already committed |

Everything else — GC, drift, blast radius, merge, derive, handoff, import, `workspace promote` — reaches none of these three and therefore stages nothing, **structurally rather than by a guard that has to be maintained**. That is the property this task is buying, and the test below is what pins it.

- [ ] **Step 0: Confirm the fourth site before writing anything**

`recordDecisionDirect` (`knowledge-actions.ts`, the `knowl_decide` path) writes through the repository rather than through `knowledge-writer` — its own comment at `:118-121` says so. Read it. If it commits before returning, it is a fourth seam site and gets the same call; if it delegates to `storeKnowledgeItemDeduped`, it is already covered. Do not guess: a decision that silently never stages is exactly the kind of gap this plan exists to close.

- [ ] **Step 1: Write the failing test**

Create `tests/cloud/auto-stage-seam.test.ts`. Build every case through the **real entry point**, never by calling `maybeAutoStage` directly — the point of this task is the wiring, and a test that calls the hook proves nothing about whether the hook is called.

```ts
  it('a knowl_store-shaped write stages', async () => {
    const { storeKnowledgeItemDeduped } = await import('../../src/store/knowledge-writer.js');
    const result = await storeKnowledgeItemDeduped(projectId, atom({ title: 'staged' }), 'Store fact');
    expect((await listStaged(WS)).map(row => row.itemId)).toEqual([result.item.id]);
  });

  it('an update to a published atom stages a correction and keeps its version', async () => {
    const { storeKnowledgeItemDeduped } = await import('../../src/store/knowledge-writer.js');
    const { recordPushed, publishedVersion } = await import('../../src/cloud/ledger.js');
    const { updateKnowledgeItemWithCommit } = await import('../../src/store/knowledge-actions.js');

    const { item } = await storeKnowledgeItemDeduped(projectId, atom({ title: 'known' }), 'Store fact');
    await recordPushed(item.id, WS, 5);

    await updateKnowledgeItemWithCommit(projectId, item.id, { content: 'materially different' });

    expect((await listStaged(WS)).map(row => row.itemId)).toEqual([item.id]);
    expect(await publishedVersion(item.id, WS)).toBe(5);
  });

  it('a metadata-only update stages nothing, because neither hash moved', async () => {
    const { storeKnowledgeItemDeduped } = await import('../../src/store/knowledge-writer.js');
    const { unstagePublish } = await import('../../src/cloud/ledger.js');
    const { updateKnowledgeItemWithCommit } = await import('../../src/store/knowledge-actions.js');

    const { item } = await storeKnowledgeItemDeduped(projectId, atom({ title: 't' }), 'Store fact');
    await unstagePublish(item.id, WS);

    await updateKnowledgeItemWithCommit(projectId, item.id, { source: 'a new label' });

    expect(await listStaged(WS)).toEqual([]);
  });

  /**
   * The exclusion list from §6.1.1, asserted as one table.
   *
   * Each of these reaches `repo.updateKnowledgeItem` directly and moves the lifecycle hash, so a
   * seam in the repository layer would have staged every one of them -- garbage collection
   * queueing archived atoms for the team is the worst of them, and none would have been caught by
   * a `changed` guard. They stage nothing here because they route through none of the three
   * transaction owners, which is a structural property and not a maintained list of exceptions.
   */
  it.each([
    ['garbage collection archiving an atom', archiveViaGc],
    ['a drift sweep marking one stale', markStaleViaDrift],
    ['blast radius flagging one for review', flagViaBlastRadius],
    ['an import', importOneAtom],
    ['workspace promote', promoteOne],
  ])('%s stages nothing', async (_name, act) => {
    const { storeKnowledgeItemDeduped } = await import('../../src/store/knowledge-writer.js');
    const { unstagePublish } = await import('../../src/cloud/ledger.js');
    const { item } = await storeKnowledgeItemDeduped(projectId, atom({ title: 't' }), 'Store fact');
    await unstagePublish(item.id, WS);

    await act(item.id);

    expect(await listStaged(WS)).toEqual([]);
  });
```

Write `atom()` and the five act helpers from the shapes the existing suites already build — `tests/store/knowledge-writer.test.ts`, `tests/store/gc.test.ts`, `tests/store/drift.test.ts`, `tests/store/portability.test.ts`, `tests/workspace/promote.test.ts`. Do not invent a shape, and do not stub these five: a stub proves the stub does not stage.

- [ ] **Step 2: Run it and watch it fail**

Run: `npm.cmd test -- tests/cloud/auto-stage-seam.test.ts`
Expected: FAIL on the first three cases (nothing stages, because the hook is not wired). The five exclusion cases pass already — that is correct and they are there to *stay* passing.

- [ ] **Step 3: Implement**

In `storeKnowledgeItemDeduped`, after the `withClientTransaction` block returns and before the function's own return:

```ts
  // After the commit, outside the transaction, deliberately. `withClientTransaction` has
  // returned by here, so the item is durable; firing inside it would stage an atom a rollback
  // then erased, and the ledger write is on a different connection so it would survive.
  await maybeAutoStage({
    projectRoot: getConfigRoot(), config, itemId: item.id, namespace, alreadyPublished: false,
  });
```

The same shape in `storeKnowledgeAtomsDeduped`, once per written atom — or better, extend `maybeAutoStage` to take `itemIds: string[]` so a batch is one `filterExcluded` and one ledger write rather than N of each. Task 1's `filterExcluded` already takes an array for exactly this reason.

In `updateKnowledgeItemWithCommit`, after `createKnowledgeCommit`:

```ts
  // Only when the atom changed what it asserts. The content hash covers the text; the lifecycle
  // hash covers status and supersession, which is why it exists (`4bd5aec20a684cc1`). A source
  // label or a freshness stamp moving is not a correction the team needs.
  const changed = updated.contentHash !== beforeItem.contentHash
    || updated.lifecycleHash !== beforeItem.lifecycleHash;
  if (changed) {
    await maybeAutoStage({
      projectRoot: options?.projectRoot ?? getConfigRoot(),
      config,
      itemId: id,
      alreadyPublished: (await publishedVersion(id, config?.cloud?.workspaceId ?? '')) !== null,
    });
  }
```

**Threading `config`.** None of the three sites currently receives `ProjectConfig`. Thread it from the callers rather than loading config inside the store layer — a `loadConfig` call on every write would put a file read on the hot path and give `knowledge-writer` a dependency it has never had. `src/mcp/tools.ts` already holds `config` at every call site, and the CLI actions load it. Where a caller genuinely has none (tests, pipelines), the parameter is optional and `maybeAutoStage` returns immediately on a missing `cloud` pointer, which is the behaviour those callers want anyway.

- [ ] **Step 4: Run it and watch it pass**

Run: `npm.cmd test -- tests/cloud/auto-stage-seam.test.ts`
Expected: PASS, all eight cases.

- [ ] **Step 5: Run the whole suite**

Run: `npm.cmd test`
Expected: green. This task changes the function every write path uses; a failure elsewhere is this task's fault and must be fixed here rather than deferred. Pay particular attention to `tests/store/gc.test.ts` and `tests/mcp/` — if either now sees staged rows, the seam went in one layer too low.

- [ ] **Step 6: Commit**

```bash
git add src/store/knowledge-writer.ts src/store/knowledge-actions.ts src/mcp/tools.ts \
  tests/cloud/auto-stage-seam.test.ts
git commit -m "feat(cloud): stage on write, at the transaction owner, and not from maintenance"
```

---

### Task 3: Machine-local auto-push consent

**Files:**
- Create: `src/cloud/consent.ts`
- Modify: `src/cli/program.ts` — `knowl cloud autopush <on|off>`
- Test: `tests/cloud/consent.test.ts`

**Interfaces:**
- Produces:
  - `readAutoPushConsent(workspaceId: string): Promise<boolean>`
  - `writeAutoPushConsent(workspaceId: string, enabled: boolean): Promise<void>`
  - `consentPath(): string` — `knowlHome()/cloud-consent.json`

- [ ] **Step 1: Write the failing test**

Create `tests/cloud/consent.test.ts`:

```ts
  it('defaults to off', async () => {
    const { readAutoPushConsent } = await import('../../src/cloud/consent.js');
    expect(await readAutoPushConsent('ws-1')).toBe(false);
  });

  it('round-trips per workspace', async () => {
    const { readAutoPushConsent, writeAutoPushConsent } = await import('../../src/cloud/consent.js');
    await writeAutoPushConsent('ws-1', true);
    expect(await readAutoPushConsent('ws-1')).toBe(true);
    expect(await readAutoPushConsent('ws-2')).toBe(false);
  });

  it('lives in knowlHome, never in the repository', async () => {
    const { consentPath } = await import('../../src/cloud/consent.js');
    const { knowlHome } = await import('../../src/core/paths.js');
    expect(consentPath().startsWith(knowlHome())).toBe(true);
  });

  it('a corrupt file reads as off rather than throwing', async () => {
    const { consentPath, readAutoPushConsent } = await import('../../src/cloud/consent.js');
    await fs.writeFile(consentPath(), 'not json', 'utf8');
    expect(await readAutoPushConsent('ws-1')).toBe(false);
  });
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm.cmd test -- tests/cloud/consent.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement**

Create `src/cloud/consent.ts`, mirroring `credentials.ts`'s file handling (atomic write, unreadable-reads-as-empty):

```ts
import fs from 'node:fs/promises';
import path from 'node:path';
import { writeFileAtomic } from '../core/atomic-write.js';
import { knowlHome } from '../core/paths.js';

type ConsentFile = { version: 1; workspaces: Record<string, boolean> };

/**
 * Standing permission to publish without a prompt, per machine and per workspace.
 *
 * NOT in `.knowl/config.json`, and that is the whole point. That file is deliberately
 * force-committable so a workspace pointer travels with a clone (`src/core/types.ts:282`), so a
 * consent flag stored there would be committed by one person and would then enable irreversible
 * automatic publishing for every teammate who clones and for CI -- none of whom agreed to it.
 * Consent is exactly as personal as the credential it authorises, and lives beside it.
 */
export function consentPath(): string {
  return path.join(knowlHome(), 'cloud-consent.json');
}

async function readFileOrEmpty(): Promise<ConsentFile> {
  try {
    const parsed = JSON.parse(await fs.readFile(consentPath(), 'utf8')) as ConsentFile;
    if (!parsed || typeof parsed !== 'object' || !parsed.workspaces) return { version: 1, workspaces: {} };
    return parsed;
  } catch {
    // Absent, unreadable or hand-edited. Reading as "no consent" is the safe direction for a
    // permission to do something irreversible.
    return { version: 1, workspaces: {} };
  }
}

export async function readAutoPushConsent(workspaceId: string): Promise<boolean> {
  return (await readFileOrEmpty()).workspaces[workspaceId] === true;
}

export async function writeAutoPushConsent(workspaceId: string, enabled: boolean): Promise<void> {
  const file = await readFileOrEmpty();
  file.workspaces[workspaceId] = enabled;
  await writeFileAtomic(consentPath(), JSON.stringify(file, null, 2));
}
```

Add the CLI verb under `cloudCommand`:

```ts
cloudCommand
  .command('autopush <state>')
  .description('Turn automatic pushing on or off for this machine and this workspace')
  .action(async (state: string) => {
    if (state !== 'on' && state !== 'off') {
      console.error('Expected on or off.');
      process.exit(1);
    }
    const root = await findProjectRoot(process.cwd());
    const config = await loadConfig(root);
    if (!config.cloud) {
      console.error('This repository is not connected to a cloud workspace.');
      process.exit(1);
    }
    await writeAutoPushConsent(config.cloud.workspaceId, state === 'on');
    console.log(state === 'on'
      ? `Automatic push enabled for ${config.cloud.workspaceName ?? config.cloud.workspaceId} on this machine.\nThis machine will now send without asking. It applies to you only — it is not committed.`
      : `Automatic push disabled for ${config.cloud.workspaceName ?? config.cloud.workspaceId}.`);
  });
```

- [ ] **Step 4: Run it and watch it pass**

Run: `npm.cmd test -- tests/cloud/consent.test.ts`
Expected: PASS, all four cases.

- [ ] **Step 5: Prove it never travels**

Add to the same test file:

```ts
  it('enabling consent changes nothing in the repository', async () => {
    const before = await fs.readFile(path.join(ROOT, '.knowl', 'config.json'), 'utf8');
    const { writeAutoPushConsent } = await import('../../src/cloud/consent.js');
    await writeAutoPushConsent('ws-1', true);
    expect(await fs.readFile(path.join(ROOT, '.knowl', 'config.json'), 'utf8')).toBe(before);
  });
```

This is spec §12.9 and it is the only thing that stops this regressing back into project config.

- [ ] **Step 6: Commit**

```bash
git add src/cloud/consent.ts src/cli/program.ts tests/cloud/consent.test.ts
git commit -m "feat(cloud): auto-push consent is per machine and never committed"
```

---

### Task 4: Snapshot-bound push

**Files:**
- Modify: `src/cloud/publish.ts` — `pushStaged` (the live `listStaged` read at line 164), `MAX_BATCH` (line 140)
- Modify: `src/cli/program.ts` — `--yes` on `cloud push`
- Test: `tests/cloud/publish-snapshot.test.ts`

**Interfaces:**
- Produces:
  - `type PushSnapshot = { items: Array<{ itemId: string; contentHash: string | null; lifecycleHash: string | null; payload: PublishItem }> }`
  - `computePushSnapshot(workspaceId: string): Promise<PushSnapshot>`
  - `pushStaged` input gains `snapshot?: PushSnapshot` and `strict?: boolean`; result gains `{ status: 'snapshot-stale'; added: string[]; changed: string[]; unstaged: string[] }`

**The snapshot carries the payload, and that is the fix.** An earlier draft stored only the two hashes and then re-derived what to send from a *separate* live read, which leaves two windows open:

- `pushStaged` reads `listStaged` at `publish.ts:166`, and the snapshot check would call `computePushSnapshot` — a second `listStaged` — some lines later. An atom unstaged between those two reads is absent from the second and still present in the first, and the send filters the first. It goes out after being unstaged.
- Even with the hashes agreeing, `loadPublishItem` (`publish.ts:199`) re-reads the row *after* the comparison. Content that changes in that gap is sent unverified, which is the whole class of bug the snapshot exists to close.

Capturing the payload at snapshot time collapses both: what was hashed, what was shown, and what is sent are one object that nothing can edit in between.

- [ ] **Step 1: Write the failing test**

Create `tests/cloud/publish-snapshot.test.ts`:

```ts
  it('sends only what the snapshot listed', async () => {
    await stageForPublish(['a'], WS, 'main');
    const snapshot = await computePushSnapshot(WS);

    // Another process stages something while the prompt is open.
    await stageForPublish(['b'], WS, 'main');

    const sent: string[] = [];
    await pushStaged({ projectRoot: ROOT, config: connected(), snapshot, api: apiRecording(sent) });

    expect(sent).toEqual(['a']);
  });

  it('refuses when a listed atom changed under the prompt', async () => {
    await stageForPublish(['a'], WS, 'main');
    const snapshot = await computePushSnapshot(WS);

    await mutateContentHash('a', 'different');

    const result = await pushStaged({ projectRoot: ROOT, config: connected(), snapshot, api: apiRecording([]) });
    expect(result.status).toBe('snapshot-stale');
    expect((result as any).changed).toEqual(['a']);
  });

  it('reports an addition as stale rather than silently dropping it', async () => {
    await stageForPublish(['a'], WS, 'main');
    const snapshot = await computePushSnapshot(WS);
    await stageForPublish(['b'], WS, 'main');

    const result = await pushStaged({
      projectRoot: ROOT, config: connected(), snapshot, api: apiRecording([]), strict: true,
    });
    expect(result.status).toBe('snapshot-stale');
    expect((result as any).added).toEqual(['b']);
  });

  it('does not send an atom that was unstaged while the prompt was open', async () => {
    await stageForPublish(['a', 'b'], WS, 'main');
    const snapshot = await computePushSnapshot(WS);

    // The user, or another process, changed their mind about one of them.
    await unstagePublish('a', WS);

    const sent: string[] = [];
    const result = await pushStaged({ projectRoot: ROOT, config: connected(), snapshot, api: apiRecording(sent) });

    expect(sent).toEqual(['b']);
    expect((result as any).unstaged ?? []).not.toContain('b');
  });

  it('sends the bytes the snapshot captured, not a fresh read of the row', async () => {
    await stageForPublish(['a'], WS, 'main');
    const snapshot = await computePushSnapshot(WS);

    // Content moves, but the hashes are left alone -- the shape of a write that slips between
    // the comparison and the load. Only sending the captured payload survives this.
    await mutateContentLeavingHashes('a', 'text nobody confirmed');

    const bodies: string[] = [];
    await pushStaged({ projectRoot: ROOT, config: connected(), snapshot, api: apiRecordingBodies(bodies) });

    expect(bodies[0]).not.toContain('text nobody confirmed');
  });

  it('without a snapshot, behaves exactly as before', async () => {
    await stageForPublish(['a', 'b'], WS, 'main');
    const sent: string[] = [];
    await pushStaged({ projectRoot: ROOT, config: connected(), api: apiRecording(sent) });
    expect(sent.sort()).toEqual(['a', 'b']);
  });
```

Write `apiRecording`, `apiRecordingBodies`, `mutateContentHash` and `mutateContentLeavingHashes` as local helpers in this file. The last one writes `knowledge_items.content` with raw SQL so the hash columns stay put — going through the writer would move them and the test would pass for the wrong reason.

**Note the deliberate asymmetry the second and third cases pin.** A *changed* atom always refuses — its text is not what was shown. An *added* atom is merely absent from this push by default, because it will go in the next one and refusing would make a busy agent's writes block every push. `strict: true` turns additions into refusals too, and the CLI passes it so an interactive user re-reads a prompt whose list grew.

- [ ] **Step 2: Run it and watch it fail**

Run: `npm.cmd test -- tests/cloud/publish-snapshot.test.ts`
Expected: FAIL — `computePushSnapshot` is not exported.

- [ ] **Step 3: Implement**

In `src/cloud/publish.ts`:

```ts
/**
 * What a confirmation prompt was shown, as a thing that can be checked later.
 *
 * `pushStaged` reads `listStaged` live, and a long-lived MCP server writes to that queue
 * continuously once auto-staging is on -- so between drawing a prompt and reading the answer,
 * another process can stage new atoms or rewrite the text of listed ones. Confirming a live read
 * would send items and content nobody was shown. This risk did not exist when staging was manual
 * and rare; auto-staging is what created it.
 */
export type PushSnapshot = {
  items: Array<{
    itemId: string;
    contentHash: string | null;
    lifecycleHash: string | null;
    /**
     * The exact bytes that will be sent, captured here rather than re-read at send time.
     *
     * This is the whole mechanism. Comparing hashes and then loading the payload separately
     * leaves a window between the comparison and the load, and content that moves inside it goes
     * out unverified -- the same bug the comparison was added to prevent, one line further down.
     */
    payload: PublishItem;
  }>;
};

export async function computePushSnapshot(workspaceId: string): Promise<PushSnapshot> {
  const staged = await listStaged(workspaceId);
  const hashes = await readHashes(staged.map(row => row.itemId));
  const items: PushSnapshot['items'] = [];
  for (const row of staged) {
    const payload = await loadPublishItem(row.itemId, workspaceId);
    // A staged id whose row is gone cannot be shown and cannot be sent. It stays in the ledger
    // -- see `pushStaged`'s own note on why the intent is not swept -- but it is not part of
    // what the user is about to confirm.
    if (!payload) continue;
    items.push({
      itemId: row.itemId,
      contentHash: hashes.get(row.itemId)?.contentHash ?? null,
      lifecycleHash: hashes.get(row.itemId)?.lifecycleHash ?? null,
      payload,
    });
  }
  return { items };
}
```

Write `readHashes` as one `SELECT id, content_hash, lifecycle_hash FROM knowledge_items WHERE id IN (...)` returning a `Map`.

In `pushStaged`, replace the existing `const staged = await listStaged(...)` usage with a single reconciliation. There must be **exactly one** live read after the snapshot, and the send must draw from the snapshot:

```ts
    // One live read, used for every comparison below. Two reads is what let an atom unstaged
    // between them be sent anyway: absent from the second, present in the first, and the send
    // filtered the first.
    const current = await computePushSnapshot(pointer.workspaceId);

    let sendable: PublishItem[];
    if (input.snapshot) {
      const promised = new Map(input.snapshot.items.map(item => [item.itemId, item]));
      const live = new Map(current.items.map(item => [item.itemId, item]));

      const changed = [...promised.keys()].filter(id => {
        const now = live.get(id);
        if (!now) return false;                       // gone, not changed -- reported below
        const was = promised.get(id)!;
        return was.contentHash !== now.contentHash || was.lifecycleHash !== now.lifecycleHash;
      });
      const added = [...live.keys()].filter(id => !promised.has(id));
      const unstaged = [...promised.keys()].filter(id => !live.has(id));

      // A changed atom always refuses: its text is not what the human read. An addition only
      // refuses under `strict`, because it will go in the next push either way and refusing by
      // default would let a busy agent block every push it runs beside.
      if (changed.length > 0 || (input.strict && added.length > 0)) {
        return { status: 'snapshot-stale', added, changed, unstaged };
      }

      // Sent from the SNAPSHOT, intersected with what is still staged. The payload is the object
      // that was hashed and shown; nothing re-reads the row between the check and the send, and
      // an atom unstaged while the prompt was open is dropped rather than sent.
      sendable = input.snapshot.items
        .filter(item => live.has(item.itemId))
        .map(item => item.payload);
    } else {
      sendable = current.items.map(item => item.payload);
    }
```

Delete the old `for (const record of staged) { const item = await loadPublishItem(...) }` loop — `computePushSnapshot` now does that work, once — and use `sendable` everywhere `items` was used below. The empty-queue early return moves above this block and keys on `current.items.length === 0`.

**STOP: the premise under this whole section is stale. Verified 2026-08-12 against knowl-cloud's tree.**

`MAX_BATCH = 25` and Codex's finding that 25 atoms take ~52 seconds both derive from `59d964ba2ac14798` — "200 atoms of realistic prose at 1564 MB peak, 418 seconds, a property of `publishItems` embedding inline and synchronously inside the request". **That has not been true since 2026-08-09.** knowl-cloud commit `a2d7413` ("index in the background, round-robin across workspaces") moved the forward pass into `src/knowledge/embedding/queue.ts`; `src/knowledge/publish.ts:171` now calls `enqueueIndexing` and returns. It shipped in `v0.1.0` on 2026-08-10, before every tag currently cut.

So publish returns after its transaction commits, not after 418 seconds of CPU, and **no arithmetic derived from 2.1 seconds per atom describes the server that exists.** That includes Codex's 52-second figure and it includes the 10 this section originally chose.

**What to do instead.** A bound is still wanted — an unbounded batch is an unbounded transaction on a shared database, which is what `MAX_BATCH`'s own docblock says and is still true. But it must be sized by **payload size and transaction time**, measured against the current server, not inferred from a superseded embedding cost. `docs/superpowers/specs/2026-08-12-client-side-embedding-design.md` §11.4 already names this as an open question requiring exactly that measurement.

**Until that measurement exists, leave `MAX_BATCH` at 200 and change nothing here.** It is the contract's own cap, it has no known failure against a server that does not embed inline, and replacing it with a smaller number derived from a dead premise would turn a 1,000-atom publish into 100 round trips for no reason. The client timeout question below dissolves with it: a request that does not wait on a forward pass does not need 120 seconds.

Everything from here to the end of Step 3 is retained only as the record of what was believed, and **must not be implemented**:

---

**Lower `MAX_BATCH`, and give publishing its own timeout.** These two numbers are one decision: with the batch at 25 and the client timeout at 30 seconds, the plan's own estimate (52 seconds for 25 atoms) exceeds the abort by 22 seconds, so every full batch would fail on the client while the server kept working.

```ts
/**
 * Well below the size measured as unsurvivable, and below what the timeout permits.
 *
 * knowl-cloud fact `f77ce73dcb914744` measured 200 atoms of realistic prose at 1564 MB peak and
 * 418 seconds, because `publishItems` embeds inline and synchronously inside the request -- and
 * this constant WAS 200, so a full-repo publish was guaranteed to collide with it. That collision
 * reached production on 2026-08-11: the first 200-atom batch OOM-killed the origin and the
 * remainder returned 502. Auto-staging makes large queues routine rather than exceptional, which
 * is why this moves now.
 *
 * 418s/200 is roughly 2.1 seconds per atom, so 10 is about 21 seconds -- inside PUBLISH_TIMEOUT_MS
 * below with room for a slow atom, where 25 would have been about 52 seconds and aborted on the
 * client every time. Both numbers are a linear reading of one data point, not a second
 * measurement: if a batch of 10 still times out against the live server, lower it again rather
 * than assuming the arithmetic held.
 *
 * PROVISIONAL, and deliberately so. This number exists only to dodge inline server-side
 * embedding, and `docs/superpowers/specs/2026-08-12-client-side-embedding-design.md` §7 removes
 * its reason for existing: once the client supplies the vector, a batch is a batch of row
 * inserts and the limit is sized by payload and transaction time instead -- considerably larger.
 * Do not treat 10 as a settled constant, and re-derive it from a measurement when that design
 * lands rather than carrying this arithmetic forward.
 */
const MAX_BATCH = 10;
```

and in `src/cloud/api-client.ts`, publishing stops sharing the auth timeout:

```ts
/**
 * Publishing is not an auth round trip, and 30 seconds is an auth number.
 *
 * `DEFAULT_TIMEOUT_MS` exists so `knowl login` and `knowl cloud connect` fail rather than hang
 * with a person watching -- its docblock says exactly that. A publish is a bulk write whose
 * server side embeds every atom inline, so it is slow *by construction* and its slowness is not
 * the symptom the auth timeout was added to catch. Keeping them equal meant a batch sized for
 * the server's memory was aborted by a limit chosen for a login prompt.
 */
const PUBLISH_TIMEOUT_MS = 120_000;
```

Apply it per call rather than widening the client: `request` reads the closure's `timeoutMs`, so give `publishItems` an explicit override — pass `timeoutMs` through `request`'s init argument and default it to the closure value. Nothing else changes its timeout.

In the CLI's `push` action, compute the snapshot, print it, confirm, then push with `strict: true`. Non-TTY without `--yes` exits non-zero without sending.

- [ ] **Step 4: Run it and watch it pass**

Run: `npm.cmd test -- tests/cloud/publish-snapshot.test.ts tests/cloud/publish.test.ts`
Expected: PASS, including the pre-existing publish cases unmodified.

- [ ] **Step 5: Commit**

```bash
git add src/cloud/publish.ts src/cli/program.ts tests/cloud/publish-snapshot.test.ts
git commit -m "feat(cloud): a push sends the snapshot it showed you, or refuses"
```

---

### Task 5: Auto-push, gated on everything, and reachable from exactly one place

**Files:**
- Modify: `src/cloud/auto-stage.ts` — `maybeAutoStage` returns what it staged
- Create: `src/cli/auto-push.ts` — the gate chain and the push
- Modify: `src/cli/program.ts` — call it after `store`, `decide` and `cloud stage --apply`
- Test: `tests/cloud/auto-push.test.ts`

**Interfaces:**
- Changed: `maybeAutoStage(...) : Promise<{ staged: string[] }>` — was `Promise<void>`
- Produces: `maybeAutoPush(input: { projectRoot: string; config: ProjectConfig; staged: string[] }): Promise<AutoPushOutcome>`
  ```ts
  type AutoPushOutcome =
    | { status: 'skipped'; reason: 'not-connected' | 'no-consent' | 'nothing-staged' }
    | { status: 'gated'; detail: string }
    | { status: 'stale' }
    | { status: 'pushed'; created: number; updated: number };
  ```

**Two things an earlier draft left undefined, both of which made this task unbuildable.**

**1. `maybeAutoStage` returned `void` and swallowed its failures**, so "run push after a successful stage" had no *successful* to test. It now returns the ids it staged — `{ staged: [] }` on every skip and on every swallowed error, so the swallow is preserved and the caller still learns nothing was queued. The docblock's promise (never throw) is unchanged; only the return type moves.

**2. Where auto-push fires was never named.** It fires **from the CLI only**, and the spec settles this rather than leaving it to taste: §6.2 defines automatic push as *"the standing answer to §6.4's prompt"*. A prompt exists only where there is a terminal, so a standing answer to it belongs where the prompt would have been. The consequences are all in the right direction:

- A long-lived MCP server never makes a 120-second network call inside a tool request. `knowl_store` returning after a publish would be a tool call that appears to hang.
- The one path with a `--yes` flag, a TTY and an exit code is the one that can report a refusal.
- An agent's writes still reach the team — they are staged as they are written, and the next CLI command with consent sends them. Nothing is lost, only deferred to a moment a human is present.

State this in the module docblock, because the obvious next change is to "also fire it from MCP" and the reason not to is not obvious from the code.

- [ ] **Step 1: Write the failing test**

Create `tests/cloud/auto-push.test.ts`:

```ts
  it('does not push without consent', async () => {
    await writeAutoPushConsent(WS, false);
    const sent: string[] = [];
    const result = await maybeAutoPush({ projectRoot: ROOT, config: connected(), staged: ['a'], api: apiRecording(sent) });
    expect(result).toEqual({ status: 'skipped', reason: 'no-consent' });
    expect(sent).toEqual([]);
  });

  it('does not push when the gate is closed', async () => {
    await writeAutoPushConsent(WS, true);
    await checkoutFeatureBranch(ROOT);
    const sent: string[] = [];
    const result = await maybeAutoPush({ projectRoot: ROOT, config: connected(), staged: ['a'], api: apiRecording(sent) });
    expect(result.status).toBe('gated');
    expect(sent).toEqual([]);
  });

  it('pushes when consent is given and the gate is open', async () => {
    await writeAutoPushConsent(WS, true);
    const sent: string[] = [];
    const result = await maybeAutoPush({ projectRoot: ROOT, config: connected(), staged: ['a'], api: apiRecording(sent) });
    expect(result.status).toBe('pushed');
    expect(sent).toEqual(['a']);
  });

  it('binds to a snapshot it computed itself', async () => {
    // Consent replaces the PROMPT, not the snapshot. An automatic push that sent whatever was in
    // the queue at send time would reintroduce exactly the race Task 4 closed -- and it would be
    // worse here, because no human is watching the list grow.
    await writeAutoPushConsent(WS, true);
    const sent: string[] = [];
    await maybeAutoPush({
      projectRoot: ROOT, config: connected(), staged: ['a'],
      api: apiRecording(sent),
      onBeforeSend: async () => { await stageForPublish(['b'], WS, 'main'); },
    });
    // `b` was staged after the snapshot was taken. It is not part of this push.
    expect(sent).toEqual(['a']);
  });

  it('never throws, so a write is never reported as failed because a push was', async () => {
    await writeAutoPushConsent(WS, true);
    const api = { publishItems: async () => { throw new Error('network down'); } } as any;
    await expect(maybeAutoPush({ projectRoot: ROOT, config: connected(), staged: ['a'], api }))
      .resolves.toMatchObject({ status: expect.any(String) });
  });
```

`onBeforeSend` is a test seam, in the same spirit as `EnsureTokenInput.onBeforeLock` (`src/cloud/token.ts:28`) — the race it opens is otherwise unreachable in-process, and a snapshot binding nothing exercises is a snapshot that can be deleted without a test noticing.

- [ ] **Step 2: Run, fail, implement, pass**

Gate order, all five, in this order and short-circuiting:

1. `config.cloud` present → else `skipped: 'not-connected'`
2. `input.staged.length > 0` → else `skipped: 'nothing-staged'`
3. `readAutoPushConsent(pointer.workspaceId)` true → else `skipped: 'no-consent'`
4. `checkPublishGate(projectRoot)` ok → else `gated`
5. `computePushSnapshot`, then `pushStaged({ snapshot, strict: false })` → `stale` if it refuses

Consent is checked **before** the gate deliberately: `checkPublishGate` shells out to git (`spawnSync`), and a machine with no consent must not pay for that on every write.

Every non-`pushed` outcome prints one line saying what is queued and why it was not sent. Silence here is the failure mode that matters — a user who turned auto-push on and sees nothing has no way to tell "sent" from "refused".

- [ ] **Step 3: Full verification**

```bash
npm.cmd run build
npm.cmd test
git diff --check
```

- [ ] **Step 4: Commit**

```bash
git add src/cloud/auto-stage.ts src/cli/auto-push.ts src/cli/program.ts tests/cloud/auto-push.test.ts
git commit -m "feat(cloud): auto-push, behind consent, the gate and a snapshot, from the CLI only"
```

---

### Task 6: The three controls the spec promises and nothing implements

**Files:**
- Modify: `src/cli/config/*` — allow `cloud.autoStage` as a `knowl config set` key
- Modify: `src/cloud/connect.ts` and `src/cli/program.ts` — `--no-auto-stage` at connect
- Modify: `src/core/doctor.ts` — a drift check
- Test: `tests/cli/config-command.test.ts`, `tests/cloud/connect.test.ts`, `tests/core/doctor.test.ts`

Task 1 added `autoStage?: boolean` to the type and read it. Nothing sets it, and the spec names three surfaces that must:

| Promise | Where the spec says it | Status before this task |
| --- | --- | --- |
| `knowl config set cloud.autoStage false` | §6.1, line 296 | The key is not in the settable set |
| `knowl cloud connect --no-auto-stage` | §6.1, line 296 | The flag does not exist |
| `knowl doctor` reports auto-stage drift | §6.1.1, line 336 | No check; the swallowed failures in `maybeAutoStage` are invisible |

The third is not cosmetic. `maybeAutoStage` swallows every error by design — that is the right trade, and it is only defensible because something else notices. Without the doctor check, a repository whose ledger writes have been failing for a week looks exactly like one with nothing to say.

- [ ] **Step 1: Write the failing tests**

```ts
  it('accepts cloud.autoStage as a config key and round-trips false', async () => {
    await runCli(['config', 'set', 'cloud.autoStage', 'false']);
    expect((await loadConfig(ROOT)).cloud?.autoStage).toBe(false);
  });

  it('connect --no-auto-stage writes the setting rather than leaving it absent', async () => {
    await runConnect({ projectRoot: ROOT, apiHost: HOST, workspaceId: WS, autoStage: false, api: stubApi() });
    // Absent means on (Task 1), so "off" has to be written explicitly -- it cannot be a default.
    expect((await loadConfig(ROOT)).cloud?.autoStage).toBe(false);
  });

  it('doctor warns when connected atoms exist that were never staged and never excluded', async () => {
    const { item } = await storeKnowledgeItemDeduped(projectId, atom({ title: 'orphan' }), 'Store fact');
    await unstagePublish(item.id, WS);          // simulate the swallowed failure's end state
    await clearExclusion(item.id);

    const checks = await cloudDoctorChecks(ROOT, connected());
    const drift = checks.find(check => check.name.includes('auto-stage'));
    expect(drift?.status).toBe('WARN');
    expect(drift?.detail).toMatch(/1 item/);
  });

  it('doctor says nothing when auto-stage is off, because then it is not drift', async () => {
    const checks = await cloudDoctorChecks(ROOT, connected({ autoStage: false }));
    expect(checks.find(check => check.name.includes('auto-stage'))).toBeUndefined();
  });
```

- [ ] **Step 2: Run, fail, implement, pass**

The doctor check counts active, workspace-eligible atoms in a connected repo with `autoStage` on that have **no** `cloud_published` row and **no** `cloud_excluded` row. That set is empty when the seam is working, so a non-zero count is exactly the drift the swallow hides. Report it WARN with the remedy — `knowl cloud stage --category ... --apply` — never FAIL: an unstaged atom is a queue that is behind, not a repository that is broken.

Register it in `cloudDoctorChecks` beside the existing `stagedCheck`, and skip it entirely when `autoStage` is off — a repo that opted out has no drift, and warning there would train the user to ignore doctor.

- [ ] **Step 3: Render it**

```bash
npm.cmd run build
node dist/index.js doctor
node dist/index.js cloud connect --help
```

Expected: `--no-auto-stage` in the help, and the drift line present or absent according to this repo's own state. Per the CLI-rendering constraint, read the output.

- [ ] **Step 4: Commit**

```bash
git add src/cli/ src/cloud/connect.ts src/core/doctor.ts tests/
git commit -m "feat(cloud): let a repo turn auto-staging off, and let doctor see when it drifted"
```

---

## What Plan C deliberately does not do

- **No `knowl store --local`.** Plan D adds the flag; `cloud unstage --forever` is the only exclusion writer until then. **Plan D depends on this plan for it**: the exclusion has to be written before the seam Task 2 installs can fire, which is why `store --local` cannot be built against Plan A alone.
- **No change to `maybeAutoSync`.** Auto-pull already works; Plan B surfaced it in status and that is the whole of it.
- **No relaxation of the publish gate.** Auto-push waits for it like everything else.
- **No auto-push from MCP.** Task 5 states the reasoning; changing it is a product decision, not a wiring one.
