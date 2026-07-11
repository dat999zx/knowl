# Knowl

A local-first knowledge operating system for AI agents.

Knowl gives an AI coding agent durable project memory without sending that memory to a hosted service by default. It stores structured knowledge atoms in a per-project SQLite database under `.knowl/`, exposes that memory through a CLI, and provides an MCP server so tools such as Codex, Cursor, or Claude Desktop can retrieve and update project context while they work.

Knowl is designed for durable engineering context: decisions, architecture, goals, constraints, facts, current state, and reusable skills. It is not meant to archive raw chat logs.

## What It Does

- Stores project memory locally in `.knowl/knowl.db`.
- Organizes memory into `fact`, `decision`, `goal`, `constraint`, `architecture`, `state`, and `skill` categories.
- Provides deterministic MCP tools for storing and querying structured knowledge without a Knowl-side AI provider.
- Generates or refreshes `AGENTS.md` guidance so agents know to query Knowl before inspecting files.
- Records work-loop starts, checkpoints, and finishes as structured state atoms with knowledge commits.
- Wraps shell commands with an automatic work loop so agents query memory before execution and write back success or failure state.
- Stores learned executable skill packages under `.knowl/skills/<name>/` with `SKILL.md`, `skill.json`, and optional scripts.
- Exposes stable MCP and CLI skill bridges so new learned skills work without adding one new tool per skill.
- Detects supported agents and installs MCP registrations from `knowl init`.
- Adds `.knowl/` to `.gitignore` during project initialization.
- Supports optional AI-backed CLI commands for raw text ingestion and natural-language answers.
- Supports BM25 plus default-on local vector search with a lazy first-use model download.
- Tracks memory changes as knowledge commits so project memory has history.

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

This creates `.knowl/config.json`, bootstraps `.knowl/knowl.db`, installs Knowl guidance into `AGENTS.md`, and ensures `.knowl/` is ignored by git.

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
knowl init codex claude
```

Project-local MCP config is preferred. Global-only clients require confirmation unless `--yes` is supplied.

Wrap work with an automatic Knowl work loop:

```bash
knowl task run "Implement search UI" --query "search retrieval" -- npm test
```

Or record manual checkpoints:

```bash
knowl task start "Implement search UI" --query "search retrieval"
knowl task checkpoint <task-id> "Added search UI tests"
knowl task finish <task-id> "Verified search UI implementation"
```

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

1. Call `knowl_recent` at the start of a project-specific session.
2. Use `knowl_query` for specific questions, with 2-6 concise keywords.
3. Use `knowl_state` only for broad full-state summaries.
4. For multi-step tasks, query Knowl again before each new subtask or when switching areas.
5. Store durable new facts, decisions, constraints, architecture notes, state, and skills immediately after each completed subtask or verified finding with `knowl_store`, `knowl_decide`, or `knowl_ingest_atoms`.
6. Use `knowl_update` as soon as you find stale or contradicted memory.

Available MCP tools:

| Tool | Purpose |
| --- | --- |
| `knowl_recent` | Return recent active knowledge and recent knowledge commits for session startup. |
| `knowl_query` | Search active or historical project memory. Defaults to active items and returns up to three hits. |
| `knowl_state` | Return the full active project memory as markdown. |
| `knowl_store` | Store one structured knowledge atom without AI configuration. |
| `knowl_ingest_atoms` | Store a batch of structured knowledge atoms without AI configuration. |
| `knowl_decide` | Record a decision with required reasoning. |
| `knowl_update` | Update item content, title, reasoning, or status. |
| `knowl_task_start` | Start a manual work loop, query relevant memory, and store active task state. |
| `knowl_task_checkpoint` | Store durable progress during a work loop. |
| `knowl_task_finish` | Store durable completion state for a work loop. |
| `knowl_skill_list` | List learned file-backed skill packages from `.knowl/skills`. |
| `knowl_skill_read` | Read one learned skill package (`skill.json` and `SKILL.md`). |
| `knowl_skill_create` | Create a learned skill package and index it as a `skill` knowledge item. |
| `knowl_skill_run` | Auto-run a learned skill entrypoint, preferring repo-local scripts with optional shell fallback. |
| `knowl_ingest` | Run raw text through Knowl's AI-backed extraction pipeline. Requires explicit AI config. |
| `knowl_gc_preview` | Preview duplicate, stale, or cold memory cleanup recommendations. |
| `knowl_gc_apply` | Apply garbage collection transactionally and record a knowledge commit. |

Readable MCP resources:

| Resource | Purpose |
| --- | --- |
| `knowl://recent` | Compact recent session context. |
| `knowl://brain` | Full active project brain state. |
| `knowl://category/<name>` | Active items for a category such as `decision`, `architecture`, or `state`. This URI form is readable even though only `knowl://recent` and `knowl://brain` are listed during resource discovery. |

## Agent Setup

`knowl init` detects Codex, Claude Code, Cursor, and Claude Desktop, then presents a multi-select UI. Re-run it at any time to add another agent or repair a stale Knowl registration. It preserves unrelated MCP servers, writes a backup before changing an existing agent config, and does not duplicate correct entries.

If an MCP client shows `Auth: Unsupported` for this local stdio server, that is expected and does not mean Knowl is unavailable.

## CLI Commands

| Command | Description |
| --- | --- |
| `knowl init [agents...]` | Initialize or upgrade this project, then interactively select detected agents. Pass `codex`, `claude`, `cursor`, or `claude-desktop` to configure explicitly. |
| `knowl upgrade` | Upgrade an existing Knowl repository with current defaults and agent files. |
| `knowl status` | Show repository path, item counts, category counts, AI config status, and recent knowledge commits. |
| `knowl doctor` | Check whether the project is ready for agent memory usage. |
| `knowl audit` | Read-only validation, reference, JSON, status, and FTS integrity audit. |
| `knowl snapshot create` | Create a timestamped SQLite snapshot plus SHA-256 manifest. |
| `knowl snapshot restore <path> --confirm` | Restore a snapshot transactionally; creates a pre-restore snapshot first. |
| `knowl state` | Print the full active hierarchical project memory. |
| `knowl task start <title>` | Start a work loop, query relevant memory, and store active task state. |
| `knowl task checkpoint <task-id> <summary>` | Store durable progress for an active work loop. |
| `knowl task finish <task-id> <summary>` | Store durable completion state for a work loop. |
| `knowl task run <title> -- <command...>` | Start a work loop, run a command, then finish on success or checkpoint on failure with the child exit code. |
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
