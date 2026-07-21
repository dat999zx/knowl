# Knowl

A local-first knowledge operating system for AI agents.

Knowl gives an AI coding agent durable project memory without sending that memory to a hosted service by default. It stores structured knowledge atoms in a per-project SQLite database under `.knowl/`, exposes that memory through a CLI, and provides an MCP server so tools such as Codex, Cursor, or Claude Desktop can retrieve and update project context while they work.

Knowl is designed for durable engineering context: decisions, architecture, goals, constraints, facts, current state, and reusable skills. It is not meant to archive raw chat logs.

## What It Does

- Stores project memory locally in `.knowl/knowl.db`.
- Organizes memory into `fact`, `decision`, `goal`, `constraint`, `architecture`, `state`, and `skill` categories.
- Provides deterministic MCP tools for storing and querying structured knowledge without a Knowl-side AI provider.
- Generates canonical `KNOWL.md` plus a synchronized managed section in `AGENTS.md` so agents know to query Knowl before inspecting files.
- Records work-loop starts, checkpoints, and finishes as structured state atoms with knowledge commits.
- Wraps shell commands with an automatic work loop so agents query memory before execution and write back success or failure state.
- Stores learned executable skill packages under `.knowl/skills/<name>/` with `SKILL.md`, `skill.json`, and optional scripts.
- Exposes stable MCP and CLI skill bridges so new learned skills work without adding one new tool per skill.
- Detects supported agents and installs MCP registrations from `knowl init`.
- Adds `.knowl/` to `.gitignore` during project initialization.
- Supports optional AI-backed CLI commands for raw text ingestion and natural-language answers.
- Supports BM25 plus default-on local vector search with a lazy first-use model download.
- Tracks memory changes as knowledge commits so project memory has history.
- Indexes TypeScript/JavaScript symbols locally with Tree-sitter and can attach durable evidence to `symbol://` locators.
- Supports temporal assertions, exclusive conflict identities, bounded context packs, layered memory namespaces, and verified JSONL portability.
- Includes a read-only localhost viewer via `knowl view`.

## Install

Install the published CLI:

```bash
npm install -g @dat999zx/knowl
knowl --version
```

Build and link from source:

```bash
git clone <repo-url>
cd knowl
npm install
npm run build
npm link
```

## Quick Start

Initialize a project from the project root:

```bash
knowl init
```

This creates `.knowl/config.json`, bootstraps `.knowl/knowl.db`, installs canonical `KNOWL.md` plus synchronized `AGENTS.md` guidance, ensures `.knowl/` is ignored by git, and offers project-local MCP plus host setup for detected agents.

Record a decision:

```bash
knowl decide "Use SQLite" "Use SQLite for local project memory." \
  --reasoning "It keeps Knowl local-first and simple to install." \
  --alternatives PostgreSQL MongoDB \
  --tags database local-first
```

Inspect the project memory:

```bash
knowl status
knowl state
knowl doctor
```

Choose detected agents interactively, or configure them explicitly:

```bash
knowl init
knowl init codex claude cursor gemini
knowl doctor
```

Project-local MCP and host config is preferred. Claude uses `CLAUDE.md` importing `@KNOWL.md` and a default-on matcher-free `UserPromptSubmit` hook that runs `knowl.cmd agent-reminder claude --json`; the prompt reminder emits a fixed card without reading the prompt, opening the database, or capturing a session. During one long Claude response, the existing `PostToolUse` lifecycle hook also emits a shorter continuation reminder after every eight accepted successful tool events. Gemini uses `.gemini/settings.json` and `GEMINI.md` importing `@./KNOWL.md`; it remains on the manual `knowl task run` fallback because no verified lifecycle hook format is assumed. Existing host rules and active `@AGENTS.md`/`@KNOWL.md` imports are preserved. Start a new agent session after setup and trust the repository when the host asks before running project hooks. Claude Desktop receives MCP configuration but remains lifecycle-unsupported.

Wrap work with an automatic Knowl work loop:

```bash
knowl task run "Implement search UI" --query "search retrieval" -- npm test
```

Or record manual checkpoints:

