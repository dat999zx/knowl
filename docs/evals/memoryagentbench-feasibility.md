# MemoryAgentBench Conflict Resolution — feasibility

**Date:** 2026-07-27
**Question:** is there a smaller, public benchmark that actually tests Knowl's differentiator?
**Answer: yes — MemoryAgentBench's Conflict Resolution track. Recommend switching focus to it.**

---

## Why this one and not LongMemEval

LongMemEval measures generic retrieval over chat history. Chat turns carry no status, so
Knowl's governance — supersession, current-vs-stale, rejected exclusion — is switched off, and
Knowl competes as a plain embedding+BM25 retriever. It also gave little room to be interesting:
everyone already scores 90%+ on Recall@10.

MemoryAgentBench's **Conflict Resolution (CR)** competency is the inverse. It is defined as
"detecting and overwriting outdated facts when new, contradictory information is introduced,
ensuring subsequent queries reflect only the newest valid data" — a near-verbatim description of
what Knowl's write path is built to do.

**And the public state of the art is bad at it:**

| Track | Long-context agents | Best RAG method |
| --- | --- | --- |
| CR-SH (single-hop) | 45.0% | 56.0% |
| CR-MH (multi-hop) | 5.0% | 3.0% |

The paper reports that "all paradigms exhibit dramatic failures on multi-hop conflict
resolution: best accuracy remains at or below **6%** for CR-MH."

That is the opposite situation from LongMemEval. There is enormous visible headroom, on a public
benchmark, in exactly the capability Knowl claims as its reason to exist.

Practical properties: metric is **Latest-fact Exact Match** — deterministic string matching, so
**no LLM judge and no API spend**. Datasets are `fact_sh` / `fact_mh` from FactConsolidation,
built from "concatenated edit pairs". MIT licensed. Substantially smaller than LongMemEval's
500 × ~115k tokens.

---

## Correction: Knowl does infer supersession

An earlier note in this session claimed Knowl's supersession is purely caller-driven — that the
client model must pass a `supersedes` id. **That is wrong**, and it matters, because it was the
main argued reason CR might be infeasible.

Reading [`src/store/knowledge-writer.ts`](../../src/store/knowledge-writer.ts), Knowl has three
supersession paths, and one of them is fully automatic:

```ts
export function resolveDuplicate(input, duplicate): DuplicateResolution {
  if (input.supersedes && input.supersedes === duplicate.id) return 'supersede';  // explicit
  if (normalizedIdentity(input) === normalizedIdentity(duplicate)) return 'no-op'; // exact re-store
  return sameSubjectTitle(input, duplicate) ? 'supersede' : 'coexist';             // INFERRED
}
```

`sameSubjectTitle` tokenises both titles, drops stop words, and returns true when the smaller
token set (of at least 2 tokens) is a **subset** of the larger. So writing an item titled
"Capital of France" when one already exists with that subject retires the predecessor
automatically, with no caller hint. `findLikelyDuplicateKnowledgeItem` finds the candidate by
BM25 within the same category and `active` status.

There is also `conflictKey` + `conflictExclusive` for a caller-declared "only one active value"
identity.

So Knowl can, in principle, do unprompted latest-fact consolidation. **CR is not
architecturally out of reach.**

---

## The real crux: how raw facts become titled atoms

The auto-supersession rule keys on **titles**. FactConsolidation injects facts as a raw text
stream, so the harness must turn each injected fact into an atom with a title. That choice
decides the whole result:

- Title each chunk generically (`"chunk 17"`) → token subsets never match → supersession never
  fires → Knowl scores like any other RAG system.
- Title each atom with the fact's **subject** → supersession fires → the benchmark actually
  exercises Knowl's governance.

This is legitimate, not a workaround: Knowl's design deliberately delegates extraction to the
client model, and a real user's agent titles atoms by subject. That is "native mode".

**The honesty line, which must be preregistered:** the title must be derived from the injected
fact's own text, deterministically, using no knowledge of which fact is newest, which is gold, or
what the question will ask. Stream order alone supplies recency. A harness that titled atoms
using the answer key would be manufacturing the result, and the number would be worthless.

A second, smaller risk: `findLikelyDuplicateKnowledgeItem` searches by BM25 within the same
category. If the injected facts are lexically similar to each other but not to their own
predecessor, detection can miss. Worth measuring, not assuming.

---

## Recommendation

1. **Stop with LongMemEval.** Keep the two committed session-granularity results — they are
   honest, complete, and externally anchored, and they already paid for themselves by exposing
   the embedding truncation and the N+1 scan. Do not re-run.
2. **Target CR-SH first, then CR-MH.** Deterministic metric, no judge, no spend, small data, and
   published baselines that are weak enough that a real result would be meaningful.
3. **Preregister the titling rule before running anything**, for the reason above.
4. **Keep the internal governance suite as a regression guard**, not as proof — it is
   self-authored, which is the whole problem it cannot solve.

**Expected outcome, stated in advance:** if Knowl's inferred supersession works as designed,
CR-SH should land well above the 56% best-RAG baseline, because Knowl retires the predecessor at
write time instead of hoping the reader picks the newest of several retrieved contradictions.
CR-MH is a genuinely hard multi-hop reasoning task and Knowl has no special mechanism for it;
a low score there would be honest and expected.

## Sources

- [MemoryAgentBench repository](https://github.com/HUST-AI-HYZ/MemoryAgentBench) · [paper (arXiv 2507.05257)](https://arxiv.org/pdf/2507.05257) · [competency and results summary](https://www.emergentmind.com/topics/memoryagentbench)
- Upstream README currently says CR dataset construction details are "coming soon", so the
  format specifics above should be re-verified against the code before implementing.

Retrieved 2026-07-27.
