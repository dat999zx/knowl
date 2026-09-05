# OpenClaw: an in-process plugin, and the library export it needs

Date: 2026-09-05
Status: draft for review
Supersedes: Tasks 4–6 of `docs/superpowers/plans/2026-09-03-harness-integrations.md`, which
designed a Cline-style subprocess shell-out for OpenClaw.
Governed by: constraint `6676fd41b5dc410c` — recall is the turn-start hook's fixed orientation
card, never a query built from the user's prompt text.
Depends on: nothing unbuilt. The engine exists; only its front door is missing.

## Why this is not the 2026-09-03 design

That plan gave OpenClaw the same shape Cline and Hermes have: a small translator that spawns
`knowl agent-hook <host> <event> --json` once per event and reads JSON off stdout.

Hermes has that shape because it has no choice. Its plugin is Python — `subprocess.run`,
`shutil.which("knowl.cmd")` at `integrations/hermes/knowl/__init__.py:233` — and Python cannot
import TypeScript. The shell-out is its ceiling, not its design.

OpenClaw is TypeScript on Node, the same runtime Knowl is written in. Verified at source
2026-09-05 (atom `35421756dd5c4dc1`): root `package.json` declares
`engines.node: ">=22.22.3 <23 || >=24.15.0 <25 || >=25.9.0"`, `packageManager: pnpm@12.1.0`,
`scripts.start: node openclaw.mjs`. `docs/install/bun.md` states plainly that "Node remains
OpenClaw's primary, default, and recommended runtime"; Bun 1.4+ is an opt-in that additionally
requires WAL-reset-safe `node:sqlite`, and `bun install` cannot resolve the repo's pnpm workspace
at all. That engine range sits entirely inside Knowl's own `>=22`.

Choosing the subprocess here would be adopting Hermes' limitation on purpose. Two things follow
from being in-process, and neither is available to any subprocess plugin:

- **A returned value, not text.** `integrations/hermes/knowl/__init__.py:893` records the
  limitation verbatim: Hermes "only reads a bare string here, which a subprocess cannot return."
- **A warm database.** Measured on the maintainer's machine 2026-09-05: 187 ms median just to
  spawn `node dist/index.js --version` (5 runs: 182/182/187/188/4739). That is the floor per hook
  event, paid hundreds of times a session, before any work happens.

The cost is process isolation: an engine fault now lands inside OpenClaw's gateway. The plan's
existing rule — *a hook failure must allow the action* — stops being defensive and becomes
load-bearing. Every handler wraps its body and swallows.

## Part 1 — the library export

### The problem, exactly

`@dat999zx/knowl` has no library entry. `package.json` declares `bin: { knowl: "dist/index.js" }`
and `main: "dist/index.js"`; `exports` is **undefined**. And `dist/index.js` is the CLI: `src/index.ts`
opens `#!/usr/bin/env node` and its module body dispatches on `process.argv[2]` immediately. Importing
it does not expose an API — it runs the CLI.

### The engine is already a library

This is not a refactor. `src/mcp/server.ts` already imports `initDb`, `getProjectByRootPath` and
`registerTools` directly from core modules rather than shelling out; the CLI does the same. Both
protocol surfaces are already thin adapters over a shared engine, which is what the project's
"maintain thin protocol boundaries" goal asks for. The work is to name a front door, not to build
one.

`runAgentHook(host, event)` in `src/cli/agent-hook.ts` is itself a shell: it reads stdin, resolves
the project (`findProjectRoot` → `assertKnowledgeDatabasePresent` → `initDb` →
`getProjectByRootPath`), delegates to **`handleHostLifecycleEvent(project.id, normalized)`**, and
prints JSON. Everything a host plugin needs is that one call; the stdin/stdout wrapper is the only
thing the CLI adds.

### The surface

Three entries. Parity is not reduced by keeping it small — the Hermes plugin, the most complete
integration shipped, invokes exactly three CLI verbs across its 1,100 lines
(`agent-hook` at :387, `query` at :445 and :1000, `store` at :1022) and nothing else.

