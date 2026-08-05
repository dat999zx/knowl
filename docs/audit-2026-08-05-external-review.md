# External review — Knowl v3.0.1 (received 2026-08-05)

> **Provenance.** This document is an external review of `v3.0.1` (`36c7471`), received
> verbatim from ChatGPT and stored here unedited as the source artefact. Its author states
> they could not resolve `github.com` and therefore could not clone, install, run the test
> suite, or run any dependency scanner; they reviewed source through GitHub raw/blob
> endpoints, and marked the limitation honestly.
>
> **It has not been accepted as-is.** Every claim was re-checked against the working tree at
> `36c7471`. The verdicts — confirmed, corrected, overstated, wrong — plus three findings this
> review missed (one of them a critical silent total-data-loss bug in the recovery path) are in
> [audit-2026-08-05-verified.md](audit-2026-08-05-verified.md). **Read that document, not this
> one, when deciding what to fix.** This file exists so the original wording stays available
> and the corrections can be checked against it.

---

**Audit target:** `v3.0.1` (`36c7471`)
**Audit date:** 2026-08-05
**Scope:** source-level review of the tagged release, release diff, schema/bootstrap logic, portability, snapshots, executable skills, viewer, database context, configuration, diagnostics, CI/CD, README, and competitor positioning.

## Important limitation

The execution container could not resolve `github.com`, so I could not honestly run:

- `git clone`
- `npm ci`
- the local Vitest suite
- `npm audit`
- OSV/CodeQL
- cross-platform runtime tests
- full benchmarks

I reviewed the tagged source directly through GitHub raw/blob endpoints. The published release workflow itself runs `npm ci`, `npm run build`, and `npm test` on Ubuntu/Node 22 before publishing, so the release indicates those project tests passed in the official Ubuntu release job. That is not a substitute for an independent run, Windows/macOS testing, hostile-input fuzzing, or dependency scanning.

## Executive verdict

v3.0.1 is a **real improvement** over v3.0.0. It fixes the previously reported lexical traversal, skill identity mismatch, namespace misrouting race, viewer crash/auth gap, and snapshot preflight gap.

However, two recovery/trust-boundary problems remain serious:

1. **Imported skills can still escape through a pre-existing symlink/junction**, despite lexical path containment.
2. **Snapshot restore is still a partial logical restore with an incomplete dependency model**, so it can fail on evidence foreign keys or produce a mixed-time store and lose derived history indexes.

The codebase's strongest area remains its governed knowledge architecture. Its weakest areas are executable-skill trust, recovery semantics, import scalability/atomicity, cross-platform/supply-chain CI, and Cloud tenant isolation.

## Severity summary

| Priority | Finding | Severity | Confidence |
|---|---|---:|---:|
| P0 | Skill import follows pre-existing symlink/junction outside `.knowl/skills` | High | Confirmed filesystem behavior + source |
| P0 | Snapshot restore omits standalone/indirect tables and can produce mixed-time state | High data-integrity | Confirmed source/schema |
| P1 | Skill-file installation can partially succeed after DB commit | Medium–High | Confirmed source |
| P1 | Executable skill approval is package-controlled and processes inherit all secrets | High for Cloud | Confirmed source |
| P1 | Import/export load entire JSONL streams into memory | Medium availability | Confirmed source |
| P1 | Viewer graph construction/rendering scales quadratically | Medium performance | Confirmed source |
| P1 | Process-wide transaction queue creates cross-store head-of-line blocking | Medium for Cloud | Confirmed source |
| P2 | Viewer bootstrap token remains in URL/history | Medium–Low privacy | Confirmed source |
| P2 | Config writes are non-atomic and not permission-hardened | Medium–Low | Confirmed source |
| P2 | Startup trace stores sensitive local metadata with default permissions | Low–Medium | Confirmed source |
| P2 | `package-lock.json` still identifies the root package as 3.0.0 | Low release quality | Confirmed |
| P2 | README snapshot and product-scope wording still drift from source | Medium docs | Confirmed |
| P2 | CI/CD lacks platform, security, coverage, packaging, and migration gates | Medium engineering risk | Confirmed |

