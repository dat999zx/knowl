# Write Gate (Shadow Mode First) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land issue #17's piece 3 — the `PreToolUse` write gate — in a shadow mode that logs what it would have blocked, so the false-positive rate is measured before anything refuses a write.

**Architecture:** Cherry-pick William-Sommers' gate commit `cd9fc8f` to preserve authorship, relocate it from `store/` to `session/` to satisfy the enforced layer graph, then add a three-state `impact.gate` config (`off`/`shadow`/`enforce`). Shadow computes the identical verdict, records one row per finding in a new `impact_gate_shadow` table, and allows the write — crucially without releasing read-set rows, so the table being measured is not mutated by the act of measuring it.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), libSQL/SQLite via `getClient()`, vitest, tsup.

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-08-08-write-gate-shadow-mode-design.md`. Read it before Task 1.
- **Build before testing.** A fresh worktree has no `dist/`; CLI tests spawn the built binary. Run `npm run build` before the first `npm test` or 76 tests fail for unrelated reasons.
- **Baseline:** 257 test files, 2257 passed, 4 skipped. Any other number means something broke.
- **Layer graph** (`tests/architecture/module-boundaries.test.ts`): `core`→`store`→{`ai`,`workspace`,`skills`,`code`}→{`session`,`pipeline`,`transcripts`,`viewer`}→{`cli`,`mcp`}. A module may import strictly below its own layer, never above. Type-only imports are exempt.
- **`KNOWL_SCHEMA_VERSION` stays 1.** Raising it locks out installed builds. Only `KNOWL_MIGRATION_LEVEL` moves (3 → 4).
- **Never add `impact.gate` to `DEFAULT_CONFIG`.** `upgradeConfigDefaults` merges that object into every config on the machine, which would arm a write gate in every repo the user has initialized.
- **Fail open, without exception.** Every error path in the gate allows the write.
- **Comment style:** this repo comments the *why with measurements*. Match the surrounding density; it is the strongest unwritten convention here.
- **Commit style:** lowercase `type(scope): summary`, body explains why. Do not add `Co-authored-by` to the cherry-picked commit — `git cherry-pick` already preserves its author.

---

### Task 1: Cherry-pick the gate and land it in the right layer

The gate commit is based on `ac3ce52`, before pieces 1 and 2 merged and before `#31` moved modules into `session/`. Every conflict is a path that moved, not a semantic disagreement.

