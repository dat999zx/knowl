# Follow-up 4: a file-backed skill cannot retire a different skill, and `supersedes` names the target

Date: 2026-09-28. Found by the R5 second review, pre-existing on `main`, left open. Folded into
branch `fix/issue-165-value-free-restatement` because that branch already changed skill indexing
(`indexSkillPackage` passes `supersedes` for its own stale entry).

## Two defects

**D1. Unrelated skills retire each other.** `indexSkillPackage` (`src/skills/knowledge-index.ts`)
writes through `storeKnowledgeItemDeduped`. Skill titles are package names, and
`sameSubjectTitle` is a token-subset test, so creating `deploy-app-staging` finds `deploy-app` as
a same-subject duplicate and supersedes it. Two packages on disk, one active index entry, and
`recordSkillRun` can no longer find the retired one.

**D2. An explicit `supersedes` loses to a detected duplicate.** `resolveSupersedeTarget`
(`src/store/knowledge-writer.ts` ~line 675) returns the detected duplicate whenever it qualifies,
and only falls back to the explicit id when it does not. A write that names X in `supersedes` but
fuzzy-matches Y retires Y and leaves X active. The caller asked for X.

## Rules

- **D1.** In `resolveDuplicate`, after the `supersedes` check: two `skill` items that both carry a
  `source` and whose sources differ are different skills → `coexist`. Agent-stored skill atoms
  (the two real `skill` supersessions in this repository's store) have no `source` and are
  unaffected; replay to confirm.
- **D2.** In `resolveSupersedeTarget`, an explicit active `supersedes` target wins. The detected
  duplicate is retired only when there is no explicit one. (When the two are the same item nothing
  changes.) Read both writers' call sites and confirm that the `nearDuplicate` / `nearDuplicateId`
  reporting stays correct: a detected duplicate that is no longer retired because an explicit
  target won must be reported as left beside, not silently dropped from the result.

## Tests (each must fail without its code)

1. Index `deploy-app`, then index `deploy-app-staging` → both index entries active.
2. Re-creating `deploy-app` with a changed purpose still retires its own stale entry (the existing
   `tests/skills/knowledge-index.test.ts` case stays green).
3. Two agent skill atoms without `source`, same subject → still superseded as before.
4. D2: seed X ("Cache TTL policy") and Y ("Cache TTL"), write "Cache TTL policy for the API tier"
   (fuzzy-matches one of them) with `supersedes: <the other>.id` → the named one is superseded, the
   other stays active and is reported as `nearDuplicate`.

## Replay

Read-only against `D:/coding/knowl/.knowl/knowl.db`:
- count `skill` supersessions where both sides carry a `source` (D1 would clamp these); expected 0.
- count all `skill` supersessions (2 today, both agent atoms without `source`); D1 must leave them.

D2 cannot be replayed from the store (a retired row does not record which id the writer named),
so it is pinned by test 4 only. Say so in the report.
