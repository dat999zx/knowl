# File-Backed Learned Skills Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build file-backed learned skills in `.knowl/skills/<name>/` with stable CLI/MCP tools that can list, read, create, and auto-run skills.

**Architecture:** Add a focused `src/skills/registry.ts` module for package IO, validation, and execution. Keep MCP tool names stable (`knowl_skill_list`, `knowl_skill_read`, `knowl_skill_create`, `knowl_skill_run`) so old sessions can use newly created skills through dynamic registry reads.

**Tech Stack:** TypeScript, Node.js fs/path/child_process, Commander CLI, existing MCP server, existing SQLite knowledge item index.

---

### Task 1: Skill Package Registry

**Files:**
- Create: `src/skills/registry.ts`
- Test: `tests/skills/registry.test.ts`

- [ ] **Step 1: Write failing tests**

Cover path-safe names, package creation, list/read, script execution, fallback shell execution, and path traversal rejection.

- [ ] **Step 2: Run registry tests**

Run: `npm.cmd run test -- tests/skills/registry.test.ts`
Expected: FAIL because `src/skills/registry.ts` does not exist.

- [ ] **Step 3: Implement registry**

Implement `.knowl/skills/<name>/skill.json`, `SKILL.md`, script writing, entrypoint validation, and synchronous execution.

- [ ] **Step 4: Verify registry tests pass**

Run: `npm.cmd run test -- tests/skills/registry.test.ts`
Expected: PASS.

### Task 2: Stable MCP Skill Tools

**Files:**
- Modify: `src/mcp/tools.ts`
- Modify: `src/mcp/server.ts`
- Test: `tests/mcp/server.test.ts`

- [ ] **Step 1: Write failing MCP tests**

Assert tool list includes stable skill tools. Assert `knowl_skill_create`, `knowl_skill_list`, `knowl_skill_read`, and `knowl_skill_run` operate on `.knowl/skills` without adding one MCP tool per learned skill.

- [ ] **Step 2: Run MCP tests**

Run: `npm.cmd run test -- tests/mcp/server.test.ts`
Expected: FAIL because tools are missing.

- [ ] **Step 3: Implement MCP handlers**

Wire registry functions into MCP handlers. On create, also store a `skill` knowledge item pointing to `.knowl/skills/<name>/SKILL.md`. On run, update skill usage metadata when an indexed item exists.

- [ ] **Step 4: Verify MCP tests pass**

Run: `npm.cmd run test -- tests/mcp/server.test.ts`
Expected: PASS.

### Task 3: CLI Skill Commands

**Files:**
- Modify: `src/index.ts`
- Test: `tests/cli/cli.test.ts`

- [ ] **Step 1: Write failing CLI tests**

Assert `knowl skill create`, `knowl skill list`, `knowl skill read`, and `knowl skill run` work after `knowl init`.

- [ ] **Step 2: Build and run CLI tests**

Run: `npm.cmd run build`
Run: `npm.cmd run test -- tests/cli/cli.test.ts`
Expected: FAIL on missing `skill` command before implementation.

- [ ] **Step 3: Implement CLI commands**

Add `skill list`, `skill read <name>`, `skill create <name>`, and `skill run <name>` with concise output.

- [ ] **Step 4: Verify CLI tests pass**

Run: `npm.cmd run build`
Run: `npm.cmd run test -- tests/cli/cli.test.ts`
Expected: PASS or expose only the known pre-existing init timeout if environment is slow.

### Task 4: Docs and Guidance

**Files:**
- Modify: `README.md`
- Modify: `src/core/agents-guidance.ts`
- Test: `tests/cli/cli.test.ts`

- [ ] **Step 1: Add docs/guidance assertions**

Assert generated `AGENTS.md` mentions `knowl_skill_list`, `knowl_skill_read`, and `knowl_skill_run`.

- [ ] **Step 2: Update docs/guidance**

Document learned skill packages, stable MCP bridge, auto-run behavior, and shell fallback.

- [ ] **Step 3: Verify**

Run: `npm.cmd run build`
Run: `npm.cmd run test`
Run: `git diff --check`
