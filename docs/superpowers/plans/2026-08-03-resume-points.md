# Resume Points Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user park a workstream under a short key they keep, and resume it from any later session in any directory by pasting that key back.

**Architecture:** A `resume_points` table holding one brief per key, plus two MCP tools. `knowl_park` mints a key and returns a paste-ready instruction line; `knowl_resume` takes that key and returns the brief. Keys are looked up globally, not per project, so pasting one into the wrong directory still finds it.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), `@libsql/client`, `node:crypto`, Vitest, MCP SDK.

**Adapted from PR #11** (`William-Sommers:feat/transcript-vectors`). Most of that PR has landed here by other routes — the granite presets are on `main`, and the whole-archive semantic ranking shipped as `src/transcripts/`. What remains unbuilt is this feature, spread across `src/store/resume-points.ts` and several follow-up fix commits.

## This is not the same feature as the handoff baton

They look alike and are not. Build both; do not merge them.

| | Handoff baton (`knowl_handoff`) | Resume point (`knowl_park`) |
|---|---|---|
| How many | **One** per project | **Many** at once |
| Who holds it | The project — next session gets it automatically | **The user** — they hold the key |
| Delivery | Pushed once, then archived | Pulled on demand, by key |
| Spent on use | **Yes**, one-shot | **No**, resume repeatedly |
| Reach | Next session in this project | Any session, any directory, any time later |

"I'm stopping for the night, whoever picks this up next should know where I left it" is the baton. "Park this branch of work, I'll come back to it in a week or two" is a resume point.

## Global Constraints

- **ESM imports.** All relative imports end in `.js`.
- **Keys are looked up globally.** A key pasted into the wrong directory must still resolve. Scoping lookup by project defeats the feature's reason to exist.
- **A brief is context, not authorisation.** PR #11 shipped a fix commit for exactly this. The rendered brief must not read as a command the resuming session should obey — it describes what was parked, and points at the transcript as the source of truth.
- **A key must never read as a word.** See Task 1 — this is a prompt-injection surface, not a cosmetic preference.
- **Keys survive however a user pastes them.** Case, surrounding whitespace, quotes and a `knowl resume ` prefix all normalize away.
- **Do not touch `src/transcripts/`.** This feature is independent of transcript search.
- **Tool inventory is asserted.** `tests/core/knowl-guidance.test.ts:44-45` pins `KNOWL_MCP_TOOL_GROUPS` at 7 groups and `KNOWL_MCP_TOOL_NAMES` at 24. These two tools are unconditional, so both counts change — to **8 groups / 26 tools** if this ships alone. If the deliberate-handoff plan ships first it will already have taken them to 8/25; then this becomes **9 groups / 27 tools**. Read the current values before editing the fixture.
- **Verification gate:** `npm test` + `npm run build` + `git diff --check`. Not `npx tsc --noEmit` — `main` has 15 pre-existing errors in untouched files.
- **Commit style:** Conventional Commits, lowercase subject, no trailing period.

---

### Task 1: Mint a key a person can retype and an agent cannot misread

**Files:**
- Create: `src/store/resume-keys.ts`
- Test: `tests/store/resume-keys.test.ts`

**Interfaces:**
- Consumes: `randomInt` from `node:crypto`
- Produces:
  - `mintResumeKey(): string`
  - `normalizeResumeKey(raw: string): string | null`
  - `resumeInstruction(key: string): string`

**Two properties, both load-bearing:**

**It must not spell a word.** A key the user pastes back arrives inside a prompt. A six-character key drawn from a full alphabet can legitimately spell `budget`, `answer`, `delete` — and a key that reads as an instruction is one the model may act on rather than look up. Alternating consonant-digit positions makes a word structurally impossible while keeping the key pronounceable enough to read aloud.

**It must survive being transcribed by a human.** The alphabet omits every character people copy wrongly from a screen: `l`/`1`/`I`, `0`/`O`, `5`/`S`, `2`/`Z`. A key that cannot be retyped from a sticky note is a key that gets lost.

- [ ] **Step 1: Write the failing test**