```bash
knowl task start "Implement search UI" --query "search retrieval"
knowl task checkpoint <task-id> "Added search UI tests" \
  --goal "Ship search UI" \
  --completed "Added search UI tests" \
  --next-action "Finish implementation" \
  --artifact "src/search-ui.ts" \
  --verification-status "tests-passing"
knowl task finish <task-id> "Verified search UI implementation"
```

Session events are temporary scratch memory, not transcript archives. They retain only bounded command/test/error/git/decision metadata, expire after 48 hours, and stale active sessions can be recovered safely:

```bash
knowl session start "Implement search UI" --query "search retrieval"
knowl session event <session-id> test --summary "store tests passed"
knowl session finish <session-id> --status finished --summary "implementation verified"
knowl session recover
```

When a terminal session is finished normally, Knowl deterministically promotes at most five candidates: decisions, verified commands, outcomes, and task state. Each promoted candidate requires session or file evidence. Optional synthesis is never required for promotion; deterministic candidates remain the fallback. Promotion stores its item IDs on the session, so retries are idempotent.

### Agent lifecycle automation

`knowl init` installs verified project-local hooks for Codex CLI, Claude Code, and Cursor. Lifecycle hooks call short-lived `knowl agent-hook <host> <event>` processes that normalize vendor payloads into bounded session events. Claude additionally receives the prompt-time `knowl agent-reminder claude --json` card. MCP tools use a separate host-spawned `knowl serve` process; hooks never launch or manage serve.

SessionStart is the sole automatic retrieved-memory injection; Claude's prompt reminder and throttled continuation reminder are fixed workflow guidance, not retrieved memory. Claude's successful `PostToolUse` hook injects the compact continuation reminder after every eight accepted tool events in one turn; all other tool events and capture hooks remain quiet. The counter resets when the turn binding closes at `Stop`. An interrupted turn may retain its count and remind sooner on the next response, but never later. The continuation reminder does not query Knowl or inspect prompt content. Successful commands, file changes, tests, failures, compaction checkpoints, and turn completion still feed the existing validation/evidence/promotion pipeline.

When a supported host ends with a hard-stop failure (Claude `StopFailure`, failed Codex/Cursor stop/session end, or generic failed stop), Knowl stores a host-scoped deterministic `pending_handoff` state item (no AI required). The next matching-host `SessionStart` injects that handoff first, then normal recent context, and archives it so delivery is one-shot. Ordinary successful stops and tool failures do not create handoffs.

Checkpoints may also carry structured task state (`goal`, `completed`, `nextAction`, `blocker`, `artifactRefs`, `verificationStatus`). When present, those fields ride through the pending handoff so the next session can resume without reconstructing progress from prose alone. Manual `knowl_task_checkpoint` accepts the same fields for MCP work loops.

Multiple leftover `knowl serve` processes usually mean multiple host sessions or reconnects, not hook respawn. Multiple agents can use one repo with shared SQLite and brief lock waits; agents in different repos remain isolated under each project `.knowl/`.

Raw prompts, transcripts, stdout/stderr, environment variables, and unknown fields are not retained. Malformed or secret-bearing payloads are rejected, duplicate stop events are idempotently dropped, and stale sessions recover at the next session start. A generic stdin-JSON contract is available for other hosts, but normal users only run `knowl init` and `knowl doctor`.

Hook support remains host-specific. Knowl never guesses or writes an unverified host configuration. Verified lifecycle hooks and a manual task loop are mutually exclusive for one task. Unsupported hosts retain MCP access; `knowl task run` remains the manual fallback. Rerun init after upgrades, then start a new host session so imported instructions and hook registrations are reloaded.

Create and run a learned skill package:

```bash
knowl skill create run_app \
  --purpose "Start the app locally" \
  --markdown "# Run App\n\nUse this to start the app.\n" \
  --file "run.ps1=Write-Output 'run-app'" \
  --script run.ps1

knowl skill list
knowl skill read run_app
knowl skill run run_app
```

## MCP Workflow

