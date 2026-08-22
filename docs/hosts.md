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
| **Google Antigravity** | via MCP | ❌ no prompt event | via MCP | ✅ | ✅ |
| **Windsurf** (Devin Desktop) | ✅ | ❌ | via MCP | ✅ | ❌ no stop event |
| **Cursor** | ✅ | ❌ | ⚠️ MCP | ❌ | ❌ |
| **Claude Desktop** | via MCP | ❌ | via MCP | ❌ | ❌ |
| **Cline, Zed, JetBrains, Roo, Continue, Amp, Goose, Aider, …** | via MCP | ❌ | via MCP | ❌ | ❌ |

"via MCP" is not a degradation. Every `knowl_*` tool result carries any unseen change, so a host with no hook channel still learns that memory moved under it — it learns on its next Knowl call rather than on its next tool call.

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
| Antigravity | `~/.gemini/config/mcp_config.json` | `.agents/hooks.json` |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` | `.windsurf/hooks.json` |
| Cursor | `.cursor/mcp.json` | `.cursor/hooks.json` |
| Claude Desktop | platform config directory | — |

**Codex** hooks are behind `[features].codex_hooks = true` in `~/.codex/config.toml`, are experimental, and **do not run on Windows at all**. Everything else works there; only the hook-driven capabilities are unavailable.

**OpenHands** registers MCP servers as `[[mcp.stdio_servers]]` in `config.toml`, a shape documented only in secondary sources, so `knowl init` writes the hooks file and prints the stanza instead of guessing at the TOML:

```toml
[[mcp.stdio_servers]]
name = "knowl"
command = "knowl"
args = ["serve"]
```

## Why some hosts get less

**Cursor's mid-turn card.** Cursor accepts `additional_context` on `postToolUse`, logs it, and does not show it to the model — vendor ticket T-C20310, still open. Knowl emits it anyway, so it starts working the day that ships, and meanwhile Cursor is notified over MCP.

**Windsurf's capture nudge.** Windsurf has twelve hook events and none of them is a stop. `post_cascade_response` fires *after* a response and cannot withhold it. This is absence, not uncertainty — there is nothing to enable.

**Antigravity's prompt card.** No prompt-submit event exists. Its context injection runs through `injectSteps` on the invocation events, a different mechanism with a different payload, not wired up here.

**Cline has no profile at all.** Cline's hooks are TypeScript objects — `AgentPlugin` from `@cline/sdk`, with `beforeRun`/`afterRun`/`beforeTool`/`afterTool` — loaded into its runtime. There is no hooks file and no shell-command channel, so a `HostProfile` cannot reach them. Integrating would mean publishing and maintaining an npm plugin, which is a product decision rather than a profile. Cline uses Knowl over MCP like any other editor.

**Gemini CLI is gone.** Discontinued upstream; its adapter was instructions-only and was removed. Antigravity replaces it. An existing `GEMINI.md` is left on disk.

## Not built: the ACP lane

**Zed, JetBrains (IntelliJ, Junie), Neovim, Kiro, Factory Droid** and the rest of the Agent Client Protocol registry share one channel that would give all of them the write gate at once: `session/request_permission`, plus `session/update` streaming tool calls live.

It is deferred, for a structural reason rather than a scheduling one. ACP's permission request runs **agent → client**: the agent asks the editor, and nothing in between is invited. To answer it, Knowl would have to sit as a proxy between the two and speak ACP in both directions — a long-lived component with its own lifecycle, failure modes and version surface, not a file in `src/session/hosts/`.

That is worth building. It is not worth smuggling into a change that adds profiles.

## Adding a host

One file in [`src/session/hosts/`](../src/session/hosts/), registered in `index.ts`. Core code never branches on a host name; it asks the profile.

The rule that matters most: **capability is expressed by return value, and an unverified capability is an absent one.** A host that cannot receive context returns `undefined` rather than setting a flag, so nothing can claim support an envelope does not deliver. A profile that declares a channel it has not been observed to have will report blocking writes it in fact let through — and that failure is invisible, because the refusal is computed correctly and only the delivery is missing.

Read [`profile.ts`](../src/session/hosts/profile.ts) before writing one; every field carries the specific mistake it exists to prevent.
