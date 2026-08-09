# Knowl Cloud Client — Plan D: Publishing

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Knowledge goes up — explicitly, only from the repo that wrote it, and only once the code it describes is on the default branch.

**Architecture:** Publishing is two-phase. `knowl publish` **stages** an atom in a local ledger at any time on any branch; a separate push sends staged atoms whose evidence has reached the default branch. Drift reports and reviews travel the same gate. The server stays git-blind — every gate here is the client's, because only the client can see the graph.

**Tech Stack:** TypeScript (ESM, Node ≥22), `spawnSync` for git, Commander, Vitest. **No new runtime dependencies.**

**Depends on:** Plan A (`6c5df9f`), Plan B (`a137e21`), Plan C.

**Contract:** knowl-cloud decision **"Phase 6 cloud sync contract"** (`ed533f9890e84c14`) for the `reviewed` op and `needsReview`; the Phase 4a write-path semantics for `PublishOutcome`. Read both before Task 3.

**Spec:** `docs/superpowers/specs/2026-08-08-cloud-client-design.md` §9, §10, §11.

## Global Constraints

- Node `>=22`. ESM only — relative imports end in `.js`. **No new runtime dependencies.**
- Verification is `npm.cmd run build` **then** `npm.cmd test`. Finish with `git diff --check`.
- **Never `initDbPath` or `closeDb` from anything reachable by a tool call.** Constraint `defde27f6f234535`: the MCP server establishes the global context once at startup, so a helper that closes it leaves every later tool call with no database — and no unit test can see it, because a test has no ambient context to destroy. Use `withDbPath`.
- **`visibility` is not touched.** Publication state lives in the ledger (decision `ee191dd7db024bec`). `repo` and `workspace` keep their exact current meanings.
- **A secret rejection is terminal.** It fails the whole batch, the client names the item but never echoes the matched text, and it is never retried in altered form.
- **The server is git-blind and stays that way.** Do not send a branch name, and do not ask the server to compare two commits.

---

### Task 1: The publication ledger

**Files:**
- Modify: `src/store/schema.ts`, `src/store/bootstrap.ts` — add `cloud_published`, bump `KNOWL_MIGRATION_LEVEL`
- Create: `src/cloud/ledger.ts`
- Test: `tests/cloud/ledger.test.ts`

**Interfaces:**
- Produces:
  - `type PublishedRecord = { itemId: string; remoteWorkspace: string; remoteVersion: number | null; stagedAt: string; stagedOnBranch: string | null; pushedAt: string | null; retractedAt: string | null }`
  - `stageForPublish(itemIds: string[], workspace: string, branch: string | null): Promise<number>`
  - `listStaged(workspace: string): Promise<PublishedRecord[]>`
  - `listPushed(workspace: string): Promise<PublishedRecord[]>`
  - `recordPushed(itemId: string, workspace: string, remoteVersion: number): Promise<void>`
  - `publishedVersion(itemId: string, workspace: string): Promise<number | null>`

Follow the impact-detection precedent: additive tables, `KNOWL_MIGRATION_LEVEL` bumped, `KNOWL_SCHEMA_VERSION` held. Read how `impact_findings` was added and mirror it exactly.

- [ ] **Step 1: Write the failing test**

Create `tests/cloud/ledger.test.ts`:

```ts
import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, initDb } from '../../src/store/database.js';
import {
  listPushed, listStaged, publishedVersion, recordPushed, stageForPublish,
} from '../../src/cloud/ledger.js';

const ROOT = path.resolve('./.knowl-ledger-root');
const WS = 'ws-ledger';

describe('publication ledger', () => {
  beforeEach(async () => {
    await fs.rm(ROOT, { recursive: true, force: true }).catch(() => {});
    await fs.mkdir(path.join(ROOT, '.knowl'), { recursive: true });
    await fs.writeFile(path.join(ROOT, '.knowl', 'config.json'), JSON.stringify({ version: 1 }), 'utf8');
    await initDb(ROOT);
  });
  afterEach(async () => {
    await closeDb().catch(() => {});
    await fs.rm(ROOT, { recursive: true, force: true }).catch(() => {});
  });

  it('starts empty', async () => {
    expect(await listStaged(WS)).toEqual([]);
    expect(await publishedVersion('a1', WS)).toBeNull();
  });

  it('stages items with the branch they were staged on', async () => {
    // The branch is recorded because the gate reads it later: an atom staged on a feature
    // branch must not push until that work is on the default branch.
    expect(await stageForPublish(['a1', 'a2'], WS, 'feature/rollback')).toBe(2);

    const staged = await listStaged(WS);
    expect(staged.map(row => row.itemId).sort()).toEqual(['a1', 'a2']);
    expect(staged[0].stagedOnBranch).toBe('feature/rollback');
    expect(staged[0].pushedAt).toBeNull();
  });

  it('staging twice does not duplicate or re-stage a pushed item', async () => {
    await stageForPublish(['a1'], WS, 'main');
    await recordPushed('a1', WS, 3);
    await stageForPublish(['a1'], WS, 'main');

    expect(await listStaged(WS)).toEqual([]);
    expect((await listPushed(WS)).map(row => row.itemId)).toEqual(['a1']);
  });

  it('remembers the remote version, which every republish needs', async () => {
    // The server treats a republish with no `expectedVersion` as a conflict, deliberately, so
    // an older client cannot acquire overwrite rights by not knowing the field exists. This
    // column is the only place that number lives on this machine.
    await stageForPublish(['a1'], WS, 'main');
    await recordPushed('a1', WS, 7);

    expect(await publishedVersion('a1', WS)).toBe(7);
  });

  it('keeps workspaces apart, so one team\'s version cannot answer for another\'s', async () => {
    await stageForPublish(['a1'], WS, 'main');
    await recordPushed('a1', WS, 7);

    expect(await publishedVersion('a1', 'other-workspace')).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm.cmd test -- tests/cloud/ledger.test.ts`