Create `tests/store/resume-keys.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { mintResumeKey, normalizeResumeKey, resumeInstruction } from '../../src/store/resume-keys.js';

describe('mintResumeKey', () => {
  it('mints a key a person can retype: short, lowercase, no lookalike characters', () => {
    for (let i = 0; i < 200; i++) {
      const key = mintResumeKey();
      expect(key).toHaveLength(6);
      expect(key).toBe(key.toLowerCase());
      expect(key).not.toMatch(/[l1i0o5s2z]/);
    }
  });

  it('never mints a key that could read as a word, so it cannot be mistaken for an instruction', () => {
    for (let i = 0; i < 500; i++) {
      const key = mintResumeKey();
      // Digits in the odd positions make a pronounceable English word structurally impossible.
      expect(key).toMatch(/^[a-z]\d[a-z]\d[a-z]\d$/);
    }
  });

  it('does not repeat itself over a realistic number of parks', () => {
    const keys = new Set(Array.from({ length: 2_000 }, () => mintResumeKey()));
    expect(keys.size).toBe(2_000);
  });
});

describe('normalizeResumeKey', () => {
  it('accepts the key however the user pastes it', () => {
    const variants = ['k3t9m4', 'K3T9M4', '  k3t9m4  ', '"k3t9m4"', 'knowl resume k3t9m4', '`k3t9m4`'];
    for (const variant of variants) expect(normalizeResumeKey(variant)).toBe('k3t9m4');
  });

  it('rejects anything that is not a key rather than guessing', () => {
    for (const bad of ['', '   ', 'not-a-key', 'k3t9m', 'k3t9m44', 'k3t9m!']) {
      expect(normalizeResumeKey(bad)).toBeNull();
    }
  });

  it('rejects a key containing a lookalike character it could never have minted', () => {
    expect(normalizeResumeKey('k3t9l4')).toBeNull();
  });
});

describe('resumeInstruction', () => {
  it('returns a line the user can paste verbatim into a later session', () => {
    const line = resumeInstruction('k3t9m4');
    expect(line).toContain('k3t9m4');
    expect(line.split('\n')).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/store/resume-keys.test.ts`
Expected: FAIL — `Cannot find module '../../src/store/resume-keys.js'`

- [ ] **Step 3: Write the implementation**

Create `src/store/resume-keys.ts`:

```typescript
import { randomInt } from 'node:crypto';

/**
 * Letters a person will not mis-transcribe.
 *
 * Omits `l` and `i` (confusable with `1`), `o` (with `0`), `s` (with `5`) and `z` (with `2`).
 * Vowels are omitted too: without them the alternating pattern below cannot spell a word even
 * by accident.
 */
const LETTERS = 'bcdfghjkmnpqrtvwxy';

/** Digits with the same treatment: no `0`, `1`, `2` or `5`. */
const DIGITS = '346789';

const KEY_LENGTH = 6;

const pick = (alphabet: string) => alphabet[randomInt(alphabet.length)];

/**
 * A key the user keeps.
 *
 * Letter-digit alternating, six characters. The shape is not cosmetic: a key is pasted back
 * into a prompt, and a six-character key from a full alphabet can legitimately spell `budget`
 * or `delete`. A key that reads as an instruction is one a model may act on instead of look up.
 * Alternating positions makes a pronounceable word structurally impossible.
 *
 * 18 letters x 6 digits per pair, three pairs: about 1.3 million keys. Collisions are handled
 * by the caller retrying on a unique-constraint violation, not by making the key longer.
 */
export function mintResumeKey(): string {
  let key = '';
  for (let i = 0; i < KEY_LENGTH; i += 2) key += pick(LETTERS) + pick(DIGITS);
  return key;
}

const KEY_SHAPE = new RegExp(`^([${LETTERS}][${DIGITS}]){${KEY_LENGTH / 2}}$`);

/**
 * The key inside whatever the user pasted, or null.
 *
 * People paste keys with quotes, backticks, stray whitespace, and often the whole instruction
 * line they were given. Rejecting those would mean the feature works only for people who
 * hand-extract the key, which is exactly the friction the short key exists to avoid.
 *
 * Null rather than a nearest match: resuming the wrong workstream silently is worse than saying
 * the key is unknown.
 */
export function normalizeResumeKey(raw: string): string | null {
  if (typeof raw !== 'string') return null;
  const cleaned = raw
    .trim()
    .replace(/^knowl\s+resume\s+/i, '')
    .replace(/^[`'"]+|[`'"]+$/g, '')
    .trim()
    .toLowerCase();

  return KEY_SHAPE.test(cleaned) ? cleaned : null;
}

/**
 * The line to hand the user verbatim.
 *
 * Returned instead of the bare key because a key reworded is a key lost: told only "your key is
 * k3t9m4", people write it into a note and later paste something the next session does not
 * recognise as a resume request. One pasteable line removes that step.
 */