---

# 1. What v3.0.1 fixed successfully

## 1.1 Lexical path traversal

The old importer derived both the containment root and target from untrusted `skill.name`. v3.0.1 now:

- validates skill names;
- anchors them under a fixed `.knowl/skills` base;
- normalizes file paths;
- rejects lexical paths outside the skill directory;
- stages content before opening the DB transaction.

That closes names such as `../../../outside`.

## 1.2 Skill manifest/directory confusion

A package stored as `foo` can no longer declare itself as `bar` and make execution follow the manifest identity. The directory is now authoritative and a mismatch is rejected.

## 1.3 Shell runtime-argument injection

Shell entrypoints now reject runtime args instead of appending allegedly escaped strings. Script entrypoints use argv arrays. This closes the concrete `$(...)`, backtick, and Windows command-shell injection route previously identified.

## 1.4 Namespace database misrouting

Database handles are now scoped with `AsyncLocalStorage`, preventing a concurrent project write from silently using a temporarily selected session database.

This is a meaningful correctness fix, although Cloud should still use explicit tenant/store handles rather than implicit process context.

## 1.5 Viewer security baseline

The local viewer now includes:

- a random per-launch token;
- timing-safe comparison;
- loopback Host validation;
- route-level failure handling;
- CSP;
- `X-Content-Type-Options`;
- `Referrer-Policy`;
- `frame-ancestors 'none'`.

This closes the malformed-URL process crash and materially improves protection against hostile browser pages probing loopback.

## 1.6 Snapshot preflight

Restore now requires a sidecar manifest and validates:

- file size;
- SHA-256;
- supported schema version;
- attached SQLite `integrity_check`;
- attached `user_version`;

before destructive SQL is executed.

That is necessary and well implemented. It does **not**, however, fix the incomplete logical restore described below.

---

# 2. P0 — imported skill symlink/junction escape remains

## Source shape

The importer validates only lexical paths:

```ts
const base = path.resolve(projectRoot, '.knowl', 'skills');
const skillDir = path.resolve(base, skill.name);
const target = path.resolve(skillDir, ...normalized.split('/'));
const relative = path.relative(skillDir, target);
```

After the DB commits, it runs:

```ts
await fs.mkdir(path.dirname(install.target), { recursive: true });
await fs.rename(stagedFile, install.target);
```

## Exploit condition

Assume a valid path already exists as a symlink:

```text
.knowl/skills/safe -> /outside
```

An imported package named `safe` with file `payload.txt` passes every lexical check because:

```text
lexical target = <project>/.knowl/skills/safe/payload.txt
```

But `mkdir` and `rename` follow the symlinked parent, producing:

```text
real target = /outside/payload.txt
```

I reproduced the equivalent filesystem operation in the local container. The payload landed outside the trusted tree.

On Windows, the analogous risk includes directory junctions/reparse points.

## Impact

Importing a crafted export can write outside `.knowl/skills` when an attacker can cause or exploit a pre-existing symlink/junction under the skill base.

This is not as trivially reachable as the old `../` bug, but it remains a genuine arbitrary-file-write boundary failure.

## Correct fix

Do not install individual files into an existing package path.

1. Ensure `.knowl/skills` exists and `lstat` confirms it is a real directory, not a symlink/reparse point.
2. Create a new temporary package directory **directly under that trusted base**:
   ```text
   .knowl/skills/.import-<random>/
   ```
3. Write all package files into that newly created directory. Since Knowl created every ancestor, imported data cannot inject symlinks.
4. Validate the completed package.
5. If the destination exists:
   - `lstat` it;
   - reject symlinks/reparse points;
   - rename it to a backup directory.
6. Rename the staged package directory to the final package name.
7. Delete the backup after success.
8. Keep a tiny recovery journal so a crash between the two renames can be repaired.

