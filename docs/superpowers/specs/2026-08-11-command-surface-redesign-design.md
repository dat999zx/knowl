# Command surface redesign (5.0)

**Date:** 2026-08-11
**Status:** Approved for planning
**Repo:** `knowl` (this one). One section lands in `knowl-cloud` and must ship in the same wave.
**Audit this responds to:** knowledge item `6ebc3abb506540f7`
**Stated intent:** knowledge item `45bc19333671404d`

---

## 1. Purpose

Knowl's command surface grew feature by feature and now contradicts itself in seven places. The
sharpest: **a command named `publish` does not publish**, **`workspace` means two unrelated
things**, and **the CLI can only append to or hard-delete team knowledge** while the server has
supported patching, superseding and flagging all along.

5.0 makes the surface say what it does. It is a naming, routing and wiring release. It builds one
genuinely new behaviour — automatic staging — and everything else is either a rename or the
connection of two things that already exist.

---

## 2. Scope boundary

**In:** the cloud namespace, cloud knowledge lifecycle, status consolidation, CLI/MCP parity,
one-leaf flattening, one new project-config setting (`cloud.autoStage`), one machine-local consent
store (auto-push, §6.2), a `cloud_excluded` table and an explicit stage state on `cloud_published`
(§5.2–§5.3).

**Out, and named in §11 with evidence:** the `session` / `task` / `agent-event` overlap, `knowl
ask`, the three retention surfaces, the transcripts CLI/MCP name split, aliases, and full
unification of the two sharing systems.

**Compatibility budget: unlimited.** The project has no users. Old names are removed outright —
no aliases, no deprecation warnings, no migration machinery. Two things in §10 still ship, but
they are correctness, not compatibility.

---

## 3. The cloud namespace

### 3.1 Every cloud verb moves under `knowl cloud`

```
knowl cloud login       knowl cloud stage      knowl cloud status
knowl cloud logout      knowl cloud unstage    knowl cloud workspaces
knowl cloud pull        knowl cloud push       knowl cloud connect
                        knowl cloud retract
```

`knowl login`, `knowl logout` and `knowl publish` are removed from the top level. Nothing
cloud-related remains outside the group.

**This is the fix for the `workspace` collision.** The local `knowl workspace` group — ten
subcommands for linking repos on one machine — is **unchanged**. Because no cloud verb sits at the
top level any more, bare `workspace` unambiguously means the local one, and the cloud tenancy is
only ever reached through `knowl cloud`. Renaming the local group was considered and rejected: it
is the older concept, and the cloud meaning is baked into the API contract, the web app and the
server schema.

### 3.2 `publish` becomes `stage`, and the name is now accurate

`stagePublish` records an intent and sends nothing; `knowl cloud push` sends. The verb is `stage`
because that is what the operation does.

**`commit` was proposed and rejected.** "Knowledge commit" is already a user-visible Knowl noun —
`knowl status` prints `## Recent Knowledge Commits` (`src/core/format.ts:223`), `docs/reference.md:126`
lists "knowledge commits for governed changes", and the cloud sync feed keys on `knowledge_commits`
and `commit_seq`. Naming a command `commit` would re-create the exact collision §3.1 exists to fix.

The operation is also not commit-shaped. A commit *creates* an object. Staging creates nothing —
the atom already exists in full the moment `knowl store` writes it, and staging only flips ledger
state. The mapping onto git is:

| Knowl | git | what it does |
| --- | --- | --- |
| `knowl store` | `git commit` | creates the durable local object |
| `knowl cloud stage` | `git add` | selects what goes out |
| `knowl cloud push` | `git push` | sends it |

The order is inverted from git — store, then stage — and that inversion is the local-first premise:
knowledge is worth having whether or not a team ever sees it, so the object is created first and the
sharing decision follows. `docs/reference.md:729` already describes the two-phase design as being
"in the shape of git's own index and commit"; this only makes the command names agree with it.

### 3.3 `login` short-circuits

`runLogin` (`src/cloud/login.ts:54`) calls `api.startDeviceAuthorization()` unconditionally.
`readCredential` is not reached until `:78`, after the flow has already run. A signed-in user with a
valid unexpired token is sent through the full device-code and browser-approval dance again.

