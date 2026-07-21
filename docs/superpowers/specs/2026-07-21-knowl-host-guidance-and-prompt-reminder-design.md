# Host-Native Knowl Guidance and Claude Prompt Reminder Design

**Date:** 2026-07-21

**Status:** Approved concept; awaiting written-spec review

## Problem

Knowl currently writes its model-facing workflow only into `AGENTS.md`. Claude Code does not natively load that filename, Gemini CLI is not a supported `knowl init` target, and host-specific copies can drift from the generated guidance.

Instruction-file delivery is not the whole problem. `D:/coding/DuckPrep-server` reproduces the failure with all of the expected Claude integration present:

- Claude reports the project `CLAUDE.md` as loaded.
- `CLAUDE.md` contains the same Knowl section as `AGENTS.md`.
- `.mcp.json` registers the Knowl MCP server.
- `.claude/settings.local.json` installs the Knowl `SessionStart` lifecycle hook.
- Claude still tends to call Knowl only when the user explicitly requests it.

The existing contract is long and leaves task-start behavior implicit. It says lifecycle bootstrap supplies initial context and describes `knowl_query` as focused follow-up, but it does not state one short, prominent rule that applies to every project-specific request. Host instructions are also model-directed context, not mechanical enforcement.

## Goals

1. Make `KNOWL.md` the human-visible canonical Knowl workflow for a project.
2. Deliver that workflow through each selected host's native instruction mechanism without overwriting unrelated instructions.
3. Make task-start retrieval concise and unambiguous.
4. Install a default-on Claude `UserPromptSubmit` reminder that reinforces the rule immediately before each prompt is processed.
5. Keep the reminder independent of retrieval, capture, session state, and raw prompt content.
6. Add project-local Gemini MCP registration and native guidance support.
7. Preserve additive, idempotent `knowl init` behavior.

## Non-goals

