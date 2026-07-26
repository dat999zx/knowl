# Multi-Repo Workspace Design

**Date:** 2026-07-26

**Status:** Draft — revised through two review rounds. Round one: three Claude subagents against
the original draft. Round two: Codex `gpt-5.6-sol` at maximum reasoning effort against the
revision. Every finding cited below was re-verified against source before being acted on.

## Problem

Knowl memory is bound to one repository. `.knowl/knowl.db` sits at the project root and the
project scope is *implicit from the database location* (decision `af65b0bb73ec4f10`). That was
the right call for a single repo and it is wrong for the way people actually work.

A product is rarely one repo. `DuckPrep-server`, `DuckPrep-web`, and a shared `protocol`
package are three checkouts of one system. A decision recorded in the server repo about a wire
format is invisible to an agent working in the web repo. The agent re-derives it, gets it
subtly wrong, and writes a contradicting fact into the *other* database — where no conflict
detection can ever see it, because conflict detection only looks inside one file.

**The ask:** let a user choose several repos and link them into one knowledge base, so agents
can work across repos.

**The end state this document commits to:** one shared database that linked repos read and
write, with a single owning repo and an explicit visibility per item. That is v2 below. v1 is a
smaller, behaviorally inert
increment that is independently useful and that de-risks v2 — it is a stepping stone, not a
substitute, and shipping v1 without v2 would not satisfy the request.

## What review changed

The first draft of this document was reviewed against the source by four independent passes.
Five of its load-bearing claims were false. They are recorded here because each one changed the
design, and because "the mitigation exists" is the kind of claim that must not be re-assumed.

| Draft claim | Reality | Design consequence |
| --- | --- | --- |
| A `repo` label on each result mitigates cross-repo confusion | `compactKnowledgeItem` (`src/core/token-budget.ts:25-36`) is a hard allowlist — `id, category, title, content, freshness, confidence, tags`. Every MCP result passes through it (`response-format.ts:6`, `tools.ts:744`). `affectedPaths` is not in the shape at all, and the `namespace` label layered queries already attach is silently dropped | The label must be added to the compact shape and asserted on the *serialized* output, or the feature's primary safety property does not exist |
| Storage resolution can be intercepted in one place | The DB path is derived in **three** independent places: `database.ts:21`, `namespaces.ts:12`, `snapshots.ts:17`. Worse, `queryLayeredKnowledge`'s `descriptors = defaultNamespaces(root)` default is used by `context-composer.ts:17`, so `knowl_query` and `knowl_context` would read different databases | A single `resolveStorage()` with named roles is a prerequisite, and the config-free default argument must be deleted |
| Qualifying paths as `@slug/path` is a contained change | `hashKnowledgeContent` (`freshness.ts:20-38`) hashes `affectedPaths` into `content_hash`. Qualification changes every affected item's hash, which breaks `classifyIncomingItem` (`import-policy.ts:15-21`), defeats the verbatim adoption that makes re-import idempotent (2.3.0), and stops `queryLayeredKnowledge`'s content-hash dedup from ever collapsing the same fact recorded in two repos | **Path qualification is cut entirely.** Paths stay repo-relative; repo identity lives beside the item, never inside its content |
| The symbol index collides on shared path names | `indexCode` (`symbol-index.ts:156-157`) deletes **every** `code_files` row not in the current root's file set. In a shared DB, indexing repo B wipes repo A's entire index, not just colliding names | Far larger than described. The code index is removed from the shared database entirely (see below) |
| Bootstrap can create the attribution table only when a workspace exists | `bootstrapSchema(client)` (`bootstrap.ts:521-532`) receives a libSQL client and nothing else, and runs on every open | Tables are created unconditionally. The regression contract is restated as behavioral, not structural |

A second round, against the revised document, found that the revision had traded five wrong
claims for one wrong *model*. `knowledge_item_repos` was being used to mean three different
things at once — where an item came from, who may mutate it, and where it applies — and most of
the v2 contradictions followed from that conflation. The data model below separates them.

| Second-round finding | Reality | Design consequence |
| --- | --- | --- |
| Logical scope is implied by which database an item is in | In `shared` mode the project and workspace namespaces resolve to the same file, so "repo-only" and "workspace-wide" become indistinguishable for visibility, conflicts, dedup, export, and GC | Scope is persisted on the item as `visibility`, independent of database path |
| Keeping the code index and sessions "local" is a placement decision | Both use the ambient connection (`symbol-index.ts:155`, `session-repository.ts:25`). Redirecting `initDb` sends them into the workspace database, and the migration then renames the file they were supposed to live in | Three named connection roles must exist before P2/P3 |
| Forbidding auto-injection of foreign knowledge is a policy statement | Recent context, pinned constraints, and work-loop bootstrap all do unscoped ambient reads (`context-bootstrap.ts:27`, `context-composer.ts:19-20`, `work-loop.ts:106`). In `shared` mode they see the whole workspace | Current-repo filtering is a required parameter on every implicit read path, not a convention |
| v1 federation is read-only | Every namespace open runs `bootstrapSchema` (`database.ts:33`), and every query writes access telemetry (`agent-query.ts:243`). Querying a peer migrates and mutates it | Peer opens are read-only with bootstrap suppressed; foreign-item telemetry is dropped in v1 |
| A `repo` label on results is enough provenance | After a federated query the peer connection is gone. Evidence and staleness are evaluated against the *current* repo (`tools.ts:740`) and `knowl_update` takes a bare item id (`tools.ts:798`), so item-scoped tools silently answer about the wrong repo | Item-scoped operations carry `(repo, itemId)`; in v1 they refuse foreign items rather than computing a wrong answer |
| Renaming each local database protects old clients | An old client opens `<repo>/.knowl/knowl.db`, finds nothing there, and creates a **fresh** database — never meeting the version guard. Partial renames are outside the per-import transaction | The canonical path is never renamed. Migration is journalled, copies rather than moves, and flips mode last |
| One embedding per item is fine | Repos may configure different vector models; the schema stores one embedding row per item (`schema.ts:124`) and search filters by provider and model (`vector.ts:86`), so mismatched items are invisible | The workspace pins one embedding identity; `add` refuses a mismatch, `migrate` re-embeds |
| Category-driven routing at the MCP surface is sufficient | Synthesis, promotion, and the pipeline write below that surface and would bypass it; mixed `knowl_ingest_atoms` batches have no defined destination | Routing moves below every write surface, and batch writes report a per-atom destination |

A third round, against that revision, found that separating origin from visibility had created
contracts the document then stated inconsistently, and that the portability layer cannot carry
the new fields at all.

| Third-round finding | Reality | Design consequence |
| --- | --- | --- |
| Visibility, applicability, and mode each had one meaning | The document said foreign repo-private items are never returned in one place and readable in another, and called the applies-to set rank-only in one place and filtering in another | One matrix, stated once. `visibility` moves into the prerequisites so v1 and v2 share one rule |
| Only the origin repo may mutate an item | `knowl_update` was also described as able to change another repo's item. Worse, `storeKnowledgeItemDeduped` looks up a likely duplicate across the whole database and can supersede it (`knowledge-writer.ts:202-236`), so an ordinary write in one repo can retire another repo's item | Ownership is absolute; duplicate detection is scoped to the writing repo |
| Migration is safe because it is journalled | Repos stay writable while being exported and imported, and mode was to be flipped across a manifest *and* every repo's config — so a write after export vanishes, and a crash leaves mixed modes | Write fence per repo, snapshot at the fence, and mode stored **only** in the manifest so activation is one atomic write |
| Export/import can carry promotion and retirement | `content_hash` covers title, content, reasoning, source, and paths only. Equal hashes classify as `identical` and are skipped entirely (`import-policy.ts:15-21`, `portability.ts:130`), so status, freshness, supersession, origin, and visibility never converge | A separate lifecycle fingerprint, compared alongside `content_hash`, with metadata-only updates that leave `content_hash` verbatim |
| Tombstones make deletes converge | Import plans an insert without consulting local tombstones, and the tombstone upsert overwrites `deleted_at` unconditionally (`portability.ts:193-207`) — a stale export resurrects a newer delete, and an old tombstone rewinds a newer one | Tombstones are consulted before planning inserts and only ever move forward in time |
| Merging repos collapses duplicate knowledge | Import matches on **id** (`portability.ts:116-118`), and ids are random per repo. Nothing collapses | Corrected. Same-content items from two repos both survive under different owners; collapsing is a retrieval-time concern |
| `gc undo` can restore a purge | The commit records only the base item (`gc.ts:219`); cascades take assertions, evidence links, telemetry, skill steps, and embeddings with it | Purge is disabled outright in a workspace. Archive and compress remain |
| Adding two FTS columns is a schema edit | The FTS table and its triggers are `CREATE ... IF NOT EXISTS` (`bootstrap.ts:33-41`), so new columns are silently ignored on every existing database | A versioned drop, recreate, and backfill under the `user_version` guard |
| Telemetry belongs to the `local` role | `knowledge_access` has a same-database foreign key to `knowledge_items` (`schema.ts:76-79`), so it cannot reference items in another file | Telemetry follows the `knowledge` role, not `local` |
| Scoping three bootstrap paths covers implicit reads | `knowl_state`, `knowl_recent`, MCP resources, and synthesis are all still broad. `synthesizeKnowledge` reads every item (`synthesis.ts:34`) and would re-emit another repo's private content as new workspace-visible architecture | Every read surface is enumerated and scoped; synthesis inherits its sources' most restrictive visibility |

