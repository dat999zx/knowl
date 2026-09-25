# A write that drops a fact's values must not retire it

Date: 2026-09-25. Recommendation R5 of the #165 red-team report (Adam13y, pinned `2f97ae5`).
Re-verified against `origin/main` at `25ab1f3`.

This is a data-integrity guard, **not** a security boundary. An attacker who includes a false value
instead of dropping the true one is the report's A1 case, and this does nothing about it. What it
stops is the report's N2: a same-subject restatement that asserts nothing false and still erases
the fact. Honest agents produce the same shape when they paraphrase a precise fact into a vague one.

## What is broken

`resolveDuplicate` (`src/store/knowledge-writer.ts:563`) supersedes on a same-subject title and
never compares what the two bodies claim. In the report,

    held:     Nightly database backups are retained for 35 days and encrypted at rest.
    incoming: Nightly database backups are retained for the value documented in the ops runbook
              and encrypted at rest.

retired the held item in 36/36 writes, and "35 days" then appeared nowhere in the top 3 results.
The incoming write is not wrong. It is emptier, and the store trades the value for its absence.

## The rule

> If the held item carries value tokens, and the incoming write drops at least one of them and
> adds none of its own, the two are kept **beside** each other instead of superseding.

Same `coexist` clamp as the polarity guard: nothing is lost, both stay active, and the caller is
told. Applies on every channel. An explicit `supersedes` still wins.

A **value token** is a word from the body — a match of `/[A-Za-z0-9_][A-Za-z0-9_.\/-]*/g`
within a sentence, trailing dots stripped — that is either:
- digit-bearing (`35`, `16`, `eu-central-1`, `v5.23.1`, `1,024`), or
- capitalised and not the first word of its sentence (`PostgreSQL`, `Stripe`, `UTC`, `Vault`).

Tokens are compared case-insensitively. Titles are not inspected: the title is how the subject
match was made, so the claim lives in the body.

## Design

One pure function beside `differsOnlyInPolarity`, and one line in `resolveDuplicate`:

```
export function dropsValuesOnly(incoming: { content: string }, held: { content: string }): boolean
// held values V_h, incoming values V_i
// true when V_h is non-empty, V_i ⊆ V_h, and V_h \ V_i is non-empty
```

`if (dropsValuesOnly(input, duplicate)) return 'coexist';` placed after the polarity guard (and
after R2's channel guard if that lands first; they are independent and order-free).

Sentence splitting reuses the splitter `reversalCueSentences` already uses
(`/(?<=[.!?])\s+|\n+/`), so "first word of a sentence" means the same thing in both places.

## Cost, measured

Replayed over this repo's store (140 real supersessions at measurement time):

| Variant | Real supersessions it would clamp | Report's N2 subjects caught |
|---|---|---|
| Digit-bearing only | **0 / 140** | 6 / 12 |
| Digits + mid-sentence capitals (chosen) | **0 / 140** | 9 / 12 |

The three N2 subjects no variant catches carry their value as ordinary words: "two reviewer
approvals", "always redacted", "reviewed by the data team". Telling those apart needs meaning,
not tokens. That ceiling is stated in the docblock rather than chased with a word list.

## Tests (each must fail with the guard removed)

1. `dropsValuesOnly` unit cases: the backup example → true; a correction swapping `35 days` for
   `90 days` → false (adds a value); a restatement keeping every value and adding prose → false;
   a held item with no value tokens → false; a sentence-initial capital alone
   (`Backups are…` → `Retention is…`) → false.
2. `storeKnowledgeItemDeduped` end to end: the backup pair leaves both active and returns the
   held one as `nearDuplicate`.
3. The existing legitimate-correction tests in `tests/store/supersede-on-write.test.ts` and
   `duplicate-polarity-guard.test.ts` still pass untouched.

Mutation check: drop the "adds none" condition; drop the "drops at least one" condition; count
sentence-initial capitals as values. Each must fail a different subset.

## Out of scope

- Values expressed as plain words (see Cost).
- The raw-ingest merge path. It decides with an AI comparison, not `resolveDuplicate`; R2's spec
  covers its trust gap.
