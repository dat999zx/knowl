# An automatic write must not retire a verified fact

Date: 2026-09-25. Recommendation R2 of the #165 red-team report (Adam13y, pinned `2f97ae5`).
Re-verified against `origin/main` at `25ab1f3`: `resolveDuplicate` and the batch/single writers
are unchanged in any way that matters since the pin.

## What is broken

A same-subject write retires whatever it matches. `resolveDuplicate`
(`src/store/knowledge-writer.ts:563`) never asks where the write came from, so a sentence a
model lifted out of a transcript or a pasted README retires a fact a person verified, exactly as
an agent's deliberate correction would. The report measured this at 216/216 attack writes. After
it, the true fact is `superseded`, `scanContradictions` has nothing to pair it with, and the only
notice goes to the writer.

The report also showed the payload cannot tell the two cases apart: matched attack/correction
pairs differ in none of seven structural fields. **The channel can.** It is chosen by the code
path that calls the writer, not by anything in the atom, so a poisoned text cannot forge it.

### Channels in this tree

| Channel | Entry | Who decides the atom exists |
|---|---|---|
| `knowl_store`, `knowl store`, `knowl decide` | `mcp/tools.ts:651`, `cli/program.ts:2759,2819` | An agent or person, deliberately |
| `knowl_ingest_atoms` | `mcp/tools.ts:739` | An agent, deliberately (it extracted the atoms itself) |
| Plugin `store()` | `plugin.ts:93` | A host agent's tool call |
| Skill index | `skills/knowledge-index.ts:16` | The skill author |
| **Session capture** | `store/candidate-promotion.ts:35` via `session-finalizer.ts` | **Nobody.** Hook-driven, end of session |
| **Transcript approve** | `transcripts/approve-candidates.ts:124` | A model; `--all` promotes up to 1,000 unread |
| **Raw ingest** | `pipeline/merge.ts` via `knowl_ingest` / `knowl ingest` | A model, over arbitrary text |
| **Truth derivation** | `pipeline/derive.ts` (after raw ingest) | A model |

The last four are automatic. The first four are an explicit act by someone who can be held to it.

### A second hole found while tracing: raw ingest bypasses the writer entirely

`runMerge` does not go through `resolveDuplicate`. Its `update` action overwrites the matched
item **in place** (`merge.ts:~85`), and `contradiction` with `autoResolve` supersedes it
(`merge.ts:~115`). Both act on whatever the AI comparison picked, verified or not. The in-place
update is worse than a supersession: the old content is not kept as a superseded row.
`runDeriveTruth` likewise overwrites any active `state` item whose title equals a derived key.

## The rule

> An **automatic** write never retires or overwrites an active item whose provenance is
> `observed` or `user_stated`. It is kept **beside** it instead.

"Kept beside" is the clamp the polarity guard already uses (`coexist`): the new atom is inserted,
the verified one stays active, nothing is lost, and the caller's result names the pair. Both stay
retrievable, so a lie can no longer displace the truth from the served results; at worst the two
are served together.

Direct channels are unchanged. An agent persuaded to call `knowl_store` itself is **not**
covered; the report says so too. That case is left to R1 (visible retirements, Adam's PR) and R3
(exclusivity from the held side, Adam's PR).

An explicit `supersedes` still wins on every channel. No automatic channel sets it today
(`candidateToAtom`, `MemoryCandidate`, the extractor), and the check order in `resolveDuplicate`
stays as it is.

## Design

1. `type WriteChannel = 'direct' | 'automatic'` in `knowledge-writer.ts`.
2. `resolveDuplicate(input, duplicate, held?, channel: WriteChannel = 'direct')`. After the
   polarity guard:
   `if (channel === 'automatic' && isVerified(duplicate)) return 'coexist';`
   where `isVerified` is `provenance === 'observed' || provenance === 'user_stated'`.
3. `storeKnowledgeItemDeduped` and `storeKnowledgeAtomsDeduped` take the channel as a **trailing
   function parameter, not a field on the input**. The MCP handlers build the input from caller
   arguments; a field there would be settable by the very caller it is meant to constrain.
   Default `'direct'`.
4. `candidate-promotion.ts` and `approve-candidates.ts` pass `'automatic'`.
5. `runMerge` takes the channel through `MergeOptions.channel` (default `'direct'`). `runPipeline`
   (raw ingest) always passes `'automatic'`, overriding whatever it was given; `runDecisionPipeline`
   (`knowl decide` with AI configured, `cli/program.ts:2652`) stays direct, because a person typed
   that decision. With `'automatic'`, when the target of an `update` or a `contradiction` is verified, insert the atom
   as a new item and leave the target untouched. Report those ids in a new
   `MergeResult.keptBesideIds`, and surface the count in the `knowl_ingest` / `knowl ingest`
   output next to inserted/updated/superseded.
6. `runDeriveTruth`: skip the in-place overwrite when the existing `state` item is verified.
   A derived truth is recomputable, so skipping it loses nothing.

**Why the default is `'direct'`.** Making the parameter required would touch every test that
calls the writer, for four production call sites that are all named above. The ceiling: a
future automatic channel must remember to pass `'automatic'`. The docblock on the parameter
lists the four automatic channels and says so. `ponytail:` comment at the default.

## Cost, measured on this repo's store (1,214 active, 139 supersessions)

- Every supersession split by channel (first commit message on the superseding item): 129
  direct, 9 session capture, 1 unattributed, 0 ingest, 0 transcript.
- **All 9 capture supersessions retired items with no provenance.** The rule would have blocked
  **0 of 139**.
- Active same-subject pairs where one side is verified and the other `inferred`: **0**.
- Raw ingest has no traffic in this store, so its leg is untested against real writes. Stated in
  the PR, not assumed away.

## Tests (each must fail with the guard removed)

1. `resolveDuplicate`: automatic + held `observed` → `coexist`; automatic + held `user_stated` →
   `coexist`; automatic + held unset → `supersede` (the 9 real cases); direct + held `observed` →
   `supersede` (unchanged); automatic + explicit `supersedes` → `supersede`.
2. `promoteSessionCandidates` end to end: seed an `observed` item, promote a same-title
   candidate with a swapped value → both active, the seed not superseded.
3. `approveCandidates` end to end, same shape.
4. `runMerge` with a stubbed verify result: `update` against a verified item leaves its content
   byte-identical and inserts a new row; `contradiction` + `autoResolve` does not supersede it.
   Both land in `keptBesideIds`. Against an unverified item both behave as today.
5. `runDeriveTruth` does not overwrite a verified `state` item.

Tests 2 and 3 are the report's A1 shape through each automatic entry point; a 12-subject loop
would test the same line twelve times.

Mutation check: delete the guard line; flip `&&` to `||`; drop `user_stated` from `isVerified`.
Each must fail a different subset.

## Out of scope

- **R1, R3.** Adam's PRs.
- **R4, storing the attested channel.** Nothing would read the column yet: this guard needs the
  channel only at write time. Add it when ranking or Cloud writer identity needs it.
- **R5.** Separate spec, `2026-09-25-value-free-restatement-guard.md`.
- Changing what the MCP `knowl_ingest_atoms` path is trusted as. It is an explicit agent call and
  stays direct.