**New behaviour:** read the credential first. If valid and unexpired, print `Already signed in as
<identity> at <host>` and exit 0. `--force` re-runs device authorization.

### 3.4 `connect` picks interactively

`runConnect` (`src/cloud/connect.ts:43`) already calls `api.listWorkspaces` and its `ambiguous`
result already carries the full `CloudWorkspace[]`. The list exists in memory at the exact moment
the command currently refuses.

**New behaviour:** on `ambiguous`, present an arrow-key picker and connect on selection.

- `--workspace <id>` still resolves directly, for scripts.
- **Non-TTY keeps today's printed listing and non-zero exit.** A picker that blocks in CI is worse
  than the error it replaces.
- `no-workspaces` and `unknown-workspace` are unchanged. Those are distinct situations with
  distinct remedies and `src/cloud/connect.ts:45-53` documents why they were split apart; folding
  them into the picker would undo that.

A browser-based dashboard picker was considered and rejected for now: it needs a new server
endpoint and a callback poll, it breaks over SSH, and the dashboard would display the same names
the CLI already holds. Revisit if the dashboard ever has more to show than a list.

### 3.5 `workspaces` lists without connecting

`knowl cloud workspaces` prints the workspaces the credential can reach. Discovery stops being an
error path that has to be provoked on purpose.

### 3.6 `unstage` is new, and §5 makes it necessary

`knowl cloud unstage <id>` removes an atom from the staging queue — git's `restore --staged`. It is
not optional decoration: once staging is automatic, an edit made without intent to share has no
other exit short of pushing it.

**It must never be implemented as `DELETE FROM cloud_published`.** That row holds `remote_version`,
which is the only copy of the server's version on this machine, and knowl-cloud treats a republish
arriving without `expectedVersion` as a conflict *by design*, so that an older client cannot acquire
overwrite rights by not knowing the field exists. Decision `ba85bbbc98964d68` records that neither
staging path ever clears it. Deleting the row to unstage a correction would therefore make the atom
unpushable afterwards. The state model in §5.3 exists to make this representable.

**Two intents, two commands**, because collapsing them would guess:

- `knowl cloud unstage <id>` — not this time. Clears the pending stage; a later qualifying change
  re-stages normally.
- `knowl cloud unstage <id> --forever` — never. Writes the exclusion state, equivalent to having
  stored the atom with `--local`. Reversed by naming the id to `knowl cloud stage`.

---

## 4. Cloud knowledge lifecycle: local verbs are the only verbs

### 4.1 The gap is in the client, not the product

The CLI can append (`publish`) and hard-delete (`retract`). Nothing else. That is a **client**
limitation:

- `src/cloud/api-client.ts:91` already declares `updateItem(itemId, body: UpdateItemBody)`.
- Server-side, `updateItem`, `supersedeItem` and `markNeedsReview` all exist and all record
  knowledge commits (knowl-cloud constraint `7347c867492e42ae`).
- `freshness` (`fresh` / `stale` / `needs_review`) is already a first-class published field, with
  review-provenance columns and a bug history about preserving it across republish
  (knowl-cloud `eaf29fe9a3df4ee4`).
- Assertions are bitemporal with retained revision history (knowl-cloud `1cef291241d94949`).

The client's `UpdateItemBody` is a narrower subset of the server's patch union — the retraction work
wired exactly one op (`delete`) and stopped.

### 4.2 No parallel cloud vocabulary

There will be **no** `knowl cloud stale`, `knowl cloud supersede` or `knowl cloud deprecate`.
A second vocabulary for the same concepts is how the surface got into this state.

**Local verbs are the only verbs.** Whether a change reaches the team is decided by whether the atom
is published — not by which command was typed.

```
knowl supersede A B          (A is published)  ->  A is re-staged
an atom is marked stale                        ->  re-staged
knowl store --supersedes                       ->  re-staged
knowl cloud push                               ->  sends new atoms and corrections together
```

### 4.3 The re-stage predicate already exists

