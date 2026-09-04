# Knowl for Hermes Agent (Python plugin)

Project memory for [Hermes Agent](https://hermes-agent.nousresearch.com). This is the channel `knowl init hermes` installs, and the only one that reaches **Hermes Desktop**: Hermes' `serve` backend never registers the `config.yaml` shell hooks it otherwise accepts (NousResearch/hermes-agent #69825, open as of v0.21.0 and confirmed live on 2026-09-04), while Python plugins load on every path.

The plugin is a ~300-line shim. Each Hermes lifecycle hook builds the JSON that Hermes would have piped to a shell hook and runs `knowl agent-hook hermes <event> --json`, so the Knowl engine's Hermes host profile does all the work. What the shim adds:

- **Correct project on Desktop.** The working directory comes from Hermes' per-session context, not the gateway process cwd (which is Hermes' own source clone).
- **Rules in the system prompt.** A frozen section tells the model to query memory first, using the `mcp__knowl__*` tool names Hermes gives MCP tools and how to reach them through `tool_search`.
- **No stub cards.** Context is bounded under Hermes' 10,000-char spill threshold.

## What fires when

| Hermes hook | Knowl event | What the user sees |
|---|---|---|
| `pre_llm_call` (first turn) | turn-start | Bootstrap card appended to the first message. `on_session_start` is deliberately not forwarded: the engine would bind the session there, Hermes discards that hook's return value, and the first turn would then arrive on an already-seen session with no card. |
| `pre_llm_call` (later turns) | turn-start | Recall card for that turn |
| `pre_tool_call` on `write_file` / `patch` | tool-precheck | A write that contradicts a stored constraint is refused with the reason |
| `post_tool_call` | session-event | Nothing; read/write sets are recorded off the tool loop |
| `transform_tool_result` on `write_file` / `patch` | `knowl query` filtered by `affectedPaths` | The tool result gains a short "[Knowl] N stored item(s) depend on this file" card in the same turn, once per file per session |
| `pre_verify` (edit turns) | turn-stop | Capture nudge, bounded by Hermes' `max_verify_nudges` |
| `on_session_end` | turn-stop | Nothing; closes the turn |
| `on_session_finalize` | session-stop | Nothing; closes the session |

## Install

Requires Hermes Agent v0.21.0+ and `@dat999zx/knowl` 5.19.0+ (the release with the Hermes host).

The plugin ships inside the npm package too: after `npm install -g @dat999zx/knowl` it is at `<global node_modules>/@dat999zx/knowl/integrations/hermes/`, so `python <that path>/install.py` works without cloning this repo.

```powershell
npm install -g @dat999zx/knowl   # the release that ships this plugin, or newer
knowl init hermes                # copies the plugin, enables it, writes the MCP entry
```

That is the supported path: it installs the plugin into `<Hermes home>/plugins/knowl/`, sets `plugins.enabled: [knowl]` and `mcp_servers.knowl` in `config.yaml`, and removes any shell hooks an older Knowl left behind. **Restart Hermes afterwards** so it loads the plugin.

Two manual routes exist for installs that do not go through the npm package:

```powershell
python integrations/hermes/install.py          # copies knowl/ into <HERMES_HOME>/plugins/knowl and prints the config block
uv pip install --python <HERMES_HOME>/hermes-agent/venv/Scripts/python.exe knowl-hermes   # into Hermes' own venv, via the hermes_agent.plugins entry point
```

Both register under the plugin key `knowl`; installing two of them makes Hermes load the directory copy and warn about the duplicate.

Then add to `<HERMES_HOME>/config.yaml` (`%LOCALAPPDATA%\hermes\config.yaml` on Windows, `~/.hermes/config.yaml` elsewhere). If the file already has a `plugins:` key, merge into it instead of adding a second one:

```yaml
plugins:
  enabled:
    - knowl
  entries:
    knowl:
      settings:
        # optional; defaults to `knowl` on PATH, then `npx -y @dat999zx/knowl`
        knowl_bin: C:/Users/me/AppData/Roaming/npm/knowl.cmd
        timeout_seconds: 30
        rules_section: true
```

Restart Hermes (Desktop: quit and relaunch; the backend is spawned at startup). Run `knowl init` in each repository you want remembered.

Do **not** use `hermes plugins enable knowl` to flip the switch: it rewrites `config.yaml` through Hermes' YAML dumper and drops every comment in the file.

## Verify

`hermes plugins list` showing `knowl | enabled` proves discovery, not that hooks fire. Prove it end to end:

1. In a repo with a Knowl store, `knowl store "The demo service listens on port 4321" --category constraint --title "Demo port"`.
2. Open a Hermes session in that repo and ask "what port does the demo service use?".
3. `agent.log` (under `<HERMES_HOME>/logs/`) should show `knowl plugin registered (7 hooks)`, `Session plugin prompt section: id=knowl.project-memory`, and `knowl pre_llm_call: N chars of memory context`. The reply should say 4321 without any file being read.

## Known limits (v0.1)

- The same-turn impact card is built by the plugin from `knowl query` + `affectedPaths`, not by the engine; it costs one `knowl query` process (~0.7 s) per newly written file.
- Not registered as a Hermes `MemoryProvider`. Hermes allows one external provider at a time, so registering would exclude Honcho; the plugin coexists with any provider.
- `knowl-hermes` is not on PyPI yet; build with `python -m pip wheel integrations/hermes --no-deps -w integrations/hermes/dist`.
- Hermes' `pre_verify` fires only on turns that edited code and at most `agent.max_verify_nudges` times (default 3).

## Coexistence with `knowl init hermes`

Both can be present. In a terminal `hermes chat`, the shell hooks and the plugin would both fire; the engine treats the second event on a bound turn as a repeat and drops it. If you run the plugin, you can leave the `hooks:` block out.
