# Extractor Rebuild, Phase 1 (fact extraction) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the session extractor around the two fields that were measured to carry 97% of capturable knowledge — git commit subjects and error text — and remove the rules measured at zero.

**Architecture:** The two new rules are pure functions in `src/store/extractors/`, taking plain strings and event arrays and returning plain data. `session-candidates.ts` stays the orchestrator that reads the database and assembles `MemoryCandidate[]`. Pure rules test instantly with no database, and the committed 32-session corpus serves as a regression fixture in the final task.

**Tech Stack:** TypeScript (ESM, `.js` import extensions), vitest, libSQL/Drizzle. Product suite (`npm test`), not the benchmark suite.

## Global Constraints

From `docs/superpowers/specs/2026-07-31-extractor-rebuild-and-skill-loop-design.md`. Every task's requirements implicitly include this section.

- **Phase 1 stays model-free.** `finalizeMemorySession` must keep reporting `usedAi: false`. No task here may introduce an API call, a model dependency, or a prompt.
- **Measured shares this rebuild is aimed at:** git commit subject 52%, `error.message` 45%, other command text 3%, **`changedPaths` alone 0%**.
- **Skip commit types `docs:`, `test:`, `chore:`, and merge commits.** They are process, not knowledge — the same reason `Work Loop finish` is noise.
- **Error signature matching is normalised, never raw string equality.** Exception class, code and first frame are kept; paths, line numbers and hex addresses are stripped, because identical failures rarely produce byte-identical text.
- **No `Repeated workflow:` item may ever be written again in that shape.** (Spec success criterion 4. Phase 2 rebuilds skill capture properly; Phase 1 removes the rule that writes junk.)
- Product tests live in `tests/**/*.test.ts` and run under `npm test`. Benchmarks are excluded from that suite by design.
- **`npm run typecheck:bench` is already red on 17 pre-existing `src/` errors and exits 0 regardless.** The binding gate is that your changed files add no new errors: `npx tsc --noEmit 2>&1 | grep "<your file>"` must be empty.
- The project is ESM (`"type": "module"`); relative imports require explicit `.js` extensions.
- **Do not modify `benchmarks/unassisted-capture/corpus/`.** It is a committed snapshot of events that were hard-deleted from the live database hours after capture and cannot be regenerated.

## Correction to the superseded spec

The earlier capture spec proposed a **co-edit coupling** rule. **It was never implemented** — do not go looking for it to delete. The rules that actually exist in `src/store/session-candidates.ts` today are: a `decision`-event rule, the repeated-command rule, and a `stop.summary` outcome rule. Only the latter two are removed here. The `decision`-event rule is inert (no hook path emits `decision` events) but harmless, and removing it is out of scope.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `src/store/extractors/commit-subject.ts` | Parse git commit subjects and bodies out of a command string. Pure. |
| `src/store/extractors/error-signature.ts` | Normalise an error message to a comparable signature. Pure. |
| `src/store/extractors/failure-fix.ts` | Pair an error with the edits that resolved it. Pure over events. |
| `src/store/session-candidates.ts` | Orchestrator: reads events, applies rules, returns ranked candidates. |
| `src/core/types.ts` | `MemoryCandidate.candidateType` union gains `'commit'`. |
| `src/store/candidate-promotion.ts` | Importance weight for the new candidate types. |
| `tests/store/extractors/*.test.ts` | Unit tests for the three pure modules. |
| `tests/store/session-candidates.test.ts` | Existing orchestrator tests, updated. |
| `tests/store/extractor-corpus.test.ts` | Regression test over the committed 32-session corpus. |

---

### Task 1: Commit-subject parser

**Files:**
- Create: `src/store/extractors/commit-subject.ts`
- Test: `tests/store/extractors/commit-subject.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `parseCommitSubjects(command: string): CommitSubject[]` and the type `CommitSubject { type: string | null; subject: string; body: string | null }`. Task 5 imports both.

Both invocation forms appear in the corpus: `git commit ... -m "subject"` and `git commit -q -F - <<'EOF'` with the subject on the next line. A single command string may contain several commits.

- [ ] **Step 1: Write the failing test**

```ts
// tests/store/extractors/commit-subject.test.ts
import { describe, expect, it } from 'vitest';
import { parseCommitSubjects } from '../../../src/store/extractors/commit-subject.js';