Decision `ba85bbbc98964d68` records that `restageForPublish` (`ON CONFLICT DO UPDATE ... pushed_at =
NULL, retracted_at = NULL`) is **"the only route a correction has"**, and that `remote_version` is
deliberately never cleared, because the republish it enables is exactly what needs it. Today
reaching that path requires the user to remember to re-stage by id.

**The trigger is `contentHash` or `lifecycleHash` moving.** Both columns already exist on
`knowledge_items`, and per architecture `4bd5aec20a684cc1` the lifecycle hash exists *specifically
because* content-only diffing missed status and supersede changes on import. That is precisely the
class of change this must catch, so no new detection is invented.

Metadata churn that moves neither hash queues nothing.

### 4.4 What stays cloud-only

`retract`, because it has no local equivalent: it destroys the team's copy while the local one
survives. It also keeps its deliberate exemption from the branch gate (decision `22d3a20b85134c22`:
a removal is true from every vantage, and the case that brings someone to it is a leaked name
sitting in a shared workspace right now).

Its role changes. `retract` stops being the only way to unsay something and becomes the last resort
for content that must not exist, with supersede and stale carrying the ordinary cases.

---

## 5. Sharing: publication stays in the ledger

### 5.1 Two independent sharing systems, and they stay independent

| | shares with | state lives in | verb |
| --- | --- | --- | --- |
| local | linked repos on this machine | `visibility` column | `knowl workspace promote` |
| cloud | the team, over the network | `cloud_published` ledger | `knowl cloud stage` / `push` |

Decision `ee191dd7db024bec` established this separation deliberately, and it is **upheld here, not
revised**. `visibility` keeps its exact meaning — `repo` = this repo only, `workspace` = readable by
linked local repos *on this machine* (`src/cloud/publish.ts:27`).

**Reusing `visibility` as the auto-stage filter was proposed during this design and rejected.** It
is the second alternative that decision already lists and dismisses, for a reason that still holds:
it would permanently conflate two different audiences — my other local repos, and my whole company —
behind one verb. Concretely, 171 items on this machine already sit at `workspace` visibility; making
that the trigger would queue every one of them for the company the moment a repo connects.

### 5.2 Exclusions are a sibling table, and staging becomes an explicit state

An earlier draft put exclusions in `cloud_published` as rows with no `pushed_at` and no
`retracted_at`. **That does not work**, for three independent reasons found in review:

1. `listStaged` selects exactly `pushed_at IS NULL AND retracted_at IS NULL`
   (`src/cloud/ledger.ts:99`), so every exclusion row would read as *staged* and be pushed.
2. `staged_at` is `NOT NULL` (`src/store/bootstrap.ts:361`), which an exclusion has no honest value
   for.
3. The primary key is `(item_id, remote_workspace)`. **`knowl store --local` before a repo is
   connected has no workspace to key on at all** — and "never share this" is a statement about the
   atom, not about one workspace.

**Exclusions therefore live in their own table**, workspace-independent:

```
cloud_excluded(item_id PRIMARY KEY, excluded_at NOT NULL, reason)
```

Machine-local like `cloud_published` and `drift_state`, and excluded from portable export for the
same reason: it is local policy that says nothing about the atom's content and must not follow it to
another machine.

**Naming an excluded atom's id to `knowl cloud stage` still stages it.** An explicit act about an
item in hand outranks a standing policy — the same asymmetry `ba85bbbc98964d68` already draws
between naming ids and sweeping categories.

### 5.3 The staging state must be explicit, because `pushed_at` cannot carry it

`restageForPublish` currently signals "staged again" by setting `pushed_at = NULL`
(`ba85bbbc98964d68`). That destroys the record of when the atom was last pushed, so **there is no
value for `unstage` to restore** — which is why unstage cannot be expressed at all against today's
schema without either deleting the row (losing `remote_version`, §3.6) or guessing.

`cloud_published` gains an explicit stage state, and `pushed_at` stops being overloaded as a flag:

| state | meaning | `pushed_at` | `remote_version` |
| --- | --- | --- | --- |
| `pending` | queued for the next push | preserved if ever pushed | preserved |
| `clear` | nothing queued | last successful push, or null | preserved |
| — (`retracted_at` set) | destroyed in the workspace | preserved | cleared, per `22d3a20b85134c22` |

