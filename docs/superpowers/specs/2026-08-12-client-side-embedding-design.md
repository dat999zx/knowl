# Client-side embedding: the client makes the vectors, the server stores them

**Date:** 2026-08-12
**Status:** Design agreed in conversation, not yet planned. Reviewed against knowl-cloud's tree 2026-08-12; §4, §5.0, §5.1, §5.2, §10 and §11 revised by that review.
**Repos:** `knowl` (client half) and `knowl-cloud` (server half). **Most of the work is knowl-cloud's.**
**Relationship to 5.0:** Independent. The four command-surface plans stand, with one correction noted in §9.

---

## 1. The goal, in the founder's words

> "I want to cut cost on the server, running thousands of embedding is insanely pricey. Because the client embeds anyway, let them do all the job — we just need to send raw text + vector to store, or vector only to search. This is a system redesign."

Two forces behind it:

1. **Cost.** `publishItems` embeds inline and synchronously inside the request. Every atom any member ever publishes is a forward pass the server pays for.
2. **Multi-tenant damage.** A user can publish hundreds of atoms at once — which is exactly what a *new* workspace does on its first push — and that lags the web app and the engine **for every other tenant**. This is not hypothetical: knowl-cloud fact `f77ce73dcb914744` records a 237-atom publish on 2026-08-11 where the first 200-atom batch OOM-killed the origin and the remainder returned 502. `59d964ba2ac14798` measured 200 atoms of realistic prose at **1564 MB peak, 418 seconds**.

The first experience of the product is the worst case for it.

---

## 2. The discovery that shaped this design

**Clients already re-embed team knowledge locally, and the sync contract carries no vectors at all.**

`src/cloud/pull.ts:45` calls `embedReplica`, which runs `reindexKnowledgeEmbeddings` over pulled rows. Its docblock (`:53-64`) is explicit:

> "The embedder is built from the *project's* config and root, not the replica's, so team rows land in the same vector space as local ones."

Grepping `src/cloud/sync-apply.ts` and `src/cloud/sync-contract.ts` for `embedding` or `vector` returns nothing.

**Three consequences, and they reframe the whole question.**

1. **The "how do members' models match?" problem does not exist today** — and is solved better than pinning would solve it. Every client embeds everything, its own knowledge and the team's, in its own space. Nothing is shared, so nothing must match.
2. **The server's vectors have exactly one consumer: the server's own search** (the web UI, the `/query` endpoint). No client ever reads them.
3. **The same text is embedded many times over.** A ten-person workspace embeds each shared atom eleven times: once by its author, once by the server, and once by each of the nine others. The redundant compute is not only on the server — it is on every laptop, forever.

So the founder's proposal is half of a symmetric win. Vectors should travel **both** ways.

---

## 3. The shape

```
publish:  client embeds -> sends text + vector + fingerprint -> server stores, runs no model
pull:     server returns text + vector                       -> client stores, runs no model
```

Nobody embeds the same text twice, anywhere. `embedReplica` disappears for on-profile clients.

**The price is structural, not a policy preference: everyone in a workspace must be on one embedding profile.** The moment vectors move between machines instead of being made locally, the space has to be shared. This was already the recorded decision (knowl-cloud `d4176ea4604c4daf`: one profile per workspace, enforced in the service layer) — this design makes it load-bearing rather than aspirational.

---

## 4. What changes on the wire

`PublishItem` gains two fields:

- `vector` — **base64 of a Float32Array, not a JSON float array.** 384 dimensions is ~1.5 KB binary and ~4.6 KB as JSON text. At a thousand atoms that is a 2 MB request versus a 5 MB one, for identical data.
- `profileFingerprint` — **five values**: provider, model, dtype and pooling as `knowl` already computes them (decision `43d9d55f957340fe`), plus `recipeVersion`. **Not just the model name**: pooling is not discoverable at runtime and a wrong value produces plausible vectors that rank badly with nothing to notice.

**`recipeVersion` was added 2026-08-12** (knowl-cloud decision `9bb9e2d3714a4e6e`). The four model fields say what *produced* the vector and nothing about what text went *in*. The client builds `buildKnowledgeEmbeddingText`, the server builds `embeddableText`, and a difference in field order, separator, included fields or clip budget yields a different vector from an identical model — invisible to any fingerprint over the model alone.