Add tests for:

- POSIX symlink at the skill directory;
- symlink at a nested parent;
- Windows junction/reparse point;
- destination replacement;
- crash/failure after backup rename;
- concurrent imports of the same skill.

---

# 3. P0 — snapshot restore is still incomplete and internally inconsistent

## Current restore ownership rule

`restoreStatements()` restores:

1. `knowledge_items`;
2. every table with a **direct foreign key to `knowledge_items`**;
3. standalone `knowledge_commits`.

This is better than the old hard-coded five-table list, but it is not a complete snapshot dependency graph.

## Tables omitted from a normal v3.0.1 database

The bootstrap schema includes standalone or indirectly dependent tables such as:

- `knowledge_commit_items` → references `knowledge_commits`, not `knowledge_items`;
- `evidence`;
- `memory_sessions`;
- `memory_session_events` → references sessions;
- `host_session_bindings` → references sessions;
- `mcp_call_commits`;
- `knowledge_tombstones`;
- `code_files`;
- `code_symbols`;
- `code_symbol_edges`;
- `drift_state`.

These remain at their **current** values while the item/history subset is restored to the snapshot's time.

## Concrete correctness failures

### Evidence foreign keys

`knowledge_assertions` is restored because it directly references items, but its `source_evidence_id` references `evidence`, which is not restored.

`knowledge_evidence` is also restored, but `evidence` is not.

Therefore:

- if a referenced evidence ID no longer exists in the live DB, the transaction can fail;
- if it exists, the restore links snapshot-era assertions/items to current-era evidence;
- deleted or modified evidence is not recovered.

### Commit index loss

`knowledge_commits` is deleted and restored. Deleting it cascades `knowledge_commit_items`, but that index table is not restored.

A successful restore therefore loses the commit-to-item blast-radius index. It may be rebuildable, but the recovery operation should not silently discard it.

### Mixed-time lifecycle state

Sessions, host bindings, tombstones, drift state, and code indexes stay current. This can produce combinations such as:

- an old item restored while a newer tombstone remains;
- snapshot knowledge paired with current code symbols;
- current agent watermarks referencing a history timeline that was replaced;
- current drift watermark attached to restored knowledge.

## Post-restore failure behavior

The audit runs **after** the destructive transaction has committed. On error, Knowl throws a `SnapshotRestoreAuditError` containing the pre-restore snapshot path, but does not automatically put the original DB back.

That is better than silent success, but poor recovery ergonomics: the command used during a crisis can leave the user in a known-bad restored state.

## Recommended redesign: full database restore

A SQLite snapshot created with `VACUUM INTO` should be restored as a complete SQLite database.

Recommended algorithm:

1. Require and verify manifest, hash, byte size, schema stamp, and SQLite integrity.
2. Copy the source snapshot to a temporary DB beside the live DB.
3. Open the temporary copy—not the source—and run supported migrations.
4. Run the complete audit against the temporary DB.
5. Close all live DB handles.
6. Create/verify the pre-restore backup.
7. Move live DB to a backup name.
8. Atomically rename the audited temporary DB to the live path.
9. Clean/reconcile `-wal` and `-shm` sidecars.
10. Reopen and smoke-test.
11. Automatically roll back the file swap if reopening/audit fails.

Cross-platform rename behavior must be tested on Windows.

If you intentionally want a **knowledge-subset rollback**, expose a different command with an honest name, such as:

```text
knowl knowledge rollback
```

and define its complete table ownership explicitly.

## Required regression test

Create distinct "snapshot-era" and "current-era" values in **every application table**, restore, then assert one of two contracts:

- full restore: every table equals snapshot state; or
- partial restore: every table explicitly classified as restored, preserved, rebuilt, or invalidated.

CI should fail whenever a new application table is added without entering that registry.

---

# 4. P1 — skill installation is still not atomic with the DB

v3.0.1 commits the DB transaction, then renames staged files one by one.