```ts
// @dat999zx/knowl  →  exports["./plugin"]
export async function openProject(cwd: string): Promise<ProjectHandle | null>;
// resolves the root, asserts the database exists, opens it, returns a handle that keeps
// the connection warm. null when cwd is not a Knowl project — never throws for that case.

export interface ProjectHandle {
  lifecycle(event: NormalizedHostHook): Promise<LifecycleResult>;  // handleHostLifecycleEvent
  query(text: string, opts?: { limit?: number }): Promise<QueryResult[]>;
  store(atom: StoreInput): Promise<StoreResult>;
  close(): Promise<void>;
}
```

`normalizeHostHook(host, event, payload)` is exported alongside so a plugin builds a payload the
engine already accepts, rather than reimplementing the shape.

MCP is untouched and stays the channel for the other 33 tools. The library is the automatic
lifecycle path plus the two tools a plugin offers in-process so a user need not run a second
server — the same two Hermes bundles.

### Packaging constraints

- **`exports` must be additive.** Adding an `exports` map to a package that had none makes every
  previously-reachable deep path unreachable. Enumerate what already resolves against `dist/`
  before writing it, and include `"./package.json": "./package.json"` — omitting it is a known
  papercut already recorded against `@knowl/ai-sdk`.
- **`dependencies`, never `peerDependencies`.** OpenClaw installs plugins with
  `npm install --omit=dev --omit=peer --legacy-peer-deps --ignore-scripts --no-audit --no-fund`
  into `~/.openclaw/npm/projects/<encoded-package>` (`docs/plugins/dependency-resolution.md`). A
  peer dependency would simply not be installed.
- **`--ignore-scripts` is survived, not accidentally.** `tree-sitter@0.21.1` builds with
  `prebuildify --napi --strip` and resolves at require time through `node-gyp-build` against
  shipped `prebuilds/{darwin-arm64,darwin-x64,linux-x64,win32-x64}`; `libsql@0.5.29` receives its
  binaries as ordinary per-platform `optionalDependencies` (`@libsql/win32-x64-msvc` and 8
  siblings). Neither needs an install script. Any future native dependency that *downloads* a
  binary in `postinstall` breaks this path.
- **N-API, so no ABI risk.** Both native dependencies are N-API and therefore ABI-stable across
  Node majors by contract, not compiled per `MODULE_VERSION`. The earlier concern was overstated.
- **No competing SQLite addon.** OpenClaw uses Node's built-in `node:sqlite`
  (`src/infra/node-sqlite.ts`, `src/cron/store/schema.ts`, `src/infra/kysely-sync.ts`), so libsql
  is the only native SQLite addon in the process. Loading the two side by side remains unproven
  and is a Task-1 verification, not an assumption.
- **The engine cannot be bundled flat.** `tsup.config.ts` marks `libsql`, all four tree-sitter
  packages and `@huggingface/transformers` external, and explains why: libsql reaches its binding
  through a dynamic `require('@neon-rs/load')` that esbuild cannot follow, and bundling it fails at
  runtime with *"Dynamic require of \"@neon-rs/load\" is not supported"*. The plugin ships as a
  package with a dependency tree, not a single file.
- **tree-sitter and embeddings stay lazy.** A plugin doing only lifecycle/query/store may never
  load either, leaving libsql as the single native dependency actually in play.

### Version skew, which is new

Today Knowl is a program: one build owns the database. As an importable library it becomes a
dependency users pin, so a plugin carrying engine 5.21 and a CLI at 5.30 can open the same SQLite
file. The code anticipates this — `KNOWL_MIGRATION_LEVEL = 16`, `SchemaTooNewError`, and
`src/store/bootstrap.ts:1243` reasoning explicitly about two builds sharing a file — but the case
moves from rare to routine. Every future migration must stay honest about it, and
`SchemaTooNewError` must surface through the plugin as a clean disable with a readable reason,
never as a gateway crash.

