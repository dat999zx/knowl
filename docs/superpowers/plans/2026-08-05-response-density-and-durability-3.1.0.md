# Response Density and Write Durability Implementation Plan (3.1.0)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Return the whole of 90.6% of stored facts instead of 51.3% of them, without letting that raise leak into the twelve other things the same constant was capping, and make the new `synchronous = NORMAL` pragma overridable.

**Architecture:** `MAX_ITEM_CONTENT_CHARS` is currently referenced by fourteen truncation sites across five files. Task 1 splits it into four constants — one per policy — with every value still 600, so the existing suite proves the refactor changed nothing. Task 2 then raises only the two that should move. A new `src/core/sqlite-sync.ts` resolves `KNOWL_SQLITE_SYNCHRONOUS` on each database open, and the three databases call it instead of hardcoding the pragma.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), vitest, `@libsql/client`.

## Global Constraints

- **Baseline is `main` with PR #16 merged.** Every line number below is from the post-merge tree. `main` touches none of these files, so post-merge content equals PR #16's content for all of them. Re-check every line reference with `grep` before editing.
- Node `>=22`. No new runtime dependency.
- Conventional Commits. Every task ends with `npm test` green.
- CLI tests run against `dist/`. Run `npm run build` before `npm test` if a task touched anything the CLI bundles.
- Test roots follow `path.resolve('./.knowl-<name>-test')`, created in `beforeAll`, removed in `afterAll`.
- **Comments explain why, not what.** Every constant in this codebase carries the measurement that justifies its value. Match that.
- Full local gate before release: `npm test`, `npm run build`, `npx tsc --noEmit`, `npm run check:lockfile`, `git diff --check`.

## Prerequisite (not a task in this plan)

PR #16 must be merged first. Post a single comment asking the contributor to merge current `main` and re-run their measurement rigs against it, and to correct the "0 commits behind" claim and the stale CI link. State that the merge was verified clean and the merged suite verified green (1891/1891, `tsc` 0 errors) — this is an evidence refresh, not a repair. Do not ask for the PR to be split.

## File Structure

| File | Change | Responsibility after |
| --- | --- | --- |
| `src/core/token-budget.ts` | Modify | Owns all four ceilings and the compact item shape |
| `src/core/format.ts` | Modify | Markdown formatters; per-item cap now `MAX_SUMMARY_ITEM_CHARS` |
| `src/mcp/response-format.ts` | Modify | Assertion and evidence shaping; previews now `MAX_PREVIEW_CHARS` |
| `src/mcp/tools.ts` | Modify | Tool schemas and handlers; previews repointed, query description interpolates the cap |
| `src/mcp/resources.ts` | Modify | Resource markdown; title/content/preview split |
| `src/core/sqlite-sync.ts` | **Create** | Sole owner of resolving `KNOWL_SQLITE_SYNCHRONOUS` into a pragma |
| `src/store/bootstrap.ts` | Modify | Knowledge DB statements become a function |
| `src/transcripts/database.ts` | Modify | Transcript DB statements become a function |
| `src/store/resume-store.ts` | Modify | Resume DB statements become a function |
| `tests/core/token-budget.test.ts` | Modify | Ceiling behaviour, and the guard that the formatters do not widen |
| `tests/mcp/server.test.ts` | Modify | Two literal bounds repointed at `MAX_PREVIEW_CHARS` |
| `tests/mcp/query-pointer-surface.test.ts` | Modify | Fixture re-seeded off the ceiling; as-of branch pinned |
| `tests/core/sqlite-sync.test.ts` | **Create** | Env-var resolution in isolation |
| `tests/store/pragma-configuration.test.ts` | Modify | Env-var cases added to the existing pragma pins |
| `docs/reference.md` | Modify | Response contract and the env var |

**Not modified, and that is the point.** `tests/mcp/tool-response-contract.test.ts` and
`tests/performance/token-budget.test.ts` both exercise paths that must be unaffected by the
raise. They stay green without edits, or Task 1's split is wrong.

---

### Task 1: Split the overloaded constant, changing no behaviour

Every new constant holds 600, exactly what the sites read today. Nothing observable changes, so the existing suite is the proof.

**Files:**
- Modify: `src/core/token-budget.ts:6`, `:128`
- Modify: `src/core/format.ts:16`, `:141`
- Modify: `src/mcp/response-format.ts:11`, `:25`
- Modify: `src/mcp/tools.ts:1513`, `:1537`
- Modify: `src/mcp/resources.ts:101`, `:102`, `:104`

**Interfaces:**
- Produces: `MAX_TITLE_CHARS`, `MAX_SUMMARY_ITEM_CHARS`, `MAX_PREVIEW_CHARS`, all exported from `src/core/token-budget.ts` alongside the existing `MAX_ITEM_CONTENT_CHARS`.

- [ ] **Step 1: Add the three new constants**

In `src/core/token-budget.ts`, directly below line 6 (`export const MAX_ITEM_CONTENT_CHARS = 600;`):

```typescript
/**
 * The compact item's title, and the resource markdown's heading.
 *
 * Its own ceiling because it is its own thing: a title is an identifier rather than prose, and
 * it must not inherit whatever the content ceiling becomes. It shared that ceiling only by
 * accident of both being truncated in the same function.
 */
export const MAX_TITLE_CHARS = 600;

/**
 * Per-item ceiling for the markdown formatters in `./format.ts`.
 *
 * Those two call sites already bound the WHOLE response at `DEFAULT_CONTEXT_MAX_CHARS`, so this
 * must stay well under it. Raising it to the item-content ceiling would let one item consume
 * two thirds of `knowl_recent` and `knowl_state`.
 */
export const MAX_SUMMARY_ITEM_CHARS = 600;

/**
 * A bounded sample of something retrievable in full elsewhere: an evidence excerpt, a timeline
 * assertion, a skill's markdown, a skill run's stdout and stderr, a decision's reasoning.
 *
 * None of these is the fact an agent reasons from, and each has its own way back to the whole:
 * evidence carries a locator, a skill has a package on disk, a subprocess can be re-run. They
 * must not move when the item-content ceiling moves.
 */
export const MAX_PREVIEW_CHARS = 600;
```