Transitions: stage / auto-stage / re-stage → `pending`. A successful push → `clear`, stamping
`pushed_at`. `unstage` → `clear`, touching nothing else. `unstage --forever` → `clear` plus a
`cloud_excluded` row.

**The invariant that makes this correct: `remote_version` is written once by a successful push and
cleared only by retraction.** No unstage, re-stage or exclusion path may touch it. It is the only
copy of the server's version on this machine, and knowl-cloud treats a republish without
`expectedVersion` as a conflict by design.

`listStaged` becomes `stage_state = 'pending' AND retracted_at IS NULL`. Exact column naming and the
schema migration are the plan's to settle; the states, transitions and the `remote_version`
invariant are not.

### 5.4 No backfill on connect

Auto-staging covers atoms written **after** connect. The existing store is never swept
automatically.

This keeps a promise `ee191dd7db024bec` already made — *"items already at workspace visibility stay
local until an explicit publish. There is nothing to migrate."* Backfilling remains a deliberate
act: `knowl cloud stage --all --apply`, or the existing category sweep.

---

## 6. Automatic staging and syncing

### 6.1 `cloud.autoStage` — default on

When a repo is connected, an atom written from that moment on is staged as it is written, unless it
carries a `cloud_excluded` row (§5.2). The existing store is not swept (§5.4).

`knowl cloud stage` remains, demoted from routine step to override: stage an excluded atom, sweep a
category, or backfill.

Turned off with `knowl config set cloud.autoStage false`, or `--no-auto-stage` at connect.

**Why on by default.** Connecting is deliberate; nothing pre-existing is swept; push is still gated
on the default branch so nothing leaves from a feature branch; and `cloud status` plus `unstage`
make the queue visible and reversible before anything is sent.

**A rationale removed in review, because it was false.** An earlier draft also claimed "all writes
are already secret-validated." They are not. `src/store/repository.ts:143` states that import
deliberately bypasses the guard — "it writes raw SQL precisely because a dump is foreign data that
may predate any guard this build has, and refusing it would make someone's export unloadable." That
exception is correct on its own terms and is exactly why import must be **excluded** from the
auto-stage seam (§6.1.1), not a reason auto-staging is safe.

#### 6.1.1 The seam is one post-commit hook, and its coverage is enumerated

Auto-staging must fire in exactly one place, after the write commits, or it will both miss paths and
leave a crash window in which an atom exists unstaged with nothing to notice.

`createKnowledgeItem` (`src/store/repository.ts:141`) already describes itself as "the last door
before the row … so the invariant is stated here rather than at each caller," and names merge,
synthesis, session-handoff, work-loop and the CLI fixture path as arriving through it. **That is the
seam**, plus the equivalent door on the update path.

**Covered:** every mutation reaching the repository helpers, including the MCP write tools, `decide`,
work-loop writes, merge, synthesis and session-handoff.

**Excluded, deliberately, each with its reason:**

- **Import** — bypasses the door by design (above). A dump is foreign data and may contain another
  machine's local-only knowledge; auto-publishing it would launder someone's export into a team
  workspace. `knowl cloud stage` after an import is the deliberate route.
- **Workspace promotion** (`src/workspace/promote.ts`) — a one-column `visibility` update that moves
  no rows, and per §5.1 sharing with linked local repos is a different audience from publishing to
  the company. Promotion must not publish.
- **Session-namespace writes** — transient by construction.

**The crash window closes by ordering, not by a transaction.** The stage row is written after the
item commits, so a crash between them leaves an unstaged atom rather than a staged phantom. That
direction is recoverable and the other is not: `knowl cloud stage` can queue a missed atom, whereas
a ledger row pointing at an item that was never committed would be pushed as a phantom. `knowl
doctor` reports the drift.

### 6.2 `cloud.autoPush` — default off

When on, a successful stage is followed by a push **if the publish gate is already open**. It never
relaxes the gate.

