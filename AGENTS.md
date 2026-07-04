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

- At the start of a new project-specific session, call `knowl_recent` first to load recent active knowledge and knowledge commits before inspecting files or editing code.
- After `knowl_recent`, use `knowl_query` for specific questions. Use 2-6 concise search keywords from the user's question, not the whole question text.
- Do not use `knowl_ask` for MCP first-pass lookup. MCP agents already have a model; use `knowl_recent` and `knowl_query` for retrieval.
- Omit category filters unless you are certain; an over-specific category can hide the correct memory item.
- If the Knowl MCP tools are unavailable, stop and tell the user that Knowl MCP is not configured instead of silently inspecting the repository.
- `Auth: Unsupported` on a local stdio MCP server is normal and does not mean Knowl is unavailable when `knowl_query` is listed.
- Do not inspect repository files before this Knowl lookup. If Knowl has a relevant active answer, use it and cite that it came from Knowl.
- If `knowl_query` returns a relevant active item, answer from Knowl immediately.
- Do not inspect repository files just to re-verify known facts already found in Knowl.
- Only inspect repository files when Knowl misses, conflicts, looks stale or low-confidence, or the user asks for source verification.
- Only use `knowl_state` for broad project-memory summaries, status checks, or when the user asks for the full current state.
- During work, keep Knowl current. If new findings contradict or replace existing memory, use `knowl_update` to correct stale or superseded items instead of adding duplicates.
- When the user confirms a durable fact, decision, constraint, architecture detail, current state, or reusable skill, save it to Knowl using `knowl_store`, `knowl_decide`, or `knowl_ingest_atoms`.
- After discovering and verifying durable project knowledge from repository files, store it in Knowl using `knowl_store` or `knowl_ingest_atoms` before giving the final answer, but only when the initial `knowl_query` did not already return the same knowledge.
- Before the final answer, check whether the work produced durable knowledge: implemented feature summaries, setup steps, architecture changes, important commands, decisions, constraints, recurring bugs, gotchas, and verified project facts. Store useful outcomes in Knowl before responding.
- Store durable knowledge as concise structured atoms, not raw chat transcripts. Use raw conversation only as optional source/evidence when it is useful.
- Do not store temporary debugging noise, failed attempts, secrets, credentials, or speculative ideas unless the user explicitly says they are durable project knowledge.
- Prefer current active Knowl state over stale conversation memory when answering questions about this project.
<!-- /KNOWL_PROJECT_MEMORY -->
