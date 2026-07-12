# Knowl Hook Spam and Process Churn Fix

> For agentic workers: execute task-by-task with checkbox tracking. Surgical only.
>
> Do not redesign MCP, invent a global single-serve process, make hooks manage serve, reintroduce prompt hooks, or claim the model text-repeat loop is fixed without new evidence.

**Goal:** Reduce visible hook spam and process churn from Knowl lifecycle hooks, prove hooks never launch `knowl serve`, harden multi-agent SQLite contention, and document host-owned MCP serve lifecycle.

**Architecture:** Keep the current split:
- lifecycle hooks -> short-lived `knowl agent-hook <host> <event> --json`
- MCP config -> host-owned `knowl serve`
- SessionStart remains the sole intentional model-facing context injection
- PostToolUse / stop / compact remain capture-only

**Tech Stack:** TypeScript, Vitest, Node.js, libSQL/SQLite, Commander CLI, host hook JSON configs.

**Implementation order:** T1 -> T3 -> T2 -> T5 -> T4 -> T6

---

## Diagnosis (locked)

1. **Real issue:** Host lifecycle hooks fire one-shot `knowl agent-hook` processes on tool/stop/session events. Nested gpt-5.5 entries currently set `statusMessage: Updating Knowl memory` for every event, including high-frequency PostToolUse. Rapid tool use looks like flashing process/status spam.
2. **False claim:** hooks keep respawning `knowl serve`.
   - False.
   - Hooks launch `agent-hook` only (`src/cli/agents/hook-config.ts`, `src/index.ts`).
   - Host MCP config launches `knowl serve` (`src/cli/agents/project-adapters.ts` and peer adapters).
   - Multiple leftover serve processes are more likely multiple host sessions, reconnects, or host-held stdio pipes.
3. **Multi-agent**
   - Many agents, same repo: intended. Shared project SQLite + short locks.
   - Many agents, different repos: fine. Project-scoped state under each repo `.knowl/`.
   - Concurrent use can get noisier/slower under heavy hooks; not exclusive forever.
4. **Text-repeat loop**
   - Not proven as a Knowl feedback loop.
   - Capture hooks generally emit no model-facing stdout.
   - SessionStart context injection is intentional.
   - Treat host/model/tool loops as out of scope unless new evidence appears.

## Current code anchors

| Area | Path | Current behavior |
| --- | --- | --- |
| Nested hook generation | `src/cli/agents/hook-config.ts` | All nested events use statusMessage Updating Knowl memory |
| Hook command | `src/cli/agents/hook-config.ts` `knowlHookCommand()` | `knowl[.cmd] agent-hook <host> <event> --json` |
| MCP serve entry | `src/cli/agents/project-adapters.ts` `commandEntry()` | `{ command: knowl[.cmd], args: [serve] }` |
| agent-hook CLI | `src/index.ts` | normalize payload -> handleHostLifecycleEvent -> optional hostOutput JSON |
| serve CLI | `src/index.ts`, `src/mcp/server.ts` | starts stdio MCP server |
| Lifecycle orchestration | `src/store/host-lifecycle.ts` | SessionStart context; tool/stop capture |
| DB open | `src/store/database.ts`, `src/store/bootstrap.ts` | WAL on; no busy_timeout today |
| Adapter tests | `tests/cli/agent-adapters.test.ts` | verifies hook install/migration |
| Hook CLI tests | `tests/cli/agent-lifecycle.test.ts` | agent-hook runtime behavior |
| Lifecycle unit tests | `tests/store/host-lifecycle.test.ts` | context once + capture/finalize |

## Hard constraints

- Hooks launch `agent-hook` only.
- Do not make hooks launch/manage MCP `serve`.
- Do not invent global single-serve across hosts.
- Preserve multi-agent same-repo support and multi-repo isolation.
- Preserve SessionStart context injection.
- Do not reintroduce UserPromptSubmit / beforeSubmitPrompt.
- Prefer file-backed debounce over schema migration if possible.
- Minimal diffs only. Every changed line maps to a task below.

---

### Task 1: Quiet high-frequency hook status

