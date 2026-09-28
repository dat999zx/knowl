# Plan: default-on features, MCP hooks, update notice

Spec: `docs/superpowers/specs/2026-09-28-default-on-features-design.md`.
Worktree `.claude/worktrees/default-on-features`, branch `feat/default-on-features`.
One commit per task. Each task is test-first: write the failing test, make it pass, run the
touched test files. Full `npm run test && npm run lint && npm run typecheck && npm run build`
before tasks 5 and 7 are marked done.

## Task 1 — Flip reader defaults

Files: `src/store/impact-config.ts`, `src/store/capture-config.ts`, `src/core/config.ts`,
`src/transcripts/config.ts`, `src/core/hooks-transport.ts`, `src/cli/config/schema.ts`.

1. Tests (extend the existing test file of each reader; find them with
   `grep -rln "isImpactEnabled\|captureNudgeMode\|isTranscriptSearchEnabled\|hooksTransport" tests`):
   empty config → `true` / `'shadow'` / `'mcp'`; explicit `false` / `'off'` / `'command'` → honoured.
2. Change the fallbacks as listed in spec §1. `resolveHookTransport`'s `.catch(() => null)` must
   still produce `command` — return `'command'` explicitly on a load failure, don't rely on
   `hooksTransport(null)`.
3. `captureCheckpointMode`: add `'shadow'`. In `src/session/host-lifecycle.ts:1220`, shadow
   records the checkpoint through the same shadow ledger `capture.events` uses and injects nothing.
4. Update `defaultValue`s and the `capture.checkpoint` enum in `schema.ts`. Update comments that
   say "opt-in" / "default off" (`hooks-transport.ts` header, `tools.ts:251-252`).
5. Grep existing tests that assume the old defaults (`grep -rn "transport.*command\|impact.*enabled" tests`)
   and fix them to set the old value explicitly where the test is about the old behaviour.

Commit: `feat(config): core features default on, nudges default shadow`.

## Task 2 — Remove `search.vector.provider`

Files: `src/core/types.ts`, `src/core/config.ts` (`DEFAULT_CONFIG`, `stripDeprecatedConfigFields`),
`src/cli/config/schema.ts`, `src/ai/embeddings.ts:433`, `src/cli/doctor-report.ts:50,344`,
`src/core/vector-profile.ts:196`, `docs/reference.md`.

1. Test: a config file with `search.vector.provider: "local"` loads, and after `upgradeConfigDefaults`
   the key is absent.
2. Delete the key and readers. Strip it in `stripDeprecatedConfigFields`.
3. `tests/cli/config-surface.test.ts` passes.

Commit: `refactor(config): drop search.vector.provider, local is the only provider`.

## Task 3 — Update notice

Files: `src/core/version-check.ts`, `src/mcp/server.ts`, `src/store/context-bootstrap.ts`
(or wherever the parent session card is composed — confirm by tracing `bootstrapAgentSession`
from `handleHostLifecycleEvent`'s session-start branch).

1. `readCachedUpdate(projectRoot, currentVersion)`: returns `{latest, updateAvailable, notified}`
   from the cache with no fetch. `markUpdateNotified(projectRoot, version)` writes
   `notifiedVersion` into the same file.
2. Server: after `connect`, `void checkForUpdate(...).catch(() => {})` when `isUpdateCheckEnabled(config)`.
3. Session-start card (parent sessions only, not subagents): if `updateAvailable && notifiedVersion !== latest`,
   append the one-line notice from the spec and mark it notified.
4. Tests: seeded cache → line present once, absent on the second session start; fetch stub not
   called on the hook path; disabled → no line.
5. Rewrite the `version-check.ts` header comment to the new rule.

Commit: `feat(update): refresh the update check from serve, surface it on the session card`.

## Task 4 — MCP-transport fallback at session start

Files: new helper beside the adapters (`src/cli/agents/transport-fallback.ts`), called from the
session-start path. Module boundary: `session/` may not import `cli/agents`
(`tests/architecture/module-boundaries.test.ts`). The session-start command hook enters through
`src/cli/agent-hook.ts`, which is in `cli/` — run the check there, before
`handleHostLifecycleEvent`, and pass the notice line into the result.

1. `checkMcpTransport(root, host)`: if the host's hooks file names `knowl_hook` and the host's
   MCP config has no `knowl` entry, call `mergeHookConfig(path, platform, host, { transport: 'command' })`
   and return the notice text. Otherwise `null`. Only hosts with `mcpToolHookEvents`.
2. Must be cheap: two small file reads. No network. Swallow every error (a hook must never fail
   on this).
3. Tests: hooks with `knowl_hook` + MCP config without `knowl` → hooks rewritten to command,
   notice returned; with `knowl` registered → untouched; Cursor → skipped.

Commit: `feat(hooks): fall back to command hooks when the knowl MCP server is missing`.

## Task 5 — Doctor

Files: `src/cli/doctor-report.ts`, the `doctor --fix` path in `src/cli/program.ts`.

1. Doctor warns when a host's hooks use `knowl_hook` but its MCP config has no `knowl` server,
   or when the hooks file transport does not match the configured one.
2. `--fix` re-registers the server via the adapter's `configure` and rewrites hooks with
   `resolveHookTransport(root)`.
3. Tests for both.

Commit: `feat(doctor): check hooks transport against the registered MCP server`.

## Task 6 — Docs

`docs/reference.md` (config table defaults, `capture.checkpoint` shadow, provider removal, hooks
transport section, update notice), `docs/hosts.md` (which hosts get MCP hooks), CHANGELOG
`## Unreleased` → "Defaults changed" listing each key with its turn-off command. The docs
coverage gate must pass.

Commit: `docs: new defaults, hooks transport, update notice`.

## Task 7 — End-to-end on the built CLI

1. `npm run build`, then in a scratch git repo under `$LOCALAPPDATA/Temp`: `node <worktree>/dist/... init`
   (use the repo's bin path from `package.json`), `config list --all` → new defaults.
2. `init claude` → `.claude/settings.json` has `mcp_tool` hooks, `.mcp.json` has `knowl`.
3. Delete `knowl` from `.mcp.json`, run the session-start hook by hand with a Claude payload →
   hooks rewritten to command, notice in the output.
4. Seed `.knowl/cache/update-check.json` with a higher version → session-start output carries
   the notice once.
5. Run one real headless Claude Code turn in the scratch repo (npm `claude.exe`, see Knowl skill
   "Running headless Claude Code implementers on Windows") and confirm a `knowl_hook` event was
   recorded.

Record results in the PR description. Do not push or open the PR without the user's go.