That divergence is not hypothetical between these two repos. Per `59d964ba2ac14798`, a boundary-only clip returns the **empty string** when the first segment exceeds the budget — an atom of base64, minified JSON or a spaceless stack trace. knowl-cloud fixed it with a mid-segment cut; OSS still has it. For those atoms the two sides do not differ slightly: one of them embeds nothing at all. `recipeVersion` is bumped by any change to the builder and pinned by a fixture test in the style of `SCHEMA_PINS`.

The server validates all five against the workspace profile and stores the vector as given. It runs no model on the publish path.

**The workspace stores the same five values, not the preset name** — see §5.

The sync/pull contract gains the same `vector` field in the other direction.

---

## 5. One profile per workspace, enforced at connect

`knowl cloud connect` compares the repo's resolved profile against the workspace's. On mismatch it **refuses**, names both presets, and offers to switch and reindex:

```
This workspace uses granite-small-en-r2.
This repo uses granite-97m-multilingual.

Vectors are shared with the team, so they must be the same model.

Switch this repo and re-embed 1,240 items?  [~3 min]
```

**A repo connecting to two workspaces with different models is refused, and that is correct.** `config.cloud` is a single object today, so one repo reaches one workspace — but `cloud_published`'s primary key is `(item_id, remote_workspace)` and its comment anticipates multiple. Under this design the rule falls out rather than being imposed: a repo has one profile, so it can join any workspace whose profile matches, and two workspaces with different models cannot both be joined. The only alternative is embedding the store twice, which is the exact duplicated work this redesign deletes.

### 5.0 What the workspace stores

**Five values, not a preset name** — decided 2026-08-12, knowl-cloud `9bb9e2d3714a4e6e`.

`workspace_policy.embedding_preset` exists today and holds a name like `granite-small-en-r2` (`knowl-cloud/src/db/schema/control.ts:94`). A name is only meaningful to whoever owns the table that expands it into provider/model/dtype/pooling — and that table is `knowl/src/core/vector-profile.ts`, the CLI's. Comparing names would mean copying it into the server and keeping it in sync, and per `43d9d55f957340fe` a stale pooling value is exactly the failure that yields plausible vectors ranking badly with nothing to notice.

So the workspace stores the five expanded values and the check is five string comparisons with no lookup anywhere. `embedding_preset` stays as the label the settings page renders. `knowledge_embeddings` already stores the first four (`knowl-cloud/src/db/schema/knowledge.ts:131-135`) and gains `recipe_version`.

### 5.1 The canary — **DEFERRED, not adopted**

A fingerprint is a **claim**. Server-side embedding was self-enforcing — whatever clients did, one machine made every vector. Client-side embedding removes that, and a teammate on a stale `transformers.js` build or a different ONNX quantization produces vectors that are plausible and rank badly.

The proposal was a **canary**: the workspace stores a fixed text and the vector its profile produces, and the client proves at connect that it reproduces that vector within tolerance.

**Deferred out of v1 on 2026-08-12**, on the founder's own framing:

> "Cloud workspace is user created, trusted. So if user decides to pollute it with wrong model, it's their problem. But we still need to verify and counter most of it — if they try to bypass, it's their problem."

*Counter most of it* is what the five-value check already does: it catches every misconfigured preset, which is the accident that actually happens, and `recipeVersion` (§4) closes the text-recipe hole the canary was also covering. What remains uncovered is a client claiming the right profile and producing different vectors anyway — a stale build, a different quantization. Revisit if that is ever observed rather than building for it now.

**If it is adopted later, the canary should be a fixed ATOM, not a fixed text.** Run through the real `buildKnowledgeEmbeddingText`, one comparison then covers model, dtype, pooling *and* recipe together, and it catches a recipe change whose version bump was forgotten. A canary over a bare string never touches the builder and so cannot see the failure §4 describes.

### 5.2 Rejection is reported and attributable

A rejected fingerprint fails the CLI push with the reason and the fix, so the user knows to reconfigure. The server records **which repo and which member** sent it.

Attribution matters because the person who errs is not the person who suffers: one member's misconfigured client degrades *everyone else's* search, with nothing to notice. "Search got worse" must be traceable to a cause.