- [ ] **Step 2: Repoint the title in `compactKnowledgeItem`**

`src/core/token-budget.ts:128`. Change:

```typescript
    title: truncateText(item.title, MAX_ITEM_CONTENT_CHARS),
```

to:

```typescript
    title: truncateText(item.title, MAX_TITLE_CHARS),
```

Leave line 129 (`content`) and line 135 (the `truncated` check) on `MAX_ITEM_CONTENT_CHARS`. Those two are the item-content policy and must stay coupled to each other.

- [ ] **Step 3: Repoint the formatter defaults**

`src/core/format.ts`. Change the import on line 2 to add `MAX_SUMMARY_ITEM_CHARS` and drop `MAX_ITEM_CONTENT_CHARS` if it becomes unused:

```typescript
import { DEFAULT_CONTEXT_MAX_CHARS, MAX_SUMMARY_ITEM_CHARS, truncateText } from './token-budget.js';
```

Then at both line 16 and line 141, change:

```typescript
  const maxItemChars = options.maxItemChars ?? MAX_ITEM_CONTENT_CHARS;
```

to:

```typescript
  const maxItemChars = options.maxItemChars ?? MAX_SUMMARY_ITEM_CHARS;
```

- [ ] **Step 4: Repoint the assertion and evidence previews**

`src/mcp/response-format.ts`. Change the import on line 2 to use `MAX_PREVIEW_CHARS` instead of `MAX_ITEM_CONTENT_CHARS`:

```typescript
import { compactKnowledgeItem, CompactKnowledgeItem, CompactProvenance, MAX_EVIDENCE_ITEMS, MAX_PREVIEW_CHARS, truncateText } from '../core/token-budget.js';
```

Line 11:

```typescript
    content: truncateText(assertion.content, MAX_PREVIEW_CHARS),
```

Line 25:

```typescript
      ...(item.excerpt ? { excerpt: truncateText(item.excerpt, MAX_PREVIEW_CHARS) } : {}),
```

- [ ] **Step 5: Repoint the skill previews in `tools.ts`**

`src/mcp/tools.ts`. Add `MAX_PREVIEW_CHARS` to the import on line 15, keeping `MAX_ITEM_CONTENT_CHARS` (line 1453 still uses it):

```typescript
import { DEFAULT_RESULT_LIMIT, MAX_ITEM_CONTENT_CHARS, MAX_PREVIEW_CHARS, truncateText, uncalibratedScore, type UncalibratedScore } from '../core/token-budget.js';
```

Line 1513 — both the truncation and the flag that reports it must use the same constant:

```typescript
          content: [{ type: 'text', text: compactMcpJson({ manifest: skill.manifest, markdown: truncateText(skill.markdown, MAX_PREVIEW_CHARS), truncated: skill.markdown.length > MAX_PREVIEW_CHARS }) }],
```

Line 1537:

```typescript
        return { content: [{ type: 'text', text: compactMcpJson({ ...result, stdout: truncateText(result.stdout, MAX_PREVIEW_CHARS), stderr: truncateText(result.stderr, MAX_PREVIEW_CHARS), attempts: result.attempts.map(attempt => ({ entrypoint: attempt.entrypoint, exitCode: attempt.exitCode })) }) }] };
```

Leave line 1453 (`knowl_task_start` relevant memory) on `MAX_ITEM_CONTENT_CHARS` — that is bootstrap memory the agent reasons from, the same policy as a query result.

- [ ] **Step 6: Repoint the resource markdown**

`src/mcp/resources.ts`. Change the import on line 7:

```typescript
import { DEFAULT_CONTEXT_MAX_CHARS, DEFAULT_RESULT_LIMIT, MAX_ITEM_CONTENT_CHARS, MAX_PREVIEW_CHARS, MAX_TITLE_CHARS, truncateText } from '../core/token-budget.js';
```

Line 101 — the heading takes the title ceiling, the body keeps the content one:

```typescript
            md += `## ${truncateText(item.title, MAX_TITLE_CHARS)} (ID: ${item.id})\n\n${truncateText(item.content, MAX_ITEM_CONTENT_CHARS)}\n\n`;
```

Line 102:

```typescript
            if (item.reasoning) md += `**Reasoning:** ${truncateText(item.reasoning, MAX_PREVIEW_CHARS)}\n\n`;
```

Line 104:

```typescript
              md += `**Alternatives:** ${truncateText(item.alternatives.join(', '), MAX_PREVIEW_CHARS)}\n\n`;
