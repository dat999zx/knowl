# Turn the core features on by default, hooks over MCP, and an update notice agents can see

Date: 2026-09-28. Branch `feat/default-on-features`, worktree `.claude/worktrees/default-on-features`,
off `origin/main` at `25ab1f3`.

## Why

A fresh `knowl init` runs with most of what makes Knowl useful switched off. Measured by running
`knowl config list --all` in a scratch repo after `knowl init`:

| Key | Fresh-init value |
|---|---|
| `impact.enabled` | off |
| `impact.gate` | off |
| `capture.nudge` | off |
| `capture.events` | off |
| `capture.checkpoint` | off |
| `search.transcripts.enabled` / `.fallback` | off |
| `hooks.transport` | command |

Users never discover these, because nothing tells them the features exist. The shadow ladder
(`off → shadow → enforce`) already exists for exactly this: shadow measures what a mechanism would
do and shows the agent nothing. `fleet.nudge` already defaults to `shadow` (`src/fleet/config.ts:41-44`).

Separately, the update check (`src/core/version-check.ts`) runs only from `knowl status` and
`knowl doctor`. People work inside their agent, not the terminal, so they never see it.

## Changes

### 1. New defaults

| Key | Old default | New default |
|---|---|---|
| `impact.enabled` | off | **on** |
| `impact.gate` | off | **shadow** (only while impact is on — `impactGateMode` already returns `off` when it is not) |
| `capture.nudge` | off | **shadow** |
| `capture.events` | off | **shadow** |
| `capture.checkpoint` | off | **shadow** (new value, see below) |
| `search.transcripts.enabled` | off | **on** |
| `search.transcripts.fallback` | off | **on** (still gated on `enabled`) |
| `hooks.transport` | command | **mcp** (on hosts that support it, see §2) |

