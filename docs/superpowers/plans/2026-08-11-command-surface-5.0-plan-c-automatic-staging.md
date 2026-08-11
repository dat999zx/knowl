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
| `src/cloud/auto-stage.ts` | Create: the gate and the ledger write |
| `src/store/repository.ts` | Modify: fire the hook after `createKnowledgeItem` and `updateKnowledgeItem` commit |
| `src/cloud/consent.ts` | Create: machine-local auto-push consent under `knowlHome()` |
| `src/cloud/publish.ts` | Modify: snapshot binding, `MAX_BATCH`, auto-push |
| `src/cli/program.ts` | Modify: `--yes` on push, `knowl cloud autopush` |
| `src/core/types.ts` | Modify: `cloud.autoStage?: boolean` |

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

### Task 2: Fire the seam, and prove what it does not cover

**Files:**
- Modify: `src/store/repository.ts` — after `createKnowledgeItem` (line 118) and `updateKnowledgeItem` (line 307) commit
- Test: `tests/cloud/auto-stage-seam.test.ts`

**Interfaces:**
- Consumes: `maybeAutoStage` (Task 1)

**Before writing code, verify the exclusion list by reading, not by assuming.** §6.1.1 claims import and `workspace promote` do not route through these two functions. `src/store/repository.ts:143` documents import writing raw SQL. Confirm `src/workspace/promote.ts` likewise — if it *does* call `updateKnowledgeItem`, it must be excluded explicitly and this task grows a guard.

- [ ] **Step 1: Write the failing test**

Create `tests/cloud/auto-stage-seam.test.ts` with cases asserting: an MCP-style `createKnowledgeItem` stages; an `updateKnowledgeItem` on a published atom stages a correction; an import stages nothing; a `workspace promote` stages nothing. Build each through the real entry point rather than calling `maybeAutoStage` directly — the point of this task is the wiring, and a test that calls the hook proves nothing about whether the hook is called.

```ts
  it('a repository write stages, and an import does not', async () => {
    const { createKnowledgeItem } = await import('../../src/store/repository.js');
    await createKnowledgeItem(/* the same shape the other repository tests build */);
    expect((await listStaged(WS)).length).toBe(1);

    const { importKnowledge } = await import('../../src/store/portability.js');
    await importKnowledge(/* a one-item JSONL fixture */);
    // Still one: the import wrote a row and staged nothing.
    expect((await listStaged(WS)).length).toBe(1);
  });
```

Fill both calls from the argument shapes used in `tests/store/repository.test.ts` and `tests/store/portability.test.ts`; do not invent a shape.

- [ ] **Step 2: Run it and watch it fail**

Run: `npm.cmd test -- tests/cloud/auto-stage-seam.test.ts`
Expected: FAIL — nothing stages, because the hook is not wired.

- [ ] **Step 3: Implement**

In `createKnowledgeItem`, after the insert has committed and the item is returned, before `return`:

```ts
  // After the commit, deliberately. See `maybeAutoStage`.
  await maybeAutoStage({
    projectRoot, config, itemId: created.id, namespace, alreadyPublished: false,
  });
```

`createKnowledgeItem` does not currently receive `projectRoot` or `config`. Thread them from the caller rather than reading config inside the repository layer — the repository must not acquire a dependency on project configuration. If threading proves invasive, the alternative is to fire the hook one level up, in `knowledge-writer`, and this task's tests move with it; take that route only after confirming every covered path in §6.1.1 passes through it.

In `updateKnowledgeItem`, after the update commits:

```ts
  // Only when the atom actually changed what it asserts. `shouldRefreshHash` (line 363) already
  // computes exactly this question for the content half, and the lifecycle hash covers status and
  // supersede changes -- which is why it exists (`4bd5aec20a684cc1`).
  const changed = merged.contentHash !== previous.contentHash
    || merged.lifecycleHash !== previous.lifecycleHash;
  if (changed) {
    await maybeAutoStage({
      projectRoot, config, itemId: merged.id, namespace,
      alreadyPublished: await publishedVersion(merged.id, config.cloud?.workspaceId ?? '') !== null,
    });
  }
```

- [ ] **Step 4: Run it and watch it pass**

Run: `npm.cmd test -- tests/cloud/auto-stage-seam.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the whole suite**

Run: `npm.cmd test`
Expected: green. This task changes a function every write path uses; a failure elsewhere is this task's fault and must be fixed here rather than deferred.

- [ ] **Step 6: Commit**

```bash
git add src/store/repository.ts tests/cloud/auto-stage-seam.test.ts
git commit -m "feat(cloud): stage on write, after the commit, and not from an import"
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
  - `type PushSnapshot = { items: Array<{ itemId: string; contentHash: string | null; lifecycleHash: string | null }> }`
  - `computePushSnapshot(workspaceId: string): Promise<PushSnapshot>`
  - `pushStaged` input gains `snapshot?: PushSnapshot`; result gains `{ status: 'snapshot-stale'; added: string[]; changed: string[] }`

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

  it('without a snapshot, behaves exactly as before', async () => {
    await stageForPublish(['a', 'b'], WS, 'main');
    const sent: string[] = [];
    await pushStaged({ projectRoot: ROOT, config: connected(), api: apiRecording(sent) });
    expect(sent.sort()).toEqual(['a', 'b']);
  });
