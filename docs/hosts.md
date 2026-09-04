# Hosts

What Knowl can do inside each AI coding host, and — where it can do less — exactly which wire is missing.

Every host gets **memory**: `knowl_query`, `knowl_store` and the rest, over MCP. That is the product, and it works everywhere. This page is about the six *lifecycle* capabilities layered on top, which depend on what each host's hook channel actually carries.

## The six capabilities

| | What it does | What it needs from the host |
| --- | --- | --- |
| **Session bootstrap** | Relevant memory arrives before the first question | a session-start hook, or the first MCP tool result |
| **Prompt card** | Per-turn reminder to query before reading files | a prompt-submit hook whose output reaches the model |
| **Change card** | "Memory changed under you since your last call" | a mid-turn hook, or any MCP tool result |
| **CODE IMPACT card** | "Another session changed code you read" | the same channel as the change card |
| **Write gate** (`impact.gate`) | Refuses an edit that invalidates another session's reads | a pre-tool hook that can deny |
| **Capture nudge** (`capture.nudge`) | Withholds one stop and asks the agent to store what it learned | a stop hook that can block *and* carry a reason to the model |

## Support matrix

✅ shipped · ⚠️ emitted but delivery unconfirmed · ❌ the host has no such channel

| Host | Bootstrap | Prompt card | Change / impact card | Write gate | Capture nudge |
| --- | --- | --- | --- | --- | --- |
| **Claude Code** | ✅ | ✅ | ✅ | ✅ | ✅ |
| **Codex CLI** | ✅ | ✅ | ✅ | ✅ | ✅ |
| **GitHub Copilot** | ✅ | ✅ | ⚠️ MCP | ✅ | ✅ |
| **OpenHands** | ✅ | ✅ | ⚠️ MCP | ✅ | ✅ |
| **Google Antigravity** | ⚠️ | ⚠️ | ⚠️ MCP | ✅ | ✅ |
| **Windsurf** (Devin Desktop) | via MCP | ❌ | via MCP | ✅ | via MCP |
| **Cursor** | ✅ | ❌ | ⚠️ MCP | ✅ | ✅ |
| **Claude Desktop** | via MCP | ❌ | via MCP | ❌ | via MCP |
| **Cline** (with the plugin) | ✅ | ✅ | ✅ | — | via MCP |
| **Hermes Agent** | ✅ | ✅ | ⚠️ MCP | ✅ | ✅ edit turns |
| **Zed, JetBrains, Neovim, Kiro** (via `knowl acp`) | ✅ | ❌ | ✅ | ❌ | via MCP |
| **OpenCode, Roo, Continue, Amp, Goose, Aider, …** | via MCP | ❌ | via MCP | ❌ | via MCP |

"via MCP" is not a degradation, but it is a weaker guarantee, and the two cases differ. A **change card** delivered this way is complete — the host just learns on its next Knowl call rather than its next tool call. A **capture nudge** delivered this way rides a tool result the agent may read and ignore, where a stop hook could withhold the stop. Both beat the alternative, which for a hookless client was nothing at all.

"✅ edit turns" is Hermes' capture nudge: its `pre_verify` hook fires only on a turn that edited code, which is the turn the nudge is about; a turn with no edits gets no stop hook and no nudge.

⚠️ means Knowl emits the envelope and the host accepts it, but nobody has watched it reach the model. Anything deciding "has this agent already been told" reads `midTurnDeliveryVerified`, never the presence of an envelope — so a ⚠️ host keeps getting the MCP copy and is never left silent on a guess. Flipping one to ✅ is a one-line change once someone observes a real session.

## One process per event, or one server

Every hook above is installed as a `command` hook: a fresh `knowl agent-hook` process per event, ~230ms of Node startup each, serialized against the agent's own tool calls because the host waits on the pre-tool hook. Over 102 real Claude Code sessions that is 31s at the median session and 190s at the 90th percentile.

