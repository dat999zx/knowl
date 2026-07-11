# Project-Local Agent Hooks Design

## Goal

Make Knowl capture useful project memory automatically in Codex CLI and Claude Code without depending on the model to follow `AGENTS.md`.

## Scope

`knowl init codex claude` installs verified project-local lifecycle hooks. Existing projects gain the integration by rerunning the same additive, idempotent command. Global hooks, raw transcript storage, Cursor hooks, Claude Desktop hooks, and cloud synchronization are out of scope.

## Architecture

Add one host-neutral CLI boundary:

```text
gpt-5.6-sol hook JSON on stdin
        -> knowl agent-hook <host> <event>
        -> normalize safe bounded fields
        -> existing session/event/finalizer services
        -> scratch events + durable promoted atoms
```

Host adapters own only configuration and verification. The translator owns host payload parsing. Existing storage services continue to own validation, deduplication, evidence, promotion, TTL, and crash recovery.

## Project-local configuration

Codex uses `<repo>/.codex/hooks.json`. Claude Code uses `<repo>/.claude/settings.local.json`. Knowl merges only its own hook entries, preserves unrelated settings, creates a backup before changing an existing file, and does not duplicate entries on repeated initialization.

Hook commands use the platform executable name (`knowl.cmd` on Windows, `knowl` elsewhere) and never embed credentials or project content.

## Event mapping

Both hosts use turn-bounded Knowl sessions so durable candidates are finalized regularly rather than waiting for a process-level shutdown that may never arrive.

| Host event | Knowl behavior |
| --- | --- |
| `SessionStart` | Recover abandoned sessions; bootstrap compact current context |
| `UserPromptSubmit` | Start or reuse the current turn session |
| `PostToolUse` | Capture allowlisted command, test, git, changed-path, or decision metadata |
| `PostToolUseFailure` | Capture bounded error metadata without raw output |
| `PreCompact` | Store a bounded checkpoint before context compression |
| `Stop` | Finish the turn session and promote validated candidates |
| `StopFailure` | Finish as failed and promote only verified durable candidates |
| `SessionEnd` | Claude-only cleanup/recovery; no transcript ingestion |

Unsupported or absent event fields are ignored safely. Event delivery is best effort: a malformed event reports a concise error, while an event for an already-finalized session returns event-loss without breaking the agent host.

## Correlation

The translator derives a stable external correlation key from the host name, project root, host session id, and turn id when available. A small project-local mapping resolves that key to the internal Knowl session. Claude events without a turn id rotate the mapping after each `Stop`, so the next prompt creates a new turn session.

## Context injection

Session-start and prompt hooks may return only the existing bounded context-bootstrap output supported by the host hook protocol. If a host cannot consume hook output as context, capture still runs and MCP remains the retrieval path. Knowl never appends generated context to `AGENTS.md`.

## Security

Every payload passes through the existing deterministic secret validator. The translator keeps only allowlisted fields and size limits. It never reads `transcript_path`, stores full prompts, stores complete tool inputs/outputs, or records environment variables. Sensitive paths and binary content remain excluded by existing evidence collection.

## Setup and diagnostics

`knowl init codex claude` configures MCP and lifecycle hooks separately, then reports each result. `knowl doctor` verifies exact hook entries and reports supported, degraded, or broken state. A trusted project and host restart/new session may be required before project-local hooks run.

## Compatibility

Initialization remains additive and preserves the existing `.knowl/knowl.db`. No export/import or database reset is required. Hosts without verified hooks retain the existing MCP and manual work-loop fallback.

## Testing

Fixture-driven adapter tests prove additive, idempotent configuration and exact verification for both hosts. Translator tests feed real documented payload shapes and verify RED/GREEN behavior for start, tool success/failure, compaction, stop, crash recovery, secret rejection, bounded storage, and duplicate suppression. CLI integration tests cover old-project upgrade and doctor reporting. The full serial test suite, build, and diff check are the completion gate.
