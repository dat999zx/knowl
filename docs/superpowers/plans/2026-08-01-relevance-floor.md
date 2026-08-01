# Relevance Floor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop Knowl returning confident results for questions its store knows nothing about, by dropping vector-backed results that score below a measured floor.

**Architecture:** One constant and one filter inside `scoreCandidates`, applied before the result limit is taken so the floor removes results rather than reordering them. The filter is gated on whether vector search **actually contributed** a score, not on whether a caller requested vector — the two differ, and confusing them causes a total retrieval outage.

**Tech Stack:** TypeScript (ESM, `.js` import extensions), vitest, libSQL/Drizzle. Product suite (`npm test`).

## Global Constraints

From `docs/superpowers/specs/2026-08-01-relevance-floor-design.md`.

- **`MIN_VECTOR_RELEVANCE = 0.30`.** Measured 2026-08-01 over 20 queries against a 424-item store: on-topic and near-miss queries score **0.401–0.614**, off-topic **0.170–0.223**, nothing in between.
- **The floor applies only when vector genuinely contributed**, judged by a candidate carrying a vector score — never by `options.usingVector`, which is the *request*.
- **The floor is absolute, never a ratio.** Scores can go slightly negative through freshness and provenance penalties, so "70% of the top score" is ill-defined. A gap filter was measured and is worse than useless: off-topic runner-up ratios reach 0.69 while legitimate ones fall to 0.33.
- **Applied before the limit is taken**, so a query whose candidates are all below the floor returns an empty array. That is the feature.
- Product tests live in `tests/**/*.test.ts` under `npm test`.
- **Any verification that gates a merge is `npm run build && npm test`, in that order.** Twelve test files spawn `dist/index.js`; `npm test` does not build first, so a stale `dist` makes CLI tests validate code that no longer exists. This exact mistake sent a broken release to CI on 2026-08-01.
- The project is ESM (`"type": "module"`); relative imports need explicit `.js` extensions.
- `npx tsc --noEmit` is already red on ~17 pre-existing `src/` errors and exits 0 regardless. The binding gate is that `npx tsc --noEmit 2>&1 | grep "<your file>"` is empty.

## The pre-change baseline, already captured

Run on `da02644` with `node dist/index.js eval retrieval --dataset docs/evals/retrieval-suite.json --vector --json`:

| Metric | Before |
| --- | --- |
| Recall@10 | **0.9940** |
| MRR | 0.9609 |
| nDCG | 0.9689 |
| Failed cases | 8 |
| p50 / p95 latency | 34 ms / 46 ms |

Task 3 re-runs exactly that command and compares. **A recall drop blocks the change.**

## The trap this plan exists to avoid

`rankKnowledge` computes:

```ts
usingVector: Boolean(options.vector?.enabled && options.vector.embedding)
```

That is true when vector was **requested**. It is *not* true that vector produced anything. When a caller enables vector on a store with no embeddings — anyone who turns vector on before running a reindex — `searchKnowledgeEmbeddings` returns nothing, every candidate is BM25-only, and scores land on the **lexical** scale of roughly 0.05–0.23.

A 0.30 floor keyed on `usingVector` would then drop **every result for every query**: a complete retrieval outage, reachable today. Task 1 exists to make that impossible.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `src/store/agent-query.ts` | The constant, the "vector actually contributed" predicate, and the filter. |
| `tests/store/relevance-floor.test.ts` | Unit tests for the predicate and the filter, including the outage case. |

---

### Task 1: The constant and the contribution predicate

**Files:**
- Modify: `src/store/agent-query.ts`
- Test: `tests/store/relevance-floor.test.ts` (create)

**Interfaces:**
- Consumes: the existing `Candidate` type, which already carries `bm25Rank?: number`, `vectorRank?: number` and `vectorScore?: number`.
- Produces: `export const MIN_VECTOR_RELEVANCE = 0.30` and `export function vectorContributed(candidates: Pick<Candidate, 'vectorScore'>[]): boolean`. Task 2 uses both.

`vectorContributed` is the whole safety of this feature. It answers "did vector search actually return anything", which is what makes the floor's scale meaningful.

- [ ] **Step 1: Write the failing test**