**Files:**
- Modify: `src/cli/agents/hook-config.ts`
- Test: `tests/cli/agent-adapters.test.ts`

- [ ] **Step 1: Write failing assertions**

In `tests/cli/agent-adapters.test.ts`, after configureLifecycle for Codex and Claude:

```ts
expect(JSON.stringify(codexHooks.hooks.PostToolUse)).not.toContain('Updating Knowl memory');
expect(JSON.stringify(claudeSettings.hooks.PostToolUse)).not.toContain('Updating Knowl memory');
expect(JSON.stringify(codexHooks.hooks.Stop)).not.toContain('Updating Knowl memory');
expect(JSON.stringify(codexHooks.hooks.SessionStart)).not.toContain('Updating Knowl memory');
```

SessionStart may keep quieter status `Loading Knowl memory` if desired.

- [ ] **Step 2: Run RED**

```text
rtk npm.cmd test -- --maxWorkers=1 tests/cli/agent-adapters.test.ts
```

Expected: FAIL because nested hooks still emit Updating Knowl memory.

- [ ] **Step 3: Implement quiet status policy in hook-config.ts**

Change nestedEntry() so status is event-specific:

```ts
function nestedStatusMessage(event: string): string | undefined {
  if (event === 'SessionStart') return 'Loading Knowl memory';
  return undefined; // or empty string if host schema requires the field
}
```

Implementation rules:
1. Prefer omitting statusMessage for capture/stop events if host config still verifies cleanly.
2. If NestedHook type/host schema requires the field, set empty string for non-SessionStart events.
3. SessionStart may use Loading Knowl memory.
4. Do not change command shape (`agent-hook ... --json`).
5. Cursor entries already have no statusMessage; leave them alone unless needed for consistency.
6. Update NestedHook typing if status becomes optional.
7. Keep verifyNestedHookConfig equality working with the new shape.

- [ ] **Step 4: Run GREEN**

```text
rtk npm.cmd test -- --maxWorkers=1 tests/cli/agent-adapters.test.ts
```

Expected: PASS; reconfigure returns unchanged; verifyLifecycle true.

**DoD**
- High-frequency gpt-5.5 hooks no longer show Updating Knowl memory.
- Existing adapter migration/verify behavior remains green.

---

### Task 3: Prove hooks never launch serve

Do this immediately after T1 so the no-serve contract is locked before debounce work.

**Files:**
- Modify: `tests/cli/agent-adapters.test.ts`
- Optional add: `tests/cli/agent-hook-isolation.test.ts`
- Source contracts only if needed: `src/cli/agents/hook-config.ts`, `src/cli/agents/project-adapters.ts`, `src/index.ts`

- [ ] **Step 1: Add config-shape assertions**

```ts
import { knowlHookCommand } from '../../src/cli/agents/hook-config.js';

expect(knowlHookCommand('win32', 'claude', 'PostToolUse')).toBe(
  'knowl.cmd agent-hook claude PostToolUse --json',
);
expect(knowlHookCommand('win32', 'claude', 'PostToolUse')).not.toContain('serve');

for (const command of collectHookCommands(codexHooks, claudeSettings, cursorHooks)) {
  expect(command).toContain('agent-hook');
  expect(command).not.toContain('serve');
}
```

Helper can be local to the test file: walk hooks arrays and collect command strings.

Also assert MCP configs still use serve:

```ts
expect(config.mcp_servers.knowl.args).toEqual(['serve']);
expect(mcpJson.mcpServers.knowl.args).toEqual(['serve']);
```

- [ ] **Step 2: Add source/runtime isolation assertion**

Preferred lightweight checks:
1. Existing agent-lifecycle tests already prove PostToolUse returns empty stdout.
2. Optional explicit test can assert agent-hook path does not call startMcpServer.

Do not build a process-spying framework unless existing test style already supports it.

- [ ] **Step 3: Run GREEN**

```text
rtk npm.cmd test -- --maxWorkers=1 tests/cli/agent-adapters.test.ts tests/cli/agent-lifecycle.test.ts
```

**DoD**
- CI fails if hooks are later wired to launch serve.
- MCP serve registration remains separate and intact.