Expected: FAIL — cannot find module `../../src/cloud/ledger.js`

- [ ] **Step 3: Implement**

Add the table to `src/store/schema.ts` and `src/store/bootstrap.ts`:

```sql
CREATE TABLE IF NOT EXISTS cloud_published (
  item_id TEXT NOT NULL,
  remote_workspace TEXT NOT NULL,
  remote_version INTEGER,
  staged_at TEXT NOT NULL,
  staged_on_branch TEXT,
  pushed_at TEXT,
  retracted_at TEXT,
  PRIMARY KEY (item_id, remote_workspace)
)
```

The primary key is `(item_id, remote_workspace)` because one atom can in principle be published to more than one workspace, and a version from one is meaningless to the other.

Create `src/cloud/ledger.ts` with the six exported functions above, all reading the ambient
project database via `getClient()`. `stageForPublish` uses `INSERT ... ON CONFLICT DO NOTHING`
so re-staging an already-pushed item is a no-op rather than a reset.

**This is machine-local state.** Add `cloud_published` to whatever export/portability
exclusion list `drift_state` is on — a ledger describing one machine's pushes must not travel
in a portable export.

- [ ] **Step 4: Run to verify it passes**

Run: `npm.cmd test -- tests/cloud/ledger.test.ts`
Expected: PASS, 5 tests

- [ ] **Step 5: Commit**

```bash
git add src/store/schema.ts src/store/bootstrap.ts src/cloud/ledger.ts tests/cloud/ledger.test.ts
git commit -m "feat(cloud): a local ledger for what this machine has published"
```

---

### Task 2: The default-branch gate

Local knowledge tracks a working tree; team knowledge tracks the default branch. Decision `41ad0874cc9841d9`.

**Files:**
- Create: `src/cloud/publish-gate.ts`
- Test: `tests/cloud/publish-gate.test.ts`

**Interfaces:**
- Consumes: the `git()` helper pattern from `src/cloud/repo-identity.ts`.
- Produces:
  - `type GateVerdict = { ok: true } | { ok: false; reason: 'not-default-branch' | 'behind-remote' | 'git-unavailable'; detail: string }`
  - `defaultBranchOf(projectRoot: string): string | null`
  - `currentBranchOf(projectRoot: string): string | null`
  - `commitsBehindRemote(projectRoot: string, branch: string): number | null`
  - `checkPublishGate(projectRoot: string): GateVerdict`

- [ ] **Step 1: Write the failing test**

Create `tests/cloud/publish-gate.test.ts`:

```ts
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkPublishGate, currentBranchOf } from '../../src/cloud/publish-gate.js';

const ORIGIN = path.resolve('./.knowl-gate-origin');
const CLONE = path.resolve('./.knowl-gate-clone');

const git = (cwd: string, args: string[]) => spawnSync('git', args, { cwd, encoding: 'utf8' });

async function makeOriginAndClone(): Promise<void> {
  await fs.mkdir(ORIGIN, { recursive: true });
  git(ORIGIN, ['init', '-q', '-b', 'main']);
  git(ORIGIN, ['config', 'user.email', 'test@example.com']);
  git(ORIGIN, ['config', 'user.name', 'Test']);
  await fs.writeFile(path.join(ORIGIN, 'a.txt'), 'one', 'utf8');
  git(ORIGIN, ['add', '.']);
  git(ORIGIN, ['commit', '-qm', 'one']);
  git(process.cwd(), ['clone', '-q', ORIGIN, CLONE]);
  git(CLONE, ['config', 'user.email', 'test@example.com']);
  git(CLONE, ['config', 'user.name', 'Test']);
}

describe('checkPublishGate', () => {
  beforeEach(async () => {
    for (const dir of [ORIGIN, CLONE]) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    await makeOriginAndClone();
  });
  afterEach(async () => {
    for (const dir of [ORIGIN, CLONE]) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  it('passes on an up-to-date default branch', async () => {
    expect(checkPublishGate(CLONE)).toEqual({ ok: true });
  });

  it('refuses on a feature branch, because that code is nobody else\'s yet', async () => {
    // The scenario the gate exists for: an atom describing code only this branch has would be
    // false for every colleague on main, and there is no unpublish.
    git(CLONE, ['checkout', '-qb', 'feature/rollback']);

    const verdict = checkPublishGate(CLONE);
    expect(verdict).toMatchObject({ ok: false, reason: 'not-default-branch' });
  });

  it('refuses when the checkout is behind its remote', async () => {
    // Being behind main is indistinguishable from the code having been deleted. Publishing or
    // reporting drift from here would retire knowledge that is still correct for everyone
    // current -- the same collapse `fileContentHash` produced when every read error meant
    // "gone".
    await fs.writeFile(path.join(ORIGIN, 'b.txt'), 'two', 'utf8');
    git(ORIGIN, ['add', '.']);
    git(ORIGIN, ['commit', '-qm', 'two']);
    git(CLONE, ['fetch', '-q']);

    const verdict = checkPublishGate(CLONE);
    expect(verdict).toMatchObject({ ok: false, reason: 'behind-remote' });
  });

  it('passes again once the checkout catches up', async () => {
    await fs.writeFile(path.join(ORIGIN, 'b.txt'), 'two', 'utf8');
    git(ORIGIN, ['add', '.']);
    git(ORIGIN, ['commit', '-qm', 'two']);
    git(CLONE, ['pull', '-q']);

    expect(checkPublishGate(CLONE)).toEqual({ ok: true });
  });

  it('reports git being unavailable as its own reason, not as a branch problem', async () => {
    // The misdiagnosis this repo has already shipped twice: "could not determine" reported as
    // a confident wrong answer.
    const verdict = checkPublishGate(path.resolve('./.knowl-gate-not-a-repo'));
    expect(verdict).toMatchObject({ ok: false, reason: 'git-unavailable' });
  });

  it('reads the current branch', async () => {
    expect(currentBranchOf(CLONE)).toBe('main');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm.cmd test -- tests/cloud/publish-gate.test.ts`
