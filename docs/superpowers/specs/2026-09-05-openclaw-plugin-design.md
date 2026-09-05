# OpenClaw: an in-process plugin, and the library export it needs

Date: 2026-09-05 (rewritten same day after adversarial review)
Status: draft for review
Supersedes: Tasks 4–6 of `docs/superpowers/plans/2026-09-03-harness-integrations.md`, and the
first draft of this file at `347186d`, whose impact-card design was built on a misread hook.
Governed by: constraint `6676fd41b5dc410c` — recall is the turn-start hook's fixed orientation
card, never a query built from the user's prompt text.
Requires: 5.21.1's `openProjectScope` (PR #258), without which this design corrupts data.

## Why in-process

One argument, and it is the write gate.

`before_tool_call` is the only hook the agent **blocks on**. `handleHostLifecycleEvent` routes
`tool-precheck` to `runWriteGate` before every tool call. Measured 2026-09-05:

| | subprocess | in-process |
| --- | --- | --- |
| write gate (real decision) | 118 ms | 0.68 ms |
| non-write (nothing to decide) | 118 ms | 0.04 ms |

The subprocess **cannot short-circuit**. It must boot Node, load the bundle and open SQLite
before it can discover the tool was a `read` and answer "accepted". At a few hundred tool calls
per session that is 20–25 seconds of latency sitting directly in front of the user, spent
overwhelmingly on events that had nothing to decide. In-process, `toolWritesFile` returns before
the database is touched.

Two arguments the first draft made, withdrawn:

- **"187 ms per event."** That benchmarked `node dist/index.js --version`, a command nothing runs.
  The real per-event cost through `agent-hook` is 118–120 ms, of which 36 ms is the bare `node -e 0`
  process floor. In-process still pays ~32 ms of real capture work. The honest saving on the common
  *background* event is ~88 ms, not 187 ms — worth having, not worth restructuring for.
- **"A subprocess cannot return an object."** It can; `runAgentHook` already returns JSON on stdout.
  The quote it rested on describes the shape of *Hermes'* Python hook API, not a property of
  subprocesses. See "the impact card" below, where the premise collapsed entirely.

**The cost.** Process isolation. An engine fault lands inside OpenClaw's gateway. libsql is a
native addon; a segfault there takes the whole gateway with it, and no amount of try/catch
prevents that. This is knowingly accepted, not mitigated.

## The prerequisite that already shipped

The first draft assumed independent per-project handles existed. They did not. `initDb()`
overwrote a module-global context, so a gateway holding two workspaces wrote project A's rows into
project B's file — silently, no error, no log. `closeDb()` on one handle tore down every other.

Both were fixed in **5.21.1** (`openProjectScope` / `withProjectScope`, refcounted, releasing
through `releaseClient`). Every handle method in this design runs inside a scope. Nothing here may
call `initDb`, `initDbPath` or `closeDb` — those own the process-wide context and belong to the CLI.

## Why not `registerMemoryCapability`

OpenClaw ships two exclusive slots — `registerContextEngine(id, factory)` and
`registerMemoryCapability(capability)` — and `sdk-overview.md` calls the latter "the exclusive
memory-plugin API". A memory product for OpenClaw appears to belong there. It does not.

**Exclusive means one active at a time.** Registering it would displace whatever the user already
runs — `memory-core`, Honcho — and take ownership of recall, semantic search, promotion, dreaming
and the memory runtime. Knowl does not do those jobs. Knowl holds a repository's engineering truth;
their memory plugin holds the conversation. Displacing one with the other loses a capability the
user chose and replaces it with something aimed at a different question.

OpenClaw already documents the shape for this. `memory-wiki` is a bundled plugin that "does not
replace the active memory plugin. Recall, promotion, indexing, and dreaming stay owned by the
configured memory plugin… `memory-wiki` sits beside it." That is Knowl's position exactly.

So: generic hooks, beside the memory plugin, displacing nothing. Recorded here because silence read
as an oversight in review.

Two adjacent slots deliberately not used, for the same reason plus one more:

- **`registerTrustedToolPolicy`** — runs before ordinary `before_tool_call` and is documented for
  "host-trusted gates such as workspace policy". Knowl's write gate is arguably that. Rejected for
  v1: it requires `contracts.trustedToolPolicies` plus explicit enablement, and a memory tool
  claiming a trusted policy tier before it has a track record is a bigger ask than the feature is
  worth. Revisit if users report ordering conflicts.
- **`registerMemoryPromptSupplement` / `registerMemoryPromptPreparation`** — purpose-built for
  prompt text depending on async plugin state. Plausible carrier for the orientation card and worth
  a spike, but it binds Knowl into the memory-plugin surface this section just declined.