The first round also found four hazards the original draft did not mention at all: `listKnowledgeItems` accepts a
`projectId` and **ignores it** (`repository.ts:336-341`), so GC's candidate set is every
member's knowledge; there is no schema version marker anywhere in the tree, so an older client
cannot refuse a newer shared database; `resolveEmbedder` derives its config root from
`getProjectRoot()` (`write-embedding.ts:28-33`) and returns `null` on failure, so writes to any
non-project namespace get **no embedding, silently**, which under vector-first ranking
(`agent-query.ts:17-18`) makes them structurally unrankable; and `withDbPath` mutates
module-level globals across `await` points, so two concurrent queries in one MCP process can
file one query's writes into the other's database.

## Verified starting facts

Every row checked against source. Corrections from review are folded in.

| Fact | Location | Consequence |
| --- | --- | --- |
| DB path `<root>/.knowl/knowl.db` is derived in three independent places | `database.ts:21`, `namespaces.ts:12`, `snapshots.ts:17` | Redirection requires one shared resolver, not one edit |
| The DB handle is a module-level singleton; `withDbPath` closes and reopens, mutating four globals across `await` points | `database.ts:12-55` | Not async-reentrant. `getClient()` reads the mutated global at call time, so an interleaved `run()` can write to the wrong database. A mutex over the pointer does not fix this |
| `initDbPath` defaults `projectRoot` to `dirname(dirname(dbPath))` | `database.ts:25` | Only valid for the `<root>/.knowl/x.db` layout. A workspace DB elsewhere yields a nonsense root, which is what breaks embeddings |
| Namespaces exist with precedence and content-hash dedup, but `queryLayeredKnowledge` is precedence-ordered concatenation with a trailing `slice(limit)` — not fusion — and passes only `{query, limit, surface}` | `namespaces.ts:46-70` | `category`, `status`, `tags`, `explain` are dropped. A session item always outranks a more relevant project item |
| Layering is bypassed when vector search is on (default), and also by `explain` and `asOf` | `tools.ts:708-711`, `tools.ts:734`, `config.ts:20-27` | Namespace layering is effectively dead code for default configs today. Enabling it activates the dropped filters above |
| `hashKnowledgeContent` includes `affectedPaths` in the fingerprint | `freshness.ts:20-38` | Any rewrite of stored paths changes item identity, breaking import classification and dedup |
| `indexCode` deletes every `code_files` row absent from the current root's file set; `code_symbols.file_path` REFERENCES `code_files(path)` with CASCADE; `PRAGMA foreign_keys = ON` | `symbol-index.ts:152-158`, `schema.ts:133-148`, `bootstrap.ts:5` | A shared code index is destroyed by the next index run from any other member |
| `listKnowledgeItems(projectId)` ignores `projectId` and selects the whole table | `repository.ts:336-341` | Any scoping built on it is a no-op. GC, integrity, and synthesis all inherit this |
| `duplicateKey` is `category + normalized title + normalized content`, repo-blind; the purge branch is not gated by `isHot`; `fact`, `state`, `goal` are unprotected | `gc.ts:54-80`, `gc.ts:126-144` | In a shared DB, the same fact legitimately recorded twice is a duplicate, and one copy is hard-deleted |
| Purge writes a tombstone that propagates through export/import | `repository.ts:379-391`, `portability.ts:193-207` | A cross-repo GC deletion travels to teammates' machines |
| No schema version marker exists anywhere (`user_version`, `schema_version`: zero matches) | tree-wide | An old client silently opens a newer shared DB, sees `CREATE TABLE IF NOT EXISTS` succeed, and proceeds |
| `migrateLegacyProjectSchema` toggles `PRAGMA foreign_keys = OFF`, renames, copies and drops tables — outside a transaction, on every open | `bootstrap.ts:407-515` | On a shared DB this is N processes' concurrent startup path |
| `resolveEmbedder` uses `getProjectRoot()`, `loadConfig(root)`, and `<root>/.knowl/models`; failure returns `null` silently | `write-embedding.ts:20-40` | Writes to a non-project namespace are stored without embeddings and cannot compete under vector-first ranking |
| `compactKnowledgeItem` is a hard allowlist; `affectedPaths` and `namespace` never reach the agent | `token-budget.ts:25-36`, `response-format.ts:6`, `tools.ts:744` | Any per-item provenance must be added here explicitly |
| Write transactions use deferred `BEGIN`; `importKnowledge` classifies *before* opening its transaction | `portability.ts:163`, `snapshots.ts:74`, `portability.ts:116-184` | Read-modify-write without version checks. `busy_timeout` does not retry `SQLITE_BUSY_SNAPSHOT` and does not prevent lost updates |
| `restoreSnapshot` does `DELETE FROM knowledge_items` then reinserts | `snapshots.ts:74-89` | Run from one member against a shared DB, it rolls back every member's knowledge and passes the integrity audit |
| `exportKnowledge` exports every item in the active DB and packages skill directories from the writing root | `portability.ts:29`, `portability.ts:43` | `knowl export` from one member would leak the whole workspace |
| `findProjectRoot` walks **up** to the first `.knowl` directory | `config.ts:67-84` | A repo nested inside another member resolves to the outer root: wrong attribution, wrong session binding |
| Every namespace open runs `bootstrapSchema`, including legacy migration | `database.ts:33`, `bootstrap.ts:407-515` | Reading a peer database migrates it. There is no read-only open |
| `queryKnowledgeForAgent` writes access telemetry for every result | `agent-query.ts:243` | Reading a peer writes to the peer |
| Sessions, code index, host bindings, and telemetry all use the ambient connection | `session-repository.ts:25`, `symbol-index.ts:155` | They follow whatever database was last opened, not a chosen role |
| `composeContext` reads pinned constraints with an unscoped `queryKnowledgeBase`, and passes `undefined` descriptors to `queryLayeredKnowledge` | `context-composer.ts:19-20` | Implicit context assembly ignores namespaces entirely and would pull every repo's constraints |
| `getRecentContext` and `startWorkLoop` read ambient with no scope | `context-bootstrap.ts:27`, `work-loop.ts:106` | Session bootstrap auto-injects whatever the active database holds |
| `knowledge_embeddings` holds one row per item; vector search filters by provider and model | `schema.ts:124-131`, `vector.ts:86-91` | An item embedded with one repo's model is invisible to a repo configured with another |
| `knowl_update` accepts a bare item id; evidence staleness is evaluated against the current `projectRoot` | `tools.ts:798`, `tools.ts:740-743` | Item-scoped operations have no repo dimension |
| `storeKnowledgeItemDeduped` finds a likely duplicate across the whole database and may supersede it | `knowledge-writer.ts:202-236` | An ordinary write in one repo can retire another repo's item |
| Import matches existing rows by **id**, not content | `portability.ts:116-118` | Merging two repos' databases collapses nothing; ids are random per repo |
| `classifyIncomingItem` returns `identical` on equal `content_hash` and the plan skips it entirely | `import-policy.ts:15-21`, `portability.ts:130` | Status, freshness, supersession, and any new column never propagate |
| The tombstone upsert overwrites `deleted_at` unconditionally, and inserts are planned without consulting tombstones | `portability.ts:193-207`, `portability.ts:130-131` | Deletes are not monotonic; a stale export resurrects them |
| The FTS table and its three triggers are `CREATE ... IF NOT EXISTS` | `bootstrap.ts:33-41`, `bootstrap.ts:165-184` | New FTS columns are silently ignored on every existing database |
| `knowledge_access` has a same-database foreign key to `knowledge_items` | `schema.ts:76-79` | Telemetry cannot live in a different file from the items it references |
| `synthesizeKnowledge` reads every item in the database | `synthesis.ts:34` | Synthesis would launder another repo's private content into new shared knowledge |
| GC records only the base item as the before-image; delete cascades take assertions, evidence links, telemetry, skill steps, and embeddings | `gc.ts:219`, `schema.ts:34,60,70,78,92,125` | A purge is not undoable from the commit log |
| `resolveSymbolEvidence` resolves against the ambient connection's `code_symbols` | `evidence-repository.ts:145-160` | Foreign symbol evidence would be judged against the wrong repo's index |
| The export header is `version: 1` | `portability.ts:31` | Any new persisted field needs a format bump |
| Skill atoms carry `source`/`affectedPaths` pointing at `<root>/.knowl/skills/...`, matched by exact `source` equality | `skills/knowledge-index.ts:21,33-38` | A shared skill atom refers to files that do not exist in the reading repo |
| `host_session_bindings` keys on `(host, project_root, external_session_id, external_turn_id)` | `schema.ts:108-122` | Already multi-root safe. Do not "fix" it |
| `canonicalProjectRoot` lowercases on Windows only | `project-path.ts:16-19` | Reuse it for every root-keyed identifier or Windows splits one repo in two |
| `.knowl/` is added to `.gitignore` on init | `gitignore.ts` | A cloned repo normally cannot carry workspace config onto a user's machine |
| `externalNamespace` already refuses a namespace DB inside the project directory | `namespaces.ts:20-28` | Reuse this guard for the workspace descriptor |
| Import classifies `new`/`identical`/`divergent` by `content_hash` with a resolution policy, and adopts divergent winners verbatim to keep re-import idempotent | `import-policy.ts`, `portability.ts:174-184` | Migration can reuse shipped machinery — but only if item identity is left alone |
| `getProjectByRootPath` returns a synthetic `{id: 'local'}`; `projectId` is vestigial | `repository.ts:97-99` | Do not build attribution on `projectId` |
| Item ids are the first 16 hex of a UUIDv4 (~2^60, one nibble is the fixed version) | `repository.ts:27` | Merging databases will not collide in practice |
| WAL and `busy_timeout = 5000` are set | `bootstrap.ts:5-7` | Survivable, but tuned by guess and insufficient for the actual failure modes |

