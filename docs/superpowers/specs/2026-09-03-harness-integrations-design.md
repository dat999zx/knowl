# Harness integrations: DeepSeek harness, OpenClaw, Hermes Agent

Date: 2026-09-03
Status: approved design, awaiting implementation plan

## Goal

`knowl init deepseek`, `knowl init openclaw` and `knowl init hermes` give each harness what
Claude Code has today: the full MCP tool surface **and** automatic lifecycle capture, measured
against the settled six capabilities — session bootstrap, per-turn prompt card, mid-turn card,
code-impact card, `denyToolCall`, `stopContext`.

Ceilings, verified at source 2026-09-03 (Knowl atoms `3ae3f5bffacf4fa4`, `1e39ec4a19484b51`,
OpenClaw section of `e0afa6a2e71b4b41`):

| Host | Shape | Ceiling |
| --- | --- | --- |
| DeepSeek harness (dsh) | Claude-dialect shell hooks through its `dsh-hooks-claude-code` bridge | 6/6 |
| OpenClaw | in-process npm plugin, `before_prompt_build` writes the system prompt | 6/6 with one caveat: `stopContext` is delivered on the next turn, not enforced by withholding the stop (`agent_end` cannot block); push-recall in the system prompt |
| Hermes Agent | in-process Python plugin; no turn-stop veto hook exists | 5/6 |

## Approach

Every host's lifecycle goes through the existing `knowl agent-hook <host> <event>` entry and
`src/session/host-lifecycle.ts`. Nothing new in the engine. Each host is:

1. a `HookHost` value in `src/core/host-hook-types.ts`,
2. one `HostProfile` in `src/session/hosts/<host>.ts`, registered in `hosts/index.ts`,
3. an adapter in `src/cli/agents/` that `knowl init` and `knowl doctor` drive,
4. for OpenClaw and Hermes, a shipped translator under `integrations/<host>/` that maps the
   harness's in-process events onto `agent-hook` calls — the pattern
   `integrations/cline/knowl-plugin.mjs` already established.

`agent-hook`'s `<host>` argument description and `SUPPORTED_AGENT_NAMES` gain the three names.
The MCP server is written as `knowl serve --host <name>` so host-aware instructions work.

### Shared: a `yaml` merge target

dsh and Hermes both keep configuration in YAML files the user owns and that must not be
overwritten (`~/.dsh/cordis.patch.yml`, `~/.hermes/config.yaml`). `McpTarget` in
`src/cli/agents/hook-host-adapter.ts` today knows `json` and `manual`. Add:

```ts
| { kind: 'yaml'; scope: 'global'; configPath: () => string; merge: (doc: unknown) => unknown }
```

`merge` receives the parsed document (or `undefined` when the file is absent) and returns the
document with Knowl's entries present; everything else stays. Parsing and serialising use the
`yaml` package, promoted from transitive to a direct dependency. Idempotent: a second run
changes nothing. `verify` = parse and check the entries are present. A file that fails to parse
is left alone and reported, never rewritten.

## DeepSeek harness — `knowl init deepseek`

No plugin code. dsh consumes Claude Code's hooks format directly.