---

### Task 2: Debounce duplicate PostToolUse capture

**Files:**
- Add: `src/store/hook-debounce.ts`
- Modify: `src/store/host-lifecycle.ts`
- Test: `tests/store/host-lifecycle.test.ts`
- Optional: `tests/cli/agent-lifecycle.test.ts`

- [ ] **Step 1: Write failing unit tests in tests/store/host-lifecycle.test.ts**

Cover:
1. Two identical Codex session-event captures within window -> first accepted, second `{ accepted: true, reason: debounced }`, only one DB command row.
2. Distinct commands both store; stop still finalizes.
3. Failures / type error are never debounced.

- [ ] **Step 2: Run RED**

```text
rtk npm.cmd test -- --maxWorkers=1 tests/store/host-lifecycle.test.ts
```

Expected: FAIL because no debounce exists.

- [ ] **Step 3: Implement src/store/hook-debounce.ts**

Suggested API:
- `HOOK_CAPTURE_DEBOUNCE_MS = 1500`
- `captureFingerprint(input)`
- `shouldSkipDuplicateCapture(input)`
- `rememberCapture(input)`

Design rules:
1. Storage path: `<projectRoot>/.knowl/cache/hook-debounce.json`
2. Create `.knowl/cache` as needed.
3. Key: `host|projectRoot|externalSessionId|externalTurnId|fingerprint`
4. Fingerprint includes event type + command/summary/message + sorted changedPaths + exitCode/passed when present.
5. Window default 1500ms.
6. Best-effort file IO: if cache unreadable/corrupt, treat as miss and rewrite; never fail the host hook.
7. Prune expired entries opportunistically on write.
8. No schema migration.

- [ ] **Step 4: Wire debounce into handleHostLifecycleEvent**

Only on session-event / checkpoint path.

Never debounce:
- session-start
- turn-start
- turn-stop
- session-stop
- failed/error events

Skip result:

```ts
return { accepted: true, reason: 'debounced' };
```

Extend HostLifecycleResult.reason union if needed: `'event-loss' | 'debounced'`.

Keep SessionStart hostOutput / context injection unchanged.

- [ ] **Step 5: Run GREEN**

```text
rtk npm.cmd test -- --maxWorkers=1 tests/store/host-lifecycle.test.ts tests/cli/agent-lifecycle.test.ts
```

**DoD**
- Exact duplicate capture within window does not append a second event.
- Distinct commands still capture.
- Failures and stops still process.
- SessionStart context still works.

---

### Task 5: Multi-agent SQLite contention hardening

**Files:**
- Modify: `src/store/database.ts` and/or `src/store/bootstrap.ts`
- Test: `tests/store/store.test.ts` or new `tests/store/database-pragmas.test.ts`

- [ ] **Step 1: Write failing pragma test**

After initDb, assert PRAGMA busy_timeout is 5000. Adapt to actual `@libsql/client` result shape.

- [ ] **Step 2: Run RED**

```text
rtk npm.cmd test -- --maxWorkers=1 tests/store/store.test.ts
```

Expected: FAIL if busy_timeout is 0/unset.

- [ ] **Step 3: Implement busy_timeout on every open path**

In initDbPath after client create / during bootstrap:

```ts
await client.execute('PRAGMA busy_timeout = 5000;');
```

Rules:
1. Apply on every initDb / initDbPath connection.
2. Keep existing `PRAGMA journal_mode = WAL;`.
3. Do not add a global cross-host process mutex.
4. Do not change multi-repo isolation.
5. Avoid durability experiments; busy_timeout alone is enough.

- [ ] **Step 4: Optional sequential-writer smoke**

Two sequential writers on one db path succeed without uncaught SQLITE_BUSY. No flaky parallel stress suite.

- [ ] **Step 5: Run GREEN**

```text
rtk npm.cmd test -- --maxWorkers=1 tests/store/store.test.ts tests/store/host-lifecycle.test.ts
```

**DoD**
- New connections use busy_timeout=5000.
- Concurrent same-repo agents are less likely to hard-fail on short lock bursts.

---

### Task 4: Serve diagnostics + docs