**The mechanism, settled 2026-08-12 (`9bb9e2d3714a4e6e`): refuse the whole request, not the atom.** HTTP **422**, code `profile_mismatch`, body naming both the expected profile and the received one so the CLI can print the fix in two lines.

Per-atom outcomes would be wrong here. A wrong profile is a property of the *client*, so every item in the batch carries it and per-atom reporting would repeat one identical error N times. `publishItems` already refuses a whole request this way for a detected secret — a 422 that is terminal and never retried in altered form — so this is that existing path with a second code, not a new failure shape.

---

## 6. The server keeps a model, and almost never runs it

Three callers remain:

| Caller | Why it stays server-side |
| --- | --- |
| **Queries** | One short string. Trivial cost, and it saves every browser downloading a ~52 MB model just to search. |
| **Web-UI writes** | Knowledge created in the browser has no client embedder. |
| **Workspace preset changes** | See below. |

Documents published from CLI clients never touch it. That is where the saving lives — the expensive thing was always the corpus, never the query.

### 6.0 The cost of keeping it, which was not visible when §6 was agreed

knowl-cloud goal `9a59f54e52ec4f49` records a benefit this design **forfeits**: removing the server embedder entirely would drop `@huggingface/transformers` and, with it, **four unfixable `sharp` CVEs**.

Keeping a fallback embedder keeps the dependency and keeps those advisories. That is a real trade and it was not on the table when §6 was agreed, so it should be decided deliberately:

| | keep the embedder (§6 as written) | drop it entirely |
| --- | --- | --- |
| Web-UI knowledge creation | works | impossible |
| Owner changes workspace preset | server re-embeds | every member must re-push their whole history, coordinated |
| Query embedding | server-side, browser downloads nothing | browser downloads a ~52 MB model, or queries go client-side only |
| `@huggingface/transformers` + 4 unfixable `sharp` CVEs | retained | **removed** |

The middle row is the load-bearing one: without a server embedder a preset change has no reliable owner (§6.1). Whether the CVEs outweigh that is a judgement call for the founder, not one this document should make silently.

### 6.1 Why a preset change must be re-embedded server-side

When an owner changes the workspace preset, the whole corpus must be re-embedded. A client cannot reliably do it.

It is tempting: a member's replica holds the entire team corpus, so the owner *could* re-embed and push back. But it breaks in the ways that matter for an admin operation — it needs that member to have pulled recently, to have complete visibility rather than partial, and to sit through a long job while the workspace is inconsistent. If they close the laptop halfway, the workspace is stuck in a mixed state with no owner.

Server-side is the only version that is correct regardless of who happens to be around, and it costs almost nothing in practice because it fires only on a deliberate, rare admin action — never on the publish path where the thousands of embeddings actually were.

**This is what justifies keeping the embedder at all.** Without it, an owner could never change the preset without every member re-pushing their entire history, coordinated.

### 6.2 How the reindex actually runs

Decided 2026-08-12 — knowl-cloud `7a0694a083244786`. Constraints set by the founder: it must not lag other tenants, and client sync must keep flowing throughout. Both are largely met by machinery that already exists.

**It runs on the existing queue.** `knowl-cloud/src/knowledge/embedding/queue.ts` is already a single worker taking 16-atom slices round-robin across workspaces, so a workspace re-embedding 5,000 atoms takes turns like everyone else and cannot starve another tenant's publish. The single worker also keeps peak RSS constant (279 MB idle → 448 MB measured) rather than scaling with load.

**One change the queue needs: within a workspace, live indexing jumps the reindex.** Its per-workspace store is a single FIFO array, so a member publishing three atoms mid-reindex would wait behind all 5,000 — hours before their own new note is searchable, in order to repair something merely degraded. Two tiers per workspace; round-robin still governs across workspaces.

**Resume is a query, not a job table.** Rows carry their own profile, so the work list is `WHERE profile <> the workspace's current profile`. The queue is in-memory and a restart drops it — fine for publish indexing, fatal for a reindex, which would otherwise leave a workspace permanently degraded with nobody watching. The server rescans at boot and re-enqueues. No cursor, no state that can disagree with the rows.