## Approach

### Considered

**One physical database, many repos.** The literal ask, and the only shape where cross-repo
`knowl_update`, conflict detection, and dedup work — all three are single-database operations
today. Costs: attribution on every item, a code index that must be removed or re-keyed,
mandatory migration, multi-process writers on one file, and a version-skew surface.

**Federation — every repo keeps its database, reads fan out.** No migration, no lock
contention, no schema change, and repo identity is free because it is implied by *which
database a result came from*. But you cannot supersede a stale decision living in another
repo's file, conflict detection stays blind, and "one knowledge base" is a fiction maintained
at query time.

### Decision

Ship both, in order, as one feature with one vocabulary.

**v1 is federation.** Linked repos read each other's project databases. Two additive columns
(P9) and no data movement.
Fully reversible by deleting a manifest. It delivers "my repos can see each other" — the
majority of the day-to-day value — and it forces every hard *retrieval* problem (labels
surviving compaction, fusion across corpora, per-repo caps, silent-failure visibility) to be
solved before any *storage* problem is created.

**v2 is the shared database.** A workspace database that linked repos read and write, with
per-item ownership and visibility. This is the ask. It is gated on v1's retrieval work plus the
prerequisites
below, because every one of them is a correctness precondition rather than a nicety.

The first draft ordered these the same way but scoped v1 as "workspace DB as a namespace, writes
in Phase 2" — which would have shipped an empty database nothing could write to. That defect is
what makes federation-first the honest first increment rather than a relabelling.

## Vocabulary

Two user-facing words: **workspace** and **repo**.

A workspace is a named set of repos that share knowledge. A repo has a **name** (the stable
identifier, `[a-z0-9][a-z0-9-]*`). Not "member", not "slug". Write routing rides the existing
`namespace` parameter — `workspace` becomes a fifth value alongside `session`, `project`,
`organization`, `global` — rather than introducing a parallel `scope` axis that would interact
undefinedly with it.

"Workspace" collides with npm workspaces (one repo, many packages — the opposite meaning) and
with editor workspaces. No better single noun exists, and the user's own framing was "link
repos", so the collision is accepted and the docs say plainly what a Knowl workspace is not.

## Prerequisites

These are correctness preconditions. Each is independently valuable, each is a separate PR, and
none of them mention workspaces.

**P1 — One embedding identity, before layering can span anything.** `fc6171e` settled the
ordering here, and this document previously had it wrong: it treated embedding identity as a v2
workspace concern and the layering bypass as an independent P1. It is the reverse dependency.
`searchKnowledgeEmbeddings` filters on provider and model, and that filter is load-bearing
because cosine similarity across different dimensions is meaningless. A namespace embedded with
a different model returns zero rows — so removing the bypass without a shared embedding identity
trades one silent narrowing for another.

`fc6171e` chose disclosure over a wrong fix: the reply now names the skipped namespaces rather
than letting scope narrow quietly. That disclosure is the marker for this work, and it is
removed when the identity exists — not before.

So: one embedding identity (provider, model, dtype), pinned per workspace and recorded in the
manifest, is the first prerequisite. `workspace add` refuses a repo whose vector config differs
and offers to align it; `migrate` re-embeds anything that does not match; `doctor` reports
drift. Changing the pinned model is a workspace-wide re-embed and is a v3 command.

**P2 — Retrieval parity, then enable layering.** Give `queryLayeredKnowledge` full parameter
parity (`category`, `status`, `tags`, `explain`, vector) and a test asserting equivalence with
the direct path, *then* remove the bypass at `tools.ts:791`. Order matters: enabling first
activates a path that silently ignores `status` and `category` filters. This also fixes a live
bug — the `organization` and `global` namespaces are dead code for every default-config user
today.

`asOf` is no longer part of this. `fc6171e` gave it its own retry-without-category path and
deliberately keeps access recording off it, since logging time-travel reads would make stale
items look hot and shield them from GC. Leave that branch alone.

**When a repo is skipped, disclose it the way `fc6171e` already does:** a second content block,
leaving the first block a bare JSON array so existing callers are unaffected, and the
`configuredNamespaces` lookup wrapped in `try`/`catch` so a misconfigured optional entry cannot
fail an otherwise good query. This design previously said skips must be "reported, not
swallowed" without saying how; there is now a shipped pattern and it should be followed rather
than reinvented.

**P3 — Named connection roles, one resolver.** Today there is one ambient database and
everything uses it. A workspace splits it, so the roles must be named before anything moves:

| Role | Always resolves to | Holds |
| --- | --- | --- |
| `local` | `<repo>/.knowl/knowl.db` — **never** redirected | Code index, host session bindings, drift watermarks, caches |
| `session` | `<repo>/.knowl/session.db` | Session namespace, unchanged |
| `knowledge` | The project database, or the workspace database in `shared` mode | `knowledge_items` and **everything keyed to it, including access telemetry** |
| `workspace` | `<workspace-dir>/knowl.db`, writable | `linked` mode's shared-scope writes. In `shared` mode this is the same connection as `knowledge` |
| `peer` | Another repo's `knowledge` database, opened read-only | Federated reads only |

Telemetry follows `knowledge`, not `local`, because `knowledge_access` has a same-database
foreign key to `knowledge_items` (`schema.ts:76-79`) and cannot reference rows in another file.
`linked` mode needs a separate writable `workspace` role because its shared-scope writes go
somewhere the `knowledge` role does not point.

`resolveStorage(root, config) → { local, session, knowledge, peers[] }` replaces the three
independent path derivations (`database.ts:21`, `namespaces.ts:12`, `snapshots.ts:17`). Delete
the `descriptors = defaultNamespaces(root)` default argument so no call site can silently get
the unconfigured set — `context-composer.ts:19` currently relies on it, which is what would
split `knowl_context` from `knowl_query`.

The `local` role is why the canonical path is never renamed and why the code index survives
`shared` mode without a composite key. Before estimating this, enumerate every
`getProjectRoot()` consumer and classify it as *where the database is* or *which repo I am in* —
they are about to stop being the same thing, and this is where the schedule slips.

**P4 — Explicit connections, and a read-only open.** Thread a connection handle through the
query path so `getClient()` is never consulted for a namespace operation, and cache connections
by resolved path instead of closing and reopening. A mutex over a shared mutable "current
database" pointer does not fix the interleaving, because `run()` bodies read the pointer after
the switch.

Add a read-only open mode that suppresses `bootstrapSchema`. Without it, federation is not
read-only in any sense: every namespace open runs the full bootstrap including
`migrateLegacyProjectSchema`, so merely *querying* a peer migrates its database. Peer opens use
it unconditionally.

This is also a straight win today: every namespace query currently closes and reopens the
database twice.

**P5 — Provenance survives compaction.** Add `repo` to `CompactKnowledgeItem`, populated
whenever a workspace is active, and add `affectedPaths` where the budget allows. Test the
**serialized** `compactMcpJson` output, not the in-memory item — the compaction boundary is
where provenance dies.

**P6 — Schema version guard, shipped in a release *before* workspaces.** Set `PRAGMA user_version`
and refuse to open a database whose version exceeds what this client understands. Wrap
`migrateLegacyProjectSchema` in a transaction. Without this, the first old client to open a
shared database defeats every mitigation in v2 — its `CREATE TABLE IF NOT EXISTS` succeeds, it
sees nothing missing, and it proceeds.

The guard is also what makes the FTS change possible. `knowledge_items_fts` and its three
triggers are `CREATE ... IF NOT EXISTS` (`bootstrap.ts:33-41`, `bootstrap.ts:165-184`), so
adding columns to the declaration is a silent no-op on every existing database. Adding them
requires a versioned drop, recreate, and backfill from `knowledge_items`, gated on
`user_version` so it runs exactly once.

**P7 — Embeddings follow the database, not the process.** Carry an explicit config root with
the connection instead of deriving it from `getProjectRoot()`, and add a regression test that a
write to a non-project namespace produces a `knowledge_embeddings` row. Today that write
silently produces none, and vector-first ranking then makes it unretrievable.

**P8 — Honest scoping in the repository layer.** `listKnowledgeItems(projectId)` accepts a scope
argument and ignores it. Replace the signature with `listKnowledgeItems(filter?: { repos?: string[] })`
— the vestigial `projectId` carries no information (`getProjectByRootPath` returns a synthetic
`{id: 'local'}`), and `repos` is the scoping that will actually be needed. Leaving a parameter
that looks like scoping but is not is a trap for every workspace call site added later; GC is
the one that bites.

**P9 — Ownership and visibility columns, before either version ships.**

```sql
ALTER TABLE knowledge_items ADD COLUMN origin_repo TEXT;                      -- NULL = not in a workspace
ALTER TABLE knowledge_items ADD COLUMN visibility  TEXT NOT NULL DEFAULT 'repo';
```

The revised draft put these in v2 and called v1 "zero schema change". That produced the
contradiction the third round found: v1 had no way to express "this item is private to my repo",
so linking necessarily shared everything, while the document elsewhere promised repo-private
items are never returned across repos.

Visibility is a property of the item, not of the storage topology, so it belongs in both
versions or neither. Adding it here also means `promote` and category-driven routing work in v1,
which is what makes v1 a usable product rather than an all-or-nothing switch.

