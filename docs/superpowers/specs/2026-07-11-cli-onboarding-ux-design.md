# CLI Onboarding UX Design

## Goal

Make Knowl setup discoverable and safe through one idempotent `init` flow, an interactive configuration UI, and useful local search defaults.

## Scope

- Replace `knowl connect` with agent-aware `knowl init`.
- Detect installed supported agents and offer an interactive multi-select.
- Allow explicit multi-agent setup with `knowl init codex claude`.
- Add interactive `knowl config` navigation and explicit automation subcommands.
- Enable local vector search by default with lazy model download.
- Remove the old ambiguous `knowl config [key] [value]` syntax.

Checkpoint/work-loop changes are outside this feature.

## Command UX

### Interactive initialization

Running `knowl init` in a terminal initializes or upgrades the current project, detects supported installed agents, then displays a multi-select list. Previously configured agents remain selected and labeled as configured. Newly detected agents can be added without disturbing existing integrations.

Example:

```text
Detecting agents...
[x] Codex         configured
[x] Claude Code   available
[ ] Cursor        available
[ ] Claude Desktop available (global config)

Use arrows to move, space to toggle, enter to install.
```

The command then reconciles project files, installs selected MCP integrations, verifies each result, and prints a per-agent summary.

### Explicit initialization

`knowl init codex claude` performs the same reconciliation without showing the selector. It is suitable for repeatable setup and adding agents to an existing Knowl project.

`knowl init --yes codex claude` accepts required confirmations. Without explicit agent arguments, non-interactive execution initializes/upgrades the Knowl project but does not guess which agent integrations to install.

### Removed command

`knowl connect` is deleted immediately. It has no deprecated alias. Help text and documentation point only to `knowl init`.

## Initialization Behavior

Initialization is additive and idempotent:

1. Create `.knowl` when absent; otherwise upgrade it in place.
2. Preserve existing knowledge and user configuration.
3. Refresh marker-delimited `AGENTS.md` guidance and the `.gitignore` entry.
4. Detect supported agents through small independent adapters.
5. Reconcile the selected agent MCP configurations.
6. Verify each configured integration.
7. Report `configured`, `updated`, `unchanged`, `skipped`, or `failed` per agent.

One failed agent does not roll back successful integrations. The command exits non-zero when any selected integration fails and includes corrective guidance.

## Agent Adapters

Each supported agent has an adapter responsible for:

- detecting whether the agent is installed;
- identifying its project-local MCP configuration when supported;
- identifying when only global configuration is available;
- reading and safely merging the `knowl` MCP entry;
- preserving unrelated configuration;
- verifying the resulting registration.

Project-local configuration is preferred. A global-only integration requires an explicit interactive confirmation or `--yes`. Before modifying an existing agent configuration, Knowl writes a sibling backup. Re-running initialization updates an outdated Knowl entry and never duplicates it.

Initial adapters target Codex, Claude Code, Cursor, and Claude Desktop. Adapter behavior is tested independently from the interactive selector.

## MCP Entry

All adapters register one stdio server named `knowl` using the installed CLI:

```text
command: knowl
args: [serve]
```

Windows adapters may use `knowl.cmd` when required by the target agent. The adapter owns this platform-specific choice.

## Interactive Configuration

Running `knowl config` in a terminal opens a categorized configuration UI instead of printing raw JSON.

```text
> Search
  Security
  AI provider
  Reset defaults
```

Fields use appropriate controls: booleans are toggles, enumerations are selectors, secrets use hidden input, and free-form values use validated text input. Before saving, the UI shows changed keys and asks for confirmation. Knowl writes a backup before replacing the project configuration.

## Configuration Automation

Explicit subcommands remain available for scripts:

```text
knowl config get <key>
knowl config set <key> <value>
knowl config reset [key]
```

`get` prints only the requested value. `set` validates the key and value against the known configuration schema before writing. `reset` restores one key or, after confirmation, all defaults. `--yes` is required to reset all configuration non-interactively.

The old forms below are rejected with concise migration guidance:

```text
knowl config search.vector.enabled
knowl config search.vector.enabled true
```

## Vector Search Defaults

New projects and upgraded configs without an explicit vector setting receive:

```json
{
  "search": {
    "vector": {
      "enabled": true,
      "provider": "local",
      "model": "Xenova/all-MiniLM-L6-v2",
      "dtype": "q8"
    }
  }
}
```

Initialization does not download the model. The first vector operation downloads it lazily and clearly reports that a local model download is starting. Existing projects that explicitly set `enabled: false` keep that choice.

## Error Handling

- No detected agents: initialize/upgrade the project, explain explicit agent syntax, succeed.
- Unsupported explicit agent: reject before modifying agent configs and list supported names.
- Malformed agent config: preserve it, do not overwrite it, report the parse error and path.
- Permission failure: report whether the failed target was project-local or global.
- Partial integration failure: retain successful changes, print a summary, exit non-zero.
- Non-interactive `knowl init` without agents: never prompt or modify global agent configuration.
- Non-interactive `knowl config`: require `get`, `set`, or `reset`.

## Testing

Automated coverage must include:

- fresh and existing project initialization;
- installed-agent detection and selector state;
- explicit single- and multi-agent initialization;
- project-local preference and global confirmation;
- safe merge preserving unrelated MCP servers;
- repeated initialization without duplicate entries;
- outdated Knowl entry updates;
- malformed and unwritable agent configs;
- partial success and exit codes;
- deletion of `connect` and rejection of old config syntax;
- interactive config navigation, validation, confirmation, and cancellation;
- `config get`, `set`, and `reset` behavior;
- vector search enabled for new/default-upgraded configs;
- preservation of an explicit existing vector-search opt-out;
- lazy model download behavior;
- non-TTY behavior.

## Documentation

README quick start becomes:

```text
npm install -g @dat999zx/knowl
knowl init
```

Agent-specific setup documentation describes `knowl init <agent...>` and no longer documents manual MCP JSON snippets as the primary path. Configuration documentation leads with the interactive UI, followed by the explicit automation subcommands.

## Success Criteria

- A new interactive user can initialize Knowl and connect at least one detected agent through one command.
- An existing project can add another agent by re-running `knowl init` without data loss or duplicate MCP entries.
- Normal configuration changes require no dot-notation memorization.
- Scripts retain an unambiguous validated configuration interface.
- Vector search works by default without an API key and without delaying initialization for a model download.
