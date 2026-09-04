# Global memory: a personal-defaults layer

Date: 2026-09-04
Status: draft for review
Governed by: decision `d7bfb0ef36fe41d2` — *global memory is a cross-project personal-defaults
layer, not merged project truth*
Companion: global skills are a separate spec; this one is declarative memory only.

## Why

Two problems, one shape.

**A session with no repository has nowhere to remember.** Hermes Desktop is the case that
surfaced it: a session's working directory is whatever folder the person opened, and they may
open none. Every channel then refuses — correctly, since there is no project — so the agent has
no memory at all. The same holds for `knowl` run outside a repository.

**Knowledge that is true of a person has nowhere to live.** "I prefer pnpm", "this machine's
driver breaks on CUDA 12", "we use conventional commits everywhere" are not facts about any
repository, so today they are either stored in whichever repo happened to be open — where they
are wrong — or not stored at all.

The layer that answers both already exists in outline and has never been reachable.

## What is already built

| Piece | Where | State |
| --- | --- | --- |
| `MemoryNamespace = session \| project \| organization \| global` | `src/store/namespaces.ts` | done |
| Precedence `session 1 → project 2 → organization 3 → global 4` | `RANK`, `namespacePrecedence` | done |
| An external namespace as its own database, opted into per project | `externalNamespace`, `config.memory.global.{enabled,path}` | done |
| Layered read with round-robin interleave and dedupe | `queryLayeredKnowledge` | done |
| Per-row embedding identity | `knowledge_embeddings.profile_fingerprint` | done |
| Doctor reporting optional layers | `src/cli/doctor-report.ts:173` | done |
| Namespace on a write | `knowl_store` MCP `namespace` argument | done |

So the model is right and mostly implemented. What is missing is that **nothing can reach it**:
the layered read runs only when `!vector?.enabled`, vector search is the default, and the code
reports `skippedNamespaces` rather than narrowing silently. A user who enables a global namespace
today writes into a store their queries never read.

## The store

**`~/.knowl/global.db`**, honouring `KNOWL_HOME`.

Not a project at `~`. `knowlHome()` is `~/.knowl`, so `knowl init` at the home directory would put
a project store at `~/.knowl/knowl.db`, on top of the machine home that holds `models/`, `cache/`,
`repos.json`, `fleet.db` and `credentials.json`. `scaffoldTarget` already refuses that case by
name, and an empty `knowl.db` sitting in that directory on the maintainer's machine is the fossil
of something once trying it. A single file beside them is the shape `externalNamespace` already
expects: an explicit path, required to be outside the project directory.

It is one database with the ordinary schema, addressed by path rather than by project root. Rows
belong to the synthetic `local` project id the layered reader already passes.

**Machine-local.** Not synced, not shared, not pushed to a cloud workspace in this spec. That
keeps absolute paths meaningful (below) and keeps the blast radius of a mistake to one machine.
An organisation-wide layer is what the existing `organization` namespace is for, and it is
untouched here.

## Resolution

Two modes, decided by whether a project can be found.

**With a project** — unchanged: `configuredNamespaces(root, config)` yields session, project, and
whichever of organization and global that project's config enables. Precedence already puts the
project ahead of global, which is the decision's "project knowledge stays authoritative" made
mechanical.

**Without a project** — new. `knowl` outside a repository, and a Hermes session with no folder,
resolve to **global alone**. This needs a project-less entry point, because
`configuredNamespaces` takes a root and reads config from it:

```ts
/** The namespaces available with no project in sight: global, when it exists. */
export function globalOnlyNamespaces(): NamespaceDescriptor[]
```

A global-only session therefore behaves like a project whose store happens to be the global one:
query works, store works, and nothing else is in scope. That is exactly the "if people only use
global then that acts like project" case.

**What must not happen** is the silent third mode: a session that *has* a project falling back to
global because resolution failed. Global is reached when there is no project, never when there is
one we could not resolve. A failed resolution stays an error.

## Linking

Per project, in that project's own config — the existing key:

```jsonc
"memory": { "global": { "enabled": true, "path": "~/.knowl/global.db" } }
```

Set by `knowl link global` and cleared by `knowl link global --off`, so the decision is reversible
exactly as asked. `knowl init` offers it at setup; declining leaves the project isolated and
changes nothing about how it works today.

Linking is per project on purpose. A machine-wide "every project sees global" default would make
one careless write visible everywhere, which is the contamination the governing decision rejected
when it turned down "one merged cross-project knowledge pool".

## Retrieval — the actual work

Everything above is plumbing. This is the piece that makes the layer real.

### Spanning namespaces under vector search

Today `src/mcp/tools.ts` picks the layered path only when vector search is off. It must run
always, with the vector half done per namespace:

1. For each namespace in precedence order, open its database (`withNamespaceDatabase`, already
   there).
2. Resolve **that namespace's** embedding profile and fingerprint it. For a project that is its
   config; for `global.db` it is the config at the Knowl home, so global reads and writes are
   consistently one profile.