```

- [ ] **Step 7: Verify nothing changed**

Run: `npx tsc --noEmit && npm run build && npm test`
Expected: 0 type errors, and the **same pass count as before this task**. Every constant still holds 600, so any failure here is a mistake in the repointing, not a behaviour change to accept.

- [ ] **Step 8: Confirm no site was missed**

Run: `grep -rn "MAX_ITEM_CONTENT_CHARS" src/`
Expected: exactly four references outside the declaration — `token-budget.ts:129`, `token-budget.ts:135` (the `truncated` check), `tools.ts:1453`, `resources.ts:101`. Anything else is a site that was not classified.

- [ ] **Step 9: Commit**

```bash
git add src/core/token-budget.ts src/core/format.ts src/mcp/response-format.ts src/mcp/tools.ts src/mcp/resources.ts
git commit -m "refactor(token-budget): give each truncation ceiling its own constant"
```

---

### Task 2: Raise the item-content and title ceilings

**Files:**
- Modify: `src/core/token-budget.ts:6`, and the `MAX_TITLE_CHARS` declaration from Task 1
- Modify: `tests/core/token-budget.test.ts`
- Modify: `tests/mcp/server.test.ts:647`, `:666`

**Interfaces:**
- Consumes: `MAX_ITEM_CONTENT_CHARS`, `MAX_TITLE_CHARS`, `MAX_SUMMARY_ITEM_CHARS`, `MAX_PREVIEW_CHARS` from Task 1.

- [ ] **Step 1: Write the failing tests**

Append to `tests/core/token-budget.test.ts`. If the file has no `describe` covering ceilings, add this block whole:

```typescript
import { describe, expect, it } from 'vitest';
import {
  compactKnowledgeItem,
  MAX_ITEM_CONTENT_CHARS,
  MAX_PREVIEW_CHARS,
  MAX_SUMMARY_ITEM_CHARS,
  MAX_TITLE_CHARS,
} from '../../src/core/token-budget.js';
import type { KnowledgeItem } from '../../src/core/types.js';

const item = (overrides: Partial<KnowledgeItem> = {}): KnowledgeItem => ({
  id: 'i1',
  category: 'fact',
  title: 'a title',
  content: 'a body',
  freshness: 'fresh',
  confidence: 1,
  status: 'active',
} as KnowledgeItem & typeof overrides);

