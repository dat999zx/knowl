# Follow-ups 1 and 2 on the exclusive held-side guard (R3)

Date: 2026-09-28. Two gaps the R3 reviewer confirmed and left open. Same branch
`fix/issue-165-exclusive-held-side`, now based on `fix/issue-165-write-channel-guard` (R2), which
provides `runMerge`'s channel guard and `keptBesideIds`.

## F1. `knowl decide` with AI, and truth derivation, can still retire or rewrite an exclusive item

`runMerge` (`src/pipeline/merge.ts`) decides with an AI comparison and never calls
`resolveDuplicate`, so the R3 guard does not reach it. On the direct channel (`knowl decide` with
AI configured, via `runDecisionPipeline`) an `update` rewrites an exclusive item in place and an
auto-resolved `contradiction` supersedes it. `runDeriveTruth` (`src/pipeline/derive.ts`) rewrites
an exclusive `state` item in place.

**Rule.** Same as R3: an exclusive item is never retired or rewritten by these paths, on any
channel. The atom is added beside it.

- `merge.ts`, both guards (the `update` branch ~line 99 and the `contradiction` branch ~136):
  `if ((channel === 'automatic' && isVerifiedProvenance(beforeItem)) || beforeItem.conflictExclusive) {`
  The existing body (insert beside, push to `keptBesideIds`, `continue`) is unchanged. Update the
  `keptBesideIds` doc comment to "Verified items an automatic atom, or exclusive items any atom,
  would have rewritten or retired, left untouched."
- `derive.ts` ~line 90: skip the overwrite when `existing.conflictExclusive` too.

**Tests** (each must fail without its line):
1. `runMerge` direct channel, `update` against an exclusive item: content unchanged, new row
   inserted, id in `keptBesideIds`.
2. `runMerge` direct channel, `contradiction` + `autoResolveContradictions` against an exclusive
   item: not superseded, id in `keptBesideIds`.
3. `runMerge` direct channel against a non-exclusive unverified item: still updated in place.
4. `runDeriveTruth` does not overwrite an exclusive (unverified) `state` item.

## F2. `supersedes` cannot retire an exclusive item from a replacement that claims the same key

The two exclusive-key checks refuse any active holder of the key, including the one the write
names in `supersedes`, which is about to be retired in the same transaction:
- `checkKnowledgeConflict` (`src/store/conflicts.ts`), called first by `storeKnowledgeItemDeduped`.
- the in-transaction check in `repo.createKnowledgeItem` (`src/store/repository.ts` ~line 213),
  which both writers reach.

So the one deliberate way R3 leaves to retire an exclusive item fails for the natural correction:
"the database is now X", carrying the same exclusive key. The CHANGELOG currently has to warn
about it.

**Rule.** Both checks ignore exactly the active item named by `supersedes`. Nothing else changes:
a second holder that is not named is still refused.

- `checkKnowledgeConflict(input)`: accept `supersedes?: string` on its input and drop that id from
  the returned rows.
- `createKnowledgeItem`: thread the `supersedes` id in without it becoming a column. Read the
  function first; pick the smallest route (an optional trailing parameter is fine). Both writers
  pass `input.supersedes` / `atom.supersedes`.
- Then remove the CHANGELOG and spec caveat added in `9e62e31` ("from a write that does not claim
  the same exclusive key …") and say the correction may carry the same key.

**Tests:**
5. Single writer: seed exclusive key K; write with key K and `supersedes: seed.id` → succeeds,
   seed `superseded`, new item active holding K.
6. Batch writer: the same through `storeKnowledgeAtomsDeduped`.
7. Still refused: seed exclusive key K; write with key K and `supersedes` naming some *other*
   active item → `KnowledgeConflictError`.
8. `tests/store/import-exclusive-conflict.test.ts` and `batch-write-integrity.test.ts` unchanged
   and green.

## Out of scope

`sameSubject` visibility for these pairs is R1's; this branch does not depend on R1.