**The slogan is dropped, the guarantee is not.** v1 is no longer "zero schema change". It is
still behaviorally inert for a project with no workspace: `origin_repo` stays NULL, `visibility`
stays `'repo'`, and every query returns what it returns today.

`workspace add` backfills `origin_repo` for every existing row in the joining repo's database —
a single `UPDATE` on a database the user is explicitly linking, at the one moment when the
answer is unambiguous. Without the backfill, every pre-existing item would be ownerless, which
means unfilterable, unlabelled, and immune to the ownership rules below.

## v1 — linked repos read each other

### Where things live

A workspace lives **outside every repo**, at `~/.knowl/workspaces/<name>/` by default —
`os.homedir()`, overridable by a `KNOWL_HOME` environment variable and per-workspace by
`--path`. (`KNOWL_HOME` does not exist in the source today; `src/profile/` is empty and the
profiles design that referenced it was never implemented. This feature introduces it.)

```
~/.knowl/workspaces/duckprep/
  workspace.json        # the manifest — authoritative repo list (v1)
  knowl.db              # the shared knowledge database (v2)
  migration.json        # migration journal, present only during migrate (v2)
```

Each linked repo keeps its own directory unchanged:

```
<repo>/.knowl/
  config.json           # gains a pointer to the workspace
  knowl.db              # the `local` role — NEVER moved, renamed, or redirected
  session.db            # the `session` role — unchanged
  skills/  models/  cache/  snapshots/
```

| Mode | Knowledge lives in | `<repo>/.knowl/knowl.db` holds |
| --- | --- | --- |
| No workspace (today) | `<repo>/.knowl/knowl.db` | Everything |
| v1 federation | Each repo's own `knowl.db`; reads fan out | Everything, as today |
| v2 `linked` | Both — repo-scoped in the repo, workspace-scoped in `workspaces/<name>/knowl.db` | Repo-scoped knowledge, plus code index, sessions, host bindings, telemetry, watermarks |
| v2 `shared` | `workspaces/<name>/knowl.db` only | Code index, sessions, host bindings, telemetry, watermarks — and retired knowledge tables kept as the rollback artifact |

The workspace database must be outside every repo, which `externalNamespace`
(`namespaces.ts:20-28`) already enforces for external namespaces and which this reuses. It must
also not be on a network or cloud-synced folder — WAL needs working advisory locks and `-shm`
coordination, and `workspace init` refuses when a runtime probe says it does not have them.

Nothing needs a new `.gitignore` entry: the workspace is outside the repos, and `.knowl/` is
already ignored.

The manifest:

```jsonc
{
  "version": 1,
  "name": "duckprep",
  "minKnowlVersion": "2.4.0",
  "repos": [
    {
      "name": "server",
      "path": "D:/coding/DuckPrep-server",   // machine-local, may be absent
      "git": { "remote": "git@github.com:acme/duckprep-server.git" }
    }
  ]
}
```

`minKnowlVersion` guards the *manifest* format and is separate from P5's `PRAGMA user_version`,
which guards the *database*. v1 has no shared database, so only the manifest guard applies; v2
needs both.

Repo **name** is canonical identity. Not the path (differs per machine and checkout), not the
git remote (absent for local repos, plural for forks). `path` is machine-local and *optional*:
a manifest copied to a second machine resolves paths there via `knowl workspace join`, which
matches by git remote where available and prompts otherwise. This is what makes the manifest
portable, and portability is what makes the feature usable by a second developer or a second
machine — the case the first draft omitted entirely.

Names are immutable. Renaming is `remove` plus `add`; a transactional rename command was cut.

### Two-sided membership

A repo is linked only when **both** the repo's `.knowl/config.json` names the workspace and the
manifest lists that repo. Neither half suffices.

This makes linkage un-forgeable by a cloned repository: `.knowl/` is gitignored, so a hostile
repo normally cannot ship config at all, and even if a user un-ignores and commits it, the
manifest outside the repo does not list them. `knowl workspace add` additionally requires
explicit confirmation when `.knowl/config.json` is tracked by git.

`workspace add` rejects a path nested inside an existing linked repo, or containing one.
`findProjectRoot` walks upward to the first `.knowl`, so a nested repo silently resolves to the
outer root — wrong attribution, wrong session binding. Rejecting the topology is cheaper than
detecting the consequences.

### Retrieval

Reads fan out across linked repos' **project** databases. There is no workspace database in v1.

- Repo identity is free: a result's repo is the database it came from.
- Fusion is rank-based across corpora, because BM25 scores from different databases are not
  comparable — they depend on each corpus's term statistics. Reuse `RRF_K` from
  `agent-query.ts:7`; do not restate the constant.
- **No weights and no boosts in v1.** This repo justifies retrieval changes with checked-in
  ablations (`docs/evals/`); three simultaneous tunables landing without a dataset cannot be
  evaluated. Extending the eval set with cross-repo cases is a v1 deliverable, and weights are
  a follow-up justified by it.
- Per-repo candidate caps, applied *after* filtering, never before — cap-then-filter can return
  zero local results when a chatty linked repo fills the window.
- Ties break toward the current repo. That is not a tunable, and it is the whole of the
  local-preference behavior in v1.
- Every item carries `repo` through to the serialized response (P5).
- Linked repos that are absent from this machine are skipped, and the skip is *reported*, not
  swallowed. `queryLayeredKnowledge` currently discards errors for optional descriptors, which
  makes "absent" and "empty" indistinguishable — the exact ambiguity behind the support
  question this feature will generate most.

**Skills do not cross repos.** A skill atom points at files under the writing repo's
`.knowl/skills/`, and `recordSkillRun` matches on exact `source` equality. A shared skill atom
would list a skill whose `SKILL.md` does not exist locally, or — worse, on a name collision —
run the wrong entrypoint. `category: 'skill'` is excluded from cross-repo retrieval. This is a
stated limitation, not an oversight.

### v1 is read-only across repos — enforced, not promised

Writes always go to the local repo. Cross-repo `knowl_update` would mean mutating a peer through
the ambient-singleton path — the exact interleaving hazard P3 exists to remove, for a capability
the shared database delivers properly in v2.

"Read-only" is not automatic. Two shipped behaviors write to whatever database is open:

- **Bootstrap on open.** Peer connections use P3's read-only mode with bootstrap suppressed. A
  peer whose schema is older than this client is reported by `doctor` and skipped, never
  migrated — migrating another repo's database as a side effect of reading it is not something
  a user can consent to at query time.
- **Access telemetry.** `recordKnowledgeAccessBestEffort` fires for every result
  (`agent-query.ts:243`). Foreign results are **excluded** from it in v1. Writing it to the peer
  violates read-only; writing it locally is blocked by `knowledge_access`'s foreign key to
  `knowledge_items`, and a second local table for foreign telemetry is not worth building for
  one release. The cost is explicit: retrieval heat and `knowl_feedback` do not accumulate for
  foreign items in v1. It does not affect GC, because foreign items are only ever collected by
  the repo that owns them.

**Item-scoped operations refuse foreign items in v1.** `knowl_timeline`, `knowl_evidence_list`,
`knowl_feedback`, and `knowl_update` take a bare item id and resolve it against the current
database; evidence staleness is evaluated against the current `projectRoot` (`tools.ts:740`).
Left alone, they would answer confidently about the wrong repo. Each returns a clear refusal
naming the owning repo instead, and `knowl_query` omits the `evidence`/`stale` fields for
foreign items rather than computing them against the wrong filesystem. Wrong answers are worse
than absent ones here.

This is the honest boundary of federation, and it is the concrete reason v2 is required rather
than optional: conflict detection, dedup, and supersede are single-database operations, and v1
does not make them work across repos.

### MCP surface

No new tools. The agent-facing list is already 25 entries and each addition costs every agent
context on every session.

| Tool | Change |
| --- | --- |
| `knowl_query` | Optional `repos: string[]` filter; every returned item carries `repo` (v1). `explain: true` reports per-repo reached / skipped / candidate counts (v1) |
| `knowl_state` | A workspace section listing the workspace name, mode, and linked repos (v1) |
| `knowl_context` | Never auto-injects knowledge from another repo. Foreign knowledge is returned only when explicitly queried (v1) |
| `knowl_store` / `knowl_decide` / `knowl_ingest_atoms` | `namespace: 'workspace'`, defaulted by category (v2) |
| `knowl_update` | Refuses any item this repo did not originate, in **both** versions, naming the owning repo |
| `knowl_skill_*` | Unchanged. Skills never cross repos |

### The visibility matrix

Three fields decide what a query returns, and they were previously described inconsistently in
different sections. This is the single statement; nothing elsewhere overrides it.

| Item | Query from its own repo | Query from another linked repo | Under `repos: ["<its repo>"]` from elsewhere |
| --- | --- | --- | --- |
| `visibility = 'repo'` | Returned | **Never returned** | **Never returned** |
| `visibility = 'workspace'` | Returned | Returned, labelled with its `repo` | Returned |
| Listed in the applies-to set of another repo | — | Ranks higher in that repo's unfiltered queries | Unchanged — the set never adds or removes results |

The rule is identical in v1 and v2. That is the reason `visibility` moved into the
prerequisites: it is a property of the item, and making it depend on which version you are
running is how the two contradictory sentences got written in the first place.

- **`repo` on a returned item is its `origin_repo`** — the one repo that produced it and owns
  it. Singular, always present when a workspace is active, and it survives to the serialized
  payload (P5).
- **`repos: string[]` is a hard filter on `origin_repo` alone.** `repos: ["server"]` from the
  web repo returns only what the server repo produced and marked workspace-visible. "What does
  the server repo know about auth?" must not be diluted by items that merely claim to apply
  there.