**Profile** `src/session/hosts/deepseek.ts`: Claude's event map (`SessionStart`,
`UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop`), `hookConfigStyle: 'claude-nested'`,
`nativeOutput: true`, `denyExitCode: 2` (dsh blocks on exit 2; it also honours
`hookSpecificOutput`, so the Claude JSON deny stays in the envelope as OpenHands does),
`stopContext` present (dsh's `Stop` block forces another step with the reason),
`midTurnDeliveryVerified: false` until someone watches `additionalContext` arrive.

**Adapter**: a `hookHostSpecs` row.
- `hooksPath`: `<root>/.dsh/hooks.json`, written by the existing `mergeHookConfig` with commands
  `knowl agent-hook deepseek <Event>`.
- `mcp`: `kind: 'yaml'`, `configPath: $DSH_HOME/cordis.patch.yml` (`DSH_HOME` env, else
  `~/.dsh`). `merge` ensures two rows exist in the first `insert` list (added if no list exists),
  matched by `id`:

```yaml
- insert:
    - id: knowl-hooks
      name: '@deepseek-ai/dsh-hooks-claude-code'
      config:
        configPath: ./.dsh/hooks.json
    - id: knowl-mcp
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: knowl
        transport: stdio
        command: knowl
        args: [serve, --host, deepseek]
        env: {}
        cwd: !!js process.cwd()
```

The patch is global and read once at dsh launch; `configPath` is relative to the launch cwd,
so hooks fire only in a project that has `.dsh/hooks.json`, and dsh logs a warning and runs no
hooks elsewhere. `projectDir` is omitted so `CLAUDE_PROJECT_DIR` defaults to the session
workspace. The `!!js` tag must survive the round trip: the `yaml` package needs a custom tag
for it, or the merge writes the rows textually when the tag is present. The plan decides; the
test is that the file dsh reads back is the one above.

`detect`: `dsh` on PATH or the patch file exists. `verify`: hooks file merged and both rows
present. Doctor WARNs and `--fix` re-runs init when one half is missing.

## OpenClaw — `knowl init openclaw`

**Shipped plugin** `integrations/openclaw/`:
- `package.json` — `{ "name": "knowl-openclaw", "type": "module", "openclaw": { "extensions": ["./index.mjs"] } }`
- `openclaw.plugin.json` — `{ "id": "knowl", "name": "Knowl", "activation": { "onStartup": true }, "configSchema": { "type": "object" } }`
- `index.mjs` — zero dependencies; `register(api)` calls `api.on(...)` for:

| OpenClaw event | agent-hook event | Return |
| --- | --- | --- |
| `session_start` | `session-start` | — (context surfaces on the first `before_prompt_build`) |
| `before_prompt_build` | `turn-start` | `{ prependSystemContext: card }` |
| `before_tool_call` | `tool-precheck` | `{ block: true, blockReason }` on deny; otherwise the impact card is held for the next `agent_turn_prepare` `{ appendContext }` |
| `after_tool_call` | `session-event` | — |
| `agent_end` | `turn-stop` | — . `agent_end` cannot block, so a `stopContext` nudge is held and delivered as `prependSystemContext` on the following `before_prompt_build`. This is delivery without enforcement: the agent has already stopped. The profile keeps `stopContext` present so `capture.nudge: enforce` produces the text, and the doc for the host says plainly that the stop itself is not withheld. |
| `session_end` | `session-stop` | — |

Payload built from `event`/`ctx`: `session_id: ctx.sessionId`, `cwd: ctx.workspaceDir ?? ctx.cwd`,
`tool_name: event.toolName`, `tool_input: event.params`, `prompt: event.prompt`,
`agent_id: ctx.agentId`. Spawns `knowl agent-hook openclaw <event> --json` with the same
never-throw, 10s-timeout runner as the Cline plugin; a failure allows the action.

**Profile** `src/session/hosts/openclaw.ts`: normalized event names as in `cline.ts`,
`nativeOutput: false` (the reader is our plugin), `denyToolCall` and `stopContext` present,
`readsFiles`/`writesFiles` from OpenClaw's tool names (`read`, `write`, `edit`, `exec` shell —
the plan enumerates them from the OpenClaw tool catalog), `midTurnDeliveryVerified: true` once
a real session shows the `appendContext` card arriving; `false` until then.

**Adapter** `src/cli/agents/openclaw.ts`:
- Locate the shipped plugin directory next to the installed CLI (`import.meta.url` → `../../integrations/openclaw`).
- Run `openclaw plugins install --link <dir> --force` then `openclaw plugins enable knowl`;
  if `openclaw` is not on PATH, print both commands (`manual` behaviour) and continue.
