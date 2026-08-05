# Verification of the 2026-08-05 external review — Knowl v3.0.1

**Target:** `36c7471` (v3.0.1), working tree clean
**Verified:** 2026-08-05, on Windows 11 / Node 24, against the real repository
**Source under review:** [audit-2026-08-05-external-review.md](audit-2026-08-05-external-review.md)

## Method, and why it differs from the review's

The external reviewer could not resolve `github.com`. They said so plainly, which is to their
credit, but it means every one of their findings is a source read. This verification ran on the
actual checkout: real `vitest` probes against the real store, real filesystem calls on Windows,
and the real lockfile. Two of their claims collapse under that, and — more importantly — one
critical defect that a source read cannot see was found by running the code.

Still not covered here, and still open: `npm audit`/OSV (not run), macOS/Linux runtime, and
hostile-input fuzzing.

## Headline

**The review's most confident positive claim is wrong.** Its §1.6 calls the new snapshot
preflight "necessary and well implemented." It is defeated by a time-of-check/time-of-use
window that Knowl opens itself, and the result is **silent, total, unreported destruction of
the knowledge store** through the documented recovery command. That is a worse bug than
anything in the review, and it is reachable in the default configuration.

Beyond that: 11 of the review's findings are confirmed, 2 are materially wrong, 1 is a
documented deliberate tradeoff being reported as an oversight, and 6 further defects were found
that the review missed.

---

# Part 1 — New findings the review missed

## K-NEW-1 — CRITICAL: `snapshot restore` silently destroys the entire store and reports success

**Confirmed by execution.** Not a source read.

### Mechanism

