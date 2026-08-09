# Knowl Cloud — the client half (Phase 6)

**Date:** 2026-08-08
**Status:** Approved for planning
**Repo:** `knowl` (this one). The server half is built in parallel in `knowl-cloud`.

---

## 1. Purpose

A developer runs `knowl login`, connects a repo to a hosted workspace, and from then on
their agent's queries see the team's shared knowledge beside their own — same tools, same
result shape, same ranking.

This is the client half of the Knowl Cloud v1 design
(`knowl-cloud/docs/superpowers/specs/2026-08-03-knowl-cloud-v1-design.md`). It departs from
that design in three places, each recorded below with the reason.

---

## 2. The three departures

### 2.1 The cloud is not the `organization` namespace

The v1 design maps the cloud onto Knowl's `organization` namespace. That namespace does not
work, and repairing it would be unsafe.

**It does not work.** Verified at `f677c22`:

1. `knowl_query` computes the layered result only when
   `Boolean(projectRoot) && !explain && !vector?.enabled` (`src/mcp/tools.ts:747`). Vector
   search is on by default, so the branch is normally skipped.
2. When it does run, an active workspace replaces it wholesale —
   `resolvedItems = flattenGroups(federated)` (`src/mcp/tools.ts:806`).
3. CLI `knowl query` calls `queryFederated` only and has never read the namespace.
4. `knowl_context` calls `queryLayeredKnowledge` with `defaultNamespaces`, which is
   `[session, project]`. The organization layer is excluded structurally.

Writes still land, so the namespace is **write-only and does not say so**.

**Repairing it would be unsafe.** `composeContext` reads namespaces, and composed context is
injected into agent prompts with no human in the loop. Linked local peers are deliberately
kept out of `configuredNamespaces` for that reason. A cloud workspace is more exposed still —
every member writes to it.

**So the cloud joins at `queryFederated`,** the path every live surface already uses.

### 2.2 Agents read a local copy; the browser reads the server

The v1 design specifies live remote reads with no sync engine. That is wrong for the agent
path and right for the browser path.

The Knowl workflow queries before every subtask and again on every area switch, so a network
round trip lands on the hot path several times per turn. Industry reports 100–600 ms for
multi-strategy retrieval; multiplied by an agent's query rate, that is a product-defining tax.

**Team knowledge therefore syncs down and is searched locally.** The browser explorer keeps
querying the server live — different consumer, different needs, and latency does not matter
when a human queries once and reads.

This is not the bidirectional whole-database sync the v1 design rejected. The server stays
authoritative, the client never writes to its copy, and nothing merges.

Four problems disappear with it: query latency, cross-model score comparability, offline
degradation, and query-text privacy.

Competitor evidence supports the shape. ByteRover — the closest competitor — is local-first
with cloud sync for sharing, and caps its Team plan at 100 synced context files. A curated
team set is small.

### 2.3 The server may keep a different embedding model, and it costs nothing

Because team atoms are embedded **locally by the local model** once they land, there is no
cross-model comparison anywhere on the agent path. The workspace's server-side profile is
irrelevant to CLI retrieval and need not match.

---

## 3. Where the copy lives

```
knowlHome()/workspaces/<workspace-id>/knowledge.db
```

One SQLite store per cloud workspace, machine-local. **Not** under `.knowl/` — that would be
committed, and every connected repo would hold a duplicate. One copy serves every repo
pointed at that workspace.

It is a replica, never a source of truth. Deleting it must be safe and fully recoverable by
resyncing from sequence zero.

---

## 4. Sync

### Trigger

**Lazy, activity-driven, never blocking.** On a cloud-aware operation, if the last check is
older than the interval (default **60 s**), fire a check in the background and carry on. The
current query answers from disk; the next one sees anything new.

`src/core/version-check.ts` already implements this shape — a TTL'd cache with `ttlMs`,
including the rule that a non-positive TTL disables it. Reuse the pattern.

Three triggers, and no others:

- **Lazy**, as above
- **`knowl cloud connect`** — the first full pull
- **`knowl cloud pull`** — explicit, for "a colleague just published"

No timer, no daemon, no push channel.

### Single-flight

