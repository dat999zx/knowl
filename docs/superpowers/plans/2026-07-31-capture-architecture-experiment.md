# Capture Architecture Experiment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Measure whether a model reading hook events recovers enough durable knowledge to justify building a rule-based extractor at all, using the committed 32-session corpus and a preregistered decision rule.

**Architecture:** A self-contained harness under `benchmarks/unassisted-capture/`. Pure scoring functions (matcher, scorer) take plain vectors and arrays so they unit-test without a model or a database. The model-backed method takes its `generate` function as a parameter so tests inject a stub. Data artifacts — the answer key, the calibration pairs, the frozen threshold — are committed files, not code.

**Tech Stack:** TypeScript (ESM, `.js` import extensions), vitest via `npm run test:bench`, zod for schemas, `ai` + `@ai-sdk/*` for the model call, `@huggingface/transformers` via Knowl's existing local MiniLM embedder.

## Global Constraints

Copied verbatim from `docs/superpowers/specs/2026-07-31-capture-architecture-experiment-design.md`. Every task's requirements implicitly include this section.

- **Junk limit: precision ≥ 0.80.** A method below this is disqualified regardless of recall.
- **Stage 1 gate: method 2 recall over `findable` below 0.30** means stop — do not build the rules; the payload is the constraint. At 0.30 or above, proceed to stage 2.
- **Stage 2 margin: ≥ 20 points** of recall over `findable`. Below that, including a tie, the rules ship. **Stage 2 is out of scope for this plan** — it runs only after the stage 1 reading.
- **Headline recall is computed over `findable` gold only.** `thinking-only` coverage is reported separately as the ceiling hooks cannot cross.
- **Match threshold is calibrated before the run and then frozen.** 20 pairs drawn from `knowledge_items` outside the 32 sessions (10 same-fact, 10 clear non-matches). Pairs within ±0.10 of the frozen threshold are adjudicated by hand and the adjudications recorded.
- **Matching uses the local MiniLM embedder, never an LLM judge** — an LLM judge would share failure modes with the method under test.
- **Thresholds are never tuned after seeing results.** This is preregistration.
- **Transcripts are never committed or copied.** Only their presence is recorded.
- **Corpus selection (≥10 events, ≥2 changed paths) is already applied** and is part of the preregistration. Do not re-filter.
- Benchmark tests live at `benchmarks/*/tests/**/*.test.ts` and run under `npm run test:bench`. They are excluded from `npm test` by design — do not add them to the product suite.
- Typecheck benchmarks with `npm run typecheck:bench`.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `benchmarks/unassisted-capture/build-corpus.mjs` | Already committed. Rebuilds the corpus from a live database. |
| `benchmarks/unassisted-capture/corpus/*.json` | Already committed. The 32-session corpus. |
| `benchmarks/unassisted-capture/src/types.ts` | Shared types for corpus, gold, predictions, scores. |
| `benchmarks/unassisted-capture/src/corpus.ts` | Loads the committed corpus and groups events by session. |
| `benchmarks/unassisted-capture/src/answer-key.ts` | Zod schema and validator for the answer key file. |
| `benchmarks/unassisted-capture/src/matcher.ts` | Cosine similarity, threshold band, maximum-cardinality one-to-one matching. |
| `benchmarks/unassisted-capture/src/calibrate.ts` | Derives the frozen threshold from the calibration pairs. |
| `benchmarks/unassisted-capture/src/score.ts` | Precision, recall over `findable`, `thinking-only` coverage, per-session spread. |
| `benchmarks/unassisted-capture/src/method-model-events.ts` | Method 2: a model reading session events. |
| `benchmarks/unassisted-capture/src/report.ts` | Renders the results table and the stage 1 reading. |
| `benchmarks/unassisted-capture/src/cli.ts` | Entrypoint: `calibrate`, `run`, `report`. |
| `benchmarks/unassisted-capture/answer-key/gold.ndjson` | Data artifact. The hand-written answer key. |
| `benchmarks/unassisted-capture/answer-key/calibration-pairs.json` | Data artifact. The 20 hand-picked pairs. |
| `benchmarks/unassisted-capture/answer-key/threshold.json` | Data artifact. The frozen threshold. |
| `benchmarks/unassisted-capture/tests/*.test.ts` | Unit tests for the pure functions above. |

---

### Task 1: Corpus loader and shared types

**Files:**
- Create: `benchmarks/unassisted-capture/src/types.ts`
- Create: `benchmarks/unassisted-capture/src/corpus.ts`
- Test: `benchmarks/unassisted-capture/tests/corpus.test.ts`

**Interfaces:**
- Consumes: the committed JSON in `benchmarks/unassisted-capture/corpus/`.
- Produces: `loadCorpus(dir?: string): Promise<CorpusSession[]>`, plus the types `CorpusSession`, `CorpusEvent`, `EventPayload`, `GoldMark`, `GoldItem`, `AnswerKey`, `PredictedAtom`, `SessionScore`, `MethodScore`, `MatchPair`.

- [ ] **Step 1: Write the failing test**

```ts
// benchmarks/unassisted-capture/tests/corpus.test.ts
import { describe, expect, it } from 'vitest';
import { loadCorpus } from '../src/corpus.js';

describe('loadCorpus', () => {
  it('loads every committed session with its events attached', async () => {
    const sessions = await loadCorpus();

    expect(sessions).toHaveLength(32);
    expect(sessions.reduce((total, s) => total + s.events.length, 0)).toBe(1424);
  });

  it('sorts events within a session by observation time', async () => {
    const sessions = await loadCorpus();
    const busiest = sessions.reduce((a, b) => (a.events.length >= b.events.length ? a : b));
    const times = busiest.events.map((event) => event.observedAt);

    expect(times).toEqual([...times].sort());
  });

  it('parses event payloads into objects rather than leaving them as JSON strings', async () => {
    const sessions = await loadCorpus();
    const withPaths = sessions
      .flatMap((session) => session.events)
      .find((event) => (event.payload.changedPaths?.length ?? 0) > 0);

    expect(withPaths).toBeDefined();
    expect(Array.isArray(withPaths!.payload.changedPaths)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:bench -- benchmarks/unassisted-capture/tests/corpus.test.ts`
Expected: FAIL — cannot find module `../src/corpus.js`.

- [ ] **Step 3: Write the types**

```ts
// benchmarks/unassisted-capture/src/types.ts

/** Whether a gold item can be derived from events at all. Headline recall covers `findable`
 *  only -- scoring reasoning-only conclusions against an event-driven method makes the
 *  metric unwinnable and uninformative. */
export type GoldMark = 'findable' | 'thinking-only';

export interface EventPayload {
  agent?: string;
  changedPaths?: string[];
  command?: string;
  exitCode?: number;
  message?: string;
  status?: string;
  summary?: string | null;
  title?: string;
}

export type EventType = 'start' | 'stop' | 'checkpoint' | 'command' | 'error' | 'decision';

export interface CorpusEvent {
  id: string;
  sessionId: string;
  type: EventType;
  payload: EventPayload;
  observedAt: string;
}

export interface CorpusSession {
  sessionId: string;
  title: string;
  startedAt: string;
  finishedAt: string | null;
  events: CorpusEvent[];
}

export interface GoldItem {
  targetId: string;
  canonicalFact: string;
  mark: GoldMark;
}

export interface AnswerKey {
  sessionId: string;
  targets: GoldItem[];
  exclusions: string[];
}

export interface PredictedAtom {
  sessionId: string;
  category: string;
  title: string;
  content: string;
}

/** A predicted/gold pairing and the similarity that produced it. */
export interface MatchPair {
  sessionId: string;
  targetId: string;
  predictedIndex: number;
  similarity: number;
}

export interface SessionScore {
  sessionId: string;
  findableTotal: number;
  findableMatched: number;
  thinkingOnlyTotal: number;
  thinkingOnlyMatched: number;
  predictedTotal: number;
  predictedMatched: number;
}

export interface MethodScore {
  method: string;
  recallFindable: number;
  precision: number;
  recallThinkingOnly: number;
  perSession: SessionScore[];
  /** Pairs within the adjudication band, requiring a hand judgment before the score is final. */
  bandPairs: MatchPair[];
}
```