## Part 1 — the library export

### The problem

`@dat999zx/knowl` has no library entry. `bin` and `main` both point at `dist/index.js`, `exports`
is undefined, and `src/index.ts` is a `#!/usr/bin/env node` shebang that dispatches on
`process.argv[2]` in its module body. Importing it runs the CLI.

### What is already shared, and what is not

`handleHostLifecycleEvent` (`src/session/host-lifecycle.ts:940`) really is one importable call
returning `HostLifecycleResult`. `runAgentHook` is a thin shell around it: read stdin, resolve the
project, delegate, print. For **lifecycle**, this is naming a door.

For **query and store it is not**, and the first draft was wrong to imply otherwise. There is no
shared engine function: `src/mcp/tools.ts` holds ~330 lines of query logic — embedder construction,
layered namespace reads, federation across linked repos, score calibration, foreign-item
suppression — and `knowl_store` owns category validation, `assertOwnedTargets`, and namespace
routing. A library `query()` either reimplements that (a second answer to ranking) or is
deliberately dumber than `knowl_query`.

**Decision: it is deliberately dumber, and says so.** The plugin's in-process `knowl_query` is a
convenience so a user need not run a second server; anyone wanting federation and vector search
runs the MCP server, which is unchanged and still carries all 36 tools. The plugin's tool
description must say which it is.

### The surface

```ts
// @dat999zx/knowl  →  exports["./plugin"]
export async function openProject(cwd: string): Promise<ProjectHandle | null>;
export interface ProjectHandle {
  lifecycle(event: NormalizedHostHook): Promise<LifecycleResult>;
  query(text: string, opts?: { limit?: number }): Promise<QueryResult[]>;
  store(atom: StoreInput): Promise<StoreResult>;
  release(): Promise<void>;   // releaseClient, never closeDb
}
export function normalizeHostHook(host, event, payload): NormalizedHostHook;
export function readLifecyclePayloadObject(raw: unknown): LifecyclePayload;
```

Every method body runs inside `withProjectScope`. `release()` is per-handle.

**`openProject` must not collapse two errors into one.** `runAgentHook` distinguishes them
deliberately: `ProjectNotFoundError` is silent (not a Knowl repo — return `null`), while
`MissingKnowledgeDatabaseError` still speaks up (your database vanished — throw). Returning bare
`null` for both destroys the distinction `src/cli/database-presence.ts` exists to preserve.

**`readLifecyclePayloadObject` is not optional.** Both existing in-process callers route raw
payloads through `readLifecyclePayload` before normalising, and `hook-over-mcp.ts:118` says why:
"it is the allowlist, and a second copy of it here would be a second answer to what a hook may
carry." It enforces `ROOT_FIELDS`, `MAX_RETAINED_STRING=2000`, `MAX_RETAINED_ARRAY_ITEMS=50`.
Exporting only the normaliser lets a plugin hand the engine arbitrary unbounded fields — including
prompt text — which then reach `memory_session_events`, breaking the "never prompts, never
transcripts" promise this spec invokes below. The existing function takes a stream, so the library
needs an object-shaped equivalent.