One long-lived MCP server plus a `knowl` CLI spawned by every hook means "check, then sync"
run naively is a thundering herd against our own server. Whoever notices staleness takes a
lock under `knowlHome()`; anyone finding it held **does nothing** — no queueing, no waiting.
`src/session/hook-debounce.ts` solves the adjacent problem and is the model.

### Protocol

1. Read the local watermark — the last applied `seq`.
2. Ask for changes since it. The server's `knowledge_commits.seq` is a gapless per-workspace
   sequence assigned inside the publishing transaction, so the feed is exact. **`since` is a
   decimal bigint; an ISO timestamp is refused.**
3. Apply creates and updates into the team store.
4. Apply tombstones. Without this, retracted atoms live on laptops forever.
5. Embed new and changed atoms in the background, best-effort — the same treatment local
   writes already get via `indexKnowledgeItemsBestEffort`.
6. **Advance the watermark only after the apply commits**, atomically.

A failed sync keeps the previous copy and does not move the watermark. Queries keep working
on older data; `knowl doctor` reports the lag.

### Cold start

The first sync may be thousands of atoms plus an embedding pass. It must be background,
resumable, and non-blocking: the repo is usable immediately, with local results and a
progress note (`team knowledge syncing, 312 of 2000`). Never a wall.

---

## 5. Freshness is a notification problem, not a latency problem

A stale answer is only harmful if the agent cannot learn it was stale. Knowl already has the
machinery — `src/store/change-watermark.ts`, `src/session/change-card.ts`, and `work_read_sets`
recording what a session actually read. Team atoms arriving by sync are the same event with a
different source.

**Two channels, by severity.**

**A notice block on the next `knowl_query`.** Responses already carry `SCOPE:`, `WORKSPACE:`,
`LOCAL MISS:` and `SHARED LINEAGE:`. Add `TEAM UPDATE:` in the same style. No new plumbing, no
extra round trip.

**A change card at the turn boundary** when new team knowledge **supersedes or contradicts
something this session already read**. That is the case worth interrupting for, because the
agent may never query again.

**Speak only when it matters.** Intersect arriving atoms against `work_read_sets` and stay
silent otherwise. A notice that always fires is one the agent stops reading.

Because arrival is announced, the sync interval is not load-bearing. 60 s is a starting value,
not a correctness constraint.

---

## 6. Login and credentials

`knowl login` requests a device code, prints a code and URL, polls, stores tokens.
`knowl logout` clears them. The server-side device flow is built, merged and tested.

**Storage.** `knowlHome()/credentials.json`, keyed by API host so staging and self-hosted do
not collide. Never `.knowl/config.json` — that file is deliberately force-committable.

**No OS keychain in v1**, against the v1 design. A keychain means a native module (`keytar` is
unmaintained, `@napi-rs/keyring` needs prebuilds), and native modules break over SSH, in
containers and in CI — exactly where the device-code flow was chosen to work. The storage
interface stays swappable.

**Permissions stated honestly per platform.** POSIX gets mode 0600. On Windows `fs.chmod` only
toggles the read-only bit, so the real protection is the ACL on `%USERPROFILE%\.knowl`.
Documentation says that rather than claiming a permission we do not set.

### The refresh race

The server treats a replayed refresh token as theft and revokes the session. Many processes
share one credential file, so two concurrent refreshes mean one wins and the other replays a
rotated token — a logout mid-session with no explanation.

Single-flight, with the re-read **after** taking the lock:

```
expired, or inside the 60 s skew window?
  ├─ take knowlHome()/credentials.lock exclusively
  │    └─ re-read credentials.json   <- someone may have refreshed while we waited
  │         ├─ still expired -> refresh, write atomically (tmp + rename), release
  │         └─ already fresh -> release, use theirs
  └─ lock busy -> bounded wait, re-read, use what landed
```

Skipping the re-read is the bug: the winner would refresh an already-rotated token.

Refresh ~60 s before expiry. Poll the device endpoint at the interval the **server**
advertises — it derives its own rate limit from that number. No long-lived in-memory
credential cache, so `knowl logout` elsewhere takes effect.

---

## 7. `knowl cloud connect`

Named `cloud`, not `workspace`: "workspace" already means linked local repos *and*
`visibility='workspace'`. A third meaning would be confusing to users and to us.

