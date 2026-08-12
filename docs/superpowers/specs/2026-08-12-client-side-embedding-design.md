# Client-side embedding: the client makes the vectors, the server stores them

**Date:** 2026-08-12
**Status:** Design agreed in conversation, not yet reviewed or planned
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
- `profileFingerprint` — provider, model, dtype and pooling together, as `knowl` already computes it (decision `43d9d55f957340fe`). **Not just the model name**: pooling is not discoverable at runtime and a wrong value produces plausible vectors that rank badly with nothing to notice.

The server validates the fingerprint against the workspace profile and stores the vector as given. It runs no model on the publish path.

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

### 5.1 The canary

A fingerprint is a **claim**. Server-side embedding was self-enforcing — whatever clients did, one machine made every vector. Client-side embedding removes that, and a teammate on a stale `transformers.js` build, a different ONNX quantization or the wrong pooling produces vectors that are plausible and rank badly.

So the workspace stores a **canary**: a fixed text and the vector its profile produces. At connect, the client proves it reproduces that vector within tolerance.

**This is a mistake detector, not an attacker defense** — a deliberate framing from the founder:

> "Cloud workspace is user created, trusted. So if user decides to pollute it with wrong model, it's their problem. But we still need to verify and counter most of it — if they try to bypass, it's their problem."

That framing is what makes the verification cheap: it only has to beat accident. A dimension check alone catches gross mismatch and nothing else; the canary catches the silent cases.

### 5.2 Rejection is reported and attributable

A rejected fingerprint fails the CLI push with the reason and the fix, so the user knows to reconfigure. The server records **which repo and which member** sent it.

Attribution matters because the person who errs is not the person who suffers: one member's misconfigured client degrades *everyone else's* search, with nothing to notice. "Search got worse" must be traceable to a cause.

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
- Consume vectors on pull; delete `embedReplica` for on-profile clients (`src/cloud/pull.ts:45,65-75`)
- Surface rejection reasons in the CLI

**knowl-cloud (server):**
- `PublishItem` and the sync contract gain `vector`; validation against workspace profile
- Remove inline embedding from `publishItems`
- Store and serve vectors on the changes feed
- Workspace profile policy: storage, enforcement, canary generation
- Re-embed job for preset changes
- Keep an embedder for queries and web-UI writes only
- Attribution on rejection

---

## 11. Open questions

0. **Does the server keep an embedder at all?** §6 says yes and §6.0 prices it: four unfixable `sharp` CVEs and a heavy dependency, against losing web-UI writes and any reliable way to change a workspace preset. **This is the largest open decision in the document** and it was agreed before the CVE cost was known.
1. **Tolerance for the canary comparison.** Float arithmetic differs across builds and platforms; the threshold needs a real measurement, not a guess. Too tight rejects honest clients; too loose defeats the check.
2. **Does the query path stay server-embedded permanently**, or does the web UI eventually embed in-browser? Server-embedded is right for now (§6) but the browser option removes the last document-adjacent model from the server.
3. **Partial visibility and the replica.** §6.1 assumes a member's replica may be incomplete. Confirm whether workspace visibility rules can actually produce that, since it is the argument against client-side re-embedding.
4. **Batch sizing.** Needs a measurement of payload and transaction time under multi-tenant load, replacing the embedder-derived 200/25.

---

## Appendix: `knowl upgrade`, asked in the same conversation

Unrelated to the above, recorded so it is not lost.

`knowl upgrade` merges missing config defaults, bootstraps the DB schema, refreshes KNOWL.md/AGENTS.md, ensures `.gitignore` covers `.knowl/`, and prints status. `knowl init` is that plus agent registration.

For 5.0 it matters in two places, both already covered: Plan A's migration level 10 reaches existing repos through `bootstrapSchema`, and `upgrade --all` sweeps every repo on the machine. Plan D Task 4 regenerates guidance through it — **rebuild `dist/` first**, or it rewrites the guidance files from a stale build (`699986cdbcaf4565`).

**One acknowledged gap:** the original audit (`6ebc3abb506540f7`) flagged that `init` and `upgrade` do not explain their relationship by name. It was dropped when the 5.0 spec was written and is not in that spec's §11 deferred list. It should be added there.
</content>