Expected: FAIL — cannot find module

- [ ] **Step 3: Implement**

Create `src/cloud/publish-gate.ts`. Resolve the default branch from
`git symbolic-ref refs/remotes/origin/HEAD` and fall back to `origin/main` then `origin/master`;
count distance with `git rev-list --count HEAD..origin/<default>`.

Distinguish **"git could not run"** from **"git ran and said no"** exactly as
`repo-identity.ts` does — `spawnSync` reports a missing binary as `status: null` with `error`
set, and `status !== 0` is true for `null`, so a machine without git reads as a branch problem
unless `result.error` is checked first.

```ts
/**
 * Whether this checkout may speak for the team.
 *
 * Two conditions, and the second is the one that looks optional and is not. Being behind the
 * remote default branch is INDISTINGUISHABLE from the code having been deleted: the file the
 * team just published about is genuinely not here. Publishing or reporting drift from that
 * vantage retires knowledge that is still correct for everyone who is current.
 *
 * This repository has shipped that collapse before -- `fileContentHash` caught every read
 * error and returned null, `currentStateOf` mapped null to `gone`, and an antivirus lock on
 * Windows became "the file you read is deleted", fired as the strongest notice the system has
 * about an intact file.
 */
export function checkPublishGate(projectRoot: string): GateVerdict { /* ... */ }
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm.cmd test -- tests/cloud/publish-gate.test.ts`
Expected: PASS, 6 tests

- [ ] **Step 5: Commit**

```bash
git add src/cloud/publish-gate.ts tests/cloud/publish-gate.test.ts
git commit -m "feat(cloud): gate publishing on an up-to-date default branch"
```

---

### Task 3: `knowl publish` — staging

Staging must apply the same ownership rules as `promoteItems` without its side effect —
`promoteItems` flips `visibility`, which Plan D must not touch. So the shared half is
**extracted**, not called and not copied.

**Files:**
- Modify: `src/workspace/promote.ts` — extract `selectOwnedItems`
- Create: `src/cloud/publish.ts`
- Modify: `src/cli/program.ts`
- Test: `tests/cloud/publish-stage.test.ts`

**Interfaces:**
- Produces from `promote.ts`:
  - `selectOwnedItems(input: { repoName: string; categories?: KnowledgeCategory[]; ids?: string[]; requireVisibility?: 'repo' }): Promise<{ items: PromoteTarget[]; skippedForeign: number }>` — throws the existing refusals for a bare call, an unknown category, an unknown id, and an imported origin
- Produces from `publish.ts`:
  - `type StageResult = { status: 'not-connected' } | { status: 'staged'; items: PromoteTarget[]; applied: boolean; skippedForeign: number }`
  - `stagePublish(input: { projectRoot: string; config: ProjectConfig; ids?: string[]; categories?: KnowledgeCategory[]; apply?: boolean }): Promise<StageResult>`

- [ ] **Step 1: Extract the selector**

In `src/workspace/promote.ts`, lift everything from the bare-call refusal down to the `rows`
query into `selectOwnedItems`, and have `promoteItems` call it. Two changes to what moves:

- `visibility = 'repo'` becomes conditional on `requireVisibility`. Promotion only ever
  promotes unpromoted rows; publication must be able to stage a row already at `workspace`
  visibility, because sharing with local peers and publishing to a team are different acts.
- The refusal messages move verbatim. They name `--category`, `--id` and the Windows `cmd.exe`
  comma-splitting trap, and rewording them per caller would make one of the two wrong.

Run `npm.cmd test -- tests/workspace/promote.test.ts` after the extraction and before writing
anything new. Expected: PASS, unchanged. An extraction that moves behaviour is a rewrite.

- [ ] **Step 2: Write the failing test**

Create `tests/cloud/publish-stage.test.ts`. Match `tests/workspace/promote.test.ts`'s fixture
style exactly — `releaseAll()` in `beforeEach`, and **wipe the tables rather than trusting the
directory removal**, because on Windows libSQL can hold the file, the `rm` is silently refused,
and a surviving row dedups the seed away:

