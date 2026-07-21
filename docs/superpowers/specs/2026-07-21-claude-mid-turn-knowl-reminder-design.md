# Claude Mid-Turn Knowl Reminder Design

**Date:** 2026-07-21

**Status:** Approved

## Problem

Claude receives the complete Knowl operational card at `UserPromptSubmit`, but a single response can execute many tools before another user prompt occurs. During a long response, the prompt-time guidance can lose salience and Claude may stop querying or updating Knowl when it changes project areas.

The existing `PostToolUse` lifecycle hook captures successful tool activity but intentionally emits no model context. A reminder on every tool would be noisy and would repeatedly spend context tokens. A reminder at `Stop` would arrive after the response has already finished.

## Selected behavior

Keep the full operational card on `UserPromptSubmit`. During a Claude turn, count accepted successful `PostToolUse` events and inject a compact continuation reminder after every eighth event.

The continuation reminder says only what Claude needs to recover the workflow:

- use relevant active Knowl memory;
- query with 2-6 keywords before files or commands when entering a new project area;
- store or update verified durable findings;
- do not start the manual task loop while Claude lifecycle hooks are active.

It does not repeat the complete 24-tool routing card. The existing full card and `KNOWL.md` remain the detailed reference.

## Architecture

The existing `knowl agent-hook claude PostToolUse --json` process already normalizes and captures the tool event. After an accepted, non-debounced capture, it atomically increments a counter on the active per-turn row in `host_session_bindings`.

When the count is divisible by eight, `handleHostLifecycleEvent` returns Claude-native JSON:

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PostToolUse",
    "additionalContext": "<compact continuation reminder>"
  }
}
```

The command prints that response through the existing `hostOutput` path. Other successful tool events stay quiet.

The counter is reset to zero whenever a turn binding is created or rebound. A normal Claude `Stop` closes that binding, so the next response starts a fresh count. If a response is interrupted and Claude does not emit `Stop`, retaining the count is safe: the next response may receive a reminder sooner, but it cannot lose a required reminder.

## Storage migration

Add `successful_tool_count INTEGER NOT NULL DEFAULT 0` to `host_session_bindings` in both the current schema and the bootstrap SQL. Existing databases receive the column through an idempotent bootstrap check.

The increment uses one SQL `UPDATE ... RETURNING` operation so concurrent tool completions cannot lose increments. It targets the active binding for the current host, project root, external session, and external turn.

## Boundaries

- Claude only; no unverified response formats are added for other hosts.
- Count successful `PostToolUse` only. `PostToolUseFailure`, `PreCompact`, `Stop`, and debounced duplicates do not increment it.
- Do not query Knowl automatically.
- Do not read or retain user prompt content.
- Do not add another hook entry or process.
- Do not inject the full prompt-time card after tools.
- Capture and promotion behavior remains unchanged.

## Verification

- Unit tests prove the binding counter starts at zero, increments atomically, and resets when a binding is reused for a new turn.
- Lifecycle tests prove Claude is quiet for events 1-7, emits the exact compact reminder on event 8, and is quiet again on event 9.
- Lifecycle tests prove failures and debounced duplicates do not advance the reminder schedule.
- CLI tests prove the eighth real `agent-hook claude PostToolUse --json` invocation emits the Claude `PostToolUse` envelope.
- Schema migration tests prove an older `host_session_bindings` table receives the new column.
- README documents the prompt-time full card and throttled mid-turn reminder separately.