**Off by default, and consent is stored machine-locally — not in `.knowl/config.json`.** An earlier
draft put it in project config. That is wrong: `src/core/types.ts:282` records that the config file
is "deliberately force-committable so the pointer travels with a clone." Committing
`cloud.autoPush: true` would enable irreversible automatic publishing for **every teammate who
clones and for CI**, none of whom consented, from a file whose whole purpose is to travel. Decision
`9a2fe8a011d6423b` — an agent may stage, only a human may send — would be satisfied on paper by one
person's edit and violated in fact for everyone else.

Consent therefore lives beside the credentials it is equivalent in weight to, under `knowlHome()`,
keyed by workspace. It is per-machine, per-user, never committed, and never travels. Set with
`knowl cloud autopush on|off`, not `knowl config set`.

**Automatic push IS the confirmation, and that must be stated rather than left implicit.** §6.4
requires every push to confirm. Turning autoPush on is the standing answer to that prompt for this
machine, given once, deliberately, for a named workspace. It does not skip the snapshot binding in
§6.4 — an automatic push still sends only what it computed, and a queue that changed underneath it
is still refused rather than sent unseen.

### 6.3 Auto-pull already works and is merely invisible

`maybeAutoSync` (`src/cloud/auto-sync.ts`) already fires a `runPull` at most once per
`AUTO_SYNC_INTERVAL_MS` (60s), detached, single-flight under a lock, errors deliberately swallowed.
It runs inside MCP tool handling, so a connected agent has been pulling team knowledge all along.

Nothing in `cloud status` mentions it. **The work here is reporting, not building** — §7 surfaces
last-synced and next-due. No change to the sync mechanism itself.

### 6.4 `push` confirms before sending

`knowl cloud push` prints what it is about to send, grouped by category, and asks for confirmation.
`--yes` skips it. **Non-TTY requires `--yes`** and otherwise exits non-zero without sending — a
prompt that cannot be answered must not block CI, and must not be silently treated as consent for an
irreversible action.

**The confirmation must bind to a snapshot, not to the queue.** `pushStaged` reads `listStaged`
live (`src/cloud/publish.ts:164`). A long-lived MCP server is writing to that same queue
concurrently — §6.1 makes that continuous rather than occasional — so between the prompt being drawn
and the answer arriving, another process can stage new atoms or change the content of listed ones.
Confirming a live read would send items and text that were never displayed. **This risk is created
by auto-staging; it did not exist when staging was manual and rare.**

So the prompt computes a snapshot — the exact item ids plus each one's `contentHash` and
`lifecycleHash` — and the push sends **that snapshot and nothing else**. If any listed atom's hashes
moved, or the set gained members, the push refuses and re-prompts with the new snapshot rather than
sending. Atoms staged after the snapshot are simply not in this push; they are in the next one,
which is the correct outcome and needs no special handling.

The hashes are the same two §4.3 already relies on, so nothing new is computed.

**Rationale, and a risk the plan must handle.** Auto-staging makes queues larger, and a push is
irreversible. There is production evidence of what a large push does: knowl-cloud fact
`f77ce73dcb914744` records a 237-atom publish against the live server where the first 200-atom batch
OOM-killed the origin and the remainder returned 502. The client's `MAX_BATCH` (200,
`src/cloud/publish.ts:140`) is exactly the batch size measured as unsurvivable. Auto-staging makes
hitting that limit the normal case rather than the exceptional one, so **the plan must lower
`MAX_BATCH` or the two settings will collide on first use.** The ledger already makes the retry
safe and idempotent; the confirmation makes the size visible before it is attempted.

---

## 7. Status

### 7.1 `knowl cloud status` is the one cloud answer

It gains, in one report: **who is signed in** and token expiry (or "not signed in"), workspace and
role, staged count split into new atoms and corrections, what a push is waiting on, and **auto-pull
state** — last synced, next due, last error.

No `whoami` command. A separate verb for one line of a report that people already run is how the
surface grew.

#### 7.1.1 Identity is not locally knowable today, and must be cached at login

