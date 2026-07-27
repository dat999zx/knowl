# AGENTS.md

Behavioral guidelines to reduce common LLM coding mistakes. Merge with project-specific instructions as needed.

**Tradeoff:** These guidelines bias toward caution over speed. For trivial tasks, use judgment.

## 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

## 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

## 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

## 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:
```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

---

**These guidelines are working if:** fewer unnecessary changes in diffs, fewer rewrites due to overcomplication, and clarifying questions come before implementation rather than after mistakes.

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

### Linked repositories

- When this repo is in a workspace, `knowl_query` results carry a `repo` field naming the repo that produced each item. A fact from another repo describes **that** repo unless it says otherwise; do not apply it here without checking.
- Restrict a search to one repo with `knowl_query` `repos: ["<name>"]`. It matches the repo that owns an item.
- Knowledge stays private to its repo until someone runs `knowl workspace promote`. Only the owning repo can promote, update, or retire its own items.

### Safety and freshness

- Correct stale or contradicted memory with `knowl_update` instead of adding a duplicate.
- All writes are secret-validated. Never retry rejected secret material in altered form.
- `Auth: Unsupported` is normal for a local stdio MCP server when the focused retrieval tool is listed.
<!-- /KNOWL_PROJECT_MEMORY -->