Unchanged: `search.transcripts.share` (off — it exposes this repo's sessions to linked repos),
`fleet.digest` (off), `memory.organization` (off), `memory.global` (already offered by interactive
`knowl init`, `src/cli/program.ts:507-517`, default yes), `capture.scope` (`conversation`).

**How.** Follow `search.pathsChanged` / `isFleetEnabled`: flip the reader's fallback, do NOT add
the keys to `DEFAULT_CONFIG`. `upgradeConfigDefaults` merges `DEFAULT_CONFIG` into every config on
the machine, which would stamp these values into files and hide what the user actually chose.
An explicit value in a config file keeps winning, so a repo that set `off` stays `off`.

- `src/store/impact-config.ts` — `isImpactEnabled`: `!== false`. `impactGateMode`: fallback `'shadow'`.
- `src/store/capture-config.ts` — `captureNudgeMode`, `captureEventsMode`: fallback `'shadow'`.
  `captureCheckpointMode` gains a `'shadow'` value and becomes `'off' | 'shadow' | 'ask'`, fallback
  `'shadow'`. Shadow records the checkpoint it would have asked (same ledger the other capture
  shadows use) and injects nothing. Enum in `src/cli/config/schema.ts` gains `shadow`.
- `src/core/config.ts` — `isTranscriptSearchEnabled`: `!== false`.
- `src/transcripts/config.ts` — `isTranscriptFallbackEnabled`: `fallback !== false`.
- `src/core/hooks-transport.ts` — `hooksTransport`: fallback `'mcp'`. `resolveHookTransport`
  keeps failing toward `command` when the config cannot be read (its comment explains why).
- `src/cli/config/schema.ts` — every `defaultValue` above updated so `config list` and the
  interactive editor show the real default.

**Behaviour change for existing repos.** Any repo that never set these keys changes on upgrade.
Shadow modes show the agent nothing. `impact.enabled` adds read-set indexing on tool events.
Transcript search adds a lexical index pass at turn stop (already bounded, `catchUpTranscripts`)
and a separate transcripts DB. CHANGELOG gets a "Defaults changed" section that lists each key
and the one command to turn it back off.

### 2. Hooks over MCP by default, with a fallback

Only Claude Code (`mcp_tool` hook type) and Codex (0.148+) can run a hook as an MCP tool call.
Every other host runs command hooks only (Copilot CLI's docs: "Only `type: "command"` is
supported"; Cursor, Windsurf, OpenHands, Hermes, Antigravity are shell hooks). The existing code
already handles this: `overMcp` (`src/cli/agents/hook-config.ts:191`) routes an event over MCP
only when the host profile declares `mcpToolHookEvents`, and only `claude.ts` and `codex.ts` do.
So flipping the default gives every capable host MCP and leaves the rest on command, with no
per-host code.

**Tool catalog.** `knowl_hook` is registered only when the transport is `mcp`
(`src/mcp/tools.ts:253`). With the new default it is registered for every configured repo. Its
description already tells a model not to call it. Accepted cost: one catalog entry.

**The fallback.** A host drops an `mcp_tool` hook with a non-blocking error when the server is
not connected, and Knowl is never told. Knowl cannot retry per event and cannot start the
host's server itself. So the fallback lives where Knowl does run: SessionStart, which is always
a `command` hook because it fires before MCP servers connect.

- At session start, for a host whose hooks file names `knowl_hook`, check that the host's MCP
  config registers the `knowl` server (`KNOWL_MCP_SERVER_KEY`). The adapters already read those
  files for `verify` (`src/cli/agents/files.ts`, `project-adapters.ts`).
- If it is missing, rewrite that host's hooks file with `transport: 'command'` via the existing
  `mergeHookConfig(..., { transport: 'command' })`, and put one line in the session card:
  `Knowl hooks fell back to command: the knowl MCP server is not registered for <host>. Run
  knowl init <host> to restore it.`
- `knowl doctor` reports the same mismatch. `knowl doctor --fix` re-registers the MCP server
  (the adapter's `configure`) and rewrites hooks for the configured transport.

**Known gap.** A server that crashes mid-session loses that session's hook events until the next
session start. It is not detectable from Knowl's side. Documented, not solved.

### 3. Remove `search.vector.provider`

`local` is the only accepted value. Remove the key from `ConfigKey`, `CONFIG_FIELDS`,
`ProjectConfig`, `DEFAULT_CONFIG`, and `docs/reference.md`. The readers stop consulting it:
`src/ai/embeddings.ts:433` (drop the check), `src/cli/doctor-report.ts:50,344` (drop the check,
print the model alone), `src/core/vector-profile.ts:196` (drop the field). Existing config files
that still carry `provider: "local"` must keep loading: the loader ignores the unknown leaf, and
`knowl upgrade` deletes it the way `stripDeprecatedConfigFields` deletes `project`.

The AI PROVIDER section (`ai.*`) stays. `knowl_ingest`, `knowl_synthesize`, and transcript
extraction call `initAI(config.ai!)`. Removing it would remove those features. Separate decision.

### 4. Update notice where the agent will see it

Reuse `checkForUpdate` and its 24h cache (`.knowl/cache/update-check.json`). Two new callers:

- **MCP server start** (`src/mcp/server.ts`, after `connect`): fire-and-forget `checkForUpdate`
  when `isUpdateCheckEnabled`. The server is long-lived, so no one waits on the 2s timeout. It
  only refreshes the cache.
- **Session-start card**: read the cache only — no network in a hook. If the cached latest is
  newer than `PACKAGE_VERSION` and has not been shown yet, add one line to the card:
  `Knowl <current> → <latest> is available: npm install -g @dat999zx/knowl. Tell the user.`
  Record `notifiedVersion` in the same cache file so the line appears once per release, not
  every session.

Needs a `readCachedUpdate(projectRoot)` export in `version-check.ts` that returns the cache
without fetching. The existing opt-outs keep working: `updateCheck.enabled: false`,
`KNOWL_NO_UPDATE_CHECK`, `NO_UPDATE_NOTIFIER`. The header comment in `version-check.ts` ("never
hooks, MCP, or serve") gets rewritten to the new rule: network only in `status`, `doctor`, and
the server; hooks read the cache only.

No auto-update. On Windows `npm install -g` fails while the running MCP server holds the package
files, versions would mismatch mid-session, and silently installing packages is a trust problem
for a local-first tool.

## Out of scope

- A background daemon to speed up command-only hosts.
- Removing `ai.*`.
- Changing `search.transcripts.share`, `fleet.digest`, `memory.*`, `capture.scope`.
- Promoting any shadow mode to enforce. That waits for shadow data.

## Verification

- Unit: each reader returns the new default for an empty config and still honours an explicit
  `off`/`command`/`false`.
- `tests/cli/config-surface.test.ts` passes with `search.vector.provider` gone.
- A config file containing `search.vector.provider: "local"` loads, and `knowl upgrade` strips it.
- Fallback: a Claude hooks file with `knowl_hook` plus a `.mcp.json` without `knowl` → session
  start rewrites hooks to command and the card carries the fallback line.
- Update notice: seeded cache with a newer version → the card carries the line once; a second
  session start does not; the hook makes no network call (fetch stub asserts it is not called).
- End to end on the built CLI in a scratch repo: `knowl init` → `knowl config list --all` shows
  the new defaults; `knowl init claude` writes `mcp_tool` hooks; a real Claude Code session
  reaches `knowl_hook` (the hook ledger or `knowl status` shows events).
- `npm run test`, `npm run lint`, `npm run typecheck`, `npm run build`.
- Docs: `docs/reference.md` config table and hooks section, `docs/hosts.md` transport note,
  CHANGELOG "Defaults changed" section.