**Files:**
- Create: `src/session/write-gate.ts` (from the commit's `src/store/write-gate.ts`)
- Create: `tests/store/write-gate.test.ts` — **stays under `tests/store/`**, only its import changes. There is no `tests/session/` directory: when #31 moved modules into `src/session/`, the tests kept their paths, which is why `tests/store/host-lifecycle.test.ts` imports `../../src/session/host-lifecycle.js`. Creating a new directory here would be a convention this repo does not have.
- Create: `tests/cli/tool-precheck.test.ts`
- Modify: `src/cli/agents/host-hook.ts` (add `tool-precheck` to `NormalizedHookEventName`, the normalizer branch, the validator bypass)
- Modify: `src/cli/agents/hosts/claude.ts` (`CLAUDE_EVENT_MAP`, `CLAUDE_HOOK_EVENTS`, `denyToolCall`)
- Modify: `src/cli/agents/hosts/profile.ts` (optional `denyToolCall` on `HostProfile`)
- Modify: `src/cli/agents/hook-config.ts` (spread-first comment)
- Modify: `src/cli/agent-hook.ts` (exit-0 comment)
- Modify: `src/session/host-lifecycle.ts` (`runWriteGate`, dispatch line)
- Modify: `src/mcp/tools.ts:1171` (comment says `store/write-gate.ts`)
- Modify: `docs/change-impact-plan.md` (the commit's §10 additions)

**Interfaces:**
- Consumes: `IMPACT_WRITE_TOOLS` and `impactChangedPaths` (already on main, `session/host-lifecycle.ts:87,401`); `openFindingsForSession` (`session/impact.ts:448`); `activeReadSetForSession`, `repoRelativePath`, `ReadSetEntry` (`store/read-set.ts`); `ImpactCardEntry` (`session/change-card.ts`); `isImpactEnabled` (`store/impact-config.ts`).
- Produces: `shouldRefuseWrite(root: string, sessionId: string, targetPaths: string[]): Promise<WriteGateDecision>` and `interface WriteGateDecision { deny: boolean; reason: string | null; releasedReadIds: string[] }`, both from `src/session/write-gate.ts`. `HostProfile.denyToolCall?: (reason: string) => HostOutput | undefined`. `NormalizedHookEventName` gains `'tool-precheck'`.

- [ ] **Step 1: Fetch the contributor's branch**

```bash
git fetch https://github.com/William-Sommers/knowl.git \
  'refs/heads/impact/3-write-gate:refs/remotes/contrib/impact-3-write-gate'
git log --oneline -1 contrib/impact-3-write-gate   # expect cd9fc8f
```

- [ ] **Step 2: Cherry-pick, expecting conflicts**

```bash
git cherry-pick -x cd9fc8f
```

Expected: conflicts. `src/store/host-lifecycle.ts` and `src/store/write-gate.ts` do not exist at those paths on this branch. Do not abort.

- [ ] **Step 3: Place the two moved files**

`src/store/write-gate.ts` from the commit becomes `src/session/write-gate.ts`. Its import block changes — these targets all moved on main:

```ts
import type { ImpactCardEntry } from './change-card.js';
import { loadConfig } from '../core/config.js';
import { getClient } from '../store/database.js';
import { isImpactEnabled } from '../store/impact-config.js';
import { openFindingsForSession } from './impact.js';
import { activeReadSetForSession, repoRelativePath, type ReadSetEntry } from '../store/read-set.js';
```

`normalizePathForKnowledge` and `path` are imported in the original but unused by the final file — drop both rather than carry a dead import past the linter.

`src/store/host-lifecycle.ts`'s hunks apply to `src/session/host-lifecycle.ts`. The `runWriteGate` function and its dispatch line `if (input.event === 'tool-precheck') return runWriteGate(input);` go in verbatim; only `import { shouldRefuseWrite } from './write-gate.js';` differs (same directory now).

```bash
git rm --cached src/store/write-gate.ts 2>/dev/null || true
rm -f src/store/write-gate.ts src/store/host-lifecycle.ts
```

- [ ] **Step 4: Repoint the gate's test file**

`tests/store/write-gate.test.ts` stays where the cherry-pick puts it. Change only its import of the module under test to `../../src/session/write-gate.js`, matching how `tests/store/host-lifecycle.test.ts` reaches `../../src/session/host-lifecycle.js`.

- [ ] **Step 5: Update the stale comment in `src/mcp/tools.ts`**

At line 1171 it names the module's old home. Change `(\`store/write-gate.ts\`)` to `(\`session/write-gate.ts\`)`.

- [ ] **Step 6: Verify the layer rule accepts the new placement**

Run: `npx vitest run tests/architecture/module-boundaries.test.ts`
Expected: PASS. If it fails naming `session -> cli`, an import of `ImpactCardEntry` still points at `cli/agents/change-card.js`; it is `./change-card.js` now.

- [ ] **Step 7: Build and run the affected suites**

```bash
npm run build
npx vitest run tests/store/write-gate.test.ts tests/cli/tool-precheck.test.ts tests/store/host-lifecycle.test.ts
```
Expected: PASS.

- [ ] **Step 8: Full suite**

Run: `npm test`
Expected: 257 files, 2257 passed, 4 skipped.

- [ ] **Step 9: Conclude the cherry-pick**

```bash
git add -A
git cherry-pick --continue
git log -1 --format='%an <%ae>'   # must still be William Sommers
```

---

### Task 2: The `impact_gate_shadow` table

**Files:**
- Modify: `src/store/bootstrap.ts` (append to `SCHEMA_STATEMENTS`, after the `impact_findings` indexes ending at `:365`)
- Modify: `src/store/schema-version.ts:54` (`KNOWL_MIGRATION_LEVEL` 3 → 4)
- Modify: `src/store/snapshot-tables.ts:68` (add `impact_gate_shadow: 'preserved'`)
- Test: `tests/store/schema-pin.test.ts:22` (add `SCHEMA_PINS[4]`)
- Test: `tests/store/impact-schema.test.ts`

**Interfaces:**
- Produces: table `impact_gate_shadow(id, finding_id, session_id, target_path, observed_at)` with `UNIQUE(finding_id)`. `KNOWL_MIGRATION_LEVEL === 4`.

- [ ] **Step 1: Write the failing test**

Append to `tests/store/impact-schema.test.ts`:

```ts
it('records one shadow row per finding, and ignores a repeat', async () => {
  await initDb(root);
  const client = getClient();
  await client.execute({
    sql: `INSERT OR IGNORE INTO impact_gate_shadow (id, finding_id, session_id, target_path, observed_at)
          VALUES (?, ?, ?, ?, ?)`,
    args: ['s1', 'finding-a', 'session-1', 'src/a.ts', '2026-08-08T00:00:00.000Z'],
  });
  // Same finding, different row id and a later write against a different file: the belief has
  // not changed, so the table must not grow. This is what makes the row count equal the number
  // of denials an enforcing gate would have issued rather than the number of writes attempted.
  const repeat = await client.execute({
    sql: `INSERT OR IGNORE INTO impact_gate_shadow (id, finding_id, session_id, target_path, observed_at)
          VALUES (?, ?, ?, ?, ?)`,
    args: ['s2', 'finding-a', 'session-1', 'src/b.ts', '2026-08-08T00:00:01.000Z'],
  });

  expect(Number(repeat.rowsAffected ?? 0)).toBe(0);
  const rows = await client.execute('SELECT id, target_path FROM impact_gate_shadow');
  expect(rows.rows).toHaveLength(1);
  // The *first* target survives, not the latest: the row answers "what was in flight when this
  // would first have been blocked", which is the question a false-positive adjudication asks.
  expect(String(rows.rows[0].target_path)).toBe('src/a.ts');
});

it('holds the migration level at 4 with the schema version pinned to 1', () => {
  expect(KNOWL_MIGRATION_LEVEL).toBe(4);
  expect(KNOWL_SCHEMA_VERSION).toBe(1);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/store/impact-schema.test.ts`
Expected: FAIL — `no such table: impact_gate_shadow`.

- [ ] **Step 3: Add the DDL**

In `src/store/bootstrap.ts`, after the `idx_impact_findings_unique_open` statement:

```ts
  /*
   * What an enforcing gate *would* have blocked, recorded while it is not blocking anything.
   *
   * Shadow mode exists because the gate is the one part of this subsystem that can cost somebody
   * their working session, and plan §9 sets a ≥95% precision bar over ≥40 findings before it is
   * allowed to. So the verdict is computed for real and the refusal is withheld, and this table is
   * the record of what was withheld.
   *
   * The table matters because shadow mode deliberately does *not* release the read-set rows it
   * names -- releasing a belief the agent never re-read would make `work_read_sets` stop
   * describing what the session holds, while that table is simultaneously the evidence the
   * precision number is computed from. Not releasing leaves the belief live, so the same finding
   * arrives again on the next write to that file, and without the unique index below the row count
   * would measure writes attempted rather than denials avoided.
   */
  `CREATE TABLE IF NOT EXISTS impact_gate_shadow (
    id TEXT PRIMARY KEY,
    finding_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    target_path TEXT NOT NULL,
    observed_at TEXT NOT NULL
  );`,
  /*
   * `finding_id` alone, and not `(finding_id, read_set_id)`.
   *
   * A finding's `affected_id` *is* the read-set row id -- `detectCertainImpact` writes
   * `affectedId: entry.id` from the row it compared (`session/impact.ts:417`) and
   * `openFindingsForSession` joins `work_read_sets w ON w.id = f.affected_id`. One finding is
   * therefore already one stale belief, and a stored read-set id would be a second copy of a
   * value that can only ever disagree with its source.
   *
   * `session_id` is kept even though the same join reaches it, and this is the one place the
   * denormalization earns itself: `sweepReadSets` hard-deletes released rows, so after GC the
   * join returns nothing and the owning session is unrecoverable. Findings are not swept by that
   * path, so the measurement survives -- but only if the session is recorded where GC cannot
   * reach it.
   */
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_impact_gate_shadow_finding ON impact_gate_shadow(finding_id);`,
```

- [ ] **Step 4: Bump the migration level**

`src/store/schema-version.ts:54`: `export const KNOWL_MIGRATION_LEVEL = 4;` and extend the comment above it to say level 4 adds `impact_gate_shadow` and its unique index, additive, so `KNOWL_SCHEMA_VERSION` again does not move.

- [ ] **Step 5: Classify the table for snapshot restore**

`src/store/snapshot-tables.ts`, beside `impact_findings: 'preserved'`:

```ts
  // Same reason as `impact_findings`' own: these rows are the measurement. A restore that rolled
  // them back would silently reset the precision denominator to zero while leaving the findings
  // they refer to in place.
  impact_gate_shadow: 'preserved',
```

- [ ] **Step 6: Run the pin test to learn the new hash**

Run: `npx vitest run tests/store/schema-pin.test.ts`
Expected: FAIL, printing `Bump KNOWL_MIGRATION_LEVEL and add SCHEMA_PINS[4] = '<hash>'`. Copy the hash it prints — do not invent one.

- [ ] **Step 7: Record the pin**

In `tests/store/schema-pin.test.ts`, after the `3:` entry:

```ts
  // 4 adds `impact_gate_shadow` and its unique index on `finding_id`. Additive, so
  // `KNOWL_SCHEMA_VERSION` again does not move.
  4: '<hash printed in Step 6>',
```

- [ ] **Step 8: Verify**

Run: `npx vitest run tests/store/impact-schema.test.ts tests/store/schema-pin.test.ts tests/store/portability.test.ts`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/store/bootstrap.ts src/store/schema-version.ts src/store/snapshot-tables.ts \
        tests/store/schema-pin.test.ts tests/store/impact-schema.test.ts
git commit -m "feat(impact): impact_gate_shadow, at migration level 4

What an enforcing gate would have blocked, recorded while it blocks nothing.
One row per finding, because shadow mode does not release the read-set rows it
names -- so the belief stays live and the same finding returns on the next
write to that file. Without the unique index the row count would measure
writes attempted rather than denials avoided.

finding_id alone is the key: a finding's affected_id already is the read-set
row id, so one finding is one stale belief. session_id is kept because
sweepReadSets hard-deletes released rows and the owning session would
otherwise be unrecoverable after GC."
```

---

### Task 3: The `impact.gate` config key

**Files:**
- Modify: `src/core/types.ts:297` (add `gate` to the `impact` block)
- Modify: `src/cli/config/schema.ts:25` (`ConfigKey` union), `:85+` (`CONFIG_FIELDS`)
- Modify: `src/store/impact-config.ts` (add `impactGateMode`)
- Test: `tests/core/impact-config.test.ts`

**Interfaces:**
- Produces: `type ImpactGateMode = 'off' | 'shadow' | 'enforce'` and `impactGateMode(config?: ProjectConfig): ImpactGateMode`, both from `src/store/impact-config.ts`.

- [ ] **Step 1: Write the failing test**

`tests/core/impact-config.test.ts` already exists on `main` (it came with piece 2). **Append** this
block; add `impactGateMode` to its existing import of `../../src/store/impact-config.js` rather
than writing a second import statement, and reuse whatever config helper the file already defines
if it has one — the `config` helper below is only for the case where it does not.

```ts
const config = (impact: Record<string, unknown>): ProjectConfig =>
  ({ impact } as unknown as ProjectConfig);

describe('impactGateMode', () => {
  it('is off when nothing is configured', () => {
    expect(impactGateMode(undefined)).toBe('off');
    expect(impactGateMode(config({}))).toBe('off');
  });

  it('reads shadow and enforce when detection is on', () => {
    expect(impactGateMode(config({ enabled: true, gate: 'shadow' }))).toBe('shadow');
    expect(impactGateMode(config({ enabled: true, gate: 'enforce' }))).toBe('enforce');
  });

  // The gate reads findings that only exist while detection is capturing, so an armed gate over
  // a disabled detector is not a stricter configuration -- it is one that can never fire while
  // claiming it can. Refusing it here means one place decides, rather than every call site.
  it('is off when the gate is armed but detection is not', () => {
    expect(impactGateMode(config({ enabled: false, gate: 'enforce' }))).toBe('off');
    expect(impactGateMode(config({ gate: 'enforce' }))).toBe('off');
  });

  // Same rule `isImpactEnabled` follows: every failure mode of this subsystem is a failure of
  // turning it on, and this one takes away somebody's ability to write a file.
  it('treats an unrecognised value as off', () => {
    expect(impactGateMode(config({ enabled: true, gate: 'yes' }))).toBe('off');
    expect(impactGateMode(config({ enabled: true, gate: true }))).toBe('off');
    expect(impactGateMode(config({ enabled: true }))).toBe('off');
  });

  it('leaves isImpactEnabled alone', () => {
    expect(isImpactEnabled(config({ enabled: true, gate: 'enforce' }))).toBe(true);
    expect(isImpactEnabled(config({ gate: 'enforce' }))).toBe(false);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/core/impact-config.test.ts`
Expected: FAIL — `impactGateMode is not a function`.

- [ ] **Step 3: Add the type**

`src/core/types.ts`, in the `impact` block:

```ts
  impact?: {
    enabled?: boolean;
    /**
     * Whether the `PreToolUse` gate refuses a write whose premise has moved, and how loudly.
     *
     * `shadow` computes the identical verdict, records it in `impact_gate_shadow`, and lets the
     * write through -- the state plan §9's ≥95%-over-≥40-findings bar is measured in, before
     * anything is allowed to refuse. `enforce` denies. Separate from `enabled` because they are
     * different risks: detection spends context, and the gate can cost somebody their session.
     */
    gate?: 'off' | 'shadow' | 'enforce';
  };
```

- [ ] **Step 4: Add the resolver**

`src/store/impact-config.ts`:

```ts
export type ImpactGateMode = 'off' | 'shadow' | 'enforce';

const GATE_MODES: readonly ImpactGateMode[] = ['off', 'shadow', 'enforce'];

/**
 * How the write gate should behave, resolved once so no call site re-derives it.
 *
 * **Detection off means gate off, whatever the key says.** The gate's whole input is the open
 * findings the detector writes, so an armed gate over a disabled detector is not a stricter
 * configuration -- it is one that can never fire while reporting that it can.
 *
 * Anything unrecognised is `off`, following `isImpactEnabled`'s rule and for a sharper reason: a
 * malformed value here does not merely switch on machinery nobody asked for, it can take away
 * somebody's ability to write a file.
 */
export function impactGateMode(config?: ProjectConfig): ImpactGateMode {
  if (!isImpactEnabled(config)) return 'off';
  const mode = config?.impact?.gate;
  return GATE_MODES.includes(mode as ImpactGateMode) ? mode as ImpactGateMode : 'off';
}
```

- [ ] **Step 5: Add the config field**

`src/cli/config/schema.ts` — extend the `ConfigKey` union at `:25` with `| 'impact.gate'`, add `const IMPACT_GATE_MODES = ['off', 'shadow', 'enforce'] as const;` beside the other enum tuples at `:80-83`, and append to `CONFIG_FIELDS` after `impact.enabled`:

```ts
  {
    // `defaultValue: 'off'` lives here and nowhere else, same as `impact.enabled` above: the
    // literal in DEFAULT_CONFIG would be merged into every config on the machine by
    // `upgradeConfigDefaults`, which for this key means arming a write gate in every repository
    // the user has ever initialized.
    key: 'impact.gate', category: 'Change impact', type: 'enum', values: IMPACT_GATE_MODES,
    parse: enumValue(IMPACT_GATE_MODES), defaultValue: 'off',
    label: 'Write gate',
    description: 'Before an edit lands on code this session read and has not seen since: shadow records what it would have refused and lets the write through, enforce refuses it and hands back what changed. Needs change impact detection on.',
  },
```

- [ ] **Step 6: Verify**

Run: `npx vitest run tests/core/impact-config.test.ts tests/cli/cli.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/core/types.ts src/store/impact-config.ts src/cli/config/schema.ts tests/core/impact-config.test.ts
git commit -m "feat(config): impact.gate -- off, shadow, or enforce

Separate from impact.enabled because they are different risks. Detection
spends context; the gate can cost somebody their working session, so it gets
its own switch and its own default.

Detection off resolves to gate off whatever the key says: the gate's entire
input is the findings the detector writes, so an armed gate over a disabled
detector cannot fire while reporting that it can. Unrecognised values are off
for the same reason isImpactEnabled works that way, only sharper -- a
malformed value here can take away somebody's ability to write a file."
```

---

### Task 4: Shadow recording and the precision query

**Files:**
- Create: `src/store/gate-shadow.ts`
- Test: `tests/store/gate-shadow.test.ts`

**Interfaces:**
- Consumes: `getClient` (`src/store/database.js`).
- Produces, from `src/store/gate-shadow.ts`:
  - `recordShadowBlock(input: { findingId: string; sessionId: string; targetPath: string }): Promise<boolean>` — true when a row was written, false when the finding was already recorded.
  - `shadowGatePrecision(): Promise<{ adjudicated: number; falsePositives: number; precision: number | null }>` — `precision` is null when `adjudicated` is 0.
  - `countShadowBlocks(): Promise<number>`

- [ ] **Step 1: Write the failing test**

Create `tests/store/gate-shadow.test.ts`. Follow the fixture setup in `tests/store/impact-schema.test.ts` for `initDb`/root handling.

```ts
import { describe, expect, it, beforeEach } from 'vitest';
import { getClient } from '../../src/store/database.js';
import { countShadowBlocks, recordShadowBlock, shadowGatePrecision } from '../../src/store/gate-shadow.js';

// A finding row, minimal but real: the precision query joins against it, so a fake id would
// measure nothing and pass anyway.
async function seedFinding(id: string, resolution: string | null): Promise<void> {
  await getClient().execute({
    sql: `INSERT INTO impact_findings
            (id, cause_locator, cause_session, affected_kind, affected_id, tier, path_json, detected_at, delivered_at, resolution, resolved_at)
          VALUES (?, 'symbol://src/a.ts#f', 'other-session', 'work', ?, 'certain', NULL, '2026-08-08T00:00:00.000Z', NULL, ?, ?)`,
    args: [id, `read-${id}`, resolution, resolution ? '2026-08-08T01:00:00.000Z' : null],
  });
}

describe('gate shadow log', () => {
  it('records a finding once and reports the repeat as not written', async () => {
    await seedFinding('f1', null);

    expect(await recordShadowBlock({ findingId: 'f1', sessionId: 's1', targetPath: 'src/a.ts' })).toBe(true);
    expect(await recordShadowBlock({ findingId: 'f1', sessionId: 's1', targetPath: 'src/b.ts' })).toBe(false);
    expect(await countShadowBlocks()).toBe(1);
  });

  it('computes precision from the findings the shadow rows point at', async () => {
    await seedFinding('f1', 'repaired');
    await seedFinding('f2', 'false_positive');
    await seedFinding('f3', 'dismissed');
    for (const id of ['f1', 'f2', 'f3']) {
      await recordShadowBlock({ findingId: id, sessionId: 's1', targetPath: 'src/a.ts' });
    }

    const result = await shadowGatePrecision();
    expect(result.adjudicated).toBe(3);
    expect(result.falsePositives).toBe(1);
    expect(result.precision).toBeCloseTo(2 / 3, 10);
  });

  // Unresolved findings leave both halves alone rather than counting as correct. Assuming an
  // unadjudicated block was justified is how a precision number talks itself past its own bar.
  it('excludes unresolved findings from both halves', async () => {
    await seedFinding('f1', 'false_positive');
    await seedFinding('f2', null);
    await recordShadowBlock({ findingId: 'f1', sessionId: 's1', targetPath: 'src/a.ts' });
    await recordShadowBlock({ findingId: 'f2', sessionId: 's1', targetPath: 'src/a.ts' });

    const result = await shadowGatePrecision();
    expect(result.adjudicated).toBe(1);
    expect(result.falsePositives).toBe(1);
    expect(result.precision).toBe(0);
  });

  it('reports null precision when nothing has been adjudicated', async () => {
    await seedFinding('f1', null);
    await recordShadowBlock({ findingId: 'f1', sessionId: 's1', targetPath: 'src/a.ts' });

    const result = await shadowGatePrecision();
    expect(result.adjudicated).toBe(0);
    expect(result.precision).toBeNull();
  });

  // Same contract as recordReadBestEffort: this runs inside a hook, so a lost row beats a throw.
  it('returns false rather than throwing when the row cannot be written', async () => {
    expect(await recordShadowBlock({ findingId: '', sessionId: 's1', targetPath: 'src/a.ts' })).toBe(false);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/store/gate-shadow.test.ts`
Expected: FAIL — cannot resolve `src/store/gate-shadow.js`.

- [ ] **Step 3: Write the module**

Create `src/store/gate-shadow.ts`:

```ts
import crypto from 'node:crypto';
import { getClient } from './database.js';

/**
 * What an enforcing write gate would have refused, recorded while it refuses nothing.
 *
 * The gate is the one part of the change-impact design that can cost somebody their working
 * session, so plan §9 puts a ≥95% precision bar over ≥40 findings in front of it. This is the
 * table that bar is computed from: shadow mode runs the real verdict and withholds the refusal,
 * and every withheld refusal lands here.
 *
 * **One row per finding, enforced by a unique index rather than by a check here.** Shadow mode
 * deliberately does not release the read-set rows it names -- releasing a belief the agent never
 * re-read would make `work_read_sets` stop describing what the session holds, while that table is
 * simultaneously the evidence this measurement rests on. Not releasing means the belief is still
 * live on the next write to the same file, so without the index the row count would measure
 * writes attempted rather than denials avoided, and those differ by however many times an agent
 * happens to edit one file.
 *
 * No adjudication of its own. Every row names a finding, and findings already carry `resolution`
 * through `knowl_impact({resolve})` -- which plan §15 established is the only adjudication path,
 * precisely because the gate leaves findings open by design.
 */

const newId = (): string => crypto.randomUUID().replace(/-/g, '').substring(0, 16);

export interface ShadowGatePrecision {
  /** Shadow rows whose finding has been adjudicated. The denominator, and nothing else. */
  adjudicated: number;
  falsePositives: number;
  /** `null` rather than 1 when nothing is adjudicated: no evidence is not a perfect score. */
  precision: number | null;
}

/**
 * Record one withheld refusal. True when this belief had not been recorded before.
 *
 * `INSERT OR IGNORE` against `idx_impact_gate_shadow_finding`, following `insertFinding`: the
 * repeat is the expected case rather than an error, since the belief stays live by design and
 * returns on every subsequent write to that file.
 *
 * Never throws. This runs inside the `PreToolUse` path with a host blocked on the answer, and the
 * whole point of shadow mode is that it cannot affect the write -- so a store mid-snapshot costs
 * one measurement, not somebody's edit.
 */
export async function recordShadowBlock(
  input: { findingId: string; sessionId: string; targetPath: string },
): Promise<boolean> {
  const findingId = (input.findingId ?? '').trim();
  const sessionId = (input.sessionId ?? '').trim();
  const targetPath = (input.targetPath ?? '').trim();
  if (!findingId || !sessionId || !targetPath) return false;

  try {
    const result = await getClient().execute({
      sql: `INSERT OR IGNORE INTO impact_gate_shadow (id, finding_id, session_id, target_path, observed_at)
            VALUES (?, ?, ?, ?, ?)`,
      args: [newId(), findingId, sessionId, targetPath, new Date().toISOString()],
    });
    return Number(result.rowsAffected ?? 0) > 0;
  } catch {
    return false;
  }
}

/** How many refusals were withheld. The `≥40 findings` half of plan §9's bar. */
export async function countShadowBlocks(): Promise<number> {
  const rows = await getClient().execute('SELECT COUNT(*) AS total FROM impact_gate_shadow');
  return Number(rows.rows[0]?.total ?? 0);
}

/**
 * `1 − false_positive / adjudicated`, over the findings the shadow rows point at.
 *
 * Unresolved findings are excluded from **both** halves rather than counted as correct. Treating
 * an unadjudicated block as justified is how a precision number talks its way past the bar it was
 * meant to clear, and `resolution` exists precisely so the judgement is recorded rather than
 * assumed.
 */
export async function shadowGatePrecision(): Promise<ShadowGatePrecision> {
  const rows = await getClient().execute(
    `SELECT COUNT(*) AS adjudicated,
            SUM(CASE WHEN f.resolution = 'false_positive' THEN 1 ELSE 0 END) AS false_positives
     FROM impact_gate_shadow s
     JOIN impact_findings f ON f.id = s.finding_id
     WHERE f.resolution IS NOT NULL`,
  );
  const adjudicated = Number(rows.rows[0]?.adjudicated ?? 0);
  const falsePositives = Number(rows.rows[0]?.false_positives ?? 0);
  return {
    adjudicated,
    falsePositives,
    precision: adjudicated === 0 ? null : 1 - falsePositives / adjudicated,
  };
}
```

- [ ] **Step 4: Verify**

Run: `npx vitest run tests/store/gate-shadow.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/store/gate-shadow.ts tests/store/gate-shadow.test.ts
git commit -m "feat(impact): the shadow log, and the precision it is there to produce

One row per finding, INSERT OR IGNORE against the unique index, following
insertFinding -- the repeat is the expected case here, not an error, because
shadow mode leaves the belief live by design and it returns on the next write
to that file.

Precision is 1 - false_positive/adjudicated over the findings the rows point
at, and unresolved findings are excluded from both halves rather than counted
as correct. Treating an unadjudicated block as justified is how a number talks
its way past the bar it was meant to clear. Null, not 1, when nothing has been
adjudicated: no evidence is not a perfect score."
```

---

### Task 5: Teach the gate its three modes

**Files:**
- Modify: `src/session/write-gate.ts`
- Test: `tests/store/write-gate.test.ts`

**Interfaces:**
- Consumes: `impactGateMode`, `ImpactGateMode` (`src/store/impact-config.js`); `recordShadowBlock` (`src/store/gate-shadow.js`).
- Produces: `WriteGateDecision` gains `shadowedFindingIds: string[]` — the findings this call recorded as withheld refusals. Empty in every mode but `shadow`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/store/write-gate.test.ts`. Reuse that file's existing helpers for seeding a session, a read-set row and a certain-tier finding.

```ts
describe('gate modes', () => {
  it('off computes nothing and allows', async () => {
    await writeConfig({ impact: { enabled: true, gate: 'off' } });
    const decision = await shouldRefuseWrite(root, 'session-1', ['src/a.ts']);

    expect(decision.deny).toBe(false);
    expect(decision.shadowedFindingIds).toEqual([]);
    expect(await countShadowBlocks()).toBe(0);
  });

  it('shadow records the withheld refusal and lets the write through', async () => {
    await writeConfig({ impact: { enabled: true, gate: 'shadow' } });
    const decision = await shouldRefuseWrite(root, 'session-1', ['src/a.ts']);

    expect(decision.deny).toBe(false);
    expect(decision.reason).toBeNull();
    expect(decision.shadowedFindingIds).toEqual([findingId]);
    expect(await countShadowBlocks()).toBe(1);
  });

  // The property the whole mode exists for. Releasing here would clear a belief the agent never
  // re-read, so `work_read_sets` would stop describing what the session holds -- while being the
  // evidence the precision number is computed from. A diagnostic must not change what it observes.
  it('shadow does not release the read-set row it named', async () => {
    await writeConfig({ impact: { enabled: true, gate: 'shadow' } });
    await shouldRefuseWrite(root, 'session-1', ['src/a.ts']);

    const live = await activeReadSetForSession('session-1');
    expect(live.map(entry => entry.id)).toContain(readSetId);
  });

  // Not releasing means the belief returns on the next write. The unique index is what keeps the
  // count equal to the denials an enforcing gate would have issued.
  it('shadow logs one row however many writes hit the same belief', async () => {
    await writeConfig({ impact: { enabled: true, gate: 'shadow' } });
    await shouldRefuseWrite(root, 'session-1', ['src/a.ts']);
    await shouldRefuseWrite(root, 'session-1', ['src/a.ts']);
    await shouldRefuseWrite(root, 'session-1', ['src/a.ts']);

    expect(await countShadowBlocks()).toBe(1);
  });

  it('enforce denies, releases, and writes no shadow row', async () => {
    await writeConfig({ impact: { enabled: true, gate: 'enforce' } });
    const decision = await shouldRefuseWrite(root, 'session-1', ['src/a.ts']);

    expect(decision.deny).toBe(true);
    expect(decision.reason).toContain('KNOWL BLOCKED THIS WRITE');
    expect(decision.releasedReadIds).toEqual([readSetId]);
    expect(decision.shadowedFindingIds).toEqual([]);
    expect(await countShadowBlocks()).toBe(0);

    const live = await activeReadSetForSession('session-1');
    expect(live.map(entry => entry.id)).not.toContain(readSetId);
  });

  // Detection off is gate off, decided in impactGateMode and re-asserted here because this is the
  // call site where getting it wrong takes away somebody's edit.
  it('allows when the gate is armed but detection is off', async () => {
    await writeConfig({ impact: { enabled: false, gate: 'enforce' } });
    const decision = await shouldRefuseWrite(root, 'session-1', ['src/a.ts']);

    expect(decision.deny).toBe(false);
  });
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `npx vitest run tests/store/write-gate.test.ts`
Expected: FAIL — `shadowedFindingIds` undefined; shadow mode denies.

- [ ] **Step 3: Extend the decision type**

In `src/session/write-gate.ts`:

```ts
export interface WriteGateDecision {
  deny: boolean;
  /** Non-null exactly when `deny` is true. */
  reason: string | null;
  /**
   * The read-set rows this denial named and released. Present so the caller can see the one-shot
   * happened rather than take it on trust; see `releaseGatedReads`. Empty in `shadow`, which
   * withholds the refusal and therefore has no one-shot to spend.
   */
  releasedReadIds: string[];
  /**
   * The findings recorded as withheld refusals. Non-empty only in `shadow`, and it is how a
   * caller distinguishes "the gate found nothing" from "the gate found something and said
   * nothing" -- two outcomes that are otherwise the same `allow()`.
   */
  shadowedFindingIds: string[];
}

const allow = (): WriteGateDecision => ({ deny: false, reason: null, releasedReadIds: [], shadowedFindingIds: [] });
```

- [ ] **Step 4: Branch on the mode**

Replace the `isImpactEnabled` check:

```ts
    const config = await loadConfig(root).catch(() => null);
    const mode = impactGateMode(config ?? undefined);
    if (mode === 'off') return allow();
```

Collect the finding id alongside the read-set id in the matching loop — add `const findingIds: string[] = [];` beside `ids`, and `findingIds.push(finding.id);` next to `ids.push(entry.id);`.

Then, after `if (entries.length === 0) return allow();`:

```ts
    /*
     * Shadow: the same verdict, withheld.
     *
     * **No release, and that is the point.** Enforcing mode releases these rows so a retry is
     * never blocked twice, which is safe there because the agent was told to re-read. Doing it
     * here would clear a belief nobody re-read, so `work_read_sets` would stop describing what
     * the session holds -- while being the evidence the precision number is computed from. The
     * belief therefore stays live and this same finding returns on the next write to the file;
     * `idx_impact_gate_shadow_finding` is what keeps that from inflating the count.
     *
     * `paths[0]` because the row is written once and every later attempt is ignored, so the
     * column answers "what was in flight when this would first have been blocked".
     */
    if (mode === 'shadow') {
      const shadowedFindingIds: string[] = [];
      for (const findingId of findingIds) {
        if (await recordShadowBlock({ findingId, sessionId, targetPath: paths[0] })) {
          shadowedFindingIds.push(findingId);
        }
      }
      return { deny: false, reason: null, releasedReadIds: [], shadowedFindingIds };
    }
```

Leave the `releaseGatedReads` block below it untouched, and add `shadowedFindingIds: []` to the returned denial.

Imports to add:

```ts
import { impactGateMode } from '../store/impact-config.js';
import { recordShadowBlock } from '../store/gate-shadow.js';
```

`isImpactEnabled` is no longer used here — remove it from the import list.

- [ ] **Step 5: Verify**

Run: `npx vitest run tests/store/write-gate.test.ts tests/store/gate-shadow.test.ts`
Expected: PASS.

- [ ] **Step 6: Full suite**

Run: `npm run build && npm test`
Expected: 257 files + 2 new, all passing.

- [ ] **Step 7: Commit**

```bash
git add src/session/write-gate.ts tests/store/write-gate.test.ts
git commit -m "feat(impact): the gate ships in shadow mode first

Same verdict, withheld. The gate is the one part of this subsystem that can
cost somebody their working session, so plan §9's >=95%-over->=40-findings bar
gets measured before anything refuses a write.

Shadow does not release the read-set rows it names, which is the property the
mode exists for. Enforcing mode releases them so a retry is never blocked
twice -- safe there, because the agent was told to re-read. Doing the same
here would clear a belief nobody re-read, so work_read_sets would stop
describing what the session holds while being the evidence the precision
number is computed from.

The belief therefore stays live and the finding returns on the next write to
that file; the unique index on finding_id keeps that from inflating the count,
so shadow rows equal the denials an enforcing gate would have issued."
```

---

### Task 6: Correct the two stale config strings

Spec §5. Both describe the `knowl_task_finish` gate that plan §15 removed as unreachable by construction. Verified on `main`: `openFindingsForSession` has exactly one caller, `src/mcp/tools.ts:364`, the `knowl_impact` pull tool.

**Files:**
- Modify: `src/cli/config/schema.ts:213`
- Modify: `src/core/types.ts:282-296`
- Test: `tests/cli/cli.test.ts` (only if it asserts on the description text — check first)

- [ ] **Step 1: Check whether anything asserts the current wording**

Run: `grep -rn "task finish reports unresolved" tests/ src/`
Expected: only the two source sites. If a test pins the string, update it in the same commit.

- [ ] **Step 2: Fix the config description**

`src/cli/config/schema.ts:213` — replace the trailing sentence:

```ts
    description: 'Record which code each session read, and flag work whose code changed underneath it. Findings reach the agent through the change card and knowl_impact.',
```

- [ ] **Step 3: Fix the type comment**

`src/core/types.ts`, in the `impact` block's doc comment, replace *"and a gate that declines to record a clean finish while a certain-tier finding is unresolved"* with:

```
   * it, and findings an agent can pull and adjudicate. The `PreToolUse` write gate is a
   * separate switch (`impact.gate`) for a separate risk.
```

- [ ] **Step 4: Verify**

Run: `npx vitest run tests/cli/cli.test.ts tests/cli/doctor-report.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cli/config/schema.ts src/core/types.ts
git commit -m "docs(config): stop promising a task-finish gate that does not exist

Both strings described knowl_task_finish declining to close clean over an
unresolved certain-tier finding. Plan §15 removed that gate as unreachable by
construction -- reads are captured under the host session and startWorkLoop
mints a different one, so openFindingsForSession queried an id under which no
read was ever recorded.

Verified rather than assumed: openFindingsForSession has exactly one caller on
main, tools.ts:364, which is the knowl_impact pull tool. Nothing consults it at
task finish.

§15's own conclusion is that a description promising an enforcement that
cannot fire is worse than no promise, and it costs guidance-card space in
every session to say it."
```

---

### Task 7: Document the mode and close out

**Files:**
- Modify: `docs/change-impact-plan.md` (§7.5 and the §8 phase table)

`docs/reference.md` needs nothing — checked, it does not enumerate config keys (`grep -n
"impact.enabled\|search.transcripts.enabled" docs/reference.md` returns no matches), so the new
key is reachable through `knowl config` and the `CONFIG_FIELDS` entry alone.

- [ ] **Step 1: Amend §7.5 of the plan doc**

After the four-properties list, add:

```markdown
**Shipped in shadow mode first.** `impact.gate` takes `off` (default), `shadow` or `enforce`.
`shadow` computes the identical verdict, records it in `impact_gate_shadow`, and allows the
write — so §9's ≥95%-over-≥40-findings bar is measured before anything refuses anything.

Shadow deliberately does **not** release the read-set rows it names. Enforcing mode does, so a
retry is never blocked twice; doing the same while merely observing would clear a belief the
agent never re-read, and `work_read_sets` is simultaneously the evidence the precision number is
computed from. The belief therefore stays live and the same finding returns on the next write to
that file, which is why `impact_gate_shadow` is unique on `finding_id`: the row count has to
equal the denials an enforcing gate would have issued, not the writes that were attempted.
```

- [ ] **Step 2: Mark P-3 in the §8 phase table**

Change the P-3 row's gate column to note that the gate ships in shadow first and that promotion to `enforce` is a separate decision on the measured number.

- [ ] **Step 3: Full verification**

```bash
npm run build
npx tsc --noEmit
npx eslint .
npm test
```
Expected: build clean, `tsc` clean, eslint 0 errors, 259 files / 2257+new passing, 4 skipped.

If `tsc --noEmit` reports pre-existing errors in files this change did not touch, note them and move on — `main` is not gated on it (see the 2.17.0 release notes).

- [ ] **Step 4: Commit**

```bash
git add docs/
git commit -m "docs(impact): say that the gate ships in shadow mode, and why it does not release"
```

- [ ] **Step 5: Report**

Summarize for the maintainer: what landed, the full-suite numbers, that nothing blocks a write yet, and that promotion to `enforce` needs ≥40 adjudicated findings at ≥95% precision — queried with `shadowGatePrecision()`.

---

## Self-Review

**Spec coverage.** §1 → Task 1. §2 (rebase) → Task 1 Steps 1-2, 9. §2.1 layer move → Task 1 Steps 3-6. §2.1 `working-tree.ts` → not reintroduced; the commit does not contain it, verified in `git show --stat cd9fc8f`. §3.1 config → Task 3. §3.2 shadow semantics → Task 5. §3.3 table and unique index → Task 2. §3.4 precision → Task 4. §3.5 enforce unchanged → Task 5 Step 4 leaves `releaseGatedReads` untouched, pinned by the enforce test. §4 schema house rules → Task 2. §5 → Task 6. §6 testing → distributed, each task test-first. §7 non-goals → nothing in any task flips `enforce` on.

**Type consistency.** `WriteGateDecision` gains `shadowedFindingIds: string[]` in Task 5 and `allow()` is updated in the same step, so every existing return path stays well-typed. `ImpactGateMode` is declared in Task 3 and consumed in Task 5. `recordShadowBlock`/`countShadowBlocks`/`shadowGatePrecision` are declared in Task 4 and consumed in Task 5's tests. `impact_gate_shadow`'s columns match between Task 2's DDL, Task 2's test, and Task 4's SQL.

**Ordering note.** Task 4's tests insert into `impact_gate_shadow`, so Task 2 must land first. Task 5 consumes both. Tasks 6 and 7 are independent and may be done in either order after Task 5.
