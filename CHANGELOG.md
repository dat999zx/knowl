# Changelog

Notable changes to `@dat999zx/knowl`. Versions before 2.1.0 predate this file; see the
[git tags](https://github.com/dat999zx/knowl/tags) for that history.

## 2.5.0 — 2026-07-27

Link several repositories so agents can work across them. Plus a fix that affects every
project, workspace or not.

### ⚠️ Run this once after upgrading

**`knowl reindex --vectors`** — in every existing project.

Knowledge saved before your first search was never indexed for semantic search, so it is
invisible to it today. The fix below stops it happening again, but it does not go back and
index what is already there. `knowl doctor` now tells you how many items are affected.

### Added

- **Workspaces.** `knowl workspace init <name>`, then `knowl workspace add <name>` in each
  repo. An agent in one repo can then read knowledge from the others, and every result says
  which repo it came from so a fact about the server is not applied to the web client.
- **Nothing is shared until you say so.** Everything you already have stays private to its
  repo. `knowl workspace promote --category decision --apply` shares what you choose. There
  is no un-share, because other repos may already have read it.
- **`knowl workspace join <manifest>`** for a second machine or a teammate. Repo paths
  differ per machine, so joining points the workspace at your checkouts.
- **`knowl workspace status`, `list`, `remove`.** `doctor` reports linked repos that are
  missing from this machine, and a repo whose embedding settings do not match the
  workspace — mismatched settings make items invisible to each other with no error.
- **`knowl init` prepares the embedding model**, so knowledge is indexed from the first
  note onward. It never fails your setup: offline or behind a proxy you get keyword search
  and a message saying so. Skip it with `KNOWL_SKIP_MODEL_DOWNLOAD=1`.

### Fixed

- **Knowledge saved before your first search was never indexed.** Embedding on write
  deliberately never downloads the model, and nothing else fetched it until the first
  search — so everything written before that was permanently invisible to semantic search,
  with no error. An agent saving twenty notes in a session left all twenty unreachable.
- **`knowl doctor` said vector search was fine when it was not.** It reported that the
  feature was switched on, which was true and useless. It now reports how many items are
  actually indexed, and names the command to fix a gap.
- **`knowl reindex --vectors` claimed to download a model it already had.** It said
  "Downloading" on every run. Nothing was being fetched; it now says "Loading".
- **Cross-repo results were ranked by keyword overlap rather than meaning.** A repo's
  knowledge is now ranked the same way local knowledge is, so the answer that actually
  answers your question comes first even when it lives in another repo.
- **`knowl query` and the agent tool gave different answers.** The command-line search did
  not search linked repos, and later ranked them differently from the agent tool. Both now
  behave the same way.
- **`knowl status` never showed workspace information** even when the repo was linked.

### Known limits

- No notification when a linked repo adds knowledge — you see it when you search.
- Linked repos are read-only. You cannot edit another repo's knowledge from here; run the
  command there.
- Code symbol indexing stays per repo.

## 2.4.0 — 2026-07-26

A release of things that were quietly not working. Nothing here is a new feature you can
point at; several are cases where Knowl reported success while losing or hiding your
knowledge. Most were found while designing multi-repo workspaces — a shared database turns
each of them from latent into destructive — but every one of them is a bug in the
single-repo product today.

### Fixed

- **A correction could be silently dropped.** Identical content produced different memory
  depending on which agent wrote it: Codex deprecated the stale item first, while Claude
  relied on auto-dedup and had its correction discarded. Only an exact title match
  superseded; everything else was thrown away. All three write paths now share one
  resolution — `no-op` only for a byte-identical re-store, `supersede` when one title's
  significant tokens are a subset of the other's, and `coexist` otherwise, which keeps both
  and tells the caller what it was left beside. Superseding is judged on titles, not whole
  text, because content overlap cannot separate a correction from a lifecycle trail: a work
  loop's start and finish records share most of their body tokens and must stay side by
  side. `knowl_ingest_atoms` now reports each atom individually, having previously counted
  a verbatim no-op toward its stored total and called an empty batch a success.
- **`knowl_query` returned less than it found, without saying so.** An `asOf` query
  hard-filtered on category, unlike every other path, so a wrong category guess returned
  nothing where the same query without `asOf` recovered; it now retries without the filter
  when the filtered result is empty. Separately, vector search and `explain` silently fell
  back to the project database alone, dropping session and any configured
  organization/global knowledge — that scope narrowing is now disclosed in the reply
  instead of being invisible.
- **Writes outside the project layout were stored with no embedding.** The embedding writer
  derived its config directory from the database's location, which only holds for
  `<root>/.knowl/knowl.db`. Any other database produced a nonsense path, config loading
  threw, and the best-effort catch swallowed it — so the item was written with no vector
  and no error. Vector-first ranking then made it effectively unretrievable.
- **Layered retrieval dropped status and tag filters.** Only the query, limit and surface
  reached each namespace, so asking for archived items or a specific tag got neither.
  Category remains a ranking boost rather than a filter, matching the direct path, because
  a wrong category guess must not empty a result set.
- **Reading a database migrated it.** Schema bootstrap runs on every open and includes the
  legacy-schema migration, which drops foreign keys and rebuilds tables outside a
  transaction. Opening a database to read from it therefore rewrote it. There is now a
  read-only open that skips bootstrap entirely.
- **`listKnowledgeItems` accepted a scope and ignored it.** It took a project id and
  selected the whole table, so garbage collection, synthesis, integrity checking, drift,
  export and the viewer all read as bounded while scanning everything. The argument is
  gone rather than quietly honored, so nothing reads as scoped that isn't.

### Added

- **Knowl refuses to open a database written by a newer version.** There was no schema
  version marker at all, and because the schema is built from `CREATE TABLE IF NOT EXISTS`
  plus additive `ALTER`s, an older client saw every table it expected, found nothing
  missing, and proceeded — writing rows the newer schema's rules do not hold for. Databases
  now carry a version and an older build declines with a message naming both.
- **Connections are pooled.** Each namespace query previously closed and reopened the
  database twice. Clients are now cached per resolved path and open mode.
- **Query results can carry provenance.** The compact response shape is an allowlist, so
  any label attached upstream was discarded before reaching the agent — including the
  namespace label layered queries have always attached. `repo` and `namespace` now survive
  serialization. Both are absent unless supplied, so existing output is unchanged.
- **`origin_repo` and `visibility` columns on knowledge items.** Groundwork for linking
  repositories into one knowledge base. Nothing reads them yet: outside a workspace
  `origin_repo` stays null and `visibility` stays `repo`, which is exactly current
  behavior.

### Changed

- Database paths are resolved in one place instead of being derived independently in three,
  which had no visible effect only because the three happened to agree.

## 2.3.0 — 2026-07-25

Memory can now move between two machines more than once, and deletes move with it.

### Added

- **Repeatable import.** `knowl import` classifies each incoming item as new, identical,
  or divergent, and resolves divergence with `--on-divergence`: `newer` (default — latest
  `updated_at` wins, `version` breaks ties), `skip`, `theirs`, or `fail`. Previously a
  single divergent item discarded the entire import, so a machine that had done any work
  could never receive anything again — including unrelated new knowledge with no conflict
  at all. Measured on a real 372-item export: one locally edited item used to block a
  peer's new decision from landing; now it lands and the divergence is reported by id and
  title.
- **Convergence.** An adopted item is written verbatim — the peer's own `content_hash`,
  `version` and `updated_at` — so a repeat import is a no-op. Applying it as an ordinary
  update would stamp a new timestamp and version, making the copy newer than the peer's
  and leaving two machines to trade a fresh winner back and forth forever.
- **Deletes travel.** Purging an item records a tombstone that export carries and import
  replays. A local item is removed only when it is older than the delete, so an edit made
  after the remote delete wins. `knowl gc --tombstone-days` (default 90) prunes them.

### Fixed

- **An agent was told about its own writes.** On Windows the same project reaches Knowl
  with different drive-letter case — a hook payload reports `D:\project` while
  `process.cwd()` reports `d:\project` — and the binding key preserved that difference.
  One agent therefore held two independent change watermarks: a write advanced one, and
  the next tool event read the other, found it stale, and reported the write back as a
  foreign change. The continuation-reminder counter was split the same way.
- **Imported knowledge was invisible to vector search.** Import wrote raw SQL and never
  called the embedding indexer that every other write path calls. Importing 372 items
  produced 372 full-text rows and zero embeddings, so retrieval silently fell back to
  BM25 until someone ran `knowl reindex --vectors` by hand.
- **`knowl --help` described half its commands.** `timeline`, `query`, `conflicts`,
  `supersede`, `context`, `export`, `import`, `synthesize` and `view` had no description
  at all.
- **`knowl doctor` named a command that does not exist.** Its integrity hint suggested
  `knowl update`, which exists only as an MCP tool. It now names `knowl supersede`.

### Changed

- **`knowl import` output has a new shape.** `skipped` is now `identical`, and `updated`,
  `keptLocal`, `deleted` and `divergent` join it. A dry run or a failed import reports
  every count as zero with the projection under `wouldApply`, replacing output that
  showed a non-zero `inserted` beside `applied: false` and read as partial success.
  Anything parsing this output needs updating.

## 2.2.0 — 2026-07-25

Live verification of the 2.1.0 subagent work found it shipped half-working, and fixing it
turned up two ways memory could be lost or blocked without telling you.

### Fixed

- **Subagents had memory but no reason to use it.** 2.1.0 delivered a subagent's memory
  snapshot and no guidance at all — a spawned agent received no prompt reminder, no MCP
  server instructions, and no `KNOWL.md`. Probing a live subagent settled the question the
  design had left open: MCP instructions do *not* reach a subagent's startup context. A
  guidance card now ships with the bootstrap, budgeted before the memory snapshot so a
  large snapshot cannot truncate it away.
- **Corrections were discarded in favour of the value they corrected.** `knowl_store`
  superseded a same-titled near-duplicate only for `state`. For every other category the
  *new* write was dropped: storing "Cache TTL: 5 minutes" and then "Cache TTL: 30 minutes
  now" left the stale five-minute item active and threw the correction away. The
  exact-title rule now applies to every category. Nothing is lost either way — a
  superseded item keeps its status and stays queryable.
- **`.env.example` counted as a secret.** The sensitive-path check matched `.env` plus any
  suffix, so `.env.example`, `.env.sample`, `.env.template` and `.env.dist` were all
  rejected. Those files exist to be committed. Template suffixes are now exempt, matched
  exactly, so `.env.exampled` is still caught.
- **`security.rejectSecrets: false` did not fully turn secret rejection off.** The
  sensitive-path check ran before the flag was consulted, so the only knob available was
  silently partial and `knowl doctor` could report NOT READY with no setting able to clear
  it. All secret detection now sits behind that flag.
- **`knowl doctor` misreported its integrity check.** It described errors as "warning(s)"
  while failing on them, and pointed at "repair reported records" when `knowl audit` is
  read-only and no repair command exists. It now counts errors and warnings separately and
  names commands that exist.

### Changed

- **`knowl config` is navigable.** Choosing a category no longer commits you to editing
  something in it: the field list offers `Back` and the category list offers `Quit`, and
  quitting without changes no longer prompts to save an empty diff.
- **Config values are picked, not typed.** Fields now declare their type, so booleans and
  enums are presented as choices instead of free-text boxes that required typing `true` or
  recalling the valid `dtype` values. Text and list fields prefill the current value.
- **A bad config entry no longer discards your work.** Invalid input is reported and
  re-prompted rather than throwing away every pending change.
- **The duplicate reply from `knowl_store` says what happened.** It previously read
  "skipped duplicate insert", which scans as success; it now leads with `NOT STORED` and
  names the recovery.

### Documentation

- Spec for the portable memory round trip — repeatable import and traceable deletes —
  covering the two items deferred from the collaboration scoping work.

## 2.1.0 — 2026-07-25

Subagents get project memory, and any agent is told when memory changed underneath it.

### Added

- **Subagent bootstrap.** `SubagentStart` and `SubagentStop` are registered for Claude Code.
  A spawned subagent receives its own memory snapshot, capped at half the normal context
  budget because fan-out multiplies whatever a subagent costs. Previously a subagent
  received nothing at all: `SessionStart` fires once per session and never reaches one.
- **Per-agent binding scope.** Subagent hook events carry an `agent_id`, now used as the
  session-binding scope, so every subagent has an independent change watermark and an
  independent continuation-reminder counter.
- **Change notification.** Each accepted tool event compares a per-agent watermark against
  the latest knowledge commit and, when it has moved, returns a compact titles-only card
  naming what changed. It costs nothing when nothing changed, replaces the continuation
  reminder when both would fire rather than adding to it, and never reports an agent's own
  writes back to it.
- **`changes` in host-neutral hook output.** `knowl agent-hook <host> <event> --json` now
  carries the same change summary as structured JSON, so hosts with no native protocol can
  consume it without one.
- **Host profiles.** Each supported host is described by one file in `src/cli/agents/hosts/`
  declaring its identity keys, event map, and context envelopes, replacing host conditionals
  spread across six modules. Capability is expressed by return value, so support cannot be
  claimed for a channel that delivers nothing. Adding a host is adding a file.
- **Change notification beyond Claude Code.** Codex CLI receives subagent bootstrap and change
  cards through the same `hookSpecificOutput.additionalContext` channel, verified with a live
  Codex model run. Cursor is sent `additional_context`. Hosts with no hook channel continue to
  read `changes` from the host-neutral JSON result.

### Fixed

- **`knowl_query` with `asOf` crashed** with `queryKnowledgeBase is not defined`. The
  historical-query branch of the MCP server called a function it never imported, so a
  documented parameter of the most-used tool failed at runtime.
- **`knowl_ingest` always reported zero counts.** It read `insertedIds`/`updatedIds`/
  `supersededIds` off the pipeline result, which carries them on `mergeResult`, so every
  ingest returned `{inserted: 0, updated: 0, superseded: 0}` regardless of what it stored.
- **Sibling subagents corrupted each other's continuation reminder.** All subagents shared
  the parent's binding row, so their tool calls incremented and reset one counter between
  them.
- **Subagent identity was stripped from hook payloads.** The lifecycle payload allowlist
  dropped `agent_id` and `agent_type` before normalization, and dropped the tool arguments
  needed to recognise an agent's own writes.
- **Claude Desktop was routed through Cursor's hook event map.** The event-mapping ternary
  checked only Codex and Claude by name, so every other host fell through to Cursor's
  camelCase events. Each host now declares its own map, and a conformance suite asserts it.

### Upgrading

- **Rerun `knowl init` for your hosts once.** A configuration written by an earlier version
  has no `SubagentStart`/`SubagentStop` handlers, and subagents keep starting with no memory
  until you rerun it. `knowl doctor` reports the configuration as stale in the meantime.
- **Codex users must trust the hooks.** Codex does not execute project hooks until they are
  trusted once, interactively when prompted or with `--dangerously-bypass-hook-trust` in
  automation. Until then the hooks silently do not run.
- **No database action required.** The new `seen_commit_rowid` column is applied
  automatically the next time any Knowl process opens the database.