MCP is the preferred way for agents to use Knowl. The MCP tools do not require Knowl-side AI configuration for normal structured memory workflows. The client model should extract durable knowledge and call Knowl's structured tools.

Recommended agent flow:

1. Lifecycle hooks deliver compact context once at session start. Call `knowl_recent` only when hooks are unavailable or a refresh is needed.
2. Use `knowl_query` for specific questions, with 2-6 concise keywords.
3. Use `knowl_state` only for broad full-state summaries.
4. For multi-step tasks, query Knowl again before each new subtask or when switching areas.
5. Store durable new facts, decisions, constraints, architecture notes, state, and skills immediately after each completed subtask or verified finding with `knowl_store`, `knowl_decide`, or `knowl_ingest_atoms`.
6. Use `knowl_update` as soon as you find stale or contradicted memory.

Routine lifecycle events remain ephemeral. MCP responses are compact and bounded by default; explicit detail options request larger inspection payloads.

Available MCP tools (the MCP server publishes this same host-neutral workflow card in its initialize instructions):

| Tool | Purpose |
| --- | --- |
| `knowl_query` | Focused 2-6 keyword retrieval before project files and before each new subtask or area switch. |
| `knowl_recent` | Compact recent context only when lifecycle bootstrap is unavailable or an explicit refresh is needed. |
| `knowl_state` | Broad active project-memory status or full-state summary. |
| `knowl_context` | Compose an explicitly token-budgeted context pack. |
| `knowl_task_start` | Start one manual work loop when verified lifecycle hooks are unavailable. |
| `knowl_task_checkpoint` | Checkpoint meaningful manual-loop progress or blockers with its task ID. |
| `knowl_task_finish` | Finish one manual work loop once after verification. |
| `knowl_store` | Store one concise structured durable atom. |
| `knowl_ingest_atoms` | Batch store client-extracted durable atoms, never raw transcripts. |
| `knowl_decide` | Record a confirmed project decision and reasoning. |
| `knowl_update` | Correct or supersede stale or contradicted memory. |
| `knowl_timeline` | Inspect immutable assertions for one item's history. |
| `knowl_evidence_list` | Inspect evidence linked to one item. |
| `knowl_conflicts` | Inspect active exclusive conflict identities. |
| `knowl_feedback` | Record feedback after an item was actually used, rejected, or corrected. |
| `knowl_skill_list` | List learned file-backed skills. |
| `knowl_skill_read` | Inspect one learned skill package before running it. |
| `knowl_skill_run` | Run a trusted matching learned-skill entrypoint. |
| `knowl_skill_create` | Create a reusable learned skill only when explicitly requested. |
| `knowl_ingest` | Process explicitly supplied raw source through configured AI; never silently ingest the current conversation. |
| `knowl_synthesize` | Create or refresh one explicitly scoped evidence-backed understanding; never automatic. |
| `knowl_session_finish` | Finish an explicitly owned manual memory session, never a hook-owned session. |
| `knowl_gc_preview` | Preview duplicate, stale, or cold memory cleanup. |
| `knowl_gc_apply` | Apply previewed maintenance after explicit approval. |

Readable MCP resources:

| Resource | Purpose |
| --- | --- |
| `knowl://recent` | Compact recent session context. |
| `knowl://brain` | Full active project brain state. |
| `knowl://category/<name>` | Active items for a category such as `decision`, `architecture`, or `state`. This URI form is readable even though only `knowl://recent` and `knowl://brain` are listed during resource discovery. |

## Agent Setup

`knowl init` detects Codex, Claude Code, Cursor, Gemini CLI, and Claude Desktop, then presents a multi-select UI. Re-run it at any time to add another agent or repair a stale Knowl registration. It preserves unrelated MCP servers and host rules, writes a backup before changing an existing agent config, and does not duplicate correct entries. `KNOWL.md` is the canonical full workflow; `AGENTS.md` contains the synchronized managed reference, while selected Claude/Gemini files use native imports.

If an MCP client shows `Auth: Unsupported` for this local stdio server, that is expected and does not mean Knowl is unavailable.

## CLI Commands