describe('parseCommitSubjects', () => {
  it('reads a -m subject and its conventional-commit type', () => {
    const found = parseCommitSubjects('git add -A && git commit -q -m "fix(store): take writes through the client" && git log -1');

    expect(found).toHaveLength(1);
    expect(found[0].type).toBe('fix');
    expect(found[0].subject).toBe('fix(store): take writes through the client');
    expect(found[0].body).toBeNull();
  });

  it('reads a heredoc subject and keeps the body', () => {
    const command = `git commit -q -F - <<'EOF'\nfeat(workspace): record role per repo\n\nThe manifest now carries it.\nEOF`;

    const found = parseCommitSubjects(command);

    expect(found[0].subject).toBe('feat(workspace): record role per repo');
    expect(found[0].body).toBe('The manifest now carries it.');
  });

  it('finds every commit in a command that makes several', () => {
    const command = 'git commit -m "fix(a): one" && git commit -m "feat(b): two"';

    expect(parseCommitSubjects(command).map((c) => c.subject)).toEqual(['fix(a): one', 'feat(b): two']);
  });

  it('returns an empty array for a command that commits nothing', () => {
    expect(parseCommitSubjects('npm run test:bench 2>&1 | tail -5')).toEqual([]);
  });

  it('does not treat a commit-shaped string inside another command as a commit', () => {
    // `git log` printing a past subject must not be captured as a new commit.
    expect(parseCommitSubjects('git log --oneline -1 --format="fix(x): old subject"')).toEqual([]);
  });

  it('reports a null type for a subject with no conventional-commit prefix', () => {
    const found = parseCommitSubjects('git commit -m "Merge branch \\"feat/x\\" into main"');

    expect(found[0].type).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/store/extractors/commit-subject.test.ts`
Expected: FAIL — cannot find module `../../../src/store/extractors/commit-subject.js`.

- [ ] **Step 3: Write the parser**

```ts
// src/store/extractors/commit-subject.ts

export interface CommitSubject {
  /** Conventional-commit type (`fix`, `feat`, …) when the subject carries one. */
  type: string | null;
  subject: string;
  /** First paragraph after the subject, heredoc form only. */
  body: string | null;
}

/** `git commit … -m "subject"`. Requires the -m to belong to a git commit, so a
 *  subject printed by `git log --format=` is not mistaken for a new commit. */
const DASH_M = /\bgit\s+commit\b[^\n]*?\s-m\s+"((?:[^"\\]|\\.)+)"/g;

/** `git commit … -F - <<'EOF'` with the subject on the following line. */
const HEREDOC = /\bgit\s+commit\b[^\n]*?-F\s+-\s*<<\s*'?(\w+)'?\n([\s\S]*?)(?:\n\1\b|$)/g;

const CONVENTIONAL = /^(\w+)(?:\([^)]*\))?!?:/;

function typeOf(subject: string): string | null {
  return CONVENTIONAL.exec(subject)?.[1]?.toLowerCase() ?? null;
}

