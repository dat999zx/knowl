# Follow-up 3 on visible retirements (R1): say whether a listed retirement still stands

Date: 2026-09-28. The R1 reviewer's finding 4, left open. Branch
`feat/issue-165-visible-retirements`, now based on `fix/issue-165-write-channel-guard` (R2).

## What is wrong

A `retired` row keeps showing `replacedBy: B` for 14 days even after someone has undone the swap
(stored the correct fact again with `supersedes` naming B, so B is itself superseded). A reader
sees a live-looking swap that is already fixed and may "fix" it a second time.

## Rule

`replacedBy` carries the replacement's `status` (`active`, `superseded`, …), and rows whose
replacement is no longer `active` are **kept** but sorted after the ones whose replacement is
still active. Do not drop them: a chain A → B → C where C re-asserts A's value and a chain where
C doubles down on B's lie look the same from here; the reader needs to see both.

- `contradiction-scan.ts`: `VerifiedParty` for `replacedBy` gains `status: KnowledgeStatus`
  (add it to `RetiredVerified.replacedBy` only; do not change `sameSubject`'s parties, which are
  always active). Sort: replacement `active` first, then newest `retiredAt` first within each group.
- Update the `knowl_conflicts` MCP description sentence about retirements: "each with what
  replaced it and whether that replacement is still active".

## Tests (each must fail without its code)

1. Seed `observed` A; swap to B (same title); then store C with `supersedes: B.id` → A's row
   lists `replacedBy.status === 'superseded'`.
2. Two retirements, one whose replacement is still active and one whose replacement was since
   superseded, with the undone one newer → the still-active one sorts first.
3. The existing newest-first test still passes when both replacements are active.

Mutants: drop the status field; drop the active-first sort key.
