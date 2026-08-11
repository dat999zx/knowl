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

1. For every project-specific request, call `knowl_query` before repository files or commands, using the words that name the subject: another on-subject term retrieves better, an off-subject one retrieves worse, so do not pad the query and do not trim a real term to shorten it.
2. Skip a new query only when directly relevant active lifecycle context, a same-request query, or manual `knowl_task_start` relevant memory already answers it.
3. Use a relevant active hit immediately. Inspect files only after a miss, conflict, stale/low-confidence memory, or explicit verification request.
4. Query again before switching to a distinct subtask or project area, and before choosing how to build something new — existing tooling and pipelines are project knowledge, and in a linked workspace they often live in a sibling repo, so leave method queries unscoped.
5. Store or update durable knowledge during work and before the final answer — verified findings, stated intent (goals, plans, direction the user voiced) stored as goals with user_stated provenance even while unsettled, and resolved diagnoses stored as skills when the cause will recur (an environment quirk, a config trap — not a typo). The test: could a fresh session recover this from memory alone? Never store raw transcripts, secrets, or transient debugging noise.
6. If Knowl MCP tools are unavailable, stop and tell the user instead of silently bypassing Knowl.

### Lifecycle modes

- **Automatic host lifecycle:** verified hooks own bootstrap, capture, checkpoints, and finalization. Never call `knowl_task_start`, `knowl_task_checkpoint`, `knowl_task_finish`, or `knowl_session_finish` for that hook-owned session.
- **Manual work loop:** without verified hooks, use `knowl task run` for one bounded command. For resumable work, start once, checkpoint meaningful milestones/blockers with the returned task ID, and finish exactly once after verification. The start result satisfies the initial focused lookup.

Casual conversation, a single memory lookup, and trivial non-resumable work do not create a manual task loop.

### Complete MCP tool routing

| Group | Tools | Routing |
| --- | --- | --- |
| Focused retrieval | `knowl_query` | Default first call for a specific project request and again when switching areas. Use the words that name the subject, without padding, and omit category unless certain. |
| Context views | `knowl_recent`, `knowl_state`, `knowl_context` | Use recent only without lifecycle bootstrap or for an explicit refresh; state for broad status; context for an explicitly token-budgeted pack. |
| Manual work loop | `knowl_task_start`, `knowl_task_checkpoint`, `knowl_task_finish` | Use only without verified lifecycle hooks: start once, checkpoint meaningful milestones or blockers, and finish once after verification. |
| Durable writes | `knowl_store`, `knowl_ingest_atoms`, `knowl_decide`, `knowl_update` | Store one verified atom, batch verified atoms, record a confirmed decision, or correct/supersede stale memory. |
| History and quality | `knowl_timeline`, `knowl_evidence_list`, `knowl_conflicts`, `knowl_feedback` | Inspect history, evidence, or conflicts when needed; record feedback only after actual use, rejection, or correction. |
| Learned skills | `knowl_skill_list`, `knowl_skill_read`, `knowl_skill_run`, `knowl_skill_create` | Discover and read a matching skill before running a trusted entrypoint; create only when explicitly requested. |
| Special and maintenance | `knowl_ingest`, `knowl_synthesize`, `knowl_session_finish`, `knowl_gc_preview`, `knowl_gc_apply` | Raw-source ingest requires an explicit request and configured AI; never send the current conversation silently. Synthesis is explicitly scoped and never automatic. Session finish is only for an explicitly owned manual memory-session ID, never a hook session. Preview GC first; apply only after explicit approval. |
| Session handoff | `knowl_handoff` | Use when parking a workstream before ending a session. The next session in this project receives it once, then it is archived. One baton per project -- parking again replaces it. Durable facts still belong in knowl_store. |
| Parked work | `knowl_park`, `knowl_resume` | Park work the user means to come back to: knowl_park mints a short key and returns a paste-ready line to hand them verbatim, since a key reworded is a key lost. knowl_resume takes that key in any later session, from any directory, and returns the brief. Unlike the handoff baton -- which the next session in this project consumes once -- a key is held by the user, is not spent by resuming, and works any number of sessions later. Call knowl_resume as soon as a user supplies a key; with no key it lists what is parked here. |

### Linked repositories

- When this repo is in a workspace, read the **shape** of a `knowl_query` result first. A bare JSON array means every row belongs to this repo. An object keyed by repo name means at least one row does **not** — and a fact from another repo describes **that** repo unless it says otherwise, so verify before applying it here.
- An empty array under this repo's own key means this repo holds nothing on the subject. Read the other keys as background, not as an answer, and treat it as a miss if what they say does not transfer.
- Narrow with `scope: "local"` (this repo alone, always a bare array) or `scope: "workspace"` (every sharing repo, always keyed). `repos: ["<name>"]` restricts to named repos and matches the repo that owns an item; it wins if both are given.
- Method questions — "how do we generate X", "is there a script for Y" — belong to the whole workspace: query them unscoped before building new tooling; a sibling repo's pipeline answers them more often than this repo's files do.
- A `WORKSPACE:` notice names linked repos that matched but were not shown, with counts. Re-query with `repos` to read them.
- Whether a new write is shared is this repo's recorded default, not a fixed rule: joining a linked workspace sets it to workspace visibility, while `--default-visibility repo` keeps writes private. `knowl workspace set` with no flags prints the current value.
- Knowledge already written privately stays private until someone runs `knowl workspace promote`. Only the owning repo can promote, update, or retire its own items.

### Safety and freshness

- Correct stale or contradicted memory with `knowl_update` instead of adding a duplicate.
- All writes are secret-validated. Never retry rejected secret material in altered form.
- `Auth: Unsupported` is normal for a local stdio MCP server when the focused retrieval tool is listed.
<!-- /KNOWL_PROJECT_MEMORY -->
