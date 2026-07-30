# Workspace Repo Role and Default Visibility Design

## Goal

Record each repository's nature in the workspace manifest — what it is, whether its knowledge is
cross-cutting by default, and which repositories share its lineage — so that sharing decisions
follow from recorded fact rather than from each agent re-deriving them.

## Problem

`knowl workspace add` stores a name and a path. Nothing else. But repositories in a workspace
have materially different natures: a code repository with private internals, a pure-knowledge
repository whose entire content is meant to be visible everywhere, two forks with diverged
conventions. That nature drives every later sharing decision, and today it lives nowhere.

The consequence is not random error, it is *consistent* error. Each agent re-derives repository
nature from whatever it can see, and arrives at the same uniform "share selectively" posture for
every repository, because that posture is correct for the common case and nothing contradicts it
for the uncommon one. Observed in practice: roughly 10% of two code repositories was correctly
promoted, then the same filter was wrongly applied to a notes-only repository whose entire
content was meant to be workspace-visible.

`workspace promote` is the existing answer, and it is the right answer for a repository with
internals. For a repository with none it is an advisory rule — "remember to promote each new
item" — and advisory rules are exactly what gets forgotten.

A second, smaller gap: a manifest copied to another machine and adopted with `workspace join`
carries names and paths, so an agent starting there has no idea what any of these repositories
are.

## Non-goals

- **No demote.** Promotion stays one-way. See "Safety posture" for why an inverse is not offered.
- **Role text is never parsed.** No behavior is inferred from its content, ever.
- **Kin does not affect query results.** It changes how many candidates the cross-repo *write*
  advisory inspects, and nothing about ranking, `knowl_query`, or federated query.
- **No per-result role in `knowl_query`.** Each result already carries `repo`; attaching role
  would repeat the same string on every hit for no decision it enables at that point.

## Design

### 1. Manifest schema: three additive fields

```ts
export type WorkspaceRepo = {
  name: string;
  path?: string;
  git?: { remote?: string };
  addedAt?: string;
  /** Free text for agents. Never parsed, never drives behavior. */
  role?: string;
  /** Visibility stamped on new writes here. Absent === 'repo', today's behavior. */
  defaultVisibility?: 'repo' | 'workspace';
  /** Group name. Repos sharing it are kin -- same lineage, diverged conventions. */
  kin?: string;
};
```

**Manifest, not `.knowl/config.json`.** The link record in config is machine-local; the manifest
is what `workspace join` copies to a second machine. Putting `defaultVisibility` in config would
let machine 2 silently default back to private — the same divergence-by-omission that the
embedding identity check in `assertEmbeddingCompatible` exists to prevent.

`version` stays `1`. The fields are additive and every one is optional.

**Round-trip safety in both directions.** An *older* knowl preserves these fields for free today,
because `readManifest` passes `raw.repos` through untouched and `writeManifest` re-serializes the
object. To keep that property going forward, the new per-entry normalization must spread each
entry rather than rebuild it, so a field written by a *newer* version survives a pass through
this one.

**Normalization in `readManifest`**, mirroring the existing `raw.mode === 'shared' ? … : 'linked'`
pattern:

| Field | Rule |
| --- | --- |
| `defaultVisibility` | Exactly `'workspace'`, else `'repo'`. |
| `role` | Trimmed, newlines collapsed to spaces, capped at 200 characters. |
| `kin` | Must satisfy `isValidRepoName`'s charset rule, else dropped. |

Two properties are load-bearing. Normalization **never throws**: `discoverRepos` reads every
manifest on the machine to decide what `upgrade --all` visits, so a manifest this function
rejects would take down a machine-wide command rather than one repository. And every
unparseable input **resolves toward private**: the failure mode of a garbled value must be
"shared less than intended", never "published without being asked".

The 200-character cap on `role` is not arbitrary tidiness. Role text renders into the
session-start context block on every session in every linked repository, so it is a token budget
item.

### 2. Write path: extend the existing cache, do not add a second

`src/store/write-ownership.ts` already resolves the active workspace lazily and caches it per
config root. That cache **is** the 2.7.1 fix — 2.7.0 resolved the workspace inside
`storeKnowledgeItemDeduped`, so every write paid a `loadConfig` read and JSON parse, and a loop
of 2500 writes died around 2000. Default visibility rides the same resolution rather than adding
a parallel manifest read per write:

