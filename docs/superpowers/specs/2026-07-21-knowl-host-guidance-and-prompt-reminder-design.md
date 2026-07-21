# Host-Native Knowl Guidance and Claude Prompt-Time Workflow Design

**Date:** 2026-07-21

**Status:** Revised concept; awaiting written-spec review

## Problem

Knowl currently writes its model-facing workflow only into `AGENTS.md`. Claude Code does not natively load that filename, Gemini CLI is not a supported `knowl init` target, and host-specific copies can drift from the generated guidance.

Instruction-file delivery is not the whole problem. `D:/coding/DuckPrep-server` reproduces the failure with all of the expected Claude integration present:

- Claude reports the project `CLAUDE.md` as loaded.
- `CLAUDE.md` contains the same Knowl section as `AGENTS.md`.
- `.mcp.json` registers the Knowl MCP server.
- `.claude/settings.local.json` installs the Knowl `SessionStart` lifecycle hook.
- Claude still tends to call Knowl only when the user explicitly requests it.

The existing contract is long and leaves task-start behavior implicit. It says lifecycle bootstrap supplies initial context and describes `knowl_query` as focused follow-up, but it does not state one short, prominent rule that applies to every project-specific request. It also does not explain the complete MCP tool set or distinguish automatic host lifecycle capture from the manual `knowl_task_start` / `knowl_task_checkpoint` / `knowl_task_finish` work loop.

Host instruction files are advisory context that Claude may deprioritize or forget later in a session. Knowl also omits the MCP protocol's server-level `instructions`, so hosts receive only individual tool descriptions. The exported MCP tool inventory currently lists 21 names while the server actually registers 24, demonstrating that documentation and discovery can drift without an exact completeness check.

## Goals

1. Make `KNOWL.md` the human-visible canonical Knowl workflow for a project.
2. Deliver that workflow through each selected host's native instruction mechanism without overwriting unrelated instructions.
3. Make task-start retrieval concise and unambiguous.
4. Teach agents when to use every registered Knowl MCP tool, including the automatic-lifecycle versus manual-work-loop boundary.
5. Publish a compact version of that workflow through MCP server instructions.
6. Install a default-on Claude `UserPromptSubmit` hook that injects the compact operational workflow immediately before each prompt is processed.
7. Keep the hook independent of retrieval, capture, session state, and raw prompt content.
8. Add project-local Gemini MCP registration and native guidance support.
9. Preserve additive, idempotent `knowl init` behavior.

## Non-goals