**The old vectors keep serving while the new ones build.** The policy holds two profiles, `serving` and `target`. Search, publish validation and the sync feed all filter on `serving`; a preset change writes `target` and leaves `serving` alone. The backfill builds a second generation alongside the live one — a sibling table rather than a `generation` discriminator in the key, so the live read path is untouched — and the swap flips `serving := target` and drops the old generation in one transaction. Before it nothing has changed for anyone; after it, everything has.

**This is what avoids a degradation window, and it was not the first design.** Building in place meant every stored vector stopped matching the declared profile the instant the preset changed, so server-side vector search fell back to `tsvector` **for the whole corpus** until the job finished — and every member had to re-pin immediately, making a preset change a workspace-wide event. With a shadow generation, clients keep validating against `serving`, keep sending old-profile vectors, keep being accepted, and re-pin on their next connect *after* the swap. Storage roughly doubles for the duration — ~1.5 KB per 384-dim vector, so ~150 MB transient at 100k atoms — which is not worth designing around.

**The one complication it introduces: a converging tail.** Atoms published during the window land with `serving`-profile vectors and need `target` rows too, so the backfill generates its own follow-on work. Publishing is far slower than embedding so it converges, but a continuously-publishing workspace could chase it. Bound it: when the remaining count is small, take a short per-workspace advisory lock, run a final catch-up pass, and swap inside it. Publishing blocks for seconds, not hours.

**Sync is unaffected throughout** — the feed sends vectors matching `serving`, which during the window is every live row. This still narrows §3's claim: `embedReplica` does not disappear, it becomes the exception path for a row arriving without a usable vector. That path is now rare rather than being the entire corpus for the duration.

**Also:** per-workspace progress, since `pendingCount()` is global and the settings page needs "1,240 of 5,000"; and a second preset change is refused while one is in flight.

---

## 7. Bulk publish: the constraint inverts

With no embedding, a thousand atoms is a thousand row inserts. Fast — but still worth bounding for a shared database: index maintenance, WAL pressure, one tenant holding a connection while others wait.

**So batching stays, and its sizing changes completely.** `MAX_BATCH` is 200 today because 200 was what the *embedder* could survive — and per `f77ce73dcb914744` it could not, which is why a full-repo publish was guaranteed to collide with it. The new limit is sized by **payload size and transaction time**, and can be considerably larger.

The founder confirmed batching for both the publish path and the bulk case.

---

## 8. Existing published data

knowl-cloud's own ~237 atoms were embedded server-side. If the server's implementation and the client's agree, they are already in the same space and nothing is needed.

**That is an assumption, and the canary is exactly the tool that tests it.** Run it against the live workspace before assuming. If it fails, one server-side re-embed job (§6.1) fixes it.

---

## 9. Correction to the 5.0 plans

**Plan C's `MAX_BATCH = 25` must not be baked in.** That number exists only to dodge the inline-embedding OOM, and this design removes its reason for existing. See `docs/superpowers/plans/2026-08-11-command-surface-5.0-plan-c-automatic-staging.md` Task 4.

Nothing else in the four 5.0 plans is affected. They should ship on their own schedule.

---

## 10. Work split

**knowl (client):**
- Compute and attach `vector` + `profileFingerprint` on publish; base64 encoding
- `knowl cloud connect` profile comparison, refusal, and switch-and-reindex offer
- Canary reproduction check at connect
- Consume vectors on pull; **narrow** `embedReplica` rather than deleting it (`src/cloud/pull.ts:45,65-75`) — per §6.2 it becomes the exception path for rows that arrive without a usable vector, which is what happens to every row of a workspace mid-reindex
- Surface rejection reasons in the CLI

**knowl-cloud (server):**
- `PublishItem` and the sync contract gain `vector`; validation of all five fingerprint fields against workspace profile
- Remove inline embedding from `publishItems`
- Store and serve vectors on the changes feed
- Workspace profile policy: **storage already exists** — `workspace_policy.embedding_preset` (`src/db/schema/control.ts:94`) and the four profile columns on `knowledge_embeddings` (`src/db/schema/knowledge.ts:131-135`). The work is the migration to five expanded values (§5.0) plus **enforcement**. Canary generation is deferred with §5.1.
- Re-embed job for preset changes
- Keep an embedder for queries, web-UI writes and admin re-embeds — as a fallback and an admin tool only (`ac0a658049164d01`)
- Attribution on rejection; 422 `profile_mismatch` (§5.2)