**Repo identity comes from the normalized git remote**, not the directory name — two people
cloning to different paths must resolve to the same `origin_repo`. Normalize to
`host/owner/name`: lowercase host, drop `.git`, collapse `git@…:`, `https://` and `ssh://`.

- **No remote** — refuse. There is no stable identity to publish under.
- **Forks** — `origin` is the fork and `upstream` is the team's, so a colleague who forked
  resolves elsewhere. Default to `origin`, allow an override, and record which remote was used.
- **Monorepos** — several `.knowl` projects under one remote normalize alike and would merge
  silently. Qualify with the path from the repo root when the project is not at the top.

**The pointer lives in `.knowl/config.json`** — API host, workspace id, resolved repo identity.
No credentials. This is the force-committable file on purpose: a teammate clones, runs
`knowl login`, and is in.

**Non-members must degrade, not break.** Someone clones a repo whose config points at a
workspace they do not belong to. Sync 403s, the team store stays empty, local Knowl works
normally, and `doctor` explains why.

Connect performs the first sync and **publishes nothing**.

---

## 8. Federation

The team store joins as a peer in `queryFederated`, opened by the existing `openPeerStore`.
It is a local SQLite database like any other peer, so scoring, grouping, `unshown` and
`skipped` all work untouched.

**Two changes only:**

**Federation must be reachable without a local workspace.** Today
`const active = projectRoot ? await resolveWorkspace(...) : null`, so a repo with no workspace
manifest never federates. A repo connected only to the cloud must. `resolveWorkspace` returns
an active workspace when a cloud pointer exists, even with zero local peers.

**Group key and marker.** Team rows group under their normalized identity
(`github.com/acme/web`), which cannot collide with a local manifest name, and carry a
`remote: true` marker in the spirit of `kinDivergent`.

**`configuredNamespaces` is not touched.** A deliberate non-change, pinned by a test (§12).

**Containment.** Team atoms are foreign text from a store every colleague writes to. Any team
title reaching a rendered surface goes through `inlineUntrusted` / `fenceUntrusted` like every
other foreign surface.

---

## 9. Publishing

**`knowl publish` is explicit and never automatic.** Selectors mirror `promote`: `--id` or
`--category`, dry run by default, `--apply` to send. A bare `knowl publish` is refused.

### Publication state lives in a local ledger

Decision `ee191dd7db024bec`. `visibility` keeps its meaning exactly — `repo` = this repo,
`workspace` = readable by linked local repos on this machine. A new table
`cloud_published(item_id, remote_workspace, remote_version, pushed_at, retracted_at)` records
what went up.

Adding a third `visibility` value would touch a column the live read path filters in SQL
(`federated-query.ts:208`), and an older Knowl build would keep filtering on `'workspace'`
alone and silently drop published rows. And the ledger must exist regardless: the server
treats a republish without `expectedVersion` as a conflict by design.

Consequence: **connect publishes nothing.** Items already at `workspace` visibility stay local.
Nothing to migrate. The ledger is machine-local like `drift_state` and must not travel in
portable exports.

### What gets published

Storage is not the constraint — atoms are text, and ten thousand of them is tens of megabytes.
The constraints are **retrieval noise** and **what you are willing to show colleagues**.

**Default preset, from measured local experience:** `decision, constraint, architecture, goal,
skill` publish; `fact` and `state` do not. That is exactly the split chosen when 171 items were
promoted locally, on the grounds that fact and state are where per-commit entries and transient
test-failure noise live.

**Two dials, both server-owned policy:**

1. **Category routing** — which categories may auto-publish. Off by default.
2. **A quality gate** on anything auto-published, from signals that already exist: `tier`
   (earned from real retrievals since `tier_since`, not asserted by the writer), `provenance`
   (`observed` and `user_stated` travel, `inferred` does not), a confidence threshold, access
   count (`isHot()` already encodes the rule), and `freshness`.

**Solo / small-team mode** is the same mechanism with the dials open: category routing on for
everything, quality gate off. It is a different product — personal sync across your own
machines — served by the same code.

### When publishing happens: the team store tracks the default branch

Local knowledge tracks **your working tree**. The team store must track **the default branch**,
because that is the only reality every member shares. Someone on a feature branch and someone
on main are living in different codebases, and an atom true for one is false for the other.

