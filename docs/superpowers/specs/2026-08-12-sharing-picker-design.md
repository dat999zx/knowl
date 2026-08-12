# A bare `promote` and a bare `stage` ask, instead of refusing

**Date:** 2026-08-12
**Status:** Design approved in conversation, not yet planned
**Repo:** `knowl`

---

## 1. The problem

Both sharing commands refuse a bare call:

```
$ knowl workspace promote
Specify what to promote with --category <list> or --id <id>.
A bare promote would publish the whole repo.
```

The guard is right that promoting everything is wrong. It is wrong that the remedy is for the
user to already know which categories are worth sharing, type them as a comma-separated list, and
get the comma quoting right on Windows — for a command most people run once, to backfill a store
that predates the link.

`knowl cloud stage` has the identical problem, from the identical code: it calls the same
`selectOwnedItems`.

**Both are now backfill commands.** New knowledge already reaches both destinations on its own —
workspace-visible writes for the local case, auto-staging for the cloud. A bare call is somebody
catching an existing store up, which is exactly when they least want to compose a category list.

---

## 2. What to recommend, and why

Derived from this repo's own store rather than from a remembered preference. Active counts:

| category | count | share by default | why |
| --- | --- | --- | --- |
| `fact` | 359 | **no** | Commit-level changelog about this repo's internals — *"fix(cloud): stop re-running device auth"*, *"releaseAll now checkpoints WAL"*. |
| `state` | 194 | **no** | This repo's own status — *"Knowl 5.0 is implemented"*, *"PR #15 review verdict"*. Churns on every merge. |
| `architecture` | 101 | yes | How this repo is shaped. A peer cannot integrate without it. |
| `constraint` | 90 | yes | Hard rules. Cross-repo constraints are what break integrations. |
| `decision` | 72 | yes | Choices with reasoning, so a peer does not re-litigate or contradict one. |
| `skill` | 19 | yes | Method knowledge. `KNOWL.md` already says method questions belong to the whole workspace: *"a sibling repo's pipeline answers them more often than this repo's files do."* |
| `goal` | 7 | yes | Direction. A peer needs to know where this repo is going before building against it. |

**The two exclusions are 66% of the store**, and they are the churning two. That is the pollution
worth preventing; the remaining five are 289 items with a stated reason each.

This lands on the same set promoted on 2026-08-03 (`18b52256294c42bc`), but derived rather than
inherited — the earlier choice recorded *what* was picked, not why it would still be right.

**One definition, both commands.** The question is "what does another reader need from this
repo", and the answer does not change according to whether that reader is a sibling repo or a
teammate. A single exported constant, so the two cannot drift.

---

## 3. The interaction

A bare call, with a TTY, opens a multiselect with live counts:

```
Promote to workspace "knowl" — space to toggle

  [x] decision        42
  [x] constraint      18
  [x] architecture    23
  [x] goal             9
  [x] skill            4
  [ ] fact           131   noisy: per-commit entries
  [ ] state           27   noisy: transient status

  96 items selected
  [enter] continue   [esc] cancel
```

Then a count and a confirmation, and it applies.

**The confirmation IS the apply.** `--apply` remains for the flag path only. Requiring an
interactive yes *and* a flag would move the tedium rather than remove it, and an interactive
confirm is the same statement the flag makes.

**Categories with zero candidates are listed with their zero**, not hidden. "Nothing to promote"
must be visible; a silently short list reads as a bug.

**No TTY keeps today's behaviour** — the existing error naming `--category` and `--id`. A prompt
that cannot be answered must not hang CI, and this is a one-line fallback rather than a new path.

**The picker never offers to push.** Staging and sending are two phases because the branch gate
sits between them; collapsing them here would undo that.

---

## 4. The counts are per-caller

The picker is handed counts; it does not compute them. The two callers ask different questions:

- **`workspace promote`** — rows still at `visibility: 'repo'`. This is what `selectOwnedItems`
  already answers via `requireVisibility: 'repo'`.
- **`cloud stage`** — rows not yet staged or pushed to this workspace, **minus `cloud_excluded`**.
  An excluded atom is not a candidate and must not be offered, or the picker would promise
  something the sweep then silently drops (the sweep already filters; §5 of the 5.0 spec).

---

## 5. The shared-guard defect, fixed in the same change

`selectOwnedItems` throws:

> `Specify what to promote with --category <list> or --id <id>. A bare promote would publish the whole repo.`

`knowl cloud stage` calls the same function, so a bare `stage` tells the user to specify what to
*promote* — naming a real but unrelated command (`knowl workspace promote` shares with linked local
repos, not with the team). Recorded as defect 1 of `18f2ef903016403b`, found by driving the built
binary.

**The selector is fine to share; the message belongs to the caller.** The guard moves out of
`selectOwnedItems` to each command, or takes the verb as an argument. Either way the string a user
reads names the command they typed.

---

## 6. Out of scope

- **No change to what `promote` does once chosen.** It is still a one-column visibility update
  with deliberately no demote.
- **No new MCP surface.** `knowl_workspace` stays read-only and `knowl_cloud`'s `stage` keeps
  taking explicit ids or categories: a picker is a human interaction, and an agent that wants the
  recommended set can pass it.
- **No change to the push gate or its confirmation.**
</content>