```ts
import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, getClient, initDb } from '../../src/store/database.js';
import { releaseAll } from '../../src/store/connection-pool.js';
import * as repo from '../../src/store/repository.js';
import { storeKnowledgeItemDeduped } from '../../src/store/knowledge-writer.js';
import { stagePublish } from '../../src/cloud/publish.js';
import { listStaged } from '../../src/cloud/ledger.js';
import type { ProjectConfig } from '../../src/core/types.js';

const ROOT = path.resolve('./.knowl-publish-stage');
const WS = 'ws-pub';

const connected: ProjectConfig = {
  version: 1,
  cloud: {
    apiHost: 'https://api.knowl.dev', workspaceId: WS, workspaceName: 'Acme',
    repo: 'github.com/acme/web', remote: 'origin',
  },
};

let ids: { decision: string; fact: string };

describe('stagePublish', () => {
  beforeEach(async () => {
    await closeDb().catch(() => {});
    await releaseAll();
    await fs.rm(ROOT, { recursive: true, force: true }).catch(() => {});
    await fs.mkdir(path.join(ROOT, '.knowl'), { recursive: true });
    await fs.writeFile(path.join(ROOT, '.knowl', 'config.json'), JSON.stringify({ version: 1 }), 'utf8');
    await initDb(ROOT);
    await getClient().execute('DELETE FROM knowledge_items');
    await getClient().execute('DELETE FROM cloud_published');
    const projectId = (await repo.createProject(ROOT, 'publish')).id;
    const decision = await storeKnowledgeItemDeduped(projectId, {
      category: 'decision', title: 'Deploys roll back by tag',
      content: 'A failed deploy rolls back to the previous tag, never to a branch.',
    });
    const fact = await storeKnowledgeItemDeduped(projectId, {
      category: 'fact', title: 'Local scratch note',
      content: 'A scratch observation that should stay in this repo.',
    });
    ids = { decision: decision.id, fact: fact.id };
    await getClient().execute("UPDATE knowledge_items SET origin_repo = 'github.com/acme/web'");
    await closeDb();
  });
  afterEach(async () => {
    await closeDb().catch(() => {});
    await releaseAll();
    await fs.rm(ROOT, { recursive: true, force: true }).catch(() => {});
  });

  const stage = (over: Partial<Parameters<typeof stagePublish>[0]> = {}) =>
    stagePublish({ projectRoot: ROOT, config: connected, ...over });

  const staged = async (): Promise<string[]> => {
    await initDb(ROOT);
    try { return (await listStaged(WS)).map(row => row.itemId).sort(); }
    finally { await closeDb(); }
  };

  it('refuses when the repo is not connected', async () => {
    expect(await stagePublish({ projectRoot: ROOT, config: { version: 1 }, ids: [ids.decision] }))
      .toEqual({ status: 'not-connected' });
  });

  it('refuses a bare call, because it would send the whole repo', async () => {
    await expect(stage()).rejects.toThrow(/--category|--id/);
  });

  it('refuses a category that cannot exist, and names the Windows comma trap', async () => {
    // Fires without a typo on Windows: `knowl.cmd` runs through cmd.exe, which splits an
    // unquoted `--category a,b,c` on the commas, so only `a` arrives.
    await expect(stage({ categories: ['desicion' as never] })).rejects.toThrow(/quote the list/i);
  });

  it('is a dry run by default, entering nothing in the ledger', async () => {
    const result = await stage({ categories: ['decision'] });

    expect(result).toMatchObject({ status: 'staged', applied: false });
    expect(await staged()).toEqual([]);
  });

  it('stages the selected items when applied', async () => {
    await stage({ categories: ['decision'], apply: true });
    expect(await staged()).toEqual([ids.decision]);
  });

  it('counts foreign items rather than silently returning fewer rows', async () => {
    // "1 item belongs to api" is actionable; a short list with no explanation is not.
    await initDb(ROOT);
    await getClient().execute(
      `UPDATE knowledge_items SET origin_repo = 'github.com/acme/api' WHERE id = '${ids.fact}'`,
    );
    await closeDb();

    const result = await stage({ categories: ['decision', 'fact'], apply: true });

    expect(result).toMatchObject({ skippedForeign: 1 });
    expect(await staged()).toEqual([ids.decision]);
  });

  it('stages from a feature branch, because the gate belongs to the push', async () => {
    // Staging is an intent and can be formed at any time. Only sending is gated -- refusing to
    // stage would mean the work has to be remembered by a human until the merge lands.
    const result = await stage({ ids: [ids.decision], apply: true });

    expect(result).toMatchObject({ status: 'staged', applied: true });
    expect(await staged()).toEqual([ids.decision]);
  });

  it('stages an item already at workspace visibility, since the two acts are different', async () => {
    // `promote` shares with linked local repos; publishing shares with the company. An item
    // that did the first must still be able to do the second.
    await initDb(ROOT);
    await getClient().execute(
      `UPDATE knowledge_items SET visibility = 'workspace' WHERE id = '${ids.decision}'`,
    );
    await closeDb();

    await stage({ ids: [ids.decision], apply: true });
    expect(await staged()).toEqual([ids.decision]);
  });

  it('does not change visibility', async () => {
    // Decision ee191dd7db024bec: publication state lives in the ledger, and `visibility` keeps
    // meaning "readable by linked local repos on this machine" exactly as before.
    await stage({ ids: [ids.decision], apply: true });

    await initDb(ROOT);
    try {
      const row = await getClient().execute(
        `SELECT visibility FROM knowledge_items WHERE id = '${ids.decision}'`,
      );
      expect(String(row.rows[0].visibility)).toBe('repo');
    } finally { await closeDb(); }
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `npm.cmd test -- tests/cloud/publish-stage.test.ts`
Expected: FAIL — cannot find module `../../src/cloud/publish.js`

- [ ] **Step 4: Implement**

Create `src/cloud/publish.ts`:

```ts
import type { KnowledgeCategory, ProjectConfig } from '../core/types.js';
import { closeDb, initDb } from '../store/database.js';
import { selectOwnedItems, type PromoteTarget } from '../workspace/promote.js';
import { stageForPublish } from './ledger.js';
import { currentBranchOf } from './publish-gate.js';

export type StageResult =
  | { status: 'not-connected' }
  | { status: 'staged'; items: PromoteTarget[]; applied: boolean; skippedForeign: number };

/**
 * Record the intent to publish. Sends nothing.
 *
 * Staging is deliberately ungated: an intent can be formed on any branch at any time, and
 * refusing to record one would mean a developer has to remember it themselves until the merge
 * lands. The branch is stored beside it so the push can explain what it is waiting for.
 */
