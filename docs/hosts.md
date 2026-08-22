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
| **OpenCode, Zed, JetBrains, Roo, Continue, Amp, Goose, Aider, …** | via MCP | ❌ | via MCP | ❌ | via MCP |

"via MCP" is not a degradation, but it is a weaker guarantee, and the two cases differ. A **change card** delivered this way is complete — the host just learns on its next Knowl call rather than its next tool call. A **capture nudge** delivered this way rides a tool result the agent may read and ignore, where a stop hook could withhold the stop. Both beat the alternative, which for a hookless client was nothing at all.

⚠️ means Knowl emits the envelope and the host accepts it, but nobody has watched it reach the model. Anything deciding "has this agent already been told" reads `midTurnDeliveryVerified`, never the presence of an envelope — so a ⚠️ host keeps getting the MCP copy and is never left silent on a guess. Flipping one to ✅ is a one-line change once someone observes a real session.

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
| Antigravity | `~/.gemini/config/mcp_config.json` † | `.agents/hooks.json` |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` | `.windsurf/hooks.json` |
| Cursor | `.cursor/mcp.json` | `.cursor/hooks.json` |
| Claude Desktop | platform config directory | — |

† Antigravity's MCP path is the least-verified line on this page. Its hooks location is quoted from Google's reference; the MCP path is not, and it is the same file Gemini CLI leaves behind empty. If Knowl's server does not appear in Antigravity, check where that build actually reads its MCP list.

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

**Gemini CLI is gone.** Discontinued upstream; its adapter was instructions-only and was removed. Antigravity replaces it. An existing `GEMINI.md` is left on disk.

## What is actually impossible

**One thing, and it is the same one for every host in the last two rows: blocking the host's own edit tool.** A tool result can refuse Knowl's tools and nothing else. No architecture recovers that; it needs a pre-tool hook the host does not have.

Everything else that is not a ✅ is one of three temporary things, and the table says which:

- **A vendor bug somebody else must fix** — Cursor's mid-turn card, [ticket T-C20310](https://forum.cursor.com/t/native-posttooluse-hooks-accept-and-log-additional-context-successfully-but-the-injected-context-is-not-surfaced-to-the-model/155689), still open.
- **A host that has not shipped hooks yet** — OpenCode, [#39275](https://github.com/anomalyco/opencode/issues/39275). Its adapter is here and its profile lands the day that does.
- **A prompt card with nowhere to go** — Windsurf's `pre_user_prompt` fires before the prompt is processed and injects nothing, and it is the only host left with no context channel of any kind.

Windsurf's capture nudge used to be listed here as impossible, and it is not: Windsurf has no stop hook, but it speaks MCP, and the nudge now rides a tool result on every host whose hooks cannot carry it.

## Not built: the ACP lane

**Zed, JetBrains (IntelliJ, Junie), Neovim, Kiro, Factory Droid** and the rest of the Agent Client Protocol registry share one channel that would give all of them the write gate at once: `session/request_permission`, plus `session/update` streaming tool calls live.

It is deferred, for a structural reason rather than a scheduling one. ACP's permission request runs **agent → client**: the agent asks the editor, and nothing in between is invited. To answer it, Knowl would have to sit as a proxy between the two and speak ACP in both directions — a long-lived component with its own lifecycle, failure modes and version surface, not a file in `src/session/hosts/`.

That is worth building. It is not worth smuggling into a change that adds profiles.

## Adding a host

One file in [`src/session/hosts/`](../src/session/hosts/), registered in `index.ts`. The lifecycle engine never branches on a host name; it asks the profile. (The config *writer* still has one branch, for a `timeout` field Cursor documents and Windsurf does not.)

The rule that matters most: **capability is expressed by return value, and an unverified capability is an absent one.** A host that cannot receive context returns `undefined` rather than setting a flag, so nothing can claim support an envelope does not deliver. A profile that declares a channel it has not been observed to have will report blocking writes it in fact let through — and that failure is invisible, because the refusal is computed correctly and only the delivery is missing.

Read [`profile.ts`](../src/session/hosts/profile.ts) before writing one; every field carries the specific mistake it exists to prevent.