**`hook-over-mcp.ts` is the real precedent** for an in-process caller and the plugin should mirror
two guards it already has: the self-call guard (skip the hook's own tool event) and the
project-scope guard (ignore events whose cwd resolves to a sibling checkout).

### The exports map is a breaking change

Verified by experiment, not inspection: packing the repo and installing the tarball with OpenClaw's
exact flags, `dist/index.js`, `dist/plugin.js`, `package.json` and
`integrations/cline/knowl-plugin.mjs` all resolve today. A three-entry map breaks the last three
with `ERR_PACKAGE_PATH_NOT_EXPORTED`.

The casualty is real and documented: `integrations/cline/knowl-plugin.mjs` is the published Cline
install path, named in `docs/hosts.md:138`, `docs/reference.md:2390` and `CHANGELOG.md:985`.

Minimum non-breaking map, verified to restore all five paths:

```json
{
  ".": "./dist/index.js",
  "./plugin": "./dist/plugin.js",
  "./package.json": "./package.json",
  "./integrations/*": "./integrations/*",
  "./dist/*": "./dist/*"
}
```

Keep `main` for old resolvers. The tsup change is just adding `src/plugin.ts` to `entry`; code
splitting is already on, so the two entries share chunks and the CLI bundle is unaffected.

### Version skew

Verified safe in both directions. An older engine on a newer schema fails cleanly before any
migration touches the file (`assertSchemaSupported` runs at `bootstrap.ts:1261`). A newer migration
level with the same schema version opens, writes, and correctly does not stamp the level down.

**But `SchemaTooNewError` cannot be the guard.** `KNOWL_SCHEMA_VERSION` has been bumped exactly once
ever while `KNOWL_MIGRATION_LEVEL` has reached 16 — the guard has never fired in practice, and the
policy is to bump the level. So the plugin reads `KNOWL_MIGRATION_LEVEL` off the file and disables
itself with a readable reason when the file's level exceeds the bundled engine's.

Separately: `initDbPath` catches every error and rethrows `DatabaseError`, so the
`SchemaTooNewError` **class is lost at the library boundary**. Either preserve the cause or
re-classify at the plugin entry — string-matching an error message is not an answer.

## Part 2 — the plugin

### Shape

`definePluginEntry` from `openclaw/plugin-sdk/plugin-entry`; `package.json` carries
`openclaw.extensions` and an `openclaw.plugin.json` manifest with `activation.onStartup`.
`register(api)` is synchronous. Use `api.on(...)` — `api.registerHook(...)` is a different internal
system that warns and never fires for typed names. Settings come from `api.pluginConfig` inside the
closure.

**Dependencies, with one exception the first draft got backwards.** OpenClaw installs plugins with
`npm install --omit=dev --omit=peer --legacy-peer-deps --ignore-scripts --no-audit --no-fund`, so
ordinary dependencies must be real `dependencies`. But a plugin importing `openclaw/plugin-sdk/*`
**must** declare `openclaw` as a `peerDependency`: OpenClaw refuses to install a second registry
copy of the host and relinks `node_modules/openclaw` itself after install.

`--ignore-scripts` is survived because tree-sitter ships `prebuildify` prebuilds resolved at require
time and libsql's binaries arrive as per-platform `optionalDependencies`. Any future dependency that
*downloads* a binary in `postinstall` breaks this. Evaluate
`openclaw.release.bundleRuntimeDependencies: false` — the documented opt-out native-heavy packages
use so npm resolves per-platform binaries at install time.

### Permissions

`before_prompt_build` needs **both** `allowConversationAccess` (non-bundled plugins) and
`allowPromptInjection`.

**Missing them is not silent** — the first draft said it was. OpenClaw rejects the registration and
records a `warn` diagnostic, surfaced by `openclaw plugins inspect <id> --runtime --json`. So the
plugin ships no bespoke doctor line; `knowl init openclaw` writes both gates and the troubleshooting
step is the host's existing command.

### Hook map

| Hermes | OpenClaw | Kind | Note |
| --- | --- | --- | --- |
| `pre_llm_call` | `before_prompt_build` | Modify | `prependContext`, fixed card only |
| `pre_tool_call` | `before_tool_call` | Gate | `{ block, blockReason }`, `matcher` on canonical ids |
| `transform_tool_result` | **`registerAgentToolResultMiddleware`** | async | see below |
| `post_tool_call` | `after_tool_call` | Observe | capture |
| `on_pre_compress` | `before_compaction` | Observe | **bounded**, see below |
| session end | `session_end`, `agent_end`, `gateway_stop` | Observe | 2 s total drain budget |
| — | `session_start`, `before_reset` | Observe | bind / rebind |

### The impact card — the first draft was wrong

It mapped `transform_tool_result` onto `tool_result_persist` and then built an elaborate
async-precompute-plus-sync-cache workaround around that hook's synchronicity. **The premise was
false.** `tool_result_persist` rewrites the *transcript* copy of a tool result, not the copy the
model reads in the current run: its output feeds `appendMessageAndCacheTranscriptSeq(...)` while the
model's live context is a separate in-memory array. The card would have reached the model on a later
turn's replay, if ever. The one shipped consumer uses it to redact secrets from persistence.

The correct seam is **`api.registerAgentToolResultMiddleware(...)`** — "for async tool-result
transforms that must run before OpenClaw or Codex feeds tool output back into the model." It is
async and runtime-neutral, so the entire cache workaround is deleted. Cost: declare
`contracts.agentToolResultMiddleware` and require explicit enablement.

Model-visible text still goes in `content`, never only `details` — OpenClaw strips `details` before
provider replay and compaction.

### The recall card, and the trap

`before_prompt_build` emits the fixed orientation card: `turn-start` → `bootstrapWithHandoff` —
bound session, pending handoff, recent state, budget-capped. It must **never** build a query from
the prompt. That is the defect PR #257 fixed on Hermes: the provider slot took the user's literal
sentence and keyword-searched it. Prompt text may be passed as a signal; it never becomes the query.

`before_prompt_build`, `agent_turn_prepare` and `heartbeat_prompt_contribution` are three
independent hooks, not one slot — but their context additions **concatenate in priority order**, so
two publishers duplicate. This spec uses `before_prompt_build` alone. (`heartbeat_prompt_contribution`
fires only on heartbeat turns, so it cannot double on an ordinary user turn — but it can on a
heartbeat.)

### The write gate, and the safety contract the first draft had backwards

`before_tool_call` returns `{ block: true, blockReason }`. `block: true` is terminal;
`block: false` is **no decision**, not an allow. `blockReason` does reach the model — it becomes the
blocked tool result's text content.

**The plan's rule "a hook failure must allow the action" is not OpenClaw's contract.**
`before_tool_call` is documented **fail-closed** on a 15-second budget: throw or exceed it and the
user's write is *blocked*. Worse, a timed-out handler keeps running — hook callbacks get no
cancellation signal. A cold libsql open or a first-call migration crossing 15 s would deny writes
while the work continues.

Therefore:

- The gate handler carries its **own internal deadline**, well under 15 s, and answers "accepted" on
  its own timeout rather than letting the host's fail-closed budget decide.
- `knowl init openclaw` writes an explicit `plugins.entries.knowl.hooks.timeouts.before_tool_call`
  rather than inheriting the default.
- First open is warmed at `session_start`, not lazily inside the gate.

`event.derivedPaths` is documented as possibly incomplete or over-approximate — a hint, never the
sole basis for a refusal. Codex relays **reject** parameter rewrites and fail closed when one is
attempted, so the gate must never return `params`.

### Two host budgets that constrain the observers

- **`before_compaction` carries a 30 s per-handler timeout**, and in the Codex harness runs on the
  serialized notification queue where a hung handler "freezes every later codex notification —
  including `turn/completed`". The checkpoint must be bounded, not merely fire-and-forget.
- **`session_end` has a 2-second *total* drain budget** shared across all sessions and handlers.
  Anything that must survive belongs in the write path, not a flush at the end.

### No handler may float a promise

`before_compaction` and `after_tool_call` ignore return values, which invites fire-and-forget. A
floated rejection escapes the enclosing try/catch and Node's default `--unhandled-rejections=throw`
kills the gateway. Every handler awaits its own work inside its own try/catch, or pushes onto an
explicitly drained queue with a terminal `.catch()`.

The plugin must **not** install a process-level `unhandledRejection` listener. Silently changing
crash policy inside someone else's gateway is worse than the defect it hides.

## What ships

- `exports` map (with the wildcards above) and `src/plugin.ts`, tested by importing the built
  artifact the way a consumer will.
- `integrations/openclaw/` — `package.json`, `openclaw.plugin.json`, `index.ts`.
- `knowl init openclaw` — merges the plugin entry, both permission gates, and the
  `before_tool_call` timeout into `openclaw.json`, never overwriting a user's file.
- An `openclaw` `HostProfile` in `src/session/hosts/`.

## Verification

Beyond `npm run build`, `npm test`, `npx eslint .`:

1. ~~**libsql loads beside OpenClaw's built-in `node:sqlite` in one process**~~ — **DONE
   2026-09-05, passed.** Node 24.15.0, knowl 5.21.1 from the registry, `node:sqlite` opened first
   and held open throughout. Both engines opened their own databases in one directory under WAL
   (51 interleaved writes each, both intact) and then **the same file**, each seeing the other's
   row, sidecars correct. Against the real `knowl init` store: 37 tables read, `journal_mode=wal`,
   200 interleaved gateway-writes + engine-reads in 247 ms, a row written and read back while
   `node:sqlite` held its own. `tree-sitter` loaded in the same process, and an external `knowl`
   CLI ran against the same repo concurrently. Clean shutdown.
   This does **not** prove a libsql *abort* is survivable — a segfault still takes the gateway, and
   that remains the accepted cost.
2. **Install via `openclaw plugins install npm-pack:<tgz>`**, not `--link` — only that path
   exercises the real `--ignore-scripts` managed install.
3. **`openclaw plugins inspect knowl --runtime --json`** shows every hook registered and no blocked
   registrations.
4. **The card appears once** in the built prompt.
5. **The card is prompt-independent** — two different prompts in one session produce the same card.
   The regression test for #257, one host over.
6. **A blocked write is refused and `blockReason` reaches the model.**
7. **Two workspaces open in one gateway** write to their own databases. The 5.21.1 regression, at
   the plugin layer.
8. **A stalled engine does not deny a write** — the internal deadline fires before the host's
   fail-closed budget.

Hybrid reload hot-reloads hook policy; code changes need a Gateway restart.