3. Embed the query with that profile, and search with that fingerprint. The
   `profile_fingerprint` predicate in `searchKnowledgeEmbeddings` is load-bearing and stays: a
   768-dimension query vector scored against 384-dimension rows is meaningless, and the
   fingerprint is what prevents it.
4. Interleave round-robin, unchanged. `interleaveByPrecedence` already exists precisely because
   scores from different namespaces are not comparable, which is also why this design never
   merges them by score.

**When a namespace's profile cannot be served** — a different model with no provider configured,
say — that namespace is **skipped and named in the response**, never silently dropped. This is
the existing `skippedNamespaces` behaviour, kept: the codebase's rule is to say what was skipped
rather than let the scope narrow invisibly.

**Simplification accepted for v1:** namespaces are expected to share one embedding profile.
`knowl link global` refuses a store whose profile differs from the project's, with the reason and
the command to re-embed. Multi-profile support is a strictly later concern, and the skip-and-say
path above means it degrades honestly in the meantime rather than mis-ranking.

### Applicability

The governing decision says to "retrieve only applicable global items". This spec reads that as
satisfied by three mechanisms already present, and deliberately does **not** invent a predicate
language:

- **Relevance.** An inapplicable global atom does not match the query, so it does not surface.
- **Precedence.** The project answers first and, on a tie, wins.
- **The round-robin cap.** Global can never crowd out the project store, because each namespace
  contributes in turn rather than by score.

A matcher — "applies when the project is TypeScript" — is speculative until someone has a global
store big enough to need one. If that day comes it is an additive field, not a redesign.

**This is the section most worth arguing with.** If applicability should be explicit, it belongs
here, and the rest of the design is unaffected.

## Writes

`--namespace global` on the CLI, mirroring the MCP argument that already exists. Writes go to the
namespace named, with no fallback: naming global and getting the project store would be the
contamination this layer is built to avoid.

**Paths on a global atom must be absolute.** A relative `src/auth.ts` in a store that spans
repositories names nothing. An absolute path names one file on this machine, which is why the
store is machine-local.

**And the write says what they are for.** Nothing in `src/session/` touches the namespace query —
impact detection, drift and evidence staleness all read the project store — so a path on a global
atom is provenance for a reader, not an index entry. The result says so, because a path that
looks wired up and is not is worse than no path. If the impact index later spans namespaces, the
stored value is already correct and nothing needs rewriting.

**What belongs here**, stated in the tool description so it reaches the agent: preferences,
machine quirks, conventions that hold across repositories. What does not: anything true of one
repository, which belongs to that repository.

## Setup

`knowl init` becomes runnable outside a repository, because the global half is machine-level and
has nothing to do with any checkout.

```
$ knowl init hermes            # anywhere
? This directory is not a Knowl project. What should this set up?
  > Project — a store for this folder, and the global store if it is missing
    Global — the machine-wide personal-defaults store only
? Link this project to the global store? (reversible with `knowl link global --off`)
```

- Inside a repository, the project option is preselected and the prompt is skipped under `--yes`.
- The global store is created once and never recreated; a second run reports it as present.
- `--host-only` configures a host integration and touches no store at all, which is what a
  machine-global host like Hermes actually needs.

## What this does not cover

- **Global skills** — its own spec, and the only part that executes anything. The governing
  decision's capability, precondition, pinning and approval requirements live there.
- **The organization namespace** — same mechanism, unchanged by this work.
- **Syncing global** to a cloud workspace, which would make absolute paths wrong.
- **Impact, drift and evidence across namespaces** — deliberately still project-only.

## Testing

- Resolution: with a project, without one, and the case that must not exist — a project that
  fails to resolve falling through to global.
- Precedence: an atom in both stores answers from the project; the global one is reachable and
  labelled.
- Round-robin: a global store full of loose matches cannot crowd out the project store.
- Fingerprints: a namespace whose embedding profile differs is skipped and named, never scored.
- Writes: `--namespace global` lands in `global.db`; a relative path is refused; the result says
  paths are not indexed.
- Setup: `knowl init` outside a repository creates only the global store; a second run is
  idempotent; linking and unlinking round-trip.
- Global-only: query and store work with no project anywhere on the path.

## Risks

**The layer becomes a dumping ground.** Everything project-shaped that lands in global dilutes
retrieval for every project linked to it. Mitigated by precedence, the round-robin cap, the
absolute-path rule and the tool description — but not prevented. Worth revisiting once there is a
real store to measure.

**Turning the layered path on changes every query.** It currently runs only without vector
search, so this puts a previously-unreachable branch on the default path for every host. The
round-robin and dedupe are already written and tested; the new part is per-namespace embedding,
which is where a regression would show.

**Absolute paths pin the store to one machine.** Accepted deliberately: global is machine-local
here. If it is ever synced, paths become the first thing to fix.