- **The applies-to set only boosts ranking.** It never adds or removes results, in any mode,
  under any filter. Keeping the filter on one field is what makes a result set explainable.
- **The unfiltered default** is the current repo's items at any visibility, plus
  `visibility = 'workspace'` items from linked repos. Ties break toward the current repo.
- **Names, not opaque ids.** The identifier appears in every result, in the filter an agent has
  to type, in guidance text, and in CLI output, so it is `server`, not `r_7f3a9c`. An agent
  writing `repos: ["server"]` is far likelier to be correct than one writing an opaque handle,
  and Knowl's retrieval is already tuned around imperfect agent wording.

### Names are owned, and stay owned

A name is not just a label — it is the ownership key on every item that repo produced, so a name
that changes hands silently transfers knowledge.

- Names are immutable. Rename is `remove` plus `add`.
- `workspace remove <name>` **refuses while that repo still owns items in the workspace**, and
  names the two ways out: `--transfer-to <repo>` reassigns ownership in one transaction, or
  `--export-first` writes them out before removal. Neither is a default.
- A removed name is recorded in the manifest's `retiredNames` and cannot be reused. Otherwise
  adding a different repo under an old name would silently adopt whatever that name still owns
  — including rows an interrupted `remove` left behind.

Now that path qualification is cut, a true rename is an `UPDATE` across `origin_repo`, the
applies-to table, tombstones, the denormalized repo in commit payloads, the FTS shadow columns,
and the manifest — six places and one JSON rewrite, but no `content_hash` involvement. Cheap
enough to reconsider in v3, not cheap enough to ship untested.

### Observability

Shipped in v1, not deferred, because every failure mode of query-time fan-out is silent:

- `knowl status` gains a workspace block (today it prints one `Repository:` line).
- `knowl doctor` gains a workspace section: manifest reachable, repos present or missing,
  version agreement, nesting violations, guidance freshness per repo.
- `knowl_query` with `explain: true` reports per-repo reached / skipped / candidate counts.

Repo names are shown by default; absolute paths only under `--verbose`, matching the existing
decision to keep resolved roots out of routine output.

### Agent guidance

The MCP `instructions` block does not reach subagents — this project probed it and documented
the finding (`knowl-guidance.ts:120`), which is why `KNOWL_SUBAGENT_BOOTSTRAP_CARD` exists.
Workspace guidance therefore goes into `renderFullKnowlGuidance()` (the managed `KNOWL.md` /
`AGENTS.md` section) and the subagent card, and `knowl upgrade` must refresh guidance in every
linked repo. One line: knowledge from another repo is labelled with its repo name and applies
*there* unless it says otherwise. The README's published token-overhead table must be updated
rather than quietly invalidated.

### CLI

```
knowl workspace init <name> [--path <dir>]
knowl workspace add [<path>] [--name <repo-name>]
knowl workspace join <manifest-path>
knowl workspace list
knowl workspace status
knowl workspace remove <repo-name> [--transfer-to <repo> | --export-first]
knowl workspace promote --category <list> | --id <id>...
```

v2 adds `migrate [--repo <name>] [--apply]`, `unlink`, and `--migrate` on `add`. `promote` is v1,
because `visibility` is (P9) and sharing existing decisions is most of what makes v1 useful.

`knowl init` offers to join a workspace already registered for a sibling path — a registry
lookup, not a filesystem scan. (The first draft listed filesystem scanning as a non-goal while
describing discovery; registry lookup is the resolution.)

`remove` unlinks a repo from the workspace. It never deletes knowledge in v1 — there is no
shared store for it to delete from — and the v2 behavior is specified explicitly rather than
implied by a `--keep-knowledge` flag.

## v2 — the shared database

### Storage

A workspace database at `<workspace-dir>/knowl.db`, added as a namespace with precedence
between `project` and `organization`, reusing `externalNamespace`'s existing guard that a
namespace database may not live inside a project directory.

Two modes:

- **`linked`**: the repo keeps `.knowl/knowl.db`, and reads fuse *both* v1's peer fan-out and
  the workspace database. Repo-scoped knowledge stays in each repo and is still readable across
  repos; cross-cutting knowledge lives in the workspace database where supersede and conflict
  detection work.
- **`shared`**: the repo's project namespace resolves to the workspace database via
  `resolveStorage` (P3). One database for knowledge, so there is nothing to fan out to. The
  local database stays at its canonical path serving the `local` and `session` roles — code
  index, host bindings, telemetry, watermarks — and its retired knowledge tables are the
  rollback artifact.

v1's fan-out is therefore not throwaway work: it is `linked` mode's read path. The only piece
v2 changes is which descriptors are constructed.

Mode is set at `workspace init` / `add`. A runtime `mode` switch command is cut: `shared → linked`
has no defensible answer to "which items come back", and an asymmetric toggle is worse than no
toggle.

### Three questions, three fields

The revised draft used one junction table to answer three different questions, and nearly every
v2 contradiction came from that. They are separated:

| Question | Field | Cardinality |
| --- | --- | --- |
| Which repo produced this, and which repo owns its lifecycle? | `origin_repo` on `knowledge_items` | Exactly one, immutable |
| Is this repo-only or workspace-wide? | `visibility` on `knowledge_items` — `'repo'` \| `'workspace'` | Exactly one, mutable |
| Which other repos does this apply to? | `knowledge_item_repos` | Zero or more, advisory |

`origin_repo` and `visibility` ship in P9, ahead of v1. Only the advisory table is new here:

```sql
CREATE TABLE knowledge_item_repos (          -- applies-to, advisory only
  knowledge_item_id TEXT NOT NULL REFERENCES knowledge_items(id) ON DELETE CASCADE,
  repo_name         TEXT NOT NULL,
  PRIMARY KEY (knowledge_item_id, repo_name)
);
CREATE INDEX idx_knowledge_item_repos_name ON knowledge_item_repos(repo_name);
```

**`origin_repo` is the only lifecycle key.** Freshness, drift, `version`, `affected_paths`,
GC, export, tombstones, and supersede are all item-global mutable state, so they must be owned
by exactly one repo. A many-to-many key cannot scope them: drift computed in repo A would stale
an item repo B also claims, and a GC run in A would delete it out from under B. Everything that
mutates an item is keyed to `origin_repo`, and a repo may only mutate items it originated.

**Ownership is absolute, and write-time dedup is where it will be breached.**
`storeKnowledgeItemDeduped` finds a likely duplicate across the entire database and, on a
`supersede` resolution, retires it (`knowledge-writer.ts:202-236`). In a shared database an
ordinary `knowl_store` in the web repo could retire a server-repo item — no cross-repo intent,
no warning, and the write reports success.

`46596c7` widened this. Supersession is now gated on `sameSubjectTitle` — one title's
significant tokens being a subset of the other's — rather than an exact title match, and its own
worked example is "Database is SQLite" against "Project database uses SQLite". Across two repos
of one product that is not an edge case, it is Tuesday.

The same commit also supplies the fix. `resolveDuplicate` already has a third outcome,
`coexist`: insert, leave the other active, and tell the caller what it was left beside. So the
rule is not to narrow detection but to clamp resolution:

- **Detection may span repos.** Learning that the server repo holds an overlapping item is
  exactly the signal a cross-repo workspace exists to provide. Scoping detection to the writing
  repo would throw it away.
- **Resolution never crosses an ownership boundary.** When the detected duplicate has a
  different `origin_repo`, the outcome is forced to `coexist`, whatever `resolveDuplicate`
  would otherwise return — including an explicit `supersedes` id naming a foreign item, which
  is refused for the same reason `knowl_update` refuses one.
- **The `nearDuplicate` report carries the repo.** The existing message already tells the agent
  which item it was left beside and how to retire it; for a foreign item it names the owning
  repo and says the retirement must happen there.

`checkKnowledgeConflict` follows the same shape: a conflict key held by another repo's item is a
*reported* conflict, never an automatic supersede.

An agent that finds a stale fact in another repo records that finding in its own repo and names
the other; it does not reach across and edit. Cross-repo correction needs a review step this
design does not have, and inventing one here would be scope creep on an already large feature.

**`visibility` persists logical scope independently of the database path.** This is what makes
`shared` mode coherent: when the project and workspace namespaces resolve to the same file, the
file no longer tells you whether an item was meant to be private to its repo. Without the
column, repo-only and workspace-wide items are indistinguishable to visibility filtering,
conflict detection, dedup, export, and GC — and `shared` mode silently becomes "everything is
shared", which is a different product than the one specified.

**`knowledge_item_repos` is advisory.** It boosts and filters retrieval — "this decision also
applies to `web`" — and nothing else reads it for a lifecycle decision. It may be populated
manually or left empty; an empty table degrades retrieval slightly and breaks nothing. Because
it is advisory, it can be deferred past v2 without blocking anything.

Tombstones and `CommitChange` payloads carry `origin_repo` denormalized, because
`ON DELETE CASCADE` removes attribution before a delete-notification consumer could filter on
it. The payload is already a rewritable JSON snapshot (`stripProjectFields`, `bootstrap.ts:199`).

All of this is created unconditionally — `bootstrapSchema` receives only a client and cannot
know whether a workspace exists. `origin_repo` and `visibility` are also added to
`knowledge_items_fts` as `UNINDEXED` columns so filtering happens inside the search rather than
after it, with the three FTS triggers (`bootstrap.ts:165-184`) updated accordingly.