An earlier draft promised an offline report containing the signed-in identity. **Nothing in the
client can produce it.** `CloudCredential` (`src/cloud/credentials.ts:6`) holds an access token, a
refresh token, an expiry and the server's session handle — and its own docblock states the server
"sends no user id." `CloudApi` (`src/cloud/api-client.ts:73`) has no identity method; tokens are
opaque. `listWorkspaces` needs the network and returns workspaces, not a user.

**The server already answers this; the client never asks.** `GET /v1/me` exists in knowl-cloud
(`src/http/server.ts:99` registers `identityRoutes` at that prefix) and returns
`MeResponse = { user: { id, email, displayName }, orgs, workspaces }`
(`packages/contract/src/identity.ts:4-28`). The gap is entirely on this side: `CloudApi` has no
method for it.

**Resolution: cache it once, read it forever.** `CloudApi` gains `me(accessToken)`. `knowl cloud
login` calls it after the token lands and stores `email` / `displayName` into the credential file
alongside the tokens. Every later read — CLI or MCP, online or offline — answers from that cache,
which is the only shape that satisfies both "MCP stays offline" and "status says who you are."

**No knowl-cloud change is required.** An earlier draft listed this as a cross-repo dependency and
"the one item that cannot be built in this repo alone." That was wrong: the endpoint and the fields
were already shipped.

A credential written by 4.x has no cached identity. Status reports `signed in (identity unknown —
run knowl cloud login)` rather than inventing one or fetching on a path that must not.

#### 7.1.2 Host selection when the repo is not connected

A disconnected repo has no `config.cloud` and therefore no `apiHost`, while credentials are keyed by
host. Status resolves the host the same way `login` and `logout` already do — `defaultApiHost()`,
i.e. `$KNOWL_API_HOST` or the hosted default — and reports that host's credential. If credentials
exist for other hosts, it names the count and says which flag reaches them. No guessing between
them.

#### 7.1.3 What each caller reports

`cloudStatus` (`src/cloud/status.ts:29`) and `cloudStatusInRequest` (`:51`) stay split, because
constraint `defde27f6f234535` establishes that `initDb`/`closeDb` inside an MCP request leaves every
*later* tool call in that server with no database.

| | identity, workspace, staged, sync state | usage |
| --- | --- | --- |
| CLI | from cache, offline | best-effort fetch, short timeout, degrades to `usage: unavailable` |
| MCP | from cache, offline | **omitted entirely** — no network on a live request |

**The two reports are deliberately not identical**, and the difference is one line. Claiming
otherwise is what made the earlier draft unbuildable.

### 7.2 `knowl status` gains a short cloud summary

Two lines — connected workspace and staged count — pointing at `knowl cloud status` for the rest.
`knowl status` already prints workspace membership and says nothing about cloud, which is what
leaves cloud state stranded.

---

## 8. Closing three MCP-only gaps

Three MCP tools have no CLI counterpart. Each gains one, over the internals the MCP handler already
calls. **This is not full parity and the section no longer claims it** — the omissions are listed,
because an unstated omission is what makes a "parity" claim wrong.

**`knowl store <content>`** — `--category` and `--title` required, plus `--tag`, `--path`,
`--confidence`, `--provenance`, `--reasoning`, `--alternative`, `--source`, `--source-commit`,
`--supersedes`, and `--local` (§5.2).

*Deliberately omitted:* `conflictKey`, `conflictScope`, `conflictExclusive` (machine-oriented
identity fields; a human typing a fact has no use for them), `namespace` (project is the only
sensible CLI target; the others need configuration), and `steps` (skill-only — `knowl skill create`
already owns that path). A plan may add them behind flags if a use appears; nothing here depends on
their absence.

**`knowl park`** — `--goal` required, matching the tool's `required: ['goal']`. Optional
`--completed` (repeatable), `--next-action`, `--blocker`, `--artifact` (repeatable),
`--verified` / `--unverified`. Mints the key and prints the paste-ready line. Completes the pair with
the `knowl resume` that already exists (`src/cli/program.ts:451`).

**`knowl handoff`** — `--goal` **and** `--next-action` both required, matching
`required: ['goal', 'nextAction']`. Same optional set as `park`. Leaves the baton for the next
session in this project.

`sessionId` is omitted from both: it exists because an MCP client has no session of its own to
report, which is not a problem a CLI invocation has.