export async function stagePublish(input: {
  projectRoot: string;
  config: ProjectConfig;
  ids?: string[];
  categories?: KnowledgeCategory[];
  apply?: boolean;
}): Promise<StageResult> {
  const pointer = input.config.cloud;
  if (!pointer) return { status: 'not-connected' };

  await initDb(input.projectRoot);
  try {
    const { items, skippedForeign } = await selectOwnedItems({
      repoName: pointer.repo,
      categories: input.categories,
      ids: input.ids,
    });

    if (input.apply && items.length > 0) {
      await stageForPublish(
        items.map(item => item.id),
        pointer.workspaceId,
        currentBranchOf(input.projectRoot),
      );
    }

    return { status: 'staged', items, applied: Boolean(input.apply) && items.length > 0, skippedForeign };
  } finally {
    await closeDb();
  }
}
```

`initDb`/`closeDb` are correct **here** and only here: this runs from a CLI command, which owns
the process. Constraint `defde27f6f234535` forbids them from anything reachable by an MCP tool
call, and nothing in Plan D is.

Register the command:

```ts
program
  .command('publish')
  .description('Stage knowledge for publication to the connected cloud workspace')
  .option('--id <ids...>', 'Item ids to stage')
  .option('--category <list>', 'Comma-separated categories (quote the list on Windows)')
  .option('--apply', 'Actually stage; without this the command is a dry run')
  .action(async options => {
    try {
      const root = await findProjectRoot(process.cwd());
      const config = await loadConfig(root);
      const result = await stagePublish({
        projectRoot: root,
        config,
        ids: options.id,
        categories: options.category?.split(',').map((entry: string) => entry.trim()),
        apply: options.apply,
      });

      if (result.status === 'not-connected') {
        console.error('This repository is not connected to a cloud workspace. Run knowl cloud connect.');
        process.exit(1);
      }
      for (const item of result.items) console.log(`  ${item.category}  ${item.title}`);
      if (result.skippedForeign > 0) {
        console.log(`${result.skippedForeign} item(s) belong to another repo and can only be published from it.`);
      }
      console.log(result.applied
        ? `Staged ${result.items.length} item(s). Run knowl cloud push to send them.`
        : `${result.items.length} item(s) would be staged. Re-run with --apply.`);
      if (result.applied) console.log('Publishing cannot be undone from here yet.');
    } catch (error: any) {
      console.error(`Publish failed: ${error.message}`);
      process.exit(1);
    }
  });
```

- [ ] **Step 5: Run to verify it passes**

Run: `npm.cmd test -- tests/cloud/publish-stage.test.ts tests/workspace/promote.test.ts`
Expected: PASS — both suites, the second unchanged from before the extraction

- [ ] **Step 6: Commit**

```bash
git add src/workspace/promote.ts src/cloud/publish.ts src/cli/program.ts tests/cloud/publish-stage.test.ts
git commit -m "feat(cloud): knowl publish stages knowledge without sending it"
```

---

### Task 4: The push

**Files:**
- Modify: `src/cloud/publish.ts`, `src/cloud/api-client.ts`, `src/cloud/sync-state.ts`, `src/cloud/sync.ts`, `src/cli/program.ts`
- Test: `tests/cloud/publish-push.test.ts`

**Interfaces:**
- On `CloudApi`:
  - `publishItems(input: { workspaceId: string; accessToken: string; originRepo: string; items: PublishItem[] }): Promise<{ outcomes: PublishOutcome[]; commitId: string | null }>`
  - `updateItem(input: { workspaceId: string; accessToken: string; itemId: string; body: UpdateItemBody }): Promise<{ status: string; currentVersion?: number }>`
- In `sync-contract.ts`:
  - `type PublishOutcome = { id: string; status: 'created' | 'updated'; version: number } | { id: string; status: 'conflict'; currentVersion: number } | { id: string; status: 'foreign_origin'; originRepo: string } | { id: string; status: 'deleted' } | { id: string; status: 'tombstoned'; deletedAt: string }`
- Produces:
  - `type PushResult = { status: 'not-connected' } | { status: 'not-logged-in' } | { status: 'gated'; reason: string; detail: string; staged: number } | { status: 'forbidden'; role: string } | { status: 'pushed'; created: number; updated: number; conflicts: PublishOutcome[]; foreign: PublishOutcome[] }`
  - `pushStaged(input: { projectRoot: string; config: ProjectConfig; api?: CloudApi }): Promise<PushResult>`

- [ ] **Step 1: Record the caller's role during sync**

The role rides on every sync response and is the only way to refuse a reader without a round
trip. Add `role TEXT` to `cloud_sync_state` (in `team-store.ts`'s `CREATE_SYNC_STATE`, plus an
`ALTER TABLE ... ADD COLUMN` guard for replicas created before this), carry it through
`SyncState`, and write `page.role` in `traverse`.

A replica synced by an older build has no role recorded. Treat that as **unknown, not
permitted**: the push proceeds and lets the server decide, because refusing on missing local
state would block a legitimate editor over a column that had not been invented yet.

- [ ] **Step 2: Write the failing test**

Create `tests/cloud/publish-push.test.ts`. The fixture needs a real git clone (reuse the
`makeOriginAndClone` helper shape from `publish-gate.test.ts`) because the gate is real:

```ts
const pushed = (over: Partial<PushResult> = {}) => ({ /* fixture api, see below */ });