| Command | Description |
| --- | --- |
| `knowl init [agents...]` | Initialize or upgrade this project, then interactively select detected agents. Pass `codex`, `claude`, `cursor`, `gemini`, or `claude-desktop` to configure explicitly. |
| `knowl upgrade` | Upgrade an existing Knowl repository with current defaults and agent files. |
| `knowl status` | Show repository path, item counts, category counts, AI config status, and recent knowledge commits. |
| `knowl doctor` | Check whether the project is ready for agent memory usage. |
| `knowl audit` | Read-only validation, reference, JSON, status, and FTS integrity audit. |
| `knowl snapshot create` | Create a timestamped SQLite snapshot plus SHA-256 manifest. |
| `knowl snapshot restore <path> --confirm` | Restore a snapshot transactionally; creates a pre-restore snapshot first. |
| `knowl evidence list <item-id>` | List linked file, commit, test, command, URL, user, agent, or symbol evidence. |
| `knowl state` | Print the full active hierarchical project memory. |
| `knowl task start <title>` | Start a work loop, query relevant memory, and store active task state. |
| `knowl task checkpoint <task-id> <summary> [--goal ...] [--completed ...] [--next-action ...] [--blocker ...] [--artifact ...] [--verification-status ...]` | Store durable progress and optional structured task state for an active work loop. |
| `knowl task finish <task-id> <summary>` | Store durable completion state for a work loop. |
| `knowl task run <title> -- <command...>` | Start a work loop, run a command, then finish on success or checkpoint on failure with the child exit code. |
| `knowl timeline <item-id>` | Print immutable content assertions for one knowledge item. |
| `knowl query <query> --as-of <timestamp>` | Query historically valid content at an ISO-8601 time. |
| `knowl conflicts` | List active exclusive conflict identities. |
| `knowl supersede <item-id> <replacement-id>` | Mark one item superseded by an explicit replacement. |
| `knowl context --token-budget <n>` | Compose a compact task context pack with pinned constraints and exclusions. |
| `knowl code index` | Incrementally index TypeScript/JavaScript symbols and import/export edges. |
| `knowl code symbols <path>` | Print indexed symbols for one repository-relative file. |
| `knowl synthesize --scope <tag>` | Create or refresh deterministic evidence-backed architecture understanding. |
| `knowl export <path>` | Write a versioned, manifest-verified JSONL memory export. |
| `knowl import <path> [--dry-run]` | Validate and import JSONL memory without auto-resolving conflicts. |
| `knowl view` | Start the read-only local viewer on `127.0.0.1`. |
| `knowl agent-event <event>` | Receive bounded host lifecycle events; accepts structured flags or JSON on stdin. |
| `knowl agent-hook <host> <event>` | Internal host-hook translator used by project-local automatic capture; Claude `PostToolUse` also emits the throttled continuation reminder. |
| `knowl agent-reminder claude --json` | Emit the fixed non-blocking Claude `UserPromptSubmit` workflow card. |
| `knowl session start|event|finish|recover` | Manage bounded, expiring scratch session events and recover stale sessions. |
| `knowl skill list` | List learned file-backed skill packages under `.knowl/skills`. |
| `knowl skill read <name>` | Print `skill.json` and `SKILL.md` for a learned skill package. |
| `knowl skill create <name> --purpose ...` | Create a learned skill package and index it as a `skill` knowledge item. |
| `knowl skill run <name>` | Run a learned skill entrypoint and update usage metadata for the indexed skill item. |
| `knowl decide [title] [content]` | Record a decision. Runs interactively when title or content is omitted. |
| `knowl ask <question>` | Ask a natural-language question over project memory. Requires AI config. |
| `knowl ingest <text>` | Extract and merge knowledge from raw text. Requires AI config. |
| `knowl config` | Open the interactive categorized configuration UI. |
| `knowl config get <key>` | Print one validated configuration value. |
| `knowl config set <key> <value>` | Set one validated configuration value. |
| `knowl config reset [key]` | Reset one setting, or all settings after confirmation. |
| `knowl reindex --vectors` | Rebuild local vector embeddings. |
| `knowl gc` | Preview memory garbage collection recommendations. |
| `knowl gc --apply` | Apply memory garbage collection recommendations. |
| `knowl serve` | Start the stdio MCP server. |