export function resumeInstruction(key: string): string {
  return `To pick this up later, paste this into any Knowl session: knowl resume ${key}`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/store/resume-keys.test.ts`
Expected: PASS, 7 tests

- [ ] **Step 5: Commit**

```bash
git add src/store/resume-keys.ts tests/store/resume-keys.test.ts
git commit -m "feat(resume): mint keys a person can retype and a model cannot misread"
```

---

### Task 2: Store and retrieve parked briefs

**Files:**
- Modify: `src/store/bootstrap.ts` (add `resume_points` to `SCHEMA_STATEMENTS`)
- Create: `src/store/resume-points.ts`
- Test: `tests/store/resume-points.test.ts`

**Interfaces:**
- Consumes: `mintResumeKey` / `normalizeResumeKey` (Task 1), `getClient()` from `src/store/database.js`
- Produces:
  ```typescript
  type ResumeBrief = {
    goal: string;
    completed?: string[];
    nextAction?: string;
    blocker?: string;
    artifactRefs?: string[];
    verificationStatus?: 'verified' | 'unverified';
    sessionId?: string;
  };
  type ResumePoint = ResumeBrief & { key: string; projectDir: string; createdAt: string };
  createResumePoint(projectDir: string, brief: ResumeBrief): Promise<ResumePoint>;
  readResumePoint(rawKey: string): Promise<ResumePoint | null>;
  listResumePoints(projectDir: string, limit?: number): Promise<ResumePoint[]>;
  ```

**Lookup is global; listing is per project.** `readResumePoint` takes only a key and searches every row, because the whole point is that a key works from anywhere — a user who parked work in `~/work/api` and pastes the key while sitting in `~/work/web` must still get their brief. `listResumePoints` is the "what did I park *here*" view and is scoped.

- [ ] **Step 1: Write the failing test**

Create `tests/store/resume-points.test.ts`. Copy the `initDb` + temp-root setup from an existing `tests/store/` test.

```typescript
describe('createResumePoint', () => {
  it('returns a key and stores the brief under it', async () => {
    const point = await createResumePoint('/repo/api', { goal: 'Ship the parser', nextAction: 'Wire the CLI flag' });

    expect(point.key).toMatch(/^[a-z]\d[a-z]\d[a-z]\d$/);
    expect(point.goal).toBe('Ship the parser');

    const read = await readResumePoint(point.key);
    expect(read?.nextAction).toBe('Wire the CLI flag');
  });

  it('holds several parked workstreams at once, unlike the single session baton', async () => {
    const first = await createResumePoint('/repo/api', { goal: 'First workstream' });
    const second = await createResumePoint('/repo/api', { goal: 'Second workstream' });

    expect(first.key).not.toBe(second.key);
    expect((await readResumePoint(first.key))?.goal).toBe('First workstream');
    expect((await readResumePoint(second.key))?.goal).toBe('Second workstream');
  });

  it('round-trips every field of the brief', async () => {
    const point = await createResumePoint('/repo/api', {
      goal: 'Ship the parser',
      completed: ['schema', 'tests'],
      nextAction: 'Wire the CLI flag',
      blocker: 'Waiting on the config shape',
      artifactRefs: ['src/parser.ts'],
      verificationStatus: 'unverified',
      sessionId: 'session-abc',
    });

    const read = await readResumePoint(point.key);
    expect(read).toMatchObject({
      completed: ['schema', 'tests'],
      blocker: 'Waiting on the config shape',
      artifactRefs: ['src/parser.ts'],
      verificationStatus: 'unverified',
      sessionId: 'session-abc',
    });
  });
});

describe('readResumePoint', () => {
  it('finds a key regardless of which directory it is pasted into', async () => {
    const point = await createResumePoint('/repo/api', { goal: 'Parked in api' });

    // No project argument at all: a key works from anywhere, which is the point.
    expect((await readResumePoint(point.key))?.goal).toBe('Parked in api');
  });

  it('accepts the key however the user pastes it', async () => {
    const point = await createResumePoint('/repo/api', { goal: 'Parked' });

    for (const variant of [point.key.toUpperCase(), `  ${point.key}  `, `knowl resume ${point.key}`]) {
      expect((await readResumePoint(variant))?.goal).toBe('Parked');
    }
  });

  it('resumes more than once, because work gets picked up and parked again', async () => {
    const point = await createResumePoint('/repo/api', { goal: 'Parked' });

    expect(await readResumePoint(point.key)).not.toBeNull();
    expect(await readResumePoint(point.key)).not.toBeNull();
  });

  it('returns nothing for an unknown key rather than the nearest match', async () => {
    await createResumePoint('/repo/api', { goal: 'Parked' });

    expect(await readResumePoint('k3t9m4')).toBeNull();
    expect(await readResumePoint('not-a-key')).toBeNull();
  });
});

describe('listResumePoints', () => {
  it('lists what is parked in this project, newest first', async () => {
    await createResumePoint('/repo/api', { goal: 'Older' });
    await createResumePoint('/repo/api', { goal: 'Newer' });
    await createResumePoint('/repo/web', { goal: 'Elsewhere' });

    const points = await listResumePoints('/repo/api');

    expect(points.map(p => p.goal)).toEqual(['Newer', 'Older']);
  });

  it('returns an empty list when nothing is parked here', async () => {
    expect(await listResumePoints('/repo/empty')).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/store/resume-points.test.ts`
Expected: FAIL — `Cannot find module '../../src/store/resume-points.js'`

- [ ] **Step 3: Add the table**

In `src/store/bootstrap.ts`, add to `SCHEMA_STATEMENTS`:

```typescript
  `CREATE TABLE IF NOT EXISTS resume_points (
    key TEXT PRIMARY KEY,
    project_dir TEXT NOT NULL,
    brief TEXT NOT NULL,
    created_at TEXT NOT NULL
  );`,

  `CREATE INDEX IF NOT EXISTS idx_resume_points_project ON resume_points(project_dir, created_at);`,
```

The brief is one JSON column rather than a column per field: it is written whole, read whole, and never queried by field. A schema change per new brief field would buy nothing.

- [ ] **Step 4: Write the implementation**

Create `src/store/resume-points.ts`:

```typescript
import { getClient } from './database.js';
import { mintResumeKey, normalizeResumeKey } from './resume-keys.js';

export type ResumeBrief = {
  goal: string;
  completed?: string[];
  nextAction?: string;
  blocker?: string;
  artifactRefs?: string[];
  verificationStatus?: 'verified' | 'unverified';
  /** The session that parked it, so a resuming session can read the transcript itself. */
  sessionId?: string;
};

export type ResumePoint = ResumeBrief & {
  key: string;
  projectDir: string;
  createdAt: string;
};

/** Retries on the vanishingly unlikely key collision rather than lengthening every key. */
const MINT_ATTEMPTS = 5;

export async function createResumePoint(projectDir: string, brief: ResumeBrief): Promise<ResumePoint> {
  const createdAt = new Date().toISOString();

  for (let attempt = 0; attempt < MINT_ATTEMPTS; attempt++) {
    const key = mintResumeKey();
    try {
      await getClient().execute({
        sql: 'INSERT INTO resume_points (key, project_dir, brief, created_at) VALUES (?, ?, ?, ?)',
        args: [key, projectDir, JSON.stringify(brief), createdAt],
      });
      return { ...brief, key, projectDir, createdAt };
    } catch (error) {
      if (!String(error).toUpperCase().includes('UNIQUE')) throw error;
    }
  }

  throw new Error('Could not mint a unique resume key.');
}

function toPoint(row: Record<string, unknown>): ResumePoint | null {
  try {
    return {
      ...(JSON.parse(String(row.brief)) as ResumeBrief),
      key: String(row.key),
      projectDir: String(row.project_dir),
      createdAt: String(row.created_at),
    };
  } catch {
    // A brief that will not parse is unusable; treating it as absent beats throwing at the
    // one moment the user is trying to get their work back.
    return null;
  }
}

/**
 * The brief behind a key, from anywhere.
 *
 * Deliberately takes no project argument. A key is held by the user, not by a directory, and
 * pasting one while sitting in a different repo is the normal case rather than a mistake.
 *
 * Reading does not consume it: work gets picked up, put down, and picked up again.
 */
export async function readResumePoint(rawKey: string): Promise<ResumePoint | null> {
  const key = normalizeResumeKey(rawKey);
  if (!key) return null;

  const rows = (await getClient().execute({
    sql: 'SELECT key, project_dir, brief, created_at FROM resume_points WHERE key = ?',
    args: [key],
  })).rows;

  return rows[0] ? toPoint(rows[0] as Record<string, unknown>) : null;
}

/** What is parked in this project, newest first. The "what did I leave here" view. */
export async function listResumePoints(projectDir: string, limit = 20): Promise<ResumePoint[]> {
  const rows = (await getClient().execute({
    sql: `SELECT key, project_dir, brief, created_at FROM resume_points
          WHERE project_dir = ? ORDER BY created_at DESC, rowid DESC LIMIT ?`,
    args: [projectDir, limit],
  })).rows;

  return rows
    .map(row => toPoint(row as Record<string, unknown>))
    .filter((point): point is ResumePoint => point !== null);
}
```

`ORDER BY created_at DESC, rowid DESC` rather than `created_at` alone: two points parked in the same millisecond would otherwise come back in arbitrary order. That exact bug is why [access-feedback.ts:95](../../../src/store/access-feedback.ts#L95) orders by `rowid`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/store/resume-points.test.ts`
Expected: PASS, 9 tests

- [ ] **Step 6: Commit**

```bash
git add src/store/bootstrap.ts src/store/resume-points.ts tests/store/resume-points.test.ts
git commit -m "feat(resume): park a workstream under a key the user keeps"
```

---

### Task 3: Render a brief as context, not as orders

**Files:**
- Modify: `src/store/resume-points.ts`
- Test: `tests/store/resume-points.test.ts`

**Interfaces:**
- Consumes: `ResumePoint` (Task 2)
- Produces: `formatResumeBrief(point: ResumePoint): string`

PR #11 shipped a dedicated fix commit for this — `fix(resume/handoff): a brief is context, not authorisation` — which means the first version got it wrong in a way worth not repeating.

A brief is text a user parked days ago, replayed into a fresh session's context. If it renders as imperatives, the resuming session treats stale intent as current instruction: it may resume work the user has since abandoned, act on a `nextAction` that no longer applies, or trust a claim the brief makes about what is done. The brief describes a past state and points at the transcript as the thing to verify against.

- [ ] **Step 1: Write the failing test**

Append to `tests/store/resume-points.test.ts`:

```typescript
describe('formatResumeBrief', () => {
  const point = (over: Partial<ResumePoint> = {}): ResumePoint => ({
    key: 'k3t9m4',
    projectDir: '/repo/api',
    createdAt: '2026-08-03T10:00:00.000Z',
    goal: 'Ship the parser',
    nextAction: 'Wire the CLI flag',
    completed: ['schema', 'tests'],
    ...over,
  });

  it('renders the brief as a description of parked work', () => {
    const text = formatResumeBrief(point());

    expect(text).toContain('Ship the parser');
    expect(text).toContain('Wire the CLI flag');
    expect(text).toContain('2026-08-03');
  });

  it('marks the brief as context rather than instruction', () => {
    const text = formatResumeBrief(point());

    // The resuming session must not read stale intent as a current order.
    expect(text).toMatch(/parked|recorded|was the plan/i);
    expect(text).toMatch(/confirm|check|may be out of date|verify/i);
  });

  it('points at the transcript instead of asking the reader to trust the brief', () => {
    const text = formatResumeBrief(point({ sessionId: 'session-abc' }));

    expect(text).toContain('session-abc');
    expect(text).toMatch(/knowl_transcript_search|transcript/i);
  });

  it('says nothing about the transcript when no session was recorded', () => {
    expect(formatResumeBrief(point({ sessionId: undefined }))).not.toMatch(/knowl_transcript_search/);
  });

  it('omits empty sections rather than printing empty headings', () => {
    const text = formatResumeBrief(point({ completed: [], blocker: undefined, artifactRefs: [] }));

    expect(text).not.toMatch(/Completed:/);
    expect(text).not.toMatch(/Blocker:/);
    expect(text).not.toMatch(/Artifacts:/);
  });

  it('flags unverified work so it is not taken as done', () => {
    const text = formatResumeBrief(point({ verificationStatus: 'unverified' }));
    expect(text).toMatch(/unverified/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/store/resume-points.test.ts`
Expected: FAIL — `formatResumeBrief` is not exported.

- [ ] **Step 3: Write the implementation**

Add to `src/store/resume-points.ts`:

```typescript
/**
 * What the resuming session reads.
 *
 * Deliberately framed as a report on a past state, not as instructions. This text is replayed
 * into a fresh session's context possibly weeks later, and a brief written as imperatives is a
 * brief the model may simply obey -- resuming work the user has since dropped, or acting on a
 * next step that no longer applies. The user is in the room; they can confirm.
 *
 * The transcript is named as the source of truth, because the brief is a summary someone wrote
 * in a hurry and the transcript is what actually happened.
 */
export function formatResumeBrief(point: ResumePoint): string {
  const lines = [
    `# Parked workstream (${point.key})`,
    '',
    `Recorded ${point.createdAt} in ${point.projectDir}. This is context from a past session, not a current instruction -- confirm with the user before acting on it, since it may be out of date.`,
    '',
    `Goal at the time: ${point.goal}`,
  ];

  if (point.completed?.length) lines.push(`Completed: ${point.completed.join('; ')}`);
  if (point.nextAction) lines.push(`Next step recorded: ${point.nextAction}`);
  if (point.blocker) lines.push(`Blocker recorded: ${point.blocker}`);
  if (point.artifactRefs?.length) lines.push(`Artifacts: ${point.artifactRefs.join('; ')}`);
  if (point.verificationStatus === 'unverified') {
    lines.push('The work above was recorded as unverified -- treat it as claimed, not confirmed.');
  }

  if (point.sessionId) {
    lines.push(
      '',
      `Parked from session ${point.sessionId}. Read what actually happened with knowl_transcript_search (sessionId: "${point.sessionId}") rather than trusting this summary.`,
    );
  }

  return lines.join('\n');
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/store/resume-points.test.ts`
Expected: PASS, 15 tests

- [ ] **Step 5: Commit**

```bash
git add src/store/resume-points.ts tests/store/resume-points.test.ts
git commit -m "feat(resume): render a brief as context rather than as authorisation"
```

---

### Task 4: The `knowl_park` and `knowl_resume` tools

**Files:**
- Modify: `src/mcp/tools.ts` (tool list + dispatcher)
- Modify: `src/core/knowl-guidance.ts` (`KNOWL_MCP_TOOL_GROUPS` + compact card Route line)
- Modify: `tests/core/knowl-guidance.test.ts:16` (`EXPECTED_TOOLS`), `:44` (group count)
- Test: `tests/mcp/server.test.ts`

**Interfaces:**
- Consumes: `createResumePoint`, `readResumePoint`, `listResumePoints`, `formatResumeBrief` (Tasks 2-3), `resumeInstruction` (Task 1)
- Produces: MCP tools `knowl_park` and `knowl_resume`

Both are unconditional — no config gate, no index, no model.

**`knowl_resume` with no key lists what is parked here.** A user who remembers parking something but not the key still gets somewhere, and it makes the tool safe to call speculatively.

- [ ] **Step 1: Write the failing test**

Update `tests/core/knowl-guidance.test.ts`: add `'knowl_park'` and `'knowl_resume'` to `EXPECTED_TOOLS`, and bump the group count. **Read the current values first** — if the deliberate-handoff plan already shipped, the baseline is 8 groups / 25 tools, not 7 / 24.

Append to `tests/mcp/server.test.ts`:

```typescript
  it('lists both resume tools', async () => {
    const names = (await runRpcRequest('tools/list', {})).result.tools.map((t: { name: string }) => t.name);
    expect(names).toContain('knowl_park');
    expect(names).toContain('knowl_resume');
  });

  it('parks and returns a paste-ready instruction, not a bare key', async () => {
    const response = await runRpcRequest('tools/call', {
      name: 'knowl_park',
      arguments: { goal: 'Ship the parser', nextAction: 'Wire the CLI flag' },
    });

    const text = JSON.stringify(response.result);
    expect(text).toMatch(/knowl resume [a-z]\d[a-z]\d[a-z]\d/);
  });

  it('resumes a parked workstream by key', async () => {
    const parked = await runRpcRequest('tools/call', {
      name: 'knowl_park', arguments: { goal: 'Ship the parser' },
    });
    const key = /([a-z]\d[a-z]\d[a-z]\d)/.exec(JSON.stringify(parked.result))![1];

    const resumed = await runRpcRequest('tools/call', {
      name: 'knowl_resume', arguments: { key },
    });

    expect(JSON.stringify(resumed.result)).toContain('Ship the parser');
  });

  it('lists what is parked here when resume is called with no key', async () => {
    await runRpcRequest('tools/call', { name: 'knowl_park', arguments: { goal: 'Something parked' } });

    const response = await runRpcRequest('tools/call', { name: 'knowl_resume', arguments: {} });

    expect(JSON.stringify(response.result)).toContain('Something parked');
  });

  it('says so plainly for an unknown key', async () => {
    const response = await runRpcRequest('tools/call', {
      name: 'knowl_resume', arguments: { key: 'k3t9m4' },
    });

    expect(JSON.stringify(response.result)).toMatch(/no parked workstream|unknown key/i);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/core/knowl-guidance.test.ts tests/mcp/server.test.ts`
Expected: FAIL — neither tool is registered.

- [ ] **Step 3: Add the guidance group**

In `src/core/knowl-guidance.ts`:

```typescript
  {
    label: 'Parked work',
    tools: ['knowl_park', 'knowl_resume'],
    routing: 'Park work the user means to come back to: knowl_park mints a short key and returns a paste-ready line to hand them verbatim, since a key reworded is a key lost. knowl_resume takes that key in any later session, from any directory, and returns the brief. Unlike the handoff baton -- which the next session in this project consumes once -- a key is held by the user, is not spent by resuming, and works any number of sessions later. Call knowl_resume as soon as a user supplies a key; with no key it lists what is parked here.',
  },
```

Add one Route line to the compact card, matching the existing bullets:

```typescript
    '- parked work: knowl_park mints a key the user keeps; knowl_resume takes that key any time later, from any directory.',
```

The card has a 2,000-character ceiling and was 1,746 before any of this. Measure after the change and report the number in the commit message; if it would exceed, tighten an existing bullet rather than dropping this one.

- [ ] **Step 4: Register and dispatch**

In `src/mcp/tools.ts`:

```typescript
        {
          name: 'knowl_park',
          description: 'Park a workstream the user means to return to. Mints a short key and returns a line to hand them verbatim. Unlike knowl_handoff, this is not consumed by resuming and works from any directory, any number of sessions later.',
          inputSchema: {
            type: 'object',
            properties: {
              goal: { type: 'string', maxLength: 2000, description: 'What this workstream is trying to achieve.' },
              completed: { type: 'array', items: { type: 'string' }, maxItems: 20, description: 'What is already done.' },
              nextAction: { type: 'string', maxLength: 2000, description: 'The next step as it stands now.' },
              blocker: { type: 'string', maxLength: 2000, description: 'What is in the way, if anything.' },
              artifactRefs: { type: 'array', items: { type: 'string' }, maxItems: 20, description: 'Files the returning session should look at.' },
              verificationStatus: { type: 'string', enum: ['verified', 'unverified'], description: 'Whether the work so far was checked.' },
            },
            required: ['goal'],
          },
        },
        {
          name: 'knowl_resume',
          description: 'Resume a parked workstream from its key. Call this as soon as a user supplies something that looks like a resume key. With no key, lists what is parked in this project.',
          inputSchema: {
            type: 'object',
            properties: {
              key: { type: 'string', maxLength: 200, description: 'The key the user pasted, in whatever form they pasted it.' },
            },
          },
        },
```

Dispatcher, following the neighbouring handlers' return shape:

```typescript
    if (name === 'knowl_park') {
      const projectRoot = getProjectRoot();
      if (!projectRoot) return textResult('Project is not initialized.');

      const point = await createResumePoint(projectRoot, {
        goal: String(args.goal ?? ''),
        completed: Array.isArray(args.completed) ? args.completed.map(String).slice(0, 20) : undefined,
        nextAction: args.nextAction ? String(args.nextAction) : undefined,
        blocker: args.blocker ? String(args.blocker) : undefined,
        artifactRefs: Array.isArray(args.artifactRefs) ? args.artifactRefs.map(String).slice(0, 20) : undefined,
        verificationStatus: args.verificationStatus === 'verified' ? 'verified' : 'unverified',
        sessionId: args.sessionId ? String(args.sessionId) : undefined,
      });

      // The instruction line, not the bare key: told only "your key is k3t9m4", people write
      // down something the next session will not recognise as a resume request.
      return textResult(`Parked.\n\n${resumeInstruction(point.key)}`);
    }

    if (name === 'knowl_resume') {
      const projectRoot = getProjectRoot();
      if (!projectRoot) return textResult('Project is not initialized.');

      if (args.key) {
        const point = await readResumePoint(String(args.key));
        if (!point) {
          return textResult(`No parked workstream for that key. Call knowl_resume with no key to list what is parked in this project.`);
        }
        return textResult(formatResumeBrief(point));
      }

      const points = await listResumePoints(projectRoot);
      if (points.length === 0) return textResult('Nothing is parked in this project.');

      return textResult([
        'Parked in this project:',
        ...points.map(point => `- ${point.key}: ${point.goal} (${point.createdAt})`),
        '',
        'Resume one with knowl_resume and its key.',
      ].join('\n'));
    }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/core/knowl-guidance.test.ts tests/mcp/server.test.ts tests/store/resume-points.test.ts`
Expected: PASS

Run: `npm test && npm run build && git diff --check`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/mcp/tools.ts src/core/knowl-guidance.ts tests/core/knowl-guidance.test.ts tests/mcp/server.test.ts
git commit -m "feat(resume): expose knowl_park and knowl_resume"
```

---

### Task 5: The `knowl resume` CLI path

**Files:**
- Modify: `src/index.ts` (add a `resume` command)
- Test: `tests/cli/resume-command.test.ts`

**Interfaces:**
- Consumes: `readResumePoint`, `listResumePoints`, `formatResumeBrief` (Tasks 2-3)
- Produces: `knowl resume [key]`

The instruction line minted in Task 1 reads `knowl resume <key>`. A user will paste that into a terminal as readily as into a chat — and a command that does not exist makes the instruction look broken. This closes that loop.

- [ ] **Step 1: Write the failing test**

Create `tests/cli/resume-command.test.ts`, following the harness in the other `tests/cli/` command tests:

```typescript
describe('knowl resume', () => {
  it('prints the brief for a key', async () => {
    const point = await createResumePoint(TEST_ROOT, { goal: 'Ship the parser' });

    const output = await runCli(['resume', point.key]);

    expect(output).toContain('Ship the parser');
  });

  it('accepts a key pasted with surrounding noise', async () => {
    const point = await createResumePoint(TEST_ROOT, { goal: 'Ship the parser' });

    expect(await runCli(['resume', `"${point.key.toUpperCase()}"`])).toContain('Ship the parser');
  });

  it('lists what is parked here when given no key', async () => {
    await createResumePoint(TEST_ROOT, { goal: 'Something parked' });

    expect(await runCli(['resume'])).toContain('Something parked');
  });

  it('exits non-zero for an unknown key', async () => {
    await expect(runCli(['resume', 'k3t9m4'])).rejects.toMatchObject({ exitCode: 1 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/cli/resume-command.test.ts`
Expected: FAIL — unknown command `resume`.

- [ ] **Step 3: Add the command**

In `src/index.ts`, beside the other commands:

```typescript
program
  .command('resume')
  .description('Resume a parked workstream, or list what is parked here')
  .argument('[key]', 'The key you were given when the work was parked')
  .action(async (key?: string) => {
    try {
      const root = await findProjectRoot(process.cwd());
      await initDb(root);

      if (key) {
        const point = await readResumePoint(key);
        if (!point) {
          console.error(`No parked workstream for that key. Run \`knowl resume\` with no key to list what is parked here.`);
          process.exitCode = 1;
        } else {
          console.log(formatResumeBrief(point));
        }
      } else {
        const points = await listResumePoints(root);
        if (points.length === 0) console.log('Nothing is parked in this project.');
        else for (const point of points) console.log(`${point.key}  ${point.goal}  (${point.createdAt})`);
      }

      await closeDb();
    } catch (error: any) {
      console.error(`Error resuming: ${error.message}`);
      process.exit(1);
    }
  });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/cli/resume-command.test.ts`
Expected: PASS, 4 tests

- [ ] **Step 5: Verify the loop end to end**

```bash
npm run build
node dist/index.js resume            # -> nothing parked
# park something through the MCP tool or a direct createResumePoint call, then:
node dist/index.js resume <key>      # -> the brief
```

Expected: the exact line `resumeInstruction` produces works verbatim when pasted into a shell.

- [ ] **Step 6: Commit**

```bash
git add src/index.ts tests/cli/resume-command.test.ts
git commit -m "feat(resume): accept the minted instruction line as a CLI command"
```

---

## Self-review notes

**PR coverage.** #11's unbuilt work maps as: key minting and normalization → Task 1; `createResumePoint` / `readResumePoint` / `listResumePoints` → Task 2; `formatResumeBrief` and its `a brief is context, not authorisation` fix → Task 3; `knowl_park` / `knowl_resume` and the inventory registration → Task 4; `resumeInstruction` reaching a shell → Task 5.

**Deliberately not ported from #11.** The granite and arctic-embed model commits — `main` already resolves `granite-small-en-r2` through `src/core/vector-profile.ts`. The whole-archive transcript ranking and its `transcript-vectors.ts` — shipped as `src/transcripts/`. The `project-dir.ts` refactor and `freshness` / `gc` / `host-lifecycle` churn — unrelated to this feature and not obviously wanted. The `chore(fork)` version bump — fork bookkeeping that means nothing here.

**One thing to check before Task 4.** The tool-inventory numbers depend on whether the deliberate-handoff plan shipped first. Task 4 says to read the current `EXPECTED_TOOLS` and group count rather than trusting a number written here.

**Verified, not assumed:** `src/store/resume-points.ts` absent from `main`; no `knowl_park` or `knowl_resume` in the tool surface; `KNOWL_MCP_TOOL_GROUPS` at 7 and `KNOWL_MCP_TOOL_NAMES` at 24 today; PR #11's own `fix(resume/handoff): a brief is context, not authorisation` commit, which is why Task 3 exists as its own task rather than as three lines inside Task 2.