If file 1 succeeds and file 2 fails:

- the database import is committed;
- file 1 is installed;
- the remaining files are absent;
- the staging directory is deleted in `finally`;
- there is no automatic rollback or completion record.

This is visible rather than silent, which is better, but still leaves partial state.

## Fix

Stage and install one complete skill directory at a time using directory-level swaps and a recovery journal. Do not treat N individual file renames as one package installation.

Include fault-injection tests at every filesystem operation.

---

# 5. P1 — executable skills still lack an independent trust boundary

## Current behavior

Execution requires `entrypoint.autoRun === true`, but that value is stored in the package's own manifest. A package author or imported package therefore grants its own permission.

Child processes inherit:

```ts
{
  ...process.env,
  KNOWL_PROJECT_ROOT,
  KNOWL_SKILL_NAME,
  KNOWL_SKILL_DIR
}
```

No explicit timeout or output ceiling is passed to `spawnSync`.

Shell entrypoints remain arbitrary shell command strings by design, and PowerShell runs with `ExecutionPolicy Bypass`.

## Risks

- imported executable packages can carry their own approval;
- API keys, GitHub tokens, cloud credentials, proxy credentials, and SSH-related variables may be exposed;
- a skill can hang the MCP/CLI indefinitely;
- very large stdout/stderr can consume memory;
- network and filesystem access are unrestricted;
- a package update does not invalidate any approval concept.

## Correct model

Keep package intent separate from local trust.

```json
{
  "skill": "deploy-preview",
  "approvedHash": "sha256:...",
  "approvedBy": "user:...",
  "approvedAt": "...",
  "entrypoints": ["default"],
  "environment": ["PATH", "HOME"],
  "network": "deny",
  "timeoutMs": 30000,
  "maxOutputBytes": 1048576
}
```

Rules:

- imported skills start untrusted;
- a human approves a specific package hash;
- any file/manifest edit invalidates approval;
- manifest `autoRun` means "this entrypoint is designed to run," not "the user approved it";
- child environment is allowlisted;
- secrets are opt-in per skill;
- time and output limits are enforced before result formatting;
- Cloud never runs customer skills inside the normal API process.

For Cloud, initially sync skill packages as opaque artifacts only.

---

# 6. P1 — import/export are memory-unbounded

Import currently:

- reads the whole file;
- splits every line;
- rebuilds the body for hash verification;
- parses every record;
- retains arrays for all record classes.

A large or malicious JSONL stream can exhaust memory. The package already depends on `stream-json`, but portability does not use streaming.

## Fix

Implement streaming JSONL processing with:

- incremental SHA-256;
- maximum total bytes;
- maximum line size;
- maximum record count;
- maximum atom size;
- maximum skill count/file count/file bytes;
- per-record Zod schemas;
- bounded temporary staging;
- batched SQL;
- streamed export writes;
- batched assertion/evidence fetching to remove N+1 patterns.

Cloud should enforce workspace-level quotas in addition to parser limits.

---

# 7. P1 — viewer graph does not scale

## Server-side

For every isolated node, the server performs:

```ts
nodes.find(...)
```

which is O(N²) in the worst case.

The graph response also includes full `content` and `reasoning` for every atom, even though users inspect only one at a time.

## Browser-side

The force simulation performs pairwise repulsion for all nodes:

```text
O(N²) per simulation step
```

and settles over many animation steps. A repository with thousands of atoms can freeze the browser or create a very large initial response.

## Fix

- return graph summaries only: id, title, category, tags, state, degree;
- load full atom/evidence/timeline lazily on selection;
- replace isolated-node lookup with a category representative map;
- cap or cluster visible nodes;
- offer filters before loading;
- use a Web Worker;
- use Barnes–Hut/quadtree repulsion or a mature graph layout engine;
- add a performance test at 1k, 5k, and 20k atoms.

The existing viewer is strong UX for small/medium repositories; this is a scale issue, not a reason to remove it.