- [ ] **Step 4: Write the corpus loader**

```ts
// benchmarks/unassisted-capture/src/corpus.ts
import fs from 'node:fs/promises';
import path from 'node:path';
import type { CorpusEvent, CorpusSession, EventPayload, EventType } from './types.js';

const DEFAULT_CORPUS_DIR = path.join('benchmarks', 'unassisted-capture', 'corpus');

const readJson = async <T>(dir: string, name: string): Promise<T> =>
  JSON.parse(await fs.readFile(path.join(dir, name), 'utf8')) as T;

/** Payloads are stored as JSON strings in SQLite and survive the dump that way. */
function parsePayload(raw: unknown): EventPayload {
  if (typeof raw !== 'string') return (raw ?? {}) as EventPayload;
  try {
    return JSON.parse(raw) as EventPayload;
  } catch {
    return {};
  }
}

export async function loadCorpus(dir: string = DEFAULT_CORPUS_DIR): Promise<CorpusSession[]> {
  const sessionRows = await readJson<any[]>(dir, 'sessions.json');
  const eventRows = await readJson<any[]>(dir, 'events.json');

  const eventsBySession = new Map<string, CorpusEvent[]>();
  for (const row of eventRows) {
    const sessionId = String(row.session_id);
    const event: CorpusEvent = {
      id: String(row.id),
      sessionId,
      type: String(row.type) as EventType,
      payload: parsePayload(row.payload),
      observedAt: String(row.observed_at),
    };
    const bucket = eventsBySession.get(sessionId);
    if (bucket) bucket.push(event);
    else eventsBySession.set(sessionId, [event]);
  }

  for (const bucket of eventsBySession.values()) {
    bucket.sort((a, b) => a.observedAt.localeCompare(b.observedAt));
  }

  return sessionRows.map((row) => ({
    sessionId: String(row.id),
    title: String(row.title),
    startedAt: String(row.started_at),
    finishedAt: row.finished_at ? String(row.finished_at) : null,
    events: eventsBySession.get(String(row.id)) ?? [],
  }));
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm run test:bench -- benchmarks/unassisted-capture/tests/corpus.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck:bench`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add benchmarks/unassisted-capture/src/types.ts benchmarks/unassisted-capture/src/corpus.ts benchmarks/unassisted-capture/tests/corpus.test.ts
git commit -m "bench(capture): load the committed corpus into typed sessions"
```

---

### Task 2: Answer key schema and validator

**Files:**
- Create: `benchmarks/unassisted-capture/src/answer-key.ts`
- Test: `benchmarks/unassisted-capture/tests/answer-key.test.ts`

**Interfaces:**
- Consumes: `AnswerKey`, `GoldItem` from Task 1.
- Produces: `parseAnswerKey(ndjson: string): AnswerKey[]`, which throws on any violation. `loadAnswerKey(file?: string): Promise<AnswerKey[]>`.

Validation exists because a mislabelled `mark` silently changes the headline number — a gold item wrongly marked `thinking-only` is quietly dropped from recall.

- [ ] **Step 1: Write the failing test**

```ts
// benchmarks/unassisted-capture/tests/answer-key.test.ts
import { describe, expect, it } from 'vitest';
import { parseAnswerKey } from '../src/answer-key.js';

const line = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    sessionId: 's1',
    targets: [{ targetId: 't1', canonicalFact: 'The retry loop was removed.', mark: 'findable' }],
    exclusions: [],
    ...overrides,
  });