---

## 9. Flattening one-leaf groups

| now | becomes |
| --- | --- |
| `knowl code index` | `knowl index-code` |
| `knowl code symbols <path>` | `knowl symbols <path>` |
| `knowl eval retrieval` | `knowl eval` |
| `knowl access report` | `knowl access` |
| `knowl pr check` | `knowl pr` |
| `knowl evidence list <id>` | `knowl evidence <id>` |

`knowl snapshot create` / `restore` stays a group — those two are a genuine pair, not a group
wrapping a single leaf.

---

## 10. Consequences that must ship in the same wave

Migration machinery is out of scope (§2), but three things are correctness rather than
compatibility and cannot be skipped.

### 10.1 MCP tool descriptions ship command strings to the model

`src/mcp/tool-definitions.ts:99` instructs the agent to run `knowl cloud push`, `knowl cloud
retract`, `knowl cloud pull`, `knowl cloud connect` and **`knowl login`**. These strings are read by
a model, not a human — a stale one is a wrong instruction that an agent will confidently follow, not
merely wrong documentation. Every renamed command must be updated here.

`knowl_cloud`'s own `stage` action now matches the CLI verb exactly, which removes a mismatch
rather than creating one.

### 10.2 Guidance files are generated by the product and gated by CI

`installKnowlProjectGuidance` (`src/core/agents-guidance.ts`) writes KNOWL.md and AGENTS.md from
`renderManagedKnowlGuidanceSection` (`src/core/knowl-guidance.ts`), and `docs:check` compares both
against `src/` and fails on drift (architecture `699986cdbcaf4565`). Renames land there or CI reds.

**The trap recorded in that same item applies to this work:** those commands run the *built* CLI, so
running `knowl init` or `knowl upgrade` inside this repository against a stale `dist/` silently
rewrites the guidance files from the old build. Run `npm run build` first.

### 10.3 knowl-cloud's web copy hardcodes CLI strings

Per knowl-cloud goal `a052496241be48a2`, the web app names CLI commands in six locations and
**three e2e tests assert those strings** (`app-onboarding.spec.ts:30`,
`app-instrument-screens.spec.ts:68`). That repo's suite currently pins a command that does not exist
at all. Any rename here reds knowl-cloud's CI until its copy and tests are updated in the same wave.

### 10.4 Nothing else crosses the repo boundary

An earlier draft listed a fifth item here: a knowl-cloud endpoint to supply the signed-in identity.
It was withdrawn on inspection — `GET /v1/me` and the `email` / `displayName` fields already exist
(§7.1.1), so that work is entirely client-side.

**§10.1–§10.3 are therefore the complete list.** Only the web copy and its three e2e tests live
outside this repo, and they are copy changes rather than capability work.

---

## 11. Deferred, with evidence

### 11.1 `session` / `task` / `agent-event`
Four parallel lifecycle systems: `knowl session start/event/finish/recover`, `knowl task
start/checkpoint/finish/run`, the three `agent-*` hook commands, and MCP's `knowl_task_*` plus
`knowl_session_finish` — which exposes session *finish* but not session start, half of one system
and all of the other. Architectural, reaches into the hooks that own the lifecycle, needs its own
spec.

### 11.2 `knowl ask`
Requires AI configuration, loads the entire hierarchy rather than retrieving, and sits beside
`query` while working nothing like it. A strong deletion candidate, but deleting a user-facing
command deserves its own decision.

### 11.3 Three retention surfaces
`transcripts approve/discard`, `gc`, `forget-log`.

### 11.4 `transcripts` is two features sharing a name
The CLI half (extract / candidates / approve / discard) and the MCP half (search / read /
session_list) share zero verbs. Reading is agent-only; distilling is human-only.

### 11.5 Full sharing unification
§5 keeps the two systems separate, per `ee191dd7db024bec`. Collapsing them into one model with two
destinations rewrites the visibility column, the cloud ledger, `workspace/promote.ts`,
`cloud/publish.ts` and `cloud/sync-apply.ts` together — larger than the rest of 5.0 combined, and it
would have to answer the audience question that decision raises: my other repos and my whole company
are not the same reader, and one verb cannot mean both.