---

# 8. P1 — transaction serialization is process-wide

Async context fixed correctness, but `transactionQueue` remains global. Transactions against unrelated database connections wait for one another.

That is acceptable for a local single-project MCP process, but harmful for a multi-tenant Cloud process:

- one slow tenant blocks unrelated tenants;
- restore/GC/import can create head-of-line blocking;
- latency becomes workload-coupled across stores.

## Fix

Use a per-client/per-database queue:

```ts
const queues = new WeakMap<Client, Promise<void>>();
```

Better still, make `StoreContext` explicit throughout Cloud code and avoid any global fallback context.

Add a concurrency isolation test with randomized operations across two DBs that proves:

- zero row crossover;
- no accidental serialization where not required;
- correct rollback isolation;
- stable behavior under restore/import/GC.

---

# 9. P2 — viewer bootstrap token remains in browser history

The printed URL contains `?token=...`; the viewer sets a cookie, but does not immediately redirect to `/`.

Even with `Referrer-Policy: no-referrer`, the secret remains in:

- browser history;
- copied URLs;
- screenshots;
- browser-extension visibility.

## Fix

Treat the query token as one-time bootstrap material:

1. verify token;
2. set HttpOnly, SameSite=Strict cookie;
3. consume/rotate bootstrap token;
4. return `302 Location: /`.

The local server uses HTTP loopback, so `Secure` cookies are not universally available. Document the boundary.

Also consider making `/api/retrieval` POST because it records access telemetry. A GET route that mutates state is surprising and can be retried/prefetched.

---

# 10. P2 — config durability and permissions

`saveConfig` writes directly to `.knowl/config.json`.

Risks:

- interruption can leave truncated JSON;
- concurrent writers can lose changes;
- file mode depends on umask;
- literal provider keys are permitted.

## Fix

- write a same-directory temporary file;
- mode `0600` where supported;
- flush file;
- atomic rename;
- flush directory where supported;
- optionally use a lock/version check;
- prefer environment references or OS secret storage.

The new env-reference-preservation logic is good and should remain.

---

# 11. P2 — startup trace privacy and race

Startup diagnostics can contain:

- exact project root;
- hostname;
- PID;
- Node version;
- load averages;
- free memory.

The trace directory/file use default permissions. Multiple server processes can also race while trimming/rewriting the shared JSONL file.

## Fix

- diagnostics dir `0700`;
- trace file `0600`;
- hash/redact project path by default;
- never add argv or environment values;
- atomic rotation under a lock;
- `knowl diagnostics clear`;
- retention and contents documented in README/privacy docs.

---

# 12. Release metadata and dependency management

## Confirmed lockfile drift

`package.json` says `3.0.1`; `package-lock.json` still says `3.0.0` for the root package.

Fix with:

```bash
npm install --package-lock-only
```

and add CI:

```js
assert(packageJson.version === lock.version);
assert(packageJson.version === lock.packages[""].version);
```

## Dependency audit limitation

I could not run `npm audit` or OSV and therefore do **not** claim the lockfile is vulnerability-free.

The project should add automated updates/scans. Zod v4 is available while Knowl remains on v3; this is an evaluation candidate, not an emergency. Major upgrades such as Zod/Commander should be isolated from security hotfixes.

Test newer `@libsql/client` versions carefully because Knowl already contains workarounds around transaction/runtime behavior.

## Useful gates

- Dependabot or Renovate;
- `npm audit --omit=dev`;
- OSV Scanner;
- dependency-review action;
- CodeQL;
- SBOM;
- npm provenance;
- pinned GitHub Action SHAs;
- pinned npm version in release jobs.

The current CD job installs `npm@latest` at publish time, making release behavior change independently of the repository. Pin a reviewed npm version.

---

# 13. CI/CD gaps

Current CI is Ubuntu/Node 22 only and runs build + tests.

