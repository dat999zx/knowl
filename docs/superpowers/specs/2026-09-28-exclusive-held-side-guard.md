# An item marked exclusive cannot be retired by an implicit same-subject write

Date: 2026-09-28. Recommendation R3 of the #165 red-team report (Adam13y). Adam has not picked
it up since the 2026-09-25 acceptance, so the maintainers take it. Built on `integrate/issue-165`
(R2 + R5 merged), branch `fix/issue-165-exclusive-held-side`.

## What is broken

`conflictExclusive` is meant to say "only one active answer to this key, and nothing replaces it
by accident". The check that enforces it reads only the **incoming** write:

    src/store/conflicts.ts:39   if (!input.conflictExclusive || !input.conflictKey) return [];

So an exclusive item is protected only from writers that volunteer the same key. A same-subject
write that simply omits the key reaches `resolveDuplicate`, which supersedes on a title match and
never looks at `conflictExclusive`. The report measured it: 36/36 retired with the key omitted,
36/36 refused with it included. The author's mark protects nothing from the one writer it exists
to stop.

## The rule

> An implicit same-subject write never retires an active item marked `conflictExclusive`. It is
> kept **beside** it.

- Same `coexist` clamp as the polarity, channel (R2) and value-free (R5) guards: the new atom is
  inserted, the exclusive item stays active, and the caller gets it back as `nearDuplicate`.
- An explicit `supersedes` naming the exclusive item still wins; it is checked first in
  `resolveDuplicate` and is never second-guessed. That is the one deliberate way to retire it.
- A write carrying the same exclusive key is still refused by `checkKnowledgeConflict`, unchanged.
- Applies on every channel.

**Why clamp, not refuse.** Refusing would throw away a write, which the writer never does for a
payload it cannot judge. Coexisting loses nothing, and R1 (same branch series) lists every
same-subject pair with a verified side, so the pair is visible afterwards.

## Design

One line in `resolveDuplicate` (`src/store/knowledge-writer.ts`), beside the other guards, after
the `supersedes` check:

    if (duplicate.conflictExclusive) return 'coexist';

Both writers (`storeKnowledgeItemDeduped`, `storeKnowledgeAtomsDeduped`) already route through
`resolveDuplicate`, so no caller changes. `conflicts.ts:39` is left as it is: it answers a
different question (may this write carry this key at all), and it is correct for that.

### Paths that do not go through `resolveDuplicate`, checked

- **Session handoff** (`src/session/session-handoff.ts:~375`) marks its `Pending session handoff`
  items exclusive and replaces them through `repo.updateKnowledgeItem` directly. Unaffected.
  Confirm during implementation that no handoff path calls the deduped writers.
- **`runMerge`** decides with an AI comparison, not `resolveDuplicate`. Out of scope here. It is
  reached from raw ingest (automatic channel, where R2 stops it rewriting verified items) **and**
  from `runDecisionPipeline` (`src/pipeline/pipeline.ts:78`), i.e. `knowl decide` with AI
  configured, on the direct channel, where R2 does not apply: a model-judged contradiction or
  update can still retire or rewrite an exclusive item there (`src/pipeline/merge.ts:99,136`).
  Truth derivation (`src/pipeline/derive.ts:90`) likewise rewrites an unverified exclusive `state`
  item in place. Note both gaps in the PR body; the follow-up is `|| beforeItem.conflictExclusive`
  at those checks.
- **`supersedes` with the same key.** The deliberate retire only works from a write that does not
  claim the same exclusive key: `checkKnowledgeConflict` and `repository.ts:213` refuse a same-key
  write while the old item is active, `supersedes` or not. Unchanged here.
- **Explicit `supersede` / `knowl_update`** are deliberate retirements and stay allowed.

## Cost, measured on this repo's store

- Active items marked exclusive: **3** (two `Pending session handoff`, one plan-review state).
- Real supersessions that retired an exclusive item: **1 of 140**, the "Optional transcript search
  plan review status" state item replaced by its successor state. Under this rule the successor
  would have been kept beside it, and the author would retire the old one with `supersedes`.
  Stated in the PR, not hidden.

## Tests (each must fail under one of the mutants below)

1. `resolveDuplicate`: held item `conflictExclusive: true`, incoming same title, no key → `coexist`.
2. Same, with `supersedes: held.id` → `supersede`.
3. Held item not exclusive → `supersede` (unchanged).
4. End to end through `storeKnowledgeItemDeduped`, the report's X1 shape: seed an exclusive item
   with a key, write the same title with a swapped value and no key → seed still `active`, result
   `nearDuplicate.id === seed.id`.
5. Same end to end through `storeKnowledgeAtomsDeduped` (the batch path).
6. The existing `tests/store/import-exclusive-conflict.test.ts` and
   `tests/store/batch-write-integrity.test.ts` still pass unchanged.

Mutation check: delete the guard; move it before the `supersedes` check; move it before the
verbatim no-op check; widen it to `duplicate.conflictKey`. Each must fail a different test (the
last two are pinned by an exact-restatement `no-op` test and a keyed, non-exclusive held item).

## Out of scope

- Making `checkKnowledgeConflict` look at held items. It is the key-collision check, not the
  supersession check.
- Changing how session handoffs are replaced.