- `json` merge into `openclaw.json` (OpenClaw's documented config path, home-scoped):
  `plugins.entries.knowl = { enabled: true, hooks: { allowConversationAccess: true } }` and the
  MCP server entry `knowl serve --host openclaw` under OpenClaw's MCP servers key.
- `verify`: config carries both; `detect`: `openclaw` on PATH or `openclaw.json` exists.

## Hermes Agent — `knowl init hermes`

**Shipped plugin** `integrations/hermes/knowl/`:
- `plugin.yaml` — name `knowl`, `provides_hooks: [on_session_start, pre_llm_call, pre_tool_call, post_tool_call, on_session_end]`.
- `__init__.py` — stdlib only (`subprocess`, `json`); `register(ctx)` registers the hooks:

| Hermes hook | agent-hook event | Return |
| --- | --- | --- |
| `on_session_start` | `session-start` | ignored by Hermes; card held for the first `pre_llm_call` |
| `pre_llm_call` | `turn-start` | `{"context": held + card}` (Hermes caps at 10,000 chars; the plugin truncates the held part first) |
| `pre_tool_call` | `tool-precheck` | `{"action": "block", "message": reason}` on deny; an impact card is held |
| `post_tool_call` | `session-event` | ignored |
| `on_session_end` | `session-stop` | ignored |

Runs `knowl agent-hook hermes <event> --json`, never raises, 10s timeout, failure allows.

**Profile** `src/session/hosts/hermes.ts`: `nativeOutput: false`, `denyToolCall` present,
`stopContext` **absent** — Hermes has no turn-stop hook, so the capture nudge rides the MCP
tool-result channel exactly as for MCP-only hosts. `readsFiles`/`writesFiles` from Hermes'
tool names (`read_file`, `write_file`, `patch`, `terminal`), enumerated in the plan.

**Adapter** `src/cli/agents/hermes.ts`:
- Copy `integrations/hermes/knowl/` to `$HERMES_HOME/plugins/knowl/` (`HERMES_HOME` env, else `~/.hermes`); overwrite only files Knowl shipped.
- `yaml` merge into `~/.hermes/config.yaml`: `mcp_servers.knowl = { command: knowl, args: [serve, --host, hermes] }`.
- Print `/reload-mcp` as the way to pick the server up in a running chat.
- `verify`: plugin dir and MCP entry present.

Follow-up, not in this spec: a `MemoryProvider` implementation (`system_prompt_block`,
`sync_turn`, `on_pre_compress`) contributed to `NousResearch/hermes-agent` under
`plugins/memory/knowl/`, which is the only route to a system-prompt slot and a stop-time hook.

## Not in scope

- `hooks.transport: mcp` for these hosts. Every host ships on `command`; dsh's bridge exposes no
  `mcp_tool` hook type, and the two plugins would each need an embedded MCP client. Revisit when
  the per-event process cost is measured to matter in one of them.
- ACP proxy, Hermes `MemoryProvider`, publishing the OpenClaw plugin to npm (it ships inside
  `@dat999zx/knowl`, so `--link` is the install).

## Testing

- Profile conformance: the existing suite in `tests/store/host-lifecycle.test.ts` runs over the
  three new profiles.
- `yaml` target: merging into an absent file, an existing file with unrelated rows, and a
  second run (byte-identical); a malformed file is untouched and reported; the dsh `!!js` tag
  survives.
- Adapters: `knowl init <host>` on a temp root writes exactly the files above; `doctor` reports
  a half-configured host and `--fix` completes it; missing `openclaw`/`dsh` binaries degrade to
  printed instructions, exit 0.
- Translators: `integrations/openclaw/index.mjs` against a fake `api` — assert argv, stdin JSON,
  and the mapped returns (`block`, `prependSystemContext`, `appendContext`). The Hermes plugin
  under `python -m unittest` against a fake `ctx`, skipped when no `python` is on PATH.
- Manual, per host, recorded in the PR: one real session showing bootstrap card, a per-turn
  card, a denied tool call, and (dsh, OpenClaw) a stop nudge.

## Files

New: `src/session/hosts/{deepseek,openclaw,hermes}.ts`, `src/cli/agents/{openclaw,hermes}.ts`,
`integrations/openclaw/{package.json,openclaw.plugin.json,index.mjs}`,
`integrations/hermes/knowl/{plugin.yaml,__init__.py}`, tests beside each.
Changed: `src/core/host-hook-types.ts`, `src/session/hosts/index.ts`,
`src/cli/agents/{hook-host-adapter,registry,types}.ts`, `src/cli/program.ts` (agent-hook
description), `package.json` (`yaml`), `README.md`/`CHANGELOG.md` `## Unreleased`.
