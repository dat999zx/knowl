# Agent Change Notification Design

**Date:** 2026-07-25

**Status:** Approved. No open blockers.

## Problem

An agent receives a knowledge snapshot when its session begins and then acts on that
picture for the rest of the session. If a sibling agent stores something at minute five,
the first agent is never told. Nothing invalidates its snapshot and nothing gives it a
reason to re-query.

This is cache invalidation, not synchronization. Every agent in a project opens the same
database file (`initDb` resolves `<projectRoot>/.knowl/knowl.db`, `src/store/database.ts`),
`src/store/bootstrap.ts` sets `journal_mode = WAL` with `busy_timeout = 5000`, and SQLite
serializes concurrent writes. There are no replicas, no lost writes, and nothing to merge.
Merge semantics, tombstones, and replica identity belong to a separate track and are
explicit non-goals here.

## Findings that shaped the design

These were verified before designing, and several contradict the assumptions the work
started from. They are recorded because the design rests on them.

### Subagents fire `PostToolUse` but not `SessionStart`

Per the [hooks reference](https://code.claude.com/docs/en/hooks), hooks fire "on every tool
call inside the agentic loop," and subagent invocations carry an extra `agent_id` field:
"Present only when the hook fires inside a subagent call. Use this to distinguish subagent
hook calls from main-thread calls." `SessionStart`, by contrast, fires "once per session";
subagents get a separate `SubagentStart` event, which also supports `additionalContext` and
matches on agent type.

Confirmed empirically on 2026-07-25 by registering a raw-payload dump handler on
`SubagentStart`, `SubagentStop`, and `PostToolUse`, then spawning an `Explore` subagent
(Knowl item `14195a48267d4d84`):

| Observation | Result |
| --- | --- |
| `SubagentStart` fires | Yes — `session_id`, `transcript_path`, `cwd`, `prompt_id`, `agent_id`, `agent_type`, `hook_event_name` |
| `SubagentStop` fires | Yes — adds `permission_mode`, `effort`, `stop_hook_active`, `agent_transcript_path`, `last_assistant_message`, `background_tasks`, `session_crons` |
| Subagent `PostToolUse` | Carries `agent_id` and `agent_type` (observed `agent_id="adc54472c7d8cad78"`, `agent_type="Explore"`) |
| Main-session tool calls | Carry **no** `agent_id` |
| `session_id` | Shared — subagent events carry the parent's session id |
| Ordering | `SubagentStart` fires before the subagent's first `PostToolUse` |
| `tool_input` | Present on `PostToolUse` |

So the hook channel is available to subagents, it supplies exact per-agent identity, and
bootstrap is guaranteed to precede the first watermark check.

Two design choices rest directly on these payloads. Shared `session_id` is what makes "one
memory session, N bindings" correct rather than merely convenient. And the absence of
`agent_id` on main-session events is what keeps the non-agent binding path alive — see
[Agent-scoped binding key](#agent-scoped-binding-key).

### Subagents currently receive no bootstrap at all

`CLAUDE_HOOK_EVENTS` (`src/cli/agents/hook-config.ts:9`) registers `SessionStart`,
`PostToolUse`, `PostToolUseFailure`, `PreCompact`, `Stop`, `StopFailure`, and `SessionEnd`.
There is no `SubagentStart`. A spawned subagent therefore never receives bootstrap context.

The framing "an agent loads a snapshot at SessionStart and then acts on it" describes the
main thread only. For subagents the problem is not a stale snapshot but the absence of one.

### Every subagent currently shares the parent's binding row

`externalIds` (`src/cli/agents/host-hook.ts:62-75`) reads `session_id`, `conversation_id`,
or `thread_id`, and never `agent_id`. Claude's `PostToolUse` payload carries no `turn_id`,
so `bindingKey(input, 'turn')` (`src/store/host-lifecycle.ts:38-45`) resolves to
`(claude, projectRoot, session_id, '__turn__')` for the parent and for every sibling alike.

Two consequences: the drift counter is already shared today, so siblings increment and
reset one another's, and a watermark placed on that row would be shared the same way.
Per-agent identity is a prerequisite for this feature, not an enhancement to it.

### The MCP process cannot identify its caller

`startMcpServer` records the topology directly (`src/mcp/server.ts:88`): "one serve process
per connected host session." Every subagent shares that one connection, and no tool
argument carries a session or agent id. A watermark maintained inside the MCP server is
therefore process-scoped, so the first sibling to call `knowl_query` would absorb the
notification on behalf of all the others.

This — not "it only fires when the agent is least stale" — is what disqualifies an
MCP-response header as the universal floor.

### The database is already open and written on every tool event

Every accepted tool event calls `captureMemorySessionEvent` plus a counter `UPDATE`
(`src/store/host-lifecycle.ts:180-196`). "Checking on every `PostToolUse` opens the
database, which is expensive" does not describe a real trade-off: the connection is already
open and already writing. The measured ~950ms warm mean is process launch, paid whether or
not a watermark is read. One additional scalar `SELECT` is rounding error beside the insert
and update already occurring.

### The recurring reminder costs 302 characters, not 1695

`KNOWL_CLAUDE_CONTINUATION_REMINDER` is a single 302-character line
(`src/core/knowl-guidance.ts:104`), roughly 76 tokens. The 1695-character figure is
`KNOWL_CLAUDE_OPERATIONAL_CARD`, delivered once at `SessionStart`. The recurring per-event
budget a change payload must respect is therefore about five times tighter than assumed.

### Commit rows already contain everything the payload needs

`knowledge_commits` is `(id, message, changes, created_at)` with an implicit `rowid` that is
dense and monotonic (measured: 200 rows, `MAX(rowid) = 200`). `changes` is a JSON array of
`CommitChange`, and `compactCommitChanges` (`src/store/repository.ts:71-73`) is only
`stripProjectFields`, which recursively removes `projectId` and `project_id` and nothing
else. All call sites pass the full item as `after`. Titles and categories are therefore
available with no join to `knowledge_items` — verified, not assumed.

Commit counts per tool call were also confirmed. `knowl_ingest_atoms` calls
`createKnowledgeCommit` exactly once for a batch and **zero times when every atom deduped**
(`src/store/knowledge-writer.ts:251-257`). `knowl_decide` produces one commit with one or
two changes (`src/store/knowledge-actions.ts:57`). `knowl_update` produces one commit with
one change and a useful action vocabulary (`src/store/knowledge-actions.ts:131`).

### Why the reminder is not simply retargeted

The tempting reframe is to leave the trigger alone and upgrade the existing drift reminder's
payload. Half of that is right: the channel and the delivery slot are reused exactly.

Gating change news on the drift counter is wrong. Drift fires only after twelve consecutive
tool calls that ignored Knowl, and any Knowl call resets it. An agent that queries
diligently would therefore *never* be told that a sibling wrote something — and a parent
orchestrator whose subagents are doing the writing is precisely that agent. Staleness and
drift are independent signals. This design reuses the channel, upgrades the payload, and
gives change notification its own trigger.

## Section 1: identity and subagent bootstrap

### Agent-scoped binding key

`NormalizedHostHook` gains `agentId?: string`. `externalIds` reads `raw.agent_id` for
Claude, truncated to `MAX_STRING` like every other untrusted string.

`bindingKey` gains an agent dimension: when `agentId` is present, the turn-scope key becomes
`__agent__:<agentId>` rather than `__turn__` or a host turn id. Each subagent then owns its
own binding row, and therefore its own drift counter and its own watermark.

This deliberately reuses the `external_turn_id` column rather than adding
`external_agent_id` to the primary key, because a PK change means a SQLite table rebuild.
The column's real meaning is "sub-session scope key"; a comment saying so costs nothing.

This also fixes the live bug where siblings corrupt each other's drift counter.

**The non-agent branch stays.** The probe confirms main-session tool calls carry no
`agent_id`, so main-thread events continue to key on `__turn__` or a host turn id exactly as
today. What the probe *does* retire is any subagent-side fallback: a subagent event always
carries `agent_id`, so agent scope never needs to degrade to session or turn scope, and no
code should be written for that case.

**`agent_type` is used for one thing only: naming.** The binding title for an agent-scope row
becomes `Agent session (<agent_type>)`, which makes `host_session_bindings` and the memory
session event log readable when eight subagents are live — worth the zero marginal cost, since
the field is already in the payload.

Gating bootstrap by `agent_type` — skipping the snapshot for cheap read-only agents like
`Explore` — is explicitly rejected. Agent types are user- and plugin-definable, so any
built-in skip list is guesswork that silently blinds whichever agent the user most wants
informed, and "read-only" is a property of a prompt rather than of a type. If subagent
bootstrap cost later proves to matter, the honest lever is the context cap, which is already
a knob.

### Two new events

`SubagentStart` normalizes to a new event `agent-start`; `SubagentStop` to `agent-stop`.
Both are added to `CLAUDE_HOOK_EVENTS`.

`agent-start` binds the agent-scope row **to the parent's existing memory session**, found
via the session-scope binding, bootstrapping one if absent exactly as `turn-start` already
does. It returns bootstrap context as
`hookSpecificOutput: { hookEventName: 'SubagentStart', additionalContext }` and initializes
the watermark to the current head.

Reusing the parent's memory session is load-bearing. One memory session per host session
with N bindings leaves `finalizeMemorySession` and every stop path untouched; a session per
subagent would multiply sessions requiring finalization.

`agent-stop` closes only that agent-scope row and emits nothing. `SubagentStop` is permitted
by the host to block a subagent from stopping; this design never does.

`mergeNestedHookConfig`'s cleanup path must recognize the new entries so that re-running
`knowl init` neither duplicates them nor strips them.

### Subagent bootstrap payload

The operational card is **included** for subagents, and recent context is capped at half
`DEFAULT_CONTEXT_MAX_CHARS`.

Omitting the card would be cheaper, on the theory that MCP `instructions` reach subagents
because they share the parent's server connection. That theory is unverified. The asymmetry
decides it: if the assumption is wrong, omitting the card silently disables the workflow for
every subagent, while including it merely costs tokens. Halving recent context recovers most
of the cost, since fan-out multiplies whatever a subagent bootstrap costs.

### Verified payload contract

`SubagentStart` and `SubagentStop` both fire, and the implementation may rely on the payload
fields listed under
[Subagents fire `PostToolUse` but not `SessionStart`](#subagents-fire-posttooluse-but-not-sessionstart).
Concretely, `normalizeHostHook` may treat as guaranteed:

- `agent_id` on every subagent event, including `PostToolUse`, and absent on main-thread
  events. It is the binding-scope discriminator.
- `agent_type` on `SubagentStart` and subagent `PostToolUse`.
- `session_id` shared with the parent, which is how `agent-start` locates the parent memory
  session.
- `cwd`, so `requireProjectRoot` resolves without needing `workspace_roots`.
- `SubagentStart` arriving before the subagent's first `PostToolUse`, so a bootstrapped
  watermark always precedes the first change check.

Registration alone proves nothing about firing, which is why this was probed rather than
inferred; corroborating strings in the installed `claude.exe`
(`executeSubagentStartHooks` in the same dispatch table as `executeSessionStartHooks`, plus
`"SubagentStart hooks cancelled (control stream closed)"` and `hook_additional_context`) are
consistent with the probe but were not sufficient on their own.

Two related assumptions were checked and did not hold. The binary also contains
`executeStopFailureHooks`, and `PostToolUseFailure` sits in the same event-name table as
every other event, so `CLAUDE_HOOK_EVENTS` is not carrying dead names. And hook configuration
is **not** snapshotted at session start: the probe's own handlers were written to
`.claude/settings.local.json` and fired seconds later in the same session with no restart.
Hook-config changes therefore take effect live, which means the `mergeNestedHookConfig`
cleanup path must stay correct for a session already in flight, not merely for the next one.

## Section 2: watermark and trigger

### State

`host_session_bindings` gains `seen_commit_rowid INTEGER NOT NULL DEFAULT 0` — an
`ALTER TABLE ADD COLUMN`, no rebuild. It records the last commit this agent has been shown.
Head is `SELECT MAX(rowid) FROM knowledge_commits`.

`rowid` rather than `created_at` because it is an integer comparison, and rather than a new
explicit sequence column because it already exists and is already monotonic.

**Zero is a sentinel meaning uninitialized, not "has seen nothing."** Two paths produce it,
and both are ordinary rather than edge cases. `bindHostSession` creates rows outside
`agent-start` — `startBoundSession(projectId, input, 'turn')` runs on *every* session-event
(`src/store/host-lifecycle.ts:181`) and creates the row if it is missing — and the
`ALTER TABLE` leaves every pre-existing row at 0 on upgrade. Left untreated, the first tool
event on such a row would report the entire commit history as new.

Two measures, deliberately overlapping:

- `bindHostSession` writes the current head on insert and on its `ON CONFLICT DO UPDATE`
  reset path, alongside the existing `successful_tool_count = 0`.
- The trigger treats `seen == 0 && head > 0` as uninitialized: set `seen = head`, emit
  nothing. This covers migrated rows and anything the first measure misses.

The cost of the belt-and-braces is one branch; the cost of getting it wrong is a 200-item
card on an agent's first tool call.

### The rule

One rule covers every case: **always advance to head, and emit the foreign subset.**

Per accepted successful `session-event`, in order:

0. **Initialize.** If `seen == 0` and `head > 0`, set `seen = head` and emit nothing.
1. **Clamp.** If `seen > head`, set `seen = head` and emit nothing. Snapshot restore runs
   `INSERT INTO knowledge_commits SELECT *` (`src/store/snapshots.ts:82`), which reassigns
   rowids; garbage collection can also remove rows. Without the clamp, a restored database
   would spray phantom diffs at every live agent.
2. **Nothing new.** If `head == seen`, fall through to drift handling.
3. **Partition.** Load commits `WHERE rowid > seen ORDER BY rowid`. Split their changes into
   *mine* and *foreign* by the attribution rule below. Set `seen := head` unconditionally.
4. **Emit.** If the foreign subset is non-empty, emit the change card and reset drift to
   zero. Change news implies "go query," so the static drift nudge would be redundant.
5. **Drift.** Otherwise apply existing behaviour: a Knowl tool call resets drift; any other
   successful tool increments it, and `drift % 12 == 0` emits the existing static card.

### Attribution without a schema change

An agent must not be told about its own writes. Attribution by column is not achievable:
writes arrive through the MCP process, which has no caller identity to record.

Attribution by content is, and needs nothing new. The hook payload already carries
`tool_input` (`toolInput(raw)`, `src/cli/agents/host-hook.ts:111-113`), and commit changes
already carry `itemId` and `after.title`. A change is *mine* when either matches a key
extracted from my own `tool_input`:

- `id` and `supersedeId` against `itemId` — exact, covers `knowl_update`.
- `title` and `atoms[].title` against the change title — covers `knowl_store`,
  `knowl_decide`, and `knowl_ingest_atoms`.

Counting was rejected. A rule of "advance silently when `head - seen == 1`" fails in the
direction that matters: an all-duplicate `ingest_atoms` batch commits nothing, so a single
sibling commit meanwhile makes `head - seen == 1` and the notification is silently
swallowed — exactly the failure this feature exists to prevent.

Content attribution also removes a whole configuration surface. A read-versus-write tool
allowlist is unnecessary, because write tools are simply the case where the foreign subset
is smaller than the whole. Nothing has to be maintained when a Knowl tool is added later,
and there is no latent regression from a new read tool being misclassified.

Residual noise, accepted: `knowl_synthesize` and `knowl_ingest` produce commits whose titles
are not derivable from `tool_input`, so their own commits echo back to the agent that made
them. Both are rare and explicitly invoked, and the failure is visible rather than silent.

### Known blind spot

CLI usage (`knowl store` through Bash) reports `tool_name: "Bash"`, so `knowlTool` is false
and `tool_input` holds no titles. An agent's own CLI write therefore echoes back as foreign.
This is a pre-existing limitation of `knowlTool` detection, inherited rather than introduced,
and it fails in the visible direction.

## Section 3: payload

```
KNOWL CHANGED: 3 items since you last looked.
- decision: Agent change-notification comes before distributed sync work
- fact (updated): Export/import cannot sync; concurrency risk is staleness
- fact: Embedding-model tests depend on gitignored .knowl/models
Call knowl_query before relying on earlier memory in these areas.
```

Rules:

- At most five item lines; the header always carries the true total, and the overflow line
  is `- +N more`.
- Titles truncated to 90 characters.
- Category from the change payload; a non-`insert` action is rendered as a parenthesised
  verb. A superseded or updated item is a *correction*, which is the most important thing to
  surface.
- The same `itemId` touched more than once collapses to one line carrying the latest action.
- Title resolution falls back from `after.title` to `before.title`. `CommitChange` declares
  both `before` and `after` as optional and nullable (`src/core/types.ts:142-147`), and
  `delete` is in the action union. This is not hypothetical: `recordDecisionDirect` pushes
  supersede changes with only `before` (`src/store/knowledge-actions.ts:53`), so rows with
  no `after` already exist. A change with neither title is dropped from the card but still
  counted in the header.

Worst case is roughly 610 characters, about 150 tokens. The nothing-changed case is zero
bytes.

Titles only, never content. A title is the routing information the agent needs — *do I care
about this?* — and content is what `knowl_query` is for.

## Section 4: host coverage and budget

### Precedence

The change card replaces the static drift card, and emitting it resets drift. At most one
card per tool event, never two. Steady-state budget delta is zero, because nothing is
emitted when nothing changed; roughly 150 tokens are spent only on the events where memory
genuinely moved.

### Hosts

| Host | Behaviour in v1 |
| --- | --- |
| `claude` | Full: `SubagentStart` bootstrap plus change cards on `PostToolUse`. |
| `codex` | Watermark maintained, card not emitted. `PostToolUse` is registered and `hostContextOutput` already emits the Claude-shaped envelope, but Codex's acceptance of `additionalContext` there is unverified and it has no subagent concept in the registered set. One line to enable once verified. |
| `cursor` | No card. Its `hostContextOutput` shape carries `sessionStart: true`, which reads as session-start-specific. |
| `generic` | No card. It has no host-native protocol and deliberately emits no host output (`src/store/host-lifecycle.ts:63-66`). |

### Degraded path for `generic`

`HostLifecycleResult` gains `changes?: { count: number; items: { category, title, action }[] }`.
Generic integrations already consume that JSON, so this adds no protocol. It is populated
for **all** hosts, which also keeps `knowl agent-hook <host> <event> --json` uniformly
inspectable and testable.

### Constraints honoured

- **No daemon.** Nothing here launches `knowl serve` or any background process. Every check
  happens inside the existing short-lived `knowl agent-hook` invocation.
- **No feedback loop.** Output is still confined to `additionalContext` on events that
  already carry it. The card is emitted only when the watermark actually moved, and moving
  it is idempotent, so the same change is never delivered twice to the same agent.
- **Latency.** One scalar `SELECT` is added to a connection that is already open and already
  performing an insert and an update.

## Testing

The trigger is a pure decision over `(head, seen, tool_input, commits, drift)` and should be
table-driven:

- Each ordered branch: initialize, clamp, nothing-new, foreign-only, mine-only, mixed, and
  drift.
- Clamp behaviour when `seen > head`.
- A newly created binding row, and a row migrated with `seen == 0` against a non-empty commit
  history, must both emit nothing and adopt head.
- Attribution by `itemId` for `knowl_update`, by title for `store`, `decide`, and
  `ingest_atoms`; the all-duplicate `ingest_atoms` case that commits nothing while a sibling
  commit is pending must still notify.
- Card construction: the five-line cap and overflow count, 90-character truncation, action
  verbs, `itemId` dedup to the latest action, `before.title` fallback, and a change with
  neither title being dropped from lines but counted in the header.
- Agent-scope key derivation from `agent_id`, including the main-thread case where it is
  absent and the key must remain `__turn__`.
- `agent_type` reaching the binding title as `Agent session (<agent_type>)`, and a subagent
  event missing `agent_type` still binding successfully.
- `agent-start` binding to the parent's shared `session_id` memory session rather than
  creating a new one, and `agent-stop` closing only its own row.
- `mergeNestedHookConfig` remaining idempotent across the two new event registrations, since
  hook config takes effect live rather than at next session start.
- Sibling isolation: two agent-scope rows must maintain independent watermarks and drift
  counters.

## Non-goals

Merge semantics, tombstones, replica identity, and any lineage or causality model. A commit
attribution column. Relevance filtering by `affected_paths` or by the session's earlier
queries — the titles-only payload lets the agent filter for free, and server-side filtering
needs coverage that many atoms lack. Any daemon, watcher, or background process. Cross-host
push. MCP-response headers for hosts running the MCP server with no hooks installed, which
is a real but separate population and needs its own spec.