function fakeApi(outcomes: PublishOutcome[], onPublish?: (body: unknown) => void): CloudApi {
  return {
    startDeviceAuthorization: async () => { throw new Error('unused'); },
    pollForToken: async () => 'pending' as const,
    refresh: async () => { throw new Error('unused'); },
    listWorkspaces: async () => [],
    fetchSyncPage: async () => { throw new Error('unused'); },
    publishItems: async (body: any) => { onPublish?.(body); return { outcomes, commitId: 'c1' }; },
    updateItem: async () => ({ status: 'ok' }),
  } as unknown as CloudApi;
}
```

The tests:

```ts
  it('refuses from a feature branch and names it, without sending anything', async () => {
    // The scenario the gate exists for. An atom describing code only this branch has would be
    // false for every colleague on main, and there is no unpublish.
    git(CLONE, ['checkout', '-qb', 'feature/rollback']);
    let sent = false;

    const result = await pushStaged({ projectRoot: CLONE, config: connected, api: fakeApi([], () => { sent = true; }) });

    expect(result).toMatchObject({ status: 'gated', reason: 'not-default-branch' });
    expect((result as any).detail).toContain('feature/rollback');
    expect(sent).toBe(false);
  });

  it('refuses from a checkout behind its remote', async () => {
    // Behind main is indistinguishable from the code having been deleted, and this repo has
    // shipped that collapse before in `fileContentHash`.
    commitToOrigin('b.txt');
    git(CLONE, ['fetch', '-q']);

    expect(await pushStaged({ projectRoot: CLONE, config: connected, api: fakeApi([]) }))
      .toMatchObject({ status: 'gated', reason: 'behind-remote' });
  });

  it('refuses a reader before sending anything', async () => {
    // The role rides on every sync response. Building a batch and eating a 403 spends the
    // user's time to learn something already on disk.
    await recordRole('reader');
    let sent = false;

    const result = await pushStaged({ projectRoot: CLONE, config: connected, api: fakeApi([], () => { sent = true; }) });

    expect(result).toMatchObject({ status: 'forbidden', role: 'reader' });
    expect(sent).toBe(false);
  });

  it('sends no expectedVersion the first time an atom is published', async () => {
    // A first publish has no remote version to be stale against, and sending one would be a
    // claim about a row that does not exist.
    let body: any;
    await pushStaged({ projectRoot: CLONE, config: connected, api: fakeApi(
      [{ id: ids.decision, status: 'created', version: 1 }], sent => { body = sent; }) });

    expect(body.items[0].expectedVersion).toBeUndefined();
    expect(body.originRepo).toBe('github.com/acme/web');
  });

  it('sends expectedVersion from the ledger on a republish', async () => {
    // The server treats a republish with no expectedVersion as a conflict, deliberately, so an
    // older client cannot acquire overwrite rights by not knowing the field exists.
    await pushStaged({ projectRoot: CLONE, config: connected, api: fakeApi(
      [{ id: ids.decision, status: 'created', version: 1 }]) });
    await stagePublish({ projectRoot: CLONE, config: connected, ids: [ids.decision], apply: true });

    let body: any;
    await pushStaged({ projectRoot: CLONE, config: connected, api: fakeApi(
      [{ id: ids.decision, status: 'updated', version: 2 }], sent => { body = sent; }) });

    expect(body.items[0].expectedVersion).toBe(1);
  });

  it('records the version the server returned, so the next republish is correct', async () => {
    await pushStaged({ projectRoot: CLONE, config: connected, api: fakeApi(
      [{ id: ids.decision, status: 'created', version: 4 }]) });

    expect(await publishedVersionOf(ids.decision)).toBe(4);
  });

  it('reports a conflict without retrying, and leaves that atom staged', async () => {
    // A conflict means the local copy is stale. Retrying would overwrite whatever the other
    // writer landed, and the remedy is to re-read, not to insist.
    const result = await pushStaged({ projectRoot: CLONE, config: connected, api: fakeApi(
      [{ id: ids.decision, status: 'conflict', currentVersion: 9 }]) });

    expect((result as any).conflicts).toHaveLength(1);
    expect(await stagedIds()).toEqual([ids.decision]);
    expect(await publishedVersionOf(ids.decision)).toBeNull();
  });

  it('reports foreign_origin separately from conflict, because a retry would not help', async () => {
    const result = await pushStaged({ projectRoot: CLONE, config: connected, api: fakeApi(
      [{ id: ids.decision, status: 'foreign_origin', originRepo: 'github.com/acme/api' }]) });

    expect((result as any).foreign).toHaveLength(1);
    expect((result as any).conflicts).toHaveLength(0);
  });

  it('fails the whole batch on a secret, names the item, and quotes nothing', async () => {
    // A conflict means one atom is stale; a secret means the source is compromised. So this is
    // not an outcome per atom -- the server refuses the request -- and the rejection is
    // terminal: never retried, never retried in altered form.
    const api = { ...fakeApi([]), publishItems: async () => {
      throw new CloudApiError(422, 'Secret detected in item ' + ids.decision, 'secret_detected');
    } } as unknown as CloudApi;

    await expect(pushStaged({ projectRoot: CLONE, config: connected, api }))
      .rejects.toMatchObject({ code: 'secret_detected' });

    expect(await stagedIds()).toEqual([ids.decision]);
    expect(await publishedVersionOf(ids.decision)).toBeNull();
  });

  it('chunks a batch larger than the contract maximum', async () => {
    // PublishRequest caps items at 200: an unbounded batch is an unbounded transaction and an
    // unbounded embedding job on the server.
    await stageMany(250);
    const sizes: number[] = [];
    await pushStaged({ projectRoot: CLONE, config: connected, api: fakeApi([], (body: any) => sizes.push(body.items.length)) });

    expect(sizes.every(size => size <= 200)).toBe(true);
    expect(sizes.reduce((a, b) => a + b, 0)).toBe(250);
  });
