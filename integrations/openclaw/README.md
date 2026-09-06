# Knowl for OpenClaw

Knowl's repository memory and write gate, running **inside** OpenClaw's gateway rather than as a
subprocess per lifecycle event.

`before_tool_call` is the only hook the agent blocks on, and it is the reason this plugin is
in-process: a subprocess pays ~118 ms on *every* tool call because it must boot Node, load the
bundle and open SQLite before it can even discover the tool was a read. In-process the same gate
answers in ~0.68 ms, or ~0.04 ms when the tool is not a write at all.

## Install

```bash
knowl init openclaw
```

That merges the plugin entry into `openclaw.json` along with both required permission gates
(`allowConversationAccess`, `allowPromptInjection`) and an explicit
`timeouts.before_tool_call`, preserving any surrounding configuration. It also copies this
directory to `~/.openclaw/knowl-plugin` and prints the two commands that finish the install:

```bash
cd ~/.openclaw/knowl-plugin && npm install @dat999zx/knowl @libsql/client --install-links
openclaw plugins install --link ~/.openclaw/knowl-plugin --force --accept-capabilities
openclaw plugins inspect knowl --runtime            # status: loaded, hookCount non-zero
# restart the gateway
```

Each flag is there because the install fails without it:

- **`--install-links`** copies the dependency rather than symlinking it. A plain
  `npm install <path>` symlinks back to the source, and OpenClaw's safety scan refuses a plugin
  whose `node_modules` escape the install root: *"dependency boundary scan found node_modules
  symlink target outside install root"*. The dependencies are needed at all because a linked
  directory resolves its own imports and libsql stays external to the Knowl bundle.
- **`--force`** covers the directory sitting outside ClawHub trust metadata.
- **`--accept-capabilities`** covers the tool-result middleware declared in the manifest.

A refused install still leaves the config entry behind, so the next run reports
`plugins.entries.knowl: plugin not found (stale config entry ignored)` — that message means the
registration failed, not that the plugin is missing.

## Shipping — TypeScript source, and why that is fine

**`openclaw.extensions` points at `./src/index.ts`, and OpenClaw loads it directly.** The rule
that a plugin must ship compiled JavaScript applies to the *managed npm install* path
(`npm-pack:` archives, ClawHub packages) — a `--link` install of a local directory accepts a
TypeScript entry, which is what OpenClaw's own error text means by a development checkout. Since
`knowl init openclaw` copies this directory and links it, there is no build step, no `dist/`, and
no second npm package to publish.

That also removes an ordering problem worth recording: a published plugin package would depend on
`@dat999zx/knowl` for the `/plugin` subpath export, which only exists from 5.22.0 — so the plugin
could not be installed until a release that did not yet exist. Copy-and-link has no such cycle.

If you ever do need a packed archive, the compile runs in `prepack`, because OpenClaw's managed
installer runs `npm install --ignore-scripts` and cannot build on the user's machine. The trap
there: `npm pack --ignore-scripts` skips `prepack` and produces a tarball containing only
`package.json` and `openclaw.plugin.json` — two files, no code, no error.

## Dependencies, and why they look inverted

- `@dat999zx/knowl` is a real **dependency**, not a peer: OpenClaw's managed install runs
  `--omit=peer`, so a peer would simply not be installed.
- `openclaw` is a **peerDependency**: the host refuses to install a second registry copy of itself
  and relinks its own `node_modules/openclaw` after install.
- `openclaw.release.bundleRuntimeDependencies` is `false` because Knowl carries native addons
  (libsql, tree-sitter) whose per-platform binaries must be resolved by npm at install time.

## Hooks

| Hook | Purpose |
| --- | --- |
| `before_prompt_build` | The fixed orientation card. **The only recall channel.** See the dispatch caveat below. |
| `before_tool_call` | The write gate, matched to `exec` / `apply_patch` / `spawn_agent`. |
| `registerAgentToolResultMiddleware` | The impact card, injected before the model sees tool output. |
| `after_tool_call` | Capture. |
| `before_compaction` | Checkpoint before the conversation is compressed. |
| `session_start` / `session_end` / `agent_end` / `gateway_stop` | Bind, close, release. |

**`before_prompt_build` does not dispatch on every surface.** On OpenClaw 2026.9.1 it fires under
the `claude-cli` backend and does not fire on the embedded runner — for bundled and non-bundled
plugins alike, verified with a control plugin whose only job was to return a marker string.
`plugins inspect` reports the hook registered in both cases and no warning is emitted, so the
failure is silent in both directions. Upstream: [openclaw#134579](https://github.com/openclaw/openclaw/issues/134579),
which also records that the generic `openclaw agent` command is not a contracted surface for
prompt hooks. Nothing else in the table is affected; the write gate, capture and impact card all
run normally.

Three of these carry constraints that are not obvious from the catalog:

- **Recall never reads the prompt.** `before_prompt_build` emits a *fixed* orientation card. Building
  a query from the user's sentence is the defect fixed in knowl#257 on another host, and the
  "never prompts, never transcripts" promise depends on it not recurring here.
- **Exactly one hook publishes the card.** `agent_turn_prepare` and `heartbeat_prompt_contribution`
  return the same field names and their contributions *concatenate* — two publishers duplicate the
  block in the prompt.
- **`before_tool_call` is fail-closed.** If the handler throws or exceeds OpenClaw's 15-second
  budget, the user's write is *blocked*. The gate therefore carries its own 5-second deadline whose
  fallback is **accept**, and the first database open is warmed at `session_start` rather than
  lazily inside the gate. A stalled or broken Knowl must never deny a write.

The impact card writes into `content`, never only `details`, because OpenClaw strips `details`
before provider replay and compaction. It does **not** use `tool_result_persist`, which rewrites
only the transcript copy and would be invisible to the model in the turn that earned it.