### 11.6 Aliases
There are none anywhere in the CLI. Whether that is deliberate is unresolved; 5.0 does not add any.

### 11.7 Three local ways to retire an item
`knowl supersede`, `knowl_update {supersedeId}`, `knowl_store {supersedes}`. The spec does not
consolidate them, but a plan should name one canonical route in the docs.

---

## 12. Verification

Beyond the standing gate (`npm.cmd run typecheck`, `lint`, `build`, `test`, `docs:check`):

1. **No orphaned command strings — in live surfaces only.** Grep for every removed name (`knowl
   login`, `knowl logout`, `knowl publish`, `knowl code `, `knowl eval retrieval`, `knowl access
   report`, `knowl pr check`, `knowl evidence list`) across **`src/`** (error messages, help text,
   MCP tool descriptions), **KNOWL.md and AGENTS.md**, **`README.md`**, and **`docs/reference.md`**.
   Zero hits.

   **`docs/superpowers/**` is excluded, and must be.** Seven plans and specs from July and August
   name these commands as they existed when written — `2026-07-11-product-layer.md`,
   `2026-08-09-cloud-client-plan-{a,b,d}.md` and others. They are a record of what was decided and
   when. Rewriting them to match a later rename would falsify the history that makes them worth
   keeping, and would silently edit the reasoning this spec itself cites. Historical documents are
   allowed to describe history.
2. **`login` short-circuit** proven with a stored valid credential: no device authorization is
   started. Covered by a test, not by inspection.
3. **`connect` non-TTY** proven not to block.
4. **Auto-stage sends nothing pre-existing.** Connecting a repo with a populated store queues zero
   atoms; an atom written afterwards queues; an atom written with `--local` never queues; naming an
   excluded atom's id explicitly still stages it. `visibility` is untouched throughout — assert that
   a `workspace`-visibility atom written before connect stays unqueued, since that is the exact
   regression §5.1 exists to prevent.
5. **Re-stage predicate** — a change to content, status, freshness or supersede on a published atom
   queues a correction; a change moving neither hash queues nothing.
6. **`remote_version` survives every non-retract path.** Push an atom, edit it, `unstage`, edit it
   again, push: the second push must still carry `expectedVersion`. Assert the column directly, not
   just the outcome — this is the invariant §5.3 exists to protect, and a regression here surfaces
   as a server-side conflict far from its cause.
7. **`unstage` versus `unstage --forever`.** After plain `unstage`, a later qualifying change
   re-stages the atom. After `--forever`, it does not, and no category sweep picks it up — but
   naming its id to `knowl cloud stage` still does.
8. **Confirmation binds to a snapshot.** With a push prompt open, stage another atom and mutate a
   listed one out of band. The push must send neither change: the added atom is absent, and the
   mutated one causes a refusal and re-prompt rather than a silent send.
9. **Auto-push consent never travels.** Enable it, then assert nothing in `.knowl/config.json`
   changed — a fresh clone of the repo must have it off. This is the §6.2 failure mode and a test is
   the only thing that stops it regressing back into project config.
10. **The auto-stage seam covers what §6.1.1 lists and excludes what it excludes.** Specifically:
    an import queues nothing, a `workspace promote` queues nothing, and a session-namespace write
    queues nothing — while an MCP `knowl_store` and a `knowl decide` both do.
11. **Identity is cached at login, and its absence is reported honestly.** `login` calls `me()` and
    persists the result; a credential written without one reports `identity unknown`, never a
    fabricated or re-fetched name, and the MCP path makes no network call while doing it.
12. **`cloudStatusInRequest` still opens and closes no database**, per `defde27f6f234535`. The three
    cases in `tests/cloud/ambient-context.test.ts` must still pass unmodified.
13. **`MAX_BATCH`** lowered, with the chosen number justified against the 200-atom measurement in
    `f77ce73dcb914744`.
14. **knowl-cloud CI green** on the paired web-copy and e2e-test change (§10.3). No engine change is
    expected there; if one becomes necessary, that is a signal the design drifted.