```

- [ ] **Step 3: Run to verify it fails**

Run: `npm.cmd test -- tests/cloud/publish-push.test.ts`
Expected: FAIL — `pushStaged` is not a function

- [ ] **Step 4: Implement**

Add to `src/cloud/publish.ts`:

```ts
/** The contract's own cap. An unbounded batch is an unbounded transaction on the server. */
const MAX_BATCH = 200;

/**
 * Send what is staged, if this checkout may speak for the team.
 *
 * The gate is checked ONCE, before the batch. The branch cannot change mid-push, and
 * re-checking per atom would spend a `spawnSync` per item for one answer.
 *
 * Nothing is un-staged until the server has confirmed it. An atom whose outcome was a conflict,
 * a foreign origin, or a failure stays staged, so the next run retries exactly it and no more.
 */
export async function pushStaged(input: {
  projectRoot: string;
  config: ProjectConfig;
  api?: CloudApi;
}): Promise<PushResult> { /* ... */ }
```

Order of operations, and each step's reason:

1. `not-connected` if no pointer — nothing to push to.
2. Read staged rows; return `pushed` with zeros if empty, **before** the gate. Reporting
   `gated` when there is nothing to send would be a refusal about nothing.
3. `checkPublishGate` — return `gated` with the branch or distance in `detail`.
4. Role from `cloud_sync_state`; `forbidden` for `reader`. Unknown proceeds.
5. `ensureAccessToken`; `not-logged-in` if absent.
6. Chunk to `MAX_BATCH`, attaching `expectedVersion` from `publishedVersion(id, workspace)` —
   omitted when null.
7. Per outcome: `created`/`updated` → `recordPushed(id, workspace, version)`; everything else
   left staged and collected into `conflicts` / `foreign`.

A thrown `CloudApiError` propagates. The secret case must not be caught and converted into a
partial success — the batch failed, and the ledger correctly still says so.

- [ ] **Step 5: Run to verify it passes**

Run: `npm.cmd test -- tests/cloud/publish-push.test.ts`
Expected: PASS, 10 tests

- [ ] **Step 6: Prove the gate is load-bearing**

Temporarily make `pushStaged` skip `checkPublishGate`. Run the test.
Expected: the feature-branch and behind-remote tests FAIL. Restore and confirm they pass.

- [ ] **Step 7: Register `knowl cloud push` and commit**

```bash
git add src/cloud/publish.ts src/cloud/api-client.ts src/cloud/sync-state.ts src/cloud/sync.ts src/cloud/team-store.ts src/cli/program.ts tests/cloud/publish-push.test.ts
git commit -m "feat(cloud): push staged knowledge once its code is on the default branch"
```

---

### Task 5: Drift upward and the `reviewed` op

**Files:**
- Create: `src/cloud/drift-report.ts`
- Test: `tests/cloud/drift-report.test.ts`

**Interfaces:**
- Produces:
  - `reportDrift(input: { projectRoot: string; config: ProjectConfig; itemId: string; reason: string; api?: CloudApi }): Promise<'reported' | 'gated' | 'not-published'>`
  - `reportReviewed(input: { projectRoot: string; config: ProjectConfig; itemId: string; note?: string; api?: CloudApi }): Promise<'reviewed' | 'gated' | 'not-published' | 'conflict'>`

- [ ] **Step 1: Write the failing test**

Create `tests/cloud/drift-report.test.ts`, on the same git-clone fixture as Task 4:

```ts
  it('refuses to report an atom this machine never published', async () => {
    // An atom absent from the ledger has no server-side counterpart, so a report about it is a
    // report about nothing -- and would 404 after spending a request to find out.
    expect(await reportDrift({ projectRoot: CLONE, config: connected, itemId: 'never-published', reason: 'gone', api }))
      .toBe('not-published');
  });

  it('refuses to report drift from a feature branch', async () => {
    // Deleting a feature locally makes the local drift check mark its atom stale -- correctly
    // for this tree, wrongly for everyone on main. Reporting it would retire knowledge that is
    // still true for every colleague.
    git(CLONE, ['checkout', '-qb', 'feature/remove-rollback']);
    expect(await reportDrift({ ...base, itemId: published, reason: 'file deleted', api })).toBe('gated');
  });

  it('refuses to report drift from a checkout behind its remote', async () => {
    // The trap: three days behind, the file the team just published about is genuinely not
    // here, and "gone" is the wrong conclusion.
    commitToOrigin('c.txt');
    git(CLONE, ['fetch', '-q']);
    expect(await reportDrift({ ...base, itemId: published, reason: 'file deleted', api })).toBe('gated');
  });

  it('sends the commit it was observed at', async () => {
    // Stored, never validated -- the server has no working tree. It is what makes a bad report
    // traceable and reversible rather than anonymous and permanent.
    let body: any;
    await reportDrift({ ...base, itemId: published, reason: 'file deleted', api: capture(sent => { body = sent; }) });

    expect(body.op).toBe('needsReview');
    expect(body.reason).toBe('file deleted');
    expect(body.observedAtCommit).toBe(headOf(CLONE));
    expect(body.expectedVersion).toBeUndefined();
  });

  it('sends expectedVersion and sourceCommit when reviewing', async () => {
    // The asymmetry is the point. `needsReview` takes no version and bumps none, so a report is
    // never dropped mid-edit. `reviewed` is a positive claim about specific content, and
    // vouching for text you did not read is the failure to prevent.
    let body: any;
    await reportReviewed({ ...base, itemId: published, api: capture(sent => { body = sent; }) });

    expect(body.op).toBe('reviewed');
    expect(body.expectedVersion).toBe(1);
    expect(body.sourceCommit).toBe(headOf(CLONE));
  });

  it('surfaces a review conflict instead of retrying', async () => {
    expect(await reportReviewed({ ...base, itemId: published, api: conflicting() })).toBe('conflict');
  });