**Files:**
- Modify: `src/index.ts` and/or `src/mcp/server.ts`
- Modify: `README.md` section Agent lifecycle automation

- [ ] **Step 1: Add stderr diagnostics on serve start**

Log once to stderr:
- pid
- project root if resolved
- note: host-owned stdio process; one serve process per connected host session; hooks use agent-hook and do not spawn serve

No new CLI flags.

- [ ] **Step 2: Update README**

In Agent lifecycle automation, state explicitly:
1. Lifecycle hooks call short-lived `knowl agent-hook ...` processes.
2. MCP tools use host-spawned `knowl serve`.
3. Multiple leftover serve processes usually mean multiple host sessions/reconnects, not hook respawn.
4. Multiple agents can use one repo; shared SQLite may briefly wait on locks.
5. Multiple agents in different repos are isolated.
6. SessionStart remains the sole automatic model-facing context injection; capture hooks are quiet/capture-only.

Correct any stale wording that currently says prompt starts receive context if that is no longer true.

- [ ] **Step 3: Run focused checks**

```text
rtk npm.cmd test -- --maxWorkers=1 tests/mcp/server.test.ts tests/cli/agent-adapters.test.ts
rtk npm.cmd run build
```

**DoD**
- Diagnostics and docs remove the false hooks-spawn-serve interpretation.
- No behavior change to MCP tool surface.

---

### Task 6: Manual multi-host verification matrix

Not fully automated. After T1-T5 code + tests, run and record results in PR notes.

| Case | Setup | Expect |
| --- | --- | --- |
| Codex rapid tools | project with Knowl hooks configured | no Updating Knowl memory spam; process list shows short-lived agent-hook, not serve growth per tool call |
| Claude rapid tools | same | same |
| Cursor rapid tools | same | same |
| 2 agents same repo | Codex + Claude or two sessions | both work; brief lock waits ok; no DB corruption |
| 2 agents different repos | two initialized projects | isolated memory/state |
| SessionStart | new trusted session | one bounded context injection |
| Failure + Stop | failed tool then stop | failure captured; stop finalizes |
| Process list during hooks | watch while tools run | agent-hook churn only; serve count tracks host sessions/reconnects |

Manual commands:

```text
rtk npm.cmd run build
knowl init
knowl doctor
```

Then exercise host sessions and inspect process list.

**DoD**
- Matrix filled in PR notes.
- No blocker regressions found, or residual risks explicitly listed.

---

## Final verification

After all code tasks:

```text
rtk npm.cmd test -- --maxWorkers=1 tests/cli/agent-adapters.test.ts tests/cli/agent-lifecycle.test.ts tests/store/host-lifecycle.test.ts tests/store/store.test.ts tests/mcp/server.test.ts
rtk npm.cmd test -- --maxWorkers=1
rtk npm.cmd run build
rtk git diff --check
```

Expected:
- focused and full tests pass
- build exit 0
- no whitespace errors

Existing projects need `knowl init` / lifecycle reconfigure + new host sessions to pick up quiet hook status. Running sessions will not retroactively rewrite already-loaded host hook configs.

---

## Acceptance criteria

- Rapid tool use no longer looks like Knowl status/process spam.
- High-frequency hooks stay quiet.
- Tests prove hooks do not launch serve.
- Duplicate capture events can be debounced safely.
- Concurrent agents same/different repos remain safe.
- No fake global MCP singleton.
- SessionStart context injection preserved.
- Model text-repeat not falsely closed as fixed.

## Out of scope

- Global singleton MCP serve across hosts
- Hooks managing serve lifecycle
- Fixing model text-repeat without new evidence
- Removing SessionStart context
- Reintroducing prompt hooks
- Broad rewrite of host adapters or capture pipeline

## Implementer notes

- Related historical plans already retired prompt hooks; do not undo that.
- Current split is already correct architecturally: hooks = agent-hook, MCP = serve.
- This plan is mostly noise reduction, contract tests, debounce, and contention hardening.
- Prefer tiny pure helpers over new framework code.
- If a host rejects omitted statusMessage, use empty string rather than inventing more status text.