For a tool that manipulates paths, launches PowerShell/shell scripts, uses SQLite/WAL, registers hooks, and supports Windows/macOS, this is too narrow.

## Add a matrix

- Ubuntu, Windows, macOS;
- minimum supported Node;
- current LTS/current supported Node;
- normal and path-with-spaces workspaces.

## Add jobs

- TypeScript typecheck;
- ESLint;
- format check;
- coverage threshold;
- dependency/security scans;
- migration tests from every supported schema;
- snapshot roundtrip covering every application table;
- hostile JSONL/path fuzzing;
- symlink/junction tests;
- concurrent namespace/store tests;
- `npm pack` + clean install smoke test;
- CLI/MCP help-doc generation drift check;
- performance budgets for hooks, retrieval, import, and viewer graph generation.

The release job does run build/tests before publish, which is good. Add `npm pack --dry-run` and install/test the generated tarball rather than testing only the source tree.

---

# 14. README and docs drift still present

## Product scope remains too narrow

Canonical package metadata says:

> A Knowledge Operating System for AI Agents

The README hero says:

> Local-first, structured project memory for AI coding agents.

Coding agents are the strongest wedge, but the system also stores general facts, goals, constraints, state, decisions, skills, and evidence without requiring code.

Recommended hero:

> **Knowl is a local-first Knowledge Operating System for AI agents.**
> It gives agents durable, governed knowledge across sessions, tools, repositories, and workstreams—while keeping current truth, history, provenance, and evidence explicit.

Then say software engineering is the primary use case.

## Snapshot section is stale

README says:

- manifest is validated "when one is present," but v3.0.1 requires it;
- restored subset is items, commits, skill rows, and embeddings;
- assertions/evidence links/access are not restored.

Current code dynamically restores direct item dependents, so assertions, links, access, skills, and embeddings can be included—but evidence itself is not.

Rewrite only after deciding whether restore means full DB restore or partial knowledge rollback.

## Internal audit ledger needs version state

`docs/audit-2026-08-04.md` describes audits against `fork/mainline-2.16`. It remains useful historical evidence, but should declare:

- applicable version;
- superseded-by release/issues;
- verification date against v3.0.1;
- which open findings remain.

Otherwise readers may treat a historical ledger as the current security state.

## Schema has two partial sources of truth

`bootstrap.ts` contains application tables/columns not fully mirrored in `schema.ts`. This split contributed to recovery/table-ownership errors.

Create one canonical table registry or generate:

- Drizzle schema;
- bootstrap/migrations;
- audit ownership;
- snapshot policy;
- docs.

At minimum, CI should enumerate live application tables and compare them with restore/audit registries.

## Missing security/project docs

Add:

- `SECURITY.md`;
- `THREAT_MODEL.md`;
- `CONTRIBUTING.md`;
- supported-version policy;
- private vulnerability reporting instructions;
- disclosure timeline;
- Cloud vs local trust-boundary document.

Generate CLI commands, MCP tools, embedding presets, and config defaults from source to prevent future README drift.

---

# 15. Competitor comparison after v3.0.1

Qualitative engineering scores—not benchmark numbers:

| Aspect | Knowl 3.0.1 | ByteRover | Basic Memory | Claude-Mem | AgentMemory |
|---|---:|---:|---:|---:|---:|
| Governed current truth | **9.8** | 8.4 | 7.4 | 5.8 | 7.8 |
| Provenance/evidence | **9.6** | 8.8 | 8.1 | 6.5 | 8.3 |
| Human inspectability/editing | 6.6 | **10** | **10** | 5.5 | 5.3 |
| Automatic capture | 8.7 | 9.5 | 7.1 | **9.8** | 9.6 |
| AI-independent core | **9.7** | 7.2 | 9.2 | 6.8 | 8.5 |
| Local recovery transparency | 6.0 | 9.0 | **9.6** | 8.0 | 8.0 |
| Cloud/team maturity | 4.8 | **9.6** | 9.3 | 7.6 | 8.3 |
| Cross-platform/release hardening | 6.0 | **9.2** | 8.8 | 8.5 | 8.4 |
| Docs/product polish | 6.5 | **9.4** | 9.0 | 8.7 | 8.4 |