Useful command examples:

```bash
knowl config
knowl config set ai.provider openai
knowl config set ai.model gpt-4o-mini
knowl config set ai.apiKey '${OPENAI_API_KEY}'
knowl config set search.vector.enabled false
knowl reindex --vectors
knowl init codex
knowl task start "Fix auction settlement bug" --query "auction settlement wallet"
knowl task run "Run tests" --query "test verification" -- npm test
knowl gc
knowl gc --apply
knowl audit
knowl snapshot create
knowl snapshot restore .knowl/snapshots/<snapshot>.db --confirm
```

All structured and raw knowledge writes pass deterministic secret, sensitive-path, and size validation. `knowl audit` never mutates data. Restore requires `--confirm`, verifies a snapshot manifest when present, creates a pre-restore snapshot, then audits the restored store.

Evidence is opt-in in MCP query results (`includeEvidence`). Each item can link multiple `supports`, `contradicts`, or `derived_from` records. Example: `src/auth/token.ts:18-55` supports a JWT decision; commit `a18f7c2` derives it; `tests/auth-token.spec.ts` supports it. File evidence reports stale when its stored hash no longer matches disk.

## Optional AI Configuration

Knowl does not require AI configuration for MCP structured tools such as `knowl_store`, `knowl_ingest_atoms`, `knowl_decide`, `knowl_query`, `knowl_recent`, or `knowl_state`.

Configure AI only when you want:

- `knowl ask`
- `knowl ingest`
- MCP `knowl_ingest`
- AI-assisted decision conflict handling in the CLI

Supported providers are `openai`, `anthropic`, `ollama`, and `custom`.

OpenAI example:

```bash
knowl config set ai.provider openai
knowl config set ai.model gpt-4o-mini
knowl config set ai.apiKey '${OPENAI_API_KEY}'
```

Anthropic example:

```bash
knowl config set ai.provider anthropic
knowl config set ai.model claude-3-5-sonnet-latest
knowl config set ai.apiKey '${ANTHROPIC_API_KEY}'
```

Ollama example:

```bash
knowl config set ai.provider ollama
knowl config set ai.model llama3.1
```

For `custom`, set an OpenAI-compatible `ai.baseUrl`:

```bash
knowl config set ai.provider custom
knowl config set ai.model my-model
knowl config set ai.baseUrl http://localhost:8080/v1
knowl config set ai.apiKey my-key
```

Environment variable placeholders such as `${OPENAI_API_KEY}` are resolved at runtime.

## Local Data

Knowl stores project data under `.knowl/`:

- `.knowl/config.json` contains security, AI, and search configuration.
- `.knowl/knowl.db` contains project memory, knowledge commits, search indexes, and optional embeddings. The project scope is implicit from the database location, so Knowl does not persist separate project-name or root-path metadata inside the database.
- `.knowl/skills/` contains file-backed learned skill packages with `SKILL.md`, `skill.json`, and optional scripts.

`skill.json` defines path-safe learned skill metadata plus entrypoints. The `default` entrypoint should usually point at a repo-local script inside the skill package such as `run.ps1`, `run.sh`, or `run.cmd`. A `fallback` shell command is allowed when the skill needs a direct shell invocation.

By default, `knowl init` and `knowl upgrade` ensure `.knowl/` is ignored by git.

## Development

Install dependencies:

```bash
npm install
```

Run tests:

```bash
npm test
```

Build the CLI:

```bash
npm run build
```

Validate the npm package contents:

```bash
npm pack --dry-run
```

On Windows, if the default npm cache has permission issues, use a workspace-local cache:

```bash
npm pack --dry-run --cache .tmp\npm-cache
```

## Package

The npm package is published as `@dat999zx/knowl`. The installed binary is still named `knowl`.

The package payload is limited to:

- `dist`
- `README.md`
- `LICENSE`

`prepublishOnly` runs `npm run build` before publish.

## License

Knowl is licensed under the Apache License 2.0. See [LICENSE](LICENSE) for the full terms.