## Part 2 — the plugin

### Shape

`definePluginEntry` from `openclaw/plugin-sdk/plugin-entry`; `package.json` carries
`openclaw.extensions: ["./index.ts"]` plus an `openclaw.plugin.json` manifest with
`activation.onStartup`. `register(api)` is **synchronous** and registers every handler; handlers
themselves may be async except the two synchronous persistence hooks. Plugin settings are read as
`api.pluginConfig` inside the closure — not `event.context.pluginConfig`.

Use `api.on(...)` for everything. `api.registerHook(...)` is a different internal system:
registering a typed name there logs a warning and the typed runner never invokes it.

### Both permission gates are required

A non-bundled plugin needs `plugins.entries.knowl.hooks.allowConversationAccess: true` for
`before_prompt_build`, `agent_turn_prepare`, `before_agent_finalize` and `agent_end`. Separately,
`allowPromptInjection` (default allowed) gates `before_prompt_build`, `agent_turn_prepare`,
`heartbeat_prompt_contribution` and durable next-turn injections. `before_prompt_build` needs
**both**. Without them the plugin registers and silently does nothing — the failure mode to detect
in `doctor`, not in a bug report.

### Hook map

| Hermes hook | OpenClaw hook | Kind | Notes |
| --- | --- | --- | --- |
| `pre_llm_call` | `before_prompt_build` | Modify | Returns `prependContext`. Fixed card only. |
| `pre_tool_call` | `before_tool_call` | Gate | `{ block: true, blockReason }`. `opts.matcher` on canonical ids. |
| `post_tool_call` | `after_tool_call` | Observe | Return ignored. Computes and caches the impact card. |
| `transform_tool_result` | `tool_result_persist` | Sync | Returns `{ message }`. Reads the cache. |
| `on_pre_compress` | `before_compaction` | Observe | Fire-and-forget checkpoint. |
| `on_session_end` / `on_session_finalize` | `session_end`, `agent_end`, `gateway_stop` | Observe | `session_end.reason` ∈ new/reset/idle/daily/compaction/deleted/shutdown/restart/unknown. |

`session_start` also exists (Observe) and binds the session.

### The recall card, and the trap

`before_prompt_build` receives the current prompt and session messages, and can return
`prependContext`, `appendContext`, `systemPrompt`, `prependSystemContext`, `appendSystemContext`
or `toolsAllow`. It is the obvious place to run a search on what the user just typed. **It must
not.**

That is exactly the defect PR #257 fixed one host over: Knowl's Hermes MemoryProvider took the
user's literal sentence and ran `knowl query <sentence> --limit 5`, which is keyword search over
conversational prose. `src/cli/agents/host-hook.ts` keeps prompt text out of the hook payload
deliberately — only a derived `correctionSignal` boolean crosses — and the product's "never
prompts, never transcripts" promise rests on that.

So this hook emits the same fixed orientation card every other host gets: `turn-start` →
`bootstrapWithHandoff` — the bound session, the pending handoff, recent project state, budget-
capped. Prompt text may be *passed* as a signal (Hermes forwards it capped at 4000 chars) but
never becomes the query string.

**Exactly one hook may carry the card.** `before_prompt_build`, `agent_turn_prepare` and
`heartbeat_prompt_contribution` are three surfaces onto the same slot; two of them publishing the
same block is how the Hermes rules section appeared in the system prompt twice. This spec chooses
`before_prompt_build` and the other two carry nothing.

Ordering on embedded/CLI paths is: drain queued injections → `agent_turn_prepare` → heartbeat
contribution → ordinary `before_prompt_build` → finalized tool policy → authorized prompt
enrichment. `agent_turn_prepare` and injection draining are **not** wired into the Codex or
Copilot prompt paths.