## What to copy—not clone

### From ByteRover

- persistent daemon/service to amortize startup and hook work;
- package-level version control/review UX;
- polished Cloud/team workflows;
- cross-platform packaging and operational diagnostics;
- visible review queues.

### From Basic Memory

- human-readable export/view that is always reconstructable;
- simple recovery guarantees;
- sync conflict UX;
- documentation discipline around file ownership and portability.

Knowl should not replace SQLite atoms with Markdown, but a generated, reviewable Markdown mirror/export would improve trust and Git workflows.

### From Claude-Mem

- invisible capture and persistent worker architecture;
- progressive disclosure;
- operational simplicity.

### From AgentMemory

- integration matrix;
- server health/readiness endpoints;
- explicit remote/protected deployment configuration;
- broad compatibility tests.

## Knowl's defensible lead

Do not chase competitors feature-for-feature. Knowl's strongest line remains:

> **The AI may suggest what changed. Knowl governs what agents are allowed to treat as current truth.**

Cloud should monetize synchronization, team governance, approvals, identities, auditability, and operations—not cripple local retrieval.

---

# 16. Recommended release order

## v3.0.2 — recovery/security hotfix

1. Reject symlink/junction/reparse parents during skill import.
2. Install whole skill packages atomically, not files one by one.
3. Replace snapshot subset restore with full audited file restore—or disable/rename it until correct.
4. Auto-rollback failed restores.
5. Fix package-lock version.
6. Add regression/fault-injection tests for all above.

## v3.1 — hardening release

1. External hash-pinned skill approvals.
2. Environment allowlist, timeout, output cap, capability policy.
3. Streaming bounded import/export.
4. One-time viewer bootstrap token + clean redirect.
5. Lazy/scalable viewer graph.
6. Atomic secure config writes.
7. Private diagnostics permissions/rotation.
8. Full platform/security/packaging CI.
9. README/security/threat-model rewrite.

## Before Knowl Cloud alpha

1. Explicit `StoreContext`/tenant handle on every operation.
2. Per-store transaction queues.
3. AuthN/AuthZ at every query/write/sync boundary.
4. Customer skills never execute in the API process.
5. Idempotent append/sync protocol with quotas and bounded payloads.
6. Tested full backup/restore/delete lifecycle.
7. Tenant-isolation, concurrency, fault, and abuse tests.
8. Audit logs and approval policies.
9. Secret handling/KMS design.
10. Incident response and vulnerability disclosure process.

---

# 17. Updated rating

| Area | v3.0.0 audit | v3.0.1 |
|---|---:|---:|
| Knowledge architecture | 9.6 | **9.6** |
| Retrieval | 9.3 | **9.3** |
| Local utility | 8.7 | **8.8** |
| Namespace/concurrency correctness | 6.0 | **8.0 local / 6.5 Cloud** |
| Viewer security | 5.5 | **8.0 local** |
| Import security | 4.5 | **6.5** |
| Data recovery | 5.0 | **5.8** |
| Executable-skill security | 4.5 | **5.5** |
| Docs accuracy | 5.3 | **6.5** |
| CI/supply chain | 5.0 | **5.0** |
| Cloud readiness | 4.5 | **4.8** |
| Overall local product | 8.4 | **8.6** |

## Bottom line

v3.0.1 fixed the exact issues it claimed to fix at the lexical/concurrency/viewer/preflight layers. Nice release.

The remaining highest-value work is not another feature. It is:

- filesystem-real containment, not string containment;
- complete and atomic recovery semantics;
- independent executable-skill trust;
- bounded streaming imports;
- cross-platform/security CI;
- explicit Cloud tenant boundaries.

Once those are done, Knowl Core will be in a much healthier state to support a paid Cloud layer.
