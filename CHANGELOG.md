# Changelog

Notable changes to `@dat999zx/knowl`. Versions before 2.1.0 predate this file; see the
[git tags](https://github.com/dat999zx/knowl/tags) for that history.

## 2.1.0 — 2026-07-25

Subagents get project memory, and any agent is told when memory changed underneath it.

### Added

- **Subagent bootstrap.** `SubagentStart` and `SubagentStop` are registered for Claude Code.
  A spawned subagent receives its own memory snapshot, capped at half the normal context
  budget because fan-out multiplies whatever a subagent costs. Previously a subagent
  received nothing at all: `SessionStart` fires once per session and never reaches one.
- **Per-agent binding scope.** Subagent hook events carry an `agent_id`, now used as the
  session-binding scope, so every subagent has an independent change watermark and an
  independent continuation-reminder counter.
- **Change notification.** Each accepted tool event compares a per-agent watermark against
  the latest knowledge commit and, when it has moved, returns a compact titles-only card
  naming what changed. It costs nothing when nothing changed, replaces the continuation
  reminder when both would fire rather than adding to it, and never reports an agent's own
  writes back to it.
- **`changes` in host-neutral hook output.** `knowl agent-hook <host> <event> --json` now
  carries the same change summary as structured JSON, so hosts with no native protocol can
  consume it without one.
- **Host profiles.** Each supported host is described by one file in `src/cli/agents/hosts/`
  declaring its identity keys, event map, and context envelopes, replacing host conditionals
  spread across six modules. Capability is expressed by return value, so support cannot be
  claimed for a channel that delivers nothing. Adding a host is adding a file.
- **Change notification beyond Claude Code.** Codex CLI receives subagent bootstrap and change
  cards through the same `hookSpecificOutput.additionalContext` channel, verified with a live
  Codex model run. Cursor is sent `additional_context`. Hosts with no hook channel continue to
  read `changes` from the host-neutral JSON result.

### Fixed

- **`knowl_query` with `asOf` crashed** with `queryKnowledgeBase is not defined`. The
  historical-query branch of the MCP server called a function it never imported, so a
  documented parameter of the most-used tool failed at runtime.
- **`knowl_ingest` always reported zero counts.** It read `insertedIds`/`updatedIds`/
  `supersededIds` off the pipeline result, which carries them on `mergeResult`, so every
  ingest returned `{inserted: 0, updated: 0, superseded: 0}` regardless of what it stored.
- **Sibling subagents corrupted each other's continuation reminder.** All subagents shared
  the parent's binding row, so their tool calls incremented and reset one counter between
  them.
- **Subagent identity was stripped from hook payloads.** The lifecycle payload allowlist
  dropped `agent_id` and `agent_type` before normalization, and dropped the tool arguments
  needed to recognise an agent's own writes.
- **Claude Desktop was routed through Cursor's hook event map.** The event-mapping ternary
  checked only Codex and Claude by name, so every other host fell through to Cursor's
  camelCase events. Each host now declares its own map, and a conformance suite asserts it.

### Upgrading

- **Rerun `knowl init` for your hosts once.** A configuration written by an earlier version
  has no `SubagentStart`/`SubagentStop` handlers, and subagents keep starting with no memory
  until you rerun it. `knowl doctor` reports the configuration as stale in the meantime.
- **Codex users must trust the hooks.** Codex does not execute project hooks until they are
  trusted once, interactively when prompted or with `--dangerously-bypass-hook-trust` in
  automation. Until then the hooks silently do not run.
- **No database action required.** The new `seen_commit_rowid` column is applied
  automatically the next time any Knowl process opens the database.