So publishing on write is wrong for the same reason pushing every keystroke would be. Publishing
is **two-phase**, matching git's own index-then-commit model developers already hold:

| Phase | When | Where |
|---|---|---|
| **Stage** | any time, on any branch | local ledger only |
| **Push** | the code it describes is on the default branch | server |

`knowl publish` stages. The network push happens once the atom's evidence resolves against the
default branch. The ledger therefore carries `staged_at` and `staged_on_branch` beside
`pushed_at`.

This also closes the abandoned-branch hazard: publishing early from a branch that never merges
would ship a permanent falsehood, and there is no unpublish.

**Only code-coupled atoms are gated.** The discriminator already exists in the schema — an atom
with `affectedPaths` or code evidence describes code and is gated; one without (*"we chose
Postgres"*) is true the moment it is decided, and gating it would be pointless friction. Gate on
evidence, not on category.

**Drift reports are gated the same way.** Deleting a feature locally makes the local drift check
mark the atom stale — correctly, for that tree. Reporting it upward immediately would retire
knowledge still valid for everyone on main. So drift is reported **only when observed on the
default branch**. The signal is self-correcting: once the branch merges, the next member to pull
main observes the same thing, so the report needs no particular author, only a correct vantage.

### The currency check, and why it is not optional

**Being behind main is indistinguishable from the code having been deleted.** A developer three
days behind cannot find a file the team published an atom about, concludes the code is gone, and
retires correct team knowledge because *they* are out of date.

This repository has already shipped this exact collapse one level down: `fileContentHash` caught
every error and returned null, and `currentStateOf` mapped null to `gone`, so an antivirus lock
on Windows became "the file you read is deleted" — the strongest notice the system has, about an
intact file. The fix there was to narrow "gone" to `ENOENT`/`ENOTDIR` alone.

Same discipline here: before any upward drift report, confirm the checkout is current with the
remote default branch (`git rev-list --count HEAD..origin/<default>` is zero). If it is not, the
observation is about local staleness rather than about the code, and the client stays silent.

**The push trigger** is therefore: on the default branch, not behind its remote, and the atom's
evidence resolves against the tree. Evaluated at session start, on `knowl cloud push`, or after
`knowl pr check` — which already maps changed git paths to knowledge provenance and is the
natural gate.

**The server stays git-blind.** It has no working tree and must not grow branch awareness; every
gate above is the client's, because only the client can see the graph.

### Failures

**Conflicts.** A 409 names the stale atom and stops. No blind retry; the local copy must be
re-read first.

**Secrets.** Rejection is terminal and fails the whole batch. The client names the offending
item, never echoes the matched text, and never retries in altered form.

**Foreign origin.** Only items this repo originated may be published. Refused client-side
before the request, with the message shape `promote` already uses.

---

## 10. Lifecycle across the boundary

Team knowledge must behave like local knowledge, which means four mechanisms have to cross.

**Supersede** — works as-is. The server has `superseded_by_id` and `version` with optimistic
concurrency. A retirement syncs down as a lifecycle change; that is what `lifecycle_hash` is for.

**Stale / `needs_review`** — only clients have a working tree, so the server can record evidence
but never verify it. Drift detection stays local and reports upward for atoms in the ledger; the
server applies it workspace-wide and it syncs to everyone. One person notices, everyone benefits.

**Conflicts across people** — `conflict_key` and `conflict_exclusive` now operate between humans.
Two colleagues asserting contradictory values is a governance event; the server surfaces it and
never silently picks a winner.

**Decay** — locally, cold never-retrieved items are archived after 60 days using access counts.
Team knowledge has no single access count. **Retrieval counts flow upward** — atom ids and counts
only, never query text — which both enables team-scale GC and produces a quality signal no
competitor has: an atom two hundred people have read outranks one somebody rated confident.

---

## 11. Permissions, and the never-list

### Roles

The server already ships `owner / admin / editor / reader`, with authority held under a row
lock for the whole request. The client half:

- Fetch the caller's role at connect and refresh it on sync.
- **Fail fast.** `knowl publish` refuses a reader immediately, not after building a batch and
  eating a 403.
- **Readers may flag.** `needs_review` is allowed from any member; acting on it — retire,
  supersede — requires editor. Restricting flagging to editors would lose most rot detection,
  because readers are usually the ones who notice.
- **Permissions are two-dimensional.** Workspace role decides whether you may write at all;
  repo ownership decides which atoms. An editor still cannot modify another repo's atom. Both
  must pass, and the refusal must say which one failed.

### Never leaves the machine, under any setting

A setting that can leak these is a setting someone eventually turns on:

- **Query text** — the promise that makes local search a privacy property
- Transcripts, sessions, host bindings
- Embeddings — wrong space and large
- Code index — machine and commit specific, rebuildable
- Credentials, local model paths, hook configuration

The demand ledger stores query text, so team-scale demand analytics must ship aggregate counts
without it, or be explicit opt-in. It must not ride along by default.

---

## 12. Testing

- **Remote URL normalization** as a table test: fork, monorepo, no-remote, all three URL forms.
- **The refresh race**, as a real concurrency test: N concurrent refreshes produce exactly one
  network refresh and zero revocations. Confirm it fails with the lock removed.
- **Sync single-flight**: N processes see a stale watermark, exactly one syncs.
- **Watermark safety**: a sync that fails mid-apply leaves the watermark unmoved and the old
  copy intact; the retry is idempotent.
- **Tombstones applied**: a deleted atom disappears locally on the next sync.
- **A test that fails if the cloud store is ever added to `configuredNamespaces`**, and one
  asserting `composeContext` output never contains a team row. These are the injection guards
  and they are the most important tests in the change.
- **Non-member degradation**: a 403 on sync leaves local Knowl fully functional.
- **Publish**: conflict, terminal secret rejection, client-side foreign-origin refusal,
  reader fast-refusal, ledger round-trip.
- **Contract conformance.** This repo does not depend on `knowl-cloud/packages/contract`. It
  carries its own schema mirror plus committed response fixtures, and a test that fails when
  they diverge — the drift detection knowl-cloud records as otherwise absent.

---

## 13. Server dependencies

**Already shipped** (knowl-cloud `main` at `a715862`, migrations `0011`–`0014`): the gapless
per-workspace commit sequence, the changes feed keyed on it, `knowledge_tombstones` and a
`delete` op, `skill_steps` / `skill_metadata`, `knowledge_assertions`, `untrusted.ts`, and the
`owner/admin/editor/reader` model.

**Still needed for this design:**

1. **The changes feed must carry full atom payloads plus evidence**, or a companion fetch
   endpoint must. A notification-shaped feed of ids and actions cannot drive a sync.
2. **The caller's own role** must be readable by the client, so publish can fail fast.
3. **`needs_review` permitted from readers.**
4. **An access-count ingest endpoint** — atom ids and counts only.
5. **An owner override for atom ownership.** An archived repo, or one whose team disbanded, has
   atoms nobody can update, because origin ownership blocks it permanently. Locally the remedy
   was "run it from that repo"; in a company that remedy can cease to exist.

**Deliberately kept though unused by the CLI:** `POST /v1/workspaces/:id/knowledge/candidates`.
It is off the critical path now, but it is exactly the seam a future server-side retrieval mode
would use. Do not delete it.

---

## 14. Plans

**Plan A — no server dependency, starts immediately.** `knowl login`, credential storage, the
refresh lock, `knowl cloud connect`, repo identity, doctor checks.

**Plan B — starts when the sync payload contract is pinned.** The team store, sync, federation,
the notification channel, publishing, the ledger, and the injection-guard tests.

---

## 15. Success criteria

1. `knowl login` is run once; no further interactive authentication for the token's lifetime.
2. Ten concurrent `knowl` processes refreshing an expired token produce one refresh and no logout.
3. A repo with no local workspace, connected to a cloud workspace, returns team rows in
   `knowl_query`, grouped under their originating repo.
4. **No search request ever leaves the machine.** Provable by network capture during a query.
5. With the server unreachable, queries return team knowledge from the local copy and report
   how stale it is.
6. A colleague's publish reaches another developer's next query, and the response says so.
7. An atom deleted on the server disappears from every laptop on the next sync.
8. `knowl cloud connect` on this machine publishes none of the 171 already-promoted items.
9. A reader is refused publication before any request is sent, and can still flag `needs_review`.
10. A non-member who clones a connected repo can still use Knowl locally.
11. No team row ever appears in composed context.