describe('parseAnswerKey', () => {
  it('parses one record per line', () => {
    const keys = parseAnswerKey(`${line()}\n${line({ sessionId: 's2' })}`);

    expect(keys.map((k) => k.sessionId)).toEqual(['s1', 's2']);
    expect(keys[0].targets[0].mark).toBe('findable');
  });

  it('ignores blank lines so a trailing newline is not an error', () => {
    expect(parseAnswerKey(`${line()}\n\n`)).toHaveLength(1);
  });

  it('rejects a mark outside the two allowed values', () => {
    const bad = line({ targets: [{ targetId: 't1', canonicalFact: 'x', mark: 'maybe' }] });

    expect(() => parseAnswerKey(bad)).toThrow(/mark/i);
  });

  it('rejects a duplicate targetId even across different sessions', () => {
    // Distinct sessions, same targetId -- the session check passes and the target check catches it.
    const second = line({ sessionId: 's2' });

    expect(() => parseAnswerKey(`${line()}\n${second}`)).toThrow(/duplicate targetId/i);
  });

  it('rejects a duplicate sessionId', () => {
    // Same session, distinct targetId -- the session check fires first.
    const other = line({ targets: [{ targetId: 't2', canonicalFact: 'y', mark: 'findable' }] });

    expect(() => parseAnswerKey(`${line()}\n${other}`)).toThrow(/duplicate session/i);
  });

  it('rejects an empty canonicalFact, which would match everything', () => {
    const bad = line({ targets: [{ targetId: 't1', canonicalFact: '   ', mark: 'findable' }] });

    expect(() => parseAnswerKey(bad)).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:bench -- benchmarks/unassisted-capture/tests/answer-key.test.ts`
Expected: FAIL — cannot find module `../src/answer-key.js`.

- [ ] **Step 3: Write the validator**

```ts
// benchmarks/unassisted-capture/src/answer-key.ts
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { AnswerKey } from './types.js';

const DEFAULT_ANSWER_KEY = path.join('benchmarks', 'unassisted-capture', 'answer-key', 'gold.ndjson');

const GoldItemSchema = z.object({
  targetId: z.string().min(1),
  canonicalFact: z.string().trim().min(1),
  mark: z.enum(['findable', 'thinking-only']),
});

const AnswerKeySchema = z.object({
  sessionId: z.string().min(1),
  targets: z.array(GoldItemSchema),
  exclusions: z.array(z.string()).default([]),
});

export function parseAnswerKey(ndjson: string): AnswerKey[] {
  const keys: AnswerKey[] = [];
  const seenSessions = new Set<string>();
  const seenTargets = new Set<string>();

  const lines = ndjson.split('\n').map((line) => line.trim()).filter((line) => line.length > 0);
  for (const [index, line] of lines.entries()) {
    const parsed = AnswerKeySchema.safeParse(JSON.parse(line));
    if (!parsed.success) {
      throw new Error(`Answer key line ${index + 1} is invalid: ${parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`);
    }
    const key = parsed.data;
    if (seenSessions.has(key.sessionId)) {
      throw new Error(`Answer key line ${index + 1}: duplicate session ${key.sessionId}`);
    }
    seenSessions.add(key.sessionId);
    for (const target of key.targets) {
      if (seenTargets.has(target.targetId)) {
        throw new Error(`Answer key line ${index + 1}: duplicate targetId ${target.targetId}`);
      }
      seenTargets.add(target.targetId);
    }
    keys.push(key);
  }

  return keys;
}

export async function loadAnswerKey(file: string = DEFAULT_ANSWER_KEY): Promise<AnswerKey[]> {
  return parseAnswerKey(await fs.readFile(file, 'utf8'));
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test:bench -- benchmarks/unassisted-capture/tests/answer-key.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add benchmarks/unassisted-capture/src/answer-key.ts benchmarks/unassisted-capture/tests/answer-key.test.ts
git commit -m "bench(capture): validate the answer key format"
```

---

### Task 3: Similarity matcher

**Files:**
- Create: `benchmarks/unassisted-capture/src/matcher.ts`
- Test: `benchmarks/unassisted-capture/tests/matcher.test.ts`

**Interfaces:**
- Consumes: `MatchPair` from Task 1.
- Produces: `cosine(a: number[], b: number[]): number`; `maxCardinalityMatch(edges: boolean[][], leftCount: number, rightCount: number): number[]` returning, per right-hand index, the matched left index or `-1`; `inBand(similarity: number, threshold: number, band?: number): boolean`.

Matching is maximum-cardinality one-to-one, not greedy. Greedy by descending similarity can consume a prediction that was the only possible partner for a later gold item, understating recall.

- [ ] **Step 1: Write the failing test**

```ts
// benchmarks/unassisted-capture/tests/matcher.test.ts
import { describe, expect, it } from 'vitest';
import { cosine, inBand, maxCardinalityMatch } from '../src/matcher.js';

describe('cosine', () => {
  it('scores identical vectors as 1', () => {
    expect(cosine([1, 2, 3], [1, 2, 3])).toBeCloseTo(1, 10);
  });

  it('scores orthogonal vectors as 0', () => {
    expect(cosine([1, 0], [0, 1])).toBeCloseTo(0, 10);
  });

  it('is scale invariant, so unnormalised vectors still compare correctly', () => {
    expect(cosine([1, 2], [10, 20])).toBeCloseTo(1, 10);
  });

  it('returns 0 for a zero vector rather than NaN', () => {
    expect(cosine([0, 0], [1, 1])).toBe(0);
  });
});

describe('inBand', () => {
  it('flags a similarity within the default band of the threshold', () => {
    expect(inBand(0.72, 0.7)).toBe(true);
    expect(inBand(0.62, 0.7)).toBe(true);
  });

  it('does not flag a similarity clear of the band', () => {
    expect(inBand(0.95, 0.7)).toBe(false);
    expect(inBand(0.4, 0.7)).toBe(false);
  });
});

describe('maxCardinalityMatch', () => {
  it('pairs each left with a distinct right', () => {
    const edges = [
      [true, true],
      [true, false],
    ];

    const matched = maxCardinalityMatch(edges, 2, 2);

    expect(matched.filter((left) => left !== -1)).toHaveLength(2);
  });

  it('beats greedy: it does not strand a gold item whose only partner was taken', () => {
    // Left 0 can pair with either right; left 1 only with right 0. A greedy pass that gives
    // right 0 to left 0 strands left 1 and understates recall.
    const edges = [
      [true, true],
      [true, false],
    ];

    const matched = maxCardinalityMatch(edges, 2, 2);

    expect(new Set(matched.filter((left) => left !== -1)).size).toBe(2);
  });

  it('leaves unmatched rights as -1', () => {
    const matched = maxCardinalityMatch([[false, false]], 1, 2);

    expect(matched).toEqual([-1, -1]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:bench -- benchmarks/unassisted-capture/tests/matcher.test.ts`
Expected: FAIL — cannot find module `../src/matcher.js`.

- [ ] **Step 3: Write the matcher**

```ts
// benchmarks/unassisted-capture/src/matcher.ts

/** Half-width of the hand-adjudication band around the frozen threshold. */
export const DEFAULT_BAND = 0.1;

export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  if (magA === 0 || magB === 0) return 0;
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

export function inBand(similarity: number, threshold: number, band: number = DEFAULT_BAND): boolean {
  return Math.abs(similarity - threshold) <= band;
}

/**
 * Kuhn's algorithm for maximum bipartite matching. `edges[left][right]` is true when the
 * pair is above threshold. Returns, per right index, the matched left index or -1.
 */
export function maxCardinalityMatch(edges: boolean[][], leftCount: number, rightCount: number): number[] {
  const matchRight = new Array<number>(rightCount).fill(-1);

  const tryAssign = (left: number, seen: boolean[]): boolean => {
    for (let right = 0; right < rightCount; right++) {
      if (!edges[left]?.[right] || seen[right]) continue;
      seen[right] = true;
      if (matchRight[right] === -1 || tryAssign(matchRight[right], seen)) {
        matchRight[right] = left;
        return true;
      }
    }
    return false;
  };

  for (let left = 0; left < leftCount; left++) {
    tryAssign(left, new Array<boolean>(rightCount).fill(false));
  }

  return matchRight;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test:bench -- benchmarks/unassisted-capture/tests/matcher.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add benchmarks/unassisted-capture/src/matcher.ts benchmarks/unassisted-capture/tests/matcher.test.ts
git commit -m "bench(capture): add cosine matching with maximum-cardinality pairing"
```

---

### Task 4: Threshold calibration

**Files:**
- Create: `benchmarks/unassisted-capture/src/calibrate.ts`
- Test: `benchmarks/unassisted-capture/tests/calibrate.test.ts`

**Interfaces:**
- Consumes: `cosine` from Task 3.
- Produces: `chooseThreshold(scored: ScoredPair[]): { threshold: number; agreement: number }` where `ScoredPair = { similarity: number; same: boolean }`; `calibrate(pairs: CalibrationPair[], embed: Embed): Promise<CalibrationResult>` where `CalibrationPair = { a: string; b: string; same: boolean }`, `Embed = (texts: string[]) => Promise<number[][]>`, and `CalibrationResult = { threshold: number; agreement: number; scored: ScoredPair[] }`.

The threshold is chosen as the midpoint between adjacent candidate similarities, so it never sits exactly on an observed value where a floating-point tie would decide a match.

- [ ] **Step 1: Write the failing test**

```ts
// benchmarks/unassisted-capture/tests/calibrate.test.ts
import { describe, expect, it } from 'vitest';
import { calibrate, chooseThreshold } from '../src/calibrate.js';

describe('chooseThreshold', () => {
  it('separates cleanly split pairs and reports perfect agreement', () => {
    const scored = [
      { similarity: 0.9, same: true },
      { similarity: 0.85, same: true },
      { similarity: 0.3, same: false },
      { similarity: 0.2, same: false },
    ];

    const { threshold, agreement } = chooseThreshold(scored);

    expect(agreement).toBe(1);
    expect(threshold).toBeGreaterThan(0.3);
    expect(threshold).toBeLessThan(0.85);
  });

  it('maximises agreement when one pair is an outlier', () => {
    // Four cleanly separable pairs plus one outlier that no threshold can rescue. The best
    // achievable agreement is exactly 4/5 -- asserting that exact value means a
    // non-maximising search returning a worse threshold fails. A fixture where NO threshold
    // can score 1 would pass for any return value and pin nothing.
    const scored = [
      { similarity: 0.9, same: true },
      { similarity: 0.85, same: true },
      { similarity: 0.3, same: false },
      { similarity: 0.2, same: false },
      { similarity: 0.95, same: false },
    ];

    expect(chooseThreshold(scored).agreement).toBeCloseTo(0.8, 10);
  });

  // Forward-looking, not a regression test: this passes with or without the duplicate guard
  // below, because a candidate sitting on a duplicated value classifies identically to the
  // midpoint just under it and the strict `>` tie-break hands the win to the earlier one.
  // It earns its place by pinning the invariant against a future change of `>` to `>=`,
  // which would start selecting the duplicate-valued candidate. Do not delete as redundant.
  it('never returns a threshold equal to an observed similarity, even with duplicates', () => {
    const scored = [
      { similarity: 1, same: true },
      { similarity: 1, same: true },
      { similarity: 0.2, same: false },
    ];

    const { threshold } = chooseThreshold(scored);

    expect(scored.map((pair) => pair.similarity)).not.toContain(threshold);
  });

  it('throws on an empty set rather than inventing a threshold', () => {
    expect(() => chooseThreshold([])).toThrow(/calibration/i);
  });
});

describe('calibrate', () => {
  it('embeds each side of a pair and scores it', async () => {
    const vectors: Record<string, number[]> = {
      'a same': [1, 0],
      'b same': [1, 0],
      'a diff': [1, 0],
      'b diff': [0, 1],
    };
    const embed = async (texts: string[]) => texts.map((text) => vectors[text]);

    const result = await calibrate(
      [
        { a: 'a same', b: 'b same', same: true },
        { a: 'a diff', b: 'b diff', same: false },
      ],
      embed,
    );

    expect(result.scored.map((s) => s.same)).toEqual([true, false]);
    expect(result.scored[0].similarity).toBeCloseTo(1, 10);
    expect(result.scored[1].similarity).toBeCloseTo(0, 10);
    expect(result.agreement).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:bench -- benchmarks/unassisted-capture/tests/calibrate.test.ts`
Expected: FAIL — cannot find module `../src/calibrate.js`.

- [ ] **Step 3: Write the calibrator**

```ts
// benchmarks/unassisted-capture/src/calibrate.ts
import { cosine } from './matcher.js';

export interface CalibrationPair {
  a: string;
  b: string;
  same: boolean;
}

export interface ScoredPair {
  similarity: number;
  same: boolean;
}

export interface CalibrationResult {
  threshold: number;
  agreement: number;
  scored: ScoredPair[];
}

export type Embed = (texts: string[]) => Promise<number[][]>;

/**
 * Picks the threshold maximising agreement with the hand judgments. Candidates are midpoints
 * between adjacent observed similarities, so the chosen value never sits exactly on an
 * observed score where a floating-point tie would decide a match.
 */
export function chooseThreshold(scored: ScoredPair[]): { threshold: number; agreement: number } {
  if (scored.length === 0) {
    throw new Error('Cannot derive a threshold from an empty calibration set.');
  }

  const sorted = [...scored].sort((a, b) => a.similarity - b.similarity);
  const candidates: number[] = [sorted[0].similarity - 0.01];
  for (let i = 1; i < sorted.length; i++) {
    // Only when the neighbours differ. The midpoint of two equal similarities IS that
    // similarity, and duplicate scores are ordinary -- two near-perfect same-fact pairs
    // both land at ~1.0. Defensive rather than load-bearing: such a candidate can never
    // actually win, since it classifies identically to the midpoint just below it and the
    // strict `>` below hands ties to the earlier candidate (verified by brute force over
    // 320 duplicate-bearing fixtures). Dropping it keeps the candidate set meaningful.
    if (sorted[i - 1].similarity !== sorted[i].similarity) {
      candidates.push((sorted[i - 1].similarity + sorted[i].similarity) / 2);
    }
  }
  candidates.push(sorted[sorted.length - 1].similarity + 0.01);

  let best = { threshold: candidates[0], agreement: -1 };
  for (const threshold of candidates) {
    const correct = scored.filter((pair) => (pair.similarity >= threshold) === pair.same).length;
    const agreement = correct / scored.length;
    if (agreement > best.agreement) best = { threshold, agreement };
  }

  return best;
}

export async function calibrate(pairs: CalibrationPair[], embed: Embed): Promise<CalibrationResult> {
  const texts = pairs.flatMap((pair) => [pair.a, pair.b]);
  const vectors = await embed(texts);

  const scored: ScoredPair[] = pairs.map((pair, index) => ({
    similarity: cosine(vectors[index * 2], vectors[index * 2 + 1]),
    same: pair.same,
  }));

  return { ...chooseThreshold(scored), scored };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test:bench -- benchmarks/unassisted-capture/tests/calibrate.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add benchmarks/unassisted-capture/src/calibrate.ts benchmarks/unassisted-capture/tests/calibrate.test.ts
git commit -m "bench(capture): derive the match threshold from hand-judged pairs"
```

---

### Task 5: Scorer

**Files:**
- Create: `benchmarks/unassisted-capture/src/score.ts`
- Test: `benchmarks/unassisted-capture/tests/score.test.ts`

**Interfaces:**
- Consumes: `cosine`, `inBand`, `maxCardinalityMatch` from Task 3; `AnswerKey`, `PredictedAtom`, `MethodScore`, `SessionScore`, `MatchPair` from Task 1.
- Produces: `scoreMethod(input: ScoreInput): Promise<MethodScore>` where `ScoreInput = { method: string; answerKey: AnswerKey[]; predictions: PredictedAtom[]; threshold: number; embed: Embed }`.

Precision counts every prediction, against gold of **both** marks — a prediction matching a `thinking-only` item is still useful output, and penalising it would be wrong. Recall is `findable` only.

- [ ] **Step 1: Write the failing test**

```ts
// benchmarks/unassisted-capture/tests/score.test.ts
import { describe, expect, it } from 'vitest';
import { scoreMethod } from '../src/score.js';
import type { AnswerKey, PredictedAtom } from '../src/types.js';

const vectors: Record<string, number[]> = {
  'retry loop removed': [1, 0, 0],
  'the retry loop was removed': [1, 0, 0],
  'why it deadlocked': [0, 1, 0],
  'unrelated noise': [0, 0, 1],
};
const embed = async (texts: string[]) => texts.map((text) => vectors[text] ?? [0, 0, 0]);

const answerKey: AnswerKey[] = [
  {
    sessionId: 's1',
    targets: [
      { targetId: 't1', canonicalFact: 'the retry loop was removed', mark: 'findable' },
      { targetId: 't2', canonicalFact: 'why it deadlocked', mark: 'thinking-only' },
    ],
    exclusions: [],
  },
];

describe('scoreMethod', () => {
  it('counts a findable hit in recall', async () => {
    const predictions: PredictedAtom[] = [
      { sessionId: 's1', category: 'fact', title: '', content: 'retry loop removed' },
    ];

    const score = await scoreMethod({ method: 'm', answerKey, predictions, threshold: 0.5, embed });

    expect(score.recallFindable).toBe(1);
    expect(score.precision).toBe(1);
    expect(score.recallThinkingOnly).toBe(0);
  });

  it('excludes thinking-only items from headline recall', async () => {
    const predictions: PredictedAtom[] = [
      { sessionId: 's1', category: 'fact', title: '', content: 'why it deadlocked' },
    ];

    const score = await scoreMethod({ method: 'm', answerKey, predictions, threshold: 0.5, embed });

    expect(score.recallFindable).toBe(0);
    expect(score.recallThinkingOnly).toBe(1);
    expect(score.precision).toBe(1);
  });

  it('counts an unmatched prediction against precision', async () => {
    const predictions: PredictedAtom[] = [
      { sessionId: 's1', category: 'fact', title: '', content: 'retry loop removed' },
      { sessionId: 's1', category: 'fact', title: '', content: 'unrelated noise' },
    ];

    const score = await scoreMethod({ method: 'm', answerKey, predictions, threshold: 0.5, embed });

    expect(score.precision).toBe(0.5);
    expect(score.recallFindable).toBe(1);
  });

  it('reports zero precision rather than NaN when a method predicts nothing', async () => {
    const score = await scoreMethod({ method: 'm', answerKey, predictions: [], threshold: 0.5, embed });

    expect(score.precision).toBe(0);
    expect(score.recallFindable).toBe(0);
  });

  it('collects borderline pairs for hand adjudication', async () => {
    const predictions: PredictedAtom[] = [
      { sessionId: 's1', category: 'fact', title: '', content: 'retry loop removed' },
    ];

    const score = await scoreMethod({ method: 'm', answerKey, predictions, threshold: 0.95, embed });

    expect(score.bandPairs.length).toBeGreaterThan(0);
    expect(score.bandPairs[0].targetId).toBe('t1');
  });

  it('reports per-session rows so the spread can be judged', async () => {
    const score = await scoreMethod({ method: 'm', answerKey, predictions: [], threshold: 0.5, embed });

    expect(score.perSession).toHaveLength(1);
    expect(score.perSession[0]).toMatchObject({ sessionId: 's1', findableTotal: 1, thinkingOnlyTotal: 1 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:bench -- benchmarks/unassisted-capture/tests/score.test.ts`
Expected: FAIL — cannot find module `../src/score.js`.

- [ ] **Step 3: Write the scorer**

```ts
// benchmarks/unassisted-capture/src/score.ts
import type { Embed } from './calibrate.js';
import { cosine, inBand, maxCardinalityMatch } from './matcher.js';
import type { AnswerKey, MatchPair, MethodScore, PredictedAtom, SessionScore } from './types.js';

export interface ScoreInput {
  method: string;
  answerKey: AnswerKey[];
  predictions: PredictedAtom[];
  threshold: number;
  embed: Embed;
}

export async function scoreMethod(input: ScoreInput): Promise<MethodScore> {
  const { method, answerKey, predictions, threshold, embed } = input;

  const perSession: SessionScore[] = [];
  const bandPairs: MatchPair[] = [];

  for (const key of answerKey) {
    const sessionPredictions = predictions.filter((p) => p.sessionId === key.sessionId);
    const goldTexts = key.targets.map((target) => target.canonicalFact);
    const predictionTexts = sessionPredictions.map((p) => `${p.title} ${p.content}`.trim());

    const empty: SessionScore = {
      sessionId: key.sessionId,
      findableTotal: key.targets.filter((t) => t.mark === 'findable').length,
      findableMatched: 0,
      thinkingOnlyTotal: key.targets.filter((t) => t.mark === 'thinking-only').length,
      thinkingOnlyMatched: 0,
      predictedTotal: sessionPredictions.length,
      predictedMatched: 0,
    };

    if (goldTexts.length === 0 || predictionTexts.length === 0) {
      perSession.push(empty);
      continue;
    }

    const vectors = await embed([...goldTexts, ...predictionTexts]);
    const goldVectors = vectors.slice(0, goldTexts.length);
    const predictionVectors = vectors.slice(goldTexts.length);

    // edges[prediction][gold] -- predictions are the left side so an unmatched prediction is
    // directly visible as a precision miss.
    const edges: boolean[][] = [];
    for (let p = 0; p < predictionVectors.length; p++) {
      edges[p] = [];
      for (let g = 0; g < goldVectors.length; g++) {
        const similarity = cosine(predictionVectors[p], goldVectors[g]);
        edges[p][g] = similarity >= threshold;
        if (inBand(similarity, threshold)) {
          bandPairs.push({
            sessionId: key.sessionId,
            targetId: key.targets[g].targetId,
            predictedIndex: p,
            similarity,
          });
        }
      }
    }

    const matchedGold = maxCardinalityMatch(edges, predictionVectors.length, goldVectors.length);

    let findableMatched = 0;
    let thinkingOnlyMatched = 0;
    let predictedMatched = 0;
    for (let g = 0; g < matchedGold.length; g++) {
      if (matchedGold[g] === -1) continue;
      predictedMatched++;
      if (key.targets[g].mark === 'findable') findableMatched++;
      else thinkingOnlyMatched++;
    }

    perSession.push({ ...empty, findableMatched, thinkingOnlyMatched, predictedMatched });
  }

  const sum = (pick: (row: SessionScore) => number) => perSession.reduce((total, row) => total + pick(row), 0);
  const ratio = (numerator: number, denominator: number) => (denominator === 0 ? 0 : numerator / denominator);

  return {
    method,
    recallFindable: ratio(sum((r) => r.findableMatched), sum((r) => r.findableTotal)),
    recallThinkingOnly: ratio(sum((r) => r.thinkingOnlyMatched), sum((r) => r.thinkingOnlyTotal)),
    precision: ratio(sum((r) => r.predictedMatched), sum((r) => r.predictedTotal)),
    perSession,
    bandPairs,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test:bench -- benchmarks/unassisted-capture/tests/score.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add benchmarks/unassisted-capture/src/score.ts benchmarks/unassisted-capture/tests/score.test.ts
git commit -m "bench(capture): score precision and findable-only recall"
```

---

### Task 6: Method 2 — a model reading session events

**Files:**
- Create: `benchmarks/unassisted-capture/src/method-model-events.ts`
- Test: `benchmarks/unassisted-capture/tests/method-model-events.test.ts`

**Interfaces:**
- Consumes: `CorpusSession`, `PredictedAtom` from Task 1.
- Produces: `renderSessionEvents(session: CorpusSession): string`; `runModelOnEvents(sessions: CorpusSession[], generate: GenerateAtoms): Promise<PredictedAtom[]>` where `GenerateAtoms = (prompt: string) => Promise<Array<{ category: string; title: string; content: string }>>`; `PredictedAtomSchema` (zod) for the model's structured output; `MODEL_EVENTS_SYSTEM_PROMPT`.

`generate` is a parameter so the method unit-tests without an API key. The CLI supplies the real implementation in Task 7.

- [ ] **Step 1: Write the failing test**

```ts
// benchmarks/unassisted-capture/tests/method-model-events.test.ts
import { describe, expect, it } from 'vitest';
import { renderSessionEvents, runModelOnEvents } from '../src/method-model-events.js';
import type { CorpusSession } from '../src/types.js';

const session: CorpusSession = {
  sessionId: 's1',
  title: 'Agent turn',
  startedAt: '2026-07-30T10:00:00.000Z',
  finishedAt: '2026-07-30T10:30:00.000Z',
  events: [
    {
      id: 'e1',
      sessionId: 's1',
      type: 'error',
      payload: { message: 'SQLITE_BUSY: database is locked' },
      observedAt: '2026-07-30T10:01:00.000Z',
    },
    {
      id: 'e2',
      sessionId: 's1',
      type: 'checkpoint',
      payload: { changedPaths: ['src/store/database.ts'] },
      observedAt: '2026-07-30T10:02:00.000Z',
    },
    {
      id: 'e3',
      sessionId: 's1',
      type: 'command',
      payload: { command: 'npx vitest run', exitCode: 0 },
      observedAt: '2026-07-30T10:03:00.000Z',
    },
  ],
};

describe('renderSessionEvents', () => {
  it('includes error text, changed paths, and commands', () => {
    const rendered = renderSessionEvents(session);

    expect(rendered).toContain('SQLITE_BUSY');
    expect(rendered).toContain('src/store/database.ts');
    expect(rendered).toContain('npx vitest run');
  });

  it('keeps events in observation order so a failure reads as preceding its fix', () => {
    const rendered = renderSessionEvents(session);

    expect(rendered.indexOf('SQLITE_BUSY')).toBeLessThan(rendered.indexOf('src/store/database.ts'));
  });

  it('does not leak the session title into the event stream, which the rules cannot see', () => {
    expect(renderSessionEvents({ ...session, title: 'SECRET-TITLE' })).not.toContain('SECRET-TITLE');
  });
});

describe('runModelOnEvents', () => {
  it('tags every returned atom with its session', async () => {
    const generate = async () => [{ category: 'fact', title: 'Lock', content: 'SQLITE_BUSY fixed in database.ts' }];

    const atoms = await runModelOnEvents([session], generate);

    expect(atoms).toEqual([
      { sessionId: 's1', category: 'fact', title: 'Lock', content: 'SQLITE_BUSY fixed in database.ts' },
    ]);
  });

  it('treats an empty return as zero atoms rather than an error', async () => {
    expect(await runModelOnEvents([session], async () => [])).toEqual([]);
  });

  it('keeps going when one session throws, so a single failure cannot void the run', async () => {
    let call = 0;
    const generate = async () => {
      call++;
      if (call === 1) throw new Error('rate limited');
      return [{ category: 'fact', title: 'T', content: 'C' }];
    };

    const atoms = await runModelOnEvents([session, { ...session, sessionId: 's2' }], generate);

    expect(atoms).toHaveLength(1);
    expect(atoms[0].sessionId).toBe('s2');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:bench -- benchmarks/unassisted-capture/tests/method-model-events.test.ts`
Expected: FAIL — cannot find module `../src/method-model-events.js`.

- [ ] **Step 3: Write the method**

```ts
// benchmarks/unassisted-capture/src/method-model-events.ts
import { z } from 'zod';
import type { CorpusSession, PredictedAtom } from './types.js';

export const PredictedAtomSchema = z.object({
  atoms: z.array(
    z.object({
      category: z.enum(['fact', 'decision', 'architecture', 'constraint', 'state', 'skill']),
      title: z.string().min(1),
      content: z.string().min(1),
    }),
  ),
});

export const MODEL_EVENTS_SYSTEM_PROMPT = `You are extracting durable project knowledge from a coding session's event log.

You see only what an automated hook recorded: errors, files changed, and commands run. You do NOT see the conversation, the reasoning, or the code.

Write only knowledge that a careful reviewer would still want six months from now, and that is genuinely supported by the events. A failure that was followed by edits and did not recur is durable. Files repeatedly changed together are durable. A command running once is not. "The session finished" is not.

Prefer returning nothing over returning something weak. Noise is worse than silence: every wrong item degrades every future search.`;

export type GenerateAtoms = (prompt: string) => Promise<Array<{ category: string; title: string; content: string }>>;

/**
 * Renders exactly the signal the hook layer records -- deliberately excluding the session
 * title, which the rules cannot key on either. Giving the model a hand-written title would
 * measure the title, not the events.
 */
export function renderSessionEvents(session: CorpusSession): string {
  const lines: string[] = [];
  for (const event of session.events) {
    const { payload } = event;
    switch (event.type) {
      case 'error':
        if (payload.message) lines.push(`[error] ${payload.message}`);
        break;
      case 'checkpoint':
        if (payload.changedPaths?.length) lines.push(`[changed] ${payload.changedPaths.join(', ')}`);
        break;
      case 'command':
        if (payload.command) lines.push(`[command exit=${payload.exitCode ?? '?'}] ${payload.command}`);
        break;
      case 'stop':
        lines.push(`[stop] status=${payload.status ?? 'unknown'}`);
        break;
      default:
        break;
    }
  }
  return lines.join('\n');
}

export async function runModelOnEvents(
  sessions: CorpusSession[],
  generate: GenerateAtoms,
): Promise<PredictedAtom[]> {
  const predictions: PredictedAtom[] = [];

  for (const session of sessions) {
    const rendered = renderSessionEvents(session);
    if (rendered.length === 0) continue;

    try {
      const atoms = await generate(rendered);
      for (const atom of atoms) {
        predictions.push({
          sessionId: session.sessionId,
          category: atom.category,
          title: atom.title,
          content: atom.content,
        });
      }
    } catch (error) {
      // One session failing must not void a run that costs money. The miss shows up as
      // reduced recall, which is the honest outcome, and the session is named on stderr.
      console.error(`session ${session.sessionId} failed: ${(error as Error).message}`);
    }
  }

  return predictions;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test:bench -- benchmarks/unassisted-capture/tests/method-model-events.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add benchmarks/unassisted-capture/src/method-model-events.ts benchmarks/unassisted-capture/tests/method-model-events.test.ts
git commit -m "bench(capture): add the model-over-events method"
```

---

### Task 7: Report renderer and CLI

**Files:**
- Create: `benchmarks/unassisted-capture/src/report.ts`
- Create: `benchmarks/unassisted-capture/src/cli.ts`
- Test: `benchmarks/unassisted-capture/tests/report.test.ts`

**Interfaces:**
- Consumes: everything above.
- Produces: `readStage1(score: MethodScore): Stage1Reading` where `Stage1Reading = { proceed: boolean; disqualified: boolean; verdict: string }`; `renderReport(score: MethodScore, reading: Stage1Reading): string`. CLI commands `calibrate` and `run`.

The gate values live here as named constants so the preregistered numbers appear once in code and match the spec exactly.

- [ ] **Step 1: Write the failing test**

```ts
// benchmarks/unassisted-capture/tests/report.test.ts
import { describe, expect, it } from 'vitest';
import { readStage1, renderReport } from '../src/report.js';
import type { MethodScore } from '../src/types.js';

const score = (overrides: Partial<MethodScore> = {}): MethodScore => ({
  method: 'model-events',
  recallFindable: 0.5,
  recallThinkingOnly: 0.1,
  precision: 0.9,
  perSession: [
    { sessionId: 's1', findableTotal: 2, findableMatched: 1, thinkingOnlyTotal: 1, thinkingOnlyMatched: 0, predictedTotal: 1, predictedMatched: 1 },
  ],
  bandPairs: [],
  ...overrides,
});

describe('readStage1', () => {
  it('proceeds when recall clears 0.30 at or above the junk limit', () => {
    expect(readStage1(score())).toMatchObject({ proceed: true, disqualified: false });
  });

  it('stops when recall is below 0.30', () => {
    const reading = readStage1(score({ recallFindable: 0.29 }));

    expect(reading.proceed).toBe(false);
    expect(reading.verdict).toMatch(/payload/i);
  });

  it('disqualifies a method under the 0.80 junk limit however high its recall', () => {
    const reading = readStage1(score({ recallFindable: 0.99, precision: 0.79 }));

    expect(reading.disqualified).toBe(true);
    expect(reading.proceed).toBe(false);
  });

  it('disqualifies on precision before considering recall, when both gates fail', () => {
    // The only input where check ORDER is observable. The test above cannot pin precedence:
    // its recall of 0.99 clears the gate on its own, so swapping the two checks yields the
    // same verdict. Here both fail, so a swapped order would report the payload verdict
    // with disqualified false.
    const reading = readStage1(score({ recallFindable: 0.1, precision: 0.5 }));

    expect(reading.disqualified).toBe(true);
    expect(reading.proceed).toBe(false);
    expect(reading.verdict).toMatch(/junk limit/i);
    expect(reading.verdict).not.toMatch(/payload/i);
  });

  it('treats exactly 0.30 recall and exactly 0.80 precision as passing', () => {
    expect(readStage1(score({ recallFindable: 0.3, precision: 0.8 }))).toMatchObject({
      proceed: true,
      disqualified: false,
    });
  });
});

describe('renderReport', () => {
  it('shows the headline numbers and flags band pairs needing adjudication', () => {
    const withBand = score({ bandPairs: [{ sessionId: 's1', targetId: 't1', predictedIndex: 0, similarity: 0.72 }] });
    const text = renderReport(withBand, readStage1(withBand));

    expect(text).toContain('0.50');
    expect(text).toContain('0.90');
    expect(text).toMatch(/1 pair/i);
  });

  it('states the thinking-only ceiling separately from headline recall', () => {
    expect(renderReport(score(), readStage1(score()))).toMatch(/thinking-only/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:bench -- benchmarks/unassisted-capture/tests/report.test.ts`
Expected: FAIL — cannot find module `../src/report.js`.

- [ ] **Step 3: Write the report renderer**

```ts
// benchmarks/unassisted-capture/src/report.ts
import type { MethodScore } from './types.js';

/** Preregistered in docs/superpowers/specs/2026-07-31-capture-architecture-experiment-design.md.
 *  Never tune these after seeing a result. */
export const JUNK_LIMIT = 0.8;
export const STAGE1_RECALL_GATE = 0.3;

export interface Stage1Reading {
  proceed: boolean;
  disqualified: boolean;
  verdict: string;
}

export function readStage1(score: MethodScore): Stage1Reading {
  if (score.precision < JUNK_LIMIT) {
    return {
      proceed: false,
      disqualified: true,
      verdict: `Disqualified: precision ${score.precision.toFixed(2)} is below the ${JUNK_LIMIT} junk limit. Recall is not considered.`,
    };
  }
  if (score.recallFindable < STAGE1_RECALL_GATE) {
    return {
      proceed: false,
      disqualified: false,
      verdict: `Stop. Recall ${score.recallFindable.toFixed(2)} is below the ${STAGE1_RECALL_GATE} gate: the events do not carry recoverable knowledge. Do not build the rules -- the payload is the constraint. Escalate method 3 and the retention work.`,
    };
  }
  return {
    proceed: true,
    disqualified: false,
    verdict: `Proceed to stage 2. Recall ${score.recallFindable.toFixed(2)} clears the ${STAGE1_RECALL_GATE} gate at precision ${score.precision.toFixed(2)}.`,
  };
}

export function renderReport(score: MethodScore, reading: Stage1Reading): string {
  const sessionsWithGold = score.perSession.filter((row) => row.findableTotal > 0);
  const perSessionRecall = sessionsWithGold.map((row) => row.findableMatched / row.findableTotal);
  const spread = perSessionRecall.length
    ? `${Math.min(...perSessionRecall).toFixed(2)} - ${Math.max(...perSessionRecall).toFixed(2)}`
    : 'n/a';

  return [
    `Method: ${score.method}`,
    '',
    `  Recall (findable)      ${score.recallFindable.toFixed(2)}`,
    `  Precision              ${score.precision.toFixed(2)}`,
    `  Recall (thinking-only) ${score.recallThinkingOnly.toFixed(2)}   <- ceiling hooks cannot cross, reported separately`,
    '',
    `  Sessions scored        ${score.perSession.length}`,
    `  Per-session recall     ${spread}`,
    `  Adjudication           ${score.bandPairs.length} pair(s) within the band, hand judgment required before this score is final`,
    '',
    reading.verdict,
  ].join('\n');
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test:bench -- benchmarks/unassisted-capture/tests/report.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Write the CLI**

```ts
// benchmarks/unassisted-capture/src/cli.ts
import fs from 'node:fs/promises';
import path from 'node:path';
import { generateObject } from 'ai';
import { initAI } from '../../../src/ai/provider.js';
import { createLocalEmbeddingProvider } from '../../../src/ai/embeddings.js';
import { loadConfig } from '../../../src/core/config.js';
import { loadAnswerKey } from './answer-key.js';
import { calibrate, type CalibrationPair, type Embed } from './calibrate.js';
import { loadCorpus } from './corpus.js';
import { MODEL_EVENTS_SYSTEM_PROMPT, PredictedAtomSchema, runModelOnEvents } from './method-model-events.js';
import { readStage1, renderReport } from './report.js';
import { scoreMethod } from './score.js';

const ANSWER_KEY_DIR = path.join('benchmarks', 'unassisted-capture', 'answer-key');
const THRESHOLD_FILE = path.join(ANSWER_KEY_DIR, 'threshold.json');
const PAIRS_FILE = path.join(ANSWER_KEY_DIR, 'calibration-pairs.json');
const RESULTS_FILE = path.join('benchmarks', 'unassisted-capture', 'results.json');

async function embedder(): Promise<Embed> {
  const config = await loadConfig(process.cwd());
  const provider = await createLocalEmbeddingProvider(config, process.cwd());
  return (texts: string[]) => provider.embed(texts);
}

async function commandCalibrate(): Promise<void> {
  const pairs = JSON.parse(await fs.readFile(PAIRS_FILE, 'utf8')) as CalibrationPair[];
  const result = await calibrate(pairs, await embedder());

  await fs.writeFile(
    THRESHOLD_FILE,
    `${JSON.stringify({ threshold: result.threshold, agreement: result.agreement, pairs: pairs.length, frozenAt: new Date().toISOString() }, null, 2)}\n`,
  );
  console.log(`threshold ${result.threshold.toFixed(4)} (agreement ${result.agreement.toFixed(2)} over ${pairs.length} pairs) -> ${THRESHOLD_FILE}`);
}

async function commandRun(): Promise<void> {
  const frozen = JSON.parse(await fs.readFile(THRESHOLD_FILE, 'utf8')) as { threshold: number };
  const answerKey = await loadAnswerKey();
  const corpus = await loadCorpus();
  const scored = corpus.filter((session) => answerKey.some((key) => key.sessionId === session.sessionId));

  const config = await loadConfig(process.cwd());
  if (!config.ai) throw new Error('No AI provider configured; method 2 cannot run.');
  const model = initAI(config.ai);

  const predictions = await runModelOnEvents(scored, async (prompt) => {
    const { object } = await generateObject({
      model,
      schema: PredictedAtomSchema,
      system: MODEL_EVENTS_SYSTEM_PROMPT,
      prompt,
      temperature: 0.1,
    });
    return object.atoms;
  });

  const score = await scoreMethod({
    method: 'model-events',
    answerKey,
    predictions,
    threshold: frozen.threshold,
    embed: await embedder(),
  });
  const reading = readStage1(score);

  await fs.writeFile(RESULTS_FILE, `${JSON.stringify({ score, reading, threshold: frozen.threshold }, null, 2)}\n`);
  console.log(renderReport(score, reading));
}

const command = process.argv[2];
const run = command === 'calibrate' ? commandCalibrate : command === 'run' ? commandRun : null;
if (!run) {
  console.error('usage: cli.ts <calibrate|run>');
  process.exit(1);
}
run().catch((error: Error) => {
  console.error(error.message);
  process.exit(1);
});
```

- [ ] **Step 6: Verify the CLI's imports resolve**

Run: `npm run typecheck:bench`
Expected: no errors. `loadConfig(projectRoot: string): Promise<ProjectConfig>` is verified to exist at `src/core/config.ts:103`, and `createLocalEmbeddingProvider` requires `search.vector.enabled` to be true in `.knowl/config.json` — if it throws "Vector search is not enabled", enable it rather than bypassing the embedder, since the frozen threshold is meaningless under a different similarity function.

- [ ] **Step 7: Commit**

```bash
git add benchmarks/unassisted-capture/src/report.ts benchmarks/unassisted-capture/src/cli.ts benchmarks/unassisted-capture/tests/report.test.ts
git commit -m "bench(capture): add the stage 1 reading and CLI"
```

---

### Task 8: Write the calibration pairs and the answer key

**Files:**
- Create: `benchmarks/unassisted-capture/answer-key/calibration-pairs.json`
- Create: `benchmarks/unassisted-capture/answer-key/gold.ndjson`
- Create: `benchmarks/unassisted-capture/answer-key/README.md`

**Interfaces:**
- Consumes: `parseAnswerKey` (Task 2) to validate; `commandCalibrate` (Task 7) to freeze the threshold.
- Produces: the two data artifacts every later step depends on.

This is a labelling task, not a coding task. It is the expensive step and the one that determines whether any number means anything.

- [ ] **Step 1: Write the 20 calibration pairs**

Draw from `benchmarks/unassisted-capture/corpus/seed-items.json` and the wider store, using only items **outside** the 32 scored sessions. Ten pairs must state the same fact in different words; ten must be clearly different facts drawn from the same project so they share vocabulary — near-misses, not random pairs, or the threshold calibrates too low.

```json
[
  { "a": "The write path segfault came from Drizzle batching multi-statement transactions.", "b": "A crash on writes was traced to Drizzle sending several statements in one transaction.", "same": true },
  { "a": "Retrieval is vector-first with BM25 as a bounded fallback.", "b": "Ranking uses cosine similarity first and falls back to BM25 by rank.", "same": true },
  { "a": "Retrieval is vector-first with BM25 as a bounded fallback.", "b": "The write path segfault came from Drizzle batching multi-statement transactions.", "same": false }
]
```

Continue to exactly 20 entries, 10 `true` and 10 `false`.

- [ ] **Step 2: Freeze the threshold**

Run: `npx tsx benchmarks/unassisted-capture/src/cli.ts calibrate`
Expected: writes `answer-key/threshold.json` and prints the agreement. **If agreement is below 0.90, the pairs are not separable — revise the pairs, not the threshold, and re-run.** Record the final agreement; it is published with the results.

- [ ] **Step 3: Write the answer key, cold**

For each of the 32 sessions in `corpus/sessions.json`, read its events (`corpus/events.json`, filtered by `session_id`) and write what a careful reviewer would want retained. **Do not open `seed-items.json` while doing this** — that file is the audit in Step 5, and reading it first destroys its value.

One NDJSON line per session, every session present even when its `targets` array is empty:

```json
{"sessionId":"41f80e20...","targets":[{"targetId":"t-41f8-01","canonicalFact":"The workspace manifest test suite was stabilised by giving it its own KNOWL_HOME.","mark":"findable"},{"targetId":"t-41f8-02","canonicalFact":"The suite was flaky because parallel workers shared one home directory.","mark":"thinking-only"}],"exclusions":[]}
```

Mark `findable` only when the events alone support it — an error message, a changed path, a command. Mark `thinking-only` when the item requires knowing why. When genuinely unsure, mark `thinking-only`: that removes it from headline recall and is the conservative choice, because wrongly marking an underivable item `findable` makes every method look worse than it is.

- [ ] **Step 4: Validate the answer key**

```bash
node --input-type=module -e "
import { loadAnswerKey } from './benchmarks/unassisted-capture/src/answer-key.js';
const keys = await loadAnswerKey();
const targets = keys.flatMap(k => k.targets);
console.log('sessions', keys.length);
console.log('findable', targets.filter(t => t.mark === 'findable').length);
console.log('thinking-only', targets.filter(t => t.mark === 'thinking-only').length);
"
```

Expected: `sessions 32`, and a non-zero `findable` count. A zero `findable` count means the corpus cannot discriminate and the experiment must stop before spending money on the model.

- [ ] **Step 5: Run the seed audit**

Compare the answer key against the 41 items in `corpus/seed-items.json`. For each seed item, decide whether the cold answer key covers it. Record in `answer-key/README.md`: how many of the 41 were covered, and for each miss, one line on whether the labeller missed something real or the stored item was not actually durable.

This is the check on the labeller. A low coverage number is publishable, not hideable.

- [ ] **Step 6: Commit**

```bash
git add benchmarks/unassisted-capture/answer-key/
git commit -m "bench(capture): add the cold-labelled answer key and frozen threshold"
```

---

### Task 9: Run stage 1 and record the reading

**Files:**
- Create: `benchmarks/unassisted-capture/results.json` (generated)
- Modify: `docs/superpowers/specs/2026-07-31-capture-architecture-experiment-design.md` — append a Results section.

**Interfaces:**
- Consumes: everything above.
- Produces: the stage 1 reading, recorded as a Knowl decision.

- [ ] **Step 1: Confirm the threshold is frozen before spending money**

```bash
cat benchmarks/unassisted-capture/answer-key/threshold.json
```

Expected: a `frozenAt` timestamp **earlier** than this run. If the file is missing, stop — running first and calibrating after would invalidate the preregistration.

- [ ] **Step 2: Run method 2**

Run: `npx tsx benchmarks/unassisted-capture/src/cli.ts run`
Expected: prints the report and writes `results.json`.

- [ ] **Step 3: Adjudicate the band pairs**

Read `results.json` → `score.bandPairs`. For each, judge by hand whether the pair states the same fact, and record each judgment in `answer-key/README.md`. If any judgment flips a match, note the corrected recall and precision alongside the raw numbers. **Do not move the threshold** — that is what the band exists to avoid.

- [ ] **Step 4: Append the results to the spec**

Add a `## Results` section recording: the frozen threshold and its calibration agreement; recall over `findable`; precision; `thinking-only` coverage; the per-session spread; the band adjudication count; and the verbatim verdict string. State the sample size and the one-developer, one-repository, two-day limitation next to the headline number, not in a footnote.

- [ ] **Step 5: Record the decision**

Call `knowl_decide` with the stage 1 reading and the action it triggers — proceed to stage 2 and build the rules, or stop and escalate the payload question. Pass `supersedes: "dfc0fd9d36734a0e"` only if the reading contradicts that decision; otherwise leave it active and reference it.

- [ ] **Step 6: Commit**

```bash
git add benchmarks/unassisted-capture/results.json benchmarks/unassisted-capture/answer-key/README.md docs/superpowers/specs/2026-07-31-capture-architecture-experiment-design.md
git commit -m "bench(capture): record the stage 1 reading"
```

---

## Out of Scope for This Plan

- **Stage 2 (method 1, the rules).** Built only if Task 9 returns "proceed". It gets its own plan once the reading exists — building it now is exactly the waste this experiment prevents.
- **Method 3 (model reading the transcript).** Blocked at 3 of 32 sessions; needs 20.
- **Event TTL and transcript retention changes.** Product decisions for the maintainer, flagged in the spec, not benchmark knobs.
- **CI wiring and the permanent unassisted-capture benchmark.** The latter scores one shipped extractor under the zero-write condition and should not be designed before its subject is chosen.