**Already shipped here, so not work:** the `vector` column lost its fixed width in `drizzle/0007_embedding_profile.sql:19`, and `knowledge_embeddings` already carries provider/model/dtype/pooling/dimensions. Notes describing the column as `vector(768)` predate that migration.

---

## 11. Open questions

0. ~~**Does the server keep an embedder at all?**~~ **ANSWERED 2026-08-12** — knowl-cloud decision `ac0a658049164d01`. Yes, but narrowed: **a fallback and an admin tool, never the publish path.** Founder's words: "only as fallback, for direct admin jobs, when client fails… mostly will be client embed, send to server." The narrowing also changes §6.0's pricing — with the model serving only a short query string and a rare admin job, dropping `transformers.js` for `onnxruntime-node` directly (the second escape hatch in `96667505451a4abf`) becomes tractable, so the four CVEs are scoped debt with a known exit rather than the standing cost of the decision.
1. ~~**Tolerance for the canary comparison.**~~ **MOOT** while §5.1 is deferred. It returns with the canary if the canary does.
2. ~~**Does the query path stay server-embedded permanently?**~~ **ANSWERED 2026-08-12** — server-embedded, using **the workspace's profile**, not a profile of the server's own. A human searching the explorer types one short string, so the cost is trivial, where the browser alternative makes every user download a ~52 MB model before their first search. The model leaves the API process only if this *and* the re-embed job (question 0) both move — a later optimization, not a v1 question.

5. **The query endpoint is now the entire model-DoS surface, and its rate limit was not sized for that.** New, and a direct consequence of this design: once publish stops embedding, a search is the only way to make the server run a model. Anonymous flooding cannot reach it — the 2026-08-11 audit moved the authorization check ahead of the embed (`b4aa84771d3f4771` finding 1, pinned by `tests/knowledge/authorization-order.test.ts`) — so the threat is an authenticated member. But `knowl-cloud/src/http/server.ts:64` bounds every caller at a global `max: 300, timeWindow: '1 minute'`, a number chosen when requests were cheap; 300 forward passes a minute per address is not the same proposition as 300 row reads. Metering's `memoryOps: 'throttle'` is a monthly quota, not burst protection. **The query endpoint needs its own limit derived from measured embed cost** — the same rule `60f1eac12b8a48ef` established for the auth group, generalized from cadence to cost. Needs the measurement, like question 4.
3. **Partial visibility and the replica.** §6.1 assumes a member's replica may be incomplete. **Evidence now points the other way:** in knowl-cloud `visibility` is stored per atom (`src/db/schema/knowledge.ts:35`, defaulting to `workspace`) and rides the sync payload (`src/knowledge/sync-hydrate.ts:91`), but grep finds no filter on it in the feed — so replicas may in fact be complete. §6.1's other two arguments (the member must have pulled recently; must not close the laptop mid-job) survive either way. Read `sync-hydrate.ts` properly before relying on either answer.
4. **Batch sizing.** Needs a measurement of payload and transaction time under multi-tenant load, replacing the embedder-derived 200/25.

---

## Appendix: `knowl upgrade`, asked in the same conversation

Unrelated to the above, recorded so it is not lost.

`knowl upgrade` merges missing config defaults, bootstraps the DB schema, refreshes KNOWL.md/AGENTS.md, ensures `.gitignore` covers `.knowl/`, and prints status. `knowl init` is that plus agent registration.

For 5.0 it matters in two places, both already covered: Plan A's migration level 10 reaches existing repos through `bootstrapSchema`, and `upgrade --all` sweeps every repo on the machine. Plan D Task 4 regenerates guidance through it — **rebuild `dist/` first**, or it rewrites the guidance files from a stale build (`699986cdbcaf4565`).

**One acknowledged gap:** the original audit (`6ebc3abb506540f7`) flagged that `init` and `upgrade` do not explain their relationship by name. It was dropped when the 5.0 spec was written and is not in that spec's §11 deferred list. It should be added there.