Claude Code (2.1.257+) and Codex (0.148+) can run a hook as a call to a tool on an already-connected MCP server instead. Set `hooks.transport` to `mcp` in `.knowl/config.json` and re-run `knowl init <host>`: the mid-session events become `mcp_tool` hooks calling `knowl_hook` on the `knowl serve` process the host already holds open, and the server registers that tool. `SessionStart` stays a process (both hosts say it fires before servers finish connecting), as does `SessionEnd`. No other host has the hook type yet; on those the setting changes nothing. The trade and the details are in the [reference](reference.md#hook-transport--hookstransport).

## Setup

```bash
knowl init                 # detects installed hosts and configures each one
knowl init copilot         # or name one
knowl doctor               # what is configured, what is stale
```

| Host | MCP config | Hooks |
| --- | --- | --- |
| Claude Code | `.mcp.json` | `.claude/settings.local.json` |
| Codex CLI | `.codex/config.toml` | `.codex/hooks.json` |
| GitHub Copilot | `.github/mcp.json` | `.github/hooks/knowl.json` |
| OpenHands | `config.toml` — **manual, see below** | `.openhands/hooks.json` |
| Antigravity | `~/.gemini/antigravity/mcp_config.json` (IDE) and `~/.gemini/config/mcp_config.json` (CLI) † | `.agents/hooks.json` |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` | `.windsurf/hooks.json` |
| Cursor | `.cursor/mcp.json` | `.cursor/hooks.json` |
| Claude Desktop | platform config directory | — |
| Hermes Agent | `config.yaml` in the Hermes home (global) | same file, `hooks:` block |

† Antigravity is two products reading two files. The IDE's "View raw config" opens `~/.gemini/antigravity/mcp_config.json`; the `agy` CLI reads `~/.gemini/config/mcp_config.json`, which Gemini CLI's migration often leaves at 0 bytes — an empty file, not a broken one. Both are confirmed against real installs, and `knowl init antigravity` writes both.

The hooks path, event names, payload and tool vocabulary are now read off an installed bundle (`~/.gemini/antigravity/builtin/skills/agy-customizations/docs/hooks.md` plus its conversation transcripts, 2026-09-04) rather than quoted. Three things that reference settles, each of which had produced a working-looking integration that recorded nothing:

- **Only `PreToolUse` and `PostToolUse` take a `{matcher, hooks}` wrapper.** `PreInvocation`, `PostInvocation` and `Stop` are a flat handler list. Wrapped, Antigravity parses them and does not run them.
- **The payload is protojson**: every key camelCase, the session under `conversationId`, the root under `workspacePaths`, and the tool as one `toolCall: {name, args}` object whose arguments are PascalCase (`TargetFile`, `AbsolutePath`, `CommandLine`). Knowl's stdin allowlist and normalizer both speak snake_case, so every event arrived with no session id and no root — see `normalizePayload` on the host profile.
- **The tool names are lowercase step types**: `replace_file_content`, `multi_replace_file_content`, `write_to_file` write; `view_file` reads; `run_command` is the shell.

**Codex** hooks are behind `[features].codex_hooks = true` in `~/.codex/config.toml`, are experimental, and **do not run on Windows at all**. Everything else works there; only the hook-driven capabilities are unavailable. Because of that, Codex — like Antigravity and Windsurf, whose MCP entry is global while their hooks are per project — keeps the conditional lifecycle card rather than being told outright that its hooks own the session.

**OpenCode** has no hooks yet ([opencode#39275](https://github.com/anomalyco/opencode/issues/39275)); it uses Knowl over MCP like the hosts in the last row, and graduates when that lands.

**OpenHands** runs agents in isolated containers by default. Hooks reach Knowl only if `knowl` is on the runtime image's PATH and `.knowl/` is on a mounted volume; local and CLI mode are unaffected. Image documentation for the hosted case does not exist yet.

OpenHands registers MCP servers as `[[mcp.stdio_servers]]` in `config.toml`, a shape documented only in secondary sources, so `knowl init` writes the hooks file and prints the stanza instead of guessing at the TOML. Name it explicitly — `knowl init openhands` — since OpenHands is usually run through Docker or `uvx` and detection looks for an `openhands` binary on PATH:

```toml
[[mcp.stdio_servers]]
name = "knowl"
command = "knowl"
args = ["serve", "--host", "openhands"]
```

## Parallel agents and git worktrees

Orchestrators that fan agents out — [Conductor](https://conductor.build), Claude Code's `isolation: "worktree"`, or a plain `git worktree add` script — give each agent its own checkout. Since **5.4.1**, every one of those checkouts resolves to the **main checkout's store**: `.knowl/` is gitignored, so a linked worktree carries no marker of its own, and project discovery falls back to `git rev-parse --git-common-dir`, whose parent is the main checkout. The fallback applies the same project check as the ordinary walk, so a repository that was never initialized still reports no project rather than borrowing a store.

The consequence is the thing parallel agents actually need: **N workspaces share one memory.** What an agent verifies in workspace 1, its siblings can query from workspaces 2 through N — no configuration beyond `knowl init`, run once, in the main checkout. Worktree placement does not matter; inside the repository, a sibling directory, or a temp directory all resolve identically. (Before 5.4.1 a worktree placed outside the repository failed every command with `No Knowl project found` — if that is what you are seeing, upgrade.)

What that does and does not promise:

- **Concurrent writes are safe, not smart.** The store runs WAL with a busy timeout and a retry, so simultaneous writers get bounded waits rather than errors, and same-subject supersession applies no matter which workspace wrote first. Nothing merges two agents' *findings* for you — that is what the conflict surface is for.
- **A worktree is not a clone.** A hosted sandbox that clones fresh per VM — Conductor Cloud, OpenHands hosted, and their kin — shares no git directory with your checkout, so there is nothing for discovery to resolve to and the local store starts empty every time. That lane needs the [synced store](../README.md#sharing-memory-across-a-team-knowlcloud), not a worktree.

## Why some hosts get less

**Cursor's mid-turn card.** Emitted, accepted, logged, and never shown to the model — vendor ticket T-C20310, still open. Knowl emits it anyway so it starts working the day that ships, and meanwhile Cursor is notified over MCP.

Cursor's write gate and capture nudge *do* work, through channels shaped unlike anyone else's. It has no `beforeFileEdit`, which is not the same as having no pre-tool event: `preToolUse` fires before every tool with `tool_name` and `tool_input`, and denies with `{"permission":"deny", user_message, agent_message}`. Its `stop` cannot withhold a stop, but it returns `followup_message`, which Cursor submits as the user's next message — which is all the capture nudge needs, and arguably a better shape than blocking.

**Windsurf's capture nudge.** Windsurf has twelve hook events and none of them is a stop. `post_cascade_response` fires *after* a response and cannot withhold it. This is absence, not uncertainty — there is nothing to enable.

**Antigravity has no prompt-submit or session-start event**, which reads as "no context channel" and is not. `injectSteps` on `PreInvocation` splices an `ephemeralMessage` into the conversation trajectory before every model invocation — the same slot a prompt event occupies — so bootstrap and the per-turn card both ride it.

**Cline needs one extra line of setup.** Its hooks are `AgentPlugin` objects loaded into its own runtime, not a file Knowl can write — so `knowl init cline` configures memory and stops, and the lifecycle ships as a plugin you point Cline at:

```js
ClineCore.start({ pluginPaths: ['./node_modules/@dat999zx/knowl/integrations/cline/knowl-plugin.mjs'] })
```

That file is [`integrations/cline/knowl-plugin.mjs`](../integrations/cline/knowl-plugin.mjs). It maps Cline's method names and shells out to the same `knowl agent-hook` entry point every other host's hooks use — no npm package to install, nothing to keep in version step. Its write gate is deliberately not wired: `beforeTool` can refuse, but the plugin runs *inside* Cline's process, where a hung child stalls the agent instead of timing out a hook runner. Capture first.

**Hermes Agent** has shell hooks in its own `config.yaml` that take Claude Code's wire format — JSON on stdin with `tool_name`, `tool_input`, `session_id` and `cwd`; `{"decision": "block", "reason"}` or exit 2 to refuse; `{"context"}` to inject. `knowl init hermes` writes `mcp_servers.knowl` and one `hooks.<event>` entry per lifecycle event into that file (`~/.hermes/config.yaml` on macOS and Linux, `%LOCALAPPDATA%\hermes\config.yaml` on Windows, or `$HERMES_HOME`), editing it as a YAML document so every comment survives, though comment blocks may be re-indented to sit with their key. It deliberately never runs `hermes` itself: Hermes' own mutators re-serialise the whole config without its comments and can stop on an interactive prompt. `pre_llm_call` carries the turn card (appended to the user message), `pre_tool_call` is matched to `write_file|patch` and carries the write gate, and `pre_verify` — fired before a turn that edited code finishes — accepts the Claude Stop shape and carries the capture nudge, so the nudge is real on exactly the turns it is about. Two things to know: Hermes asks once per hook at the terminal on first use and remembers it in `shell-hooks-allowlist.json`, so a gateway or Hermes Desktop run needs that one approval first (or `hooks_auto_accept: true`); and the payload's `cwd` is the Hermes process's working directory, so launch `hermes` from the project, or expect hooks from a Desktop session to find no Knowl project and stay silent. Type `/reload-mcp` in a running chat to pick the MCP server up.

**Gemini CLI is gone.** Discontinued upstream; its adapter was instructions-only and was removed. Antigravity replaces it. An existing `GEMINI.md` is left on disk.

## What is actually impossible

**One thing, and it is the same one for every host in the last two rows: blocking the host's own edit tool.** A tool result can refuse Knowl's tools and nothing else. No architecture recovers that; it needs a pre-tool hook the host does not have.

Everything else that is not a ✅ is one of three temporary things, and the table says which:

- **A vendor bug somebody else must fix** — Cursor's mid-turn card, [ticket T-C20310](https://forum.cursor.com/t/native-posttooluse-hooks-accept-and-log-additional-context-successfully-but-the-injected-context-is-not-surfaced-to-the-model/155689), still open.
- **A host that has not shipped hooks yet** — OpenCode, [#39275](https://github.com/anomalyco/opencode/issues/39275). Its adapter is here and its profile lands the day that does.
- **A prompt card with nowhere to go** — Windsurf's `pre_user_prompt` fires before the prompt is processed and injects nothing, and it is the only host left with no context channel of any kind.

Windsurf's capture nudge used to be listed here as impossible, and it is not: Windsurf has no stop hook, but it speaks MCP, and the nudge now rides a tool result on every host whose hooks cannot carry it.

## The ACP lane

**Zed, JetBrains (IntelliJ, Junie), Neovim, Kiro, Factory Droid** and the rest of the Agent Client Protocol registry cannot be profiles: ACP's interesting traffic runs **agent → client**, so there is no hook to register. The only seat available is between them.

```bash
knowl acp -- <agent-command>        # point the editor at this instead of the agent
```

The proxy relays every line **byte for byte** and observes a parsed copy alongside. It never re-serializes, so it cannot reorder a field, drop an unknown one, or change a number's formatting in a stream two other programs are speaking — which means its failure mode is "Knowl recorded nothing", the same direction every other Knowl hook fails in.

What it captures: `session/new` and `session/prompt` as session and turn boundaries, and completed `session/update` tool calls, whose `locations` name the files touched and whose `kind` (`read`, `edit`, …) is the agent's own classification — better evidence than a tool name, because the protocol asks the agent to declare it.

**It does not answer `session/request_permission`, so the write gate is not available on this lane.** That request is where the gate would live, and answering it means choosing one of the `PermissionOption`s the agent offered — a shape the published schema names `RequestPermissionOutcome` without enumerating. Guessing wrong there does not fail quietly: it resolves a prompt the person was meant to see, in their editor, with an answer Knowl invented. Permission traffic is relayed untouched until someone reads that shape off a real session.

Treat the lane as new. It is tested against a fake agent pair, not against every agent in the registry.

## Adding a host

One file in [`src/session/hosts/`](../src/session/hosts/), registered in `index.ts`. The lifecycle engine never branches on a host name; it asks the profile.

The rule that matters most: **capability is expressed by return value, and an unverified capability is an absent one.** A host that cannot receive context returns `undefined` rather than setting a flag, so nothing can claim support an envelope does not deliver. A profile that declares a channel it has not been observed to have will report blocking writes it in fact let through — and that failure is invisible, because the refusal is computed correctly and only the delivery is missing.

Read [`profile.ts`](../src/session/hosts/profile.ts) before writing one; every field carries the specific mistake it exists to prevent.