- Do not restore automatic per-prompt database retrieval.
- Do not store, parse, summarize, log, or otherwise retain the user prompt in the reminder path.
- Do not restore the retired Knowl-owned `agent-hook ... UserPromptSubmit` capture path.
- Do not add prompt reminders for Codex, Cursor, or Gemini until their current prompt-hook output formats and overhead are separately verified.
- Do not use filesystem symlinks or hard links; they are fragile across Windows, Git configuration, and existing user files.
- Do not overwrite unrelated content in `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, or a pre-existing `KNOWL.md`.
- Do not change normal `SessionStart`, tool-event capture, stop, finalization, or handoff semantics.

## Approaches considered

### 1. Canonical file and host imports only

Create `KNOWL.md`, import it from Claude and Gemini files, and synchronize it into `AGENTS.md`. This fixes routing and drift but remains vulnerable to the behavior reproduced in DuckPrep: Claude can load the rules and still skip Knowl.

### 2. Automatic retrieval on every prompt

Restore `UserPromptSubmit` as a full lifecycle event, read the prompt, open the database, run retrieval, and inject results. This is the most deterministic retrieval path, but it restores the per-prompt process, database, session, and repeated-context overhead that commit `12d8d52` intentionally removed. It also expands prompt-handling and privacy scope.

### 3. Canonical guidance plus a reminder-only prompt hook

Use native instruction files for durable policy and add a fixed Claude reminder immediately before each prompt. The reminder performs no retrieval or capture. This adds one short-lived process per prompt, but avoids database and session work and gives the instruction greater recency than startup guidance.

This is the selected approach.

## Canonical `KNOWL.md`

`knowl init` creates or refreshes a marker-delimited Knowl section in project-root `KNOWL.md`. A pre-existing file keeps all content outside the managed markers.

The managed section is shorter than the current generated section and places the required behavior first:

1. For every project-specific request, call `knowl_query` with 2-6 concise keywords before reading/searching repository files or running project commands.
2. Skip a new query only when lifecycle-injected context already contains a directly relevant active answer or Knowl was already queried for the same request.
3. Use a relevant active hit immediately. Inspect repository files only on a miss, conflict, stale or low-confidence memory, or an explicit source-verification request.
4. Query again before switching to a distinct subtask or project area.
5. Store or update concise durable findings during work and before the final answer; never store raw transcripts, secrets, or temporary debugging noise.
6. If Knowl MCP tools are unavailable, stop and tell the user instead of silently bypassing Knowl.

Secondary guidance for `knowl_recent`, `knowl_state`, learned skills, conflict updates, and secret validation remains below the task-start rules. It must not obscure or contradict the six core rules.

## Host instruction routing

### `AGENTS.md`

Codex discovers at most one native instruction file per directory and does not provide Claude/Gemini-style `@file` expansion for an existing `AGENTS.md`. Therefore `AGENTS.md` retains a synchronized copy of the managed `KNOWL.md` section.

The two managed sections are rendered from the same source text so rerunning `knowl init` cannot produce divergent Knowl rules. Existing non-Knowl `AGENTS.md` content remains unchanged.

`KNOWL.md` is the canonical human-visible artifact. The managed section is still Knowl-owned: rerunning init refreshes edits made inside its markers, while content outside the markers remains user-owned.

### `CLAUDE.md`

When Claude is selected explicitly or selected from interactive detection, init ensures project-root `CLAUDE.md` imports `@KNOWL.md`.

- If the file is absent, create it with the managed import.
- If it already imports `KNOWL.md`, do not add a duplicate.
- If it already imports `AGENTS.md`, treat the synchronized Knowl section delivered through that import as configured and do not add a second `KNOWL.md` import.
- If it contains the old marker-delimited duplicated Knowl section, remove only that managed section. Add `@KNOWL.md` afterward only when neither an existing `KNOWL.md` import nor an `AGENTS.md` import already delivers the workflow.
- Preserve all other Claude-specific content.
- Place a newly managed import near the beginning of the file so the canonical workflow is easy to audit.

### `GEMINI.md`

When Gemini is selected explicitly or selected from interactive detection, init applies the same preservation and migration rules and imports `@./KNOWL.md`. An existing standalone `AGENTS.md` import also counts as configured because it already receives the synchronized Knowl section; init must not add duplicate guidance.

### Creation policy

- Always create or refresh `KNOWL.md` and `AGENTS.md` during base init and upgrade.
- Create or refresh `CLAUDE.md` only when Claude is selected.
- Create or refresh `GEMINI.md` only when Gemini is selected.
- Non-interactive init without explicit agent names continues to configure no host integrations.

## Claude prompt reminder

`knowl init claude` installs a Knowl-owned `UserPromptSubmit` command hook by default. The hook runs a dedicated reminder command, distinct from lifecycle capture:

```text
knowl agent-reminder claude --json
```

On Windows the configured executable is `knowl.cmd`; other platforms use `knowl`.

The command emits host-native JSON containing a fixed `additionalContext` message equivalent to:

> KNOWL: Before project-specific repository work, call `knowl_query` with 2-6 keywords unless you already queried Knowl for this request or lifecycle context directly answers it. Do not inspect files first. If Knowl tools are unavailable, tell the user.

The reminder command has these hard boundaries:

- It does not read or parse stdin.
- It does not inspect the prompt payload.
- It does not locate a Knowl project.
- It does not load project configuration or open the database.
- It does not create or bind a memory session.
- It does not capture a lifecycle event.
- It writes only the fixed host response to stdout and exits successfully.
- Its hook entry has an empty status message.

The conditional wording avoids unnecessary Knowl calls for casual conversation, already-queried requests, and tasks directly answered by lifecycle context. It also tells the model not to query repeatedly within one request.

The reminder remains model-directed rather than deterministic retrieval. Its purpose is to make the desired action recent and explicit without reintroducing the retired prompt-processing pipeline.

## Hook migration and identity

The new reminder must have a distinct command identity from the retired lifecycle prompt hook.

- Continue removing legacy Knowl-owned commands matching `agent-hook <host> UserPromptSubmit` or Cursor's retired prompt event.
- Preserve user-authored prompt hooks.
- Preserve the new `agent-reminder claude --json` entry during cleanup.
- Rerunning init updates stale Knowl reminder entries and never duplicates the current one.
- Lifecycle verification for Claude requires both the existing capture events and the reminder entry.
- Existing Claude sessions require a new session after init because hook and instruction discovery occur at session startup.

## Gemini integration

Add `gemini` to the project-local agent registry.

- Detect the `gemini` executable.
- Configure Knowl under `mcpServers.knowl` in `.gemini/settings.json` using the same platform-specific `knowl serve` command as other project adapters.
- Preserve unrelated Gemini settings.
- Verify the exact MCP entry after writing.
- Install the `GEMINI.md` import described above.
- Report lifecycle automation as unsupported in this change and keep `knowl task run` as the documented fallback.

Explicit agent names are validated before base init writes any files so an unsupported target cannot leave a partially initialized repository.

## Data flow

### Initialization

1. Parse and validate explicit agent names.
2. Create or upgrade `.knowl` project state.
3. Create or refresh canonical `KNOWL.md`.
4. Synchronize the managed section into `AGENTS.md`.
5. Configure each selected host's MCP entry.
6. Create, migrate, or refresh that host's native instruction import.
7. For Claude, configure existing lifecycle capture hooks plus the reminder-only prompt hook.
8. Verify MCP, lifecycle, reminder, and instruction integration and report the result.

### Claude request

1. Claude loads `CLAUDE.md`, which imports `KNOWL.md`, when the session starts.
2. Existing `SessionStart` behavior injects bounded recent Knowl context when available.
3. Before each user prompt, the reminder command emits the fixed task-start instruction without touching the prompt or database.
4. Claude decides whether the request is project-specific and whether an exception applies.
5. For applicable work, Claude calls `knowl_query` before repository tools.
6. Normal MCP retrieval and lifecycle capture continue unchanged.

## Error handling and preservation

- Filesystem and malformed JSON errors fail the selected host integration and surface the existing init failure summary.
- A missing host instruction file is created; unrelated existing content is never replaced.
- A malformed managed marker is repaired using the existing marker-replacement behavior while preserving content before the opening marker.
- Existing valid imports, including a user-authored equivalent relative import, count as configured.
- The reminder command itself is repository-independent and has no expected runtime failure path beyond stdout failure or process launch failure.
- The reminder emits no blocking decision and returns exit code 0. Host-level process launch failures follow Claude's normal hook error behavior and are documented rather than hidden.

## Testing and verification

### Guidance tests

- Base init creates `KNOWL.md` and a synchronized `AGENTS.md` section.
- Rerun is unchanged when both are current.
- Stale managed content is refreshed without changing unrelated content.
- Claude creation, existing-import detection, duplicate-section migration, preservation, and rerun idempotency are covered.
- Gemini receives the corresponding tests using `@./KNOWL.md`.

### Reminder tests

- `agent-reminder claude --json` emits the exact valid Claude hook response outside a Knowl repository.
- Secret-looking and malformed stdin cannot affect output because the command does not consume stdin.
- The command does not create `.knowl`, open a database, or require project configuration.
- Claude hook merge preserves user `UserPromptSubmit` hooks, removes the retired Knowl lifecycle entry, and installs exactly one reminder.
- Verification rejects missing or altered reminder entries.
- Reminder hooks use no status message.

### Gemini tests

- Detection and explicit name parsing include Gemini.
- `.gemini/settings.json` preserves unrelated configuration and receives the correct Knowl MCP command.
- Verification and idempotent reruns pass.
- The init summary reports MCP configured and lifecycle fallback clearly.
- Invalid explicit agent names fail before any base artifacts are written.

### End-to-end verification

1. Run focused guidance, adapter, hook, lifecycle, init-flow, and CLI tests.
2. Run the complete test suite and production build.
3. Benchmark standalone cold and warm reminder-command process launches and report their overhead; do not add a timing-sensitive CI assertion.
4. Rerun `knowl init claude` in `D:/coding/DuckPrep-server` after implementation.
5. Start a fresh trusted Claude session and verify `/context` includes `KNOWL.md` through `CLAUDE.md`.
6. In three fresh Claude sessions, submit one project-specific prompt and confirm the first project action is a focused `knowl_query` before repository tools. Also verify a casual non-project prompt does not cause unnecessary retrieval.

## Documentation

Update the README to explain:

- `KNOWL.md` is canonical.
- `AGENTS.md` receives synchronized guidance rather than an import.
- Claude and Gemini use native imports.
- The Claude prompt reminder is default-on, reminder-only, and does not retain prompt content.
- Gemini lifecycle capture remains on the manual `knowl task run` fallback in this change.
- Existing host sessions must be restarted after rerunning init.

## Success criteria

- One canonical workflow drives all generated host guidance.
- Existing user-authored instruction content survives init and upgrade.
- Claude receives a fixed task-start reminder on every prompt without prompt inspection, database access, or lifecycle capture.
- The old per-prompt retrieval/capture behavior remains absent.
- In three fresh DuckPrep Claude sessions, the first project-specific prompt triggers `knowl_query` before any repository tool.
- Gemini can be selected during init, use the Knowl MCP server, and load the canonical workflow.
- Focused tests, the complete suite, and the build pass.
