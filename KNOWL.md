<!-- KNOWL_PROJECT_MEMORY -->
## Knowl Project Memory

### Required workflow

1. For every project-specific request, call `knowl_query` with 2-6 concise keywords before repository files or commands.
2. Skip a new query only when directly relevant active lifecycle context, a same-request query, or manual `knowl_task_start` relevant memory already answers it.
3. Use a relevant active hit immediately. Inspect files only after a miss, conflict, stale/low-confidence memory, or explicit verification request.
4. Query again before switching to a distinct subtask or project area.
5. Store or update verified durable findings during work and before the final answer; never store raw transcripts, secrets, or debugging noise.
6. If Knowl MCP tools are unavailable, stop and tell the user instead of silently bypassing Knowl.

### Lifecycle modes

- **Automatic host lifecycle:** verified hooks own bootstrap, capture, checkpoints, and finalization. Never call `knowl_task_start`, `knowl_task_checkpoint`, `knowl_task_finish`, or `knowl_session_finish` for that hook-owned session.
- **Manual work loop:** without verified hooks, use `knowl task run` for one bounded command. For resumable work, start once, checkpoint meaningful milestones/blockers with the returned task ID, and finish exactly once after verification. The start result satisfies the initial focused lookup.

Casual conversation, a single memory lookup, and trivial non-resumable work do not create a manual task loop.

### Complete MCP tool routing

| Group | Tools | Routing |
| --- | --- | --- |
| Focused retrieval | `knowl_query` | Default first call for a specific project request and again when switching areas. Use 2-6 keywords and omit category unless certain. |
| Context views | `knowl_recent`, `knowl_state`, `knowl_context` | Use recent only without lifecycle bootstrap or for an explicit refresh; state for broad status; context for an explicitly token-budgeted pack. |
| Manual work loop | `knowl_task_start`, `knowl_task_checkpoint`, `knowl_task_finish` | Use only without verified lifecycle hooks: start once, checkpoint meaningful milestones or blockers, and finish once after verification. |
| Durable writes | `knowl_store`, `knowl_ingest_atoms`, `knowl_decide`, `knowl_update` | Store one verified atom, batch verified atoms, record a confirmed decision, or correct/supersede stale memory. |
| History and quality | `knowl_timeline`, `knowl_evidence_list`, `knowl_conflicts`, `knowl_feedback` | Inspect history, evidence, or conflicts when needed; record feedback only after actual use, rejection, or correction. |
| Learned skills | `knowl_skill_list`, `knowl_skill_read`, `knowl_skill_run`, `knowl_skill_create` | Discover and read a matching skill before running a trusted entrypoint; create only when explicitly requested. |
| Special and maintenance | `knowl_ingest`, `knowl_synthesize`, `knowl_session_finish`, `knowl_gc_preview`, `knowl_gc_apply` | Raw-source ingest requires an explicit request and configured AI; never send the current conversation silently. Synthesis is explicitly scoped and never automatic. Session finish is only for an explicitly owned manual memory-session ID, never a hook session. Preview GC first; apply only after explicit approval. |
| Session handoff | `knowl_handoff` | Use when parking a workstream before ending a session. The next session in this project receives it once, then it is archived. One baton per project -- parking again replaces it. Durable facts still belong in knowl_store. |
| Parked work | `knowl_park`, `knowl_resume` | Park work the user means to come back to: knowl_park mints a short key and returns a paste-ready line to hand them verbatim, since a key reworded is a key lost. knowl_resume takes that key in any later session, from any directory, and returns the brief. Unlike the handoff baton -- which the next session in this project consumes once -- a key is held by the user, is not spent by resuming, and works any number of sessions later. Call knowl_resume as soon as a user supplies a key; with no key it lists what is parked here. |

### Linked repositories

- When this repo is in a workspace, `knowl_query` results carry a `repo` field naming the repo that produced each item. A fact from another repo describes **that** repo unless it says otherwise; do not apply it here without checking.
- Restrict a search to one repo with `knowl_query` `repos: ["<name>"]`. It matches the repo that owns an item.
- Knowledge stays private to its repo until someone runs `knowl workspace promote`. Only the owning repo can promote, update, or retire its own items.

### Safety and freshness

- Correct stale or contradicted memory with `knowl_update` instead of adding a duplicate.
- All writes are secret-validated. Never retry rejected secret material in altered form.
- `Auth: Unsupported` is normal for a local stdio MCP server when the focused retrieval tool is listed.
<!-- /KNOWL_PROJECT_MEMORY -->