```ts
export type WriteDefaults = { repo: string | null; visibility: 'repo' | 'workspace' };
export async function resolveWriteDefaults(): Promise<WriteDefaults>;
export async function resolveWritingRepo(): Promise<string | null>;  // stays, thin wrapper
```

`resetWriteOwnershipCache()` continues to clear it; tests depend on that.

**`createKnowledgeItem` hardcodes `'repo'` twice** — implicitly in the row (the column default,
since `visibility` is absent from the insert literal) and literally inside `hashKnowledgeLifecycle`.
Both must read one variable. Letting them disagree is not cosmetic: `lifecycle_hash` is exactly
what change-notification (`src/store/change-watermark.ts`) and import policy
(`src/store/import-policy.ts`) compare to decide whether an item changed. A row saying
`visibility = 'workspace'` whose hash was computed over `'repo'` is a silent, permanent
divergence between the two.

Landing this at `createKnowledgeItem` — the single funnel every write passes through — means it
covers MCP store, batch ingest, synthesis and candidate promotion with no per-caller opt-in.

**Staleness is stated, not engineered away.** The cache is process-lifetime. `workspace set
--default-visibility` runs in a separate CLI process, so a long-lived MCP server keeps the old
default until its next start. The command's output says so. Re-reading the manifest per write to
avoid this is precisely the regression 2.7.1 fixed, and the trade is not close: the stale window
ends at the next session, and it fails toward whichever value was already in effect.

### 3. Safety posture

`--default-visibility workspace` is a step up in risk from `promote`. Promote is explicit and
per-batch; this is standing and automatic, so a wrong setting keeps publishing until someone
notices. There is no demote, and there should not be: a peer may already have read the item, and
`change-watermark` may already have delivered a notification for it. An inverse that un-shares
going forward while implying it un-shared retroactively would be worse than no inverse at all.

What the feature offers instead is a loud gate at both entry points, `add` and `set`:

```
Repo "duck" will write new knowledge at workspace visibility.
Every item written here becomes readable by all linked repos immediately, with no review step.
This cannot be undone: there is no demote. `knowl workspace set --default-visibility repo`
stops future writes only; anything already shared stays shared.
```

`workspace set` may only edit **this repo's own entry**, the same ownership rule that governs
promote, update and retire.

**Constraint on automated repair.** `doctor --fix` and `upgrade --all` are a machine-wide
automated write channel dispatching on the `DoctorRemedy` union. The safety posture above is
worth nothing if a remedy kind can flip visibility. Therefore: **no `DoctorRemedy` may ever
change an item's `visibility` or a repository's `defaultVisibility`.** The current union —
`guidance`, `gitignore`, `session-recover`, `reindex-vectors`, `host-init` — satisfies this;
the constraint exists to keep it satisfied. This is consistent with the rule already stated in
`doctor-remedy.ts`, that only findings with a genuinely safe automatic answer get a remedy.

The related sweep in `upgrade` claims `origin_repo` on unowned rows and touches `visibility`
never. Ownership and default visibility stay orthogonal, and a test pins that.

### 4. CLI surface

```
knowl workspace add <workspace> [--name <n>] [--role <text>]
                                [--default-visibility repo|workspace]
                                [--kin <group>] [--promote-existing] [--force]
knowl workspace set  [--role <text>] [--default-visibility repo|workspace] [--kin <group>]
knowl workspace join <manifest-path> …          # unchanged
```

`set` with no flags prints the current values rather than erroring, so it doubles as the way to
read them.

`join` deliberately gains none of these flags. Machine 2 inherits what machine 1 recorded, which
is the entire reason the fields live in the manifest rather than in local config. Changing them
afterwards is `set`.

One honest limit, inherited from workspace v1 rather than introduced here: manifests do not
sync. `join` copies one, once. So `set` edits the local copy, and a change made on one machine
reaches another only when its manifest is copied again. This is the same known limit that
already applies to `repos` and `retiredNames`, and it is not in scope to fix.