describe('truncation ceilings', () => {
  it('returns 2000 characters of content whole and flags anything longer', () => {
    expect(MAX_ITEM_CONTENT_CHARS).toBe(2000);

    const exact = compactKnowledgeItem({ ...item(), content: 'x'.repeat(2000) });
    expect(exact.content.length).toBe(2000);
    expect(exact.truncated).toBeUndefined();

    const over = compactKnowledgeItem({ ...item(), content: 'x'.repeat(2001) });
    expect(over.content.length).toBe(2000);
    expect(over.truncated).toBe(true);
  });

  it('caps a title at 200 without flagging it', () => {
    expect(MAX_TITLE_CHARS).toBe(200);

    const long = compactKnowledgeItem({ ...item(), title: 'y'.repeat(300), content: 'short' });
    expect(long.title.length).toBe(200);
    // No flag: the ceiling is four times the longest title measured (133), so a cut title is a
    // data problem rather than a budget one, and a flag nobody can act on is noise.
    expect(long.truncated).toBeUndefined();
  });

  it('leaves the summary and preview ceilings where they were', () => {
    // These are pinned as VALUES, not as `=== MAX_ITEM_CONTENT_CHARS`. The whole point of the
    // split is that raising the content ceiling must never drag them along, and an assertion
    // written against the other constant would have moved with it.
    expect(MAX_SUMMARY_ITEM_CHARS).toBe(600);
    expect(MAX_PREVIEW_CHARS).toBe(600);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/core/token-budget.test.ts`
Expected: FAIL — `expected 600 to be 2000` on the first test and `expected 600 to be 200` on the second. The third passes already; that is correct, it is a regression guard.

- [ ] **Step 3: Raise the two ceilings**

`src/core/token-budget.ts:6`. Replace the line with the value and the measurement that justifies it:

```typescript
/**
 * How much of a stored fact a caller receives.
 *
 * 600 was returning **half of every fact severed mid-sentence**: measured on this repository's
 * store (556 active items), p50 558 but p75 1,448 and p90 1,988, so 48.7% of items were cut,
 * and until the `truncated` flag landed a caller could not tell a short complete atom from the
 * opening third of a long one — while the doctrine told it to answer from memory rather than
 * read files.
 *
 * 2,000 against the same corpus, at `DEFAULT_RESULT_LIMIT`:
 *
 * | ceiling | items whole | mean chars/query | worst case |
 * | --- | --- | --- | --- |
 * | 600 | 51.3% | 1,331 | 1,800 |
 * | 1,500 | 76.6% | 2,311 | 4,500 |
 * | 2,000 | 90.6% | 2,552 | 6,000 |
 * | 3,000 | 99.1% | 2,665 | 9,000 |
 *
 * 3,000 costs only 113 more mean characters and buys another 8.5 points, but its worst case is
 * 9,000 and the value is tuned to this store's longest item (3,779) rather than to a principle.
 * 2,000 is the choice that survives not knowing the corpus.
 */
export const MAX_ITEM_CONTENT_CHARS = 2000;
```

Then change the `MAX_TITLE_CHARS` declaration added in Task 1 to `200` and extend its comment with the measurement:

```typescript
/**
 * The compact item's title, and the resource markdown's heading.
 *
 * Its own ceiling because it is its own thing: a title is an identifier rather than prose, and
 * it must not inherit whatever the content ceiling becomes. Measured on this repository's store:
 * p50 62, p90 100, p99 120, longest 133 — so 200 never fires on real data and exists to stop a
 * pathological title from claiming the content ceiling's new headroom.
 */
export const MAX_TITLE_CHARS = 200;
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/core/token-budget.test.ts`
Expected: PASS, all three.

- [ ] **Step 5: Repoint the two literal bounds in the server test**

Both assert against a literal `600`. They are upper bounds, so both would still pass at the new ceiling — and that is exactly the problem: they would no longer check the ceiling they name.

**Read what each one actually bounds before editing.** `tests/mcp/server.test.ts:650` is inside `it('compacts default timeline content')`, so its `payload[0].content` is a **timeline assertion**, shaped by `response-format.ts:11`. That is `MAX_PREVIEW_CHARS`, not the item ceiling — pointing it at `MAX_ITEM_CONTENT_CHARS` would silently stop testing anything, because the seeded item is `'x'.repeat(2_000)` and 2,000 ≤ 2,000.

Add the import:

```typescript
import { MAX_PREVIEW_CHARS } from '../../src/core/token-budget.js';
```

Line 650 (timeline assertion content):

```typescript
    expect(payload[0].content.length).toBeLessThanOrEqual(MAX_PREVIEW_CHARS);
```

Line 667 (evidence excerpt):

```typescript
    expect(payload[0].excerpt.length).toBeLessThanOrEqual(MAX_PREVIEW_CHARS);
```

Leave line 651 (`text.length` under 1,000) alone — the assertion still caps at 600, so the whole timeline payload stays small.

- [ ] **Step 6: Re-seed the pointer-surface test, which now seeds under the ceiling**

`tests/mcp/query-pointer-surface.test.ts:78` seeds `'Detail sentence about the reconciliation pass. '.repeat(40)` behind a 53-character prefix — **1,893 characters**. That was comfortably past 600 and is comfortably *under* 2,000, so lines 104–105 (`expect(long.truncated).toBe(true)` and `expect(long.content.length).toBe(MAX_ITEM_CONTENT_CHARS)`) will fail.

Fix the fixture so it can never drift under the ceiling again. Replace line 78's content with:

```typescript
      // Sized off the ceiling rather than a literal: this fixture existed to be truncated, and
      // a hardcoded repeat count silently stops testing that the moment the ceiling moves.
      content: `Checkout ledger reconciliation runs after settlement. ${'Detail sentence about the reconciliation pass. '.repeat(Math.ceil((MAX_ITEM_CONTENT_CHARS * 1.5) / 46))}`,
```

`MAX_ITEM_CONTENT_CHARS` is already imported in that file at line 9.

- [ ] **Step 7: Add the regression test for the surfaces that must NOT widen**

This is the failure the whole split exists to prevent, so it gets its own assertion rather than relying on the constants alone. Append to `tests/core/token-budget.test.ts`:

```typescript
import { formatRecentContextToMarkdown } from '../../src/core/format.js';

it('does not widen the recent-context formatter when the item ceiling moves', () => {
  const long = {
    id: 'r1', category: 'fact', status: 'active', title: 'Long', freshness: 'fresh',
    confidence: 1, version: 1, createdAt: '', updatedAt: '',
    content: 'x'.repeat(MAX_ITEM_CONTENT_CHARS + 500),
  } as any;

  const md = formatRecentContextToMarkdown({ items: [long], commits: [] });

  // The formatter bounds the WHOLE response at DEFAULT_CONTEXT_MAX_CHARS, so one item taking
  // the item ceiling would eat two thirds of knowl_recent and knowl_state.
  expect(md).toContain('x'.repeat(MAX_SUMMARY_ITEM_CHARS));
  expect(md).not.toContain('x'.repeat(MAX_SUMMARY_ITEM_CHARS + 1));
});
```

- [ ] **Step 8: Run the full suite**

Run: `npm run build && npm test`
Expected: PASS.

Two existing tests are the real proof and must be green without being edited:
- `tests/mcp/tool-response-contract.test.ts:210` — `keeps a context pack under the response ceiling`. `knowl_context` composes through `context-composer.ts`'s own `compact`, not `compactKnowledgeItem`, so the raise must not reach it.
- `tests/performance/token-budget.test.ts:9` — formats an item of `DEFAULT_CONTEXT_MAX_CHARS * 2` through the markdown path, which is now `MAX_SUMMARY_ITEM_CHARS`.

If either fails, the raise has leaked past Task 1's split. Find the site and repoint it; do not adjust the expectation.

- [ ] **Step 9: Fix the prose PR #16 left behind**

Three comments now describe a ceiling that has moved. They are comments only — no assertion changes.

- `tests/mcp/query-pointer-surface.test.ts:16` — "longer than the 600-character ceiling" → "longer than the content ceiling".
- `tests/core/token-budget.test.ts:33` — "the 84-94% of items whose content arrives truncated" → "the items whose content arrives truncated".
- `tests/core/token-budget.test.ts` above `flags a truncated content body` — "a caller reading 600 characters of a 2,000-character atom" → "a caller reading a prefix of a longer atom".

- [ ] **Step 10: Commit**

```bash
git add src/core/token-budget.ts tests/core/token-budget.test.ts tests/mcp/server.test.ts tests/mcp/query-pointer-surface.test.ts
git commit -m "feat(token-budget): return 2000 characters of an item instead of 600"
```

---

### Task 3: Stop restating the ceiling in the tool description

PR #16 writes ``content` is cut at 600 characters` into the `knowl_query` description. After Task 2 that sentence is false, and it is doctrine agents act on.

**Files:**
- Modify: `src/mcp/tools.ts:383`
- Modify: `tests/mcp/server.test.ts`

**Interfaces:**
- Consumes: `MAX_ITEM_CONTENT_CHARS` (already imported at `tools.ts:15`).

- [ ] **Step 1: Write the failing test**

Add to the existing `describe` in `tests/mcp/server.test.ts` that holds the tool-description assertions (the block starting at line 270):

```typescript
  it('states the content ceiling by reading it, not by restating it', async () => {
    const res = await listTools();
    const byName = new Map(res.result.tools.map((tool: any) => [tool.name, tool.description]));
    const description = byName.get('knowl_query') as string;

    // The sentence must carry the live value. A literal here is how doctrine comes to lie to
    // every agent that reads it: the ceiling moved once already and the prose did not.
    expect(description).toContain(`cut at ${MAX_ITEM_CONTENT_CHARS} characters`);
    expect(description).not.toContain('cut at 600 characters');
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/mcp/server.test.ts -t 'states the content ceiling'`
Expected: FAIL — the description contains `cut at 600 characters`.

- [ ] **Step 3: Interpolate the constant**

`src/mcp/tools.ts:383`. The description is a single-quoted string containing backticks, so **do not convert it to a template literal** — every embedded backtick would need escaping. Use concatenation. Split the existing literal at the number:

```typescript
          description: 'Use this first for specific project questions, before each new subtask, and when switching areas during multi-step work. Use every word that names the subject and none that does not: one more on-subject term retrieves better, one off-subject term retrieves worse, so never pad a query to reach a length and never drop a real term to stay under one. Skip only for directly relevant active lifecycle context, a same-request query, or relevant memory returned by knowl_task_start. If results contain a relevant active item, answer from Knowl without inspecting repository files. Inspect files only on miss, conflict, stale or low-confidence results, or explicit verification requests -- and on a miss, re-run once with different words first, because a first-pass miss is usually vocabulary rather than absence. `content` is cut at '
            + MAX_ITEM_CONTENT_CHARS
            + ' characters and marked `truncated` when it was; `affectedPaths` names the files the item depends on, so open those rather than searching for them. Results carry `score` (0-1) when semantic search is available: it is the relevance the ranker ordered by and it is comparable across queries, so a low top score means the best available match is weak rather than that it is the answer. When no calibrated number exists, `score` is the string `uncalibrated (<reason>)`: the ranker has an order but no opinion on strength, so do not read position as confidence -- judge the content itself.',
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/mcp/server.test.ts`
Expected: PASS, including the pre-existing description assertions at lines 306–313, which match substrings that do not span the number.

- [ ] **Step 5: Confirm no other copy of the number survives**

Run: `grep -rn "cut at 600\|600 characters" src/ KNOWL.md AGENTS.md docs/reference.md`
Expected: no matches.

- [ ] **Step 6: Commit**

```bash
git add src/mcp/tools.ts tests/mcp/server.test.ts
git commit -m "fix(mcp): read the content ceiling into the query description instead of restating it"
```

---

### Task 4: Make `synchronous` overridable

**Files:**
- Create: `src/core/sqlite-sync.ts`
- Modify: `src/store/bootstrap.ts:17-57`, `:783`
- Modify: `src/transcripts/database.ts:166-176`, `:223`
- Modify: `src/store/resume-store.ts:19-28`, `:48`
- Modify: `tests/store/pragma-configuration.test.ts`

**Interfaces:**
- Produces: `resolveSynchronous(env?): 'NORMAL' | 'FULL'` and `synchronousPragma(env?): string` from `src/core/sqlite-sync.ts`.

- [ ] **Step 1: Write the failing unit tests**

Create `tests/core/sqlite-sync.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { resolveSynchronous, synchronousPragma } from '../../src/core/sqlite-sync.js';

describe('KNOWL_SQLITE_SYNCHRONOUS', () => {
  it('defaults to NORMAL when unset or empty', () => {
    expect(resolveSynchronous({})).toBe('NORMAL');
    expect(resolveSynchronous({ KNOWL_SQLITE_SYNCHRONOUS: '' })).toBe('NORMAL');
    expect(resolveSynchronous({ KNOWL_SQLITE_SYNCHRONOUS: '   ' })).toBe('NORMAL');
  });

  it('accepts FULL in any case, with surrounding whitespace', () => {
    // A trailing space out of a shell profile is a typo that should work.
    expect(resolveSynchronous({ KNOWL_SQLITE_SYNCHRONOUS: 'FULL' })).toBe('FULL');
    expect(resolveSynchronous({ KNOWL_SQLITE_SYNCHRONOUS: 'full ' })).toBe('FULL');
    expect(resolveSynchronous({ KNOWL_SQLITE_SYNCHRONOUS: ' Normal' })).toBe('NORMAL');
  });

  it('refuses OFF by name', () => {
    expect(() => resolveSynchronous({ KNOWL_SQLITE_SYNCHRONOUS: 'OFF' })).toThrow(/OFF is refused/);
  });

  it('throws on an unrecognised value rather than falling back', () => {
    // Falling back would hand NORMAL to somebody who asked for FULL, which is precisely the
    // failure this variable exists to prevent.
    expect(() => resolveSynchronous({ KNOWL_SQLITE_SYNCHRONOUS: 'fast' }))
      .toThrow(/must be NORMAL or FULL/);
  });

  it('renders a pragma statement', () => {
    expect(synchronousPragma({})).toBe('PRAGMA synchronous = NORMAL;');
    expect(synchronousPragma({ KNOWL_SQLITE_SYNCHRONOUS: 'FULL' })).toBe('PRAGMA synchronous = FULL;');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/core/sqlite-sync.test.ts`
Expected: FAIL — `Cannot find module '../../src/core/sqlite-sync.js'`.

- [ ] **Step 3: Create the resolver**

Create `src/core/sqlite-sync.ts`. This carries the rationale that currently sits inline in `src/store/bootstrap.ts`, because three databases now share it and a comment copied three times is a comment that will diverge:

```typescript
/**
 * How hard SQLite works to get a commit onto the platter, and the one place that is decided.
 *
 * `synchronous` was never set anywhere, so every database ran at SQLite's default of FULL by
 * inheritance rather than by decision. FULL fsyncs the WAL on every commit, and because a bare
 * `execute` is its own implicit transaction that is one fsync per un-batched write — which is
 * the common shape here: one `knowl_store`, one hook capture, one session event.
 *
 * MEASURED on this schema (Windows 11, node 24.13, @libsql/client 0.14.0, interleaved A/B,
 * medians over 15 rounds): un-batched writes cost 3.488 ms/row at FULL against 0.832 at NORMAL,
 * 4.19x. NORMAL matched `synchronous=OFF` (0.867) to within noise, which identifies the fsync as
 * the whole of the gap rather than a part of it. Under contention it is better, not merely
 * faster alone: six concurrent processes on one file went 173 -> 337 writes/s, p95 6.161 ->
 * 0.198 ms, zero SQLITE_BUSY either way.
 *
 * THE TRADE. SQLite's documentation is unambiguous that this is not a corruption risk in WAL:
 * "WAL mode is safe from corruption with synchronous=NORMAL... Transactions are durable across
 * application crashes regardless of the synchronous setting or journal mode."
 * (pragma.html#pragma_synchronous). A crashed agent, a killed `serve`, Ctrl-C, a closed lid lose
 * nothing. Only a power cut or OS crash can drop the last seconds, and the file still opens
 * clean. For project memory that is re-derivable from the transcripts beside it, that is the
 * right default — but it is a policy, and a policy with no way out is not a choice.
 *
 * `OFF` is not offered. It CAN corrupt on power loss, and it measured no faster than NORMAL, so
 * it is a real risk for no gain.
 */
export type SynchronousMode = 'NORMAL' | 'FULL';

export const SYNCHRONOUS_ENV_VAR = 'KNOWL_SQLITE_SYNCHRONOUS';

/**
 * Read on every database open rather than cached at module load, so a test can set it per case
 * and a long-lived `serve` never holds a stale value.
 */
export function resolveSynchronous(env: NodeJS.ProcessEnv = process.env): SynchronousMode {
  const raw = env[SYNCHRONOUS_ENV_VAR];
  if (raw === undefined) return 'NORMAL';

  const value = raw.trim().toUpperCase();
  if (value === '') return 'NORMAL';
  if (value === 'NORMAL' || value === 'FULL') return value;

  if (value === 'OFF') {
    throw new Error(
      `${SYNCHRONOUS_ENV_VAR}=OFF is refused: it can corrupt the database on power loss and `
      + 'measured no faster than NORMAL. Use NORMAL (the default) or FULL.',
    );
  }
  // Thrown rather than ignored. Silently supplying NORMAL to somebody who asked for FULL is the
  // failure this variable exists to prevent, and every command opens a database, so a typo
  // surfaces at once instead of at some later write.
  throw new Error(
    `${SYNCHRONOUS_ENV_VAR} must be NORMAL or FULL, not ${JSON.stringify(raw)}.`,
  );
}

/** The statement, ready to execute. Connection state, not file state: every connection sets it. */
export function synchronousPragma(env: NodeJS.ProcessEnv = process.env): string {
  return `PRAGMA synchronous = ${resolveSynchronous(env)};`;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/core/sqlite-sync.test.ts`
Expected: PASS, all five.

- [ ] **Step 5: Wire the knowledge database**

`src/store/bootstrap.ts`. Add the import at the top:

```typescript
import { synchronousPragma } from '../core/sqlite-sync.js';
```

Delete the `'PRAGMA synchronous = NORMAL;'` line at `:57` **and the long comment block above it** (that rationale now lives in `sqlite-sync.ts`). Convert the array at `:17` into a function so the value resolves per open rather than at module load:

```typescript
function baseStatements(): string[] {
  return [
    'PRAGMA busy_timeout = 10000;',
    'PRAGMA foreign_keys = ON;',
    'PRAGMA journal_mode = WAL;',
    // Chosen, not inherited. See `synchronousPragma` for the measurements and the trade.
    synchronousPragma(),
  ];
}
```

At `:783`, change `await executeAll(client, BASE_STATEMENTS);` to:

```typescript
  await executeAll(client, baseStatements());
```

- [ ] **Step 6: Wire the transcript database**

`src/transcripts/database.ts`. Add the import:

```typescript
import { synchronousPragma } from '../core/sqlite-sync.js';
```

Convert the array at `:166` the same way, dropping the hardcoded pragma at `:175`:

```typescript
function baseStatements(): string[] {
  return [
    // A fresh connection's default busy_timeout is 0, so a concurrent writer would fail the
    // open outright.
    'PRAGMA busy_timeout = 10000;',
    'PRAGMA journal_mode = WAL;',
    // See `synchronousPragma`. It matters at least as much here: an index pass writes a great
    // many small rows, and this database is the one a backfill hammers while a live session
    // writes beside it.
    synchronousPragma(),
  ];
}
```

At `:223`, change the loop to call it:

```typescript
      for (const statement of baseStatements()) await client.execute(statement);
```

- [ ] **Step 7: Wire the resume database**

`src/store/resume-store.ts`. Add the import:

```typescript
import { synchronousPragma } from '../core/sqlite-sync.js';
```

Convert `SCHEMA_STATEMENTS` at `:19` into `schemaStatements()`, dropping the hardcoded pragma at `:27` and keeping every `CREATE TABLE` statement exactly as it is:

```typescript
function schemaStatements(): string[] {
  return [
    'PRAGMA busy_timeout = 10000;',
    'PRAGMA journal_mode = WAL;',
    // See `synchronousPragma`. A resume key is re-mintable and this file is tiny, so the
    // durability traded away is worth even less here than it is in the knowledge store.
    synchronousPragma(),
  ];
}
```

Then move every existing `CREATE TABLE` / `CREATE INDEX` string from the old `SCHEMA_STATEMENTS`
array into this function's returned array, in the same order, byte-for-byte. Only the three
pragma entries above them change; the DDL is untouched.

At `:48`, change `for (const statement of SCHEMA_STATEMENTS)` to:

```typescript
    for (const statement of schemaStatements()) await client.execute(statement);
```

- [ ] **Step 8: Write the failing integration tests**

Append to `tests/store/pragma-configuration.test.ts`, which already defines `ROOT` and the `readPragma` helper. Add the imports it needs:

```typescript
import { openResumeDb, closeResumeDb } from '../../src/store/resume-store.js';
```

Then the new block:

```typescript
describe('KNOWL_SQLITE_SYNCHRONOUS', () => {
  const saved = process.env.KNOWL_SQLITE_SYNCHRONOUS;
  const savedHome = process.env.KNOWL_HOME;

  afterEach(async () => {
    if (saved === undefined) delete process.env.KNOWL_SQLITE_SYNCHRONOUS;
    else process.env.KNOWL_SQLITE_SYNCHRONOUS = saved;
    if (savedHome === undefined) delete process.env.KNOWL_HOME;
    else process.env.KNOWL_HOME = savedHome;
    await releaseAll();
    await closeTranscriptDbs().catch(() => {});
    await closeResumeDb().catch(() => {});
  });

  // Each case uses its OWN database file. The connection pool caches by path, so re-acquiring
  // one already opened would hand back a client carrying the previous case's pragma.
  it('gives the knowledge database FULL when asked', async () => {
    process.env.KNOWL_SQLITE_SYNCHRONOUS = 'FULL';
    const client = await acquireClient(path.join(ROOT, 'sync-full.db'));
    expect(await readPragma(client, 'synchronous')).toBe(2);
  });

  it('gives the transcript index FULL when asked', async () => {
    process.env.KNOWL_SQLITE_SYNCHRONOUS = 'FULL';
    const client = await openTranscriptDb(path.join(ROOT, 'sync-full-transcripts.db'));
    expect(await readPragma(client, 'synchronous')).toBe(2);
  });

  it('gives the resume store FULL when asked', async () => {
    process.env.KNOWL_HOME = path.join(ROOT, 'home-full');
    process.env.KNOWL_SQLITE_SYNCHRONOUS = 'FULL';
    const client = await openResumeDb();
    expect(await readPragma(client, 'synchronous')).toBe(2);
  });

  it('still defaults the knowledge database to NORMAL with the variable unset', async () => {
    delete process.env.KNOWL_SQLITE_SYNCHRONOUS;
    const client = await acquireClient(path.join(ROOT, 'sync-default.db'));
    expect(await readPragma(client, 'synchronous')).toBe(1);
  });

  it('refuses to open a database at all on an unrecognised value', async () => {
    process.env.KNOWL_SQLITE_SYNCHRONOUS = 'sorta';
    await expect(acquireClient(path.join(ROOT, 'sync-bad.db')))
      .rejects.toThrow(/must be NORMAL or FULL/);
  });
});
```

Add `afterEach` to the vitest import at the top of the file if it is not already there.

- [ ] **Step 9: Run the integration tests**

Run: `npx vitest run tests/store/pragma-configuration.test.ts`
Expected: PASS. `1` is NORMAL and `2` is FULL in SQLite's `PRAGMA synchronous` output.

- [ ] **Step 10: Run the full suite**

Run: `npm run build && npm test`
Expected: PASS, including the pre-existing pragma pins that assert `synchronous` is `1` by default.

- [ ] **Step 11: Commit**

```bash
git add src/core/sqlite-sync.ts src/store/bootstrap.ts src/transcripts/database.ts src/store/resume-store.ts tests/core/sqlite-sync.test.ts tests/store/pragma-configuration.test.ts
git commit -m "feat(store): let KNOWL_SQLITE_SYNCHRONOUS override the durability default"
```

---

### Task 5: Pin the as-of branch's pointer behaviour

`src/mcp/tools.ts:1125` calls `compactItemResponse(item)` with no provenance, so the foreign-repo guard that withholds `affectedPaths` from another repo's items never runs there. It is correct today because that branch queries one project. Nothing says so.

**Files:**
- Modify: `tests/mcp/query-pointer-surface.test.ts`
- Modify: `src/mcp/tools.ts:1125` (comment only)

**Interfaces:**
- Consumes: the harness already in `tests/mcp/query-pointer-surface.test.ts` — `call(name, args)`, `jsonOf(result)`, the seeded `Checkout ledger reconciliation` item with `affectedPaths: ['src/billing/reconcile.ts', 'src/billing/ledger.ts']`, and its `beforeAll`/`afterAll`.

- [ ] **Step 1: Write the test**

Add to the existing `describe` in `tests/mcp/query-pointer-surface.test.ts`. Extending that file rather than creating a new one: it is the same subject, and its transport harness is sixty lines that must not be duplicated.

```typescript
  /**
   * The as-of branch shapes its results with `compactItemResponse(item)` and NO provenance
   * argument, so the `isForeign` guard that withholds another repo's `affectedPaths` never runs
   * on this path. That is correct only because the branch resolves through
   * `queryKnowledgeBase(projectId, ...)` against one project id and therefore cannot return a
   * foreign item.
   *
   * Pinned because it is correct by construction rather than by code: federating the
   * time-travel path later would hand a reader paths that are relative to a checkout that is
   * not theirs, and the repos most likely to be linked are fork siblings where the same path
   * exists in both and means different things.
   */
  it('returns affectedPaths on the as-of branch, which is single-repo by construction', async () => {
    const items = jsonOf(await call('knowl_query', {
      query: 'checkout ledger reconciliation settlement',
      limit: 3,
      asOf: new Date(Date.now() + 60_000).toISOString(),
    }));

    const hit = items.find((item: any) => item.title === 'Checkout ledger reconciliation');
    expect(hit, 'the seeded item should be retrievable at a future asOf').toBeTruthy();
    expect(hit.affectedPaths).toEqual(['src/billing/reconcile.ts', 'src/billing/ledger.ts']);
    expect(hit).not.toHaveProperty('repo');
  });
```

- [ ] **Step 2: Run it**

Run: `npx vitest run tests/mcp/query-pointer-surface.test.ts`
Expected: PASS. This is a characterisation test — it pins behaviour PR #16 already produces. If it fails, the as-of branch is not returning pointers at all, which is a real finding: report it and stop rather than adjusting the test to match.

- [ ] **Step 3: Name the dependency at the call site**

`src/mcp/tools.ts:1125`. Add above the return:

```typescript
          // No provenance argument, so the foreign-repo guard below never runs here. Safe only
          // because `queryKnowledgeBase` resolves against one project id and this branch cannot
          // return a foreign item. Pinned by tests/mcp/query-asof-surface.test.ts.
```

- [ ] **Step 4: Run the full suite and commit**

Run: `npm run build && npm test`

```bash
git add tests/mcp/query-pointer-surface.test.ts src/mcp/tools.ts
git commit -m "test(mcp): pin the as-of branch's single-repo pointer assumption"
```

---

### Task 6: Document and release 3.1.0

**Files:**
- Modify: `docs/reference.md`
- Rename: `docs/superpowers/plans/2026-08-04-hardening-and-ci-3.1.0.md`
- Modify: `package.json`, `package-lock.json`

- [ ] **Step 1: Document the response contract**

In `docs/reference.md`, in the section covering `knowl_query`'s response, add:

```markdown
Each result carries:

- `content` — up to 2,000 characters of the stored fact, with `truncated: true` present only
  when it was cut. Around 91% of items on a typical store arrive whole.
- `affectedPaths` — up to six repository-relative files the item depends on, each up to 120
  characters. Withheld for an item owned by another repo in a workspace, because its paths are
  relative to a checkout that is not yours.
- `score` — the ranker's fused relevance in [0,1] when a calibrated one exists, or the string
  `uncalibrated (<reason>)` when it does not. A string means the ranker has an order but no
  opinion on strength: judge the content, not the position.
```

- [ ] **Step 2: Document the environment variable**

In the same file, alongside the other `KNOWL_*` variables, add:

```markdown
| `KNOWL_SQLITE_SYNCHRONOUS` | `NORMAL` | `NORMAL` or `FULL`. NORMAL does not fsync on every commit: an application crash, a killed `serve`, or Ctrl-C still lose nothing, and only a power cut or OS crash can drop the last seconds of writes. Set `FULL` to fsync every commit at roughly 4x the per-write cost. `OFF` is refused. |
```

- [ ] **Step 3: Renumber the pending hardening plan**

```bash
git mv docs/superpowers/plans/2026-08-04-hardening-and-ci-3.1.0.md docs/superpowers/plans/2026-08-04-hardening-and-ci-3.2.0.md
```

Then edit its title line and any in-file `3.1.0` references to `3.2.0`. Run `grep -rn "hardening-and-ci-3.1.0" docs/` and fix every link that names the old path.

- [ ] **Step 4: Run the full gate**

Run each and confirm each passes before continuing:

```bash
npm test
npm run build
npx tsc --noEmit
npm run check:lockfile
git diff --check
```

- [ ] **Step 5: Version and commit**

```bash
npm version minor --no-git-tag-version
npm run check:lockfile
git add package.json package-lock.json docs/
git commit -m "chore(release): 3.1.0 — wider results, split ceilings, overridable durability"
```

- [ ] **Step 6: Tag and push**

```bash
git tag v3.1.0
git push origin main --follow-tags
```

Confirm the CD workflow publishes before calling the release done.

---

## Self-Review Notes

**Spec coverage.** Four constants → Task 1 and 2. The 2,000 justification → Task 2 Step 3. The "cap must not be restated in prose" rule → Task 3. `KNOWL_SQLITE_SYNCHRONOUS` including the OFF refusal, the throw, case-insensitivity and per-open resolution → Task 4. The as-of invariant → Task 5. Docs, plan renumbering, 3.1.0 → Task 6. Track A (the PR comment) is stated as a prerequisite because it is not code and has no test cycle.

**Deliberately absent, per the spec.** No `knowl_read` tool. No change to the `score` union. No config key for `synchronous`. No truncation flag for titles.

**Ordering.** Tasks 1 and 2 are split so that Task 1 is provably inert — every value stays 600, so any suite failure is a repointing mistake rather than a judgement call. Task 3 depends on Task 2 for the new value. Tasks 4 and 5 are independent of 1–3 and of each other, and could run in parallel if the executor supports it. Task 6 is last.

**Known risk.** Task 1 Step 8's grep is the guard against a missed site. If it reports a reference this plan does not name, the post-merge tree differs from what was surveyed — stop and re-survey rather than guessing which ceiling that site should take.

**Test impact of the raise, surveyed rather than assumed.** Every test in the post-merge tree that seeds long content or asserts truncation was read before this plan was written:

| test | effect of 600 → 2,000 | handled in |
| --- | --- | --- |
| `tests/mcp/query-pointer-surface.test.ts:78,104,105` | **Fails.** Seeds 1,893 chars, which is now under the ceiling, so `truncated` is absent | Task 2 Step 6 |
| `tests/mcp/server.test.ts:650` | Passes but stops testing anything — it bounds a *timeline assertion*, which stays at 600 | Task 2 Step 5 |
| `tests/mcp/server.test.ts:667` | Passes but stops naming its ceiling — evidence excerpt, stays at 600 | Task 2 Step 5 |
| `tests/core/token-budget.test.ts` truncation case | Passes unchanged; already written against `MAX_ITEM_CONTENT_CHARS + 1` | prose only, Task 2 Step 9 |
| `tests/mcp/tool-response-contract.test.ts:210` | Unaffected — `knowl_context` composes through its own `compact` | asserted green, Task 2 Step 8 |
| `tests/performance/token-budget.test.ts:9` | Unaffected — the markdown path moves to `MAX_SUMMARY_ITEM_CHARS` | asserted green, Task 2 Step 8 |

**Corrected during self-review.** An earlier draft repointed `server.test.ts:650` at `MAX_ITEM_CONTENT_CHARS`. That is wrong: the payload is a timeline assertion, the seeded item is exactly 2,000 characters, and the assertion would have passed while testing nothing.