In a non-workspace project `origin_repo` is `NULL` and `visibility` is `'repo'` for every row,
which is exactly today's behavior.

### Implicit reads must be scoped, structurally

Auto-injected context must never contain another repo's knowledge. Three shipped paths would
violate that the moment `shared` mode redirects the knowledge role: `getRecentContext`
(`context-bootstrap.ts:27`), `composeContext`'s pinned-constraint read
(`context-composer.ts:20`, an unscoped `queryKnowledgeBase` for every active constraint), and
`startWorkLoop`'s bootstrap query (`work-loop.ts:106`).

The fix is a required parameter, not a convention: every implicit read takes a repo scope and
there is no default. Implicit reads resolve to `origin_repo = <current>` only — *not*
`visibility = 'workspace'`. Workspace-wide knowledge from another repo is available through an
explicit `knowl_query`, where it arrives labelled and the agent has asked for it. Silently
widening what lands in an agent's context at session start is how a linked repo turns into an
injection channel.

Scoping three bootstrap paths is not enough — every read surface has to be enumerated, because
the ones that are missed are exactly the ones nobody thinks of as retrieval:

| Surface | Today | Scoped to |
| --- | --- | --- |
| `getRecentContext`, `composeContext` pinned constraints, `startWorkLoop` | Unscoped ambient | `origin_repo = <current>` |
| `knowl_state` | Whole database | Current repo, plus a separate workspace section naming the other repos without quoting their content |
| `knowl_recent` | Whole database | `origin_repo = <current>` |
| MCP resources | Whole database | `origin_repo = <current>` |
| `synthesizeKnowledge` | Reads every item (`synthesis.ts:34`) | Current repo's items only |

Synthesis is the dangerous one. It reads the whole table, merges what it finds, and writes a new
`architecture` item — so under category-driven routing it would take another repo's private
content, blend it, and publish the result as workspace-visible. Sources are restricted to the
current repo, and the synthesized item inherits the **most restrictive** visibility among its
sources: any `repo`-visibility source makes the output `repo`-visibility, regardless of category.

### Paths and item identity stay exactly as they are

**`affected_paths` stays repo-relative and `content_hash` is untouched.** Path qualification
was the first draft's mechanism and it is cut: because `hashKnowledgeContent` folds
`affectedPaths` into the fingerprint, qualifying paths would change item identity, break
`classifyIncomingItem`, defeat verbatim adoption, and stop content-hash dedup from ever
collapsing the same fact recorded twice. Attribution beside the item does the same job without
touching identity — and it also removes slug-in-path traversal, the rename-rewrite problem, and
the `@`-smuggling surface in `normalizeAffectedPaths`.

Drift and freshness scope by `origin_repo`: a git diff in one repo is matched only against items
that repo originated, so a path that exists in two repos can no longer cross-match. This is the
concrete reason lifecycle state is keyed to a single owner rather than to the advisory
applies-to set.

**This narrows decision `af65b0bb73ec4f10`, it does not reverse it.** That decision removed
*redundant* metadata: when one database means one project, `project_id` carries no information.
When a database holds several repos, origin and visibility are information. The narrowing is
recorded as a superseding decision in Knowl.

### The code index leaves the shared database

`code_files`, `code_symbols`, and `code_symbol_edges` are **not** shared. `indexCode` deletes
every row absent from the current root's file set, so any index run from any repo destroys
every other repo's index — and re-keying it means a composite primary key, a matching composite
foreign key on `code_symbols`, a locator format change breaking four consumers
(`symbol-index.ts:175`, `drift.ts:67-70`, `evidence-repository.ts:48,159-160`) plus already-persisted
`evidence.locator` rows, and a full table rebuild that `CREATE TABLE IF NOT EXISTS` cannot
express.

That is a feature-sized project for an index of files on one machine — inherently local data.
In `shared` mode the code index remains in the repo-local database, which continues to exist for
exactly this purpose and for `session.db`. Cross-repo symbol search is a v3 candidate, not a
v2 obligation.

**Evidence staleness follows the owning repo, or returns unknown.** This is a direct consequence
of the split. Symbol evidence resolves against `code_symbols` on the ambient connection
(`evidence-repository.ts:145-160`), and that index now lives in each repo's `local` database;
file evidence needs the owning repo's filesystem root. Evaluating either from the wrong repo
produces a confident, wrong answer — almost always "stale", because the file or symbol is
genuinely absent here.

So staleness is computed only for items the current repo owns. For a foreign item it is
`unknown`, never `stale`, in both versions and both modes — including when the owning repo is
checked out on this machine, because resolving it would mean opening that repo's `local`
database mid-query for a field the agent did not ask for. A `stale` flag that is wrong is worse
than one that is absent: it tells an agent to go re-verify knowledge that is perfectly current.

### Writes

`namespace: 'workspace'` on `knowl_store` / `knowl_decide` / `knowl_ingest_atoms`. No `scope`
parameter — that would give one tool two scoping axes whose interaction is undefined.

**The default is category-driven**, not "always repo". In a workspace: `decision`, `constraint`,
`architecture`, and `goal` default to `workspace`; `fact`, `state`, and `skill` default to the
repo. `skill` never crosses.

The first draft defaulted everything to `repo` and attached a suggestion to promote. An agent
does not act on advice returned by a call that already succeeded — the write returned OK and the
subtask is finished. That default would have starved the shared brain while appearing to work.
The category rule serves the motivating example directly (a wire-format *decision*), is one
sentence in a tool description, and is overridable in both directions.

**Routing lives below every write surface.** A single `routeWrite(atom, context) → { visibility,
originRepo }` sits in `knowledge-writer`, beneath the MCP tools — because synthesis
(`synthesis.ts`), candidate promotion (`candidate-promotion.ts`), and the extraction pipeline
(`pipeline/merge.ts`) all create items without passing through a tool handler. Routing
implemented at the MCP layer would be bypassed by every one of them, and the resulting items
would land with a default `visibility` nobody chose.

**Batch writes report per-atom destinations.** A `knowl_ingest_atoms` batch may contain a
decision and three facts, which category routing sends to different destinations. The batch is
partitioned by destination and each partition is written in its own transaction; the response
lists every atom with its destination and status. A partition that fails does not roll back the
others — that is the partial-failure semantic, stated rather than avoided. Rejecting mixed
batches outright was the alternative and it is worse: it pushes the agent into per-atom calls,
which is what `knowl_ingest_atoms` exists to prevent.

### Migration and rollback

`knowl workspace migrate` reuses the shipped import machinery, and **never renames the canonical
local database**:

1. Dry-run by default. Per repo: items, divergences, resulting `origin_repo` and `visibility`,
   embedding re-work required.
2. Write a journal at `<workspace-dir>/migration.json` recording each repo's state —
   `pending` → `fenced` → `exported` → `imported` → `done`. The journal, not the filesystem, is
   the source of truth.
3. **Fence the repo before reading it.** A `migrating` marker in its `knowl_meta` makes every
   knowledge write fail with a message saying migration is in progress. Without the fence a
   write landing between export and activation is simply lost: it goes into a database that
   stops being read the moment mode flips, and nothing reports it. The fence is per repo and
   short-lived, so the other repos stay fully usable.
4. **Copy, do not move**, from a snapshot taken at the fence: export the repo's knowledge and
   import it into the workspace, setting `origin_repo`, routing `visibility` by category, and
   re-embedding anything that does not match the pinned embedding identity. Item identity and
   `content_hash` are untouched, so this is idempotent and safe to re-run — the journal says
   where to resume.
5. Mark the repo's local knowledge retired in `knowl_meta`, bump its `user_version`, and lift
   the fence. The database stays exactly where it was, still serving `local` and `session`.
6. **Activate by writing the manifest, once.** Mode lives **only** in `workspace.json`; a repo's
   `config.json` records which workspace it belongs to and nothing about mode. Activation is
   therefore a single atomic file write after every repo reports `done`, and there is no state
   in which some repos are `shared` and others are not. The revised draft flipped mode across
   the manifest *and* every repo's config, which is a multi-writer cutover with no atomicity —
   a crash midway left exactly the mixed-mode state that has no recovery procedure.
7. Report the rollback command.

`promote` and `unlink` use the same journal for the same reason: both move items between
databases in `linked` mode, and a crash halfway through either one is otherwise unrecoverable.

The revised draft renamed each local database to `knowl.db.pre-workspace`, which defeats the
version guard it depends on: an old client opening `<repo>/.knowl/knowl.db` would find nothing
there and create a **fresh** database, never encountering the guard, and then write knowledge
into a file nothing reads. Leaving the file in place with a bumped `user_version` is what makes
the old client refuse. Partial renames were also outside the per-import transaction, which the
journal now covers.

### Linking a repo that already has knowledge

The expected case. A greenfield workspace over empty repos is the rare one, and the design has
to be good at the common path rather than the clean one.

**Linking in v1 moves nothing.** `workspace add` writes a manifest entry and a config pointer.
The repo's database is not opened for writing, not migrated, not touched. Its existing knowledge
becomes visible to the other linked repos on the next query, and unlinking restores the previous
state exactly, because there was no previous state to restore.

**Migrating at workspace creation.** `knowl workspace migrate` is the journalled copy described
above: every repo's knowledge is copied into the workspace database with `origin_repo` set and
`visibility` routed by category.

**A repo that joins after the workspace is already in `shared` mode** needs the same treatment
for itself alone: `knowl workspace add --migrate`, which is `knowl workspace migrate --repo <name>`
run as part of the join. Without it the repo would flip to the shared knowledge database while
its own history stayed behind in a file nothing reads any more — the single most likely way for
a user to conclude their memory was deleted. `add` refuses to set `shared` mode for a repo with
un-migrated local knowledge unless `--migrate` or an explicit `--discard-local` is given.