```ts
// tests/store/relevance-floor.test.ts
import { describe, expect, it } from 'vitest';
import { MIN_VECTOR_RELEVANCE, vectorContributed } from '../../src/store/agent-query.js';

describe('MIN_VECTOR_RELEVANCE', () => {
  it('sits inside the measured gap between off-topic and legitimate queries', () => {
    // Measured 2026-08-01: off-topic tops out at 0.223, legitimate bottoms out at 0.401.
    expect(MIN_VECTOR_RELEVANCE).toBeGreaterThan(0.223);
    expect(MIN_VECTOR_RELEVANCE).toBeLessThan(0.401);
  });
});

describe('vectorContributed', () => {
  it('is true when at least one candidate carries a vector score', () => {
    expect(vectorContributed([{ vectorScore: undefined }, { vectorScore: 0.42 }])).toBe(true);
  });

  it('is false when no candidate carries one, even though vector may have been requested', () => {
    // The outage case: vector enabled on a store with no embeddings. Every candidate is
    // BM25-only and scores on the lexical scale, where a 0.30 floor would drop everything.
    expect(vectorContributed([{ vectorScore: undefined }, { vectorScore: undefined }])).toBe(false);
  });

  it('is false for no candidates at all', () => {
    expect(vectorContributed([])).toBe(false);
  });

  it('counts a zero vector score as a contribution', () => {
    // 0 is a real cosine result, not an absence. Treating it as absent would disable the
    // floor for exactly the most distant match.
    expect(vectorContributed([{ vectorScore: 0 }])).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/store/relevance-floor.test.ts`
Expected: FAIL — `MIN_VECTOR_RELEVANCE` and `vectorContributed` are not exported from `agent-query.js`.

- [ ] **Step 3: Add the constant and the predicate**

In `src/store/agent-query.ts`, near the other scoring constants at the top of the file:

```ts
/**
 * Below this, a vector-backed result is noise rather than a weak answer.
 *
 * Measured 2026-08-01 over 20 queries against a 424-item store: on-topic and near-miss
 * queries score 0.401-0.614, off-topic queries 0.170-0.223, and nothing falls between.
 * 0.30 leaves roughly 0.08 above the worst junk and 0.10 below the weakest legitimate
 * query -- the larger margin deliberately protects real answers, since silencing one is
 * worse than admitting a weak one.
 */
export const MIN_VECTOR_RELEVANCE = 0.30;

/**
 * Whether vector search actually returned anything for this query.
 *
 * NOT the same as `options.vector?.enabled && options.vector.embedding`, which says only
 * that vector was *requested*. On a store with no embeddings the request succeeds and
 * returns nothing, leaving every candidate on the BM25 scale of roughly 0.05-0.23 -- where
 * applying MIN_VECTOR_RELEVANCE would drop every result for every query.
 */
export function vectorContributed(candidates: Pick<Candidate, 'vectorScore'>[]): boolean {
  return candidates.some(candidate => candidate.vectorScore !== undefined);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/store/relevance-floor.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Verify no new type errors**

Run: `npx tsc --noEmit 2>&1 | grep "agent-query"`
Expected: no output.

- [ ] **Step 6: Commit**

```bash
git add src/store/agent-query.ts tests/store/relevance-floor.test.ts
git commit -m "feat(retrieval): add the relevance floor constant and its contribution guard"
```

---

### Task 2: Apply the floor in scoreCandidates

**Files:**
- Modify: `src/store/agent-query.ts` — the `usingVector` branch of `scoreCandidates`
- Modify: `tests/store/relevance-floor.test.ts`

**Interfaces:**
- Consumes: `MIN_VECTOR_RELEVANCE`, `vectorContributed` (Task 1).
- Produces: no new exports. Behaviour: `scoreCandidates` drops below-floor results when vector contributed, and is byte-identical to today when it did not.

The insertion point is the `usingVector` branch, which currently reads:

```ts
  if (usingVector) {
    // Trust the semantic ranking directly — MMR de-duplication scrambles rankings
    // among legitimately distinct-but-similar atoms and hurts recall.
    selected = scored.slice(0, limit).map(candidate => ({ ...candidate, diversity: 0 }));
  } else {
```

**The filter goes before `.slice(0, limit)`.** Filtering after the slice would leave a query returning two results when three cleared the floor.

**Do not change the `else` branch.** The lexical path has no separation between legitimate and off-topic scores — the floor is meaningless there and applying it would be an outage.

**Why the fixture numbers below work.** The final score is the cosine plus several small additive terms, so a `vectorScore` is not the whole score. For these fixtures the additions total at most about **0.03**: recency ≤ 0.005, confidence 0.005, freshness `fresh` 0.02, text match 0 with no query, and both the category hint (0.015) and the verified-tier boost (0.015) are zero because the fixtures set neither. So `vectorScore: 0.05` scores about 0.08 and drops with wide margin, while `vectorScore: 0.9` scores about 0.93 and stays. A BM25-only candidate scores about 0.036 — `BM25_FALLBACK_WEIGHT / (RRF_K + 1)` plus the same small terms — which is *below* the floor, and is precisely why the "requested but returned nothing" test matters rather than being theoretical.

- [ ] **Step 1: Write the failing test**

Append to `tests/store/relevance-floor.test.ts`:

```ts
import { scoreCandidates } from '../../src/store/agent-query.js';
import type { KnowledgeItem } from '../../src/core/types.js';

const item = (id: string): KnowledgeItem => ({
  id, category: 'fact', status: 'active', title: `item ${id}`, content: 'content',
  confidence: 1, freshness: 'fresh', version: 1,
  createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z',
} as KnowledgeItem);

describe('scoreCandidates with the relevance floor', () => {
  it('drops vector-backed results that fall below the floor', () => {
    const scored = scoreCandidates(
      [
        { item: item('keep'), vectorRank: 1, vectorScore: 0.9 },
        { item: item('drop'), vectorRank: 2, vectorScore: 0.05 },
      ],
      { limit: 10, usingVector: true },
    );

    expect(scored.map((row) => row.item.id)).toEqual(['keep']);
  });

  it('returns nothing when every candidate is below the floor', () => {
    // The point of the feature: a question the store knows nothing about gets no answer.
    const scored = scoreCandidates(
      [
        { item: item('a'), vectorRank: 1, vectorScore: 0.06 },
        { item: item('b'), vectorRank: 2, vectorScore: 0.04 },
      ],
      { limit: 10, usingVector: true },
    );

    expect(scored).toEqual([]);
  });

  it('does NOT apply the floor when vector was requested but returned nothing', () => {
    // The outage case. usingVector is true, but every candidate is BM25-only and scores
    // on the lexical scale, where 0.30 would drop everything.
    const scored = scoreCandidates(
      [
        { item: item('a'), bm25Rank: 1 },
        { item: item('b'), bm25Rank: 2 },
      ],
      { limit: 10, usingVector: true },
    );

    expect(scored.map((row) => row.item.id)).toEqual(['a', 'b']);
  });

  it('leaves the lexical path untouched', () => {
    const scored = scoreCandidates(
      [{ item: item('a'), bm25Rank: 1 }, { item: item('b'), bm25Rank: 2 }],
      { limit: 10, usingVector: false },
    );

    expect(scored).toHaveLength(2);
  });

  it('filters before the limit, so a capped query is not short-changed', () => {
    // Three clear the floor and one does not; with limit 3 the caller must still get 3.
    const scored = scoreCandidates(
      [
        { item: item('a'), vectorRank: 1, vectorScore: 0.90 },
        { item: item('b'), vectorRank: 2, vectorScore: 0.80 },
        { item: item('junk'), vectorRank: 3, vectorScore: 0.02 },
        { item: item('c'), vectorRank: 4, vectorScore: 0.70 },
      ],
      { limit: 3, usingVector: true },
    );

    expect(scored.map((row) => row.item.id)).toEqual(['a', 'b', 'c']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/store/relevance-floor.test.ts`
Expected: FAIL — the drop and empty-result tests return everything, because no filter exists.

- [ ] **Step 3: Apply the filter**

Replace the `usingVector` branch body:

```ts
  if (usingVector) {
    // Trust the semantic ranking directly — MMR de-duplication scrambles rankings
    // among legitimately distinct-but-similar atoms and hurts recall.
    //
    // The floor runs before the limit so a capped query still returns its full quota
    // from whatever cleared it, and is gated on vector having genuinely contributed:
    // on a store with no embeddings every candidate sits on the BM25 scale, where this
    // threshold would drop everything.
    const floored = vectorContributed(candidates)
      ? scored.filter(candidate => candidate.score >= MIN_VECTOR_RELEVANCE)
      : scored;
    selected = floored.slice(0, limit).map(candidate => ({ ...candidate, diversity: 0 }));
  } else {
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/store/relevance-floor.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 5: Run the retrieval and ranking suites**

Run: `npx vitest run tests/store/rank-knowledge.test.ts tests/store/store.test.ts tests/store/filter-before-cap.test.ts`
Expected: PASS. **If one fails, report the exact assertion and why before changing it.** A ranking test failing here may mean the floor is cutting legitimate results, which is the risk this whole plan is built around — do not re-baseline it to match.

- [ ] **Step 6: Verify no new type errors**

Run: `npx tsc --noEmit 2>&1 | grep "agent-query"`
Expected: no output.

- [ ] **Step 7: Commit**

```bash
git add src/store/agent-query.ts tests/store/relevance-floor.test.ts
git commit -m "feat(retrieval): drop vector results below the relevance floor"
```

---

### Task 3: Verify against the eval and the real queries

**Files:**
- No source changes. This task is measurement.

**Interfaces:**
- Consumes: everything from Tasks 1 and 2.
- Produces: the before/after comparison that decides whether this ships.

- [ ] **Step 1: Build, then run the full product suite**

Run: `npm run build && npm test`
Expected: 0 failures. Report file and test counts. **Build first** — twelve test files spawn `dist/index.js`, and a stale build silently validates the previous code.

- [ ] **Step 2: Re-run the retrieval eval with the exact guard command**

Run:

```bash
node dist/index.js eval retrieval --dataset docs/evals/retrieval-suite.json --vector --json
```

Both flags matter. `--dataset` has no default, and `docs/evals/retrieval-baseline.json` is a 10-case smoke test rather than this 500-case suite. Without `--vector` the eval ranks on the lexical path, where the floor does not apply — a green run would prove nothing.

Compare against the captured baseline:

| Metric | Before |
| --- | --- |
| Recall@10 | 0.9940 |
| MRR | 0.9609 |
| nDCG | 0.9689 |
| Failed cases | 8 |

**A drop in Recall@10 blocks the change.** Report both sets of numbers. If recall falls, do not lower the floor to make it pass — report which case IDs newly fail and stop, because a floor that silences correct answers is not worth having and the right response may be to abandon the value rather than tune it.

- [ ] **Step 3: Confirm the behaviour the feature exists for**

Run this probe, which exercises the real ranker on the live store:

```bash
cat > floor-probe.mts <<'EOF'
import { queryKnowledgeForAgent } from './src/store/agent-query.js';
import { createLocalEmbeddingProvider, getVectorSearchConfig } from './src/ai/embeddings.js';
import { loadConfig } from './src/core/config.js';
import { initDb } from './src/store/database.js';
import { getProjectByRootPath } from './src/store/repository.js';

await initDb(process.cwd());
const config = await loadConfig(process.cwd());
const vcfg = getVectorSearchConfig(config);
const provider = await createLocalEmbeddingProvider(config, process.cwd());
const project = (await getProjectByRootPath(process.cwd()))!;

const off = ['training a labrador puppy', 'who won the world cup in 1998', 'best hiking trails in patagonia'];
const on = ['session event expiry retention', 'commit subject extractor rule', 'how does caching work'];

for (const [label, qs] of [['OFF', off], ['ON ', on]] as Array<[string, string[]]>) {
  for (const q of qs) {
    const [embedding] = await provider.embed([q]);
    const rows = await queryKnowledgeForAgent(project.id, {
      query: q, limit: 3,
      vector: { enabled: true, embedding, provider: vcfg.provider, model: vcfg.model },
    });
    console.log(`${label} ${rows.length} result(s)  "${q}"`);
  }
}
EOF
npx tsx floor-probe.mts; rm -f floor-probe.mts
```

Expected: every `OFF` line reports **0 results**, every `ON` line reports **3**. Report the actual output. If an `ON` query returns 0, the floor is too high for this store and that is a finding, not something to work around.

- [ ] **Step 4: Confirm the doctor check still passes**

Run: `node dist/index.js doctor`
Expected: the agent-query check reports OK rather than WARN. It passes no query string and no embedding, so the floor should not reach it — this confirms that reasoning against the real command.

- [ ] **Step 5: Commit the measurements**

Append a `## Results` section to `docs/superpowers/specs/2026-08-01-relevance-floor-design.md` recording the before/after eval numbers, the probe output, and the doctor result.

```bash
git add docs/superpowers/specs/2026-08-01-relevance-floor-design.md
git commit -m "docs(retrieval): record the relevance floor's before and after measurements"
```

---

## Out of Scope

- **Why junk reaches the scorer at all.** Vector search admits its nearest N regardless of distance, and `fallback` in the vector branch is gated on `result.vectorScore === undefined`, so an item BM25 ranked #1 contributes no lexical signal whenever vector also returned it. Both are follow-up work behind the same eval guard.
- **Any floor on the lexical path.** Measured to have no separation; a threshold there would be arbitrary.
- **Making the floor configurable.** One measured constant until there is evidence a second value is needed.
