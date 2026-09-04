# Changelog

Notable changes to `@dat999zx/knowl`. Versions before 2.1.0 predate this file; see the
[git tags](https://github.com/dat999zx/knowl/tags) for that history.

## Unreleased

**The global memory layer (`~/.knowl/global.db`): personal defaults, project-less sessions, and layered vector retrieval.**

The machine-wide personal-defaults store is now reachable and active:

- **Layered retrieval under vector search.** Previously, the layered reader ran only when vector search was disabled (`!vector?.enabled`). Because vector search is enabled by default, linked external namespaces (such as `global` and `organization`) were written to but never read in normal sessions. Vector search now spans all configured namespaces, with each namespace embedded using its own embedding profile and fingerprint (`namespaceFingerprint`) resolved from its own config root (`~/.knowl` for global/organization, project root for project/session). If an optional namespace cannot be served or embedded, it is skipped and named in `skippedNamespaces`, never silently omitted.
- **`knowl link global [--off]`.** Link a project to the machine-wide store (`~/.knowl/global.db`) to query and store personal defaults alongside project memory. Project answers always outrank global answers on a tie (`RANK: session 1, project 2, org 3, global 4`), interleaved round-robin. Unlinking with `--off` is reversible and preserves the store.
- **`knowl store --namespace global`.** Write directly to the global database from any directory or linked project. Every path passed to `--path` must be absolute (relative paths name nothing in a cross-repository store). Paths on global atoms are provenance notes for readers and are not indexed: impact detection, PR drift, and evidence staleness remain strictly project-store only.
- **Setup outside a repository.** `knowl init` is now runnable anywhere. Outside a repository, it prompts to set up **Project** (a local store, plus the global store if missing) or **Global** (the machine-wide store only). `--global` creates the global store directly without prompting, and `--host-only` configures named agent host integrations without creating any database. Sessions with no project folder (such as Hermes Desktop) resolve to `global` alone (`globalOnlyNamespaces()`).

**`knowl cloud push` can drain a queue again.** Two independent faults could each leave staged
knowledge unsendable indefinitely.

`--yes` passed the strict snapshot check, which refuses when the queue merely GREW since the
snapshot was taken. That check exists to protect what a human read at the prompt, and `--yes`
shows no prompt — so with auto-staging on, any agent writing beside the push (including the
session running it) restaged continuously and every `push --yes` died with "the queue changed
while you were deciding". Strictness now follows the prompt: an addition refuses only when the
list was actually shown. An atom that CHANGED still refuses either way.

A staged id whose atom has since been deleted is now named. The ledger keeps such a row on
purpose so the push can report it, but nothing ever did: `status` counted the row, `push` skipped
it and reported "Published 0 new", and the queue never reached zero with no id to act on. The
push now lists the ids and points at `knowl cloud unstage <id>`, and sends the rest of the queue
as normal rather than refusing over it.

## 5.19.0 — 2026-09-03

Hermes Agent at Claude Code parity: `knowl init hermes`.

**Hermes Agent** is configured through the shell hooks in its own `config.yaml`, which take Claude Code's wire format: `knowl init hermes` writes `mcp_servers.knowl` and one `hooks.<event>` entry each for `on_session_start`, `pre_llm_call`, `pre_tool_call` (matched to `write_file|patch`), `post_tool_call`, `pre_verify`, `on_session_end` and `on_session_finalize`. `pre_llm_call` carries the turn card, `pre_tool_call` blocks a refused write on exit 2, and `pre_verify` — which fires before an edit turn finishes and accepts Claude's `{"decision": "block"}` — carries the capture nudge, so Hermes reaches every capability. Init edits `config.yaml` as a YAML document (comments survive) and never runs `hermes` itself, whose own mutators rewrite the file without comments and can stop on an interactive prompt. Hermes asks for consent once per hook at the terminal on first use; gateway and Hermes Desktop runs need that approval or `hooks_auto_accept: true`. Home is `HERMES_HOME`, else `%LOCALAPPDATA%\hermes` on Windows, else `~/.hermes`.

User-owned YAML config files (`config.yaml`) are merged as documents: every comment survives (comment blocks may be re-indented to sit with their key), the file's line-ending convention is kept, and a file that fails to parse is reported and left untouched. `yaml` is now a direct dependency.

**Antigravity is two products reading two MCP files, and `knowl init antigravity` now writes both.** The IDE's "View raw config" opens `~/.gemini/antigravity/mcp_config.json`; the `agy` CLI reads `~/.gemini/config/mcp_config.json`, which Gemini CLI's migration often leaves at 0 bytes. The adapter had pointed at the IDE file alone, so the CLI's `/mcp` stayed empty. An empty JSON config is now read as "no servers" rather than a parse error, and a JSON MCP target takes a list of files: `detect` reports configured only when every file holds the entry, and `configure` merges into each.

## 5.18.0 — 2026-09-03

Hooks can run on the MCP server the host already holds open, and file evidence can finally
go stale.

**File evidence can go stale, which the README has promised since it was written.**
`isEvidenceStale` compares a file's current hash against the one the evidence recorded, and no
shipped writer ever recorded one: `affectedPaths` became file evidence with `contentHash` NULL, the
one module that hashed files has no importer, and the MCP schema has no field for a caller to
supply one. Symbol evidence went stale; file evidence could not. The obvious fix — hash every cited
path — would have turned an agent's unverified assertion about a file into a staleness claim about
it, and that gate was real. The read-set is now the gate: a cited path some session provably
opened (`work_read_sets` holds a `file://` or `symbol://` row for it, captured from the tool
stream and never from the agent's own report) is hashed from disk at write time; a path merely
declared stays unhashed and never reports stale. One disk read per observed path per write, on the
write path only. `session-evidence.ts` is untouched and still unwired; whether to delete it is a
separate call (#225).

**"Two independent confirmations" now means two days, and the items that had already earned it
are promoted.** The comment above `VERIFY_THRESHOLD` promised independent confirmations; the query
counted rows, so two `knowl_feedback` calls in one turn — one agent, one item, one source — promoted
an item to `verified`. Measured on the project's own store, every item the row count would have
promoted was a burst inside a single session: four useful events in seven minutes on one, two four
minutes apart on another. The feedback path now counts distinct days, the unit the observed-use path
already uses, and neither clears the bar. The second half is the one that matters more: promotion
was edge-triggered only, run at the instant a feedback row was written and never again, so an item
whose confirmations crossed the bar before `knowl_feedback` was wired to standing stayed `asserted`
forever — the store holds one with three useful events against a threshold of two. Session start
now re-evaluates the feedback predicate over every asserted item, capped and audited the way the
observed-use pass is, so the backlog drains instead of stranding (#223).

**Hooks can run on the server the host already holds open, instead of as a process per event.**
Every Knowl hook has been a `command` hook: a fresh `knowl agent-hook` process per event, measured
at ~230ms of Node startup each and paid twice per tool call, serialized against the agent's own
work because the host waits on the pre-tool hook. Over 102 real Claude Code sessions that is 31s
of startup at the median session and 190s at the 90th percentile — while the MCP server sat there
with the database open and the embedding model loaded. Claude Code 2.1.257 and Codex 0.148 can run
a hook as a call to a tool on a connected MCP server, so `hooks.transport: mcp` now writes the
mid-session events as `mcp_tool` hooks calling `knowl_hook` and registers that tool; `SessionStart`
stays a process because both hosts say it fires before servers finish connecting. Opt-in and
`command` by default, because moving costs a catalog entry — MCP has no hidden-tool concept, and a
34th tool against a surface already measured at ~10.5K tokens is paid only by the repositories that
asked for it. The payload travels as `${field}` templates the host fills in, is rebuilt on the
server whichever way the host rendered each one, and then goes through the same allowlist the
stdin path applies, so nothing reaches the handler by this route that the other would have dropped.
Calling the tool while the transport is `command` is refused rather than run, so a client holding
a stale tool list cannot capture every event twice. A write the gate refuses still says why on the
server's stderr, which is where the host writes its MCP log — the same second copy the process
path prints, and worth more here, because a block whose verdict this new transport got subtly
wrong would otherwise be completely silent (#224).

## 5.17.0 — 2026-09-03

The agent sessions running on one machine stop being invisible to each other, and an agent can
ask what its own branch broke.

**A push no longer fails anonymously on an over-long field.** The cloud contract caps `title`,
`source` and `conflictKey` at 500 characters; the local store caps nothing, so a research atom
with a long citation list sat staged until push, where the server's zod rejection came back as
`Too big: expected string to have <=500 characters` with no path and no id — one line per
offender, and no way to tell which two atoms of a hundred were meant short of SQL over
`cloud_published`. The caps are now checked before the request, and the failure names the atom,
the field and both lengths. Not enforced at write time on purpose: `knowl store` is local-first
and works with no cloud account, so a machine that will never push does not answer to the
server's limits (#217).

**`knowl doctor` stops prescribing a fix that breaks publishing.** A repo embedding differently
from its workspace drew a WARN saying the two sets of items were "invisible to each other", with
the remedy "align `search.vector`, then reindex". #191 made the mechanism false — each peer is
searched under its own profile and scored against its own range and floor — and the remedy was
worse than the warning: a cloud-connected repo's atoms must stay on the server's serving
profile, so aligning to the workspace would break every `knowl cloud push`. It is now an OK line
that names the per-profile mode. `workspace add` and `workspace join` still refuse a mismatch,
but say why they actually refuse: a workspace holds one profile so every repo shares one
semantic range, which is a policy choice rather than an invisibility claim (#216).

**The sessions on one machine can see each other, on every host.** Claude Code keeps a registry of
its live sessions and lets one message another, but records nothing about what each is doing —
and every other host records nothing at all — so two sessions hit the same failure and both start
fixing it, and a third changes the hook every one of them is standing on. Knowl now keeps the
other half in one machine-level file, `~/.knowl/fleet.db`: what each session was asked, what it
wrote this turn, its last error, and which problem it has claimed by editing files after seeing
it. Every host with Knowl hooks is in the fleet and they see each other — a Codex session appears
on a Claude session's roster and the reverse — with liveness read from the host's own registry
where it publishes one and from recency where it does not. Only the sessions the host's messaging
can actually reach are offered as something to `SendMessage`; the rest are listed, marked, and
raised with the user instead. `knowl fleet` lists it from any terminal, inside a project or not,
and the `knowl_fleet` MCP tool lists it to an agent — registered unless `fleet.enabled` is
`false`. Two of the four switches ship active, and the line between them is what a surface can
cost you: `fleet.enabled` because the roster prints nothing at all when a session is alone, and
`fleet.cards` (`enforce`) because a card is advice on a channel the agent is already reading and
never a refusal. The two that would cost you something ship quiet — `fleet.digest` (`off`) spends
lines on every turn, and `fleet.nudge` (`shadow`) withholds a stop, so it records what it would
have said until you arm it. `knowl posture maximal` turns the digest on and arms the nudge.

**An agent can ask what its own branch broke.** `knowl pr --since` has always answered "which
stored knowledge does this diff invalidate", and it was CLI-only — so the actor most able to act
on the answer, the one that just wrote the branch, had no way to ask. `knowl_drift` is the same
check as an MCP tool: it takes a base ref, previews by default, and `apply` marks the matches as
needing review. It deliberately does not tell the team, which the CLI does — publishing a
retirement is visible to every member of a workspace, and sending stays the user's to run, the
same line `knowl_cloud` already draws. The automatic session-start check is a different question
and is unchanged: that one asks what drifted while you were away, this one asks what the work you
just did made false, and the diff that answers it does not exist until the branch does.

## 5.16.0 — 2026-09-02

Knowl can be installed from the official MCP registry, and change impact stops being blind to
half of how agents actually read code.

**Knowl is publishable to registry.modelcontextprotocol.io.** `server.json` is the manifest, and
the part worth reading twice is that the registry does not take a publisher's word for ownership:
it fetches the npm metadata for exactly the version the manifest names and rejects the publish
unless that tarball carries an `mcpName` matching the server name. 5.15.0 is on npm without that
field, so the registry would have refused it — this release is the first that carries it, which is
what makes the publish possible at all. `mcpName` and the server name now have to stay equal
across two files forever, so `npm run check:versions` gained `server.json` as a fourth file rather
than the promise getting a gate of its own.

**The read set sees a file opened with `cat`, not only with `Read`.** The read tools were `Read`
and `NotebookRead`; a file opened through the shell arrived as a command string with no paths at
all and hit neither the read branch nor the write branch. That is not an edge case — a host
granted shell access instructs its agent to prefer `cat`, `head` and `sed -n` over the file tools,
and a session working that way recorded **no reads whatsoever**, silently, in exactly the sessions
doing the most reading.

What the parser refuses is most of the design, because a read-set row asserts that a session saw
some text and the `certain` tier spends that assertion by interrupting the agent and refusing its
write. So `grep`, `rg`, `find`, `ls` and `wc` are declined — they return matches or names, not
contents — along with `git show <ref>:<path>` (the agent saw a ref's text; the hash recorded would
be the working tree's), an in-place `sed -i`, any segment carrying a redirect, and any token the
shell would still have expanded. A read piped into anything that reports on the text rather than
passing it on (`cat f | grep x`, `cat f | wc -l`) is declined for the same reason its direct form
is. Shell reads are recorded at file granularity rather than per symbol: the shell says *which*
file was opened and never how much of it, and expanding a slice into one row per symbol would
assert beliefs about signatures that never reached the agent.

**The write gate's own precision is printed somewhere.** The measurement had existed since the
shadow gate did, computing exactly the number the bar in front of enforcing it is written against
— and nothing imported it. Shadow mode was faithfully recording every refusal an enforcing gate
*would* have issued into a table whose verdict no command could read, which is the same defect as
not measuring at all: a score nobody can see cannot promote the thing it measures, and cannot
retire it either.

```
🛡️  WRITE GATE (shadow)
  Refusals withheld:     60
  Adjudicated:           48 of 60
  Precision:             87.5% (6 false positive(s))
  Bar to enforce:        ≥95% over ≥40 adjudicated — not cleared
```

The bar is printed beside the number on purpose: a precision figure alone invites "87% sounds
fine". Both halves fail differently and are reported separately, because 100% over three findings
is not evidence and this block has to say so rather than look like a pass. Nothing has been
adjudicated yet reads as *not yet measured*, never `0.0%` or `100%` — no evidence is not a perfect
score.

**The staleness marker names what to open.** A row whose cited files moved used to report a
condition and leave the reader to diff `affectedPaths` against the working tree to find the
target. Measurement on exactly that situation — a served claim whose source had moved, with the
link present and reachable — found agents opened the source in roughly one turn in five and acted
on the superseded value in about three quarters of the rest, and a content-free freshness cue did
not move those numbers. What moved them was an instruction naming the target, on the path the
reader was already on. So the sentence leads with the verb and the filenames and the count follows
it, capped at three names plus `and N more` so an atom citing thirty paths still reads as one line.

### Fixed

- **A correction elsewhere was promoting the atom it made doubtful.** The session card's three
  knowledge slots were ordered by `updated_at`, which moves on supersession, archival, visibility
  promotion and a freshness flip — 72% of items on a 950-item store carry one newer than their
  `valid_from`. Marking a sibling `needs_review` stamps that column, so correcting one atom
  promoted unrelated atoms onto the next session's card *for having just been flagged as
  doubtful*, evicting whatever that session had actually learned. Housekeeping could take all
  three slots. The card now orders by the open assertion's `valid_from`, which moves on
  restatement and on nothing else; an item with no open assertion still falls back to `updated_at`.
- **A fork was handed a second copy of what it already inherited.** A fork is the one subagent
  that is not context-poor — it inherits the parent's whole conversation, system prompt and tool
  definitions, so the parent's own session card and the workflow rules were already in front of it
  when the subagent bootstrap fired. It now gets neither. Only the context is skipped: a fork's
  reads, writes and tool events stay attributed exactly as any other subagent's.
- A conflict-repair test asserted an order it had never established. Both rows were created by
  back-to-back calls, ISO timestamps are millisecond-granular, and on a fast machine the repair
  fell through to its own id tiebreak — so "newest wins" was decided by which random hex sorted
  first. Failed 9 times in 12 under a forced tie. The production sort is unchanged; it is
  deterministic by construction, which is what its comment always claimed.

### Documentation

- `docs/reference.md` carries the staleness marker's new wording, which its previous text quoted
  verbatim and would otherwise have contradicted, and documents what the shell-read parser
  recognises and — at greater length — what it declines.
- The README feature list gains the shadow write gate's precision surface, alongside the recall
  gap and the un-restated claims report.

### Chores

- GitHub Actions group bumped (`codeql-action` 4.37.8 → 4.37.9, `ai-plugin-scanner-action`
  1.2.533 → 1.2.551) and dev dependencies (`eslint` 10.8.0 → 10.9.1, `typescript-eslint`
  8.66 → 8.68).

## 5.15.0 — 2026-08-27

Knowl can see who it is failing, and stops cutting the card that tells them.

**A subagent in a linked workspace received no skills and no knowledge at all.** Both paths that
build the session card rendered it at full width and let the caller slice the finished string, so
anything charged against the budget first pushed the cut backwards through a section boundary. On a
four-repo workspace the repo list alone is 1,034 characters against a subagent's 853-character
budget: the child got a header, a repo list severed mid-entry, and nothing else. Skills are the half
that cannot be recovered — recent knowledge can be found by querying, but a peer repo's shared skill
is findable only by an agent who already knows it exists, which is exactly the agent who does not.
The card is now **composed** to the budget rather than sliced down to it, so the formatter's own
clamps apply instead of a blind cut. The parent path had the milder form of the same bug: with all
three warning producers at their ceiling, 1,310 characters of warning cut the knowledge section off
entirely.

The cap is no longer optional. An omitted cap used to select the slicing path, which meant three
further callers — the `knowl agent lifecycle session-start` CLI, session-start on a host that
shares its binding, and turn-start before a session binding exists — were still cutting cards
delivered to live agents. There is now no way to ask for a sliced card.

**A subagent's recall is no longer pooled into its parent's.** A subagent shares its parent's
session id, so every child's recall landed on the parent's row and the one population most worth
looking at was the one the measurement could not isolate. `knowl status` now splits the ratio:

```
  Retrieved when held — main thread: 62% (128 held)
                        subagents:   31% (44 held)
```

Printed only when both sides have observations, so a comparison is never made against a population
of one. Additive column, no backfill and none possible — an observation already written cannot be
re-attributed, because the identity was never on it.

**The knowledge no drift check can reach is now dated.** Drift watches files; roughly half the store
cites none. A new `knowl status` block reports how long since anyone last restated those claims, by
category, and names the ones furthest past their own category's cadence. Report only — nothing flips
`freshness`, because for prose there is no evidence a claim became false, only the absence of anyone
reaffirming it.

It ranks rather than flags, and that is what makes it shippable today: a cutoff cannot be calibrated
on a store younger than the cadence it is measuring, but an ordering needs no cutoff and sharpens on
its own. Ranking on plain age was tried and measured degenerate — a store is seeded in one batch, so
an age-ranked list is that seed with every row tied at the store's own age. The ratio to a category
median asks the useful question instead: is this claim unusual *for its kind*.

### Fixed

- The Claude Code plugin registered no MCP server at all.

### Documentation

- `docs/reference.md` covers both new `knowl status` blocks, and the README feature list gains
  the un-restated claims report and the recall gap's main-thread/subagent split.
- Parallel agents in git worktrees share the main checkout's store.


## 5.14.0 — 2026-08-26

Knowl stops charging every turn for work that produced nothing.

One release, four measurements, and the thread joining them is not performance for its own sake:
each of these was paying a recurring cost for an outcome that never arrived. A guidance card
repeated into a context window that already held it. An embedding pass that loaded a model and
then embedded nothing. A pre-tool hook that spawned a process to ask a question only writes can
answer. A counter that split one conversation across two rows and read the fragment.

**The turn-start card follows the drift schedule now.** It used to print the same 613-character
paragraph on every prompt, forever — and because turn-start context accumulates in the transcript
rather than replacing the previous copy, a 40-turn session carried 40 identical copies, ~6k
tokens. It is also a restatement of `KNOWL.md`/`AGENTS.md`, which every host already carries in
its system prompt: `CLAUDE.md` → `@KNOWL.md` for Claude Code, the managed block in `AGENTS.md` for
everyone else. It now lands on the first prompt of a conversation and then follows
`reminders.driftEvery` / `reminders.driftBackoff` — turn 0, 12, 36, 84, 180 — counted in completed
turns. `driftEvery 0` silences it. The command also moved onto the entry's fast path, so it costs
137ms rather than 350ms despite now reading the store.

**Transcript embedding left the hook path, because it was never working there.** `catchUpTranscripts`
charged the model load to the same 1.5s budget it then enforced before doing any work — and a hook
is a fresh process per turn, so the model was never warm and the ~1.8s load alone exhausted it.
The pass found its deadline spent and returned 0, every turn. One real store held **12,598 indexed
messages and 4 vectors**. The turn-stop hook now runs the lexical pass only, which needs no model,
and embedding happens where a model stays warm: the search-time top-up inside `knowl serve`, or
`knowl reindex --transcripts`. The budget also stopped charging setup to the work allowance, which
is what lets the first call in a warm process do anything at all. Measured: `Stop` went **2595ms →
492ms**.

**The pre-tool hook only fires for tools that can write.** `runWriteGate` returns on its first line
when the tool writes no file, so under a `.*` matcher every Read, Grep, Glob, Bash and Task paid a
process spawn and a store open — ~170ms — to reach an immediate no-op. Host profiles gained
`writeTools`; Claude Code declares the four names the fallback already used, and the matcher is
built from that same list, so the gate and the matcher cannot drift apart. Measured over 12 real
transcripts and 1,060 tool calls: 195 are write tools, so **865 spawns never start — 81.6%**.
Cursor and Windsurf keep the wildcard deliberately, because their write rule keys off the event
rather than the tool name.

**One conversation was being counted as two.** `conversationKey` and `turnCaptureKey` built their
key from the raw project root while the session bindings canonicalised theirs, and hosts do not
agree on the case of a Windows drive letter. Three live conversations existed under both
`D:\coding\knowl` and `d:\coding\knowl` at once — one holding 33 turns on one row and 1 on the
other. Capture health, the `turns >= 3` silence threshold and the new turn-start gate all read a
fragment. No migration: the key is recomputed from hook input on every call, so old rows fall out
of the window on their own.

### Upgrading

- **Run `knowl init <host>`.** The pre-tool matcher changed, and `knowl doctor` reports hooks as
  stale until the config is rewritten. `knowl doctor --fix` does it too.
- **If transcript search was already on, run `knowl reindex --transcripts --budget 10` once.** This
  release stops semantic coverage decaying; it does not backfill what never landed.

## 5.13.0 — 2026-08-26

Knowl starts counting what it never asked for, and stops discarding the evidence that something
mattered.

The theme is signals that existed and went nowhere. A no-op duplicate write — an agent reaching a
conclusion the store already held, unaided — was computed and thrown away, though it is the only
positive capture signal in the system. An agent reporting that an item misled it flagged that
item's batch-mates and left the named item untouched. And on the read side there was no signal at
all: nothing measured how often an agent acted on a file the store already knew something about
without ever retrieving it, which is the one failure a session cannot observe about itself.

**New: the recall gap.** On every tool call that reads or writes a file, the touched paths are
matched against active atoms citing them, and one row records whether the store held anything and
whether it had already been retrieved. Read it in `knowl status` under `RECALL GAP`. Nothing is
shown to the agent and there is no configuration key — a count gated behind the feature it exists
to justify can never justify it. It counts *touches* rather than atoms, takes its share over
"held" rather than over every tool call, and prints that it is a lower bound: only knowledge
carrying `affectedPaths` can be matched to a file. Migration level 15, additive;
`KNOWL_SCHEMA_VERSION` does not move and an older build ignores the table entirely.

**Re-derivation now protects memory from garbage collection.** A no-op duplicate write is recorded
as a `knowledge_access` row under a new `rederived` surface, and two of them protect an item from
GC decay the way three retrievals already do. The surface is deliberately separate from retrieval:
`retrievalCount` backs the never-read lens and `isHot`, and quietly widening what it counts would
invalidate every measurement taken against it. The read-side signals cannot see this case at all —
a fact nobody queries for looks cold right up until it matters.

**`knowl_update` can correct a misfiled category.** An item captured as `state` that turns out to
be a standing decision previously had to be stored again and the original retired, discarding its
assertion history, access telemetry and re-derivation count to change one enum. Category is not
cosmetic: it is the only field GC reads to decide whether an item is archivable at all, so the
misfiled copy was precisely the one on the collection path, and the only fix for it erased the
evidence against collecting it.

**A correction now flags the item that caused it.** Reporting that an item misled you demoted its
tier, flipped up to twelve batch-mates to `needs_review` on shared provenance, and left the named
item at `fresh`. Measured on this repo's store: of 14 items that have ever caused a correction, 6
were still active and still fresh. Weaker evidence earned the flag and direct evidence did not.

**An answered question becomes a decision memory.** `session-candidates.ts` has promoted `decision`
session events into decision atoms since the beginning, and a measurement of the live store found
zero had ever been written — the extractor was built and starving. Only the question header and the
label of the chosen option are captured.

**The local embedding model is optional.** `@huggingface/transformers` pulls `onnxruntime-node`,
which downloads a native binary from a postinstall script; an unreachable CDN aborted the whole
install for reasons unrelated to the package. Retrieval already reported `lexical-only` when no
vector half was available, which is the same degraded mode a user who never downloaded the model
was in, so nothing new had to tolerate anything. CI now checks for the rollback explicitly and
retries once, rather than failing three minutes later with `Cannot find package` — which reads like
a bug in the change under test rather than a missing dependency.

**Issue #169 is closed, not fixed.** The relevance floor cannot be tuned to separate on-topic from
technical off-topic queries, and `docs/evals/relative-floor-probe.md` closes the last open
direction: every page-relative signal scores *worse* than the absolute cosine it was meant to
replace, and the store-self-similarity family fails for an arithmetic reason rather than an
empirical one — within one corpus its statistics are constants, so all three variants are monotonic
transforms of the raw cosine and cannot reorder anything. Nothing about the floor's behaviour
changes. The measurement is recorded so nobody spends a week retrying it.

## 5.12.0 — 2026-08-25

Knowl stops claiming more than it can show, and stops silently losing what it can.

Several threads arrived at the same shape in one week. The relevance floor was telling callers a
store lacked an answer when all it can detect is an off-subject question. The reversal detector was
listing candidate contradictions at a rate that only survives as a passing note. Both now say the
narrower true thing, and where no measurement supports a verdict, none is given.

The other half is the opposite failure — machinery quietly doing less than it reported. Cross-repo
search had been keyword-only for any workspace whose repos sat on different Knowl versions, and
every transcript vector was stored missing a quarter of its length. Neither surfaced as an error;
both returned results that looked fine.

**Upgrading with transcript search on? Run `knowl reindex --transcripts`** — the stored vectors are
replaced, and nothing else asks you to act.

Thanks to **[@williamttruong](https://github.com/williamttruong)**, who found or fixed most of what
is below: the conflicts work, #183, the quantization clip, the federation diagnosis, and the
checkpoint.

### The relevance floor says off-subject, not unanswerable

`abstained` and the `NO CONFIDENT MATCH` notice meant **"this question does not look like it is
about this store"**, and said "this store probably does not hold the answer". That second claim is
not something the floor can know, and integrators were building on it.

The measurements behind the correction, both new:

- **No embedding preset fixes it.** On-topic and off-topic cosine distributions overlap on all five
  shipped presets against technical off-subject queries, and the current default,
  `granite-small-en-r2`, has the *smallest* overlap of them — so there is nowhere better to move.
  `docs/evals/preset-floor-sweep.md`, reproducible with `scripts/sweep-preset-floor.ts`.
- **Lexical coverage cannot replace it either.** It is quantized at `1/terms`, so a short vague
  on-topic question lands on the same values as partially-matching junk: `why is startup slow`
  scores 0.500 against a store that answers it in full, and so does `sourdough starter discard
  crumb`. `docs/evals/query-coverage-probe.md`.

Cosine fails because a question in a store's own register is close to it either way; coverage fails
because it is too coarse. Neither is a tuning problem, so nothing here is a new threshold — the
notice, the CLI note, the `abstained` doc comment and a new `docs/reference.md` section now state
the narrow reading and point the caller at judging the results.

### Transcript hits carry an absolute similarity you can judge

It returned hits for input with no semantic content at all — `zzzzz qqqqq xxxxx vvvvv` came back
with plausible-looking history and nothing marking it. The number needed to tell noise from recall
already existed and was being discarded: `semanticRank` computes a real cosine, then Reciprocal Rank
Fusion replaces every score with a total built from *positions*.

`cosine` now survives the fusion, so a caller can tell a strong match from the least bad of five
bad ones.

**The verdict built on it is deliberately switched off, and that is the honest state.** The
machinery is wired — a notice on the typed tool, withholding on the automatic
`search.transcripts.fallback` chain — but its floor is `null`, so neither fires. The per-model
floors are measured over knowledge-atom fixtures, and a floor cannot be borrowed across corpora
any more than across models: applied to transcripts it judged **every** query off-subject,
including ones the archive answers, which through the fallback chain reported "nothing here" over
an archive holding the answer. Arming it needs a measurement on transcript data, and if the classes
overlap there as they did for atoms it stays off.

So transcript search behaves as it always did, except that every hit now carries an absolute
`cosine` you can judge for yourself.

`contributions.coverage` is also published now, for the same reason `cosine` was: it is the one
lexical number that means the same thing in every repo, and it was being multiplied into a
page-relative one before the caller saw it.

### Reversals are raised where you can act on them

A reversal stored under a title unrelated to the item it reverses now gets a **write-time
advisory** — at the moment you write it, with the predecessor named — instead of appearing in a
list you would have to go looking for.

It is deliberately not in `knowl conflicts`. Measured against 101 real title-unrelated
supersessions, the detector fires on **4**, with 45 false fires among active items — about 4%
recall at ~8% precision, and no gate setting exceeds 5.9%. That rate is survivable as a note you can
ignore in passing and not as a list that claims to be a work queue. `docs/evals/reversal-detector-recall.md`,
replayable with `scripts/probe-reversal-recall.ts`.

What `knowl conflicts` *gained* is the half that is exact by construction: pairs whose titles differ
only by polarity tokens. It previously read only `conflictKey`/`conflictExclusive`, set on 3 of 937
active items, so such a pair could appear nowhere at all.

**`knowl conflicts` is also 22× faster** — 1,796ms to 79.5ms on a real 1,033-item store — now that
the scan tokenizes each title once instead of re-tokenizing both inside a predicate on an O(n²) loop.

### Cross-repo search stopped silently losing half itself

**Fixes a silent failure that needed no misconfiguration to reach.** Federation applied *this*
repo's embedding fingerprint to every linked repo's store, so a peer whose fingerprint differed
contributed **no vector candidates at all** — cross-repo search quietly fell back to keyword-only
while still returning rows, which reads as perfectly healthy.

The link-time compatibility check compares provider, model, dtype and pooling. The filter applied
to a peer's vectors compares a fingerprint that *also* covers the embedding recipe version. So two
repos with identical vector config diverge the moment they sit on different Knowl versions, and
nothing re-checks after linking. A cloud-connected repo cannot converge even in principle — its
atoms must stay on the model its workspace serves — so `doctor`'s advice to align was unfollowable
for exactly the repos that needed it.

Each peer is now searched under **its own** profile, ranked against its own scale and judged
against its own floor. Two consequences worth knowing: cosines from different models are never
compared, so a model whose scores naturally run high cannot outrank one whose run low on scale
alone; and a peer whose model cannot be loaded here degrades to keyword-only for that repo rather
than failing the search. Repos sharing a profile still share one range, because their scores
genuinely are comparable.

Cost: one extra forward pass per distinct profile, and both models' weights resident.

Thanks to **[@williamttruong](https://github.com/williamttruong)** for the diagnosis and for
measuring what it cost — 0.5442 against 0.4157 MRR@10 over 160 queries on three corpora, which is
to say the invisible half was also the better-retrieving half.

### Transcript vectors were storing a quarter less than they measured

**Action required if you use transcript search: run `knowl reindex --transcripts`.**

Quantization clipped every component above `6/sqrt(dims)` — 0.3062 for the default model — on the
reasoning that L2-normalised components sit near six sigma of that. True of the average component,
false of the one that matters: `granite-small-en-r2` carries a rogue component near **0.75**, and
clipping that single value cost **25% of the vector's norm** and ~22° of direction.

Nothing caught it because the scoring function documents itself as cosine "since both sides are
unit-length", and the stored side quietly was not. Every transcript score was `cos(q,d) × ‖d‖` with
`‖d‖` ranging 0.69–0.81 across a real 9,000-message archive — a content-independent ±8%
reweighting of the ranking, and a depressed cosine scale on top.

Fixed with a per-vector scale, which needed no schema change: `scale` was already a per-row column.
Old rows are invalidated through a new quantization version folded into the transcript fingerprint,
so an ordinary reindex replaces them — deliberately *not* the shared embedding-recipe version,
which is a cross-repo contract and would have forced a full knowledge reindex for a
transcript-local change.

Found and fixed by **[@williamttruong](https://github.com/williamttruong)**.

### Ask what the session is relying on but never checked

New: `capture.checkpoint`, off by default, armed by `knowl posture maximal`. Every 20 assistant
turns it asks one question — **what is this session currently relying on that it has not actually
verified?** A number taken from a summary rather than the source, a fix called done without
re-running its proof, an attribution never confirmed, one observation generalised into a rule.

It **asks the agent and calls no model**, so it costs nothing and adds no network dependency to the
capture path — which is what let it join `posture maximal` at all. It **never withholds a stop**:
flags are recorded so a durable write settles them, but they are excluded from the gate that can
block, because that gate is for things that happened and a checkpoint fires on a counter.

The idea, the measurements behind it, and the caution that a self-audit is not the same instrument
as the independent judge those measurements used, are all
**[@williamttruong](https://github.com/williamttruong)**'s.

## 5.11.0 — 2026-08-24

Knowl gets a posture. Four recall and capture mechanisms that were previously the maintainer's
private trade-offs are now switches you set, `knowl posture maximal|frugal` moves all of them at
once, and — because a switch nobody can find is not a switch — `knowl config list` prints every
setting Knowl has, what it is set to now, and the exact command to change it. Plus the mid-turn
reminder stops repeating forever, and the entrypoint stops recompiling itself on every run.

Thanks to **[@williamttruong](https://github.com/williamttruong)** for the recall posture (#166)
and the config catalog (#173), and to **[@Adam13y](https://github.com/Adam13y)** for #165.

### `knowl config list` — every setting, its value, and how to change it

Knowl had accumulated more settings than any document listed, most of them off, and nothing told
you which. `knowl config list` is a non-interactive catalog: every setting with its live value, a
one-line description, and for anything currently off, the exact `config set` command that arms it.
`--all` adds preset-derived values and internals. `knowl status` gained a matching line
(`⚙️ FEATURES / N of M on · knowl config list`), and `knowl config --help` now generates the same
registry as a reference.

**Fixed before it shipped:** the three-mode ladders (`impact.gate`, `capture.events`) rendered as
lit while sitting at `off`, so the marker contradicted the value printed beside it, `knowl status`
over-counted what was on, and the `config set` hint — the one job the command exists for — stayed
silent for exactly the two settings whose default is off. Ladders now get a hint like switches do,
offering the first mode *above* off (`shadow`, not `enforce`).

### A recall and capture posture, all of it off by default

Four mechanisms, each independently switchable, plus `knowl posture maximal|frugal` to move the
set. **Schema migration level 13 → 14.** Nothing here changes behaviour on upgrade until you turn
it on.

- **`search.transcripts.fallback`** — a missed `knowl_query` searches the transcript archive itself
  rather than suggesting you do it, and reports `RECALL CHAIN — VERIFIED NEGATIVE` when both stores
  miss. AND-gated on `search.transcripts.enabled`.
- **`pathsChanged` on query rows** — a returned atom says when the files it cites moved after it was
  stored. mtime against `updated_at`, a 2-second grace window, local rows only, and absent entirely
  when nothing moved.
- **`capture.events`** (`off`/`shadow`/`enforce`) — destructive commands and corrections become
  pending lessons that only a subsequent durable write settles. The stop gate has a hard ceiling of
  three blocks per conversation.
- **`capture.scope: 'turn'`** — the silence question asked once per turn, through the mid-turn
  channel, so a query cannot quiet it. Only a durable write does.

### The continuation reminder backs off instead of repeating forever

Measured against a 197-session archive: the mid-turn continuation reminder fired 3,700 times, in
70.6% of sessions, at **~1,750 tokens per session** — 3.5× the guidance card, which has an eval and
a hard character ceiling, while the reminder had no ceiling of any kind.

Its gap now doubles after each delivery — 12, 36, 84, 180, 372 — removing 86% of deliveries.
`reminders.driftBackoff` (default true) turns it off; `reminders.driftEvery` (default 12, `0` for
off) scales the whole sequence. A hard cap of three scored three points better and was rejected
deliberately: it goes permanently silent at drift event 36 and says nothing across the remaining
~2,868 events of the longest session. Backoff never stops entirely, it just stops shouting.

### The CLI starts faster

`module.enableCompileCache()` at the entrypoint, so V8 bytecode for the command surface and
everything it pulls in is cached between runs. Measured here at **41–66ms per invocation** (180ms
against 219–246ms, node 24), which `agent-hook` pays hundreds of times a session — it is a fresh
process per agent tool call.

Guarded twice, and neither guard is decoration: `engines` is `>=22` while the API landed in 22.1.0,
and the cache directory can be unwritable. A startup optimisation must never be what fails a
command. Called with no argument, so the cache lands in `NODE_COMPILE_CACHE` if you set one and in
node's own versioned temp directory otherwise — nothing new appears in your home or your repo.

### Fixes

- **Composite keys are no longer joined on NUL** (#167). Storage was always correct, but the libsql
  driver truncates TEXT at the first NUL *on read*, so a key selected back out of a row was cut to
  its first segment and could never match again — and `SELECT conversation FROM capture_outcomes`
  showed `claude` for every row, making the table look collapsed onto one key when it was not. The
  separator is now the unit separator (`U+001F`), which survives the read path and keeps rows
  greppable. No migration: every reader recomputes the key from hook input rather than round-tripping
  it, so old rows are simply never reached again and expire as the per-conversation counters they are.
- **A path `pathsChanged` cannot resolve is not evidence that its atom went stale.** An unresolvable
  cited path was being read as a change.
- **`rm -rf dist` is a build clean.** The destructive-command classifier tested its exemption against
  the whole command rather than the segment the verb was found in, so `rm -rf node_modules; rm -rf
  /etc/nginx` classified as safe — and it required a separator before the directory name, so bare
  `rm -rf dist`, `rm -rf build` and `npm run build && rm -rf dist` all fired. In
  `capture.events=enforce` that is a blocked stop on essentially every repository that cleans before
  it builds.

### Also

- **Measured: no embedding preset fixes the relevance floor** (#169). All five presets have a
  negative on/off-topic gap against *technical* off-topic queries, and the current default,
  `granite-small-en-r2`, is already the best of them. Reproduce with
  `npx tsx scripts/sweep-preset-floor.ts`; written up in `docs/evals/preset-floor-sweep.md`.
- The HOL Guard scanner runs in CI, scoped to what ships.
- `AGENTS.md` is no longer tracked — it is generated.

## 5.10.0 — 2026-08-23

The viewer stops being a snapshot. `knowl view` now watches the store while it is open and draws
what happens: a retrieval lights the atoms it answered with, a write arrives on a cleared stage, a
retirement goes dark and stays dark. Building it turned up two things that were wrong before it
existed — retired atoms had never been drawn as retired, and one of the two supersede paths never
reached the change log at all.

### The viewer draws live store activity

While a viewer tab is open it polls `/api/pulse` four times a second and animates what the store
did: retrievals ignite their hits in rank order and dim everything else, writes clear the stage and
flare, retirements go out. A caption above each changed atom says which verb it was — `NEW`,
`UPDATED`, `SUPERSEDED` — and a feed at the bottom-left names what happened.

It watches the **database**, not the agent, so Claude Code, Codex, Cursor and a second terminal
running `knowl query` all light the graph identically, and none of them needs to know the viewer
exists. Nothing was added to any write path: the two tables it reads, `knowledge_commits` and
`knowledge_access`, were already written on every write and every retrieval. **With no viewer
running, none of this executes.**

### Retired atoms are drawn as retired

**Behaviour change, visible on upgrade whether or not you ever open a viewer.** The graph never read
an atom's `status`, so superseded, archived, deprecated and rejected atoms rendered exactly like
live ones — full white core, full category halo. On a store of 1,127 atoms that was 124 of them,
11%, asserting on screen that retired knowledge was still in force.

They are now drawn as ash: dimmed, no halo, core in grey rather than white. They stay visible and
still carry their links, because they are the history — they simply no longer claim to be current.
The graph is the only surface that shows them at all; the list filters non-active out and the rail
counts only active.

### Fixed: retiring an atom by id never reached the change log

`knowl_update --supersedeId`, `knowl supersede` and the MCP equivalent wrote the retirement to the
item row and nowhere else. The row was always correct, so retrieval honoured the retirement and
nothing about querying looked wrong — but no `supersede` entry reached `knowledge_commits`, and
everything that reads the change log rather than the row missed it:

- the workspace change notice, so a teammate in a linked workspace was never told an atom they hold
  had been retired, and went on reading it as current
- blast radius, which uses the commit trail to decide what to re-check when something turns out wrong
- `mcp_call_commits` write attribution

Storing with `supersedes:` always recorded both halves in one commit; only the retire-by-id path was
affected. All callers now route through `supersedeKnowledgeItemWithCommit`, which records it.

One consequence worth knowing: a retired atom now stages to a connected cloud workspace, because the
committing path stages. That is the same fix in the sync dimension — a published atom that has been
retired has to reach the team as retired — but it is new behaviour.

## 5.9.0 — 2026-08-22

Knowl reaches every host it can reach. Four new lifecycle integrations, a Codex profile that was
wrong in both directions, a plugin for the one host that cannot be configured, and a proxy for
the protocol that has no hook to register at all — eleven hosts and the ACP registry, up from
five. Plus a `serve` that can start in a repository nobody ran `init` in.

### `knowl serve` auto-initializes an uninitialized repository

Marketplace installs (the OpenHands catalog, MCP directories) launch `serve` with no step that
could run `knowl init` first — so serve advertised its full tool set and failed every call with
"run knowl init", which is what closed OpenHands/extensions#486. Now, in a git repository that
was never initialized, serve scaffolds a minimal store before the handshake and finishes the
adoption behind it, on the tool-call clock the connect deadline allows.

Narrower than init on purpose: no guidance files, no agent setup, no model download — and the
anchor is the repository root, never a bare working directory. A directory with no git
repository, or one whose store would land in the machine's Knowl home, is refused and gets the
ordinary not-initialized guidance; a failed scaffold gets its own message rather than advice to
run the thing that just failed. The ignore entry is a self-ignoring `.gitignore` inside
`.knowl/` (venv's shape) — serve edits no file the user owns. The banner and the instructions
card both announce what was created and where. `KNOWL_DISABLE_SERVE_AUTO_INIT=1` turns it off.

A repository that ships its own `.knowl/skill-trust.json` is refused as well. That file is what
approves a skill package for execution, and it lives in the repository beside the bytes it
vouches for — so a checkout can arrive carrying both. `knowl init` may adopt such a repository,
because a person ran it; auto-init is a host process that chose nothing, and it must not be the
step that turns a planted `.knowl/skills/` into a runnable one.

### GitHub Copilot, OpenHands, Antigravity and Windsurf

Full lifecycle on all four: session bootstrap, capture, the change and CODE IMPACT cards, and —
where the host has a channel for it — the `impact.gate` write refusal and the `capture.nudge`
stop.

Each hooks file is written in the shape its own vendor documents, which turned out to matter more
than anything else here. Copilot needs `"version": 1` and camelCase events, and denies with a
**flat** `permissionDecision` rather than Claude's nested one. OpenHands puts its events at the
**top level** with no `hooks` wrapper. Antigravity nests a hook *name* above the event.
Windsurf takes a flat command list with no matcher and refuses on **exit code 2** with no JSON
verdict at all. A hooks file in the wrong shape parses without error and fires nothing, so every
one of these was read off a vendor reference rather than inferred from the host next door.

Copilot alone treats any unexpected non-zero exit as a denial, which inverts this codebase's
failure direction — everywhere else a broken hook allows the write. The hook entry now withholds
its own error status there, so a Knowl crash degrades to "nothing was recorded" instead of
blocking somebody's edit.

### Codex declares the events it has, and retires two it never had

Verified against the shipped `codex.exe` 0.147.0: `PreToolUse`, `PermissionRequest`,
`permissionDecision`, `UserPromptSubmit` and `SessionEnd` are all present, and
`PostToolUseFailure` and `StopFailure` are not. The profile had it backwards — two handlers for
events no Codex build implements, sitting in every `.codex/hooks.json` Knowl ever wrote, and no
pre-tool event. Codex reaches full parity: prompt card, write gate and capture nudge, through the
same envelopes as Claude Code.

Existing configs are swept on the next `knowl init codex` or `knowl doctor --fix`. Nothing removed
retired handlers before, because the merge copied unknown keys through and `verify` only looked
for what was missing.

Codex hooks remain behind `[features].codex_hooks` and do not run on Windows, so the MCP guidance
card keeps its conditional wording for that host rather than claiming its hooks own the session.

### Cursor gains a write gate and a capture nudge

Both were previously recorded as impossible, on two premises that are true and neither of which
supports the conclusion. Cursor has no `beforeFileEdit`, which is not the same as having no
pre-tool event: `preToolUse` fires before every tool with `tool_name` and `tool_input`. And its
`stop` cannot block, but it returns `followup_message`, which Cursor submits as the user's next
message — reaching the model is what the nudge requires; blocking never was.

Cursor also populates a read-set for the first time, so it can receive a CODE IMPACT card at all.
Registering `preToolUse` does mean a hook process before every tool call; Cursor's config format
has no matcher to scope it with.

### Cline, through a plugin

Cline's hooks are TypeScript objects loaded into its runtime, so there is no file `knowl init`
can write. `integrations/cline/knowl-plugin.mjs` maps its method calls onto the same
`knowl agent-hook` entry point every other host uses. A local path, not a package — point Cline
at it and there is nothing to publish or keep in version step:

```js
ClineCore.start({ pluginPaths: ['./node_modules/@dat999zx/knowl/integrations/cline/knowl-plugin.mjs'] })
```

### `knowl acp` — Zed, JetBrains, Neovim and Kiro

The Agent Client Protocol's traffic runs agent-to-client, so there is no hook to register and the
only seat is between them:

```bash
knowl acp -- <agent-command>
```

Every line is forwarded byte for byte, terminator included, and observed on a parsed copy — never
re-serialized, so it cannot reorder a field or drop an unknown one in a stream two other programs
are speaking. `session/update` carries `locations` naming the files a call touched and `kind`
declaring whether it read or edited, which is the agent's own classification rather than something
recognised after the fact.

It does **not** answer `session/request_permission`, so there is no write gate on this lane.
Answering means selecting one of the `PermissionOption`s the agent offered, a shape the published
schema names without enumerating — and guessing there resolves a prompt the person was meant to
see, in their editor, with an answer Knowl invented.

### The capture nudge reaches hosts with no stop hook

It rides a tool result, the way the change card already does, so Claude Desktop, OpenCode,
Windsurf, Zed and any unlisted MCP client get it. A host whose hooks can carry it stands down, so
nobody is nudged twice. Still `capture.nudge = enforce` only, still off by default.

### `knowl serve --host <host>`

`knowl init` writes it into each host's MCP config so the guidance card can state that host's
lifecycle mode outright, instead of handing every agent the same conditional and leaving it to
work out which branch applies. The MCP `initialize` card is captured before the client handshake,
so the client's own identity arrives too late to read.

Existing configs without the flag keep working and keep the conditional card. The entry
comparison tolerates its absence deliberately: a strict match would have reported every install
written before this release as unconfigured and invited `doctor --fix` to rewrite working files.

### Removed

The Gemini CLI adapter. The host is discontinued upstream, and the adapter was instructions-only —
`.gemini/settings.json` plus a `GEMINI.md` import line, with no hook channel. Antigravity replaces
it. **`knowl init gemini` now fails**; any existing `GEMINI.md` is left on disk, because deleting
a file somebody owns on upgrade is not ours to do.

### Fixed

- `knowl init` crashed outright on a zero-byte `~/.gemini/config/mcp_config.json`, which Gemini
  CLI leaves behind. Detection ran with no per-adapter catch, so one unreadable file took all
  nine hosts down before the picker appeared. Detection is best-effort per adapter now, and the
  Antigravity entry points at `~/.gemini/antigravity/mcp_config.json`, which is where a live
  install actually keeps it.
- The impact subsystem consulted Claude Code's tool names for every host, so on any other one no
  read was recorded and the write gate answered "no opinion" before ever consulting the host's
  deny channel. Tool vocabulary is per host now. Codex writes through `apply_patch`; Cursor's
  `afterFileEdit` names no tool at all.
- A `generic` caller's events lost their tool name and kept absolute paths, alone among the
  hosts — so anything integrating over that contract got capture and neither read-set nor impact
  detection, silently.
- `verifyNestedHookConfig` checked Claude's prompt-event key for every host, so merge and verify
  disagreed about which key held the reminder for any host that names it differently.
- The prompt reminder said "Claude hooks own the lifecycle" inside every session, whichever host
  was running.

### Known limits

Copilot, OpenHands, Windsurf and Cline are not installed on the machine this was built on and have
not been run against a live session; the ACP lane is tested against a fake agent pair rather than
a real editor. Every profile is written so that an unverified capability is an absent one, so the
failure mode is "Knowl recorded nothing" rather than a gate that reports blocking a write it let
through — but `impact.gate` and `capture.nudge` are opt-in on every host for a reason, and this is
it. Per-host detail, and which claims are observed versus quoted, is in
[docs/hosts.md](docs/hosts.md).


## 5.8.0 — 2026-08-20

### `knowl reviewed <itemId>` — the verb that clears a review flag

`knowl pr` raises `needs_review` and, on a connected repo, tells the team. Nothing discharged
either, so a workspace could only accumulate reviews with no way to close one. A republish says
nothing about freshness and leaves an open flag standing.

It is a command a person types, deliberately, rather than something an edit does on their behalf:
the remote half sends `expectedVersion`, which is a positive claim about specific text, and
vouching for text the caller did not read is exactly the failure that check exists to prevent.

Local first and unconditional — the flag and `last_drift_at` clear whether or not a workspace is
attached, since a repo that never connected still accumulates drift flags. The upward half
borrows `knowl pr`'s refusal policy: `not-connected`, `not-published` and `gated` are ordinary
states and stay silent. `conflict` is the one worth saying out loud, because the remote text moved
under the reviewer and what they vouched for is no longer what is there.

### Retrieval publishes the raw cosine, the one number a caller can judge with

`score` is min-max scaled across the candidate page, so the top row sits near 1.0 whatever its
similarity actually was. On a small store an off-topic query and a perfect match both publish
0.96, while their cosines are 0.7928 and 0.9296 -- and every surface nonetheless told the caller
to read `score` and judge, with `knowl_query` claiming outright that it "is comparable across
queries". It is not.

Results now carry `cosine` beside `score`: the uncalibrated similarity the relevance floor
already judges by. Published as a **new field** rather than by changing what `score` means, so
anything keyed on the old one keeps working.

### `knowl store` says when part of an atom will not be searchable

The embedding text is capped, by a character slice and by a token budget, and both cut silently.
An author who wrote a 12 KB atom got a vector covering the first two thirds of it and no way to
find out; no caller could reconstruct it either. The write path now names the atom and the real
numbers:

```
Note: embedded the first 7729 of 12487 characters of "Payment reconciler ledger comparison".
The rest is stored but will not be found by search -- split it into smaller atoms.
```

Counted on the combined embedding text -- title, content, reasoning and tags -- because that is
what the cap applies to.

### `knowl view` reads as a graph rather than as confetti

The memory graph was unreadable on a real store, and the reason was measurable: **589 of 1,070
atoms have no link at all**. Running those through the same forces as the 481 connected ones packed
the whole store into one evenly-filled disc, so the structure was buried under its own orphans.
Unlinked atoms now sit on a scattered rim, placed rather than simulated, which also takes 55% of the
nodes out of an O(n^2) force loop.

Everything else follows from being able to see the core at all. Links were drawn at 0.14 opacity --
not faint, invisible -- and are now visible and neutral grey, so the only hues on the stage are the
seven that mean a category. Every atom is one fixed-size dot at every zoom: sizing by degree put the
largest dots in the densest region, and since dots are drawn in screen space, zooming grew them
along with the gaps so the crowding never opened up.

Atoms render as white cores inside category-tinted halos, breathing on roughly a six-second cycle,
each on its own phase and its own tempo. The category is still readable -- it is the colour of the
light -- and overlapping halos show where a kind of knowledge concentrates, which flat coloured dots
never did. The drift lives in the projection rather than in the physics, so the layout stays frozen
and clickable while the render never stops moving.

### Names resolve as you zoom in

Labels used to show for every atom above a degree threshold, which on a real store meant ~60 blocks
of text over the densest part of the graph. They now appear as the camera comes closer, with the
threshold dropping as it does; hover, selection and search still name things at any zoom. Clicking
an atom flies the camera to it and holds it centred, biased for the inspector panel. Label halos are
stroked rather than blurred -- the blur smudged every dot a label passed over.

### A flatter ground

The stage lost its teal radial gradient, which washed one corner a full step lighter than the other
so identical atoms read as different colours depending on where the layout dropped them. Grounds are
darker and less blue than the docs site's, since that palette carries prose and this one carries a
thousand saturated dots; hue family and every accent token are unchanged. The rail is narrower and
flat, controls share one radius, and the list's title column takes the slack instead of stranding
Category, Age and Reads against the far edge.

### Removed

Two `EvidenceType` members, `command` and `url`, that nothing ever produced or read. Evidence
staleness only ever handled `symbol` and `file` and returned false for everything else, so the
two were reachable by hand-writing the string and by nothing else.

## 5.7.0 — 2026-08-20

Knowl installs as a Claude Code plugin, and four places that described the product incorrectly
now describe it correctly. No schema change, nothing removed.

### Installable as a Claude Code plugin

A `.claude-plugin/plugin.json` at the repository root makes the repo itself installable, the same
whole-repo layout the marketplace uses for other external plugins. The manifest wires one MCP
server — `npx -y @dat999zx/knowl serve` — so an install gets the full tool surface with no
credentials and no build step. Validated with `claude plugin validate .`, the command the
directory's CI runs.

### The no-AI notice said conflict detection was off, one line above doing it

`knowl decide` without an AI provider printed *"Falling back to direct insertion without conflict
detection"* and then, on the next line, reported a superseded predecessor. Both cannot be true.

Same-subject reconciliation is deterministic and runs regardless; what a provider adds is
contradiction detection **across** subjects, where the new atom does not name the thing it
invalidates. The notice now says that, and only appears alongside `Left active beside …` — the one
outcome where a configured provider might have reconciled instead. On the common path, where the
predecessor was retired cleanly, the provider's absence changed nothing and the line was noise.

That wording had a measurable cost. It was read as *"supersession needs an API key"*, which is
false, and that misreading reached the README before being caught. It was also the loudest line in
the recorded demo, arguing against the feature the recording exists to show.

### Documentation that contradicted the code

Five comments across `drift-auto.ts`, `host-lifecycle.ts`, `schema.ts` and `tier.ts` still said the
drift check leaves `freshness` alone. It has passed `apply: true` since 2026-08-13 — one of them
sat 88 lines above the call that contradicts it. Two atoms in this project's own store were
faithful transcriptions of those comments, and a session read them, concluded a shipped feature did
not exist, and said so. Documentation drift became memory drift.

The reference now also states the consequence of its own reconciliation threshold: a title needs
two significant tokens to reconcile, so `"Database choice"` supersedes cleanly later and
`"Use SQLite"` does not (`use` is a stopword). The example in the docs used the failing shape.

### Version drift is checked rather than remembered

`.claude-plugin/plugin.json` carries the version by hand and nothing kept it in step — the same
shape as the demo Dockerfile that stayed pinned to `3.2.2` while users installed 5.5.0. The
lockfile guard became `npm run check:versions` and now covers the manifest too. It caught the
drift on this release, which was the first one after it was written.

The README demo was re-recorded from a tarball packed out of the checkout rather than an npm pin,
so it cannot fall behind the repository it sits in again.
## 5.6.0 — 2026-08-19

A person can now read, correct and add memory by hand — `knowl view` became an editor, and two new
commands make the store browsable from the terminal. Plus two changes to what a stored atom is
allowed to lose.

### The local viewer is an editor, and it opens on a list

`knowl view` served a force-directed canvas and answered nothing but `GET`. On a real store that is
unusable in both directions: several hundred atoms averaging around two thousand characters cannot
be found by hunting a dot in a physics simulation, and once found, nothing could be corrected.

There is now a list beside the graph with three lenses. **Unread** is the one that earns its place —
it sorts by never-retrieved, oldest first, which is how you find memory you would never search for,
because you cannot search for what you do not know is there. Clicking a row opens the atom with its
evidence and timeline, and the panel carries **Edit**, **Archive** and **Restore**; `+ New memory`
writes one by hand. Archiving is reversible and Restore sits on the same panel. Permanent removal
stays with `knowl forget`, which asks first.

Atom bodies are markdown and were being printed as source, so on a real store most of the memory
read as literal asterisks and pipes. They render now — bold, inline code, tables, lists, headings —
escaped before any markup is applied, so no atom field can introduce an element or an attribute.

Writes are refused unless the request names this viewer as its origin. `SameSite` is not sufficient
here and reasoning that it is would be a mistake: it does not scope by port, so a page served from
any other `127.0.0.1` port is same-site with the viewer and the browser attaches the cookie
unprompted.

The graph also says less. A tag that dozens of atoms share is a category, not a relationship, and
drawing it as edges buried the mesh that meant something; atoms nothing else is about are now left
unlinked rather than tied to an arbitrary neighbour. On a 675-atom store that took 1,556 links down
to 484.

### `knowl list` and `knowl edit`

`knowl query` searches, which requires knowing what you are looking for. `knowl list` browses:

```bash
knowl list --unread --limit 20     # what nothing has ever retrieved, oldest first
knowl list --stale --category fact
```

`knowl edit <id>` opens one atom in the viewer and prints a deep link. It accepts the eight-character
id `knowl list` prints, and names the candidates when a prefix is ambiguous.

### A commit with no body is no longer stored as knowledge

The session finalizer minted an atom from every `git commit` it found in the captured commands. With
no body, that atom's content is its title — it consumes a retrieval slot to repeat what the slot
already showed. Measured on one real store: 48 of 226 commit-derived atoms were exactly that.

Commits with bodies are still captured, and `git commit -m "subject" -m "body"` — git's own way of
writing one — is now read correctly rather than reported as having no body at all.

Two further changes cover what a stored atom is allowed to lose. One is about delivery — a long body
arriving with its conclusion cut off — and the other about the write path, where a claim could be
retired by its own negation.

### A truncated body keeps both ends, not just the head

Atom bodies here are written with the verdict last: `CONSEQUENCE`, `THE FIX`, `THE LIMIT OF THIS
EVIDENCE`. Delivery truncation was a head slice, so it systematically handed over the setup and
dropped the finding — and the caveat that had to travel with it went with the rest.

That would be recoverable if the `truncated` flag were acted on, and mostly it is not. The withheld
tail was not being declined; it was going unread, which is exactly the case a head slice makes
invisible.

An over-long body now keeps a 60/40 head and tail around a marked elision. **This is not a ceiling
change and does not spend a single extra character** — the budget is identical, and only which
characters survive it moves. `MAX_ITEM_CONTENT_CHARS` stays at 2,000 for the reasons recorded when
it was set, and reading an item whole by `id` still returns it whole.

Applied to the three surfaces that hand a stored body to an agent: `knowl_query` results, the
`knowl://category/{name}` resource, and `knowl_task_start`'s relevant memory. Titles, tags and
`affectedPaths` deliberately keep the head slice — a path with its middle removed is not a shorter
path, it is an unusable one.

### A claim can no longer be retired by its own negation

Write-time supersession judges whether two atoms share a subject by testing whether one title's
significant tokens are contained in the other's. None of `not`, `no`, `never` or `longer` is a stop
word, so an affirmative title was a strict subset of its own negation and the test fired. "Push gate
blocks default branch" retired "Push gate no longer blocks default branch", in whichever order the
two writes happened to arrive, and the survivor then asserted the opposite of what it had retired
with nothing said about it.

Two titles that differ only by polarity are now left to coexist. The incoming atom is still
inserted, the predecessor stays active, and the pair is reported through the near-duplicate channel
that already hands back the exact retire call — so an agent that means to retire the other one says
so, and an explicit `supersedes` is never second-guessed.

Deliberately narrow. Ambiguous stems (`can`, `won`, `don`) are left out: a missed negation costs
what it already costs, while a false positive costs a supersession the caller then has to make by
hand. The numeric case that similar guards elsewhere are built around does not exist here — digits
survive tokenization, so `768` is simply absent from a title saying `1024` and the two already
coexist.

**Provenance deliberately does not gate supersession.** A second guard was proposed alongside this
one — refuse to let an atom with no provenance retire one claiming `observed` — and it was dropped
on measurement rather than on principle. Replayed against 101 real supersessions it blocked 3, and
all three were legitimate corrections, including one whose entire point was that the measurement it
replaced had been defective. Unset provenance is not a weak claim; it is what most writes look like.

## 5.5.0 — 2026-08-19

Pushing to a workspace got slower the more memory a repository had, and the reason was never the
amount of knowledge — it was how many times the client knocked. A backlog went as five requests
where one would do, and an atom nobody had edited was sent anyway.

### A routine backlog is one request instead of five

`MAX_BATCH` was 20, sized against roughly three seconds per atom of embedding that the server used
to do inline and synchronously inside the publish request. It no longer does: embedding moved to a
background worker that runs after the commit, and a client that brings its own vector is never
re-embedded at all. The number was answering a cost that had already been removed.

The binding constraint now is the server's 2 MB body limit, **not** the 200-item cap in the
publish contract. Measured against a real store — atoms averaging about 2 KB of text, 384-dimension
vectors arriving as about 2 KB of base64 — an atom is roughly 5 KB and at worst 12 KB, so 100 per
request lands near 500 KB and worst-cases at 1.2 MB. A ninety-atom queue stops being five round
trips and becomes one.

That raise is what makes an oversized body reachable at all, so the retry that used to answer only
a timeout now answers a 413 as well. Both failures mean the same thing to a client holding a queue
— send fewer — and both are safe to retry smaller, because the server upserts by item id and a
rejected body committed nothing. Nothing else is retried: a secret rejection is still terminal,
never retried and never retried in altered form.

### An atom nobody edited is no longer re-sent

The ledger recorded which atoms had been pushed and what version the server gave them, but never
what they *said*. So an atom re-staged into byte-identical text was indistinguishable from a real
correction, and went anyway — spending a version bump the server applies unconditionally, which
then reaches every replica on its next pull. One redundant push was a round of sync traffic for
everybody.

`knowl cloud push` now settles those without sending them and reports how many, and
`knowl cloud status` counts the same way, so the two agree on one number.

Both the content hash and the lifecycle hash have to match. That second half is load-bearing:
`status` and `freshness` live in the lifecycle hash, so comparing content alone would read a
**retirement** as an unchanged atom and strand it locally — a worse failure than the redundant push
this removes.

Migration level 12, adding two nullable columns to the publication ledger. There is no backfill and
that is deliberate: the skip requires a recorded hash, so every atom staged before this release is
still sent exactly as it would have been. `KNOWL_SCHEMA_VERSION` does not move, so a 5.4 build
opens a 5.5-touched database unchanged.

### Note

The matching server-side change ships in knowl-cloud, where a publish is now a fixed four
statements regardless of how many atoms it carries, rather than about five per atom against a
remote database. Neither half requires the other, but a backlog is fastest with both.

## 5.4.1 — 2026-08-18

Three fixes to the places where Knowl decides *which* memory it is talking to, and whether an agent
believes it can talk to Knowl at all. The worktree one is the largest: until now, every agent an
orchestrator fanned out into an isolated checkout was silently cut off from the repository's memory.

### A git worktree reaches the repository's memory instead of reporting no project

`.knowl/` is gitignored, and `git worktree add` materialises tracked files only — so a linked
worktree is a checkout of an initialized repository that carries no marker anywhere inside it.
Placed beside the main checkout, which is where orchestrators put them, every command failed:
`knowl doctor` reported NOT READY and `knowl query` exited non-zero. Not a degraded result, a hard
error.

That was the whole of the parallel-agent case. Claude Code's `isolation: "worktree"`, and every
orchestrator that fans agents across isolated checkouts, produce exactly this shape — so the agents
that most need shared memory were the ones guaranteed not to have it. It stayed hidden because a
worktree placed *inside* the main checkout already worked, the ordinary ancestor walk climbing out
into it.

When that walk finds nothing, Knowl now resolves the repository's shared git directory and looks
again from the main checkout. It is a fallback, never a first step: a Knowl project nested inside a
larger git repository still resolves to itself, and a repository whose main checkout was never
initialized still refuses rather than borrowing somebody else's store.

Two things keep it from answering about the wrong repository. Knowl consults git only when it finds
the marker a linked worktree actually carries — `.git` as a *file* rather than a directory — so an
ordinary directory pays a `stat` instead of a subprocess on a path that runs once per agent tool
call. And it strips `GIT_DIR`, `GIT_COMMON_DIR` and `GIT_WORK_TREE` from that call, because git
exports them into every hook it runs: without that, a directory with no relationship to your
repository could inherit one from inside a `git commit` hook and silently read and write its memory.

`knowl init` inside a worktree now says it is a worktree of the repository, rather than describing
it as nested inside one and telling you to move it somewhere it already is.

### An agent is told that a listed tool with no schema is not a missing tool

Some hosts list Knowl's MCP tools by name and withhold their schemas until asked. The guidance said
*"if Knowl MCP tools are unavailable, stop and tell the user"* — which an agent looking at a list of
tools it cannot yet call can reasonably read as its own case. The instructed response to that case
was to stop using Knowl.

The rule now separates the two: load the schema for the name you need and call it, and stop only
when the tools are genuinely absent or when every call fails. Where a host namespaces tools from the
server key, the guidance names the form that resolves rather than the bare name that does not.

Run `knowl init` to pick up the reworded guidance in an existing repository.

### `knowl doctor` sees the MCP configuration `knowl init` writes

The MCP server key was written from one constant and read back from three hard-coded copies.
Renaming it would have left `init` writing a configuration `doctor` could never detect, and
`doctor --fix` re-running `init` forever without converging. Both halves now derive from the same
constant, and a test drives configure → detect → verify across every supported host.

Doctor also no longer says "MCP remains available" when lifecycle hooks are degraded or unsupported.
That claimed the tool surface is a sufficient fallback, and on a host that defers tool schemas it is
not — the messages now name what actually survives, which is the recording rather than the routing.

### Development tooling

`npm run measure:card` prices the guidance card against a real transcript archive, with the writeup
in `docs/evals/guidance-card-cost.md`. Nothing in the published package changes.

## 5.4.0 — 2026-08-15

Mostly a release about knowing what actually happened. Two of these are cases where Knowl told you
something confidently and wrongly: `cloud send` said it was handing over a few atoms while handing
over your skills library and your forget-log, and `doctor` said your knowledge had never been
embedded when an upgrade had just invalidated a perfectly good index. A third said nothing at all —
`cloud receive` crashed before it could collect. The feature is the same theme from the other side:
an atom written across repos now records who wrote it, instead of losing that at the moment it was
created.

If you are upgrading and semantic search has felt worse lately, run `knowl doctor` — it will now
tell you whether a reindex is what you need.

### A send carries the atoms you chose, and no longer your skills and your forget-log with them

`knowl cloud send --id <one atom>` sealed the selected atom — and also every learned skill package
in `.knowl/skills`, file contents inlined, and every tombstone in the store.

`exportKnowledge` gained an item selection for `send`, and the selection reached the item records
and nothing after them. Skill packages and tombstones were appended unconditionally. For
`knowl export` that is correct, because a backup means everything. For `send` it is not: send hands
a few atoms to one person, and that person is explicitly someone who may share no workspace with
the sender.

So a one-atom send to an outside collaborator disclosed the sender's entire learned-skills library,
file contents and all, plus the full forget-log — which atoms were destroyed, when, and whatever
free text the deletion reason carried. A tombstone holds no title, so the second is narrower than
it first looks, but it is still a record of what somebody decided to remove, handed to a person who
was given none of it.

It went unnoticed because the first real end-to-end send was made from a repository that happened
to have no tombstones and an empty skills directory, so the bundle was correct by accident. Any
repository with learned skills would have shipped them all.

A selection now governs the whole stream rather than only the part where it was easy to apply. The
guard is on "was everything asked for", not on the item list being non-empty, so selecting nothing
still exports nothing instead of widening to everything. `knowl export` is unchanged and still
carries both. If a send ever wants skills, that should be a flag somebody asks for rather than a
default nobody sees.

### `knowl cloud receive` collects again, and the two irreversible prompts became a menu

`knowl cloud receive <code>` could not collect anything. It peeked the mailbox, printed the sender
and the atom count, and then died:

```
From: a colleague · 1 atom(s) · expires 2026-08-18T05:22:28.087Z
Receive failed: confirm is not defined
```

`knowl cloud send --query …` failed the same way at the same point. Both called a bare global
`confirm()` — a browser API that does not exist in Node — so both threw a `ReferenceError` on the
one path either command is ever actually used on. Nothing was lost: the crash landed before the
claim, so a bundle that failed to collect was still sitting there afterwards. But the only way
through was `--yes`, which is the flag that skips the question, and answering a question you were
never asked is not the interaction these two commands wanted.

**Why nothing caught it.** `tsc` was reading `confirm` as legitimate. The project set `target`
without setting `lib`, and a transitive dependency's `/// <reference lib="dom" />` pulled the whole
DOM into scope, so every browser global typechecked clean inside a CLI. `lib: ["ES2022"]` is now
explicit and the bare call is a compile error — verified by putting the original line back and
watching `npm run typecheck` fail on it, where before it passed. The tests missed it for a second,
compounding reason: every test drove these commands with `--yes`, which skips the branch entirely,
so the defect was only ever reachable by a human at a terminal.

**Both prompts are now a two-option menu**, matching the settings picker rather than a y/n:

```
◆  Collect it? This can only be done once.
│  ● Decline (the code still works until it expires)
│  ○ Accept (import the atoms and spend the code)
```

Decline is listed first and preselected, so the answer a bare Enter gives is the answer that costs
nothing, and the irreversible option is never under the cursor on arrival. Ctrl-C is a decline.
Spelling both outcomes out is worth more here than anywhere else in the CLI: one of these spends a
code that cannot be re-collected, and the other seals atoms to a person on a fuzzy `--query` match.

`--yes` still exists and still skips the menu. What changed is what happens without a terminal:
rather than treating silence as consent, both commands now say what they would have done and exit
non-zero, so a script that only meant to peek at a bundle cannot spend it.

### Doctor says when an upgrade invalidated the vector index, instead of calling it never embedded

`fingerprintProfile` hashes the embedding recipe and the batching policy alongside the model, so a
recipe change invalidates its own rows rather than leaving them matching a space they are no longer
in. Retrieval filters on that same fingerprint. Both halves are right, and together they mean a
release can take a fully embedded store to zero reachable vectors at once, without the user doing
anything at all.

Doctor counted those rows as unembedded — correct, since search cannot read them — and then
described them with the wrong sentence: *"only 23 of 747 active item(s) are embedded … Nothing
embeds these retroactively."* Every one of the 724 was embedded, and a reindex is exactly what
repairs them. The reader was told the opposite of both facts, and the natural conclusion — a broken
embedder, or a model that never downloaded — sends them looking in the wrong place.

Measured on a real machine upgrading across 5.0.0: **1,100 of 1,639 vectors, three repositories'
entire indexes, went invisible on the version bump** and semantic search silently fell back to
keyword for three days.

The check now separates the two conditions, because two different things can be wrong at once and
only one of them is something the user just did:

- rows embedded under an **earlier recipe** — named as such, with the note that re-embedding
  restores every one, and without the "nothing embeds these retroactively" line that is untrue of
  them
- rows that were **never embedded at all** — the original wording, unchanged

Severity is unchanged: a majority uncovered still fails, a tail still warns, and the remedy is
`knowl reindex --vectors` either way.

### An atom written across repos records who wrote it

5.3.0 let an agent do a linked repo's work by naming it on the call. The write lands in that
repo, stamped as its own — which is right, because it governs that repo, and that repo promotes
and retires it. But nothing recorded that another repo's session authored it, so the fact simply
disappeared at the moment it was created.

`written_by` records it. Subject and author are two different questions, and `origin_repo` only
ever answered the first.

**Null keeps meaning "the owner wrote it"**, which is the ordinary case and the reason the column
is not stamped on every write. Putting a repo's own name on every one of its own atoms would make
the column say nothing on the overwhelming majority of rows, and force a reader to compare it
against `origin_repo` to discover that. It is set only when the two genuinely differ.

Existing knowledge is deliberately **not** backfilled, and here writing nothing is the correct
answer rather than a concession: every row that predates the column was written before a repo
could act as another, so its owner is exactly who wrote it — which is what null already says.

Migration level 11, one nullable column. The compatibility floor does not move: an older Knowl
ignores the column, and a newer one reading null gets the truth rather than a hole.

## 5.3.0 — 2026-08-15

Two ways a linked workspace stops being a wall. Until now a repo could *see* its siblings'
knowledge and do nothing else with it: a federated result carried rows you could not open, and work
that belonged to another repo had to be filed where you were standing or not at all. Both are
addressed here, and both stop at the same line — a repo's private knowledge stays private, and the
tools that can act as another repo are the ones that say so.

### An agent can do another linked repo's work, from here

Pass `repo: "<name>"` to `knowl_store`, `knowl_decide`, `knowl_update`, `knowl_ingest_atoms`,
`knowl_timeline` or `knowl_evidence_list` and that one call runs as the named repo: against its
store, stamped as its own, with its config, its cloud pointer and its ownership rules — exactly as
if it had been run in that repo's directory.

This was never a new capability, only a newly reachable one. `cd ../sibling && knowl store …` has
always worked, because standing in a repo is what the ownership guard checks: an item there is
simply *local*, so the guard is satisfied rather than bypassed. What was missing was a way for an
MCP server — bound to its launch directory for the whole of its life — to do the same thing. The
workaround was to shell out and run the CLI, which works, and is invisible to every rule this
codebase otherwise keeps.

So an agent that had spent an hour on one repo's task, with output landing in another, had to file
what it learned in the wrong place or not at all.

**Full rights, including retiring the target's knowledge.** When you are finishing that repo's
task, the repo is correcting itself, and which folder the terminal happens to sit in is not a fact
about the knowledge. An additive-only version would have left the destructive half reachable only
by shelling out, which is the situation this removes.

Three things bound it. The target is **named, not pathed** — resolved through the workspace
manifest, so a repo has to be linked before it can be acted as. A linked repo with no checkout on
this machine is refused rather than written to, because a repo's evidence paths and git state do
not resolve without a working tree. And `repo` is honoured **only on the tools that declare it**,
which the dispatch reads from the published schema rather than from a list kept beside it. Naming
a repo anywhere else refuses the call and says which tools offer it — notably on `knowl_query`,
whose `repos` filter over shared rows sits one letter away from a rebind that would have read a
linked repo's private knowledge as its own.

Omitting `repo` leaves every call exactly as it was.

### A linked repo's atom can be read in full, by id

A workspace query returns rows from every linked repo, but asking for one of those rows whole —
`knowl_query { id }` — refused, and told you to go and run the command from the repo that owns it.
Reading a federated result therefore meant switching repos, and an agent that had just been handed
an id could not open it.

The refusal was never a permission check. `knowl_query { id }` reads this repo's database, so a
sibling's id was simply not there, and the message explained that absence in terms of ownership.
What ownership actually protects is narrower: `affectedPaths` names files in the owning repo's
checkout, and evidence and its staleness resolve against that repo's database and working tree.
Those fields are what must not cross — not the record.

So the fetch now looks in the linked repos too. A foreign atom comes back whole, with its content,
reasoning and alternatives, and **without** the fields that would be answered against the wrong
checkout — which is what the search path has always done with the same rows. It carries a `foreign`
block naming the repo that owns it, so the omissions read as deliberate rather than as an atom that
cites nothing, and so the agent knows where the item can be changed.

**Only what the repo shares.** A query across a workspace has always read a peer's
workspace-visible rows and nothing else, and fetching by id reaches exactly the same rows. A repo
keeps its private knowledge private until it runs `knowl workspace promote`, and knowing an id is
not a way around that — ids are not secret, they travel in supersession chains and conflict
reports. A private row reports as a miss rather than as a refusal, because "that one is private"
would confirm it exists.

**Reading is all that changed.** Updating, superseding or retiring another repo's item is refused
exactly as before, by the same guard, with the same message.

A miss now says the linked repos were searched too — and says "readable from here", because a repo
that is not checked out on this machine was never asked, and must not be reported as one that
answered no.

### The reference page has a logo you can see

`docs/reference.md` opened with a near-white wordmark on transparent, so on GitHub's light theme
only the cyan `owl` showed and the page led with a floating half-word. It now ships a light variant
alongside the dark one and lets `prefers-color-scheme` choose. The dark original also drops from
329 KB to 118 KB at unchanged dimensions — it is flat two-colour art that was stored as 32-bit
truecolour.

## 5.2.1 — 2026-08-14

### A backlog of staged knowledge can be pushed again

`knowl cloud push` sent the whole queue in one request. Publishing embeds every atom on the server
as it arrives, so a large batch could not finish inside the request budget — and because nothing
was recorded when it failed, every retry re-sent exactly what had just failed. A backlog of forty
atoms was stuck permanently, while nine went through.

The push now sends twenty at a time, and **on a timeout it halves the batch and tries again**
rather than failing outright. That second part is what matters: how long an atom takes on the
server varies by an order of magnitude depending on whether it is warm, so no fixed size is right
for both. A slow server now degrades into smaller requests instead of blocking.

Anything already accepted is recorded before the failure, so running the push again resumes where
it stopped. When a push does give up, it says how many atoms it was carrying and how many are
still queued, instead of naming only the timeout.

### Staging says when an atom was already replaced

`knowl cloud status` could report a number that pushing never drove to zero. Staging skips atoms
that a newer write has retired — correctly — but said nothing, so naming 118 ids staged 109 with
no way to discover what happened to the other nine. Reconciling "118 queued" against "109
published" read as a broken push rather than as replaced knowledge.

`knowl cloud stage` now reports how many named atoms were replaced, and `status` splits the queue:

```
Staged:    118 staged (118 new, 0 correction(s)) on main, not yet sent.
           109 of those can still be sent; 9 were replaced by a newer write after being staged.
```

## 5.2.0 — 2026-08-14

### Guessing a send code is now expensive, not merely improbable

A five-word code is about 2⁵⁵, which sounds like plenty. It was not, because *each guess was
cheap*: both the mailbox id and the sealing key came off the code through SHA-256, so a stolen
database could be ground through on a GPU rig in hours-to-days — inside a bundle's own 24–72 hour
life.

Both halves now derive through **Argon2id at 64 MiB**. A guess costs about a second and a rig's
worth of memory instead of a hash, which takes the whole codespace out of reach. That is why
`send` and `receive` now pause for a moment before they do anything.

Node 24.7 and later use the standard library's Argon2id; Node 22 and 23 use a bundled
implementation that produces byte-identical output, so a bundle sealed on one still opens on the
other.

**Codes minted by 5.1.0 still work.** A receiver looks for the new mailbox first and the old one
second, so an in-flight bundle from an un-upgraded sender is collected exactly as before.

`knowl cloud send --words 6` mints a six-word code, about 2⁶⁶. Worth having alongside the slow
derivation and no substitute for it.

### You can see what you have in flight, and take it back

`knowl cloud send --list` shows your unclaimed bundles and whether each has been collected. Read it
as a detection surface first: **a bundle you never handed to anybody, marked collected, means
somebody else had the code.**

`knowl cloud send --revoke` destroys one early, taking either the code or an id from the list.

### A sender at their quota is no longer told their bundle does not exist

The service reports why it refused a send or a claim, and its list of reasons grows independently
of the CLI. A reason this build had never heard of was being reported as the closest one it knew —
so hitting the in-flight limit read as *"No bundle waiting on that code"* for a bundle that had
just been created. Unrecognised reasons now show what the service actually said.

## 5.1.0 — 2026-08-13

### Hand knowledge to a person, not just to a workspace

`knowl cloud send` seals a few atoms under a five-word code and prints it; `knowl cloud receive`
takes that code and imports them. `push` is *everyone on this team, permanently*; `send` is *you,
specifically, right now* — collected once, and expiring whether or not anyone takes it.

The service cannot read what you send. Your machine mints the code, derives an encryption key and
a mailbox id from it under separate labels, and uploads only the id and the sealed bytes. The code
travels between two humans and is printed once — not stored, not logged, not recoverable.

Both ends need a Knowl Cloud account; neither needs the same workspace. What arrives is marked as
imported, so it can never be published from your repo as your own work.

### Drift detection stopped crying wolf

A file being edited is no longer evidence that anything became false. Measured on a real store,
the detector flagged 339 of 867 active items and only 14 of those cited a file that had genuinely
gone away. It now separates a deletion from an edit, ignores a rename, drops paths that change on
every release, and no longer treats a tag as a file path — 339 down to 14, with the noise cut by
96%. Because what survives is small enough to act on, a surviving candidate is now marked
`needs_review` instead of recorded and ignored, and `knowl pr check` reports it to the team.

### Work-loop checkpoints stopped piling up

A checkpoint is a snapshot of where a task stands, not an entry in a log, so each one now retires
the last and a finished task leaves exactly one atom. Step atoms also carry the task in their
title, where every one of them used to be called `Work Loop checkpoint` whatever it was about.

### Also

- `knowl export` takes an optional set of item ids, so a selection can be exported without
  exporting the store.

## 5.0.3 — 2026-08-13

### Publishing no longer waits for the default branch

`knowl cloud push` refused every send from anything but an up-to-date default branch. That
blocked knowledge with nothing to do with code — pricing research, a vendor decision — on a git
fact that had no bearing on whether it was true.

The gate was specified to apply only to code-coupled atoms, but it was never able to: it received
a project root and never saw an atom, so it produced one verdict for the whole checkout and
applied it to everything in the batch.

It is removed, on the distinction that survives:

> **Publishing adds an atom. Reporting drift retires someone else's.**

Adding from a stale checkout gives the team something merely premature, and `knowl cloud
supersede` and `knowl cloud retract` both undo it. Retiring from a stale checkout destroys what is
still true for everyone current — from a checkout behind the default branch, merged code and
deleted code look identical. Drift reporting keeps the gate for exactly that reason, and
`retract` already sat outside it on the same reasoning.

Two surfaces that reported the gate as the blocker change with it. `knowl cloud status` printed
the refusal verbatim on a feature branch, naming a blocker that no longer exists and sending the
reader to change branch for a push that would have worked; it now reports readiness. `knowl
doctor` warned about staged-but-unsent work *only* when the gate refused, so staged work sat
invisible on the default branch; it now warns whenever anything is staged, and points at `knowl
cloud push`.

Automatic staging no longer skips silently on a feature branch.

**The cost, stated plainly:** an atom published from a branch that is later abandoned stays in the
team store, and a squashed or rebased `sourceCommit` can dangle. Both are staleness rather than
corruption, and `supersede` and `retract` are the remedies.

`docs/reference.md` is corrected in seven places, including a section heading, that described
publishing as branch-gated.

## 5.0.2 — 2026-08-13

### A `cloud` block is not the same thing as a cloud connection

Making `cloud.autoStage` settable in 5.0.1 created a state nothing had seen before. In a
repository that was never connected to a workspace:

```
$ knowl config set cloud.autoStage false
Set cloud.autoStage = false
$ knowl doctor
[FAIL] Cannot read properties of undefined (reading 'trim')
```

The setting is stored inside the `cloud` block, and fifteen callers read that block's mere
presence as "this repository is connected". So the config held settings but no pointer, and
`doctor` printed a JavaScript error where the diagnosis goes — on a repository whose only sin was
setting a documented preference. `cloud status`, `cloud unstage`, auto-staging and auto-push read
the same way.

A repository is now treated as connected only when the block carries both `apiHost` and
`workspaceId`: the two fields nothing works without, one naming the deployment credentials are
keyed by and the other naming what to read and write. Anything less is an unconnected repository,
which is what it always was.

No action is needed. A config written by `knowl config set cloud.autoStage` is valid and stays
valid; it simply no longer claims to be a connection.

### Dependencies

`sharp` and `adm-zip` are forced past the pins `@huggingface/transformers` carries, picking up
patched versions of both.

## 5.0.1 — 2026-08-13

Two surfaces that told you the wrong thing about what Knowl was doing.

### `doctor` no longer reports READY for a store semantic search cannot reach

Unembedded knowledge was an advisory warning printed above `Result: READY`. A Knowl Cloud
deployment sat at 345 atoms and zero vectors for twelve hours reading exactly that way — every
embed failing on a permissions error nobody saw, under a verdict that said the install was healthy.

Vector coverage is graded by proportion now:

| state | verdict |
| --- | --- |
| everything embedded | `OK` |
| a tail unembedded | `WARN` — still reachable by keyword |
| **the majority unembedded** | **`FAIL`** |

The majority rather than zero, because one stray embedded row would otherwise grade a store of 345
items as merely advisory. Above that line semantic search answers from a minority of your knowledge
*while still returning plausible results*, so a partial index misleads in a way an absent one
cannot.

A missing `knowledge_embeddings` table is also `FAIL`, but only when vector search is enabled.

**If you gate CI on `knowl doctor`**, it exits 1 on `NOT READY`, so a repository in this state will
now fail where it previously passed. `knowl reindex --vectors` fixes it. An empty project, a
project with vector search off, and one running `KNOWL_DISABLE_WRITE_EMBEDDING=1` are all
unaffected — a chosen gap is not a problem to report.

Every other check was reviewed and deliberately left advisory: `code_symbols` and `memory_sessions`
schema, stale sessions, `.gitignore`, host instructions and lifecycle hooks, and all cloud and
workspace states. None of them makes a repository's own stored knowledge unreachable, which is the
line between the two.

### Two settings that existed but could not be set

`knowl config set cloud.autoStage false` was documented in 5.0.0 and answered `Unknown config key`.
`updateCheck.enabled` had been readable, defaulted and unreachable for longer. Both work now, and
`knowl config` lists them.

The rest of the `cloud` block stays deliberately unsettable: `apiHost`, `workspaceId`,
`workspaceName`, `repo` and `remote` are a pointer written by `knowl cloud connect` *after* it
authenticates, not preferences. Hand-editing them aims a repository at a workspace it never
authenticated against — every later command looks connected while every push fails.

`knowl config get` now answers with the effective value instead of `undefined`. Four settings are
kept out of the default config on purpose, so in an ordinary repository the file says nothing about
them, and `get cloud.autoStage` reported `undefined` for a repository that does stage as it writes.

Update checks are documented for the first time, including the two environment variables that
disable them (`KNOWL_NO_UPDATE_CHECK`, and the cross-tool `NO_UPDATE_NOTIFIER`).

### Internal

`ProjectConfig` and the config editor's field list were two hand-maintained enumerations of the
same shape with nothing connecting them, which is how both settings above went missing. A guard
test now requires every setting to be either editable or listed with a reason for not being.
The deprecated `project` block is gone from `ProjectConfig`; it had been stripped from configs on
every load for some time, so declaring it described a field the product did not have.

## 5.0.0 — 2026-08-13

A command surface that had grown feature by feature, and contradicted itself in seven places. A
command named `publish` that did not publish. `workspace` meaning both a set of linked local repos
and a cloud tenancy. A CLI that could only append to or hard-delete team knowledge while the server
had supported patching and superseding all along.

**This release removes commands. There are no aliases.** A removed name exits 1 and prints where it
went, which is a signpost rather than a redirect:

```
$ knowl publish
`knowl publish` moved to `knowl cloud stage`.
```

### Every cloud verb lives under `knowl cloud`

`login`, `logout` and `publish` leave the top level; `publish` becomes `stage`, because staging is
what it does — it marks a pending set that `push` drains, which is `git add`, not `git commit`.
That is also what makes bare `workspace` unambiguous: nothing cloud-shaped sits beside it any more.

New: `cloud workspaces` lists what you can reach before connecting. `cloud unstage` takes an atom
back out of the queue. `cloud autopush` records standing consent to send without a prompt — **per
machine, never in `.knowl/config.json`**, so one person cannot enable irreversible publishing for a
whole team by committing a file.

`cloud login` no longer re-runs device authorisation for someone already signed in, and
`cloud connect` offers a picker instead of refusing when you belong to more than one workspace.

### Knowledge stages itself

Connect a repository and knowledge written from then on is queued for the team as it is written.
Nothing is sent by that — a separate `push` does that, still gated on the default branch, and it
now shows what it is about to send and asks first.

Three ways to say "not this one": `knowl store --local` at write time, `cloud unstage` after the
fact, `cloud unstage --forever` to stop it recurring. Agents get the same choice through
`local: true` on `knowl_store`.

A push binds to a snapshot of exactly what it displayed. With staging now continuous, a
long-running agent can change the queue between the prompt and the answer; a changed atom refuses
rather than being sent unseen.

### Local verbs are the only verbs

There is no parallel cloud vocabulary for editing knowledge. Correct an atom locally and, if it is
published, the correction re-stages itself. `retract` stops being the only way to unsay something
and becomes the last resort it should always have been.

### The rest

`knowl store`, `knowl park` and `knowl handoff` exist for humans, not only for agents. Five groups
that wrapped a single leaf became one word each: `index-code`, `symbols`, `eval`, `access`, `pr`,
`evidence`. A bare `workspace promote` or `cloud stage` opens a picker with the categories worth
sharing already ticked, rather than refusing until you name them.

Vectors now travel both ways with the cloud: the client embeds once and sends the vector, and pull
returns vectors instead of making every machine re-embed the same team knowledge. Requires
knowl-cloud v0.3.1 or later.

Migration level 10 adds `cloud_excluded` and `cloud_published.stage_state`. `KNOWL_SCHEMA_VERSION`
stays 1, so a 4.x build can still open a database a 5.0 build has touched.

### Fixed

- A junctioned or symlinked transcript archive reported "Indexed 0 transcript message(s)" and
  exited 0, silently skipping the whole corpus.
- Drift now watches affected paths git cannot diff, so an atom pointing at an untracked working
  directory stops reporting itself fresh forever.
- Cloud failures exit 1 rather than 127. `process.exit` during embedder teardown aborted with a
  native assertion, and 127 conventionally means "not found".
- A profile mismatch that differs only by recipe no longer tells you to switch to the model you are
  already using.
- `cloud connect` and `cloud workspaces` sent an expired access token instead of refreshing it,
  so an hour after signing in the onboarding command reported the credential was invalid.
- A bare `cloud stage` named `promote` in its refusal — a real but unrelated command.
- `cloud stage --apply` that matched nothing no longer asks you to pass `--apply`.

## 4.2.0 — 2026-08-11

Memory that is present but never surfaced, memory that is never written at all, a second harness's
transcripts sitting on disk unread — and the cold start, where a fresh install has an archive of
past sessions beside an empty store and no way across.

Then a sweep over the code that arrived with them, which found two ways a transcript could be lost
without anything being said, and one way an ordinary `knowl init` could fail on Windows.

### Transcripts can become knowledge, through a review step

The index made past sessions searchable and put nothing in the store, so a fresh `knowl init`
stayed empty until somebody wrote to it. `knowl transcripts extract` distils indexed sessions into
staged candidates; `knowl transcripts candidates`, `approve` and `discard` decide what becomes
memory.

**Nothing is promoted by extraction.** Candidates land in `transcript_candidates` and stop there.
A first run over a real archive produces on the order of a thousand atoms, and an unreviewed corpus
of that size would be answering every future query while nobody had yet decided any of it was true.
Approval is the act that puts an atom in front of a query, and it is separate, explicit, and per
candidate.

**It costs the operator money, and the command says so before spending any.** `extract` prints the
session count, the character estimate and the provider it would call, then stops unless `--yes` is
passed. The default limit is 10 sessions, not the archive. A session that has been extracted is
watermarked so a rerun never pays for it twice — including one that yielded nothing, since the
sessions most likely to yield nothing are the short ones and they would otherwise dominate the bill.
A session whose extraction *fails* is deliberately not watermarked: a provider hiccup is not a
verdict about that session.

Three bugs found by building it, each fixed:

- **Approval was secretly AI-dependent.** It went through `runDecisionPipeline`, whose `runVerify`
  calls the model to adjudicate against existing items in the same category. That works on an empty
  store and throws `AI provider has not been initialized` on the second atom of the first bulk run.
  It now uses `storeKnowledgeAtomsDeduped`, the same writer `knowl_ingest_atoms` uses — which also
  turned out to be the path that persists `provenance`.
- **A bogus category reached the store.** A `not-a-category` atom was written to `knowledge_items`
  intact, where every reader downstream assumes the enum. Validated at promotion now.
- **Secret patterns were not being passed.** Approval called the writer without `config.security`,
  running the weakest available validation on the one input most likely to contain a key — a
  transcript is a recording of a working session, and working sessions paste credentials.

Promoted atoms carry `provenance: 'inferred'` and `source: transcript:<harness>:<session>`. They
were distilled by a model from a conversation nobody re-read at approval time; claiming `observed`
would rank them above knowledge somebody actually verified.

### A query miss now names the cold start

`NO CONFIDENT MATCH` already pointed at `knowl_transcript_search` where transcripts were enabled.
Where they are *not*, it said nothing — so an empty store could sit beside hundreds of indexable
sessions and never mention it. It now names the config (not the tool, which that build genuinely
does not expose), and only when an archive is actually on disk. The probe is two `stat` calls and
opens no file: it runs at the moment a query has decided memory is empty.

### Codex sessions are indexed alongside Claude Code's

`knowl reindex --transcripts` read one archive. Measured on the machine that wrote this: **125
Claude sessions and 137 Codex sessions** for this repository — so more than half of its own history
was invisible to transcript search, and a developer who had switched tools would have found the
backfill quietly covering a fraction of their work while reporting success.

Codex needs its own discovery rather than a wider glob, and this is the part worth knowing:

- **Claude Code encodes the project in the directory name** (`d:\coding\knowl` → `d--coding-knowl`),
  so finding this repo's sessions is a directory match.
- **Codex partitions by date** (`~/.codex/sessions/YYYY/MM/DD/rollout-<iso>-<uuid>.jsonl`) and
  records its project *inside* the file, as `session_meta.payload.cwd` on the first line.

So every candidate file is opened. The read is bounded to 8 KB, because `cwd` is written before
`base_instructions` — the system prompt, tens of kilobytes — and reading whole headers for a
477-file archive would be tens of megabytes of I/O to answer a question the first few hundred bytes
settle. A header that does not yield its `cwd` there falls back to reading on to the end of the
line, capped at 2 MB.

`response_item` records are read and `event_msg` is ignored. That is deduplication, not preference:
Codex writes each assistant turn twice, once for its UI stream and once as the item that went to the
model, and indexing both would put every assistant message in the index twice. `reasoning` items are
dropped for the same reason Claude's `thinking` blocks are — they are not what was said — and here
they arrive encrypted anyway. Parser dispatch is on the record's own shape, so no caller needs to
know which archive a line came from.

Two smaller things that follow:

- `<environment_context>` joins the injected-opener list. It opens *every* Codex session, so without
  it the session directory would title all of them with the same boilerplate.
- **Redirecting one archive redirects both.** A caller that passes `projectsDir` no longer gets the
  real `~/.codex` read underneath it. That is not hypothetical: the first version of this change
  made eight existing discovery tests start returning 137 of this machine's real sessions beside
  their three fixtures.

`transcript_files` gains a `harness` column, defaulted to `claude` — not a guess standing in for
unknown data, since every row that predates it was discovered through the only archive discovery
could then reach. No watermark reset, so an existing index keeps working.

### A linked repo's skills now reach the session-start card

Workspace visibility governed *query* reach but not *ambient* reach. `bootstrapAgentSession` filled
its "Available skills" section from `listActiveSkillItems`, which reads the local store only — so a
sibling repo's workspace-visible skill could be found by an agent that already knew to ask for it,
which is precisely the agent that does not know the tooling exists. The knowledge most worth sharing
across a workspace is reusable tooling, and that is the kind nobody queries for by name.

Peer skills now ride the same card as pointers, labelled with the repo that owns them
(`- **mascot-art** (in duckprep, not runnable here) — …`), local rows first, inside the existing
750-character budget. A repo with enough of its own skills degrades to exactly the previous card.

Two things that had to be right, and were not free:

- **A peer skill is forced non-runnable rather than derived as one.** `toSurfacedSkills` reads
  runnability off `source.startsWith('.knowl/skills/')`, and a peer's package carries exactly that
  source — it is a real package, just not under this root. Left to the derivation, peer rows came
  back `runnable: true`, and two things believe that field: `knowl_skill_run` resolves against the
  local root, and `matchSkillForCommand` filters on it, so a peer row could have won the mid-turn
  slot and told the agent to run something unreachable. Trust is the deeper reason —
  `assertSkillApproved` is per-repo, so running a peer's bytes from here spends an approval nobody
  gave.
- **The repo label is priced by the function that renders it.** `selectSurfacedSkills` charges
  `renderSkillRow(skill).length`; a label appended at the render site would have priced one string
  and emitted another.

`listActiveSkillItems` is untouched: it runs on every command tool event and is index-scoped for
that reason, so bootstrap got its own peer lookup rather than a widened hot path.

### The write path can now see what it failed to store

Knowl's write path is all admission control — secret validation, categories, conflict keys, dedup —
and every one of those gates decides what gets *in*. Nothing noticed what should have got in and did
not. The read side had been growing exactly that telemetry (`knowledge_access` records
retrieved-but-never-used); the write side had no twin, and its only detector was a person noticing
afterwards and asking for the save by hand.

`capture_outcomes` now records, per conversation, how many turns it produced and how many durable
writes it made. `knowl status` reports it:

```
🔍 CAPTURE HEALTH
  Sessions recorded:     88
  Stored nothing:        79
  ...and ran long enough to count: 31 (35%)
```

Measurement runs unconditionally; `capture.nudge` decides only what is done with the answer, and
defaults to `off`. `shadow` records the nudge it would have sent. `enforce` withholds one stop and
asks the agent to store what it learned. That is the same `off → shadow → enforce` ladder
`impact.gate` climbs, for the same reason: the number a decision to intervene rests on cannot be
measured by something already intervening.

Four design points worth stating, because each is a place the obvious version is wrong:

- **Turns, not tool events.** The sessions this exists to catch are strategy conversations — long on
  turns, short on tool calls — so any threshold counted in tool events would have excluded exactly
  them.
- **Keyed on the conversation, not a memory session.** A Claude turn binds its own memory session and
  `Stop` closes it, so the next turn gets a fresh one; a counter keyed that way reports one turn
  forever however long the conversation runs.
- **`finalizeMemorySession` reporting `skipped` is not "stored nothing".** It means automatic
  promotion found no candidate, which is true of nearly every conversation and says nothing about
  what the agent stored by hand. Reading it as silence would have fired on the sessions that did
  everything right.
- **There is no non-blocking channel at stop.** A stop hook either withholds the stop and hands back
  a reason, or is not heard; `SessionEnd` fires once the model is gone. So `enforce` costs a turn,
  which is why it is claimed once per conversation before delivery — a block keyed on "stored
  nothing" is a condition the agent may rightly decline to clear, and without the one-shot it would
  fire on every subsequent stop forever.

Reads do not count as writes: a session that queried diligently and stored nothing is the case this
measures.

### Two silent losses in the archive readers

Both sat under comments promising the behaviour the code did not have, so neither was findable by
reading intent.

**A non-ASCII project path lost every Codex session.** The `session_meta` header is read in 8 KB
chunks and each was decoded on its own, so a multi-byte character landing on a read boundary became
two `U+FFFD`. Where the split fell inside the recorded `cwd`, the path came back corrupt, matched no
root, and every session under it was dropped from discovery with nothing said —
`D:\côding\knowl` read back as `D:\c<?><?>ding\knowl`. Bytes are accumulated and decoded once now,
and newlines are found in the bytes, which is safe because `0x0a` cannot occur inside a multi-byte
sequence.

**One deleted transcript ended a whole extraction run.** `createReadStream` succeeds on a path that
does not exist — `fs.ReadStream` opens lazily and reports `ENOENT` by emitting `error` — so a guard
around the constructor caught nothing a real archive produces. `knowl transcripts extract` died on
the first transcript deleted since indexing, mid-run and after the model had already been paid for
the sessions before it. The guard is around the iteration now. A failure *after* a chunk has
arrived is a truncated read of a file that is really there and still propagates: returning a
watermark for it would tell the caller it had seen lines it never did.

An unreadable file and an empty one are also told apart at extraction, so a transcript that is
merely missing is no longer watermarked as "extracted, yielded nothing" — which would have retired
a session permanently on the strength of one failed read.

### The transcript pipeline says what it did, and matches a worktree the way the Claude half does

**`approve --all` stops at 1,000 candidates and now says so.** A first run over a real archive
produces atoms on that order, so the cap lands on precisely the run it exists for, and
`Approved 1000 candidate(s).` reads as completion. It now reports how many remain, counted from the
store after the run rather than derived from the cap. The cap itself is deliberate and stays:
approval writes atoms one at a time through the deduping writer, and an unbounded run over a whole
archive is the worse failure.

**A Codex worktree recorded under an un-resolved path is matched.** A `cwd` is whatever the agent's
shell had, while `git worktree list` answers canonically, and `realpath` only maps toward the real
path — it cannot invert it. The Claude reader already derived that inverse substitution from the
project root as given and as resolved; the Codex reader never got it, so a sibling worktree git
names only as `/private/var/folders/X-wt` matched no session recorded in `/var/folders/X-wt`. Both
readers share one derivation now, which is the fix rather than tidying beside it — keeping it
inside one of them is what let them diverge.

### Windows: an atomic write survives a scanner holding the file

`EPERM: operation not permitted, rename '<file>.tmp' -> '<file>'` was the most frequent cause of a
red Windows run here, and it is not only a test problem: every caller writes a file a user cares
about, so the same moment makes an ordinary `knowl init` or `knowl config set` fail on a machine
with an antivirus. Windows refuses a rename onto a path any other handle still holds, and the usual
holder is a scanner reading the temporary file the write has just produced — so creating the file
is itself what provokes the block.

The rename retries: five attempts, linear 10 ms backoff, ~150 ms worst case. Narrow on purpose —
only `EPERM`, `EACCES` and `EBUSY`, which mean "someone has it open right now". `ENOENT` means the
staged file is gone, which is a bug rather than contention, and `ENOSPC` will not improve by asking
again. The caller's own error is what escapes when the attempts run out.

`credentials.ts` carried a second implementation of the same idea and is now a call to the shared
one. They had already drifted: the shared helper flushes the handle before renaming and that one did
not, so an interrupted credential write could leave an empty file where the other left none.

### Smaller fixes

- **`knowl view` stops on Ctrl-C instead of crashing.** The signal handler was an unawaited `async`
  function, so a failing `close()` surfaced as `ERR_UNHANDLED_REJECTION` — on the one path that
  exists to shut the process down in order.
- **A federated query no longer contradicts itself.** Naming the cloud workspace in `repos:`
  returned the replica's rows *and* reported the id as `unknown`, which is the notice whose whole
  job is to say a name matched nothing.

## 4.1.0 — 2026-08-10

The first release after 4.0.0 met a real cloud workspace, and the first thing it found was that
publishing could not work at all from the repo that wrote the feature.

### `knowl publish` could never stage anything from a linked repo

A repository has two names and both are correct. Local workspace membership stamps `origin_repo`
with the member name from the manifest; `knowl cloud connect` records the git remote identity,
because that is the bucket the server keys publications on. Staging asked the ownership question
with the second and compared it against the first, so **every atom in the repo came back foreign** —
not some of them, every one. Staging four categories on a real store returned 0 items and
`skippedForeign: 566`.

A repo that was both linked into a local workspace and connected to a cloud workspace could not
publish anything by any route: the `--id` path and the category sweep share the filter, and there is
no `--repo` override on `cloud connect` to work around it. Repos that never joined a local workspace
were unaffected, which is why a green suite and a working end-to-end test both missed it —
`origin_repo` is `NULL` there, and the ownership clause claims `NULL` regardless.

The push payload never changed and was never wrong; only the local question was asked with the wrong
name. Both `knowl publish` and the `knowl_cloud` MCP tool are fixed together, and two tests now pin
the linked-and-connected combination, including that a peer member still counts foreign — so the fix
cannot decay into turning the ownership check off.

### The forget log says which rule fired, what survived, and what was destroyed

`knowl gc` recorded *why* it destroyed an item as prose, and prose cannot be aggregated. Three
additions, all read out of Lethe's `forget_log.py` rather than its README:

- **`reason_code`** — a closed set beside the sentence, never replacing it, so "how many were merged
  versus collected cold" is a `GROUP BY` instead of a regex over English.
- **`merged_into_id`** — the survivor as a column. Duplicate collection recorded the winner only
  inside the sentence `Duplicate of <id>`; now `knowl forget-log` prints it.
- **A bounded preview of what was destroyed** — because a purge is a hard delete, and judging
  whether a rule was right usually means seeing what it took. `bytes` still records the real size,
  so bounding the preview loses nothing about cost.

`KNOWL_MIGRATION_LEVEL` moves 7 → 8. The change is additive and `KNOWL_SCHEMA_VERSION` stays at `1`,
so older builds still read the database.

### Stated intent is storable, and every storage cue said otherwise

An agent following Knowl's own guidance skipped storing two consecutive strategy conversations — a
user's declared plan for an entire venture — and the user had to notice the gap and ask. The agent
was complying, not misbehaving: every storage cue on every surface said "verified durable findings",
a conversation verifies nothing, so the filter said skip, twice, consistently.

The `goal` category and `user_stated` provenance exist for exactly that content and the guidance
never mentioned either. Every surface now names the mechanism and carries a decision rule an agent
can actually run — *could a fresh session recover this from memory alone?* The exclusions are
untouched: transcripts, secrets, routine noise. This widens the storable class surgically; it does
not say "save more". A test asserts every cue that reaches an agent names stated intent, because
"verified durable findings" is exactly the phrase someone re-introduces while shortening a line.

The subagent bootstrap card deliberately stays findings-only: a subagent receives a bounded task,
not a user conversation.

### Benchmarks are gated, and so is what CodeQL reads

- **Benchmark invariants** now run before any CR number is trusted, including the check that matters
  most and is the least obvious: each `supersede-off` baseline must leak strictly more than its
  `supersede-on` counterpart. A win measured against a contaminated baseline is not a win, and that
  contamination is invisible in any single results file. Mutation-verified — every check was made to
  fail on purpose before being trusted.
- **`benchmarks/` joins CI.** It sat outside every gate, which is how two type errors lived on main.
- **CodeQL analyses shipped code only**, so alerts describe what users run.

Dependency updates: `hono`, `@hono/node-server`, `postcss`, `fast-uri`, `ip-address`, `tsx`, and the
CodeQL actions.

## 4.0.0 — 2026-08-09

Knowl learns to work with a team. Forty-five commits, almost all of them one feature: a cloud
client that lets several checkouts share one body of project memory, and lets an agent on any of
them answer from what a colleague wrote.

**Why a major.** Nothing here breaks: `KNOWL_SCHEMA_VERSION` is held at `1`, the migration to
level 7 is additive, and every existing command behaves as it did. The number marks the change in
what Knowl *is* — memory that had never left the machine now has a way to leave it — rather than a
compatibility break you need to plan around.

### Knowl Cloud

A workspace is a shared store several repositories publish into. The commands:

```
knowl login                                 # device-code flow, per-host credentials
knowl cloud connect                         # point this repo at a workspace; publishes nothing
knowl publish --category decision --apply   # stage: any time, any branch
knowl cloud push                            # send: only from an up-to-date default branch
knowl cloud pull                            # fetch team knowledge into the local replica
knowl cloud status                          # what is connected, staged, and holding it up
```

Team knowledge lands in a **per-workspace replica** under `knowlHome()/cloud/`, with its sync
watermark stored inside the replica rather than beside it — so deleting the replica is a complete
reset, and a watermark can never outlive the data it describes. Queries read the replica directly
and attribute every row to the repository that wrote it, so a fact from someone else's codebase
never reads as a fact about yours.

**Retrieval never waits on the network.** A query answers from the local replica immediately and a
refresh runs in the background; when something new has landed, the next query carries a
`TEAM UPDATE:` notice telling the agent it may want to look again. There is no path where a remote
call sits on the retrieval hot path.

### Publishing is two-phase, and the gate is the interesting half

`knowl publish` *stages* an intent and sends nothing. The network push happens only once the code
an atom describes is on the default branch, and only from a checkout that is not behind its remote.

Both halves are deliberate. An atom describing code only you have would be false for everyone else,
and being behind the remote is indistinguishable from the code having been deleted — so the client
stays silent rather than reporting a local truth as a shared one. Only code-coupled atoms are
gated: "we chose Postgres" is true when decided and pushes immediately. The gate keys on evidence,
never on category, and it lives entirely in the client because only the client can see the graph.

### `knowl cloud retract` takes something back

```
knowl cloud retract <id> --reason "leaked a customer name"
```

The workspace copy is deleted and a tombstone written in one transaction; the id can never be
published again, and teammates lose the atom on their next sync. This is for knowledge that must
not remain readable. Knowledge that merely stopped being true should be superseded, which keeps
the lineage.

**It is the one upward path with no branch gate.** Publishing and drift reports are gated because
they assert something about code only you have; a removal is true from every vantage, and the case
that brings you here is a secret sitting in a shared workspace right now. Answering that with
"switch to the default branch and pull first" would hold the leak open for the length of a rebase.

`expectedVersion` comes from the local ledger, so if a colleague edited the atom after you
published it the retraction stops with a conflict rather than destroying an edit you never read.

### An agent can see what is shared

New MCP tool `knowl_cloud`, offered only to a repository that is connected. `status` reports the
connection, your role, what is staged and what a push is waiting for, with no network call.
`stage` records an intent and is a dry run unless asked otherwise.

It stops there deliberately: sending, retracting, pulling, connecting and signing in stay yours to
run, and the agent relays the command instead. Both directions across the network are irreversible,
and neither is a decision to make on an agent's initiative.

### Every MCP tool now says when to use it

The guidance card was shrunk on the assumption that `tools/list` already teaches routing. Auditing
all 31 tools showed several that never did — `knowl_context` described what it composed but not
when to reach for it, and left two arguments undocumented; `knowl_conflicts` said to use it "when a
conflict must be resolved" without saying how you would learn one exists. Nine tools gained a
trigger, and the batch writer now says its fields mean what `knowl_store`'s mean rather than
repeating ten descriptions.

### Also in this release

- **`knowl gc` records why an item was destroyed**, not just that it was, in a forget log with a
  level of its own, an owner, and a way to read it.
- **Standing knowledge promotes on observed use**, because the feedback channel it previously
  depended on never fired.
- **Three live prompt injections closed** in the untrusted-content gate — cases the gate drove but
  could not itself see — with the containment guarantee now pinned by a test so a new formatter
  cannot outgrow it.
- **`knowl doctor` reports cloud connection and replica lag.**

### The hosted service is not reachable yet

The cloud client ships to every user whether they connect or not, which is deliberate and matches
`gh` and `vercel`. **But there is no deployed server behind the default host.** `knowl login` and
`knowl cloud connect` will fail with a connection error until there is; everything above was
verified against a local server, including a two-checkout run proving an atom written on one
machine reaching another. Point `KNOWL_API_HOST` at your own instance if you are running one.

Related, and worth knowing before you rely on it: the production browser approval path has never
been exercised, and retrieval counts do not yet flow upward, so team-scale decay has no input.

### Upgrading

Nothing to do. The migration to level 7 adds one table (`cloud_published`) and runs on first use;
`KNOWL_SCHEMA_VERSION` stays at `1`, so a store written by this version is still readable by the
last. If you do not connect to a workspace, nothing in this release changes how Knowl behaves.

## 3.4.1 — 2026-08-08

### The guidance check is line-ending agnostic

Found by running `knowl doctor` on this repository immediately after the change below: it reported
**NOT READY** on a checkout whose guidance was perfectly current. Everything in
`knowl-guidance.ts` composes with `\n`, `core.autocrlf` hands back `\r\n`, and the comparison was
exact — so every Windows clone was stale by definition, with no action that fixed it, because the
next checkout restored CRLF. Survivable while staleness was advisory; not once it blocks the
verdict.

The check now ignores line endings, and a refresh writes back in whichever endings the file
already used rather than converting it. Both halves matter: the second is what stops a guidance
refresh rewriting every line of a CRLF file as a side effect.

Includes one bug introduced by the first attempt at that fix and caught by the same manual run:
composing without normalising to LF first expands each `\n` of an already-CRLF prefix into
`\r\r\n`, so the file never compares equal to itself again. Normalise, compose, convert back — the
order `scripts/generate-docs.ts` already used.

### Stale guidance is NOT READY, and the session says so

`knowl doctor` detected stale `KNOWL.md` / `AGENTS.md` and reported it as a `WARN`. The verdict
gates on `FAIL`, so **doctor said READY while agents were reading instructions this version did not
write** — which is exactly what happened on 2026-08-08, when a `knowl` command run against a stale
`dist/` reverted guidance that had just landed and nothing anywhere said so.

That severity is now `FAIL`. Every other `WARN` here means an optional thing is not configured — no
vector provider, no work loop, `.knowl` not gitignored. Guidance staleness is not optional-anything:
the block between the markers is owned by Knowl and rewritten wholesale, while anything outside it
is preserved, so a difference there is never a preference. The obvious objection — that this flips
installs which upgraded without re-initialising — does not hold: `knowl upgrade` and `knowl init`
both reinstall guidance, so staleness survives neither, and `doctor --fix` already had the remedy
wired.

**The lifecycle hook now warns too, and this is the case that actually bites.** The hook injects its
guidance card rendered from the *running build* while the host reads `KNOWL.md` from *disk*, so a
stale file does not merely under-inform the agent — it contradicts the card inside the same session,
with nothing to break the tie. Session start now leads with a `KNOWL GUIDANCE STALE` line naming
which source is wrong, charged against the context budget rather than stacked on top of it.

The hook warns only when the files are **present and different**, where `doctor` fails on missing or
stale alike. The two are opposite findings: an absent file is one the host never read, so there is
no second version of the guidance to contradict, and "written by a different version" would simply
be false. A project that never ran `knowl init` is `doctor`'s to report, not something to repeat at
every session start.

### `knowl doctor` asks the registry every time

The update check caches for a day, which is right for `knowl status` — run in passing, and a
day-old answer costs nothing. It is wrong for `doctor`, whose entire job is to report what is true
right now. Measured on the day 3.4.0 shipped: the cache was written at 05:14Z, 3.4.0 published at
10:18Z, and `doctor` went on reporting a healthy 3.3.0 for the rest of the day with no way to make
it look again. A diagnostic that cannot be refreshed is one you stop believing.

`doctor` now passes `ttlMs: 0`. It costs at most the existing 2s fetch timeout on a command that
is already deliberate and slow, fails silently offline like every other caller, and still writes
the shared cache so the next `knowl status` benefits from the fresh answer. `status` is unchanged.

A non-positive TTL now disables the cache before any clock is read. The age comparison alone did
not deliver that: `age > ttlMs` at `ttlMs: 0` still served the cache when the write and the read
landed in the same millisecond, so `doctor` could quietly return the cached answer it passed 0 to
avoid. Caught by CI on macOS, where the runner was fast enough to share a tick; ubuntu and windows
both passed and hid it.

### `docs:check` catches drift in KNOWL.md and AGENTS.md

Both files are generated from `src/core/knowl-guidance.ts` by `installKnowlProjectGuidance`, and
nothing verified them: the region check covered `README.md` and `docs/reference.md` only. The gap
let two separate stale-guidance commits through in one day. One was a `knowl` command run against
a stale `dist/`, which rewrote both files from an older build and silently reverted bullets that
had just landed; the other edited `KNOWL.md` and left `AGENTS.md` behind, with `docs:check`
reporting "regions are current" while the two files disagreed with each other and with the source.

`npm run docs:check` now fails on that drift and `npm run docs:generate` repairs it. Compared from
`src/`, never from `dist/` — a stale build is the failure being caught, so trusting the build to
detect it would close the loop on itself. The comparison and the write both match each file's own
line endings, because `installKnowlProjectGuidance` writes LF unconditionally and a checkout with
`core.autocrlf` would otherwise report drift on every run that git cannot see.

## 3.4.0 — 2026-08-08

### Retrieved text renders as data, not as live markdown

Everything in the store is untrusted input, and not because the user is hostile: session capture
and `knowl_ingest` both write atoms no human has read, so a poisoned file comment or a scraped
page can become one. Retrieval then replays it every session, and in a workspace it reaches every
linked repo — OWASP ASI06.

A stored body used to be interpolated straight into markdown. One carrying a fence run, an ATX
heading, a thematic break or a blockquote became **real structure** in the agent's context rather
than a quoted claim. New `src/core/untrusted.ts` contains it two ways, because the surfaces
differ: `fenceUntrusted` opens a fence one backtick longer than the longest run in the body, so
the body provably cannot close its own container, and `inlineUntrusted` collapses whitespace for
one-line contexts — sufficient rather than partial, since every CommonMark block construct must
begin at a line start.

Applied at every surface that reaches an agent with no human in the loop, which is the rule for
finding them rather than which file they live in: the project brain state, the session bootstrap
card, the skill rows inside it, the mid-turn skill nudge, the pending-session handoff and a
parked resume brief. The handoff's `errorMessage` is the sharpest of them — a string from an
external host process, landing in the first thing a fresh session reads.

Also the `knowl://category/{name}` resource, the mid-turn change card, the parked-work listing
and both transcript tools. Three of those sat in modules that were already **partly** contained —
`resources.ts` had fixed its other two routes, `resume-points.ts` had contained the brief but not
the listing that renders the same goal, and `change-card.ts` had been collapsing whitespace in
`renderSignature` while leaving `item.title` on the line beside it. The transcript tools hold the
least reviewed text knowl has: a transcript row is whatever a past session happened to say, tool
output and fetched pages included, and the search response keeps speaking in knowl's own voice
below the hits.

The JSON surface takes the rule in the `knowl_query` description instead of a per-response block:
that response's block count is a contract, where an extra block reports an anomaly, and JSON
already contains bodies structurally.

### The provenance prior scores the absence of a claim

`provenance === 'inferred'` never matched. Censused across five real stores — 1,014 active items
— 72.9% leave provenance unset, 26.2% say `observed`, 0.9% `user_stated`, and zero say
`inferred`. The multiplier had not fired once.

Worse than dead, the incentive ran backwards: unset scored exactly as well as `observed`, so
saying nothing about where a claim came from was free, and labelling your own inference honestly
was the only way to lose rank. It now keys on the absence of a grounding claim, so `observed` and
`user_stated` earn full credit while silence and an honest `inferred` sit together one notch
below. Order-neutral on any corpus with uniform provenance, including both eval suites, so no
measured number moves.

The `knowl_store` and `knowl_ingest_atoms` schemas say so, which is the point: the field's whole
purpose is to be filled in, and the description is the only place a writer learns what filling it
in is worth.

### `workspace add` shares by default in a linked workspace

**Breaking-ish, for new links only.** A repo joining a `linked` workspace now gets
`defaultVisibility: workspace` unless it passes `--default-visibility repo`. The command says a
default decided it and how to decline.

`'repo'` was the *compatibility* default — it preserved pre-workspace behaviour when the columns
landed and nothing read them, which was right at the time. Once workspaces shipped it became a
*policy* default nobody chose, and since promotion has no inverse it only drifts one way: measured
on a real three-repo workspace, to 95% private, with the same rule shared from one repo and
private in its sibling purely by where someone happened to be standing.

Sharing costs little and loses nothing — across 92 cases and five workspace archetypes, pooled MRR
moves 0.9837 → 0.9674 while recall@3 is unchanged to four decimal places
([measurement](docs/evals/share-everything.md)). Answers get reordered, never dropped.

Two limits, both deliberate:

- **Repos already in a manifest do not move.** An absent `defaultVisibility` still resolves to
  `'repo'`. Changing that would publish every linked repo's next write on account of a release
  rather than a decision, and no `--default-visibility repo` could undo it — the bulk publish
  `tests/cli/upgrade.test.ts` already forbids. The new default applies only where a person ran a
  command and read the notice.
- **The default does not satisfy `--promote-existing`.** That still requires an explicit
  `--default-visibility workspace`. Defaulting future writes is small and announced; publishing
  everything a repo already knows is the largest irreversible action here, and a default must not
  stand in for saying it out loud.

The `linked`-mode condition ships unconditional today, since nothing constructs `'shared'` yet. It
is written now because `visibility` is one column on the item, not a per-workspace grant: under
`linked` a shared row means "me, in another directory", and under `shared` the same bit would mean
"another person". Rows written under this default predate any counterparty, so a future `shared`
migration must ask again rather than inherit them as consent.

Everything that told an agent or a reader the opposite moved with it. The "N existing items are
still private" notice suggested re-running `add --promote-existing`, which the guard above now
refuses — it names `--default-visibility workspace --promote-existing`, and a test parses the line
the tool prints and runs it rather than asserting its wording. The guidance installed into every
repo's `KNOWL.md` said knowledge stays private until someone promotes it; it now says visibility is
the repo's recorded default and names the command that prints it, because that sentence is what an
agent consults before deciding a write is safe. The README and `docs/reference.md` said the same
thing on the front page and did not document the flag at all.
### Workspace results say which repo they came from, in the shape of the response

Asking a repo about something it has never touched returned a linked repo's answer in a shape
indistinguishable from its own. Local and peer rows were fused into one flat list, so the `repo`
field on each row was the only thing saying whose answer it was — a quiet field in a JSON array,
set against a standing instruction to use a relevant hit immediately. The field lost.

`knowl_query` and `knowl query` now return results **partitioned by owning repo**. A bare array
means every row is this repo's. An object keyed by repo name means at least one is not, and an
empty array under this repo's own key is the response saying it holds nothing on the subject. A
notice can be skimmed past; a response whose structure is wrong for "this repo's answer" cannot be
read as one.

New `scope` parameter: `local` searches this repo alone and always returns a bare array,
`workspace` searches every sharing repo and always returns a keyed object. `repos` still restricts
to named repos and wins if both are given. An explicit scope **fixes** the shape rather than
deriving it, so a caller who asked for a partitioned view can write a parser against it.

Two notices ride alongside. `LOCAL MISS` fires when this repo returned nothing and a linked one
did, and says the thing a shape cannot — that a foreign fact describes a foreign repo. `WORKSPACE:`
names linked repos that matched and won no slot, by count, never by content, so shared knowledge
stays findable without the notice being able to stand in for it.

**Ranking is unchanged.** `scoreCandidates` is untouched and is not called differently: the same
single-union pass decides which rows reach the page, with the same global alpha, page-wide semantic
rescale and per-corpus lexical normalization. Only the layout changed. Measured on
`cross-repo-archetypes.json`, **18 of 20 cells are byte-identical**; two moved by roughly one case
each (positional polyglot-services MRR 0.9 → 0.8916, semantic monorepo-split Recall@3 1.0 → 0.9722)
because grouping cannot interleave — see `docs/evals/grouping-rebaseline.md`.

An ownership-priority variant, where the local repo filled every slot before any peer, was
implemented and measured first. It collapsed Recall@3 on all five archetypes — asymmetric-trio
1.0 → 0.361 — because `perRepoCap` admits ten candidates per repo whatever their quality, so a
local repo nearly always holds `limit` weak matches and peers never reach the page. That is the
answer leaving the page rather than ranking lower, and it is why attribution lives in the response
shape instead.

The demand ledger records `localAnswered` — how often this repo is asked something only a
neighbour holds, which nothing measured before — and marks a narrowed read with `scope`.

**Shipping as a minor, deliberately.** A workspace query returns an object where it returned an
array, which is a contract change — but the affected surface is narrow enough that a major bump
would misrepresent it. A repo with no workspace is untouched and still returns the bare array it
always has; `resolveWorkspace` returns null and federation is never reached. Within a workspace,
the consumers are agents reading JSON, which adapt to a labelled shape without code changes, and
the labelling is the point of the change. A programmatic consumer parsing `knowl query` output in
a linked repo does need to handle both shapes, and that is the cost being accepted here rather
than hidden: check `Array.isArray` before iterating, or pass `scope: "local"` for the old shape
unconditionally.

### A cross-repo evaluation suite that spans more than one workspace shape

`cross-repo-suite.json` held **three** cases over a single two-repo fixture. That is not enough to
tell whether a ranking change generalises, and the gap was demonstrated the expensive way: a
change measured as a clear win over one real three-repo workspace — 12 queries, 9 unchanged,
every regression accounted for — broke two of those three cases the moment it met a fixture built
by somebody else. The sample was not merely small, it was **narrow**: every query, every label and
every counterexample came from one person's data and one person's judgement.

`cross-repo-archetypes.json` adds **92 cases over 5 workspace archetypes, 15 repos and 121 items**,
each archetype carrying a different failure mode — a split monorepo (vocabulary overlaps by
construction), diverged forks (same name, different meaning), unrelated client projects sharing
generic words alongside a house toolkit that is correct everywhere, an asymmetric big-service /
small-SDK / prose-handbook trio, and four independent services where most cross-repo hits are
noise.

Ground truth was authored **without sight of the ranking rules**, from one question only: *"a
developer in this repo typed this — which item genuinely answers them?"*, with authors explicitly
instructed not to reason about which repo an item lives in. So the labels cannot encode the
preference a ranker is then congratulated for having. Several land against the intuitive answer:
one case's honest answer is a peer's item because the local note explicitly defers to it.

Two things the suite keeps separate on purpose:

- **Privacy is not a ranking metric.** A peer's repo-private row must never be returned, ever.
  That is asserted at exactly zero and computed from the fixtures' own visibility, not from the
  suites' `mustNotReturn` — which mixes the hard guarantee with "this shouldn't crowd the page".
  Merged, a ranking regression could pass as a privacy failure, or a leak hide inside a tolerance
  granted for ranking.
- **Scores are recorded per archetype, not pooled.** A change that lifts the average while
  wrecking one shape is the exact failure this exists to catch, and an average is what hides it.

It found one on arrival. Against 3.3.0 the recorded baseline fails at `polyglot-services`,
semantic MRR 1.0 → 0.975, traced by experiment to 4152c34's min-max rescale of the semantic
half: neutralising `rescaleSemantic` restores 1.0 and leaves every other cell byte-identical,
and the whole positional column is untouched, which is what a semantic-only cause predicts. One
case moves — a query naming a peer service, where amplifying a narrow cosine lead is the
rescale working as designed. Recorded as an accepted cost rather than reverted: 4152c34 won on
the two suites that can discriminate, over 135 and 56 cases, and overturning that on a single
fixture case is the closed-loop reasoning `cross-repo-local-preference.md` exists to warn
against. The reasoning is in the baseline file, so the next drop is still a regression.

### `knowl workspace demand` — what the repos actually ask each other for

A workspace-level ledger recording every cross-repo query: which repo asked, which answered,
how well it was answered, and the query itself where it passes the repo's own secret validators
(a fingerprint always, so demand stays countable even when the text is withheld). Lives beside
the workspace manifest, not in any member repo, and is local to this machine.

"How well" is the best **raw cosine** on the answered page, and withheld entirely where no
semantic half ran. The column exists so a "weak query" threshold can be chosen from its
distribution later, which needs a number meaning the same thing on every row — and the fused
score is not one. Its semantic half is min-max scaled across the candidate page (3.3.0), so the
best row lands near 1.0 whether its cosine was 0.9 or 0.2; with vector off, its lexical half is
normalised against each corpus's own best hit, so the top row lands near 1.0 again. Cosine is
what the relevance floor is measured against, so a threshold picked from this column is
comparable to the shipped per-model floors.

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

## 3.3.0 — 2026-08-07

### Added

- **Change impact detection, off by default.** When one session edits code another session has
  read, the second is told. Detection only — it reports, it never blocks. A finding is emitted
  only when both halves are demonstrable from stored state: a session recorded a read of that
  exact locator, and the locator's hash has moved since. Nothing infers, walks an edge or scores
  a similarity, because this is the only tier allowed to push into an agent's context.

  Enable with `impact.enabled`. It is deliberately absent from the default config rather than
  present and false, so upgrading cannot switch it on. Adds two tables (`work_read_sets`,
  `impact_findings`), a `CODE IMPACT` stanza inside the existing mid-turn card, and the
  `knowl_impact` MCP tool, registered only when enabled. Schema version is unchanged at 1; the
  migration level moves 2 → 3, so older builds still open the database.

### Retrieval

- **The semantic half of fusion now carries the weight it was configured to have.** Fusion is
  `alpha * semantic + (1 - alpha) * lexical` at alpha 0.8, so the semantic term was meant to hold
  four fifths of the ranking authority. It did not: the lexical term is normalised against the
  corpus best and spans nearly all of [0,1], while a cosine does not, because cosines do not start
  near zero. Measured across 135 cases, the semantic swing was 0.086 against the lexical term's
  0.200 — so the term holding 20% of the weight carried roughly 2.3x the authority, and a lexical
  match routinely overturned the best semantic hit. Of five cases where the #1 vector hit failed
  to finish first, all five had no lexical match at all: absence from the lexical arm was being
  read as evidence against.

  The semantic side is now min-max scaled across the candidate page — not divided by the best,
  which would leave the range as compressed as it was. Pages narrower than 0.02 are left alone so
  rounding noise is not amplified into a ranking signal.

  | suite | metric | before | after |
  | --- | --- | --- | --- |
  | semantic (135) | Recall@3 | 0.896 | **0.919** |
  | | MRR | 0.858 | **0.870** |
  | | extreme tier | 0.333 | **0.381** |
  | governance (56) | MRR | 0.989 | **1.000** |
  | retrieval (500) | Recall@10 | 1.000 | 0.998 |

  It wins on the two suites that can discriminate and costs one case on each of the two that are
  saturated. The relevance floor is unaffected — it judges the raw cosine before this scaling —
  and that was checked against a live store rather than inferred: six of six off-topic probes
  refused and six of six on-topic answered, identical on both sides.

### Fixed

- **Windows: a batch shim run through `cmd` no longer loses its own directory, and an argument
  can no longer start a second command.** `knowl task run` hands `cmd /c` a resolved full path
  rather than a quoted bare name, which had left `%~dp0` expanding to the caller's working
  directory — enough to make `npm` die with `MODULE_NOT_FOUND`. Quoting alone does not neutralise
  `& | < > ( ) ^` for a batch target either, because cmd parses the line twice; those are now
  caret-escaped inside the quoted token.
- **Twenty-nine code-scanning alerts closed**, including two incomplete sanitizations and five
  filesystem races. The three that remain are all the same rule firing on `knowl task run`
  spawning a command the caller typed, which is what that command is for.

### Internal

- The module layer graph is enforced by a test rather than by convention, and the last value-import
  cycles are gone, so `core` now depends on nothing.
- Test fixtures moved out of the repository into a per-run temporary root, so a run cannot leak
  fixtures or collide with a parallel one.

The rest of this release is the 2026-08-06 audit: nineteen findings across the CLI, the MCP
surface and the store.

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