**Correction: merging repos does not collapse duplicates.** An earlier revision of this document
said identical items collapse by `content_hash`. They do not. Import matches existing rows by
**id** (`portability.ts:116-118`), and ids are random 16-hex per repo, so two repos that
independently recorded the same fact produce two rows with different ids that both survive.
`--on-divergence` never engages, because there is no id collision to adjudicate.

That is the right behavior — each repo genuinely did record it, and each copy keeps its own
owner, evidence, and history — but it means a migrated workspace contains real duplicates.
Collapsing them is a retrieval concern, handled by the existing content-hash dedup in
`queryLayeredKnowledge` and by extending it to `conflict_key`, not a migration concern. The
migration dry-run reports the count so the number is not a surprise.

**Backfilling existing knowledge into the shared scope.** In `linked` mode, migration is not
what a user wants — repo-scoped knowledge should stay in its repo. But the motivating story is a
wire-format decision *that already exists*, and category-driven routing only applies to future
writes. Without a backfill, linking would share nothing a team has already learned.

```
knowl workspace promote --category decision,constraint,architecture   # dry-run by default
knowl workspace promote --id <item-id>...
```

`promote` ships in **v1** — `visibility` exists from P9, and backfilling existing decisions is
most of what makes v1 worth using. The rest of this section is v2.

`promote` sets `visibility = 'workspace'` on selected items the current repo originated. It is a
one-column update, so it does not touch `content_hash`, does not create duplicates, and does not
move rows between databases in `shared` mode. In `linked` mode it copies the item into the
workspace database by the same import path as `migrate` and retires the local copy. Dry-run
prints the affected titles; only the originating repo may promote its own items; and per open
question 5, there is no `demote` — retracting knowledge other repos have already read needs a
mechanism this design does not have.

`knowl workspace unlink` un-retires the local knowledge tables and flips mode back. Copy-back is
*not* a bespoke flag: it is `knowl export --repo <name>` from the workspace followed by
`knowl import` into the local database — shipped, tested machinery with a divergence policy.
The revised draft's `--copy-back` had undefined behavior for an item claimed by two repos;
`origin_repo` removes the ambiguity, because exactly one repo owns each item.

`knowl workspace remove <name>` in v2 leaves that repo's knowledge in the workspace by default
and prints the export command to retrieve it. It never deletes.

### Portability must carry lifecycle, and deletes must only move forward

Two shipped behaviors in `portability.ts` make the new fields non-convergent, and both have to
change before `promote`, `unlink --copy-back`, or any cross-machine workspace export can work.

**Metadata-only changes are invisible to import.** `content_hash` covers title, content,
reasoning, source, and paths. Equal hashes classify as `identical` (`import-policy.ts:15-21`)
and the plan skips the item entirely (`portability.ts:130`). So promoting an item to
workspace visibility, retiring it, superseding it, or marking it stale changes nothing an
export can carry — the receiving side keeps its old copy and the two never converge.

The fix is a second fingerprint, not a wider `content_hash`. Widening it would change every
existing item's identity and break the verbatim adoption that makes re-import idempotent — the
same trap that killed path qualification. Instead `lifecycle_hash` covers `status`, `freshness`,
`superseded_by_id`, `origin_repo`, and `visibility`. `classifyIncomingItem` compares both and
gains a fourth verdict, `metadata-divergent`, resolved by the existing `newer` policy and
applied as a metadata-only `UPDATE` that writes `content_hash` verbatim. Content convergence
behaves exactly as it does today; lifecycle convergence is new.

`confidence` is deliberately excluded — it moves on ordinary use and would make almost every
item permanently divergent.

**Deletes can currently run backwards.** Import plans an insert without consulting local
tombstones, so a stale export resurrects an item deleted after that export was taken. And the
tombstone upsert overwrites `deleted_at` unconditionally (`portability.ts:193-207`), so an old
tombstone rewinds a newer one. Both are one-line-shaped fixes with real consequences: consult
tombstones before planning an insert and skip when the tombstone is newer than the incoming
item's `updated_at`, and make the upsert conditional —
`DO UPDATE ... WHERE excluded.deleted_at > knowledge_tombstones.deleted_at`.

**The export format bumps to version 2.** The header is `version: 1` (`portability.ts:31`), and
`origin_repo`, `visibility`, and `lifecycle_hash` are new persisted fields. A version-2 reader
accepts version-1 files by treating the missing fields as NULL, `'repo'`, and recomputed; a
version-1 reader must refuse version 2 rather than silently dropping ownership.

### Operations that must be blocked or scoped in a shared database

| Operation | Today | In a workspace |
| --- | --- | --- |
| `restoreSnapshot` | `DELETE FROM knowledge_items` then reinsert (`snapshots.ts:74-89`) | Refused in `shared` mode. It would roll back every repo and pass the integrity audit while doing it |
| `exportKnowledge` | Exports every item in the active DB (`portability.ts:29`) | Defaults to `origin_repo = <current>`; `--all-repos` is explicit |
| GC purge | Hard delete plus a tombstone that propagates to peers | **Disabled entirely in a workspace.** Archive and compress remain |
| `createSnapshot` | Copies the whole active database | In `shared` mode it would write every repo's knowledge into one repo's `.knowl/snapshots/`. Refused unless `--all-repos` |
| GC candidates | `listKnowledgeItems` ignores scope | Honors it (P7); a repo only collects items it originated, and repos absent from this machine are excluded always |
| Change notification | Every foreign write notifies | Only changes whose `origin_repo` is the current repo. Hardcoded, not configurable — a knob for a behavior nobody has experienced yet |
| Implicit context reads | Unscoped ambient (`context-bootstrap.ts:27`, `context-composer.ts:20`, `work-loop.ts:106`) | Required repo scope, `origin_repo = <current>` only |
| Item mutation | Any item in the open database | A repo may only mutate items it originated |
| Duplicate detection on write | Scans the whole database and may supersede a match (`knowledge-writer.ts:202-236`) | Scoped to `origin_repo = <writing repo>`; a cross-repo conflict key is reported, never auto-superseded |

**Why purge is disabled rather than scoped.** The earlier revision promised `knowl gc undo`. It
cannot exist: the commit records only the base item (`gc.ts:219`), while the delete cascades
take assertions, evidence links, telemetry, skill steps, and embeddings
(`schema.ts:34,60,70,78,92,125`). Restoring the row restores none of that, and the tombstone
written alongside would need a cancellation record that has no representation in the format.

Purge exists to reclaim space from genuinely dead knowledge in a single-owner database. In a
workspace the blast radius crosses an ownership boundary and the recovery story is a fiction, so
it is switched off — archive and compress already deliver most of the benefit, and both are
reversible from the commit log. A workspace that genuinely needs purging can unlink a repo and
purge it locally, where the consequences are visible to whoever owns them.

### Concurrency

Each host session spawns its own `serve` process (`server.ts:83-89`), and every hook invocation
is a separate short-lived process. A shared database is N processes on one file.

WAL prevents corruption; it does not prevent lost updates, and the code does read-modify-write
without version checks — `readHostSeenCommit` → compute → `setHostSeenCommit`
(`host-session-bindings.ts:115-132`), and `importKnowledge` classifies *before* its deferred
`BEGIN` (`portability.ts:116-184`). Two concurrent imports both see the old row and the second
silently overwrites the first's resolution. Raising `busy_timeout` does nothing for this, and
`SQLITE_BUSY_SNAPSHOT` is not retried by it at all.

Required: `BEGIN IMMEDIATE` for every read-modify-write, optimistic concurrency on
`knowledge_items` (`UPDATE ... WHERE version = ?`, retry on zero rows affected), and bounded
retry with jittered backoff and a hard deadline rather than a tuned `busy_timeout` constant —
the failure case is a slow volume, where no static value is right.

Acceptance is a number, not a task: **8 concurrent writers, zero escaped `SQLITE_BUSY`, zero
lost updates, p95 write under 50 ms on local disk.** The test must detect lost updates
specifically; a test that only asserts "no corruption, no unhandled error" passes on today's
code while losing writes.

**Network and synced folders are refused, not warned about.** WAL needs working advisory locks
and `-shm` coordination; Dropbox, OneDrive, and iCloud sync `.db`, `-wal`, and `-shm`
independently and produce a mutually inconsistent triple, and SMB/NFS locking is frequently
broken. A shared workspace on a synced folder is the obvious thing a user reaching for this
feature will try. Detection is a runtime probe of the volume and its locking behavior — not a
list of folder-name patterns, which misses mapped drives, junctions, and self-hosted servers.
If the probe fails, `workspace init` refuses and explains.

### Trust

Two-sided membership defends against a hostile *clone*. It does not defend against a hostile
*commit*, and that is the exposure this feature actually creates: content from repo A is
injected into an agent's context while it works in repo B, and linkage is granted per repo, not
per commit. Once `protocol` is linked, anyone who can land a commit there can influence what a
`server` agent reads — through a `state` atom a hook writes after their PR merges, or a skill
package (import writes skill files to disk, `portability.ts:209-215`).

Mitigations, in v2:

- Knowledge from another repo is never auto-injected into context (hooks, `knowl_context`). It
  is returned when explicitly queried, always labelled.