- Do not restore automatic per-prompt database retrieval.
- Do not store, parse, summarize, log, or otherwise retain the user prompt in the prompt-time hook path.
- Do not restore the retired Knowl-owned `agent-hook ... UserPromptSubmit` capture path.
- Do not tell agents to invoke every Knowl tool on every task. Complete discovery is paired with explicit routing and safety gates.
- Do not stack a manual task work loop on a hook-owned lifecycle session or ask an agent to finish a hook-owned memory session.
- Do not automatically invoke raw ingestion, synthesis, skill creation, session promotion, or garbage-collection mutation merely because the tools are advertised.
- Do not add prompt reminders for Codex, Cursor, or Gemini until their current prompt-hook output formats and overhead are separately verified.
- Do not use filesystem symlinks or hard links; they are fragile across Windows, Git configuration, and existing user files.
- Do not overwrite unrelated content in `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, or a pre-existing `KNOWL.md`.
- Do not change normal `SessionStart`, tool-event capture, stop, finalization, or handoff semantics.

## Approaches considered

### 1. Canonical file and host imports only

Create `KNOWL.md`, import it from Claude and Gemini files, and synchronize it into `AGENTS.md`. This fixes routing and drift but remains vulnerable to the behavior reproduced in DuckPrep: Claude can load the rules and still skip Knowl.

### 2. Automatic retrieval on every prompt

Restore `UserPromptSubmit` as a full lifecycle event, read the prompt, open the database, run retrieval, and inject results. This is the most deterministic retrieval path, but it restores the per-prompt process, database, session, and repeated-context overhead that commit `12d8d52` intentionally removed. It also expands prompt-handling and privacy scope.

### 3. Canonical guidance plus server instructions and a prompt-time operational card

Use native instruction files for the full durable reference, publish a host-neutral compact operational card through MCP initialization, and inject the corresponding Claude-mode rendering through a fixed hook immediately before each prompt. The hook performs no retrieval or capture. This adds one short-lived process and roughly 1,700 characters of model context per prompt, but avoids database and session work and gives the complete routing instruction greater recency than startup guidance. The cumulative context cost is accepted for this reliability goal, bounded and measured as part of verification.

This is the selected approach.

## Canonical `KNOWL.md`

`knowl init` creates or refreshes a marker-delimited Knowl section in project-root `KNOWL.md`. A pre-existing file keeps all content outside the managed markers.

The managed section places the required behavior first:

1. For every project-specific request, call `knowl_query` with 2-6 concise keywords before reading/searching repository files or running project commands.
2. Skip a new query only when lifecycle-injected context already contains a directly relevant active answer, Knowl was already queried for the same request, or a manual `knowl_task_start` returned relevant memory for that request.
3. Use a relevant active hit immediately. Inspect repository files only on a miss, conflict, stale or low-confidence memory, or an explicit source-verification request.
4. Query again before switching to a distinct subtask or project area.
5. Store or update concise durable findings during work and before the final answer; never store raw transcripts, secrets, or temporary debugging noise.
6. If Knowl MCP tools are unavailable, stop and tell the user instead of silently bypassing Knowl.

Immediately after the core rules, the managed section explains the two mutually exclusive lifecycle modes:

- **Automatic host lifecycle:** verified hooks own session bootstrap, event capture, checkpoints, and finalization. The agent uses retrieval, durable-memory, evidence, and skill tools as needed, but does not call `knowl_task_start`, `knowl_task_checkpoint`, `knowl_task_finish`, or `knowl_session_finish` for the hook-owned session.
- **Manual work loop:** when lifecycle hooks are unavailable, use `knowl task run` for one bounded command. For multi-command or resumable agent work, call `knowl_task_start` once, reuse its `taskId` for meaningful milestone/blocker checkpoints, and call `knowl_task_finish` exactly once after verification. The relevant memory returned by `knowl_task_start` satisfies the initial focused lookup; do not immediately duplicate it with `knowl_query`.

Casual conversation, a single memory lookup, and trivial non-resumable work do not create a manual task loop.

### Complete MCP tool routing

The generated reference names and routes every registered MCP tool. The list is grouped by intent so complete discovery does not imply unconditional use:

| Group | Tools | Routing |
| --- | --- | --- |
| Focused retrieval | `knowl_query` | Default first call for a specific project request and again when switching areas. Use 2-6 keywords and omit category unless certain. |
| Context views | `knowl_recent`, `knowl_state`, `knowl_context` | Use recent only when lifecycle bootstrap is unavailable or an explicit refresh is needed; state for a broad status/full-memory request; context for an explicitly token-budgeted, diversified pack. |
| Manual work loop | `knowl_task_start`, `knowl_task_checkpoint`, `knowl_task_finish` | Use only in manual lifecycle mode for multi-command/resumable work. Start once, checkpoint meaningful progress or a blocker, finish once after verification. Never mix with a hook-owned session. |
| Durable writes | `knowl_store`, `knowl_ingest_atoms`, `knowl_decide`, `knowl_update` | Store one atom, batch multiple atoms, record a confirmed decision with reasoning, or correct/supersede stale memory. Write verified durable knowledge, not routine command output. |
| History and quality | `knowl_timeline`, `knowl_evidence_list`, `knowl_conflicts`, `knowl_feedback` | Inspect immutable history, evidence, or active conflicts when needed. Record feedback only after a retrieved item was actually used, rejected, or caused a correction. |
| Learned skills | `knowl_skill_list`, `knowl_skill_read`, `knowl_skill_run`, `knowl_skill_create` | Discover and read a matching project skill before running its trusted entrypoint. Create a skill only when the user asks to codify a reusable workflow or the task explicitly requires it. |
| Special and maintenance | `knowl_ingest`, `knowl_synthesize`, `knowl_session_finish`, `knowl_gc_preview`, `knowl_gc_apply` | Raw-source ingest requires an explicit ingestion request and configured AI; never send the current conversation silently. Synthesis is explicitly scoped and never automatic. Session finish is only for an explicitly owned manual memory-session ID, never a hook session. GC apply requires preview plus explicit user approval. |

Secret validation, active-versus-stale handling, and the rule to update rather than duplicate contradictory memory remain directly below this routing table.

### Shared guidance source and MCP server instructions

One canonical guidance module owns the core workflow, the exact 24-tool inventory, seven routing groups, and safety clauses. It renders three views:

- A full reference for the managed `KNOWL.md` and synchronized `AGENTS.md` sections.
- A compact, host-neutral operational card for MCP server instructions.
- A corresponding compact card with a verified automatic-lifecycle mode line for the Claude prompt hook.

Both compact renderings name all 24 tools, keep the mandatory project-start rule and lifecycle mode in the opening 512 characters, and stay below 2,000 characters. The host-neutral mode line describes both branches; the Claude line states that the installed lifecycle hooks own capture and finalization. Individual tool descriptions remain task-specific fallback guidance.

`createMcpServer` passes the compact card as the SDK `Server` option `instructions`. The installed SDK already supports this field, so no dependency change is required. MCP instructions are still advisory and some clients may ignore them; they supplement rather than replace native files and the Claude hook. The server uses the in-code canonical text even when the current directory is not an initialized Knowl project and never reads generated `KNOWL.md` at startup.

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

## Claude prompt-time operational hook

`knowl init claude` installs a Knowl-owned `UserPromptSubmit` command hook by default. The hook runs a dedicated guidance command, distinct from lifecycle capture:

```text
knowl agent-reminder claude --json
```

On Windows the configured executable is `knowl.cmd`; other platforms use `knowl`.

The command emits host-native JSON containing the following compact operational card in `additionalContext`:

```text
KNOWL WORKFLOW - for project work.
Start: use a relevant active lifecycle hit; else call knowl_query with 2-6 keywords before repository files or commands. A knowl_task_start hit counts in manual mode. Re-query on a new area. Inspect files only after miss/conflict/stale/low-confidence or explicit verification. If tools are unavailable, stop and tell the user.
Mode: Claude hooks own lifecycle. Never call knowl_task_start, knowl_task_checkpoint, knowl_task_finish, or knowl_session_finish while active.
Manual fallback: one bounded command uses knowl task run; resumable work uses knowl_task_start once, knowl_task_checkpoint at meaningful milestones/blockers with its taskId, and knowl_task_finish once after verification.
Route:
- retrieval: knowl_query; knowl_recent only without bootstrap or for refresh; knowl_state for broad state; knowl_context for a token-budgeted pack.
- durable memory: knowl_store one atom; knowl_ingest_atoms a batch; knowl_decide a confirmed choice; knowl_update a stale or contradicted item.
- audit: knowl_timeline, knowl_evidence_list, knowl_conflicts; knowl_feedback after actual use or correction.
- skills: knowl_skill_list, knowl_skill_read, knowl_skill_run only for a trusted matching entrypoint; knowl_skill_create only when explicitly requested.
- special: knowl_ingest only for explicit raw-source ingestion, never silent chat; knowl_synthesize only for an explicit scope; knowl_session_finish only for an explicitly owned manual session; knowl_gc_preview before maintenance; knowl_gc_apply only after preview and explicit approval.
During work, store or update verified durable findings; never store raw transcripts, secrets, or routine command noise.
```

The host-neutral MCP rendering replaces only the mode line with: `Mode: verified hooks, when active, own lifecycle. Never call knowl_task_start, knowl_task_checkpoint, knowl_task_finish, or knowl_session_finish while active; otherwise use the manual fallback.`

The command serializes the card in this exact Claude hook envelope, with normal JSON string escaping and no blocking fields:

```json
{
  "hookSpecificOutput": {
    "hookEventName": "UserPromptSubmit",
    "additionalContext": "<Claude-mode operational card>"
  }
}
```

The hook is deliberately self-contained. It does not merely say "read `KNOWL.md`," because the failure being addressed is Claude deprioritizing previously loaded file instructions. `KNOWL.md` remains the detailed reference and audit surface, while the hook repeats enough routing to act correctly without rereading it on every prompt.

The reminder command has these hard boundaries:

- It does not read or parse stdin.
- It does not inspect the prompt payload.
- It does not locate a Knowl project.
- It does not load project configuration or open the database.
- It does not create or bind a memory session.
- It does not capture a lifecycle event.
- It writes only the fixed host response containing the in-code operational card to stdout and exits successfully.
- Its hook entry has an empty status message.

The conditional wording avoids unnecessary Knowl calls for casual conversation, already-queried requests, and tasks directly answered by lifecycle context. It also tells the model not to query repeatedly within one request or duplicate automatic session capture with the manual task tools.

The operational card remains model-directed rather than deterministic retrieval. Its purpose is to make the complete workflow recent and explicit without reintroducing the retired prompt-processing pipeline.

## Hook migration and identity

The new reminder must have a distinct command identity from the retired lifecycle prompt hook.

- Continue removing legacy Knowl-owned commands matching `agent-hook <host> UserPromptSubmit` or Cursor's retired prompt event.
- Preserve user-authored prompt hooks.
- Remove retired Knowl handlers at the nested handler level. If one matcher group contains both a retired Knowl handler and a user handler, retain the matcher group and every user handler; remove the group only when no handlers remain.
- Preserve the new `agent-reminder claude --json` entry during cleanup.
- Rerunning init updates stale Knowl reminder entries and never duplicates the current one.
- Lifecycle verification for Claude requires both the existing capture events and the prompt-time operational entry. This is what makes the card's automatic-lifecycle mode truthful.
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
7. For Claude, configure existing lifecycle capture hooks plus the prompt-time operational hook.
8. Verify MCP, lifecycle, operational hook, and instruction integration and report the result.

### Claude request

1. Claude loads `CLAUDE.md`, which imports `KNOWL.md`, when the session starts.
2. Existing `SessionStart` behavior injects bounded recent Knowl context when available.
3. Before each user prompt, the guidance command emits the fixed operational card without touching the prompt or database.
4. Claude decides whether the request is project-specific and whether an exception applies.
5. For applicable work, Claude uses directly relevant active bootstrap context or calls `knowl_query` before repository tools.
6. Claude routes any later Knowl operations using the full tool map in the card, while leaving task/session ownership to the automatic lifecycle hooks.
7. Normal MCP retrieval and lifecycle capture continue unchanged.

## Error handling and preservation

- Filesystem and malformed JSON errors fail the selected host integration and surface the existing init failure summary.
- A missing host instruction file is created; unrelated existing content is never replaced.
- A malformed managed marker is repaired using the existing marker-replacement behavior while preserving content before the opening marker.
- Existing valid imports, including a user-authored equivalent relative import, count as configured.
- The prompt-time command itself is repository-independent and has no expected runtime failure path beyond stdout failure or process launch failure.
- The hook emits no blocking decision and returns exit code 0. Host-level process launch failures follow Claude's normal hook error behavior and are documented rather than hidden.

## Testing and verification

### Guidance tests

- Base init creates `KNOWL.md` and a synchronized `AGENTS.md` section.
- Rerun is unchanged when both are current.
- Stale managed content is refreshed without changing unrelated content.
- Claude creation, existing-import detection, duplicate-section migration, preservation, and rerun idempotency are covered.
- Gemini receives the corresponding tests using `@./KNOWL.md`.
- The full reference contains each registered MCP tool name and routes the automatic and manual lifecycle modes without overlap.
- The canonical inventory equals the exact `tools/list` name set, including `knowl_synthesize`, `knowl_feedback`, and `knowl_session_finish`; additions or removals fail the test rather than silently drifting.
- `knowl_recent` descriptions agree that lifecycle bootstrap is preferred and that explicit refresh/manual mode are the exceptions.

### MCP instruction tests

- The initialize response exposes the compact operational card as `result.instructions`.
- Both compact renderings are below 2,000 characters, their opening 512 characters contain the project-start action and lifecycle mode, and each contains all 24 canonical tool names.
- The server instructions, generated full reference, and exact tool inventory are rendered from the same canonical guidance source.
- The host-neutral and Claude compact renderings differ only in their mode line.
- Individual tool descriptions preserve task-specific routing, including the manual-only task loop and destructive-operation gates.

### Prompt-time hook tests

- `agent-reminder claude --json` emits the exact nested `hookSpecificOutput` / `UserPromptSubmit` response containing the Claude-mode operational card outside a Knowl repository and emits no blocking fields.
- Secret-looking and malformed stdin cannot affect output because the command does not consume stdin.
- The command does not create `.knowl`, open a database, or require project configuration.
- Claude hook merge preserves user `UserPromptSubmit` hooks, removes the retired Knowl lifecycle entry, and installs exactly one reminder.
- A matcher entry containing both a retired Knowl handler and a user handler loses only the Knowl handler; the matcher and user handler remain byte-for-byte equivalent after JSON parsing.
- Verification rejects missing or altered reminder entries.
- Prompt-time hooks use no status message.
- The card explicitly says automatic Claude lifecycle owns capture/finalization and forbids `knowl_task_start`, `knowl_task_checkpoint`, `knowl_task_finish`, and `knowl_session_finish` on the hook-owned session.
- A separate manual-mode guidance test states that successful `knowl_task_start` supplies the initial relevant-memory lookup, checkpoints only meaningful progress/blockers, and finishes exactly once.

### Gemini tests

- Detection and explicit name parsing include Gemini.
- `.gemini/settings.json` preserves unrelated configuration and receives the correct Knowl MCP command.
- Verification and idempotent reruns pass.
- The init summary reports MCP configured and lifecycle fallback clearly.
- Invalid explicit agent names fail before any base artifacts are written.

### End-to-end verification

1. Run focused guidance, adapter, hook, lifecycle, init-flow, and CLI tests.
2. Run the complete test suite and production build.
3. Benchmark standalone cold and warm prompt-time command launches and report their overhead; do not add a timing-sensitive CI assertion.
4. Measure the injected payload and host-observed transcript/context growth across 20 user prompts. Accept at most 500 estimated tokens per card and 10,000 cumulative estimated card tokens over 20 prompts; report any extra host wrapper or replay overhead separately.
5. Rerun `knowl init claude` in `D:/coding/DuckPrep-server` after implementation.
6. Start a fresh trusted Claude session and verify `/context` includes `KNOWL.md` through `CLAUDE.md`.
7. In three fresh Claude sessions, submit one project-specific prompt and confirm the first project action uses directly relevant active bootstrap context or a focused `knowl_query` before repository tools. Confirm Claude does not start a parallel manual work loop while automatic hooks are active.
8. Ask Claude which Knowl tool it would use for one scenario from each routing group and confirm the answer follows the operational card without needing an explicit "read `KNOWL.md`" instruction.
9. Verify a casual non-project prompt does not cause unnecessary retrieval.

## Documentation

Update the README to explain:

- `KNOWL.md` is canonical.
- `AGENTS.md` receives synchronized guidance rather than an import.
- Claude and Gemini use native imports.
- MCP initialization publishes the compact, complete tool-routing card when the client supports server instructions.
- The Claude prompt-time hook is default-on, injects the corresponding Claude-mode operational card, and does not inspect or retain prompt content.
- Automatic host lifecycle and manual task work loops are mutually exclusive for one task.
- The complete 24-tool table includes safety gates and is checked against the actual MCP tool list.
- Gemini lifecycle capture remains on the manual `knowl task run` fallback in this change.
- Existing host sessions must be restarted after rerunning init.

## Success criteria

- One canonical workflow drives all generated host guidance.
- Every registered MCP tool is discoverable through both the full reference and the compact card, and exact-set tests prevent drift.
- Existing user-authored instruction content survives init and upgrade.
- Claude receives the fixed, complete operational card on every prompt without prompt inspection, database access, or lifecycle capture.
- MCP clients that honor server instructions receive the host-neutral compact rendering at initialization.
- Claude's hook-owned lifecycle never receives a duplicate model-created task/session loop; manual hosts receive explicit start/checkpoint/finish routing.
- The old per-prompt retrieval/capture behavior remains absent.
- In three fresh DuckPrep Claude sessions, the first project-specific prompt uses relevant active bootstrap context or triggers `knowl_query` before any repository tool, and Claude can correctly route all tool groups from the prompt-time card.
- Gemini can be selected during init, use the Knowl MCP server, and load the canonical workflow.
- Focused tests, the complete suite, and the build pass.