export function parseCommitSubjects(command: string): CommitSubject[] {
  const found: CommitSubject[] = [];

  for (const match of command.matchAll(DASH_M)) {
    const subject = match[1].replace(/\\"/g, '"').trim();
    if (subject) found.push({ type: typeOf(subject), subject, body: null });
  }

  for (const match of command.matchAll(HEREDOC)) {
    const lines = match[2].split('\n');
    const subject = (lines[0] ?? '').trim();
    if (!subject) continue;
    const body = lines.slice(1).join('\n').trim();
    found.push({ type: typeOf(subject), subject, body: body.length > 0 ? body : null });
  }

  return found;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/store/extractors/commit-subject.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Verify no new type errors**

Run: `npx tsc --noEmit 2>&1 | grep "commit-subject"`
Expected: no output.

- [ ] **Step 6: Commit**

```bash
git add src/store/extractors/commit-subject.ts tests/store/extractors/commit-subject.test.ts
git commit -m "feat(capture): parse git commit subjects out of command payloads"
```

---

### Task 2: Error signature normaliser

**Files:**
- Create: `src/store/extractors/error-signature.ts`
- Test: `tests/store/extractors/error-signature.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `errorSignature(message: string): string`. Task 3 imports it.

Two runs of the same failure differ in absolute paths, line and column numbers, hex addresses, durations and temp-directory names. The signature strips those so "the same error" can be recognised across attempts.

- [ ] **Step 1: Write the failing test**

```ts
// tests/store/extractors/error-signature.test.ts
import { describe, expect, it } from 'vitest';
import { errorSignature } from '../../../src/store/extractors/error-signature.js';

describe('errorSignature', () => {
  it('matches the same failure across runs with different paths and line numbers', () => {
    const first = 'AssertionError: expected 1 to be 2\n  at D:/coding/knowl/tests/a.test.ts:12:34';
    const second = 'AssertionError: expected 1 to be 2\n  at C:/other/tests/a.test.ts:98:7';

    expect(errorSignature(first)).toBe(errorSignature(second));
  });

  it('separates genuinely different failures', () => {
    expect(errorSignature('TypeError: x is not a function'))
      .not.toBe(errorSignature('RangeError: index out of range'));
  });

  it('strips hex addresses so two crashes at different addresses match', () => {
    expect(errorSignature('Segfault at 0x00007ff8ab12cd34'))
      .toBe(errorSignature('Segfault at 0x00001aa2bc98ef01'));
  });

  it('strips durations, which vary run to run', () => {
    expect(errorSignature('FAIL suite (1 test) 802ms')).toBe(errorSignature('FAIL suite (1 test) 15620ms'));
  });

  it('ignores case and collapses whitespace', () => {
    expect(errorSignature('Error:   Broken\n\n  thing')).toBe(errorSignature('error: broken thing'));
  });

  it('returns an empty signature for an empty message rather than throwing', () => {
    expect(errorSignature('   ')).toBe('');
  });

  it('keeps only the leading portion, so a long tail cannot make two identical failures differ', () => {
    // The base must normalise to more than SIGNATURE_CHARS on its own, or both tails
    // survive truncation and the assertion is vacuous.
    const base = 'AssertionError: expected the workspace manifest to record the repo role and the default visibility for every linked repository in the workspace before any promotion runs';

    expect(errorSignature(`${base}\n${'noise line\n'.repeat(50)}`))
      .toBe(errorSignature(`${base}\ndifferent noise entirely`));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/store/extractors/error-signature.test.ts`
Expected: FAIL — cannot find module `../../../src/store/extractors/error-signature.js`.

- [ ] **Step 3: Write the normaliser**

```ts
// src/store/extractors/error-signature.ts

/** Enough to identify the failure, short enough that a long tail of run-specific
 *  noise cannot make two identical failures look different. */
const SIGNATURE_CHARS = 160;

export function errorSignature(message: string): string {
  return message
    .replace(/0x[0-9a-f]+/gi, '')            // hex addresses
    .replace(/\b\d+(?:\.\d+)?m?s\b/gi, '')   // durations
    .replace(/[A-Za-z]:[\\/][^\s:)]*/g, '')  // Windows absolute paths
    .replace(/(?:\/[\w.@-]+){2,}/g, '')      // POSIX absolute paths
    .replace(/:\d+(?::\d+)?/g, '')           // line:column
    .replace(/\b\d+\b/g, '')                 // remaining bare numbers
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    .slice(0, SIGNATURE_CHARS);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/store/extractors/error-signature.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Verify no new type errors**

Run: `npx tsc --noEmit 2>&1 | grep "error-signature"`
Expected: no output.

- [ ] **Step 6: Commit**

```bash
git add src/store/extractors/error-signature.ts tests/store/extractors/error-signature.test.ts
git commit -m "feat(capture): normalise error messages to a comparable signature"
```

---

### Task 3: Failure→fix pairing

**Files:**
- Create: `src/store/extractors/failure-fix.ts`
- Test: `tests/store/extractors/failure-fix.test.ts`

**Interfaces:**
- Consumes: `errorSignature(message: string): string` from `./error-signature.js` (Task 2).
- Produces: `findFailureFixPairs(events: MemorySessionEvent[]): FailureFix[]` and `FailureFix { errorEvent: MemorySessionEvent; message: string; changedPaths: string[]; fixEvents: MemorySessionEvent[] }`. Task 5 imports both.

A pair is: an `error` event, then `checkpoint` events carrying `changedPaths`, then **no further error with the same signature** before the session ends. An error that recurs was not fixed.

`MemorySessionEvent` is already exported from `src/core/types.ts` with fields `id`, `sessionId`, `type`, `payload`, `observedAt`, `expiresAt`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/store/extractors/failure-fix.test.ts
import { describe, expect, it } from 'vitest';
import { findFailureFixPairs } from '../../../src/store/extractors/failure-fix.js';
import type { MemorySessionEvent } from '../../../src/core/types.js';

let seq = 0;
const event = (type: string, payload: Record<string, unknown>): MemorySessionEvent => ({
  id: `e${++seq}`,
  sessionId: 's1',
  type: type as MemorySessionEvent['type'],
  payload,
  observedAt: `2026-07-31T00:00:${String(seq).padStart(2, '0')}.000Z`,
  expiresAt: '2026-08-02T00:00:00.000Z',
});

describe('findFailureFixPairs', () => {
  it('pairs an error with the edits that followed it', () => {
    const pairs = findFailureFixPairs([
      event('error', { message: 'TypeError: x is not a function' }),
      event('checkpoint', { changedPaths: ['src/a.ts'] }),
      event('stop', { status: 'finished' }),
    ]);

    expect(pairs).toHaveLength(1);
    expect(pairs[0].message).toContain('TypeError');
    expect(pairs[0].changedPaths).toEqual(['src/a.ts']);
  });

  it('does not pair an error that recurs later — it was not fixed', () => {
    expect(findFailureFixPairs([
      event('error', { message: 'TypeError: x is not a function' }),
      event('checkpoint', { changedPaths: ['src/a.ts'] }),
      event('error', { message: 'TypeError: x is not a function' }),
    ])).toEqual([]);
  });

  it('recognises recurrence despite different paths and line numbers', () => {
    expect(findFailureFixPairs([
      event('error', { message: 'AssertionError: nope\n at D:/a/x.ts:1:2' }),
      event('checkpoint', { changedPaths: ['src/a.ts'] }),
      event('error', { message: 'AssertionError: nope\n at C:/b/y.ts:99:8' }),
    ])).toEqual([]);
  });

  it('does not pair an error with no edits after it', () => {
    expect(findFailureFixPairs([
      event('error', { message: 'TypeError: boom' }),
      event('stop', { status: 'failed' }),
    ])).toEqual([]);
  });

  it('collects every changed path after the error, de-duplicated', () => {
    const pairs = findFailureFixPairs([
      event('error', { message: 'TypeError: boom' }),
      event('checkpoint', { changedPaths: ['src/a.ts', 'src/b.ts'] }),
      event('checkpoint', { changedPaths: ['src/a.ts'] }),
    ]);

    expect(pairs[0].changedPaths).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('pairs two different errors independently', () => {
    const pairs = findFailureFixPairs([
      event('error', { message: 'TypeError: first' }),
      event('checkpoint', { changedPaths: ['src/a.ts'] }),
      event('error', { message: 'RangeError: second' }),
      event('checkpoint', { changedPaths: ['src/b.ts'] }),
    ]);

    expect(pairs).toHaveLength(2);
    expect(pairs[1].changedPaths).toEqual(['src/b.ts']);
  });

  it('ignores an error event carrying no message', () => {
    expect(findFailureFixPairs([
      event('error', {}),
      event('checkpoint', { changedPaths: ['src/a.ts'] }),
    ])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/store/extractors/failure-fix.test.ts`
Expected: FAIL — cannot find module `../../../src/store/extractors/failure-fix.js`.

- [ ] **Step 3: Write the pairing rule**

```ts
// src/store/extractors/failure-fix.ts
import type { MemorySessionEvent } from '../../core/types.js';
import { errorSignature } from './error-signature.js';

export interface FailureFix {
  errorEvent: MemorySessionEvent;
  message: string;
  changedPaths: string[];
  /** The checkpoint events that carried the edits, for evidence. */
  fixEvents: MemorySessionEvent[];
}

export function findFailureFixPairs(events: MemorySessionEvent[]): FailureFix[] {
  const pairs: FailureFix[] = [];

  for (let index = 0; index < events.length; index++) {
    const errorEvent = events[index];
    if (errorEvent.type !== 'error') continue;
    const message = typeof errorEvent.payload.message === 'string' ? errorEvent.payload.message : '';
    if (!message.trim()) continue;

    const signature = errorSignature(message);
    const changedPaths: string[] = [];
    const fixEvents: MemorySessionEvent[] = [];
    let recurred = false;

    for (const later of events.slice(index + 1)) {
      if (later.type === 'error') {
        const laterMessage = typeof later.payload.message === 'string' ? later.payload.message : '';
        // Same failure again: whatever was changed in between did not fix it.
        if (errorSignature(laterMessage) === signature) { recurred = true; break; }
        continue;
      }
      if (later.type !== 'checkpoint') continue;
      const paths = Array.isArray(later.payload.changedPaths) ? later.payload.changedPaths : [];
      if (paths.length === 0) continue;
      fixEvents.push(later);
      for (const path of paths) {
        if (typeof path === 'string' && !changedPaths.includes(path)) changedPaths.push(path);
      }
    }

    if (!recurred && changedPaths.length > 0) {
      pairs.push({ errorEvent, message, changedPaths, fixEvents });
    }
  }

  return pairs;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/store/extractors/failure-fix.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Verify no new type errors**

Run: `npx tsc --noEmit 2>&1 | grep "failure-fix"`
Expected: no output.

- [ ] **Step 6: Commit**

```bash
git add src/store/extractors/failure-fix.ts tests/store/extractors/failure-fix.test.ts
git commit -m "feat(capture): pair a failure with the edits that resolved it"
```

---

### Task 4: Candidate types and importance weights

**Files:**
- Modify: `src/core/types.ts` — the `MemoryCandidate.candidateType` union
- Modify: `src/store/candidate-promotion.ts` — `candidateImportance`
- Test: `tests/store/candidate-promotion.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `candidateType` may now be `'commit'`; `candidateImportance` weights `'commit'` at 0.75 and `'error'` at 0.8. Task 5 emits both.

The current union is `'outcome' | 'decision' | 'error' | 'verified-command' | 'task-state'`. `'error'` already exists and fits failure→fix; `'commit'` is new.

Weights reflect the measurement: a resolved failure is the most valuable single thing a session yields, and a commit subject is the most common. Both outrank the inert `outcome` and `verified-command` types.

- [ ] **Step 1: Write the failing test**

Append to `tests/store/candidate-promotion.test.ts`:

```ts
  it('ranks a resolved failure above a commit, and both above an outcome', () => {
    const make = (candidateType: MemoryCandidate['candidateType']): MemoryCandidate => ({
      candidateType,
      sessionId: 's1',
      category: 'fact',
      title: 't',
      content: 'c',
      confidence: 0.8,
      evidence: [],
    });

    const ranked = rankCandidatesByImportance([make('outcome'), make('commit'), make('error')]);

    expect(ranked.map((candidate) => candidate.candidateType)).toEqual(['error', 'commit', 'outcome']);
  });
```

Add `MemoryCandidate` to the type imports at the top of that file if it is not already imported.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/store/candidate-promotion.test.ts`
Expected: FAIL — TypeScript rejects `'commit'` as a `candidateType`, or the ordering assertion fails.

- [ ] **Step 3: Widen the union**

In `src/core/types.ts`, change the `candidateType` line of `MemoryCandidate` to:

```ts
  candidateType: 'outcome' | 'decision' | 'error' | 'commit' | 'verified-command' | 'task-state';
```

- [ ] **Step 4: Weight the new types**

In `src/store/candidate-promotion.ts`, replace the body of `candidateImportance` with:

```ts
export function candidateImportance(candidate: MemoryCandidate): number {
  // Weights follow the measured value of each source: a resolved failure is the
  // most valuable single thing a session yields, and a commit subject is the most
  // common. Both outrank the outcome and verified-command types, which measured
  // at zero.
  const typeWeight = candidate.candidateType === 'decision' ? 1
    : candidate.candidateType === 'error' ? 0.8
    : candidate.candidateType === 'commit' ? 0.75
    : candidate.candidateType === 'outcome' ? 0.6
    : candidate.candidateType === 'verified-command' ? 0.5
    : candidate.candidateType === 'task-state' ? 0.45
    : 0.4;
  return (candidate.confidence ?? 0.5) * 0.6 + typeWeight * 0.4;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/store/candidate-promotion.test.ts`
Expected: PASS, all tests including the new one.

- [ ] **Step 6: Commit**

```bash
git add src/core/types.ts src/store/candidate-promotion.ts tests/store/candidate-promotion.test.ts
git commit -m "feat(capture): add commit and error candidate types with measured weights"
```

---

### Task 5: Wire the rules in and remove the dead ones

**Files:**
- Modify: `src/store/session-candidates.ts`
- Modify: `tests/store/session-candidates.test.ts`

**Interfaces:**
- Consumes: `parseCommitSubjects`, `CommitSubject` (Task 1); `findFailureFixPairs`, `FailureFix` (Task 3); the `'commit'` candidate type (Task 4).
- Produces: `extractSessionMemoryCandidates(sessionId: string): Promise<MemoryCandidate[]>` — unchanged signature, new behaviour.

**Two rules are removed here:**
1. The repeated-command rule and its `PROCEDURAL_SKILL_MIN_REPEATS` constant. It writes `Repeated workflow: …` items which measured at 0% and which the spec forbids writing again.
2. The `stop.summary` outcome rule, which writes `Session outcome: …`. `stop.summary` is null in practice, so it is both inert and a noise source.

The `decision`-event rule stays untouched.

- [ ] **Step 1: Write the failing test**

Replace the test named `suggests a skill when a command repeats, but ignores one-off commands` in `tests/store/session-candidates.test.ts` with these, and update the two tests above it that assert exact candidate counts (they currently expect an `outcome` candidate that no longer exists):

```ts
  it('captures a commit subject as a fact, with evidence', async () => {
    const session = await startMemorySession({ title: 'Commit work', query: 'x' });
    await appendMemorySessionEvent(session.id, 'command', {
      command: 'git add -A && git commit -q -m "fix(store): take writes through the client"',
      exitCode: 0,
    });
    await finishMemorySession(session.id, 'finished');

    const candidates = await extractSessionMemoryCandidates(session.id);

    expect(candidates).toHaveLength(1);
    expect(candidates[0].candidateType).toBe('commit');
    expect(candidates[0].title).toContain('take writes through the client');
    expect(candidates[0].evidence.length).toBeGreaterThan(0);
  });

  it('skips docs, test, chore and merge commits, which are process not knowledge', async () => {
    const session = await startMemorySession({ title: 'Process commits', query: 'x' });
    for (const subject of ['docs: tidy readme', 'test: add a case', 'chore: bump deps', 'Merge branch feat/x']) {
      await appendMemorySessionEvent(session.id, 'command', { command: `git commit -q -m "${subject}"`, exitCode: 0 });
    }
    await finishMemorySession(session.id, 'finished');

    expect(await extractSessionMemoryCandidates(session.id)).toEqual([]);
  });

  it('captures a failure that was fixed, naming the error and the files that changed', async () => {
    const session = await startMemorySession({ title: 'Fix a failure', query: 'x' });
    await appendMemorySessionEvent(session.id, 'error', { message: 'TypeError: retry is not a function' });
    await appendMemorySessionEvent(session.id, 'checkpoint', { changedPaths: ['src/store/retry.ts'] });
    await finishMemorySession(session.id, 'finished');

    const candidates = await extractSessionMemoryCandidates(session.id);

    expect(candidates).toHaveLength(1);
    expect(candidates[0].candidateType).toBe('error');
    expect(candidates[0].content).toContain('TypeError: retry is not a function');
    expect(candidates[0].content).toContain('src/store/retry.ts');
  });

  it('no longer writes a Repeated workflow item however often a command runs', async () => {
    const session = await startMemorySession({ title: 'Repeats', query: 'x' });
    for (let index = 0; index < 5; index++) {
      await appendMemorySessionEvent(session.id, 'command', { command: 'npm run build && npm test', exitCode: 0 });
    }
    await finishMemorySession(session.id, 'finished');

    const candidates = await extractSessionMemoryCandidates(session.id);

    expect(candidates.some((candidate) => candidate.title.startsWith('Repeated workflow'))).toBe(false);
    expect(candidates.some((candidate) => candidate.candidateType === 'verified-command')).toBe(false);
  });

  it('no longer writes a Session outcome item', async () => {
    const session = await startMemorySession({ title: 'Outcome', query: 'x' });
    await appendMemorySessionEvent(session.id, 'decision', { text: 'Use RRF ranking for hybrid retrieval.' });
    await finishMemorySession(session.id, 'finished', 'Wrapped up the work.');

    const candidates = await extractSessionMemoryCandidates(session.id);

    expect(candidates.some((candidate) => candidate.title.startsWith('Session outcome'))).toBe(false);
    expect(candidates.some((candidate) => candidate.candidateType === 'outcome')).toBe(false);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/store/session-candidates.test.ts`
Expected: FAIL — the commit and failure→fix tests find no candidates, and the two "no longer writes" tests still find the old items.

- [ ] **Step 3: Rewrite the orchestrator**

Replace `src/store/session-candidates.ts` with:

```ts
import { MemoryCandidate, MemorySessionEvent } from '../core/types.js';
import { getClient } from './database.js';
import { rankCandidatesByImportance, MAX_PROMOTED_CANDIDATES } from './candidate-promotion.js';
import { parseCommitSubjects } from './extractors/commit-subject.js';
import { findFailureFixPairs } from './extractors/failure-fix.js';

/** Commit types that record process rather than knowledge. */
const SKIPPED_COMMIT_TYPES = new Set(['docs', 'test', 'chore']);

const MAX_CONTENT_CHARS = 2_000;

function eventEvidence(sessionId: string, event: MemorySessionEvent) {
  return [{ type: 'agent' as const, locator: `session://${sessionId}/event/${event.id}`, relationship: 'derived_from' as const, observedAt: event.observedAt }];
}

function eventsForSession(rows: any[]): MemorySessionEvent[] {
  return rows.map(row => ({ id: String(row.id), sessionId: String(row.session_id), type: row.type, payload: JSON.parse(String(row.payload)), observedAt: String(row.observed_at), expiresAt: String(row.expires_at) }));
}

export async function extractSessionMemoryCandidates(sessionId: string): Promise<MemoryCandidate[]> {
  const client = getClient();
  const sessionRow = (await client.execute({ sql: 'SELECT * FROM memory_sessions WHERE id = ?', args: [sessionId] })).rows[0];
  if (!sessionRow) throw new Error(`Memory session not found: ${sessionId}`);
  const events = eventsForSession((await client.execute({ sql: 'SELECT * FROM memory_session_events WHERE session_id = ? ORDER BY observed_at', args: [sessionId] })).rows);
  const candidates: MemoryCandidate[] = [];

  for (const event of events.filter(event => event.type === 'decision')) {
    const text = typeof event.payload.text === 'string' ? event.payload.text.slice(0, MAX_CONTENT_CHARS) : '';
    if (text) candidates.push({ candidateType: 'decision', sessionId, category: 'decision', title: `Session decision: ${text.slice(0, 80)}`, content: text, confidence: 0.9, evidence: eventEvidence(sessionId, event) });
  }

  // Commit subjects: the largest measured source of durable knowledge (52%). They
  // survive in the payload because the whole command string is captured.
  for (const event of events.filter(event => event.type === 'command')) {
    const command = typeof event.payload.command === 'string' ? event.payload.command : '';
    if (!command) continue;
    for (const commit of parseCommitSubjects(command)) {
      if (commit.type && SKIPPED_COMMIT_TYPES.has(commit.type)) continue;
      if (/^merge\b/i.test(commit.subject)) continue;
      const content = (commit.body ? `${commit.subject}\n\n${commit.body}` : commit.subject).slice(0, MAX_CONTENT_CHARS);
      candidates.push({
        candidateType: 'commit',
        sessionId,
        category: commit.type === 'fix' ? 'fact' : 'architecture',
        title: commit.subject.slice(0, 120),
        content,
        confidence: 0.8,
        evidence: eventEvidence(sessionId, event),
      });
    }
  }

  // Failure that was fixed: 45% of measured value, and the only source that records
  // why something broke rather than what changed.
  for (const pair of findFailureFixPairs(events)) {
    const content = [
      `Failed with:\n${pair.message.trim()}`,
      `Resolved after changing: ${pair.changedPaths.join(', ')}`,
    ].join('\n\n').slice(0, MAX_CONTENT_CHARS);
    candidates.push({
      candidateType: 'error',
      sessionId,
      category: 'fact',
      title: `Resolved failure: ${pair.message.trim().split('\n')[0].slice(0, 100)}`,
      content,
      confidence: 0.75,
      evidence: [pair.errorEvent, ...pair.fixEvents.slice(0, 2)].flatMap(event => eventEvidence(sessionId, event)),
    });
  }

  const seen = new Set<string>();
  const deduped = candidates.filter(candidate => { const key = `${candidate.title}\n${candidate.content}`.toLowerCase(); if (seen.has(key)) return false; seen.add(key); return true; });
  return rankCandidatesByImportance(deduped).slice(0, MAX_PROMOTED_CANDIDATES);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/store/session-candidates.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the finalizer tests, which consume these candidates**

Run: `npx vitest run tests/store/session-finalizer.test.ts tests/store/candidate-promotion.test.ts`
Expected: PASS. If a finalizer test asserted on an `outcome` or `verified-command` candidate, update it — those types are no longer produced — and say so in your report.

- [ ] **Step 6: Verify no new type errors**

Run: `npx tsc --noEmit 2>&1 | grep "session-candidates"`
Expected: no output.

- [ ] **Step 7: Commit**

```bash
git add src/store/session-candidates.ts tests/store/session-candidates.test.ts
git commit -m "feat(capture): extract commits and resolved failures, drop the dead rules"
```

---

### Task 6: Regression test over the committed corpus

**Files:**
- Create: `tests/store/extractor-corpus.test.ts`

**Interfaces:**
- Consumes: `parseCommitSubjects` (Task 1), `findFailureFixPairs` (Task 3).
- Produces: nothing.

This is spec success criterion 2, and it is testable now only because the 32-session corpus was captured before those events were hard-deleted. It exercises the pure rules against real recorded sessions, not fixtures — the strongest evidence available that the rules fire on genuine data.

**Read the corpus, never write it.** It cannot be regenerated.

- [ ] **Step 1: Write the failing test**

```ts
// tests/store/extractor-corpus.test.ts
import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseCommitSubjects } from '../../src/store/extractors/commit-subject.js';
import { findFailureFixPairs } from '../../src/store/extractors/failure-fix.js';
import type { MemorySessionEvent } from '../../src/core/types.js';

const CORPUS = path.join('benchmarks', 'unassisted-capture', 'corpus', 'events.json');

async function corpusEvents(): Promise<Map<string, MemorySessionEvent[]>> {
  const rows = JSON.parse(await fs.readFile(CORPUS, 'utf8')) as any[];
  const bySession = new Map<string, MemorySessionEvent[]>();
  for (const row of rows) {
    const sessionId = String(row.session_id);
    let payload: Record<string, unknown> = {};
    try { payload = JSON.parse(String(row.payload)); } catch { payload = {}; }
    const event = {
      id: String(row.id),
      sessionId,
      type: row.type,
      payload,
      observedAt: String(row.observed_at),
      expiresAt: String(row.expires_at),
    } as MemorySessionEvent;
    const bucket = bySession.get(sessionId);
    if (bucket) bucket.push(event); else bySession.set(sessionId, [event]);
  }
  return bySession;
}

describe('extractor rules against the recorded corpus', () => {
  it('recovers commit subjects from real sessions', async () => {
    const bySession = await corpusEvents();
    let sessionsWithCommits = 0;
    let totalSubjects = 0;

    for (const events of bySession.values()) {
      const subjects = events
        .filter((event) => event.type === 'command')
        .flatMap((event) => parseCommitSubjects(String(event.payload.command ?? '')));
      if (subjects.length > 0) sessionsWithCommits++;
      totalSubjects += subjects.length;
    }

    // Measured during the capture experiment: 36 subjects across 14 of 32 sessions.
    // Asserted as floors so an improved parser is not a failure.
    expect(sessionsWithCommits).toBeGreaterThanOrEqual(14);
    expect(totalSubjects).toBeGreaterThanOrEqual(36);
  });

  it('finds resolved failures in real sessions', async () => {
    const bySession = await corpusEvents();
    const sessionsWithPairs = [...bySession.values()].filter((events) => findFailureFixPairs(events).length > 0);

    // 16 of 32 sessions contain at least one error; not every error was resolved
    // in-session, so the floor is deliberately lower than 16.
    expect(sessionsWithPairs.length).toBeGreaterThanOrEqual(5);
  });

  it('produces no candidate at all for the stub sessions the corpus excluded', async () => {
    // Every corpus session cleared >=10 events and >=2 changed paths, so each should
    // yield something from at least one rule. A rule set that fires on none of them
    // would be inert the way the previous one was.
    const bySession = await corpusEvents();
    const productive = [...bySession.values()].filter((events) => {
      const commits = events.filter((e) => e.type === 'command').flatMap((e) => parseCommitSubjects(String(e.payload.command ?? '')));
      return commits.length > 0 || findFailureFixPairs(events).length > 0;
    });

    expect(productive.length).toBeGreaterThanOrEqual(20);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/store/extractor-corpus.test.ts`
Expected: FAIL if Tasks 1 and 3 are incomplete. If Tasks 1–5 are done, this should pass on the first run — that is the point of the task, and you should report the actual counts it produced.

- [ ] **Step 3: Report the measured counts**

Run:

```bash
node --input-type=module -e "
import fs from 'node:fs';
const rows = JSON.parse(fs.readFileSync('benchmarks/unassisted-capture/corpus/events.json','utf8'));
const sessions = new Set(rows.map((row) => String(row.session_id)));
console.log('sessions in corpus:', sessions.size, '| events:', rows.length);
"
```

Expected: `sessions in corpus: 32`. Record in your report the three numbers the test measured — sessions with commits, total subjects, sessions with resolved failures — so the floors can be tightened later if they turn out to be loose.

- [ ] **Step 4: Run the full product suite**

Run: `npm test`
Expected: PASS. Report the file and test counts.

- [ ] **Step 5: Commit**

```bash
git add tests/store/extractor-corpus.test.ts
git commit -m "test(capture): exercise the new rules against the recorded 32-session corpus"
```

---

## Out of Scope for This Plan

- **Phase 2, the skill loop** — mid-session capture, saving as runnable packages, surfacing skills in the session-start card, and the after-the-fact nudge. It gets its own plan once this ships.
- **Retiring the four existing `Repeated workflow:` items and the one `Verified command:` item.** This plan stops them being written; removing the ones already stored is a data change and the spec leaves it as an explicit decision.
- **Adding `PreToolUse`** — recorded in the spec as the escape hatch, deliberately not built.