- Skills never cross repos, and `knowl_skill_run` never resolves an entrypoint from another repo.
- Secret policy is the workspace's, not the writer's. `validateKnowledgeWrite` runs only on
  write and reads the *writing* repo's config (`knowledge-validation.ts:53-93`,
  `rejectSecrets: false` short-circuits at line 73). In a shared database that makes the whole
  workspace's policy equal to its weakest repo's. The effective policy — `rejectSecrets` and the
  union of `secretPatterns` — moves into the manifest and is enforced at maximum strictness on
  every workspace-scoped write. `workspace add` refuses a repo with `rejectSecrets: false`
  without explicit confirmation.

## Non-goals

- No hosted or remote sync. Cross-machine sharing remains export/import.
- No per-item ACLs or redaction.
- No cross-repo sessions. Lifecycle stays anchored to the hook's `cwd`.
- No cross-repo code symbol index (v3 candidate).
- No monorepo work. A monorepo is one repo and one database.
- No filesystem scanning for workspaces. Discovery is a registry lookup.
- No transactional repo rename, no runtime mode switch, no git-root-commit auto-rebinding.
- No cross-repo writes in v1. Federation is read-only; v2 delivers cross-repo update.

## Risks

| Risk | Severity | Mitigation |
| --- | --- | --- |
| An old client opens a newer shared database and defeats every schema-level mitigation | Data loss | P5 ships in an earlier release; refuse-to-open-if-newer |
| Agent applies one repo's fact while working in another | Wrong work, silently | P5 `repo` on the serialized item, tested at the boundary; category-driven scoping; no auto-injection of foreign knowledge |
| GC purges a cross-repo "duplicate" and propagates the delete to teammates | Data loss | Purge disabled in a workspace; archive and compress remain and are reversible from the commit log |
| Concurrent writers lose updates without any error | Silent loss | `BEGIN IMMEDIATE`, optimistic version checks, a test that detects lost updates specifically |
| `withDbPath` interleaving files writes into the wrong database | Silent misfiling | P3 explicit connections; a mutex alone is insufficient |
| Workspace on a synced folder corrupts | Data loss | Runtime lock probe; refuse |
| Enabling layering activates dropped `category`/`status` filters | Wrong results | P1 parity and equivalence test before enabling |
| Cross-repo retrieval degrades single-repo quality | Regression | No weights or boosts in v1; cross-repo eval cases are a v1 deliverable |
| Migration is not re-runnable after partial failure | Trust | Journalled and resumable; copies rather than moves; identity untouched so import stays idempotent; mode flips last |
| An old client creates a fresh database at a path migration emptied | Silent write loss | The canonical path is never renamed; `user_version` is bumped in place so the guard fires |
| Repo-only and workspace-wide items become indistinguishable in `shared` mode | Wrong visibility, wrong GC, leaked export | `visibility` persisted on the item, independent of database path |
| Drift or GC in one repo mutates another repo's item | Data loss | All lifecycle state keyed to a single `origin_repo`; the applies-to set is advisory and read by nothing that mutates |
| Reading a peer migrates or writes to it | Corruption of a repo the user did not touch | Read-only opens with bootstrap suppressed; foreign-item telemetry dropped in v1 |
| Implicit context assembly pulls another repo's knowledge into an agent at session start | Injection channel | Repo scope is a required parameter on every implicit read; foreign knowledge only via explicit query |
| Two repos configured with different embedding models cannot see each other's items | Silent retrieval gap | One embedding identity pinned per workspace; `add` refuses a mismatch, `migrate` re-embeds |
| Writes below the MCP layer bypass routing | Items land with a visibility nobody chose | `routeWrite` lives in `knowledge-writer`, beneath every write surface |
| An ordinary write in one repo supersedes another repo's item as a "duplicate" | Silent loss of owned knowledge | Duplicate detection and conflict resolution scoped to `origin_repo = <writing repo>` |
| A write lands between export and activation and is never read again | Silent loss | Per-repo write fence during migration; snapshot taken at the fence |
| A crash mid-migration leaves some repos shared and some not | Unrecoverable mixed state | Mode lives only in the manifest; activation is one atomic write after every repo reports done |
| Promotion or retirement never reaches another machine | Divergence that looks like data loss | `lifecycle_hash` compared alongside `content_hash`; metadata-only updates preserve `content_hash` verbatim |
| A stale export resurrects a deleted item, or an old tombstone rewinds a newer one | Deleted knowledge returns | Tombstones consulted before planning inserts; the upsert only moves `deleted_at` forward |
| Synthesis launders another repo's private content into shared architecture | Confidentiality break | Sources restricted to the current repo; output inherits the most restrictive source visibility |
| Foreign items reported stale against the wrong filesystem | Wasted re-verification, distrust of the label | Staleness computed only for owned items; `unknown` otherwise |
| A removed name is reused and adopts orphaned knowledge | Ownership transfer nobody intended | `remove` refuses while items remain; retired names are reserved |
| New FTS columns silently ignored on existing databases | Filtering that appears to work and does not | Versioned drop, recreate, and backfill under the `user_version` guard |
| Weakest repo's secret policy becomes the workspace's | Exposure | Policy in the manifest, enforced at maximum strictness |

## Testing

**Prerequisites.** Layered-vs-direct filter equivalence. A non-project namespace write produces
an embedding row. `repo` present in serialized `compactMcpJson`. An old client refuses a newer
database. `resolveStorage` returns the same `knowledge` path to `initDb`, `projectNamespace`,
and `snapshots`, and the same `local` path regardless of mode. A read-only open leaves the file
byte-identical, including for a database whose schema predates this client.

**v1.** Two temp repos linked: write in A, query from B, assert the `repo` label on the
serialized payload. **Querying a peer leaves the peer's file byte-identical** — this is the
read-only contract, and it fails today on both bootstrap and telemetry. Item-scoped tools refuse
a foreign item by name instead of answering. A linked repo absent from disk: queries succeed,
the skip is reported, doctor flags it. Nested repo rejected by `workspace add`. Manifest copied
to a second "machine" with different paths: `join` resolves. Skill atoms excluded from
cross-repo results.

**v2.** Migrate then export/import round trip with no item loss and no identity change; re-run
migrate and assert idempotence; kill the process mid-migrate and assert the journal resumes
correctly and mode has not flipped. A repo-visibility item is invisible to another repo's query
and absent from its export. Cross-repo GC purge impossible. A repo cannot mutate an item it did
not originate. Snapshot restore refused in `shared` mode. Drift in one repo cannot mark
another's items stale. Implicit reads (`getRecentContext`, `composeContext` pinned constraints,
`startWorkLoop`) return only current-repo items in a populated multi-repo database — asserted
per path, since each is a separate call site. A repo whose vector model differs is refused by
`add`. A mixed `knowl_ingest_atoms` batch reports a destination per atom, and one failing
partition does not roll back the others. A repo with existing knowledge joining an
already-migrated `shared` workspace is refused without `--migrate`, and with it, every one of
its items is reachable afterward. `promote` changes visibility without changing `content_hash`
or item count.

**v2 ownership and convergence.** A `knowl_store` in one repo whose content closely matches
another repo's item inserts rather than superseding it. `knowl_update` refuses a foreign item by
name. A write attempted during that repo's migration fence fails with the migration message
rather than succeeding into a database about to be retired. Killing the process after export but
before activation leaves mode unflipped and the repo usable. Promoting an item, exporting, and
importing on a second machine converges — the receiving side sees the new visibility, which is
the case that fails today. A tombstone newer than an incoming item blocks its insert; an older
tombstone does not overwrite a newer one. A version-1 reader refuses a version-2 export. Purge
is unavailable in a workspace. Synthesis run in one repo cannot cite or reproduce another
repo's `repo`-visibility content. Foreign items report `stale: unknown`, never `stale: true`.
`remove` refuses while the repo owns items, and a retired name cannot be re-added.

**Read-surface enumeration.** One test per surface in the table above — `knowl_state`,
`knowl_recent`, MCP resources, synthesis, and the three bootstrap paths — asserting that a
populated multi-repo database yields only current-repo items. These are separate call sites, so
a single shared assertion would pass while individual surfaces leak.

**Concurrency.** 8 writers across processes: zero lost updates (asserted by content, not by
absence of errors), zero escaped `SQLITE_BUSY`, p95 under 50 ms.

**Regression — the zero-impact guarantee, stated behaviorally.** A project with no workspace
returns the same results, leaves `origin_repo` NULL and `visibility` `'repo'`, writes no
applies-to rows, and produces byte-identical CLI output. Tables may exist and be empty;
conditional schema is not the contract, because `bootstrapSchema` cannot implement it.

## Open questions

1. **Does `linked` mode earn its keep?** If category-driven defaults route well, `shared` may be
   the only mode worth maintaining, and `linked` reduces to v1's fan-out with no workspace
   database. Decide from v1 usage, not now.
2. **Does the `repo` label change agent behavior?** P5 makes it present. Whether agents actually
   condition on it is measurable in the eval set and should be measured before weights are tuned.
3. **What is the right `busy_timeout` replacement policy** for a shared database on a slow local
   volume — bounded retry with a deadline is specified, but the deadline needs a measurement.
4. **Is the advisory applies-to table worth building at all?** It exists only to boost and filter
   retrieval, nothing reads it for a lifecycle decision, and an empty table breaks nothing. If
   `origin_repo` plus `visibility` rank well enough in the cross-repo eval cases, drop it.
5. **Should `visibility` be mutable after write?** Promoting a repo-only item to workspace-wide
   is obviously useful and is a one-column update. Demoting one that other repos have already
   read is a retraction with no mechanism behind it. Promotion only, until there is a reason.