`{ requiresToolAuthority: true }` moves the handler into a second post-policy phase with
`ctx.toolAuthority`. Knowl's card is not tool-backed, so the ordinary phase is correct; noted
because it is the right slot if retrieval ever must respect the turn's tool policy.

### The impact card: async work, synchronous hook

The one genuinely hard constraint. `tool_result_persist` returns `{ message }` to replace a tool
result — the true counterpart of Hermes' `transform_tool_result` — but it is **synchronous**:
"Do not make their handlers `async`: returned promises are ignored with a warning." Knowl's
engine entry is async, so the card cannot be computed inside it.

Therefore: `after_tool_call` (async, Observe) computes the card and writes it into a small
per-`toolCallId` cache; `tool_result_persist` (sync) reads that cache and, on a hit, returns the
message with the card appended to `content`. A miss returns nothing and the turn is unaffected.
The cache is bounded and evicted on `session_end`.

Two rules for the returned message:

- Model-visible text goes in **`content`**, never only in `details`. OpenClaw strips
  `toolResult.details` before provider replay and compaction, and caps persisted details
  (`persistedDetailsTruncated: true`).
- These hooks operate on OpenClaw-owned transcript writes and do **not** rewrite Codex-native tool
  records.

### The write veto

`before_tool_call` returns `{ block: true, blockReason }`. `block: true` is terminal and skips
lower-priority handlers; `block: false` is *no decision*, not an allow. `event.derivedPaths` gives
best-effort target paths for well-known envelopes such as `apply_patch` — useful, but documented
as possibly incomplete or over-approximate, so it is a hint and never the sole basis for a
refusal.

`opts.matcher` takes canonical tool ids (`exec`, `apply_patch`, `spawn_agent`); wildcards and
blanks are invalid. This is the same "do not even start the work for a non-write" optimisation
Knowl's `writeTools` matcher already makes.

`requireApproval` is available and deliberately unused: Knowl's refusal is a policy answer, not a
user prompt.

Codex native tool relays support blocking and observation but **reject parameter rewrites**, so
the veto must never depend on returning `params`.

### Surfaces available here that Hermes has no equivalent for

Out of scope for v1, recorded so they are not rediscovered:
`api.session.workflow.enqueueNextTurnInjection(...)` for durable next-turn context (drained before
prompt hooks, `idempotencyKey` dedupes, dropped when the plugin has prompt injection disabled),
and `api.session.state.registerSessionExtension(...)` for plugin-owned session state projected
into Control UI through `pluginExtensions`.

## What ships

- `exports` map and `src/plugin.ts` in this repo, plus tests that import the built artifact the
  way a consumer will.
- `integrations/openclaw/` — `package.json`, `openclaw.plugin.json`, `index.ts`.
- `knowl init openclaw` — merges the plugin entry and both permission gates into `openclaw.json`,
  never overwriting a user's file; reports a file it cannot parse instead of replacing it.
- An `openclaw` `HostProfile` in `src/session/hosts/`, registered in `index.ts`, with capability
  expressed by member presence rather than a boolean.

## Verification

Beyond `npm run build`, `npm test`, `npx eslint .`:

1. **libsql loads beside `node:sqlite` in one process.** The single unproven native assumption.
   Prove it before anything else.
2. **The install path, not a link.** `openclaw plugins install npm-pack:<tgz>` — the documented way
   to prove the managed package install shape, including `--ignore-scripts`. A `--link` install
   does not exercise it.
3. **`openclaw plugins inspect knowl --runtime --json`** shows every hook registered.
4. **The card appears once.** Grep the built prompt for the rules block; two copies means the
   double-publish bug.
5. **The card is prompt-independent.** Two different prompts in the same session produce the same
   orientation card. This is the regression test for #257, one host over.
6. **A blocked write is refused and the reason reaches the model.**
7. **Missing permission gates produce an actionable `doctor` line, not silence.**

Default hybrid reload hot-reloads hook *policy*; code changes need a Gateway restart.