**`--promote-existing`** addresses the split-brain at link time: a repository linked with
`--default-visibility workspace` that already holds 500 private notes is half-shared, which is
the original inconsistency in a new form. Adding the flag keeps bulk publishing an explicit
gesture, which is the rule `promoteItems` already enforces by refusing a bare promote.

- Valid only alongside `--default-visibility workspace`. **Rejected, not ignored**, otherwise —
  the rule `knowl upgrade` established for its own `--all`-only flags, and for the same reason:
  a flag that silently does nothing is how you end up believing something ran.
- Implemented as `promoteItems({ projectRoot, repoName, categories: [...KNOWLEDGE_CATEGORIES],
  apply: true })`. The exported category list is the explicit full selector, so no new promote
  path is needed. It is spread because `KNOWLEDGE_CATEGORIES` is a `readonly` tuple and
  `promoteItems` takes a mutable `KnowledgeCategory[]`.
- Runs **after** `joinWorkspace` and its `backfillOriginRepo`. Promote selects on ownership; run
  before ownership is stamped it selects nothing.

Without the flag, `add` reports the count and names the command:

```
500 existing items are still private.
Share them with:
  knowl workspace promote --category "fact,decision,goal,constraint,architecture,state,skill" --apply
```

The list is quoted in the printed command because `knowl.cmd` runs through `cmd.exe`, which
splits an unquoted comma list on the commas — the failure `workspace promote` was just hardened
against. Guidance that prints a command must print one that works on the platform reading it.

### 5. Surfacing

**Session-start context block.** `formatRecentContextToMarkdown` takes an optional `workspace`
input. Absent produces byte-identical output, mirroring the rule `formatWorkspaceBlock` already
holds for unlinked projects.

```
## Workspace: knowl-ws
- knowl (this repo) — the Knowl CLI and MCP server — new writes stay private
- duck [kin: forks] — personal notes and reading log — new writes are workspace-visible
```

This is the surface that addresses the stated problem: an agent gets repository natures *before*
it makes its first sharing decision, rather than deriving them afterwards.

**`formatWorkspaceBlock`** (`knowl status`, `knowl workspace status`) gains role and default
visibility beside the existing present/missing state.

**`describeWriteReconciliation`** (`src/mcp/tools.ts`) folds the kin marker and the peer's role
into the existing overlap note.

### 6. Kin weighting

`CrossRepoOverlap` gains `kin?: boolean` and `role?: string`. In `findCrossRepoOverlap`:

- A peer sharing this repository's `kin` group is checked for `KIN_PEER_CANDIDATES` (6)
  candidates instead of `PEER_CANDIDATES` (3).
- `sameSubjectTitle` is **untouched**. Loosening the matcher for kin peers would surface
  near-miss titles at the cost of noise on every write in a kin pair; annotating does not.
- The bound stays a bound. This runs on every knowledge write in a workspace.

The advisory gains one clause for a kin hit: a kin repository shares this one's lineage, so a
same-subject match is more likely a real divergence in convention than a coincidence of wording.
The existing advice is unchanged otherwise — the item still belongs to another repository and
still cannot be retired from here.

## Testing

Per-unit tests for each module, plus these properties:

| Property | Why |
| --- | --- |
| Manifest round-trip preserves unknown repo fields | Forward compatibility with a newer writer |
| Garbled `defaultVisibility` reads as `'repo'` | Unparseable resolves toward private |
| `readManifest` never throws on a malformed entry | `discoverRepos` reads every manifest machine-wide |
| `createKnowledgeItem` stamps visibility **and** a matching `lifecycle_hash` | The two-site hazard in §2 |
| `upgrade` claims ownership without touching visibility | Ownership and visibility stay orthogonal |
| `--promote-existing` without `--default-visibility workspace` is refused | Silent no-op flags |
| `set` refuses to edit another repository's entry | Ownership rule |
| An unlinked repository's behavior is byte-identical | The no-workspace guarantee |

## Backward compatibility

Absent fields mean current behavior, at every layer. An existing manifest reads as
`defaultVisibility: 'repo'`, no role, no kin — which is exactly what `workspace add` produces
today. No migration, no manifest version bump, and `upgrade --all` needs no new step: the fields
are optional and the code that reads manifests machine-wide only ever touches `entry.path`.
