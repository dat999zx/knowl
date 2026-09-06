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
`timeouts.before_tool_call`, preserving any surrounding configuration.

To install a local build instead:

```bash
npm pack                     # from this directory — see the warning below
openclaw plugins install --force npm-pack:/abs/path/to/dat999zx-knowl-openclaw-plugin-<v>.tgz
openclaw plugins enable knowl
openclaw plugins inspect knowl --runtime --json    # every hook registered, no blocked registrations
```

`--force` is required because a local archive sits outside ClawHub trust metadata. The path must be
absolute and forward-slashed.

## Building — read before publishing

**OpenClaw refuses a plugin that ships TypeScript source.** A managed npm install requires compiled
runtime output (`./dist/index.js`); TS source is only accepted for local development checkouts. So
`openclaw.extensions` points at `dist/`, never `src/`.

The compile runs in `prepack`, deliberately: OpenClaw's managed installer runs `npm install
--ignore-scripts`, so the build cannot happen at install time on the user's machine. It has to be
baked into the tarball.

**The trap that follows from that:** `npm pack --ignore-scripts` skips `prepack` and produces a
tarball containing only `package.json` and `openclaw.plugin.json` — two files, no code, and no
error. Always run a plain `npm pack`, and check the file count is 8, not 2:

```bash
npm pack && tar -tzf *.tgz | grep dist/index.js
```

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
| `before_prompt_build` | The fixed orientation card. **The only recall channel.** |
| `before_tool_call` | The write gate, matched to `exec` / `apply_patch` / `spawn_agent`. |
| `registerAgentToolResultMiddleware` | The impact card, injected before the model sees tool output. |
| `after_tool_call` | Capture. |
| `before_compaction` | Checkpoint before the conversation is compressed. |
| `session_start` / `session_end` / `agent_end` / `gateway_stop` | Bind, close, release. |

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