```

Write `apiRecording` and `mutateContentHash` as local helpers in this file.

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
  items: Array<{ itemId: string; contentHash: string | null; lifecycleHash: string | null }>;
};

export async function computePushSnapshot(workspaceId: string): Promise<PushSnapshot> {
  const staged = await listStaged(workspaceId);
  const hashes = await readHashes(staged.map(row => row.itemId));
  return {
    items: staged.map(row => ({
      itemId: row.itemId,
      contentHash: hashes.get(row.itemId)?.contentHash ?? null,
      lifecycleHash: hashes.get(row.itemId)?.lifecycleHash ?? null,
    })),
  };
}
```

Write `readHashes` as one `SELECT id, content_hash, lifecycle_hash FROM knowledge_items WHERE id IN (...)` returning a `Map`.

In `pushStaged`, immediately after the existing `const staged = await listStaged(...)`:

```ts
    if (input.snapshot) {
      const current = await computePushSnapshot(pointer.workspaceId);
      const promised = new Map(input.snapshot.items.map(item => [item.itemId, item]));

      const changed = current.items
        .filter(item => promised.has(item.itemId))
        .filter(item => {
          const was = promised.get(item.itemId)!;
          return was.contentHash !== item.contentHash || was.lifecycleHash !== item.lifecycleHash;
        })
        .map(item => item.itemId);

      const added = current.items
        .filter(item => !promised.has(item.itemId))
        .map(item => item.itemId);

      // A changed atom always refuses: its text is not what the human read. An addition only
      // refuses under `strict`, because it will go in the next push either way and refusing by
      // default would let a busy agent block every push it runs beside.
      if (changed.length > 0 || (input.strict && added.length > 0)) {
        return { status: 'snapshot-stale', added, changed };
      }
    }
```

Then filter the batch to the snapshot before sending:

```ts
    const sendable = input.snapshot
      ? staged.filter(row => input.snapshot!.items.some(item => item.itemId === row.itemId))
      : staged;
```

and use `sendable` everywhere `staged` was used below this point.

Lower `MAX_BATCH`:

```ts
/**
 * Well below the size measured as unsurvivable.
 *
 * knowl-cloud fact `f77ce73dcb914798` measured 200 atoms of realistic prose at 1564 MB peak and
 * 418 seconds, because `publishItems` embeds inline and synchronously inside the request -- and
 * this constant WAS 200, so a full-repo publish was guaranteed to collide with it. That collision
 * reached production on 2026-08-11: the first 200-atom batch OOM-killed the origin and the
 * remainder returned 502. Auto-staging makes large queues routine rather than exceptional, which
 * is why this moves now.
 *
 * 25 scales that measurement to roughly 195 MB and 52 seconds. It is an estimate from a linear
 * reading of one data point, not a second measurement -- if a batch of 25 is still slow against
 * the live server, lower it again rather than assuming the arithmetic held.
 */
const MAX_BATCH = 25;
```

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

### Task 5: Auto-push, gated on everything

**Files:**
- Modify: `src/cloud/publish.ts` or `src/cli/program.ts` — after a successful `stage`
- Test: `tests/cloud/auto-push.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
  it('does not push without consent', async () => { /* consent off -> nothing sent */ });
  it('does not push when the gate is closed', async () => { /* feature branch -> nothing sent */ });
  it('pushes when consent is given and the gate is open', async () => { /* sent */ });
  it('still binds to a snapshot', async () => {
    // Consent replaces the PROMPT, not the snapshot. An automatic push that sent whatever was in
    // the queue at send time would reintroduce exactly the race Task 4 closed.
  });
```

- [ ] **Step 2: Run, fail, implement, pass**

Gate order, all four required: `config.cloud` present → `readAutoPushConsent(workspaceId)` true → `checkPublishGate` ok → snapshot computed and unchanged. Any failure means stage and stop, printing what is queued and why it was not sent.

- [ ] **Step 3: Full verification**

```bash
npm.cmd run build
npm.cmd test
git diff --check
```

- [ ] **Step 4: Commit**

```bash
git add src/cloud/publish.ts src/cli/program.ts tests/cloud/auto-push.test.ts
git commit -m "feat(cloud): auto-push, behind consent, the gate and a snapshot"
```

---

## What Plan C deliberately does not do

- **No `knowl store --local`.** Plan D adds the flag; `cloud unstage --forever` is the only exclusion writer until then.
- **No change to `maybeAutoSync`.** Auto-pull already works; Plan B surfaced it in status and that is the whole of it.
- **No relaxation of the publish gate.** Auto-push waits for it like everything else.
</content>