[snapshots.ts:210-261](../src/store/snapshots.ts#L210-L261) runs in this order:

1. `verifySnapshotManifest(source)` — size, SHA-256, schema version. Passes. *(line 222)*
2. `createSnapshot(root)` — takes the pre-restore snapshot. *(line 224)*
3. `ATTACH DATABASE '<source>' AS snapshot_restore`. *(line 227)*

Step 2 ends in `pruneSnapshots(snapshotDir, SNAPSHOT_KEEP, newSnapshotPath)`
([snapshots.ts:64](../src/store/snapshots.ts#L64)). That function protects exactly one file —
the snapshot it just wrote — and deletes everything past the keep window
([retention.ts:206](../src/store/retention.ts#L206)):

```ts
for (const stale of snapshots.slice(Math.max(keep - (protectedPath ? 1 : 0), 0)))
```

With `SNAPSHOT_KEEP = 3` and the new snapshot holding one slot, only the **two newest**
pre-existing snapshots survive. **The file the user asked to restore is not protected.** If it
is not one of those two, step 2 deletes it — both the `.db` and its manifest.

Step 3 then attaches a path that no longer exists. SQLite's `ATTACH` **creates** a missing
database file. So `snapshot_restore` becomes a valid, empty, 0-byte database.

`restoreStatements` ([snapshots.ts:115-142](../src/store/snapshots.ts#L115-L142)) then reads an
empty `snapshot_restore.sqlite_schema`, so `present` is empty, so `dependents` and `standalone`
are empty. The emitted statement list degrades to exactly one statement:

```sql
DELETE FROM knowledge_items
```

The re-insert loop is skipped for every table because `sharedColumns` finds no columns in the
attached database and `continue`s. `PRAGMA foreign_keys = ON` cascades the delete through
assertions, evidence links, access, skill rows, and embeddings.

The post-restore integrity audit is then handed a perfectly consistent **empty** store, finds
**zero** error findings, and `restoreSnapshot` **returns normally**.

### Proof

Probe: one item, three snapshots, restore the oldest.

```
[probe] source .db bytes before  = 303104
[probe] source manifest before   = 169
[probe] live rows before         = 1
[probe] source .db bytes after   = 0        (recreated empty by ATTACH)
[probe] source manifest after    = -1       (pruned)
[probe] live rows after          = 0
[probe] restore threw?           = no
[probe] audit error findings     = 0
```

### Severity: Critical

- **Trigger:** restoring any snapshot in `.knowl/snapshots/` other than the two most recent.
  Under the default `SNAPSHOT_KEEP = 3` that is the steady state — a user with three snapshots
  who wants to go back furthest hits it every time.
- **Blast radius:** every knowledge item, assertion, evidence link, access record, skill row,
  and embedding.
- **Detectability:** none. Exit code 0, no warning, an audit that affirms the store is healthy.
- **Recoverability:** the pre-restore snapshot survives and holds the *pre-restore* state, so
  the data is technically recoverable — but the user has no reason to think anything went
  wrong, and every other snapshot has just been pruned.
- **Aggravating:** this is the recovery path. It runs when the previous state is already gone.

A snapshot copied outside `.knowl/snapshots/` is unaffected, because `pruneSnapshots` only
reads the snapshot directory.

### Fix (two independent guards; ship both)

1. **Protect the source.** Widen `pruneSnapshots` to accept a set of protected paths and pass
   the restore source alongside the new snapshot. Better: do not prune at all during a restore.
2. **Never treat an empty attachment as a snapshot.** `restoreStatements` must refuse when
   `snapshot_restore` holds no `knowledge_items` table, before any `DELETE` is emitted. A
   restore that produces zero `INSERT` statements is not a restore.

Guard 2 is the load-bearing one: it closes the whole class, including any other route that
yields an empty or unreadable attachment. Neither guard is more than a few lines.

The review's proposed full-file-restore redesign (its §3) also fixes this, because it copies the
source to a temporary file before anything destructive runs. That is the right destination, but
it is a redesign; guards 1 and 2 are the hotfix.

## K-NEW-2 — High: the manifest preflight is TOCTOU, by construction

K-NEW-1 is one instance of a general defect. `verifySnapshotManifest` validates the bytes on
disk at line 222; `ATTACH` reads that path again at line 227. Between them Knowl performs a
`VACUUM INTO`, a `stat`, a SHA-256, a file write, and a directory prune. Everything the
preflight proved is stale by the time it is used.

The correct shape is check-then-use on the *same* handle: copy the source to a temporary file
first, verify the copy, and attach the copy. Fixing only K-NEW-1's pruning leaves the window
open to anything else that touches the directory — including a concurrent `knowl snapshot
create` from another process.

## K-NEW-3 — Medium: a hung skill freezes the whole MCP server, not just its own call

The review says "a skill can hang the MCP/CLI indefinitely." It is worse than that, and the
reason matters. [registry.ts:268](../src/skills/registry.ts#L268) and
[registry.ts:296](../src/skills/registry.ts#L296) use **`spawnSync`**, with no `timeout`
option. `spawnSync` blocks the Node event loop. A skill that never exits does not stall one
request — it freezes the entire server process: every other MCP tool call, every hook, every
health check, until the child is killed externally.

Passing `timeout` to `spawnSync` is a one-line fix and should be in the hotfix, independent of
the larger approval-model work.

## K-NEW-4 — Medium: skill import overlays an existing package instead of replacing it

`planSkillInstalls` ([portability.ts:322-343](../src/store/portability.ts#L322-L343)) plans one
install per file *in the incoming package*. Nothing removes files already in the destination
directory. Importing a corrected skill over a compromised one therefore leaves the old files in
place — including scripts the old manifest referenced. The manifest is replaced, so the package
reads as updated while the previous executable content is still on disk and still reachable by
path.

This compounds the review's §4 (non-atomic install). The fix is the same: swap whole package
directories, never merge files into a live one.

## K-NEW-5 — Low–Medium: a failed entrypoint silently triggers a second execution

[registry.ts:359-362](../src/skills/registry.ts#L359-L362): when the requested entrypoint exits
non-zero and a `fallback` entrypoint exists, Knowl runs it automatically. The caller asked for
one execution and gets two, the second not named in the request. Combined with `autoRun` being
self-granted by the package (the review's §5, confirmed), a package can guarantee its
`fallback` runs by making its `default` fail.

## K-NEW-6 — Low: the snapshot fix comment misdescribes the bug it fixed

[snapshots.ts:69-84](../src/store/snapshots.ts#L69-L84) states that `DELETE FROM
knowledge_items` cascaded into `drift_state`. It cannot: `drift_state` has no foreign key to
`knowledge_items` ([bootstrap.ts:190-194](../src/store/bootstrap.ts#L190-L194)). Its primary key
is `project_root`.

Minor on its own; worth recording because the same confusion about which tables the restore
actually owns is the root of the review's §3 — and an explicit table registry is what stops it
recurring.

## K-NEW-7 — Low: release grants OIDC provenance permission but never produces provenance

`.github/workflows/cd.yml` requests `id-token: write` and comments that it is for the OIDC
exchange, but `npm publish --access public` is called without `--provenance`, and
`package.json` has no `publishConfig.provenance`. The permission is granted and unused; no
provenance attestation is generated. The review asked for provenance in §12 without noticing
the wiring is already half-present.

---

# Part 2 — Verdicts on the review's findings

## Confirmed

| # | Review finding | Verdict | Evidence |
|---|---|---|---|
| §2 | Skill import escapes through a pre-existing symlink/junction | **Confirmed, and reproduced on Windows** | See below |
| §3 | Snapshot restore is a partial restore with an incomplete dependency model | **Confirmed** | [snapshots.ts:115-142](../src/store/snapshots.ts#L115-L142) |
| §3 | `knowledge_commit_items` is cascaded away and never restored | **Confirmed, severity raised** | See below |
| §4 | Skill install is not atomic with the DB commit | **Confirmed** | [portability.ts:609-618](../src/store/portability.ts#L609-L618) |
| §5 | `autoRun` is self-granted by the package being imported | **Confirmed** | [registry.ts:328-330](../src/skills/registry.ts#L328-L330) |
| §5 | Child processes inherit the full parent environment | **Confirmed** | [registry.ts:340-345](../src/skills/registry.ts#L340-L345) |
| §5 | No execution timeout | **Confirmed, severity raised — see K-NEW-3** | [registry.ts:296](../src/skills/registry.ts#L296) |
| §6 | Import/export are memory-unbounded; `stream-json` is a dep but unused here | **Confirmed** | See below |
| §6 | N+1 assertion/evidence fetching | **Confirmed** | [portability.ts:69-70](../src/store/portability.ts#L69-L70), [:413](../src/store/portability.ts#L413) |
| §7 | Viewer graph is O(N²) server-side and browser-side | **Confirmed** | [server.ts:101](../src/viewer/server.ts#L101), [ui.ts:330-343](../src/viewer/ui.ts#L330-L343) |
| §7 | Graph response ships full `content` and `reasoning` for every atom | **Confirmed** | [server.ts:62-63](../src/viewer/server.ts#L62-L63) |
| §9 | Bootstrap token stays in the URL; no redirect after the cookie is set | **Confirmed** | [server.ts:158-168](../src/viewer/server.ts#L158-L168) |
| §9 | `/api/retrieval` is a GET that mutates state | **Confirmed** | [agent-query.ts:657](../src/store/agent-query.ts#L657) records access |
| §10 | `saveConfig` is a non-atomic write with no mode hardening | **Confirmed** | [config.ts:197-204](../src/core/config.ts#L197-L204) |
| §11 | Startup trace records project root, hostname, PID, loadavg, freemem at default perms | **Confirmed** | [startup-trace.ts:103-112](../src/core/startup-trace.ts#L103-L112), :151-160 |
| §12 | `package-lock.json` root package is still 3.0.0 | **Confirmed** | `pkg 3.0.1 \| lock root 3.0.0` |
| §12 | CD installs `npm@latest` at publish time | **Confirmed** | `.github/workflows/cd.yml` |
| §13 | CI is Ubuntu-only, Node 22 only, build + test | **Confirmed** | `.github/workflows/ci.yml` |
| §14 | README snapshot section has drifted | **Confirmed, but described backwards — see below** | README:732-734 |
| §14 | `SECURITY.md`, `THREAT_MODEL.md`, `CONTRIBUTING.md` absent | **Confirmed** | — |
| §14 | `docs/audit-2026-08-04.md` declares no version state | **Confirmed** | — |

### §2 symlink escape — reproduced on Windows with a junction, no elevation

The review reproduced the filesystem primitive in a Linux container. It reproduces here through
a **directory junction**, which any user can create on Windows without administrator rights or
Developer Mode:

```
lexical relative = "payload.txt" -> passes containment check: true
file landed at real path: ...\scratchpad\symtest\outside\payload.txt
outside/ now contains: [ 'payload.txt' ]
```

The lexical containment check in `planSkillInstalls` passes, and `fs.mkdir(..., {recursive:
true})` followed by `fs.rename` at
[portability.ts:612-613](../src/store/portability.ts#L612-L613) both follow the junction.

One correction to the review's framing: it presents this purely as an attacker scenario, which
requires the attacker to already have write access inside `.knowl/skills`. The **more likely**
trigger is benign — a user who symlinks a skill directory to share skills between projects, and
then imports an export. No attacker needed for the data to land outside the tree.

### §3 `knowledge_commit_items` — confirmed, and it matters more than the review says

Confirmed: `knowledge_commit_items` references `knowledge_commits`, not `knowledge_items`
([bootstrap.ts:80-81](../src/store/bootstrap.ts#L80-L81)), so `DELETE FROM knowledge_commits`
cascades it away and nothing restores it.

The review calls it "the commit-to-item blast-radius index … may be rebuildable." Per
[retention.ts:565-568](../src/store/retention.ts#L565-L568), that table is precisely what turns
blast-radius lookup from an unindexable leading-wildcard `LIKE` scan into an equality search. A
successful restore therefore silently degrades blast radius to the slow path, with no error and
no notice.

### §6 memory-unbounded import — confirmed, with the mechanism

[portability.ts:361-367](../src/store/portability.ts#L361-L367) reads the whole file to a
string, splits every line, rejoins the body for hashing, and `JSON.parse`s every line into a
retained array — at least four full copies of the input resident at once. Export is the mirror
image: [portability.ts:86](../src/store/portability.ts#L86) builds the entire body as one string
before writing. `stream-json@^3.5.0` is a declared dependency and is used in
`src/cli/agents/lifecycle.ts`, but not here. The review is right on every point.

## Corrected — the review is wrong

### C-1 — "very large stdout/stderr can consume memory" is **false**

The review's §5 lists unbounded child output as a risk. Node's `spawnSync` applies a default
`maxBuffer` of 1 MiB. Measured against a child writing 3 MiB:

```
stdout len: 1114112 | error: ENOBUFS | status: null
```

Output *is* bounded, and the child is terminated. Drop this from the finding list. The genuine
defect in the same area is the missing timeout (K-NEW-3), which the review understated rather
than overstated.

### C-2 — README drift is real but stated backwards

The review says README claims "assertions/evidence links/access are not restored," and implies
the code agrees. README:733-734 does say that — and **the code does the opposite**: those
tables all carry a direct foreign key to `knowledge_items` and are restored. So the README
*understates* what restore touches, which is the more dangerous direction: a user reads that
their assertions are preserved across a restore when they are in fact replaced.

The two concrete drifts to fix:

- README:732 — "validates the manifest when one is present." It is now **required**
  ([snapshots.ts:182-191](../src/store/snapshots.ts#L182-L191)).
- README:733-734 — the restored-subset list is wrong in both directions: assertions, evidence
  *links*, access, skill rows and embeddings **are** restored; the `evidence` table itself,
  `knowledge_commit_items`, sessions, tombstones, code indexes and `drift_state` are **not**.

### C-3 — the evidence foreign-key failure is latent, not live

The review states the restore "can fail" on `knowledge_assertions.source_evidence_id` /
`knowledge_evidence.evidence_id` because `evidence` is not restored. Checked: **no code path
deletes rows from `evidence`.** `gc.ts` does not prune it and there is no `DELETE FROM
evidence` anywhere in `src/`. The referenced rows therefore still exist, and the transaction
does not fail today.

What *is* real is the second half of their claim: the restore links snapshot-era assertions to
current-era evidence, and evidence modified since the snapshot is not rolled back. Keep the
finding, restated: it is a mixed-time correctness defect now, and a hard failure the moment
anyone adds evidence GC. Both are fixed by putting `evidence` in an explicit table registry.

## Downgraded — deliberate, documented tradeoff, not an oversight

### D-1 — §8 process-wide transaction queue

The review reports the global `transactionQueue` as a defect and proposes
`WeakMap<Client, Promise<void>>`. [database.ts:152-157](../src/store/database.ts#L152-L157)
already documents this exact decision and rejects that exact fix:

> The queue is process-wide even though handles are now scoped per async context. […] That is
> deliberate: the cost is serialization the local CLI and a single MCP server never notice, and
> the alternative — a queue per connection — has to be right about which connection a queued
> caller will resolve *after* its wait, which is exactly the reasoning that produced the
> misrouting bug this scoping fixes.

That reasoning is sound. `getClient()` resolves after the queue wait, so a queue keyed on a
connection captured *before* the wait reintroduces the misrouting bug v3.0.1 just fixed. The
review's one-line `WeakMap` sketch has precisely that flaw.

Reclassify: not a v3.0.x defect. It is a **Cloud prerequisite**, and when it is done the queue
must be keyed on the connection resolved *after* the wait, not the one captured before it.

## Not assessed

**§15 competitor comparison.** Nine dimensions scored to one decimal place across five products,
with no methodology, no sources, and no reproducible measurement. Treat as opinion. The
qualitative direction (human inspectability and Cloud maturity are Knowl's weak axes) is
plausible and matches what the code shows; the numbers are not evidence and should not drive
prioritisation. Note that its "Local recovery transparency 6.0" is generous given K-NEW-1.

**§17 ratings.** Same objection. The one line worth carrying forward is that "Data recovery 5.8"
is now unsupportable — with a silent total-wipe path in the documented restore command, recovery
is the single worst area in the product, not a middling one.

---

# Part 3 — Corrected severity table

| Priority | Finding | Severity | Status |
|---|---|---|---|
| **P0** | **K-NEW-1** `snapshot restore` wipes the store and reports success | **Critical** | **New — proven by execution** |
| P0 | K-NEW-2 manifest preflight is TOCTOU | High | New |
| P0 | §2 skill import escapes via pre-existing symlink/junction | High | Confirmed on Windows |
| P0 | §3 restore table ownership is incomplete (`evidence`, `knowledge_commit_items`, sessions, tombstones, code indexes, `drift_state`) | High | Confirmed |
| P1 | §4 + K-NEW-4 skill install is neither atomic nor replacing | Medium–High | Confirmed + extended |
| P1 | K-NEW-3 `spawnSync` has no timeout and blocks the event loop | Medium–High | New |
| P1 | §5 `autoRun` self-granted; full env inherited | Medium (High for Cloud) | Confirmed |
| P1 | §6 import/export unbounded + N+1 | Medium | Confirmed |
| P1 | §7 viewer graph O(N²) and over-fetching | Medium | Confirmed |
| P2 | K-NEW-5 failed entrypoint auto-runs `fallback` | Low–Medium | New |
| P2 | §9 bootstrap token in URL; GET mutates state | Low–Medium | Confirmed |
| P2 | §10 config write non-atomic, no mode | Low–Medium | Confirmed |
| P2 | §11 diagnostics privacy and trim race | Low–Medium | Confirmed |
| P2 | §12 lockfile 3.0.0 vs package 3.0.1 | Low | Confirmed |
| P2 | K-NEW-7 OIDC permission granted, provenance never produced | Low | New |
| P2 | §14 README snapshot drift (wrong in both directions) | Medium (docs) | Confirmed, restated |
| P2 | §13 CI has no matrix, typecheck, lint, or security gate | Medium (process) | Confirmed |
| P2 | K-NEW-6 snapshot comment misdescribes `drift_state` | Low | New |
| — | §8 process-wide transaction queue | Cloud prerequisite | Downgraded — documented tradeoff |
| — | §5 unbounded child output | **Withdrawn** | False — Node caps at 1 MiB |

## Bottom line

The review is a good piece of work — most of it holds, and its structural recommendations
(full-file restore, directory-level skill swaps, an explicit table registry, hash-pinned skill
approval) are the right destinations. It should not be dismissed for the two errors.

But its central reassurance is wrong. Snapshot preflight is not "well implemented"; the
recovery command has a critical silent-total-loss path in the default configuration. That
outranks everything either document lists, and it is a small fix. Nothing else should ship
before it.

**Plan:** [superpowers/plans/2026-08-05-recovery-and-trust-3.0.2.md](superpowers/plans/2026-08-05-recovery-and-trust-3.0.2.md)