```

- [ ] **Steps 2–4: Implement, run, commit**

Both verbs share one guard, and it is the same one `pushStaged` uses:

```ts
/**
 * A report is a claim about the team's codebase, not about this working tree.
 *
 * Both verbs pass through here because both are wrong from the same two vantages: a branch
 * whose code nobody else has, and a checkout too far behind to tell "deleted" from "not pulled
 * yet". `reviewed` is if anything the stricter of the two -- it clears a flag someone else
 * raised.
 */
async function gatedTarget(projectRoot: string, config: ProjectConfig, itemId: string) { /* ... */ }
```

```bash
git commit -m "feat(cloud): report drift and reviews upward, gated on the default branch"
```

---

### Task 6: `knowl cloud status`

**Files:**
- Create: `src/cloud/status.ts`
- Modify: `src/cli/program.ts`, `src/cloud/doctor-checks.ts`
- Test: `tests/cloud/status.test.ts`

**Interfaces:**
- Produces:
  - `type CloudStatus = { connected: false } | { connected: true; workspace: string; role: string | null; lastSyncedAt: string | null; lastError: string | null; staged: number; gate: GateVerdict }`
  - `cloudStatus(projectRoot: string, config: ProjectConfig): Promise<CloudStatus>`
  - `formatCloudStatus(status: CloudStatus): string`

- [ ] **Step 1: Write the failing test**

```ts
  it('says the repo is not connected', ...)
  it('reports the workspace, the role and how stale the replica is', ...)

  it('reports what is staged and what is holding it', async () => {
    // The line that stops staged work being silently forgotten. A developer who staged on a
    // branch and moved on has no other prompt -- the atoms are in a table nobody reads.
    git(CLONE, ['checkout', '-qb', 'feature/rollback']);
    await stagePublish({ projectRoot: CLONE, config: connected, ids: [id], apply: true });

    const text = formatCloudStatus(await cloudStatus(CLONE, connected));

    expect(text).toContain('1 staged');
    expect(text).toContain('feature/rollback');
  });

  it('says publishing cannot be undone whenever anything is staged', async () => {
    // A product requirement, not a nicety. The server has a retire verb; no client path wires
    // it, so a confirmation that omits this is a confirmation that misleads.
    await stagePublish({ projectRoot: CLONE, config: connected, ids: [id], apply: true });
    expect(formatCloudStatus(await cloudStatus(CLONE, connected))).toMatch(/cannot be undone/i);
  });

  it('makes no network call', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (() => { throw new Error('status must not reach the network'); }) as typeof fetch;
    try { await expect(cloudStatus(CLONE, connected)).resolves.toBeDefined(); }
    finally { globalThis.fetch = original; }
  });
```

- [ ] **Steps 2–4: Implement, run, commit**

Add the staged count to `cloudDoctorChecks` as a `WARN` when anything is staged and the gate
refuses, so a developer who staged on a branch is reminded by a command they already run.

```bash
git commit -m "feat(cloud): knowl cloud status reports what is staged and what is holding it"
```

- [ ] **Step 5: Full verification**

Run: `npm.cmd run build`
Then: `npm.cmd test`
Then: `git diff --check`
Expected: all pass, no output

- [ ] **Step 5: Full verification**

Run: `npm.cmd run build`
Then: `npm.cmd test`
Then: `git diff --check`
Expected: all pass, no output

---

## Out of scope for Plan D

- **Retracting a published atom.** The server has the verb; wiring it needs its own plan,
  including what the replica does with a tombstone for something this repo published.
- **Auto-publish by category from server policy.** The dials are designed (spec §9) and
  deliberately unbuilt: an automatic publish is the one that sends something nobody read.
- **The turn-boundary change card** for a team atom superseding something this session read,
  and narrowing the `TEAM UPDATE:` notice by `work_read_sets`. Carried from Plan C.
- **`published_at`, `author_user_id` and `review` columns** on the local schema. The replica
  drops them today; adding them is a schema change that belongs with the retract work, since
  both touch how a replica row is represented locally.
- **Retrieval counts flowing upward** (spec §10). Team knowledge has no single access count
  because it is scattered across laptops, so team-scale decay needs them — atom ids and counts
  only, never query text, which would break the promise that makes local search a privacy
  property. The server endpoint is asked for but unbuilt, so the client half has nothing to
  call yet.

---

## Notes for the implementer

**The ownership rules are extracted, never copied.** Task 3 lifts `selectOwnedItems` out of
`promoteItems` rather than reimplementing it. The two callers differ in exactly one way —
promotion requires `visibility = 'repo'` and publication does not, because sharing with local
peers and publishing to a team are different acts an item may do in either order. Everything
else, including the refusal messages, is one implementation.

**Three verbs pass the same gate**, and it is checked once per invocation rather than per item:
`pushStaged`, `reportDrift` and `reportReviewed`. All three are claims about the team's
codebase, and all three are wrong from the same two vantages — a branch nobody else has, and a
checkout too far behind to tell "deleted" from "not pulled yet".

**`initDb`/`closeDb` appear in this plan and that is correct.** Everything here runs from a CLI
command, which owns its process. Constraint `defde27f6f234535` forbids them only from code
reachable by an MCP tool call — if any of this later gains an MCP surface, it must move to
`withDbPath` first.

**Two mutation steps** prove the guards rather than assuming them: Task 4 Step 6 removes the
publish gate and expects the branch tests to go red. If a guard cannot be made to fail, it is
not protecting anything.
