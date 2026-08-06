# Changelog

Notable changes to `@dat999zx/knowl`. Versions before 2.1.0 predate this file; see the
[git tags](https://github.com/dat999zx/knowl/tags) for that history.

## Unreleased

### `knowl workspace demand` — what the repos actually ask each other for

A workspace-level ledger recording every cross-repo query: which repo asked, which answered,
the top result's score, and the query itself where it passes the repo's own secret validators
(a fingerprint always, so demand stays countable even when the text is withheld). Lives beside
the workspace manifest, not in any member repo, and is local to this machine.

**Nothing acts on it.** It exists to answer, with data rather than intuition, whether there is
enough cross-repo demand to justify proposing promotions at all — see the
[design](docs/superpowers/specs/2026-08-07-demand-paged-scoping-design.md), which treats
"the evidence says no, so do not build it" as a success condition. Writes are fire-and-forget
and every failure is swallowed: a telemetry file that can fail a query is worse than no
telemetry.

### Workspace reads tell the truth about what they found

Groundwork for demand-paged scoping
([design](docs/superpowers/specs/2026-08-07-demand-paged-scoping-design.md)); each item is a bug
on its own terms.

- **The relevance floor now applies to federated queries.** `queryFederated` never passed
  `vector.relevanceFloor` into the ranker, so `minRelevance` arrived `null` on every workspace
  query, no federated result could carry `abstained`, and `knowl_query`'s `NO CONFIDENT MATCH`
  notice was unreachable code from the moment a repo was linked — the case where the verdict
  matters most, because the alternative on offer is another repo's near-miss.
- **A result from a kin repo says so.** `kin` marks repos of one lineage with diverged
  conventions, and it was a write-time signal only: the cross-repo write advisory warned about
  divergence while a federated *read* returned the same repo's items unmarked. One
  `SHARED LINEAGE` notice per response, not per row.
- **The miss notice names the next move.** Where `search.transcripts.enabled` is set,
  `NO CONFIDENT MATCH` now points at `knowl_transcript_search` — past sessions are indexed
  separately and `knowl_query` does not search them. Conditional, because naming a tool the
  build does not expose is worse than saying nothing.

### The 2026-08-06 audit

Nineteen findings across the CLI, the MCP surface and the store.

### Data loss

- **`doctor` no longer rebuilds the store it was asked to inspect.** It is exempt from the
  missing-database guard so it can run when something is wrong, but it still called `initDb`, and
  opening a libSQL `file:` URL creates the file — so diagnosing a repository whose database had
  moved wrote an empty one, reported it ready, and left the guard unable to fire again.
  `knowl-sync` runs doctor everywhere, which made routine maintenance the trigger.
- **`snapshot restore` is no longer blocked by that guard**, which had been refusing the one
  command its own error names as the first recovery to try. The subcommand only: `snapshot
  create` opens the database, and opening one creates it, so exempting the group would let the
  backup command rebuild an empty store and snapshot that.
- **`snapshot restore` refuses another repository's snapshot.** The origin is recorded in the
  manifest; `--accept-origin-mismatch` covers a repository that moved.
- **`import` verifies each item's `contentHash` against its own content.** Divergence is decided on
  that field, so an item edited with its hash left alone imported as "identical" and its real
  content was discarded — under every policy, including `fail`.
- **`knowl init` refuses to fork memory from a subdirectory.**

### Failures that reported success

- `isError` is set on the uninitialized-project banner and on every cross-repo ownership refusal.
- `import` exits non-zero when it refuses.
- `knowl_skill_create` refuses rather than overwriting an existing package.
- `knowl_handoff` reports replacing an unconsumed baton.
- `knowl_task_finish` refuses a second finish or a post-finish checkpoint.
- `supersede` validates the replacement it is given.
- `knowl_timeline` and `knowl_conflicts` name their overflow instead of truncating blind.

### Context and correctness

- **`knowl_query` is bounded** — 45,147 characters measured for a 25-result query, on the one path
  with no ceiling. The bound spends bodies before it spends results: the lowest-ranked results
  are cut to an excerpt, keeping their id, title and score so the agent can read any of them
  whole with `id`. Dropping is the last resort, for when every body is already an excerpt.
- **`knowl_query` takes an `id`,** returning one item whole. 262 of 639 atoms on a real store
  exceed the content ceiling, including `reasoning`, which `knowl_decide` requires and no tool
  could read back.
- **Tool order is deliberate.** The list led with `knowl_ingest`, which needs an unconfigured AI
  provider, while `knowl_query` sat seventh.
- Unknown tools and missing resources return `-32602` rather than a successful `isError` result or
  the server's own `-32603`; a call omitting `arguments` no longer throws.
- `knowl_ingest_atoms` is capped at 50.

### Reads that wrote

- **`knowl eval` no longer writes to the store it measures**, and no longer reindexes the live
  embedding table before measuring it.
- **`upgrade --all --dry-run` no longer edits the machine registry.**

### The rest

- **Write transactions take their lock up front** (`BEGIN IMMEDIATE`), as `bootstrapSchema` already
  did for the same reason.
- **GC compression cannot grow an item** — `summarize` truncated on UTF-16 length while the gate
  measured bytes, so CJK and accented text came back larger with the original destroyed.
- **Numeric and timestamp options are validated**, not coerced: `--limit abc` reached a bound
  parameter as `NaN`, and `--as-of banana` matched every row through SQLite string comparison.
- **Resume keys are eight characters and a miss costs 250 ms**; existing six-character keys still
  resolve.
- **Write failures are diagnosable** — the SQLite verdict in `error.cause` is surfaced through the
  same sanitizer.
- **`--json` failures emit an envelope on stdout** while stderr keeps the human line.
- **`import` takes `--repair-content-hash`** for an export written by a writer whose hash formula
  predates this build. It recomputes rather than waives, so divergence is still decided on a hash
  that describes the body it arrived with.

### Changed

- **`knowl doctor` now distinguishes advisory from broken, and its exit code changed with it.**
  The verdict was `every check is OK`, which collapsed a three-level status into two outcomes:
  a freshly initialized repository — every check OK except "nothing stored yet" — reported NOT
  READY, so `knowl init` printed "ready" and `knowl doctor` called the same install broken.
  READY now means no check FAILED, warnings are counted on the verdict line, and only a FAIL
  exits non-zero. **Anything gating CI on `knowl doctor` or `knowl upgrade --all` returning
  non-zero for a warning will stop firing.** The findings themselves are unchanged and still
  printed, per repository, in the sweep.
- **Doctor's retrieval check runs a real query.** The old one called `queryKnowledgeForAgent`
  with no query string, which the ranker treats as browsing — so it was `COUNT(active) > 0`
  wearing a query's clothes, and an item present in the table but missing from the index counted
  as proof retrieval worked. It now queries a stored item by its own title words and asserts it
  comes back, counts FTS membership for every active item beside it, and records no
  `knowledge_access` rows while doing so.
- **A warning-only integrity audit reports WARN rather than OK.** It used to stamp `[OK]` and
  print a Fix line underneath it.

## 3.2.2 — 2026-08-06

### Fixed

- **Worktree transcripts really are indexed on macOS and Windows now.** 3.2.1 fixed the wrong
  half. Making the root-set guard compare canonically was correct but not sufficient: the archive
  directory is named for the path the *agent* held, and `git worktree list` always answers
  canonically, so resolving git's answer only ever moves further from the name on disk. An agent
  launched in `/var/folders/X` writes `-var-folders-X-wt`, and no amount of canonicalising
  `/private/var/folders/X-wt` produces it.

  Archive lookup now tries each root as given, resolved, **and** with the canonicalisation
  undone — the substitution (`/private/var` for `/var`, `C:\Users\runneradmin` for
  `C:\Users\RUNNER~1`) is derived from the one pair where both halves are visible, the project
  root as supplied and as resolved.

  Reproduced on Windows with a junctioned parent directory. The earlier test junctioned only the
  repo, which leaves the *sibling* worktree path identical in both forms and therefore tests
  nothing — which is why 3.2.1 looked verified and was not.

### Changed

- CI is 5 jobs instead of 9. Across two full runs the node axis produced no signal that the OS
  axis did not — 22 and 24 agreed on every leg — so node 24 is kept on ubuntu alone. Lint, types,
  docs, audit and the tarball smoke test were three ubuntu jobs each paying their own `npm ci`;
  they are one job. CodeQL drops its per-PR run for main plus weekly.

## 3.2.1 — 2026-08-06

### Fixed

- **Worktree transcripts are indexed again on macOS and Windows.** `resolveRepoRootSet` checked
  that git's worktree list included the current directory before trusting it — a guard against
  git answering about some enclosing repository. It compared git's canonical paths against Node's
  uncanonicalised ones, so wherever those differ the guard fired on the repository's *own* answer
  and returned the project root alone, dropping every worktree. A session recorded against a
  worktree was then never indexed.

  This needs no symlink to hit: macOS `os.tmpdir()` is `/var/folders/…` whose real path is
  `/private/var/folders/…`, and a Windows profile name over eight characters appears as
  `RUNNER~1`. 3.2.0's new CI matrix found it on its first run — the failure was invisible for as
  long as CI was ubuntu-only.

  Paths are now compared canonically and returned verbatim, since the returned roots are encoded
  into archive directory names a host agent wrote using the uncanonicalised form.

## 3.2.0 — 2026-08-05

Hardening, generated documentation, and the CI gates that would have caught this year's defects.

### Breaking

- **A learned skill will not run until you approve it.** `knowl skill approve <name>` records a
  SHA-256 of the package's exact bytes; any edit to any file in it revokes that approval. Existing
  packages need approving once. Approval is CLI-only and deliberately unreachable over MCP — the
  same MCP surface that runs a skill also writes it, and an agent that could approve its own
  package would make the boundary decorative.
- **A skill no longer inherits your environment.** It previously received the full `process.env`:
  model-provider keys, cloud credentials, GitHub tokens, the SSH-agent socket. It now gets an
  allowlist plus `KNOWL_PROJECT_ROOT`, `KNOWL_SKILL_NAME` and `KNOWL_SKILL_DIR`. Runs are also
  capped at 120s and 8MB of output.

### Security and durability

- **JSONL import is streamed and bounded.** It read the whole file into memory, split it, and
  parsed every record before any validation ran. It now reads line by line with ceilings on total
  bytes (256MB), record count, record size, and files per skill package.
- **Config is written atomically and owner-only.** An interrupted write left truncated JSON that
  `loadConfig` could not parse, two writers could interleave, and the mode followed the umask — on
  a file that can hold a literal `ai.apiKey`. The skill trust file uses the same writer.
- **Startup diagnostics no longer record your project paths.** The log is machine-wide, and each
  record carried the literal project root beside hostname, PID and load average — on a shared host,
  telling every local account which projects you work on and when. It is now a 16-character hash,
  in a `0700` directory, `0600`, clearable with `knowl diagnose-startup --clear`.
- "manifest-verified" is now "checksum-verified" throughout. A SHA-256 proves the bytes are intact
  and says nothing about who produced them.

### Documentation that cannot drift

- The MCP tool schemas moved out of a closure into `src/mcp/tool-definitions.ts`, so something
  outside the running server can read them. The tool count and the embedding-preset table are now
  generated; `npm run docs:check` fails on drift and on any tool or command nothing documents.
  It immediately found the preset table missing `arctic-embed-m-v2` and still claiming every
  preset is 384-dimension.
- Curated prose is checked for coverage, not regenerated. Replacing hand-written descriptions with
  first-sentence extracts would trade accurate documentation for merely current documentation.

### CI

- Matrix over ubuntu/windows/macos × node 22/24. Windows is the primary development host and was
  never covered.
- New gates: lint, typecheck, documentation drift, a production dependency audit, and a tarball
  smoke test that installs what `npm publish` would actually ship.
- CodeQL weekly and on every PR; Dependabot grouped weekly.

### Dependencies

`@libsql/client` 0.14 → 0.17, `@modelcontextprotocol/sdk` 1.4 → 1.30 (clearing a path-traversal
advisory), `dotenv` 16 → 17, `commander` 12 → 14. Two of those changed behaviour in ways only the
end-to-end CLI suites could see — dotenv 17 writes a banner to stdout, and commander 14 rejects
excess arguments before an action runs. Both are handled; the reasoning, the deferred Zod 4
migration, and the one unfixable upstream advisory are in
[docs/dependency-review-2026-08.md](docs/dependency-review-2026-08.md).

## 3.1.0 — 2026-08-05

Retrieval quality, what a memory read actually hands back, and the storage engine. Includes the
community improvement round in [#16](https://github.com/dat999zx/knowl/pull/16) by
[@William-Sommers](https://github.com/William-Sommers), measured throughout.

### Agents receive whole facts

- **`knowl_query` returns 2,000 characters of an item, up from 600.** Measured on a real 556-item
  store, 600 cut 48.7% of items — with the empty truncation marker, so a caller could not tell a
  short complete atom from the opening third of a long one while doctrine told it to answer from
  memory rather than read files. 2,000 returns 90.6% whole for about 305 extra tokens on a
  three-result query.
- **`truncated: true`** is present when content was cut, and absent otherwise.
- **`affectedPaths` is returned with every result.** It was built, stored on roughly half of all
  items, and never left the compact allowlist. Across 356 archived cases where an agent queried
  memory and then opened a file within three tool calls, the result had named that file 17.1% of
  the time; it could not have been higher.
- **`score` says "no opinion" instead of saying nothing.** Where no calibrated relevance exists it
  is now the string `uncalibrated (lexical-only | not embedded | layered namespaces)` rather than
  an absent field, which was indistinguishable from the ranker having forgotten.
- **The "2–6 keywords" rule is gone.** A ground-truth ablation on the shipped suites showed
  truncating over-length queries to six words cost 4.7 and 7.2 points of hit@1, while on-subject
  extension reached 100%. Count was the wrong variable; guidance now names relevance.

### Retrieval

- **MMR replaced by near-duplicate demotion on both paths.** On a topical query the second-best
  answer necessarily shares vocabulary with the best, so MMR was billing relevance as redundancy.
  Recall@10 on the paraphrase suite went 0.845 → 0.964, and every metric of every shipped suite
  improved. Confirmed on a data-disjoint instrument: `benchmark:accuracy` Recall@5 0.710 → 0.748.
- **The lexical tokeniser handles non-Latin scripts.** An ASCII-only character class made every
  accented or non-Latin letter a separator, so a Vietnamese query naming a stored item returned
  nothing at all.

### Storage engine

- **`synchronous = NORMAL` on all three databases**, chosen rather than inherited. Un-batched
  writes — one `knowl_store`, one hook capture — cost 3.488 ms/row at FULL against 0.832 at
  NORMAL, and six contending processes went 173 → 337 writes/s. An application crash, a killed
  `knowl serve`, `Ctrl-C` or a closed lid still lose nothing; only a power cut can drop the last
  seconds, and the file stays clean.
- **`KNOWL_SQLITE_SYNCHRONOUS`** overrides it. `FULL` restores fsync-per-commit. `OFF` is refused:
  it can corrupt on power loss and measured no faster than NORMAL. An unrecognised value stops the
  command rather than silently falling back.
- **Transcript embedding is reproducible.** A message's vector no longer depends on which others
  shared its forward pass, which the catch-up deadline had been deciding — two indexes of the same
  archive disagreed on 651 of 956 messages, and the ranker returned a different top-5 for 42.8% of
  real queries. Measured free on real messages.
- The embedding reindex commits once per pass rather than once per row: 88,549 ms → 2,220 ms.

### Fixes

- `knowl init` reads `.knowl/config.json` as the project marker, so a half-finished init can be
  finished instead of failing identically on every retry.
- The transcript byte-offset backfill is no longer starved on exactly the busy machines that need
  it — it checked its deadline before touching the first file.
- A feedback confirmation recorded in the same millisecond as a tier boundary is no longer dropped.
- A schema-locked repository reports the version stamp rather than advising `knowl init`.
- The MemoryAgentBench runner, dead since the embedding-profile guard landed.

### Internal

- `MAX_ITEM_CONTENT_CHARS` reached fourteen truncation sites across five files and is now four
  constants with one policy each. Two would have broken quietly when it moved: the markdown
  formatters cap items inside a whole-response budget, and `knowl_skill_run` truncated subprocess
  output with it.
- 100+ tests added, many from a targeted mutation sweep that found the secret-scanning fix itself
  had a comment and no test. `npm run test:mutation` runs a slice; it is not wired into CI.

## 3.0.3 — 2026-08-05

Documentation and packaging only. No runtime behaviour changes.

### Documentation

- **The README is a tour again, not a manual.** It had reached 1,199 lines / 8,211 words, with
  whole sections written at release-note depth — import divergence policies, snapshot table
  partitioning, reconciliation thresholds, tombstone monotonicity. All correct, all verified, and
  all the wrong altitude for someone deciding whether to install this. The README is now 360 lines
  and still covers every area, including a Features section that names every shipped capability
  with the command that runs it.
- **`docs/reference.md` is the complete manual.** It is the previous README preserved whole: the
  prose is byte-identical, and only the header and relative paths changed. Nothing verified was
  deleted, and the README links into it by section anchor wherever a reader wants more.
- Positioning is stated on Knowl's own terms — typed rather than free text, governed rather than
  append-only, local rather than a service. No competing product is named or linked.
- Two capabilities the README had never documented are now listed: secret-safe writes, and
  promotion at session end.
- Three claims corrected: `custom` is the bring-your-own embedding path rather than a fifth preset;
  it is *retrieval* that keeps your query local, which `knowl ask` does not; and vector ranking is
  the agent/MCP path, while a single-repository CLI query is lexical.
- The hero banner carries the real logo instead of an invented glyph, cut out of its tile and
  embedded so the file stays self-contained.
- A contributor licence agreement, contributing guide, and CLA bot.

### Changed

- The npm package description and keywords now describe what Knowl is for, and cover the terms
  people actually search: `project-memory`, `agent-memory`, `claude-code`, `codex`, `cursor`.

### Tests

- The guidance test guards `docs/reference.md` for the canonical MCP tool table, and additionally
  fails if a README link points at a reference anchor that no longer exists — so renaming a section
  breaks the build rather than the front door.
- Loose scratch databases are swept from the repository root.

## 3.0.2

### Fixed

- **Critical: `snapshot restore` could delete every knowledge item and report success.** The
  pre-restore snapshot prunes the snapshot directory to its retention limit and protected only
  the file it had just written, so restoring anything older than the second-newest snapshot
  deleted the source. `ATTACH` then created an empty database in its place, the restore emitted
  a bare `DELETE FROM knowledge_items`, the cascade took assertions, evidence links, access,
  skill rows and embeddings with it, and the integrity audit affirmed the empty store was
  healthy. Restore now refuses an attachment holding no `knowledge_items`, protects the source
  from the prune, and verifies the exact bytes it attaches by staging them outside the snapshot
  directory first.
- Restore now rewrites the full transitive dependency closure. `knowledge_commit_items` — the
  index that makes blast-radius lookup an equality search — was cascaded away and never
  refilled. `evidence` rows were left at present-day values while the links pointing at them
  were rolled back.
- Which tables restore owns is now an explicit registry (`src/store/snapshot-tables.ts`) with a
  test that fails when a table in the schema is unclassified.
- Imported skill packages install as atomic whole-directory swaps into a base Knowl verified is
  a real directory. Previously, files were renamed one at a time after the database committed —
  so a partial install was possible, an import merged into an existing package instead of
  replacing it, and a symlink or Windows junction under `.knowl/skills` was followed, landing
  files outside the tree despite passing the lexical containment check.
- A failed skill entrypoint no longer chains automatically into `fallback`; callers opt in.
- `package-lock.json` records the right version again, and CI now fails on drift.

### Changed

- `npm publish` produces provenance attestation, which the release workflow already had the
  OIDC permission for.
- README's snapshot section describes what restore actually does.

## 3.0.1

### Fixed

- **Imported skill packages can no longer write outside `.knowl/skills`.** Both sides of the
  containment check were derived from the untrusted skill name, so a traversal name satisfied it.
  Names and paths are now anchored to a fixed base, contents are staged before the transaction
  opens, and files are installed by rename after it commits rather than written inside it.
- **A skill package's directory name is now its only identity.** A manifest could declare a
  different name and entrypoint resolution followed the manifest, so a package inspected through
  `knowl skill read` as one skill could execute another's files.
- **Namespace switches no longer misroute concurrent writes.** The database handle was a set of
  process-global variables, so a project write issued while a session-namespace switch was open
  was executed against the session database — silently. The handle is now scoped to the async
  context; nothing else changes for callers.
- **The viewer survives a malformed URL and requires a token.** An async route handler with no
  error boundary turned `GET /api/evidence/%` into an unhandled rejection, which this process is
  configured to die on. Routes now answer 400, and every request needs the per-launch token
  carried by the printed URL. Responses also send CSP, `X-Content-Type-Options`,
  `Referrer-Policy`, and validate the `Host` header.
- **Snapshot restore verifies before it destroys.** A missing manifest was silently accepted, and
  the recorded `schemaVersion` and `byteSize` were written but never read. The manifest is now
  required and fully checked, the snapshot's own `integrity_check` and `user_version` are
  preflighted through the existing attachment, and `schemaVersion` records the real constant.

### Documentation

- Corrected the version branding, default embedding model, MCP tool count, `reindex --vectors`
  behaviour, snapshot guarantee, and transcript retention wording in the README.

## 3.0.0 — 2026-08-04

Almost all of this release is [@William-Sommers](https://github.com/William-Sommers)'
[#15](https://github.com/dat999zx/knowl/pull/15): seven parallel read-only audits over 25,331
lines, 86 findings, every one reproduced before it was fixed and none left open. The full ledger
with each finding's mechanism, reproduction and outcome is in `docs/audit-2026-08-04.md`.

Worth naming separately: a second round re-tested the *dismissals* from the first, under the rule
that "not worth fixing" is a claim needing evidence exactly like a fix does. It found worse than
the round it was checking — including the best-evidenced defect in the audit, which had been
recorded as a known-flaky test.

The major version is for the breaking changes below, not for a rewrite. Most stores will notice
only the reindex.

### Breaking

- **Every stored vector is invalidated and will be re-embedded on the next reindex.** Batch
  composition changes what a q8 model produces for a given text — measured up to 4.79e-2 cosine —
  so write-time embedding and `reindex --vectors` disagreed about the same atom, and over 120 real
  queries the top-10 order moved for 13 of them. Reindex now embeds one text per forward pass so
  the two agree. The shape of the batch is therefore an input to the vector, and it is now part of
  the vector's identity, which is what makes rows written by an older build invalidate rather than
  linger. Run `knowl reindex --vectors` after upgrading.

- **`.cmd` and `.bat` skill entrypoints are refused, and `autoRun` now defaults to `false`.**
  Windows re-parses a batch file's command line *after* Node has quoted it, under rules that do
  not honour `\"` (BatBadBut / CVE-2024-24576), so no argv quoting can make them safe — Node itself
  has refused to spawn them without an explicit shell since April 2024. `.cmd` was the *promoted*
  path here and the tests used it as the canonical example. A hand-rolled escape was attempted
  during research and was still injectable on the first try, so it is dropped rather than escaped:
  `quoteShellArg` is deleted, and a `shell` entrypoint now refuses arguments outright instead of
  quoting them into a command string. Use `.ps1`, `.js` or `.sh`, and pass values through the
  `KNOWL_*` environment.

- **MCP tool arguments are validated against the schema each tool publishes.** The SDK validates
  the *envelope* of a `tools/call`, never the tool's own `inputSchema`, so every constraint eleven
  tools declared was decorative. Calls that were silently accepted are now refused: an out-of-range
  `confidence`, a negative `maxChars`, a `banana` timestamp, an unbounded `limit`, a missing
  required field. One validator at dispatch closed seven findings.

- **The relevance floor reports instead of deleting, and `MIN_VECTOR_RELEVANCE` is gone.** A query
  below the floor used to return nothing, which the caller could not tell apart from an empty store
  or a missing index — and it deleted real answers: 23 of 110 answerable queries on
  `semantic-suite.json`, Recall@10 0.9818 → 0.7909. Results now come back ranked and carry
  `abstained`, with the verdict stated in words. A caller keyed on "empty means miss" must read
  that flag or the notice. See also the per-model floors under **Changed**.

- **Export format is now v3, and imported knowledge stays foreign.** Importing a stranger's export
  published *their* rows to your peers — no join, no promote, no flag — because peers filter on
  `visibility` with no origin predicate and an imported row was indistinguishable from one you
  wrote. An export now names the workspace and repo that wrote it; a foreign file may update
  content but never ownership or visibility, and imported rows are stamped `import:` so `join`
  cannot claim them and `promote` refuses them with a reason. v1 and v2 files still import, and
  their items are attributed to an unknown origin rather than to you.

### Security

- **Reading a peer created a database inside that peer's repository.** `file:` creates, and
  `query_only` applies only after the connection is open, so every read-only open of a peer with
  no database wrote an empty one into its `.knowl/` — reached from federated query, the ownership
  guard, the cross-repo overlap check and peer change detection.

- **The ownership guard failed open when the owning peer was not checked out.** It answered "not
  foreign" when it meant "I could not look", so on a partial checkout — two of five repos on a
  laptop, the documented case — the guard was simply off for every repo that was not there. It now
  refuses an operation whose ownership it cannot establish, and checks *every* id an operation
  touches rather than only the one it is named after.

- **`$HOME` was treated as a Knowl repository**, because a bare `.knowl` directory is
  indistinguishable from a project marker and `~/.knowl` is where machine-local state lives. That
  admitted a real home directory to `upgrade --all` and `doctor --fix`, which snapshot and migrate.
  Discovery now requires `.knowl/config.json`. Reproduced live during remediation.

- Statement text and bound parameters no longer leave the process in an MCP error message.

### Added

- **Retention for the three things that only ever grew.** Snapshots keep the newest 3 and say what
  they pruned; commit payloads have a 90-day horizon; and the shared model cache is pruned to what
  some repository on the machine still names, 30 days after anything last touched it — 3,187 MB →
  335 MB in the measured case. Machine-wide rather than per-repo, because the cache is, and it
  fails closed: a registry that cannot be read prunes nothing.

### Changed

- **The relevance floor is one value per model.** A cosine scale belongs to the model that produced
  it, and one constant could not be right for five. Measured over the same 110 on-topic queries and
  15 off-topic probes on one corpus, `0.30` mislabelled 24 of 110 real answers on arctic and fired
  **not once** on granite, granite-97m or bge — so on the default preset the feature was dead. Per
  model, all five now mislabel 0 of 110 while catching 11–14 of 15. A model nobody has measured
  gets no floor and does not abstain, rather than borrowing another model's number. The
  scale-free alternative — judging how far the top result stands out from the rest — was measured
  and is worse on every model, because a query that finds nothing still produces a peaked
  distribution. `docs/evals/per-model-floor.md`.

- **Ranking is a convex combination, not additive boosts on a fused rank.** RRF deliberately
  destroys magnitude, so an additive constant has nothing to be a proportion *of*: at a fixed
  cosine of 0.50 the standing terms alone moved a result 0.204, which is 96% of the entire range
  this file documents as a legitimate query. Alpha was swept over 2,149 cases; priors are bounded
  multipliers applied after the floor, so a prior may change where an item sits but never whether
  it is returned.

- **`knowl query` and `knowl_query` rank by the same engine.** The CLI had no test and had drifted
  onto different rules than the MCP tool answering the same question. Both now report the
  calibrated score.

- **The startup banner is printed after the handshake, not after initialization**, and names its
  repository on the first line.

### Fixed

- **Snapshot restore cleared 5 tables while the delete cascaded into 8.** Assertions, evidence,
  access and drift state were emptied and never refilled, and because
  `updateKnowledgeItemWithCommit` refuses a content edit on an item with no open assertion, a
  restored store looked intact and then rejected every write to it — while the audit that runs
  immediately afterwards reported success, having never checked assertions. The table set is now
  derived from the schema rather than hand-listed, and a restore that fails its audit names the
  pre-restore snapshot and the command to put it back.

- **Transcript search returned zero hits for any query containing `.`, `-` or `/`.** Tokens were
  stripped to word characters and glued together, so `index-pass.ts` became `indexpassts`, which
  the tokenizer can never have produced. Filenames, paths, domains and versions — the most natural
  things to search a transcript for — all matched nothing. Transcript discovery separately missed
  282 files (34.8%).

- **GC hard-deleted the richer of two duplicates.** The duplicate key is category, title and
  content, so reasoning, tags, paths, provenance, evidence and the assertion trail were invisible
  to it, and the survivor was then chosen by confidence and recency alone. A delete is the one GC
  action with no undo, so it now has to be provably redundant first; when neither twin subsumes the
  other, both are kept.

- **`withClientTransaction` raised `SQLITE_ERROR`, not `SQLITE_BUSY`**, on a collision, so no retry
  anywhere recognised it. A failed batch ingest left rows with no commit record; a batch now lands
  whole or not at all.

- **`doctor` could not see the gap it was written to find** — its coverage check omitted the
  `profile_fingerprint` predicate every read path applies.

- **Four tests were asserting the defects they covered**, including the secret-leak regression
  guard, which set no environment variable, so `${OPENAI_API_KEY}` resolved to `''` and it passed
  whether or not the fix was present.

### Performance

| | before | after |
| --- | --- | --- |
| Embedding reindex (10,050 rows) | 88,549 ms | **2,220 ms** |
| Blast-radius scan @ 100k commits | 14.2 ms | **0.007 ms** |
| Transcript hit rendering | 218 ms / 15.8 MB | **3.8 ms / ≤64 KB** |
| `commandExists` (6 lookups) | 1,483 ms | **38 ms** |
| `knowl --version` module graph | 339 modules | **42** |

Dependencies are now bundled, which takes the lifecycle hook from ~2.5s to ~0.9s with no source
change — it runs as a fresh process per agent tool call, so it pays startup hundreds of times a
session.

### Known limits

- `src/transcripts/embed-pass.ts` still batches, and shares the non-reproducibility the atom path
  just fixed. The atom path took one-text-per-pass for free; the transcript path is short-message
  shaped, where unbatching costs a measured ~2.7×. Recorded as a decision to take rather than
  patched blind.
- The per-model floors are measured on one 50-fixture corpus with 15 off-topic probes. They are
  good defaults, not universal constants, and `minRelevance` is a parameter so a re-sweep is a
  measurement rather than a patch.

## 2.17.0 — 2026-08-04

Two fixes in this release came from [@William-Sommers](https://github.com/William-Sommers), in
[#13](https://github.com/dat999zx/knowl/pull/13) and
[#14](https://github.com/dat999zx/knowl/pull/14), both diagnosed by measurement rather than
inspection — which is how the second one turned out to be a different bug than it looked like.

### Added

- **`knowl diagnose-startup`, and a trace behind it.** A `serve` process killed at the host's
  connect deadline leaves nothing behind but a boot banner, so "hung opening the database" and
  "crashed on startup" were indistinguishable from the outside. A watchdog now fires at 5s/15s/25s
  — inside the host's 30s window — and names the phase currently running, to stderr and to a
  machine-wide JSONL that survives the kill. `knowl diagnose-startup [--since <hours>]` reads it
  back: boots started versus became ready, per-phase percentiles, model load times split cold and
  warm, stalls by owning phase, and concurrent-boot bursts. Silent on healthy boots, capped at
  4 MB, and `KNOWL_DISABLE_STARTUP_TRACE=1` turns it off.

### Changed

- **`knowl reindex --vectors` embeds only what is out of date.** It re-embedded every item on
  every call, so a run after a handful of writes paid the full corpus cost to write back vectors
  identical to the ones already stored. The scan now selects items with no vector under the
  current profile fingerprint, or one older than the item's own `updated_at`.

  There is deliberately no "did the model change" branch: after a profile switch no row carries
  the new fingerprint, so the same predicate selects everything and the run is a full rebuild.
  One rule, both cases. Measured on a 565-item store, both including model load: **1.1s against
  92.8s**. `--force` re-embeds regardless, for the staleness a fingerprint cannot see.

- **The MCP handshake completes before the database opens.** `startMcpServer` ran
  `bootstrapSchema` and the project lookup before connecting the transport, so all of it was
  charged against a deadline none of it knew about — 30s in Claude Code, and the process is killed
  when it expires. Nothing in the handshake needs the database: the tool list is a static literal
  and the capabilities are constants. Tool calls now await readiness and answer to the tool-call
  timeout instead, which is hours rather than seconds — the right clock for work whose duration
  depends on what other processes are doing to the same file.

- **Schema bootstrap is gated, so the steady-state open path is read-only.** Every read-write open
  re-ran the full suite: a legacy migration, ~40 `CREATE TABLE IF NOT EXISTS`, ten
  `PRAGMA table_info` passes and two data repairs. It now reads a migration level from the file
  header first and returns immediately when current.

  That level is its own number in `PRAGMA application_id`, separate from `KNOWL_SCHEMA_VERSION`,
  because the two answer different questions. "Can an older build read this file" is a
  compatibility floor and must move rarely — every bump locks out every Knowl already installed.
  "Has my migration run here" moves on every additive column. One value cannot be honest about
  both. Existing databases migrate exactly once and stay readable by older builds.

### Fixed

- **Two processes bootstrapping the same new database could kill each other.** The ten column
  passes read `PRAGMA table_info` and then conditionally `ALTER TABLE ADD COLUMN` — check-then-act
  across processes. Both see a column missing, both issue the `ALTER`, and the loser dies on
  `duplicate column name`: a `SQLITE_ERROR` that no `busy_timeout` and no BUSY retry can perceive.
  Reproduced at **1 in 96 cold-start opens** with twelve processes racing, and it can only fire
  when a column is genuinely absent — the first opens after a release adds one, which is exactly
  when many sessions restart together.

  A database needing work now takes `BEGIN IMMEDIATE` and re-reads the level under the lock, so
  one process migrates and the rest find the work done and leave. `DEFERRED` would not do:
  a read-to-write upgrade is answered with `SQLITE_BUSY_SNAPSHOT`, which a busy handler is not
  allowed to wait out. Everything commits as one transaction, so a process killed mid-migration
  leaves the database exactly as it found it.

- **The startup trace changed the process it was observing.** Listening for `unhandledRejection`
  suppresses Node's default, which since v15 is to crash, so a fatal bug anywhere in the process
  became a logged one; it is now re-thrown after recording. A signal handler called
  `process.exit(0)`, announcing a host kill to the host, any supervisor and CI as a clean finish;
  it now re-raises, falling back to the conventional 128+n code.

- **The `serve` banner no longer names an anonymous process.** Deferring the database open left it
  reading `projectRoot=pending` permanently, and that line is how you tell which repository a
  `serve` process in a host log belongs to. The resolved root now arrives on a second line, with
  the time initialization took.

## 2.16.0 — 2026-08-03

### Added

- **Searchable session transcripts, off by default.** Atoms are distilled and therefore lossy;
  the raw `.jsonl` transcripts are the complete record underneath. Enable
  `search.transcripts.enabled`, run `knowl reindex --transcripts`, and a memory miss becomes a
  slower lookup instead of amnesia. Off means nothing exists: no database file, no registered
  tools, no guidance-card tokens.

  Only prose is indexed — user messages and assistant text, never `tool_use` or `tool_result`
  blocks. Measured on this repository: prose is **2.7% of 80.9 MB** across 75 transcripts, which
  is what makes the rest affordable. Rows are pointers, `(session, line, role)`, with bodies left
  in the `.jsonl`, so the index is **under 3 MB**.

  Ranking fuses BM25 with whole-corpus semantic search, so a message sharing no word with the
  query can still win. Re-ranking a keyword shortlist structurally cannot do that — the target is
  never in the shortlist. int8 vectors were chosen by measurement, not preference: float32 scored
  MRR 0.662 at 106 MB, int8 **0.668 at 27 MB**, binary 0.310 (one sign bit per dimension cannot
  hold the ranking at 384 dims).

  Its own database, `.knowl/transcripts.db`, so a backfill cannot contend with the live session
  writing knowledge, and disabling the feature deletes the file rather than orphaning it.

- **`knowl_session_list`** — a browsable inventory of past sessions: best-known name, opening ask,
  derived status, and what each session promoted into memory. The name comes from the transcript's
  own title entries, where a user's rename beats a generated title. No session cap, and unnamed
  sessions are included and described by their opening ask.

- **`knowl_handoff`** — park a workstream so the next session in this project picks it up. `main`
  already had a crash handoff; this adds the kind that means "I stopped on purpose", which opens
  as planned work instead of telling the next session to go looking for damage that does not exist.

- **`knowl_park` / `knowl_resume` and `knowl resume [key]`** — many parked workstreams, each under
  a short key the user keeps and hands back from any directory, any time later. Distinct from the
  handoff baton, which is one per project, pushed automatically, and spent on use. Keys are
  letter-digit alternating so they cannot spell a word: a key pasted back into a prompt must read
  as a key, not as an instruction.

### Changed

- **The compact guidance card carries policy, not a tool inventory.** It had reached 1,994 of its
  2,000 characters because a test required all 27 tool names to appear, so it grew with every tool
  added and the last feature was paid for by compressing four unrelated lines.

  The same MCP handshake already delivers `tools/list` — 22,394 characters including every name
  and 6,195 of descriptions. The card was spending its scarcest resource restating a payload
  eleven times its size. Route lines now describe behaviour; five names remain, and only those
  `tools/list` cannot carry: `knowl_query`, because "call this first, before files" is sequencing
  across tools, and the four lifecycle tools, because a prohibition is not something a caller
  looks for in the tool's own description.

  Card is now 1,874 / 2,000 and a twenty-eighth tool costs it nothing. The full guidance table
  still names everything — it is a file written once per repository, not a per-session cost.

### Fixed

- **A rebuild left a stale watermark that suppressed its own re-inserts.** Dropping a rewritten
  file's rows without resetting its watermark meant the batch writer skipped every line the
  rebuild re-read: the pass reported `rebuilt: 1, indexed: 0` and left the file unsearchable.

- **`sessionId` widened a search instead of narrowing it.** `%` and `_` reached SQL unescaped in
  two places, so `sessionId: "%"` returned hits from every indexed session — the opposite of what
  the caller asked for. Both sites now share one escaping helper.

- **A read-only database open created the file.** `file:<path>` creates, and `PRAGMA query_only`
  applies only afterwards, so opening a workspace peer that had no index wrote an empty
  `transcripts.db` into that repository's `.knowl/`. `?mode=ro` is not available —
  `@libsql/client` rejects it — so the open now refuses a missing file outright.

- **Disabling the feature did not revoke an already-running MCP server.** `createMcpServer`
  captures configuration once, so a live session kept serving searches after the feature was
  turned off, and a read recreated the index that disabling had just deleted. The handlers now
  re-read configuration per call and fail closed if either the captured or the on-disk value says
  disabled.

## 2.15.2 — 2026-08-03

### Fixed

- **Knowledge you can store but can never retire.** Updating an item validated a *merged*
  record — the update's fields falling back to the stored row — instead of what the update
  actually writes. So a metadata-only change re-scanned content it was not rewriting, and
  it scanned with no validation options, because a caller making a metadata-only change
  has no project config to hand it. `validateKnowledgeWrite` only short-circuits on
  `rejectSecrets === false`, and absent is not `false`.

  `supersedeKnowledgeItem` writes just a status, so retiring an item re-validated its whole
  stored body under default settings, ignoring the project's own. Anything accepted under
  `rejectSecrets: false` that happened to trip a detector was then permanent.

  The detector in question wants 32+ characters of `[A-Za-z0-9_-]` holding a lowercase, an
  uppercase and a digit. `granite-embedding-small-english-r2-ONNX` is 39 of them — so
  recording which embedding model a repo uses produced an item that could be written and
  never superseded. Hyphenated identifiers hit this routinely: model names, image tags,
  branch names.

  Updates now validate only the fields they supply. A status change scans nothing, and
  content already accepted when it was written is not re-litigated. This covers every
  caller that issues a metadata-only update — supersede, gc, tier, drift, blast-radius.

  Unchanged for now: a store that creates an item and then supersedes its predecessor does
  the two outside a single transaction, so a failure between them still leaves the new item
  written.

## 2.15.1 — 2026-08-02

### Fixed

- **Rebuilding embeddings no longer asks for 22 GB in one allocation.** A reindex handed
  `embed()` a whole 500-row database page as a single forward pass. Attention allocates
  `batch × heads × seq × seq`, so 498 items of roughly 969 tokens produced:

  ```
  Failed to allocate memory for requested buffer of size 22444923904
  Inputs given to model: input_ids dims [498, 969]
  ```

  MiniLM hid this — its 512-token window truncated everything, so the sequence stayed
  short whatever the batch size. Granite R2's 8k window truncates nothing, so **switching
  model turned a working rebuild into an impossible allocation**. Worse, the config had
  already been written by then, leaving vector search degraded with the documented
  recovery (`knowl reindex --vectors`) hitting the same wall.

  Forward passes are now sized against the text rather than the row count, budgeting on
  `items × longest²` because the longest text in a batch is what every other is padded up
  to. A single item is clipped at 8,000 characters so one giant cannot exhaust the budget
  alone, and a batch never exceeds 32 items. On the store that produced the crash, 498
  items become 39 batches peaking around 191 MB.

  The split lives in `embed()`, so reindex, write-time indexing and query all get it.

**If you hit this**: upgrade, then run `knowl reindex --vectors`. Your configuration was
already saved; only the rebuild failed.

## 2.15.0 — 2026-08-02

### Changed

- **`knowl config` is one flat list of every setting.** No categories, no `Advanced`
  section, no level to descend into. Each row's hint is the value in effect, so the list
  is the display. Selecting any row opens an editor: the model fields, enums and booleans
  are pickers; everything else is a text box.

  It was a tree before — category, then setting, then value, with the keys a preset
  supplies hidden a level below that and refusing to open at all. Three levels to descend,
  with the thing you came for at the bottom and greyed out.

- **Edits show up in the list as you make them**, marked as unsaved, and are written
  together when you choose Save. `Discard and exit` leaves the file untouched. The
  `Edit another setting?` question after every single change is gone — returning to the
  list is the loop.

- **Interactive prompts moved from `@inquirer/prompts` to `@clack/prompts`**, with
  `picocolors`. Colour, box drawing, unicode fallback, session framing and cancel
  semantics now come from the library rather than from `src/cli/ui/style.ts`, which was
  reimplementing all of it by hand and has been deleted. `Ctrl+C` in any prompt returns to
  the list instead of tearing the process down mid-edit.

  This follows [rohitg00/agentmemory](https://github.com/rohitg00/agentmemory), whose CLI
  has no settings tree at all: a flat sequence of pickers, every option a
  `{ value, label, hint }`, and one cancel path out of anything.

### Removed

- `ConfigPrompts.selectCategory` and `ConfigPrompts.continueEditing`, replaced by
  `selectSetting`, which returns a setting key or one of `CONFIG_UI_SAVE` /
  `CONFIG_UI_QUIT`. `CONFIG_UI_BACK`, `createInquirerPrompts` and `fieldRows` are gone
  with the tree that needed them.

## 2.14.1 — 2026-08-02

### Fixed

- **Nothing in `knowl config` is read-only.** Every setting is selectable and every
  selection opens an editor. 2.14.0 refused to edit the three keys a named preset supplies
  and offered to open the preset instead — backwards for a screen whose entire purpose is
  changing things.

  The reason behind the refusal was real: `resolveVectorProfile` reads a named preset
  ahead of the flat keys, so writing `dtype` under `preset: bge-small-en` changed the file
  and nothing else. That is now answered by making the edit count rather than blocking it.
  Editing a preset-supplied field moves the profile to `custom` and writes the preset's
  other values out, so nothing is lost and the edited key wins.

- **A preset-supplied field opens on the value in effect**, not on whatever its own key
  happens to hold, so an edit starts from what is actually running.

- **`Model name` is a list.** It was the last free-text box on a value with known good
  answers; it now offers the four preset model ids and keeps typing for anything else.

## 2.14.0 — 2026-08-02

### Added

- **A visual system for the interactive commands**, in `src/cli/ui/style.ts`. Colour helpers
  that check the terminal on every call, box-drawing symbols with ASCII fallbacks, and
  `intro`/`outro` framing so `knowl config` opens and closes rather than just stopping.

  Colour marks one thing per row — the value, or the key you would script with — and is
  dropped entirely when `NO_COLOR` is set, when `TERM=dumb`, or when stdout is not a
  terminal, so a piped or logged run stays readable. `FORCE_COLOR` overrides.

  Symbols fall back to ASCII where box drawing is not safe. A legacy Windows console
  renders a missing glyph as a question mark, and it is still what a double-clicked
  `cmd.exe` opens.

### Changed

- **A category shows the settings you came to change, and nothing else.** Search is two
  rows — the embedding model and whether semantic search is on. `provider`, `model`,
  `dtype`, `pooling` and `cacheDir` moved behind `Advanced settings…`, which is also the
  only place the dotted config keys appear now: someone reading that list is already
  looking for what to pass to `knowl config set`.

  The previous list put a name, a value, a status word and a dotted key on every row, read
  while it moves under a cursor. It buried the two settings anyone opens Search for under
  five they never touch.

- **Prompts share one theme**, so the cursor, the highlight and the help line no longer
  differ between the category list, a value picker and a confirmation. Lists carry a
  breadcrumb heading (`Search › Advanced`) and a rule between the settings and the ways
  out — without it they read as one list and `Back` looked configurable.

### Fixed

- **The model picker now works on a repository that predates presets.** Ownership was read
  from `search.vector.preset`, and a config initialised before that key existed has none —
  so nothing was marked as preset-owned, `Model name` stayed a free-text box, and the
  picker opened with nothing selected. This was the whole point of 2.13.0 and it applied
  to none of the configs that needed it. `currentPresetId` falls back to matching the
  model string, so such a config reads `MiniLM L6 v2` and the picker opens on it.

- **Picking a model writes the whole profile**, not just the preset name. Writing the name
  alone was correct only because `resolveVectorProfile` prefers it; the flat keys were
  left describing whatever model came before, and a config with no `preset` key had
  nothing for the resolver to prefer. Choosing a model now repairs both.

- **A highlighted row keeps its colour to the end of the line.** The prompt library
  highlights by wrapping the text it was given, so a row that already carried colour ended
  the highlight at its own first reset. Escape sequences are stripped before wrapping.

## 2.13.0 — 2026-08-02

### Changed

- **`knowl config` reads like a settings screen instead of a key dump.** Every setting now
  carries a name and a one-line explanation, so the list shows `Embedding model` and what it
  does rather than `search.vector.preset: granite-small-en-r2`. The dotted key stays on the
  row — it is what `knowl config set` takes, and a UI that never shows it gives you no way to
  find it.

- **The embedding model is a picker built from the preset table.** `VECTOR_PRESETS` already
  recorded a readable label, a size and a language range for every model; the editor listed bare
  ids anyway. Choices now read `Granite 97M Multilingual R2 — 200+ languages, 32k context ·
  98 MB`. Selecting `Custom model…` still asks for a Hugging Face id and verifies it.

- **Every value prompt has a way out.** `ConfigPrompts.inputValue` returns `string | null`, and
  `null` abandons the edit without queueing anything; selects gained a `← Back` choice and text
  inputs cancel on a blank entry. Previously, selecting a setting by accident committed you to
  entering a value for it. Implementations that return a string are unaffected.

### Fixed

- **The editor no longer names a model that is not in use.** `resolveVectorProfile` reads a named
  preset ahead of `search.vector.model`, and switching preset never rewrites that key — so a repo
  running Granite still had `Xenova/all-MiniLM-L6-v2` on disk, and the editor displayed it.
  Preset-owned rows now show the value actually in effect, and `Pooling method` shows the
  preset's pooling rather than `unset`.

- **`search.vector.model`, `.dtype` and `.pooling` are no longer editable while a preset owns
  them.** Writing them in that state changed the file and changed no behaviour. They are marked
  `set by preset`, and selecting one offers to open the preset instead of dead-ending. Choosing
  the `custom` preset releases them, since it names no model of its own.

- **A secret is no longer reported as modified on a project that never set one.** `getConfigValue`
  returns the redaction for any secret field before it reads the file, so comparing that read
  against the default marked every secret as changed — `API key ******** modified` on a config
  with no `ai` section at all. An unwritten setting now displays the default that is actually in
  effect rather than `unset`, and is not marked.

## 2.12.1 — 2026-08-02

### Fixed

- **Change notifications are no longer swallowed when two tool calls land close together.**
  A non-shell tool event normalises to `summary: "<Tool> completed"`, and the capture
  fingerprint was built from that payload alone — so every `Grep` in a session hashed
  identically, and a second call inside the 1.5 second debounce window was dropped before any
  processing. No `KNOWL CHANGED` card, no drift counting, exit 0 and no output. Agents call
  tools far faster than that, so real notifications were being lost.

  Hook events now carry a debounce-only discriminator built from the tool name and its retained
  input, so calls that differ only in their arguments no longer collide. The `tool_input`
  allowlist additionally keeps `pattern`, `glob`, `query` and `url` — short strings, bounded like
  every other retained field and compared in memory only — without which search tools have
  nothing retained to tell one call from the next. Genuine duplicate deliveries of the same call
  are still collapsed, which is what the debounce is for.

## 2.12.0 — 2026-08-02

### Added

- **The embedding model is now a choice, not a constant.** `search.vector.preset` selects one of
  four vetted local models, or `custom` for your own. A preset bundles model, dtype and pooling
  together rather than leaving them as three keys you must keep consistent — pooling is not
  discoverable at runtime, and the wrong value produces plausible-looking vectors that rank badly
  with no error at all.

  | Preset | Model | Size (q8) | Context | Languages |
  | --- | --- | --- | --- | --- |
  | `granite-small-en-r2` *(default)* | `onnx-community/granite-embedding-small-english-r2-ONNX` | ~52MB | 8k | English |
  | `granite-97m-multilingual` | `onnx-community/granite-embedding-97m-multilingual-r2-ONNX` | ~98MB | 32k | 200+ |
  | `bge-small-en` | `Xenova/bge-small-en-v1.5` | ~34MB | 512 | English |
  | `minilm-l6-en` | `Xenova/all-MiniLM-L6-v2` | ~23MB | 512 | English |

  All four emit 384-dimension vectors, so switching never changes the stored vector width. New
  repositories default to `granite-small-en-r2`. **Existing repositories are not migrated**:
  `knowl upgrade` cannot introduce a preset, and a configuration written before presets existed
  keeps its model and its original mean pooling. No forced download, no silent model change, no
  reindex required.

  The default is English-only. Repositories storing non-English knowledge should select
  `granite-97m-multilingual`, which covers 200+ languages with enhanced training on 52 of them.

- **`knowl config set-model <model>`** selects a model of your own. It confirms the repository
  exists and ships `onnx/model_quantized.onnx`, reads its pooling method from
  `1_Pooling/config.json`, and asks which to use when the repository does not declare one —
  never guessing, because a wrong guess fails silently. The three resulting keys are written as
  one unit, so a half-configured profile can never reach disk.

- **`knowl workspace repin-embedding`** moves an established workspace to a different embedding
  model and names every peer that must then reindex. Previously the pinned identity could only be
  set while a workspace was empty, so changing it meant unlinking every repository.

- **A semantic retrieval benchmark** at `docs/evals/semantic-suite.json`, with `npm run
  bench:embeddings` comparing every preset. `knowl eval retrieval` now reports metrics per
  difficulty tier as well as overall.

### Changed

- **`knowl reindex --vectors` re-embeds items in every status**, not only active ones. Items that
  are superseded, deprecated or archived are still reachable through a status filter, so leaving
  them on a previous model made them permanently invisible to vector search. It also drops rows
  belonging to a previous model, and pages through the store instead of stopping at 10,000 items.

- **Changing the embedding model now offers to rebuild.** Interactive `knowl config` prompts;
  `knowl config set` prints the same warning with the affected row count, and says when the change
  also breaks a workspace pin.

### Fixed

- **Pooling is per-model rather than hardcoded to mean.** Every model was pooled as though it were
  MiniLM. Three of the four presets — including the new default — are CLS-pooled, so this would
  have silently degraded retrieval for anyone selecting one. Nothing errors when pooling is wrong;
  the vectors simply stop meaning what they should.

- **Embeddings record the profile that produced them.** Rows previously stored only provider and
  model, and search filtered on those two — but dtype and pooling also change the numbers a model
  emits, so changing either left old rows matching the filter and being scored against
  incompatible query vectors. Rows now carry a fingerprint over all four, added by an automatic
  migration that backfills each repository's current profile. A profile change now degrades vector
  search to keyword-only rather than mis-ranking, and an interrupted rebuild leaves a smaller
  searchable set rather than a mixed one.

- **The fingerprint filter can no longer be skipped by omission.** It was an optional parameter,
  and leaving it out dropped the predicate and scored every stored vector regardless of origin.
  Making it required revealed five call sites already doing exactly that.

- **Setting `search.vector.model` while a preset is active no longer reports a silent no-op.** The
  preset decides the model, so the command changed nothing while printing success. It now says the
  key is being overridden and names the model actually in use.

- **The access log reads back in the order it was written.** `retrieved_at` is millisecond text, so
  a retrieval and the feedback answering it routinely share one — and the tiebreak was the random
  hex `id`, which made the order of an append-only log a coin flip. Equal timestamps now break on
  the insertion counter.

## 2.11.1 — 2026-08-01

### Fixed

- **Hybrid retrieval now counts lexical rank for items vector search also returned.** The
  lexical term was gated on `vectorScore === undefined`, so any item vector returned had its
  BM25 rank discarded — an item ranked #1 lexically and #40 semantically scored on its weak
  cosine alone, indistinguishable from one lexical search never found. Agreement between the
  two engines is the signal hybrid retrieval exists to exploit, and it was the one case the
  fusion ignored.

- **The lexical weight is sized for fusion rather than fallback**, renamed
  `BM25_FALLBACK_WEIGHT` → `BM25_LEXICAL_WEIGHT` and raised 0.35 → 3.0. The old value was
  correct for a term reachable only when vector search came up empty, and deliberately too
  small to disturb the semantic ranking; as a live fusion term it capped lexical evidence at
  under 0.006 against a cosine spanning 0–1, enough to break exact ties and nothing else.

  Across the 500-case suite: **Recall@3 0.9887 → 0.9907, Recall@10 0.9940 → 0.9960, MRR
  0.9609 → 0.9639, nDCG 0.9689 → 0.9715**, with the same 8 failing cases.

  3.0 is measured rather than chosen. Retrieval improves monotonically with this weight, but
  it trades against the relevance floor, because a larger term lifts every score — at 8.0 an
  off-topic query clears the floor and starts answering again. At 3.0 the separation still
  holds on a live store: worst off-topic top score 0.2529 against a 0.30 floor, weakest
  legitimate 0.4016. Raising it further requires re-running that check, not just the eval —
  the suite is saturated on Recall@10 and cannot see a floor regression at all.

## 2.11.0 — 2026-08-01

### Added

- **Agent queries can now return nothing.** Asked something the store has no answer to —
  `training a labrador puppy` against a memory-system store — retrieval previously returned
  three confident results anyway, because vector search is nearest-neighbour with no distance
  cutoff and the only bound was `slice(0, limit)`. A measured floor of 0.30 now decides whether
  a question is answerable at all. Six off-topic queries that each returned three results return
  zero; all eight on-topic and all six deliberately-vague queries still answer.

  **The floor judges the query, not each result.** Measured across 20 queries, on-topic scored
  0.401–0.614 and off-topic 0.170–0.223 — but every one of those figures is a *top-result*
  score, so that is the only claim the measurement supports. Filtering each result instead cost
  real answers: against the 500-case retrieval suite it dropped `span export backend` (0.269),
  `jwt ttl configured value` (0.262) and `which test runner` (0.233), all three on queries whose
  top result scored 0.37–0.39, taking Recall@10 from 0.9940 to 0.9867. A weak result underneath
  a strong one is the tail of a real answer, not junk. No lower constant fixes it either —
  those answers reach down to 0.233 while off-topic queries reach 0.223.

  The shipped rule leaves the ranking untouched once a query clears, and the suite confirms it:
  **Recall@10 0.9940, MRR 0.9609, nDCG 0.9689 — identical to before, with the same 8 failing
  cases.**

- **Only results vector search could have returned are judged.** Two candidates arrive looking
  identical, both scoring about 0.034 with nothing to separate them: one that vector ranked
  outside its top N (semantically distant), and one with no embedding at all (invisible to
  vector, not distant — written since the last index, or while the embedding model was not yet
  cached). The floor now keys on whether an item is embedded under the provider and model being
  searched, so a just-written item is never suppressed by a verdict reached without it. A store
  with no embeddings is unaffected: every candidate is unjudgeable and the floor turns itself
  off.

## 2.10.0 — 2026-07-31

### Changed

- **Automatic capture now reads the two fields that actually carry knowledge.** The previous
  four rules were written before anyone measured what hook events contain. Measured across 32
  recorded sessions, git commit subjects carry 52% of the durable knowledge a reviewer would
  want kept and error text carries 45%; changed file paths alone carry **none**. So a commit
  subject becomes a `fact` or `architecture` item, and a failure that was followed by edits
  and did not recur becomes a `fact` naming what broke and what fixed it.

  `docs`, `test`, `chore` and merge commits are skipped — they record process, not knowledge.
  A failure that recurs later in the session produces nothing, because it was not fixed;
  claiming otherwise is worse than staying silent.

- **Two rules were deleted rather than re-tuned.** `Repeated workflow: …` and
  `Session outcome: …` both measured at zero value, and the first was not inert as an earlier
  baseline claimed — four such items exist in a real store, two written by the very session
  that measured it. Capture stays model-free: `finalizeMemorySession` still reports
  `usedAi: false`.

### Added

- **Skills are captured while the session is live, and surfaced back to later ones.** A
  repeated command carrying something non-obvious — a pipe, a redirect, a filter — now
  prompts the agent to save it as a runnable `.knowl/skills/` package while it still knows
  what the command was for. Asking at session end, as the old rule did, is why the stored
  items could only say "ran 3 times".

  Repetition alone does not qualify: a bare `npm test` never triggers it. The nudge fires
  once, and stands down entirely once a saved skill already covers that command. Saved skills
  appear in the session-start card within its existing character budget, and a matching skill
  is suggested after a command runs. A captured command is never executed.

### Fixed

- **Resolved-failure items no longer retire each other.** Every such item was titled from the
  error's first line, which on real data is always the shell exit line — so 22 of 31 shared
  the title `Resolved failure: Exit code 1`, and title-similarity supersession then retired
  each previous one. Replaying the recorded corpus through the write path: 30 items written
  and 6 surviving became 31 written and 31 surviving.

- **A synonym lookup could throw and lose a whole session's capture.** `SEARCH_SYNONYMS` was a
  plain object literal, so two ordinary lowercase tokens resolved to inherited
  `Object.prototype` members — truthy, not iterable, and fatal inside `finalizeMemorySession`.
  The table now has a null prototype.

- **The commit parser no longer accepts shell syntax as a subject.** Its capture class matched
  newlines, so `git commit -m "$(cat <<'EOF'` yielded a wrapper fragment whose type parsed as
  null — bypassing both the skipped-type and merge filters. The capture is bounded to one line
  and the `$(cat <<'DELIM')` form is parsed properly rather than dropped.

## 2.9.0 — 2026-07-31

### Added

- **The drift check runs at session start, and reports rather than decides.**
  `checkKnowledgeDrift` had existed since the `pr` command shipped, but its only caller was a
  command someone had to remember to type — so in practice knowledge went stale exactly as if
  the check did not exist. The session boundary is the right chokepoint, being the moment
  before an agent starts relying on memory, and a watermarked check now runs there and leads
  the session context with what moved.

  It detects; it does not flip. Measured on a documentation-heavy repository, one commit
  window matched 36 of 301 atoms and fifteen windows matched a third of the store: atoms
  annotate hot files, hot files change daily, and an automatic freshness flip would hold those
  atoms at `needs_review` permanently. Run by hand after a PR that flag volume is a review
  worklist; applied silently at every session start it is corpus-wide ranking damage and a
  warning that cries wolf. So the warning names the count, the leading titles, and the exact
  pinned `knowl pr check --since <commit>` command, and flipping freshness stays deliberate.

  The first run learns its baseline silently, and a watermark that no longer resolves — a
  rebase, an aggressive gc — re-baselines quietly rather than guessing. The warning is charged
  against the context budget before the recent-knowledge block, so it cannot push a session
  past the size the host was promised, and it is the part that survives: the watermark has
  already advanced, so that line is the only record of the window.

- **A correction flags the batch that produced it.** A wrong memory is a class, not an
  instance. The extraction pass or session promotion that produced one bad atom usually
  produced more, and the correction is the one moment the system knows where to look. Siblings
  of a corrected item — same insert commit, same source label, shared evidence — flip to
  `needs_review`, capped at twelve and recorded as one knowledge commit, so the existing change
  cards announce them.

  Only two unambiguous signals fire it: `knowl_feedback` with `causedCorrection`, and demotion
  to deprecated or rejected. A routine supersede deliberately does not — state atoms supersede
  weekly, and firing there would be a flag storm. The insert commit defines the batch, so the
  replacement that performed a correction is never itself flagged.

- **`tier`: standing earned by use, orthogonal to self-reported confidence.** Every write
  starts `asserted`; two confirmed-useful feedback events promote it to `verified`; a
  correction demotes it immediately, and a content edit resets it, because verified means
  verified-verbatim. Confirmations are counted from the moment the current tier began, so a
  reset genuinely restarts the climb instead of inheriting events that confirmed a claim the
  item no longer makes.

  Ranking gains a bounded standing term sized below the freshness re-rank: earned standing
  breaks ties between near-equals, and never outranks being current. Tier is deliberately
  absent from `lifecycleHash` — verification is one machine's own experience with an item, and
  an imported copy has not been used there yet.

- **`provenance`: how the knowledge came to be believed, fixed at write time.** `observed`,
  `user_stated`, or `inferred`, accepted on both `knowl_store` and the batch atom path, since
  extraction and session promotion write through the batch. Inferred items take a small ranking
  discount — a discount, never a burial, because an inferred item may still be the only answer.
  NULL on legacy rows means exactly "written before the class existed".

  The motivation is the memory-poisoning literature's central finding: a reflected "lesson"
  reads as authoritative once stored, and the class it was born with is the only surviving
  record that it was ever a guess.

### Changed

- Schema gains `tier`, `tier_since`, and `provenance` on `knowledge_items`, plus a `drift_state`
  table. All additive and column-guarded; no migration step is required.

## 2.8.0 — 2026-07-30

### Added

- **A repository can record what it is, and whether its knowledge is shared by default.**
  `knowl workspace add` stored a name and a path, so a repository's nature — code with private
  internals, notes that are cross-cutting by definition, one of two diverged forks — lived
  nowhere. Every agent re-derived it, and got it wrong the same way each time: one uniform
  "share selectively" posture applied across repositories that do not share a nature.

  `--role` is free text describing the repository, carried in the manifest so an agent that
  joined on another machine has it too. It is never parsed and no behavior is inferred from it.
  `--default-visibility workspace` stamps new writes as workspace-visible, so a notes
  repository stops depending on someone remembering to promote each item; `--promote-existing`
  shares what it already knows in the same command. `--kin` groups repositories of shared
  lineage, and the cross-repo write advisory checks them wider and says what they are — a
  same-subject hit between two forks is likelier a real divergence than a coincidence.

  `knowl workspace set` changes any of the three afterwards, and with no flags prints them.
  Every repository's role and default visibility now appears in `knowl status` and at the top
  of the session-start context block, so an agent has them before its first sharing decision.

  A workspace default is gated at both entry points, because it is standing automatic
  publishing rather than an explicit per-batch promote: it states that sharing cannot be
  undone, that there is no demote, and that turning it off stops future writes only. Absent
  fields mean current behavior, so existing manifests need no migration.

- **`knowl upgrade --all` upgrades and repairs every repository on the machine.** A release
  used to mean visiting each repository by hand: upgrade, run doctor, read the warnings, run
  whichever command each warning named, run doctor again. A repository you forgot drifted
  quietly — schema migrations apply themselves on every database open, but guidance files and
  lifecycle hooks, the two things that change how agents behave, waited for someone to `cd`
  in. The sweep finds every repository, snapshots it, upgrades it, applies the repairs doctor
  found, re-checks, and prints one summary; it exits non-zero if any repository is still not
  ready. `--dry-run` lists what it would visit and changes nothing.

  Repositories are found from workspace manifests and from a registry that `init` and
  `upgrade` now write, so a repository is known to a sweep after one visit — including one
  belonging to no workspace, which nothing outside its own directory knew about before. Pass
  `--root <dir>` once for repositories that predate the registry; what a scan finds is
  remembered.

- **`knowl doctor --fix` applies the repairs it just described.** Doctor already knew the
  exact command for each finding, but only as prose, so acting on it meant reading the output
  and retyping. Findings now carry their repair in a form the CLI can run: guidance refresh,
  the `.knowl/` ignore entry, session recovery, and host re-registration. Findings with no
  safe automatic answer — integrity errors, an empty knowledge store — are reported as
  unfixable rather than quietly counted as handled.

  Two deliberate limits. A host is only ever re-registered if the repository already uses it,
  so a repair can never opt a repository into an agent it did not choose. And re-embedding is
  never automatic, because its cost scales with how much a repository knows; it is reported
  and waits for `--reindex`.

### Fixed

- **`upgrade` now claims knowledge that older versions left unowned.** Joining a workspace
  stamps every item present at that moment with the repository that owns it, but until 2.6.0
  nothing stamped the items written afterwards. Those rows stayed unowned, and nothing since
  went back for them — so the count that stops `workspace remove` from orphaning a
  repository's knowledge did not see them, and the repository could be unlinked as though it
  held nothing. `knowl upgrade` now sweeps them, using the same rule as joining: it only ever
  claims an unowned row, never reassigns one that already has an owner, and does nothing at
  all outside a workspace, where unowned is the correct state. It reports what it claimed.

- **`workspace promote` says what was wrong with your filter instead of "Nothing to
  promote."** Three commands all produced that one line and exited successfully: an id given
  in the short form the listings print, a category that does not exist, and — on Windows — a
  perfectly correct `--category a,b,c`, because `knowl.cmd` runs through `cmd.exe`, which
  splits arguments on commas and left the trailing categories to be silently discarded. Each
  now fails, names the value it could not use, and the Windows one explains the quoting.
  An unknown id refuses the whole command rather than promoting the ids that did resolve:
  promotion has no reverse.

## 2.7.1 — 2026-07-30

### Fixed

- **Writing a few thousand items in one process could crash it.** 2.7.0 added a check for
  knowledge that overlaps a linked repository, and worked out which workspace you were in
  *inside* that check — so every single write re-read and re-parsed the project config. A run
  of 2500 ordinary writes died partway through, at around two thousand, with no workspace or
  vector search involved. The same run completes on 2.6.0. Which workspace you are in is now
  worked out once per process, as it already was for batch writes.

  One consequence to know about: linking a repository to a workspace while a long-running
  process is already going will not be noticed by that process until it restarts. That was
  already true of ownership stamping, and it is now written down and covered by a test rather
  than left to be discovered.

## 2.7.0 — 2026-07-30

Linked repos are now searched by the same code that searches your own, and a write is told
when another repo already covers the same subject.

### Added

- **Cross-repo conflict and duplicate reporting.** Duplicate and contradiction checks only
  ever looked in the repo doing the writing, so two linked repos could hold directly
  contradictory knowledge and nothing noticed. A write inside a workspace now also checks
  the linked repos and names what it found, and which repo owns it. It reports and never
  changes anything: that item belongs to another repo, and only its owner can retire it.
  Both the single-atom and batch writers do this, the batch naming which atom overlapped, so
  five findings do not collapse into "something in your batch overlapped". Bounded to a few
  candidates per repo and never fatal — a repo that cannot be read yields no report rather
  than a failed write. Outside a workspace it costs one check.
- **One retrieval engine, pointed at any repo.** A linked repo was searched by a separate,
  simpler implementation: a raw substring scan, scored without the recency, confidence,
  freshness, category or identifier handling your own results get. So a linked repo's
  answers were ranked by older rules than your own, and every future ranking improvement
  would have had to be made twice. Reads now take an explicit database, so the same code
  runs against any repo.

### Changed

- **Results from every repo are now scored together, in one pass.** Each repo used to be
  ranked on its own and the rankings combined afterwards. That could not work: "how recent
  is this" was measured against each repo's own results, so every repo's newest item scored
  as maximally recent regardless of its actual age. Scoring the combined set removes the
  problem rather than compensating for it, and the cross-repo ranking benchmark improves
  from 0.833 to 1.0 on the non-vector path with no weight added or changed.
- **`knowl query` and the `knowl_query` tool now rank identically.** The command line used a
  plainer keyword search — no vector search, none of the ranking adjustments — while an
  agent asking the same question got the full engine. It also disagreed with itself,
  ranking better inside a workspace than outside one and returning three results instead of
  twenty. Both paths now use the shared engine and the same default.
- **The portable export format is now version 2.** It carries owning repo, visibility and
  the new lifecycle fingerprint. Version 1 files still import, with ownership defaulted,
  which is what a file written before those fields means. A version this build does not
  recognise is refused rather than imported with pieces silently missing.
- **Identical knowledge held by two repos no longer takes two result slots.** It is
  collapsed before the result limit is applied, keeping your own copy, so a shared fact
  cannot shorten the list you asked for.

### Fixed

- **Search could return nothing while a matching answer sat just past its limit.** Results
  were cut to the limit and *then* filtered, so a query whose strongest matches were all
  archived came back empty. Filtering now happens inside the search.
- **A linked repo's private notes could reach another repo.** One of the two search paths
  never received the visibility filter, so items a repo had deliberately not shared could
  come back through a cross-repo query. The filter is now part of the query itself, so an
  unshared row is never read into another repo's process at all.
- **Exporting and re-importing threw away who owned what.** Export wrote the owning repo and
  visibility into the file; import's column list did not include them, so a round trip
  returned everything owned by nobody and private, with nothing reporting the loss.
- **Promoting, retiring or superseding a note could not travel between machines.** Those
  changes leave the text identical, and import compared only the text, so it declared the
  item unchanged and skipped it. A separate lifecycle fingerprint now travels with the item.
  Promotion also records when it happened, without which no other machine could ever prefer
  it.
- **A delete could un-delete itself.** Two places overwrote a deletion's timestamp without
  checking it was newer, so replaying an older delete moved the record backwards. Import
  also now refuses to reinstate something deleted after the export was taken, and says so
  rather than reporting it as already held.
- **"Only one active answer to this" never worked without a scope.** An exclusive conflict
  key with no scope matched nothing and guarded nothing, in both the check that reports a
  conflict and the guard that prevents the write — so fixing one alone would have reported
  the conflict and still allowed it.
- **`--as-of` matched whole phrases instead of keywords.** It found proper candidates, threw
  them away, and fell back to a literal substring search, so a keyword query missed items a
  present-tense query would have found. Both paths now share one candidate list.
- **The database file kept changing after it was closed.** Writes live in a side file until a
  checkpoint folds them in, and closing did not wait for that — leaving the main file in
  motion after the close returned. This is why some environments could not delete a
  project directory immediately afterwards.

## 2.6.0 — 2026-07-29

Agents now find out when memory changes underneath them in a linked repo, and on hosts
that never got told at all.

### Added

- **A change in a linked repo now reaches agents in the repos that can read it.** Change
  notification only ever watched your own repo's history, so when another repo promoted,
  updated, or retired a workspace-visible item, agents working here could read the new
  value through `knowl_query` but were never told it had moved — with no bound on how long
  they could go on trusting the old one. Each linked repo is now tracked separately, and
  the card names the repo a change came from, because a fact from another repo describes
  that repo. A repo-private item is never named, and a peer that is absent or mid-write is
  retried rather than skipped.
- **Change cards now arrive through Knowl's own tool results, not only through hooks.**
  Hosts without a mid-turn hook channel — Claude Desktop, generic MCP clients, and anyone
  running Knowl with no hooks installed — had their change cards computed and then thrown
  away, and could never be told about those changes again. The news now rides back on the
  next `knowl_*` call, which reaches any MCP client. Hosts that already deliver cards
  through hooks are detected and stay on that path, so nothing is announced twice.

### Fixed

- **`knowl workspace promote` left no trace in the project's history.** Promotion is the
  moment an item becomes readable by other repos, and it was the one knowledge event that
  could never be observed after the fact — including by the repos it was performed for.
- **An agent could be told about a change it had just made itself, and could miss one it
  hadn't.** Recognising your own writes was previously a guess based on matching titles, so
  a write's knock-on effects — superseding a near-duplicate, collecting stale items — came
  back to you as somebody else's work, while a genuinely foreign change that happened to
  share a title was silently hidden. Your own writes are now identified exactly, and the
  title guess is only used where that exact information is unavailable.
- **A session started in a repo with no history missed its first change.** The very first
  change committed after such a session began was treated as bookkeeping and swallowed.
- **`knowl workspace promote` could not promote anything written after the repo was
  linked.** Ownership is stamped when a repo joins a workspace, and nothing stamped it
  afterwards, so everything written from then on — the normal case — was treated as
  belonging to another repo and refused, with the misleading message "1 matching item(s)
  belong to another repo". Unowned items are now recognised as this repo's own, which they
  are, and promoting one records the ownership for good.
- **A hook payload starting with a UTF-8 byte order mark failed the whole hook.** Hosts
  send clean UTF-8, but a hook wrapped in a PowerShell redirect on Windows does not, and
  the three invisible bytes made Knowl exit with `expected a value` — no memory capture and
  no change cards, with nothing in the error to suggest the cause.

## 2.5.1 — 2026-07-28

A startup race between Knowl processes could leave the MCP server permanently stuck.

### Fixed

- **The MCP server could get permanently stuck after starting up alongside another Knowl
  process.** Two or more `knowl serve` processes bootstrapping the same project at nearly
  the same moment — several host windows opening at once, or reconnecting in quick
  succession — could make one of them hit a momentary database lock during startup. That
  process then failed every tool call for the rest of its life, even though the database
  itself was fine throughout; reconnecting or restarting the host was the only recovery.
  The lock is now waited out instead of failing instantly, and a startup that does still
  fail no longer leaves a connection abandoned holding the lock open.
- **A locked-database startup failure told you to run `knowl init`.** That's the right
  advice for a project that was never initialized, and the wrong one for a healthy project
  that was just momentarily locked by another process. The two cases now get different
  messages.
- **`knowl doctor` could report `READY` (exit 0) on a project with real problems.** Its
  exit code was set after an unrelated, best-effort check for a newer published version —
  a network call with its own timing — instead of right after the checks that determine
  readiness. A script gating on `knowl doctor`'s exit code could occasionally see success
  for a project that was not actually ready.

### Changed

- **Reading a linked workspace repo's knowledge is now read-only enforced by SQLite
  itself**, not only by which code path is used to open it. A future bug that mistakenly
  wrote through that connection would previously have silently changed a repo you don't
  own; it now fails immediately instead.

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
