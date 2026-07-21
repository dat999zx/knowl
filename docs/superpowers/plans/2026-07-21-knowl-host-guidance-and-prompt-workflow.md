# Knowl Host Guidance and Prompt Workflow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Knowl's complete 24-tool workflow reliably available through canonical project guidance, MCP server instructions, Claude prompt-time reinforcement, and Gemini project integration.

**Architecture:** A new marker-free core guidance module owns the exact tool groups, full reference, managed section, and two bounded compact renderings. Project-file installers, MCP initialization, native host imports, and the Claude `UserPromptSubmit` command consume those exports without copying prose. Automatic lifecycle hooks remain separate from the manual task/session tools, and every integration is verified independently.

**Tech Stack:** TypeScript, Commander, Model Context Protocol TypeScript SDK, project-local Markdown/JSON/TOML configuration, Vitest, PowerShell verification on Windows.

**Host compatibility references:** Claude Code documents both [`CLAUDE.md` imports](https://code.claude.com/docs/en/memory) and matcher-free [`UserPromptSubmit` additional context](https://code.claude.com/docs/en/hooks). Gemini CLI documents [`GEMINI.md` `@file` imports and Markdown code-region handling](https://geminicli.com/docs/reference/memport/) and project-local [`.gemini/settings.json` MCP servers](https://geminicli.com/docs/tools/mcp-server/).

---

## Implementation map

| Responsibility | Files |
| --- | --- |
| Canonical tool inventory and guidance renderers | Create `src/core/knowl-guidance.ts`; create `tests/core/knowl-guidance.test.ts` |
| Marker-managed `KNOWL.md` and synchronized `AGENTS.md` | Modify `src/core/agents-guidance.ts`; create `tests/core/agents-guidance.test.ts` |
| MCP instructions, exact tool set, and per-tool routing | Modify `src/mcp/server.ts`, `src/mcp/tools.ts`, `src/mcp/resources.ts`, `src/cli/doctor-report.ts`, `tests/mcp/server.test.ts` |
| Base init, upgrade, and doctor wiring | Modify `src/index.ts`, `src/cli/doctor-report.ts`, `tests/cli/cli.test.ts` |
| Claude/Gemini native instruction imports | Create `src/cli/agents/instruction-files.ts`; create `tests/cli/agent-instruction-files.test.ts` |
| Instruction orchestration and Gemini adapter | Modify `src/cli/agents/types.ts`, `src/cli/agents/project-adapters.ts`, `src/cli/agents/registry.ts`, `src/cli/init-flow.ts`, `src/cli/agents/host-hook.ts`, adapter/init/host-hook tests |
| Claude prompt-time command | Create `src/cli/agents/reminder.ts`, `tests/cli/agent-reminder.test.ts`; modify `src/index.ts` |
| Claude hook installation and migration | Modify `src/cli/agents/hook-config.ts`, `tests/cli/agent-adapters.test.ts` |
| User documentation and final validation | Modify `README.md`, `tests/core/knowl-guidance.test.ts`; validate `D:/coding/DuckPrep-server` |

Keep the user's pre-existing `.gitignore` modification unstaged. Every commit command below names only task-owned files.

### Task 1: Define the canonical 24-tool guidance model

**Files:**
- Create: `src/core/knowl-guidance.ts`
- Create: `tests/core/knowl-guidance.test.ts`

- [ ] **Step 1: Write the failing inventory and rendering tests**

Create `tests/core/knowl-guidance.test.ts` with an independent inventory and the approved compact-card assertions:

```ts
import { describe, expect, it } from 'vitest';
import {
  KNOWL_CLAUDE_MODE_LINE,
  KNOWL_CLAUDE_OPERATIONAL_CARD,
  KNOWL_HOST_NEUTRAL_MODE_LINE,
  KNOWL_MCP_SERVER_INSTRUCTIONS,
  KNOWL_MCP_TOOL_GROUPS,
  KNOWL_MCP_TOOL_NAMES,
  renderFullKnowlGuidance,
  renderManagedKnowlGuidanceSection,
} from '../../src/core/knowl-guidance.js';

const EXPECTED_TOOLS = [
  'knowl_query',
  'knowl_recent', 'knowl_state', 'knowl_context',
  'knowl_task_start', 'knowl_task_checkpoint', 'knowl_task_finish',
  'knowl_store', 'knowl_ingest_atoms', 'knowl_decide', 'knowl_update',
  'knowl_timeline', 'knowl_evidence_list', 'knowl_conflicts', 'knowl_feedback',
  'knowl_skill_list', 'knowl_skill_read', 'knowl_skill_run', 'knowl_skill_create',
  'knowl_ingest', 'knowl_synthesize', 'knowl_session_finish', 'knowl_gc_preview', 'knowl_gc_apply',
] as const;

const EXPECTED_CLAUDE_CARD = [
  'KNOWL WORKFLOW - for project work.',
  'Start: use a relevant active lifecycle hit; else call knowl_query with 2-6 keywords before repository files or commands. A knowl_task_start hit counts in manual mode. Re-query on a new area. Inspect files only after miss/conflict/stale/low-confidence or explicit verification. If tools are unavailable, stop and tell the user.',
  'Mode: Claude hooks own lifecycle. Never call knowl_task_start, knowl_task_checkpoint, knowl_task_finish, or knowl_session_finish while active.',
  'Manual fallback: one bounded command uses knowl task run; resumable work uses knowl_task_start once, knowl_task_checkpoint at meaningful milestones/blockers with its taskId, and knowl_task_finish once after verification.',
  'Route:',
  '- retrieval: knowl_query; knowl_recent only without bootstrap or for refresh; knowl_state for broad state; knowl_context for a token-budgeted pack.',
  '- durable memory: knowl_store one atom; knowl_ingest_atoms a batch; knowl_decide a confirmed choice; knowl_update a stale or contradicted item.',
  '- audit: knowl_timeline, knowl_evidence_list, knowl_conflicts; knowl_feedback after actual use or correction.',
  '- skills: knowl_skill_list, knowl_skill_read, knowl_skill_run only for a trusted matching entrypoint; knowl_skill_create only when explicitly requested.',
  '- special: knowl_ingest only for explicit raw-source ingestion, never silent chat; knowl_synthesize only for an explicit scope; knowl_session_finish only for an explicitly owned manual session; knowl_gc_preview before maintenance; knowl_gc_apply only after preview and explicit approval.',
  'During work, store or update verified durable findings; never store raw transcripts, secrets, or routine command noise.',
].join('\n');

const namesIn = (text: string) => [...new Set(text.match(/\bknowl_[a-z_]+\b/g) ?? [])].sort();

describe('canonical Knowl agent guidance', () => {
  it('defines seven groups and the exact 24-tool inventory', () => {
    expect(KNOWL_MCP_TOOL_GROUPS).toHaveLength(7);
    expect(KNOWL_MCP_TOOL_NAMES).toEqual(EXPECTED_TOOLS);
    expect(new Set(KNOWL_MCP_TOOL_NAMES).size).toBe(24);
    expect(KNOWL_MCP_TOOL_NAMES).not.toContain('knowl_ask');
  });

  it('renders every tool into the full and compact guidance', () => {
    expect(namesIn(renderFullKnowlGuidance())).toEqual([...EXPECTED_TOOLS].sort());
    expect(namesIn(KNOWL_CLAUDE_OPERATIONAL_CARD)).toEqual([...EXPECTED_TOOLS].sort());
    expect(namesIn(KNOWL_MCP_SERVER_INSTRUCTIONS)).toEqual([...EXPECTED_TOOLS].sort());
    expect(renderManagedKnowlGuidanceSection()).toContain('<!-- KNOWL_PROJECT_MEMORY -->');
    expect(renderFullKnowlGuidance()).not.toContain('KNOWL_PROJECT_MEMORY');
    expect(renderFullKnowlGuidance()).toContain('Casual conversation, a single memory lookup, and trivial non-resumable work do not create a manual task loop.');
    expect(renderFullKnowlGuidance()).toContain('never send the current conversation silently');
    expect(renderFullKnowlGuidance()).toContain('never a hook session');
  });

  it('keeps both compact renderings bounded and front-loads the required action', () => {
    expect(KNOWL_CLAUDE_OPERATIONAL_CARD).toBe(EXPECTED_CLAUDE_CARD);
    expect(KNOWL_CLAUDE_OPERATIONAL_CARD).toHaveLength(1_695);
    expect(KNOWL_MCP_SERVER_INSTRUCTIONS).toHaveLength(1_746);
    for (const card of [KNOWL_CLAUDE_OPERATIONAL_CARD, KNOWL_MCP_SERVER_INSTRUCTIONS]) {
      expect(card.length).toBeLessThan(2_000);
      expect(card.slice(0, 512)).toContain('knowl_query');
      expect(card.slice(0, 512)).toContain('own lifecycle');
      expect(Math.ceil(card.length / 4)).toBeLessThanOrEqual(500);
      expect(20 * Math.ceil(card.length / 4)).toBeLessThanOrEqual(10_000);
    }
  });

  it('changes only the lifecycle mode line between compact renderings', () => {
    expect(
      KNOWL_CLAUDE_OPERATIONAL_CARD.replace(KNOWL_CLAUDE_MODE_LINE, KNOWL_HOST_NEUTRAL_MODE_LINE),
    ).toBe(KNOWL_MCP_SERVER_INSTRUCTIONS);
  });
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```powershell
npm.cmd test -- tests/core/knowl-guidance.test.ts
```

Expected: FAIL because `src/core/knowl-guidance.ts` does not exist.

- [ ] **Step 3: Implement the canonical groups and renderers**

Create `src/core/knowl-guidance.ts`. Use LF joins so the compact lengths do not vary by platform:

```ts
export const KNOWL_GUIDANCE_START_MARKER = '<!-- KNOWL_PROJECT_MEMORY -->';
export const KNOWL_GUIDANCE_END_MARKER = '<!-- /KNOWL_PROJECT_MEMORY -->';

export const KNOWL_MCP_TOOL_GROUPS = [
  {
    label: 'Focused retrieval',
    tools: ['knowl_query'],
    routing: 'Default first call for a specific project request and again when switching areas. Use 2-6 keywords and omit category unless certain.',
  },
  {
    label: 'Context views',
    tools: ['knowl_recent', 'knowl_state', 'knowl_context'],
    routing: 'Use recent only without lifecycle bootstrap or for an explicit refresh; state for broad status; context for an explicitly token-budgeted pack.',
  },
  {
    label: 'Manual work loop',
    tools: ['knowl_task_start', 'knowl_task_checkpoint', 'knowl_task_finish'],
    routing: 'Use only without verified lifecycle hooks: start once, checkpoint meaningful milestones or blockers, and finish once after verification.',
  },
  {
    label: 'Durable writes',
    tools: ['knowl_store', 'knowl_ingest_atoms', 'knowl_decide', 'knowl_update'],
    routing: 'Store one verified atom, batch verified atoms, record a confirmed decision, or correct/supersede stale memory.',
  },
  {
    label: 'History and quality',
    tools: ['knowl_timeline', 'knowl_evidence_list', 'knowl_conflicts', 'knowl_feedback'],
    routing: 'Inspect history, evidence, or conflicts when needed; record feedback only after actual use, rejection, or correction.',
  },
  {
    label: 'Learned skills',
    tools: ['knowl_skill_list', 'knowl_skill_read', 'knowl_skill_run', 'knowl_skill_create'],
    routing: 'Discover and read a matching skill before running a trusted entrypoint; create only when explicitly requested.',
  },
  {
    label: 'Special and maintenance',
    tools: ['knowl_ingest', 'knowl_synthesize', 'knowl_session_finish', 'knowl_gc_preview', 'knowl_gc_apply'],
    routing: 'Raw-source ingest requires an explicit request and configured AI; never send the current conversation silently. Synthesis is explicitly scoped and never automatic. Session finish is only for an explicitly owned manual memory-session ID, never a hook session. Preview GC first; apply only after explicit approval.',
  },
] as const;

export type KnowlMcpToolName = typeof KNOWL_MCP_TOOL_GROUPS[number]['tools'][number];

export const KNOWL_MCP_TOOL_NAMES = KNOWL_MCP_TOOL_GROUPS
  .flatMap(group => [...group.tools]) as KnowlMcpToolName[];

const REQUIRED_WORKFLOW = `### Required workflow

1. For every project-specific request, call \`knowl_query\` with 2-6 concise keywords before repository files or commands.
2. Skip a new query only when directly relevant active lifecycle context, a same-request query, or manual \`knowl_task_start\` relevant memory already answers it.
3. Use a relevant active hit immediately. Inspect files only after a miss, conflict, stale/low-confidence memory, or explicit verification request.
4. Query again before switching to a distinct subtask or project area.
5. Store or update verified durable findings during work and before the final answer; never store raw transcripts, secrets, or debugging noise.
6. If Knowl MCP tools are unavailable, stop and tell the user instead of silently bypassing Knowl.`;

const LIFECYCLE_MODES = `### Lifecycle modes

- **Automatic host lifecycle:** verified hooks own bootstrap, capture, checkpoints, and finalization. Never call \`knowl_task_start\`, \`knowl_task_checkpoint\`, \`knowl_task_finish\`, or \`knowl_session_finish\` for that hook-owned session.
- **Manual work loop:** without verified hooks, use \`knowl task run\` for one bounded command. For resumable work, start once, checkpoint meaningful milestones/blockers with the returned task ID, and finish exactly once after verification. The start result satisfies the initial focused lookup.

Casual conversation, a single memory lookup, and trivial non-resumable work do not create a manual task loop.`;

const SAFETY = `### Safety and freshness

- Correct stale or contradicted memory with \`knowl_update\` instead of adding a duplicate.
- All writes are secret-validated. Never retry rejected secret material in altered form.
- \`Auth: Unsupported\` is normal for a local stdio MCP server when the focused retrieval tool is listed.`;

export function renderFullKnowlGuidance(): string {
  const table = [
    '| Group | Tools | Routing |',
    '| --- | --- | --- |',
    ...KNOWL_MCP_TOOL_GROUPS.map(group =>
      `| ${group.label} | ${group.tools.map(tool => `\`${tool}\``).join(', ')} | ${group.routing} |`),
  ].join('\n');
  return ['## Knowl Project Memory', REQUIRED_WORKFLOW, LIFECYCLE_MODES, `### Complete MCP tool routing\n\n${table}`, SAFETY].join('\n\n');
}

export function renderManagedKnowlGuidanceSection(): string {
  return `${KNOWL_GUIDANCE_START_MARKER}\n${renderFullKnowlGuidance()}\n${KNOWL_GUIDANCE_END_MARKER}\n`;
}

export const KNOWL_CLAUDE_MODE_LINE = 'Mode: Claude hooks own lifecycle. Never call knowl_task_start, knowl_task_checkpoint, knowl_task_finish, or knowl_session_finish while active.';
export const KNOWL_HOST_NEUTRAL_MODE_LINE = 'Mode: verified hooks, when active, own lifecycle. Never call knowl_task_start, knowl_task_checkpoint, knowl_task_finish, or knowl_session_finish while active; otherwise use the manual fallback.';

function renderCompactKnowlGuidance(modeLine: string): string {
  return [
    'KNOWL WORKFLOW - for project work.',
    'Start: use a relevant active lifecycle hit; else call knowl_query with 2-6 keywords before repository files or commands. A knowl_task_start hit counts in manual mode. Re-query on a new area. Inspect files only after miss/conflict/stale/low-confidence or explicit verification. If tools are unavailable, stop and tell the user.',
    modeLine,
    'Manual fallback: one bounded command uses knowl task run; resumable work uses knowl_task_start once, knowl_task_checkpoint at meaningful milestones/blockers with its taskId, and knowl_task_finish once after verification.',
    'Route:',
    '- retrieval: knowl_query; knowl_recent only without bootstrap or for refresh; knowl_state for broad state; knowl_context for a token-budgeted pack.',
    '- durable memory: knowl_store one atom; knowl_ingest_atoms a batch; knowl_decide a confirmed choice; knowl_update a stale or contradicted item.',
    '- audit: knowl_timeline, knowl_evidence_list, knowl_conflicts; knowl_feedback after actual use or correction.',
    '- skills: knowl_skill_list, knowl_skill_read, knowl_skill_run only for a trusted matching entrypoint; knowl_skill_create only when explicitly requested.',
    '- special: knowl_ingest only for explicit raw-source ingestion, never silent chat; knowl_synthesize only for an explicit scope; knowl_session_finish only for an explicitly owned manual session; knowl_gc_preview before maintenance; knowl_gc_apply only after preview and explicit approval.',
    'During work, store or update verified durable findings; never store raw transcripts, secrets, or routine command noise.',
  ].join('\n');
}

export const KNOWL_CLAUDE_OPERATIONAL_CARD = renderCompactKnowlGuidance(KNOWL_CLAUDE_MODE_LINE);
export const KNOWL_MCP_SERVER_INSTRUCTIONS = renderCompactKnowlGuidance(KNOWL_HOST_NEUTRAL_MODE_LINE);
```

- [ ] **Step 4: Run the focused test and verify GREEN**

Run:

```powershell
npm.cmd test -- tests/core/knowl-guidance.test.ts
```

Expected: PASS with 4 tests.

- [ ] **Step 5: Commit the canonical guidance model**

```powershell
git add -- src/core/knowl-guidance.ts tests/core/knowl-guidance.test.ts
git commit -m "feat: add canonical Knowl guidance renderers"
```

### Task 2: Install canonical `KNOWL.md` and synchronized `AGENTS.md`

**Files:**
- Modify: `src/core/agents-guidance.ts`
- Create: `tests/core/agents-guidance.test.ts`

- [ ] **Step 1: Write failing file-preservation tests**

Create `tests/core/agents-guidance.test.ts`:

```ts
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  installKnowlProjectGuidance,
  isKnowlProjectGuidanceCurrent,
} from '../../src/core/agents-guidance.js';
import { renderManagedKnowlGuidanceSection } from '../../src/core/knowl-guidance.js';

const ROOT = path.resolve('.knowl-project-guidance-test');
afterEach(() => fs.rm(ROOT, { recursive: true, force: true }));

describe('project guidance files', () => {
  it('creates canonical KNOWL.md and synchronized AGENTS.md', async () => {
    await fs.mkdir(ROOT, { recursive: true });
    expect(await installKnowlProjectGuidance(ROOT)).toEqual({ knowl: 'created', agents: 'created' });
    const knowl = await fs.readFile(path.join(ROOT, 'KNOWL.md'), 'utf8');
    const agents = await fs.readFile(path.join(ROOT, 'AGENTS.md'), 'utf8');
    expect(knowl).toBe(renderManagedKnowlGuidanceSection());
    expect(agents).toBe(`# Agent Instructions\n\n${renderManagedKnowlGuidanceSection()}`);
    expect(await isKnowlProjectGuidanceCurrent(ROOT)).toBe(true);
  });

  it('preserves content outside stale managed sections in both files', async () => {
    await fs.mkdir(ROOT, { recursive: true });
    const stale = '<!-- KNOWL_PROJECT_MEMORY -->\nstale\n<!-- /KNOWL_PROJECT_MEMORY -->';
    await fs.writeFile(path.join(ROOT, 'KNOWL.md'), `Before\n\n${stale}\n\nAfter\n`);
    await fs.writeFile(path.join(ROOT, 'AGENTS.md'), `Rules\n\n${stale}\n\nTail\n`);
    expect(await installKnowlProjectGuidance(ROOT)).toEqual({ knowl: 'updated', agents: 'updated' });
    expect(await fs.readFile(path.join(ROOT, 'KNOWL.md'), 'utf8')).toContain('Before');
    expect(await fs.readFile(path.join(ROOT, 'KNOWL.md'), 'utf8')).toContain('After');
    expect(await fs.readFile(path.join(ROOT, 'AGENTS.md'), 'utf8')).toContain('Rules');
    expect(await fs.readFile(path.join(ROOT, 'AGENTS.md'), 'utf8')).toContain('Tail');
  });

  it('replaces an unterminated section through EOF and is idempotent', async () => {
    await fs.mkdir(ROOT, { recursive: true });
    await fs.writeFile(path.join(ROOT, 'KNOWL.md'), 'Keep\n\n<!-- KNOWL_PROJECT_MEMORY -->\nbroken');
    await fs.writeFile(path.join(ROOT, 'AGENTS.md'), 'Keep agents\n\n<!-- KNOWL_PROJECT_MEMORY -->\nbroken');
    await installKnowlProjectGuidance(ROOT);
    expect(await fs.readFile(path.join(ROOT, 'KNOWL.md'), 'utf8')).toMatch(/^Keep\n\n<!-- KNOWL_PROJECT_MEMORY -->/);
    expect(await installKnowlProjectGuidance(ROOT)).toEqual({ knowl: 'unchanged', agents: 'unchanged' });
  });

  it('is not current when either file is missing or stale', async () => {
    await fs.mkdir(ROOT, { recursive: true });
    await installKnowlProjectGuidance(ROOT);
    await fs.rm(path.join(ROOT, 'KNOWL.md'));
    expect(await isKnowlProjectGuidanceCurrent(ROOT)).toBe(false);
  });
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```powershell
npm.cmd test -- tests/core/agents-guidance.test.ts
```

Expected: FAIL because the project-level installer exports do not exist and `KNOWL.md` is not created.

- [ ] **Step 3: Refactor the installer around one managed-section helper**

Replace the private prose literal in `src/core/agents-guidance.ts` with imports from `knowl-guidance.ts`. Keep compatibility wrappers until Task 4 updates existing callers:

```ts
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  KNOWL_GUIDANCE_END_MARKER,
  KNOWL_GUIDANCE_START_MARKER,
  renderManagedKnowlGuidanceSection,
} from './knowl-guidance.js';

export type GuidanceInstallStatus = 'created' | 'updated' | 'unchanged';
export interface KnowlProjectGuidanceInstallResult {
  knowl: GuidanceInstallStatus;
  agents: GuidanceInstallStatus;
}

export function stripManagedKnowlGuidance(source: string): string {
  const start = source.indexOf(KNOWL_GUIDANCE_START_MARKER);
  if (start < 0) return source;
  const end = source.indexOf(KNOWL_GUIDANCE_END_MARKER, start);
  const replacementEnd = end < 0 ? source.length : end + KNOWL_GUIDANCE_END_MARKER.length;
  const before = source.slice(0, start).trimEnd();
  const after = source.slice(replacementEnd).trimStart();
  return [before, after].filter(Boolean).join('\n\n') + (before || after ? '\n' : '');
}

async function installManagedFile(
  filePath: string,
  createPrefix: string,
): Promise<GuidanceInstallStatus> {
  const managed = renderManagedKnowlGuidanceSection();
  let existing: string | undefined;
  try {
    existing = await fs.readFile(filePath, 'utf8');
  } catch (error: any) {
    if (error?.code !== 'ENOENT') throw error;
  }
  if (existing === undefined) {
    await fs.writeFile(filePath, `${createPrefix}${managed}`, 'utf8');
    return 'created';
  }
  if (existing.includes(managed)) return 'unchanged';
  const start = existing.indexOf(KNOWL_GUIDANCE_START_MARKER);
  let next: string;
  if (start >= 0) {
    const end = existing.indexOf(KNOWL_GUIDANCE_END_MARKER, start);
    const replacementEnd = end < 0 ? existing.length : end + KNOWL_GUIDANCE_END_MARKER.length;
    const before = existing.slice(0, start).trimEnd();
    const after = existing.slice(replacementEnd).trimStart();
    next = [before, managed.trimEnd(), after].filter(Boolean).join('\n\n') + '\n';
  } else {
    const separator = existing.length === 0 ? '' : existing.endsWith('\n') ? '\n' : '\n\n';
    next = `${existing}${separator}${managed}`;
  }
  await fs.writeFile(filePath, next, 'utf8');
  return 'updated';
}

export async function installKnowlProjectGuidance(projectRoot: string): Promise<KnowlProjectGuidanceInstallResult> {
  return {
    knowl: await installManagedFile(path.join(projectRoot, 'KNOWL.md'), ''),
    agents: await installManagedFile(path.join(projectRoot, 'AGENTS.md'), '# Agent Instructions\n\n'),
  };
}

export async function isKnowlProjectGuidanceCurrent(projectRoot: string): Promise<boolean> {
  const managed = renderManagedKnowlGuidanceSection();
  try {
    const [knowl, agents] = await Promise.all([
      fs.readFile(path.join(projectRoot, 'KNOWL.md'), 'utf8'),
      fs.readFile(path.join(projectRoot, 'AGENTS.md'), 'utf8'),
    ]);
    return knowl.includes(managed) && agents.includes(managed);
  } catch (error: any) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

export async function installKnowlAgentsGuidance(projectRoot: string): Promise<GuidanceInstallStatus> {
  return (await installKnowlProjectGuidance(projectRoot)).agents;
}

export async function isKnowlAgentsGuidanceCurrent(projectRoot: string): Promise<boolean> {
  try {
    return (await fs.readFile(path.join(projectRoot, 'AGENTS.md'), 'utf8'))
      .includes(renderManagedKnowlGuidanceSection());
  } catch (error: any) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}
```

- [ ] **Step 4: Run focused tests and verify GREEN**

Run:

```powershell
npm.cmd test -- tests/core/knowl-guidance.test.ts tests/core/agents-guidance.test.ts
```

Expected: PASS with both test files green.

- [ ] **Step 5: Commit the project-file installer**

```powershell
git add -- src/core/agents-guidance.ts tests/core/agents-guidance.test.ts
git commit -m "feat: install canonical Knowl project guidance"
```

### Task 3: Publish canonical MCP instructions and align the tool surface

**Files:**
- Modify: `src/mcp/server.ts:10-56`
- Modify: `src/mcp/tools.ts:39-548`
- Modify: `src/mcp/resources.ts:20-45`
- Modify: `src/cli/doctor-report.ts:9`
- Modify: `tests/mcp/server.test.ts:33-185`

- [ ] **Step 1: Write failing initialize, exact-set, and routing tests**

In `tests/mcp/server.test.ts`, import the canonical constants and extract the existing handshake into a reusable helper:

```ts
import {
  KNOWL_MCP_SERVER_INSTRUCTIONS,
  KNOWL_MCP_TOOL_NAMES,
} from '../../src/core/knowl-guidance.js';

async function initializeServer(server = createMcpServer(projectId, TEST_ROOT, MOCK_CONFIG)) {
  const transport = new InMemoryTransport();
  await server.connect(transport);
  const responsePromise = new Promise<any>(resolve => {
    transport.onSend = message => {
      if (message.id === 'init-id') resolve(message);
    };
  });
  transport.onmessage!({
    jsonrpc: '2.0',
    id: 'init-id',
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'test-client', version: '1.0' },
    },
  });
  const response = await responsePromise;
  transport.onmessage!({ jsonrpc: '2.0', method: 'notifications/initialized' });
  return { server, transport, response };
}
```

Replace `runRpcRequest()` with:

```ts
async function runRpcRequest(method: string, params: any = {}) {
  mcpServer = createMcpServer(projectId, TEST_ROOT, MOCK_CONFIG);
  const initialized = await initializeServer(mcpServer);
  const responsePromise = new Promise<any>(resolve => {
    initialized.transport.onSend = message => {
      if (message.id === 'req-id') resolve(message);
    };
  });
  initialized.transport.onmessage!({
    jsonrpc: '2.0',
    id: 'req-id',
    method,
    params,
  });
  const response = await responsePromise;
  await initialized.server.close();
  return response;
}
```

Then add:

```ts
it('publishes host-neutral instructions even when project initialization failed', async () => {
  const initialized = await initializeServer(createMcpServer(null, null, null, 'not initialized'));
  expect(initialized.response.result.instructions).toBe(KNOWL_MCP_SERVER_INSTRUCTIONS);
  await initialized.server.close();
});

it('keeps tools/list exactly aligned with the canonical inventory', async () => {
  const res = await runRpcRequest('tools/list');
  const names = res.result.tools.map((tool: any) => tool.name);
  expect(names.toSorted()).toEqual([...KNOWL_MCP_TOOL_NAMES].toSorted());
  expect(new Set(names).size).toBe(24);
});

it('advertises lifecycle and mutation gates in tool descriptions', async () => {
  const res = await runRpcRequest('tools/list');
  const byName = new Map(res.result.tools.map((tool: any) => [tool.name, tool.description]));
  expect(byName.get('knowl_recent')).toContain('only when lifecycle bootstrap is unavailable');
  expect(byName.get('knowl_task_start')).toContain('manual work loop');
  expect(byName.get('knowl_task_start')).toContain('Never use for a hook-owned session');
  expect(byName.get('knowl_session_finish')).toContain('never a hook-owned session');
  expect(byName.get('knowl_ingest')).toContain('never silently ingest the current conversation');
  expect(byName.get('knowl_skill_create')).toContain('explicitly requested');
  expect(byName.get('knowl_gc_apply')).toContain('explicit user approval');
});
```

- [ ] **Step 2: Run the MCP test and verify RED**

Run:

```powershell
npm.cmd test -- tests/mcp/server.test.ts
```

Expected: FAIL because initialize has no `instructions`, the local inventory omits three tools, and several descriptions lack the new gates.

- [ ] **Step 3: Wire server instructions and the canonical inventory**

Replace the local array in `src/mcp/server.ts`:

```ts
import {
  KNOWL_MCP_SERVER_INSTRUCTIONS,
  KNOWL_MCP_TOOL_NAMES,
} from '../core/knowl-guidance.js';

export { KNOWL_MCP_TOOL_NAMES };
```

Pass instructions through the existing SDK constructor without reading project files:

```ts
const server = new Server(
  { name: 'knowl-knowledge-server', version: PACKAGE_VERSION },
  {
    capabilities: { tools: {}, resources: {} },
    instructions: KNOWL_MCP_SERVER_INSTRUCTIONS,
  },
);
```

Change `src/cli/doctor-report.ts` to import `KNOWL_MCP_TOOL_NAMES` from `../core/knowl-guidance.js` instead of `../mcp/server.js`.

- [ ] **Step 4: Align individual tool and resource descriptions**

Replace the corresponding `description` strings in `src/mcp/tools.ts` with these exact routing clauses while leaving schemas and handlers unchanged:

```ts
const guidanceDescriptions = {
  knowl_ingest: 'Process explicitly supplied raw source text through the configured Knowl AI pipeline. Use only for an explicit ingestion request; never silently ingest the current conversation or prompt.',
  knowl_recent: 'Get compact recent session context only when lifecycle bootstrap is unavailable (including manual mode) or an explicit refresh is needed.',
  knowl_query: 'Use this first for specific project questions, before each new subtask, and when switching areas during multi-step work. Query with 2-6 keywords. Skip only for directly relevant active lifecycle context, a same-request query, or relevant memory returned by knowl_task_start. If results contain a relevant active item, answer from Knowl without inspecting repository files. Inspect files only on miss, conflict, stale or low-confidence results, or explicit verification requests.',
  knowl_timeline: 'Inspect immutable assertions for one knowledge item when its history is needed.',
  knowl_conflicts: 'Inspect active exclusive conflict identities when a conflict must be resolved.',
  knowl_evidence_list: 'Inspect evidence linked to one knowledge item when source support must be checked.',
  knowl_feedback: 'Record append-only usefulness feedback only after a retrieved item was actually used, rejected, or caused a correction.',
  knowl_session_finish: 'Finish and optionally promote an explicitly owned manual memory session; never use a hook-owned session ID.',
  knowl_task_start: 'Start one manual work loop for multi-command or resumable work when verified lifecycle hooks are unavailable. Returns relevant memory and a taskId. Never use for a hook-owned session.',
  knowl_task_checkpoint: 'Checkpoint meaningful progress or a blocker in a manual work loop using the taskId from knowl_task_start. Never use for a hook-owned session or routine command noise.',
  knowl_task_finish: 'Finish one manual work loop exactly once after verification using the taskId from knowl_task_start. Never use for a hook-owned session.',
  knowl_gc_apply: 'Apply knowledge garbage collection only after knowl_gc_preview and explicit user approval; this may purge, archive, or compress records.',
  knowl_skill_create: 'Create and index a learned file-backed skill only when the user explicitly requested a reusable workflow to be codified.',
  knowl_skill_run: 'Run a trusted matching learned-skill entrypoint after inspecting the package with knowl_skill_read.',
} as const;
```

Use each value directly in its existing registration object; do not introduce `guidanceDescriptions` as a new production abstraction. Keep `knowl_synthesize`'s existing “never automatic” wording, and keep the structured-write descriptions that already distinguish one atom, a batch, a decision, and an update.

In `src/mcp/resources.ts`, change the `knowl://recent` description to:

```ts
description: 'Compact recent context only when lifecycle bootstrap is unavailable (including manual mode) or an explicit refresh is needed.',
```

- [ ] **Step 5: Run MCP and doctor-focused tests and verify GREEN**

Run:

```powershell
npm.cmd test -- tests/mcp/server.test.ts
npm.cmd run build
```

Expected: the MCP test and TypeScript build both PASS; the doctor compiles against the canonical inventory import.

- [ ] **Step 6: Commit the MCP workflow**

```powershell
git add -- src/mcp/server.ts src/mcp/tools.ts src/mcp/resources.ts src/cli/doctor-report.ts tests/mcp/server.test.ts
git commit -m "feat: publish canonical Knowl MCP workflow"
```

### Task 4: Wire canonical guidance into init, upgrade, and doctor

**Files:**
- Modify: `src/index.ts:10,58-64,184-212,219-300,828-836`
- Modify: `src/cli/doctor-report.ts:5,46-53`
- Modify: `tests/cli/cli.test.ts:134-180,264-310,625-650`

- [ ] **Step 1: Update CLI integration tests to require both project files**

Replace the AGENTS-only expectations in `tests/cli/cli.test.ts` with assertions that both files exist, contain the new workflow, and share the exact managed section:

```ts
const managedSection = (source: string) => source.match(
  /<!-- KNOWL_PROJECT_MEMORY -->[\s\S]*?<!-- \/KNOWL_PROJECT_MEMORY -->/,
)?.[0];

it('creates canonical KNOWL.md and synchronized AGENTS.md during init', async () => {
  const knowl = await fs.readFile(path.join(TEST_DIR, 'KNOWL.md'), 'utf8');
  const agents = await fs.readFile(path.join(TEST_DIR, 'AGENTS.md'), 'utf8');
  expect(managedSection(knowl)).toBe(managedSection(agents));
  expect(knowl).toContain('For every project-specific request');
  expect(knowl).toContain('### Complete MCP tool routing');
  expect(knowl).toContain('knowl_task_checkpoint');
});
```

Extend the existing stale-guidance and upgrade tests:

```ts
expect(output).toContain('KNOWL.md');
expect(output).toContain('AGENTS.md');
expect(await fs.readFile(path.join(AGENTS_REFRESH_TEST_DIR, 'KNOWL.md'), 'utf8'))
  .toContain('### Complete MCP tool routing');
```

In the stale-guidance test, replace the legacy phrase assertions rather than retaining them. After rerunning init, use:

```ts
const agentsContent = await fs.readFile(agentsPath, 'utf8');
const knowlContent = await fs.readFile(path.join(AGENTS_REFRESH_TEST_DIR, 'KNOWL.md'), 'utf8');
expect(managedSection(agentsContent)).toBe(managedSection(knowlContent));
expect(agentsContent).toContain('For every project-specific request');
expect(agentsContent).toContain('call `knowl_query` with 2-6 concise keywords');
expect(agentsContent).toContain('### Lifecycle modes');
expect(agentsContent).toContain('### Complete MCP tool routing');
expect(agentsContent).toContain('knowl_feedback');
expect(agentsContent).not.toContain('knowl_ask');
expect((agentsContent.match(/## Knowl Project Memory/g) || [])).toHaveLength(1);
```

Remove the old assertions for “Lifecycle bootstrap supplies compact initial context,” “focused follow-up,” and the former long AGENTS-only prose; those strings are intentionally superseded by the canonical renderer.

Update doctor expectations to require:

```ts
expect(output).toContain('[OK] KNOWL.md and AGENTS.md guidance current');
```

- [ ] **Step 2: Build and run the CLI test to verify RED**

Run:

```powershell
npm.cmd run build
npm.cmd test -- tests/cli/cli.test.ts
```

Expected: FAIL because the CLI still calls the AGENTS-only compatibility wrapper and prints AGENTS-only status.

- [ ] **Step 3: Replace compatibility wiring with project guidance results**

In `src/index.ts`, import and use `installKnowlProjectGuidance`:

```ts
import {
  installKnowlProjectGuidance,
  KnowlProjectGuidanceInstallResult,
} from './core/agents-guidance.js';

function printProjectGuidanceStatus(status: KnowlProjectGuidanceInstallResult) {
  console.log(`KNOWL.md: ${status.knowl}`);
  console.log(`AGENTS.md: ${status.agents}`);
}
```

In both fresh init and `upgradeExistingRepository()`, replace `agentsStatus` with:

```ts
const guidanceStatus = await installKnowlProjectGuidance(projectRoot);
```

Return/print `guidanceStatus`, including both filenames, and remove the old `printAgentsGuidanceStatus()` usage. Once no callers remain, remove the compatibility exports `installKnowlAgentsGuidance()` and `isKnowlAgentsGuidanceCurrent()` from `src/core/agents-guidance.ts`.

In `src/cli/doctor-report.ts`, use the project-level check:

```ts
const guidanceCurrent = await isKnowlProjectGuidanceCurrent(root);
checks.push({
  status: guidanceCurrent ? 'OK' : 'WARN',
  message: guidanceCurrent
    ? 'KNOWL.md and AGENTS.md guidance current'
    : 'KNOWL.md or AGENTS.md guidance missing or stale; run knowl init',
  fix: guidanceCurrent ? undefined : 'run `knowl init`',
});
```

- [ ] **Step 4: Rebuild and verify GREEN**

Run:

```powershell
npm.cmd run build
npm.cmd test -- tests/core/agents-guidance.test.ts tests/cli/cli.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit the init/doctor wiring**

```powershell
git add -- src/core/agents-guidance.ts src/index.ts src/cli/doctor-report.ts tests/cli/cli.test.ts
git commit -m "feat: wire canonical guidance into init"
```

### Task 5: Add preserving Claude and Gemini instruction-file imports

**Files:**
- Create: `src/cli/agents/instruction-files.ts`
- Create: `tests/cli/agent-instruction-files.test.ts`
- Reuse: `src/core/agents-guidance.ts` (`stripManagedKnowlGuidance`)
- Reuse: `src/cli/agents/files.ts` (`readTextIfExists`, `writeWithBackup`, `MergeStatus`)

- [ ] **Step 1: Write the failing host-instruction matrix**

Create `tests/cli/agent-instruction-files.test.ts`:

```ts
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  installKnowlHostInstructions,
  verifyKnowlHostInstructions,
} from '../../src/cli/agents/instruction-files.js';
import { renderManagedKnowlGuidanceSection } from '../../src/core/knowl-guidance.js';

const ROOT = path.resolve('.knowl-host-instructions-test');
afterEach(() => fs.rm(ROOT, { recursive: true, force: true }));

describe.each([
  ['claude', 'CLAUDE.md', '@KNOWL.md'],
  ['gemini', 'GEMINI.md', '@./KNOWL.md'],
] as const)('%s native instructions', (host, filename, preferredImport) => {
  const pathname = path.join(ROOT, filename);

  it('creates the preferred import and reruns unchanged', async () => {
    expect(await installKnowlHostInstructions(ROOT, host)).toBe('configured');
    expect(await fs.readFile(pathname, 'utf8')).toBe(`${preferredImport}\n`);
    expect(await verifyKnowlHostInstructions(ROOT, host)).toBe(true);
    expect(await installKnowlHostInstructions(ROOT, host)).toBe('unchanged');
  });

  it.each(['@KNOWL.md', '@./KNOWL.md', '@AGENTS.md', '@./AGENTS.md'])(
    'accepts an existing standalone %s import',
    async importLine => {
      await fs.mkdir(ROOT, { recursive: true });
      await fs.writeFile(pathname, `${importLine}\n\nHost rules stay.\n`);
      expect(await installKnowlHostInstructions(ROOT, host)).toBe('unchanged');
      expect(await fs.readFile(pathname, 'utf8')).toContain('Host rules stay.');
    },
  );

  it('accepts an active import embedded in prose', async () => {
    await fs.mkdir(ROOT, { recursive: true });
    await fs.writeFile(pathname, 'Host rules load @KNOWL.md here.\n');
    expect(await installKnowlHostInstructions(ROOT, host)).toBe('unchanged');
    expect(await verifyKnowlHostInstructions(ROOT, host)).toBe(true);
  });

  it('does not mistake inline-code or fenced examples for an active import', async () => {
    await fs.mkdir(ROOT, { recursive: true });
    await fs.writeFile(pathname, '<!-- @KNOWL.md -->\nLiteral `@KNOWL.md` example.\n\n```md\n@KNOWL.md\n```\n');
    expect(await installKnowlHostInstructions(ROOT, host)).toBe('updated');
    expect((await fs.readFile(pathname, 'utf8')).startsWith(`${preferredImport}\n`)).toBe(true);
  });

  it('removes only legacy managed guidance and preserves custom content', async () => {
    await fs.mkdir(ROOT, { recursive: true });
    await fs.writeFile(pathname, `Before\n\n${renderManagedKnowlGuidanceSection()}\nAfter\n`);
    expect(await installKnowlHostInstructions(ROOT, host)).toBe('updated');
    const saved = await fs.readFile(pathname, 'utf8');
    expect(saved).toContain('Before');
    expect(saved).toContain('After');
    expect(saved).not.toContain('KNOWL_PROJECT_MEMORY');
    expect(saved.match(/@(?:\.\/)?KNOWL\.md/g)).toHaveLength(1);
  });

  it('does not duplicate an existing import while removing legacy guidance', async () => {
    await fs.mkdir(ROOT, { recursive: true });
    await fs.writeFile(pathname, `${preferredImport}\n\n${renderManagedKnowlGuidanceSection()}\nHost rules stay.\n`);
    expect(await installKnowlHostInstructions(ROOT, host)).toBe('updated');
    const saved = await fs.readFile(pathname, 'utf8');
    expect(saved).not.toContain('KNOWL_PROJECT_MEMORY');
    expect(saved).toContain('Host rules stay.');
    expect(saved.match(/@(?:\.\/)?KNOWL\.md/g)).toHaveLength(1);
  });

  it('repairs an unterminated legacy section from its opening marker through EOF', async () => {
    await fs.mkdir(ROOT, { recursive: true });
    await fs.writeFile(pathname, 'Keep this.\n\n<!-- KNOWL_PROJECT_MEMORY -->\ndiscard this');
    expect(await installKnowlHostInstructions(ROOT, host)).toBe('updated');
    const saved = await fs.readFile(pathname, 'utf8');
    expect(saved).toContain('Keep this.');
    expect(saved).not.toContain('discard this');
    expect(saved.match(/@(?:\.\/)?KNOWL\.md/g)).toHaveLength(1);
  });

  it('rejects missing imports and remaining legacy markers during verification', async () => {
    await fs.mkdir(ROOT, { recursive: true });
    await fs.writeFile(pathname, 'Host rules only.\n');
    expect(await verifyKnowlHostInstructions(ROOT, host)).toBe(false);
    await fs.writeFile(pathname, `${preferredImport}\n<!-- KNOWL_PROJECT_MEMORY -->\nstale\n`);
    expect(await verifyKnowlHostInstructions(ROOT, host)).toBe(false);
  });
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```powershell
npm.cmd test -- tests/cli/agent-instruction-files.test.ts
```

Expected: FAIL because `instruction-files.ts` does not exist.

- [ ] **Step 3: Implement active-import parsing and preserving migration**

Create `src/cli/agents/instruction-files.ts`:

```ts
import path from 'node:path';
import { KNOWL_GUIDANCE_START_MARKER } from '../../core/knowl-guidance.js';
import { stripManagedKnowlGuidance } from '../../core/agents-guidance.js';
import { MergeStatus, readTextIfExists, writeWithBackup } from './files.js';

export type NativeInstructionHost = 'claude' | 'gemini';

const HOST_INSTRUCTIONS = {
  claude: { file: 'CLAUDE.md', importLine: '@KNOWL.md' },
  gemini: { file: 'GEMINI.md', importLine: '@./KNOWL.md' },
} as const;

function hasActiveGuidanceImport(source: string): boolean {
  const withoutComments = source.replace(/<!--[\s\S]*?(?:-->|$)/g, '');
  let fenced = false;
  const visible: string[] = [];
  for (const line of withoutComments.split(/\r?\n/)) {
    if (/^\s*(?:```|~~~)/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (!fenced) visible.push(line.replace(/(`+).*?\1/g, ''));
  }
  return /@(?:\.\/)?(?:KNOWL|AGENTS)\.md(?=$|[\s),;:!?'"\]}]|[.](?=\s|$))/.test(visible.join('\n'));
}

export async function installKnowlHostInstructions(
  projectRoot: string,
  host: NativeInstructionHost,
): Promise<MergeStatus> {
  const target = HOST_INSTRUCTIONS[host];
  const pathname = path.join(projectRoot, target.file);
  const existing = await readTextIfExists(pathname);
  if (existing === undefined) {
    await writeWithBackup(pathname, `${target.importLine}\n`);
    return 'configured';
  }
  const cleaned = stripManagedKnowlGuidance(existing);
  const next = hasActiveGuidanceImport(cleaned)
    ? cleaned
    : `${target.importLine}\n${cleaned.length > 0 ? `\n${cleaned}` : ''}`;
  if (next === existing) return 'unchanged';
  await writeWithBackup(pathname, next, existing);
  return 'updated';
}

export async function verifyKnowlHostInstructions(
  projectRoot: string,
  host: NativeInstructionHost,
): Promise<boolean> {
  const source = await readTextIfExists(path.join(projectRoot, HOST_INSTRUCTIONS[host].file));
  return source !== undefined
    && !source.includes(KNOWL_GUIDANCE_START_MARKER)
    && hasActiveGuidanceImport(source);
}
```

`writeWithBackup()` already creates parent directories and writes atomically. Do not add a second file-writing path.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run:

```powershell
npm.cmd test -- tests/cli/agent-instruction-files.test.ts
```

Expected: PASS for both hosts, including preservation, migration, and rerun cases.

- [ ] **Step 5: Commit native import support**

```powershell
git add -- src/cli/agents/instruction-files.ts tests/cli/agent-instruction-files.test.ts
git commit -m "feat: install host-native Knowl imports"
```

### Task 6: Orchestrate native instructions for selected hosts

**Files:**
- Modify: `src/cli/agents/types.ts:1-39`
- Modify: `src/cli/agents/project-adapters.ts:40-107`
- Modify: `src/cli/init-flow.ts:1-105`
- Modify: `src/cli/doctor-report.ts:146-190`
- Modify: `tests/cli/agent-adapters.test.ts:83-109`
- Modify: `tests/cli/init-flow.test.ts`

- [ ] **Step 1: Write failing adapter and orchestration tests**

Extend `tests/cli/agent-adapters.test.ts`:

```ts
it('configures and verifies Claude native instructions separately from MCP', async () => {
  const claude = createClaudeCodeAdapter(environment);
  await fs.mkdir(PROJECT, { recursive: true });
  await fs.writeFile(path.join(PROJECT, 'CLAUDE.md'), 'Claude rules stay.\n');
  expect(await claude.configureInstructions!(PROJECT)).toMatchObject({ status: 'updated' });
  expect(await fs.readFile(path.join(PROJECT, 'CLAUDE.md'), 'utf8')).toContain('@KNOWL.md');
  expect(await fs.readFile(path.join(PROJECT, 'CLAUDE.md'), 'utf8')).toContain('Claude rules stay.');
  expect(await claude.verifyInstructions!(PROJECT)).toBe(true);
});
```

Extend `tests/cli/init-flow.test.ts` with an adapter whose MCP, instruction, and lifecycle calls append to an array:

```ts
it('configures MCP, native instructions, then lifecycle for a selected host', async () => {
  const calls: string[] = [];
  const adapter: AgentAdapter = {
    ...fakeAdapter('claude', { installed: true, configured: false, scope: 'project', configPath: 'mcp' }),
    configure: async () => { calls.push('mcp'); return { agent: 'claude', status: 'configured', scope: 'project', configPath: 'mcp' }; },
    verify: async () => true,
    configureInstructions: async () => { calls.push('instructions'); return { status: 'configured', configPath: 'CLAUDE.md' }; },
    verifyInstructions: async () => true,
    lifecycleCapability: async () => 'supported',
    configureLifecycle: async () => { calls.push('lifecycle'); return { agent: 'claude', status: 'configured', scope: 'project', configPath: 'hooks' }; },
    verifyLifecycle: async () => true,
  };
  const result = await runAgentInitFlow(ROOT, {
    agentNames: ['claude'], yes: true, interactive: false,
    registry: new Map([['claude', adapter]]), prompts: prompts(),
  });
  expect(calls).toEqual(['mcp', 'instructions', 'lifecycle']);
  expect(result.results[0].instructions).toMatchObject({ status: 'configured', configPath: 'CLAUDE.md' });
});
```

Add the failed-verification case:

```ts
it('keeps MCP configured but fails readiness when native instructions do not verify', async () => {
  const adapter: AgentAdapter = {
    ...fakeAdapter('claude', { installed: true, configured: false, scope: 'project', configPath: 'mcp' }),
    verify: async () => true,
    configureInstructions: async () => ({ status: 'configured', configPath: 'CLAUDE.md' }),
    verifyInstructions: async () => false,
  };
  const result = await runAgentInitFlow(ROOT, {
    agentNames: ['claude'], yes: true, interactive: false,
    registry: new Map([['claude', adapter]]), prompts: prompts(),
  });
  expect(result.results[0]).toMatchObject({
    status: 'configured',
    instructions: { status: 'failed', configPath: 'CLAUDE.md' },
  });
  expect(result.exitCode).toBe(1);
});
```

- [ ] **Step 2: Run adapter/init tests and verify RED**

Run:

```powershell
npm.cmd test -- tests/cli/agent-adapters.test.ts tests/cli/init-flow.test.ts
```

Expected: FAIL because instruction capabilities and result details do not exist.

- [ ] **Step 3: Add instruction capability types and Claude adapter methods**

Add to `src/cli/agents/types.ts`:

```ts
export interface IntegrationDetail {
  status: IntegrationStatus;
  configPath: string;
  message?: string;
}

export interface AgentInstructionAdapter {
  configureInstructions(projectRoot: string): Promise<IntegrationDetail>;
  verifyInstructions(projectRoot: string): Promise<boolean>;
}

// Add to AgentIntegrationResult:
instructions?: IntegrationDetail;

// Replace the current AgentAdapter declaration:
export interface AgentAdapter
  extends Partial<AgentLifecycleAdapter>, Partial<AgentInstructionAdapter> {
  name: AgentName;
  label: string;
  detect(projectRoot: string): Promise<AgentDetection>;
  configure(projectRoot: string): Promise<AgentIntegrationResult>;
  verify(projectRoot: string): Promise<boolean>;
}
```

In `src/cli/agents/project-adapters.ts`, change the factory signature and spread instruction methods only when present:

```ts
import {
  installKnowlHostInstructions,
  NativeInstructionHost,
  verifyKnowlHostInstructions,
} from './instruction-files.js';

function createJsonProjectAdapter(
  name: 'claude' | 'cursor' | 'gemini',
  label: string,
  command: string,
  configPath: (root: string) => string,
  environment: AgentEnvironment,
  instructionHost?: NativeInstructionHost,
): AgentAdapter {
```

Immediately before the closing brace of the existing returned adapter object, add:

```ts
...(instructionHost ? {
  async configureInstructions(root: string) {
    const status = await installKnowlHostInstructions(root, instructionHost);
    return { status, configPath: path.join(root, instructionHost === 'claude' ? 'CLAUDE.md' : 'GEMINI.md') };
  },
  async verifyInstructions(root: string) {
    return verifyKnowlHostInstructions(root, instructionHost);
  },
} : {}),
```

Replace the Claude factory call with:

```ts
export function createClaudeCodeAdapter(environment: AgentEnvironment) {
  return createJsonProjectAdapter(
    'claude',
    'Claude Code',
    'claude',
    root => path.join(root, '.mcp.json'),
    environment,
    'claude',
  );
}
```

Pass `'claude'` from `createClaudeCodeAdapter()`. Cursor passes no instruction host.

- [ ] **Step 4: Configure, verify, report, and diagnose instructions independently**

Add `IntegrationDetail` to the existing type import in `src/cli/init-flow.ts`:

```ts
import {
  AgentAdapter,
  AgentIntegrationResult,
  AgentName,
  IntegrationDetail,
} from './agents/types.js';
```

Add this helper to `src/cli/init-flow.ts`:

```ts
async function configureInstructions(adapter: AgentAdapter, projectRoot: string): Promise<IntegrationDetail | undefined> {
  if (!adapter.configureInstructions || !adapter.verifyInstructions) return undefined;
  try {
    const result = await adapter.configureInstructions(projectRoot);
    return await adapter.verifyInstructions(projectRoot)
      ? result
      : { ...result, status: 'failed', message: 'Instruction configuration verification failed' };
  } catch (error: any) {
    return { status: 'failed', configPath: projectRoot, message: error.message };
  }
}
```

After MCP verification succeeds, call `configureInstructions()` before `configureLifecycle()`, attach both details to the result, and include `instructions?.status === 'failed'` in exit-code calculation. In `formatAgentInitSummary()`, add an instruction line only when the result has that capability:

```ts
const instructions = await configureInstructions(adapter, projectRoot);
const lifecycle = await configureLifecycle(adapter, projectRoot);
results.push({ ...result, instructions, lifecycle });

const failed = results.some(result =>
  result.status === 'failed'
  || result.instructions?.status === 'failed'
  || result.lifecycle?.status === 'failed');
return { results, exitCode: failed ? 1 : 0 };
```

Replace the `formatAgentInitSummary()` row construction with:

```ts
const lines = results.flatMap(result => {
  const rows = [
    `${result.agent.padEnd(width)} MCP: ${result.status} (${result.scope})${result.message ? ` - ${result.message}` : ''}`,
  ];
  if (result.instructions) {
    rows.push(`${result.agent.padEnd(width)} instructions: ${result.instructions.status} (${result.instructions.configPath})${result.instructions.message ? ` - ${result.instructions.message}` : ''}`);
  }
  rows.push(`${result.agent.padEnd(width)} lifecycle: ${result.lifecycle?.capability ?? 'unsupported'} (${result.lifecycle?.status ?? 'skipped'})${result.lifecycle?.message ? ` - ${result.lifecycle.message}` : ''}`);
  return rows;
});
```

In `src/cli/doctor-report.ts`, add this block before lifecycle verification for an MCP-configured adapter:

```ts
if (adapter.verifyInstructions) {
  const verified = await adapter.verifyInstructions(root);
  checks.push({
    status: verified ? 'OK' : 'WARN',
    message: verified
      ? `${adapter.name} native instructions configured`
      : `${adapter.name} native instructions missing or stale`,
    fix: verified ? undefined : `run \`knowl init ${adapter.name}\``,
  });
}
```

- [ ] **Step 5: Run focused tests and verify GREEN**

Run:

```powershell
npm.cmd test -- tests/cli/agent-instruction-files.test.ts tests/cli/agent-adapters.test.ts tests/cli/init-flow.test.ts
npm.cmd run build
```

Expected: all focused tests and the build PASS.

- [ ] **Step 6: Commit instruction orchestration**

```powershell
git add -- src/cli/agents/types.ts src/cli/agents/project-adapters.ts src/cli/init-flow.ts src/cli/doctor-report.ts tests/cli/agent-adapters.test.ts tests/cli/init-flow.test.ts
git commit -m "feat: verify host-native Knowl instructions"
```

### Task 7: Add Gemini project integration and validate names before writes

**Files:**
- Modify: `src/cli/agents/types.ts:1`
- Modify: `src/cli/agents/project-adapters.ts:65-107`
- Modify: `src/cli/agents/registry.ts:1-47`
- Modify: `src/cli/agents/host-hook.ts:1-25`
- Modify: `src/index.ts:10,219-300`
- Modify: `tests/cli/agent-adapters.test.ts`
- Modify: `tests/cli/init-flow.test.ts`
- Modify: `tests/cli/host-hook.test.ts`
- Modify: `tests/cli/cli.test.ts`

- [ ] **Step 1: Write failing Gemini adapter and hook-boundary tests**

Extend `tests/cli/agent-adapters.test.ts` and include `gemini` in the fake installed-command list:

```ts
it('configures Gemini MCP and native instructions with manual lifecycle fallback', async () => {
  const gemini = createGeminiAdapter(environment);
  expect((await gemini.detect(PROJECT)).installed).toBe(true);
  await fs.mkdir(path.join(PROJECT, '.gemini'), { recursive: true });
  await writeJson(path.join(PROJECT, '.gemini', 'settings.json'), { theme: 'dark' });
  expect(await gemini.configure(PROJECT)).toMatchObject({ agent: 'gemini', status: 'configured' });
  expect(await gemini.configureInstructions!(PROJECT)).toMatchObject({ status: 'configured' });
  const settings = await readJson(path.join(PROJECT, '.gemini', 'settings.json'));
  expect(settings.theme).toBe('dark');
  expect(settings.mcpServers.knowl).toEqual({ command: 'knowl.cmd', args: ['serve'] });
  expect(await fs.readFile(path.join(PROJECT, 'GEMINI.md'), 'utf8')).toBe('@./KNOWL.md\n');
  expect(await gemini.verify(PROJECT)).toBe(true);
  expect(await gemini.verifyInstructions!(PROJECT)).toBe(true);
  expect(await gemini.lifecycleCapability!(PROJECT)).toBe('unsupported');
});

it('accepts Gemini as an explicit agent name', () => {
  expect(parseAgentNames(['gemini'])).toEqual(['gemini']);
});
```

Add to `tests/cli/host-hook.test.ts`:

```ts
it('does not treat Gemini MCP support as a verified lifecycle hook host', () => {
  expect(() => normalizeHostHook('gemini', 'SessionStart', {})).toThrow('Unsupported hook host: gemini');
});
```

In `tests/cli/init-flow.test.ts`, import `formatAgentInitSummary` and assert the Gemini fallback is explicit:

```ts
expect(formatAgentInitSummary([{
  agent: 'gemini',
  status: 'configured',
  scope: 'project',
  configPath: '.gemini/settings.json',
  instructions: { status: 'configured', configPath: 'GEMINI.md' },
  lifecycle: { capability: 'unsupported', status: 'skipped', message: 'Lifecycle hooks are unavailable; use `knowl task run`.' },
}])).toContain('use `knowl task run`');
```

- [ ] **Step 2: Write the failing validation-before-write CLI test**

In `tests/cli/cli.test.ts`, create a fresh directory, invoke `init unknown --yes`, and assert no artifacts exist:

```ts
it('rejects an unsupported explicit agent before base init writes', async () => {
  const root = path.resolve('.knowl-cli-invalid-agent-test');
  await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  await fs.mkdir(root, { recursive: true });
  expect(() => execFileSync(process.execPath, [CLI_PATH, 'init', 'unknown', '--yes'], {
    cwd: root, encoding: 'utf8', stdio: 'pipe',
  })).toThrow();
  for (const entry of ['.knowl', '.gitignore', 'KNOWL.md', 'AGENTS.md', 'CLAUDE.md', 'GEMINI.md']) {
    await expect(fs.access(path.join(root, entry))).rejects.toMatchObject({ code: 'ENOENT' });
  }
  await fs.rm(root, { recursive: true, force: true });
});
```

Add this creation-policy matrix:

```ts
it.each([
  { name: 'base', agents: [], present: ['KNOWL.md', 'AGENTS.md'], absent: ['CLAUDE.md', 'GEMINI.md'] },
  { name: 'claude', agents: ['claude'], present: ['KNOWL.md', 'AGENTS.md', 'CLAUDE.md'], absent: ['GEMINI.md'] },
  { name: 'gemini', agents: ['gemini'], present: ['KNOWL.md', 'AGENTS.md', 'GEMINI.md', '.gemini/settings.json'], absent: ['CLAUDE.md'] },
])('applies the $name host-file creation policy', async ({ name, agents, present, absent }) => {
  const root = path.resolve(`.knowl-cli-creation-${name}-test`);
  await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  await fs.mkdir(root, { recursive: true });
  execFileSync(process.execPath, [CLI_PATH, 'init', ...agents, '--yes'], { cwd: root, encoding: 'utf8' });
  for (const entry of present) await expect(fs.access(path.join(root, entry))).resolves.toBeUndefined();
  for (const entry of absent) await expect(fs.access(path.join(root, entry))).rejects.toMatchObject({ code: 'ENOENT' });
  await fs.rm(root, { recursive: true, force: true });
});
```

Add a doctor case for a configured Claude MCP entry with a stale native file:

```ts
it('doctor reports selected native instructions that are missing or stale', async () => {
  const root = path.resolve('.knowl-cli-stale-claude-instructions-test');
  await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  await fs.mkdir(root, { recursive: true });
  execFileSync(process.execPath, [CLI_PATH, 'init', 'claude', '--yes'], { cwd: root, encoding: 'utf8' });
  await fs.writeFile(path.join(root, 'CLAUDE.md'), 'No active Knowl import.\n');
  const result = spawnSync(process.execPath, [CLI_PATH, 'doctor'], { cwd: root, encoding: 'utf8' });
  expect(result.status).toBe(1);
  expect(result.stdout).toContain('[WARN] claude native instructions missing or stale');
  expect(result.stdout).toContain('run `knowl init claude`');
  await fs.rm(root, { recursive: true, force: true });
});
```

Add `spawnSync` to the existing `node:child_process` import in this test file.

- [ ] **Step 3: Run focused tests and verify RED**

Run:

```powershell
npm.cmd run build
npm.cmd test -- tests/cli/agent-adapters.test.ts tests/cli/init-flow.test.ts tests/cli/host-hook.test.ts tests/cli/cli.test.ts
```

Expected: FAIL because Gemini is unsupported and invalid explicit names are parsed only after base files are written.

- [ ] **Step 4: Implement Gemini without widening lifecycle hooks**

Extend `AgentName` in `src/cli/agents/types.ts`:

```ts
export type AgentName = 'codex' | 'claude' | 'cursor' | 'gemini' | 'claude-desktop';
```

Make the lifecycle host union explicit in `src/cli/agents/host-hook.ts`:

```ts
export type HookHost = 'codex' | 'claude' | 'cursor' | 'claude-desktop' | 'generic';
```

Widen the private JSON adapter factory to accept `gemini`, then export:

```ts
export function createGeminiAdapter(environment: AgentEnvironment) {
  return createJsonProjectAdapter(
    'gemini',
    'Gemini CLI',
    'gemini',
    root => path.join(root, '.gemini', 'settings.json'),
    environment,
    'gemini',
  );
}
```

Keep lifecycle support restricted with these existing branches after widening the factory:

```ts
async lifecycleCapability() { return name === 'claude' ? 'supported' : 'unsupported'; },
async configureLifecycle(root) {
  if (name !== 'claude') return unsupportedLifecycleResult(name, 'project', configPath(root));
  const pathname = lifecyclePath(root);
  const status = await mergeNestedHookConfig(pathname, environment.platform, 'claude');
  return { agent: name, status, scope: 'project', configPath: pathname };
},
async verifyLifecycle(root) {
  return name === 'claude' && verifyNestedHookConfig(lifecyclePath(root), environment.platform, 'claude');
},
```

In `src/cli/agents/registry.ts`, import the Gemini factory and use:

```ts
export const SUPPORTED_AGENT_NAMES: AgentName[] = ['codex', 'claude', 'cursor', 'gemini', 'claude-desktop'];

return new Map([
  ['codex', createCodexAdapter(environment)],
  ['claude', createClaudeCodeAdapter(environment)],
  ['cursor', createCursorAdapter(environment)],
  ['gemini', createGeminiAdapter(environment)],
  ['claude-desktop', createClaudeDesktopAdapter(environment)],
]);
```

- [ ] **Step 5: Validate explicit names at the start of the init action**

Import `parseAgentNames` into `src/index.ts`. Before `fs.access`, upgrade, directory creation, config/database work, guidance, or `.gitignore` writes, run:

```ts
const validatedAgents = parseAgentNames(agents);
```

Pass `validatedAgents` to both `runAgentInitFlow()` branches. Keep `runAgentInitFlow()`'s own parsing as a defensive boundary.

- [ ] **Step 6: Rebuild and verify GREEN**

Run:

```powershell
npm.cmd run build
npm.cmd test -- tests/cli/agent-instruction-files.test.ts tests/cli/agent-adapters.test.ts tests/cli/init-flow.test.ts tests/cli/host-hook.test.ts tests/cli/cli.test.ts
```

Expected: PASS. Gemini config/import are idempotent, lifecycle remains unsupported with `knowl task run`, and invalid names leave no files.

- [ ] **Step 7: Commit Gemini and pre-write validation**

```powershell
git add -- src/cli/agents/types.ts src/cli/agents/project-adapters.ts src/cli/agents/registry.ts src/cli/agents/host-hook.ts src/index.ts tests/cli/agent-adapters.test.ts tests/cli/init-flow.test.ts tests/cli/host-hook.test.ts tests/cli/cli.test.ts
git commit -m "feat: add Gemini project integration"
```

### Task 8: Add the repository-independent Claude reminder command

**Files:**
- Create: `src/cli/agents/reminder.ts`
- Create: `tests/cli/agent-reminder.test.ts`
- Modify: `src/index.ts:964-990`

- [ ] **Step 1: Write failing process-level reminder tests**

Create `tests/cli/agent-reminder.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { KNOWL_CLAUDE_OPERATIONAL_CARD } from '../../src/core/knowl-guidance.js';

const CLI_PATH = path.resolve('./dist/index.js');
let outsideRoot: string;

const run = (input?: string) => execFileSync(
  process.execPath,
  [CLI_PATH, 'agent-reminder', 'claude', '--json'],
  { cwd: outsideRoot, encoding: 'utf8', input },
);

describe('Claude prompt reminder', () => {
  beforeAll(async () => {
    outsideRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'knowl-agent-reminder-'));
  });
  afterAll(() => fs.rm(outsideRoot, { recursive: true, force: true }));

  it('emits the exact non-blocking Claude hook response outside a Knowl project', async () => {
    expect(JSON.parse(run())).toEqual({
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: KNOWL_CLAUDE_OPERATIONAL_CARD,
      },
    });
    expect(await fs.readdir(outsideRoot)).toEqual([]);
  });

  it('does not consume malformed or secret-looking stdin', () => {
    const baseline = run();
    expect(run('{')).toBe(baseline);
    expect(run('sk-test-abcdefghijklmnopqrstuvwxyz123456')).toBe(baseline);
  });
});
```

- [ ] **Step 2: Build, run the test, and verify RED**

Run:

```powershell
npm.cmd run build
npm.cmd test -- tests/cli/agent-reminder.test.ts
```

Expected: FAIL because Commander reports `unknown command 'agent-reminder'`.

- [ ] **Step 3: Implement the fixed output without lifecycle or repository dependencies**

Create `src/cli/agents/reminder.ts`:

```ts
import { KNOWL_CLAUDE_OPERATIONAL_CARD } from '../../core/knowl-guidance.js';

export interface ClaudePromptReminderOutput {
  hookSpecificOutput: {
    hookEventName: 'UserPromptSubmit';
    additionalContext: string;
  };
}

export function createAgentReminderOutput(host: string): ClaudePromptReminderOutput {
  if (host !== 'claude') throw new Error(`Unsupported reminder host: ${host}`);
  return {
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: KNOWL_CLAUDE_OPERATIONAL_CARD,
    },
  };
}
```

Import the new factory in `src/index.ts`:

```ts
import { createAgentReminderOutput } from './cli/agents/reminder.js';
```

Register a sibling command immediately before `agent-hook` in `src/index.ts`:

```ts
program
  .command('agent-reminder')
  .description('Emit fixed workflow guidance for an agent host prompt hook')
  .argument('<host>', 'claude')
  .option('--json')
  .action(host => {
    try {
      console.log(JSON.stringify(createAgentReminderOutput(host)));
    } catch (error: any) {
      console.error(`Error emitting agent reminder: ${error.message}`);
      process.exit(1);
    }
  });
```

The valid path must not call `readLifecyclePayload`, `findProjectRoot`, config/database functions, session functions, or `normalizeHostHook`.

- [ ] **Step 4: Rebuild and verify GREEN**

Run:

```powershell
npm.cmd run build
npm.cmd test -- tests/cli/agent-reminder.test.ts
```

Expected: PASS; the output is identical for empty, malformed, and secret-looking stdin.

- [ ] **Step 5: Commit the dedicated command**

```powershell
git add -- src/cli/agents/reminder.ts src/index.ts tests/cli/agent-reminder.test.ts
git commit -m "feat: add Claude prompt reminder command"
```

### Task 9: Install and safely migrate the Claude `UserPromptSubmit` hook

**Files:**
- Modify: `src/cli/agents/hook-config.ts:3-108`
- Modify: `tests/cli/agent-adapters.test.ts:115-223`

- [ ] **Step 1: Write failing default-on and mixed-handler migration tests**

In the lifecycle-configuration test in `tests/cli/agent-adapters.test.ts`, assert the canonical reminder:

```ts
expect(claudeSettings.hooks.UserPromptSubmit).toContainEqual({
  hooks: [{
    type: 'command',
    command: 'knowl.cmd agent-reminder claude --json',
    timeout: 30,
    statusMessage: '',
  }],
});
```

In that same existing lifecycle-configuration test, replace its old “every Knowl command is `agent-hook`” block with:

```ts
const knowlCommands = collectHookCommands(codexHooks, claudeSettings, cursorHooks)
  .filter(command => command.includes('knowl'));
expect(knowlCommands.length).toBeGreaterThan(0);
for (const command of knowlCommands) {
  expect(command.includes('agent-hook') || command.includes('agent-reminder')).toBe(true);
  expect(command).not.toContain('serve');
}
```

Do not retain the former `expect(command).toContain('agent-hook')` assertion; the Claude reminder is intentionally a distinct Knowl command identity.

Replace the retired-hook fixture with a mixed matcher entry:

```ts
const userHandler = {
  type: 'command',
  command: 'user-hook',
  timeout: 7,
  statusMessage: 'User hook',
  custom: 'preserve',
};

await writeJson(path.join(PROJECT, '.claude', 'settings.local.json'), {
  hooks: {
    UserPromptSubmit: [{
      matcher: 'custom',
      description: 'preserve matcher metadata',
      hooks: [
        userHandler,
        { type: 'command', command: 'knowl.cmd agent-hook claude UserPromptSubmit --json', timeout: 30, statusMessage: '' },
        { type: 'command', command: 'knowl.cmd agent-reminder claude --json', timeout: 3, statusMessage: 'stale' },
      ],
    }],
  },
});
```

After `configureLifecycle()`:

```ts
const saved = await readJson(path.join(PROJECT, '.claude', 'settings.local.json'));
expect(saved.hooks.UserPromptSubmit[0]).toEqual({
  matcher: 'custom',
  description: 'preserve matcher metadata',
  hooks: [userHandler],
});
const reminderHandlers = saved.hooks.UserPromptSubmit
  .flatMap((entry: any) => entry.hooks)
  .filter((hook: any) => hook.command?.includes(' agent-reminder claude '));
expect(reminderHandlers).toEqual([{
  type: 'command',
  command: 'knowl.cmd agent-reminder claude --json',
  timeout: 30,
  statusMessage: '',
}]);
expect(await claude.configureLifecycle(PROJECT)).toMatchObject({ status: 'unchanged' });
```

Keep the existing Codex retired-prompt fixture and add these exact assertions:

```ts
expect(codexHooks.hooks.UserPromptSubmit).toEqual([
  { matcher: '.*', hooks: [{ type: 'command', command: 'user-hook' }] },
]);
expect(JSON.stringify(codexHooks)).not.toContain('agent-reminder');

for (const command of collectHookCommands(codexHooks, saved, cursorHooks)
  .filter(command => command.includes('knowl'))) {
  expect(command.includes('agent-hook') || command.includes('agent-reminder')).toBe(true);
  expect(command).not.toContain('serve');
}
```

- [ ] **Step 2: Run the adapter test and verify RED**

Run:

```powershell
npm.cmd test -- tests/cli/agent-adapters.test.ts
```

Expected: FAIL because Claude has no prompt reminder and the current cleanup drops an entire mixed matcher entry.

- [ ] **Step 3: Add distinct reminder identity and handler-level filtering**

In `src/cli/agents/hook-config.ts`, keep `CLAUDE_HOOK_EVENTS` capture-only and add:

```ts
const CLAUDE_PROMPT_EVENT = 'UserPromptSubmit';

export function knowlReminderCommand(platform: NodeJS.Platform, host: 'claude'): string {
  const executable = platform === 'win32' ? 'knowl.cmd' : 'knowl';
  return `${executable} agent-reminder ${host} --json`;
}

const ownsReminderCommand = (value: unknown) =>
  typeof value === 'string' && value.includes(' agent-reminder claude ');

type PromptEntry = { hooks: NestedHook[] };

function reminderEntry(platform: NodeJS.Platform): PromptEntry {
  return {
    hooks: [{
      type: 'command',
      command: knowlReminderCommand(platform, 'claude'),
      timeout: 30,
      statusMessage: '',
    }],
  };
}
```

`UserPromptSubmit` always fires and does not support matchers, so the canonical reminder entry deliberately omits `matcher`. Preserve matcher metadata on pre-existing user entries during migration even though Claude ignores it for this event.

Replace whole-entry ownership filtering with a helper that preserves entry metadata and user handlers:

```ts
function removeOwnedNestedHandlers(
  entries: Record<string, any>[],
  owns: (command: unknown) => boolean,
): { entries: Record<string, any>[]; removed: boolean } {
  let removed = false;
  const retained = entries.flatMap(entry => {
    if (!Array.isArray(entry.hooks)) return [entry];
    const hooks = entry.hooks.filter((hook: Record<string, unknown>) => {
      const owned = owns(hook.command);
      removed ||= owned;
      return !owned;
    });
    if (hooks.length === entry.hooks.length) return [entry];
    return hooks.length > 0 ? [{ ...entry, hooks }] : [];
  });
  return { entries: retained, removed };
}
```

Use it for every lifecycle event so mixed user/lifecycle entries are safe too. For `UserPromptSubmit`, remove both legacy `agent-hook <host>` handlers and, for Claude, stale reminder handlers. Retain user entries; append exactly one `reminderEntry()` for Claude and none for Codex.

Replace the two nested-event merge loops with this concrete sequence:

```ts
for (const event of events) {
  const current = Array.isArray(hooks[event]) ? hooks[event] as Record<string, any>[] : [];
  const filtered = removeOwnedNestedHandlers(current, command => ownsCommand(command, host));
  hadOwnEntry ||= filtered.removed;
  nextHooks[event] = [...filtered.entries, nestedEntry(platform, host, event)];
}

const promptCurrent = Array.isArray(hooks[CLAUDE_PROMPT_EVENT])
  ? hooks[CLAUDE_PROMPT_EVENT] as Record<string, any>[]
  : [];
const withoutLegacy = removeOwnedNestedHandlers(
  promptCurrent,
  command => ownsCommand(command, host),
);
hadOwnEntry ||= withoutLegacy.removed;
const withoutReminder = host === 'claude'
  ? removeOwnedNestedHandlers(withoutLegacy.entries, ownsReminderCommand)
  : { entries: withoutLegacy.entries, removed: false };
hadOwnEntry ||= withoutReminder.removed;
const promptNext = host === 'claude'
  ? [...withoutReminder.entries, reminderEntry(platform)]
  : withoutReminder.entries;
if (promptNext.length > 0) nextHooks[CLAUDE_PROMPT_EVENT] = promptNext;
else delete nextHooks[CLAUDE_PROMPT_EVENT];
```

- [ ] **Step 4: Strengthen verification against missing or altered reminders**

In `verifyNestedHookConfig()`, retain exact lifecycle verification and add:

```ts
const promptEntries = Array.isArray(config.hooks?.[CLAUDE_PROMPT_EVENT])
  ? config.hooks[CLAUDE_PROMPT_EVENT]
  : [];
const promptHandlers = promptEntries.flatMap((entry: any) => Array.isArray(entry.hooks) ? entry.hooks : []);
const noRetiredPromptHandler = !promptHandlers.some((hook: any) => ownsCommand(hook.command, host));
const reminderHandlers = promptHandlers.filter((hook: any) => ownsReminderCommand(hook.command));
const promptValid = host === 'claude'
  ? reminderHandlers.length === 1 && promptEntries.some((entry: unknown) => equal(entry, reminderEntry(platform)))
  : reminderHandlers.length === 0;
```

Return `captureEventsValid && noRetiredPromptHandler && promptValid`. In the test, mutate the reminder command, timeout, and `statusMessage` one at a time and expect `verifyLifecycle()` to return `false` for each mutation.

Use this mutation loop so each field is independently verified:

```ts
const canonical = await readJson(path.join(PROJECT, '.claude', 'settings.local.json'));
for (const [field, value] of [
  ['command', 'knowl.cmd agent-reminder claude --wrong'],
  ['timeout', 3],
  ['statusMessage', 'noisy'],
] as const) {
  const altered = structuredClone(canonical);
  const entry = altered.hooks.UserPromptSubmit.find((candidate: any) =>
    candidate.hooks?.some((hook: any) => hook.command?.includes(' agent-reminder claude ')));
  entry.hooks[0][field] = value;
  await writeJson(path.join(PROJECT, '.claude', 'settings.local.json'), altered);
  expect(await claude.verifyLifecycle(PROJECT)).toBe(false);
}
await writeJson(path.join(PROJECT, '.claude', 'settings.local.json'), canonical);
```

- [ ] **Step 5: Run focused hook and command tests and verify GREEN**

Run:

```powershell
npm.cmd test -- tests/cli/agent-adapters.test.ts tests/cli/agent-reminder.test.ts tests/cli/agent-lifecycle.test.ts
npm.cmd run build
```

Expected: all tests and build PASS. Existing lifecycle capture remains unchanged; Claude has one quiet prompt-time card.

- [ ] **Step 6: Commit hook installation and migration**

```powershell
git add -- src/cli/agents/hook-config.ts tests/cli/agent-adapters.test.ts
git commit -m "feat: install Claude prompt workflow hook"
```

### Task 10: Document the complete workflow and run automated verification

**Files:**
- Modify: `README.md:70-225`
- Modify: `tests/core/knowl-guidance.test.ts`

- [ ] **Step 1: Write a failing README completeness test**

Add these imports to `tests/core/knowl-guidance.test.ts`:

```ts
import fs from 'node:fs/promises';
import path from 'node:path';
```

Then add:

```ts
it('documents every canonical MCP tool in the README table', async () => {
  const readme = await fs.readFile(path.resolve('README.md'), 'utf8');
  const documentedTools = [...readme.matchAll(/^\| \`(knowl_[a-z_]+)\` \|/gm)]
    .map(match => match[1]);
  expect(documentedTools).toEqual([...KNOWL_MCP_TOOL_NAMES]);
  expect(new Set(documentedTools).size).toBe(24);
  expect(readme).toContain('KNOWL.md');
  expect(readme).toContain('GEMINI.md');
  expect(readme).toContain('agent-reminder claude --json');
  expect(readme).toContain('previewed maintenance after explicit approval');
});
```

- [ ] **Step 2: Run the documentation test and verify RED**

Run:

```powershell
npm.cmd test -- tests/core/knowl-guidance.test.ts
```

Expected: FAIL because README omits seven tools, `KNOWL.md`/`GEMINI.md`, and the reminder command.

- [ ] **Step 3: Rewrite the setup and lifecycle documentation**

Update README with these concrete rules:

- `KNOWL.md` is the canonical full workflow; base init/upgrade refreshes it and the synchronized managed section in `AGENTS.md`.
- Selected Claude and Gemini integrations use native imports; an existing `AGENTS.md` import counts and is preserved.
- MCP initialization publishes the host-neutral compact card.
- Claude's default-on `UserPromptSubmit` hook injects the corresponding fixed card but never reads the prompt, locates a project, opens the database, or creates/captures a session.
- `SessionStart` is the sole automatic **retrieved-memory** injection, not the sole model-facing context injection.
- Verified lifecycle hooks and a manual task work loop are mutually exclusive for one task.
- Gemini uses `.gemini/settings.json`, loads `GEMINI.md`, and retains `knowl task run` / MCP task tools as its manual lifecycle fallback.
- A new host session is required after rerunning init.
- Noninteractive init without explicit host names creates base guidance but no host-specific files.

Change setup examples to include:

```bash
knowl init codex claude cursor gemini
```

Add `knowl agent-reminder claude --json` to the internal CLI table and replace the 17-row MCP table with all 24 rows:

```markdown
| Tool | Purpose |
| --- | --- |
| `knowl_query` | Focused 2-6-keyword retrieval before project work and area changes. |
| `knowl_recent` | Recent context only without lifecycle bootstrap or for explicit refresh. |
| `knowl_state` | Broad active project-memory status. |
| `knowl_context` | Diversified token-budgeted context pack. |
| `knowl_task_start` | Start one manual resumable work loop and return relevant memory/task ID. |
| `knowl_task_checkpoint` | Record meaningful progress or a blocker in that manual loop. |
| `knowl_task_finish` | Finish that manual loop exactly once after verification. |
| `knowl_store` | Store one verified structured knowledge atom. |
| `knowl_ingest_atoms` | Store a batch of verified structured atoms. |
| `knowl_decide` | Record a confirmed decision and reasoning. |
| `knowl_update` | Correct, refresh, or supersede stale knowledge. |
| `knowl_timeline` | Inspect immutable item assertions. |
| `knowl_evidence_list` | Inspect evidence linked to an item. |
| `knowl_conflicts` | Inspect active exclusive conflict identities. |
| `knowl_feedback` | Record feedback after actual retrieval use or correction. |
| `knowl_skill_list` | Discover learned file-backed skills. |
| `knowl_skill_read` | Inspect a learned skill package before use. |
| `knowl_skill_run` | Run a trusted matching skill entrypoint. |
| `knowl_skill_create` | Create a learned skill only when explicitly requested. |
| `knowl_ingest` | Explicit AI-backed raw-source ingestion; never silent prompt ingestion. |
| `knowl_synthesize` | Explicitly refresh one scoped evidence-backed understanding. |
| `knowl_session_finish` | Finish/promote an explicitly owned manual memory session. |
| `knowl_gc_preview` | Preview maintenance without mutation. |
| `knowl_gc_apply` | Apply previewed maintenance after explicit approval. |
```

- [ ] **Step 4: Run focused documentation and integration tests**

Run:

```powershell
npm.cmd run build
npm.cmd test -- tests/core/knowl-guidance.test.ts tests/core/agents-guidance.test.ts tests/mcp/server.test.ts tests/cli/agent-instruction-files.test.ts tests/cli/agent-reminder.test.ts tests/cli/agent-adapters.test.ts tests/cli/agent-lifecycle.test.ts tests/cli/init-flow.test.ts tests/cli/host-hook.test.ts tests/cli/cli.test.ts --maxWorkers=1
```

Expected: all listed tests PASS.

- [ ] **Step 5: Run the complete verification gate**

Run fresh, in this order:

```powershell
npm.cmd test -- --maxWorkers=1
npm.cmd run build
git diff --check
git status --short
```

Expected: the full Vitest suite reports zero failures, build exits `0`, diff check emits no errors, and the pre-existing `.gitignore` modification remains unstaged.

- [ ] **Step 6: Commit documentation after the green gate**

```powershell
git add -- README.md tests/core/knowl-guidance.test.ts
git commit -m "docs: explain complete Knowl host workflow"
```

### Task 11: Benchmark the hook and verify DuckPrep behavior

**Files:**
- Validate only: `D:/coding/knowl/dist/index.js`
- Additively update through init: `D:/coding/DuckPrep-server/KNOWL.md`, `AGENTS.md`, `.claude/settings.local.json`
- Preserve accepted existing path: `D:/coding/DuckPrep-server/CLAUDE.md` (`@AGENTS.md`)
- Verify unchanged: `D:/coding/DuckPrep-server/.gitignore` (it already contains `.knowl/`) and `.mcp.json` (it already has the canonical Knowl entry)
- Preserve all unrelated DuckPrep changes, including the currently untracked `prompts/` directory

- [ ] **Step 1: Confirm the global executable points at this checkout and rebuild**

Run:

```powershell
Set-Location D:\coding\knowl
$knowlLink = Get-Item C:\Users\Admin\AppData\Roaming\npm\node_modules\knowl
if ($knowlLink.Target -notcontains 'D:\coding\knowl') { throw 'Global knowl.cmd is not linked to this checkout.' }
npm.cmd run build
```

Expected: build exits `0`; the junction target is `D:\coding\knowl`.

- [ ] **Step 2: Benchmark cold/warm launches and enforce the payload budget**

Run:

```powershell
$knowlExe = (Get-Command knowl.cmd).Source
$serveBefore = @(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'knowl.*serve' }).Count
$coldMs = (Measure-Command { & $knowlExe agent-reminder claude --json | Out-Null }).TotalMilliseconds
& $knowlExe agent-reminder claude --json | Out-Null
$samples = 1..100 | ForEach-Object {
  (Measure-Command { & $knowlExe agent-reminder claude --json | Out-Null }).TotalMilliseconds
}
$sorted = @($samples | Sort-Object)
$response = & $knowlExe agent-reminder claude --json | ConvertFrom-Json
$card = $response.hookSpecificOutput.additionalContext
$estimatedTokens = [Math]::Ceiling($card.Length / 4)
$serveAfter = @(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'knowl.*serve' }).Count
$lingeringReminder = @(Get-CimInstance Win32_Process | Where-Object {
  $_.Name -match '^(node|cmd)(\.exe)?$' -and $_.CommandLine -match 'agent-reminder claude --json'
}).Count
$report = [pscustomobject]@{
  ColdMs = $coldMs
  WarmMean = ($samples | Measure-Object -Average).Average
  WarmP50 = $sorted[[Math]::Floor($sorted.Count * 0.50)]
  WarmP95 = $sorted[[Math]::Ceiling($sorted.Count * 0.95) - 1]
  CardCharacters = $card.Length
  CardTokens = $estimatedTokens
  TwentyPrompts = 20 * $estimatedTokens
  ServeProcessesBefore = $serveBefore
  ServeProcessesAfter = $serveAfter
  LingeringReminderProcesses = $lingeringReminder
}
$report | Format-List
if ($card.Length -ge 2000 -or $estimatedTokens -gt 500 -or (20 * $estimatedTokens) -gt 10000) {
  throw 'Prompt reminder exceeds the approved context budget.'
}
if ($serveAfter -ne $serveBefore) { throw 'Reminder launches changed persistent knowl serve processes.' }
if ($lingeringReminder -ne 0) { throw 'A prompt-reminder process remained after the benchmark.' }
```

Expected: the budget checks pass, no reminder process lingers, and the result is reported rather than asserted against a timing threshold.

- [ ] **Step 3: Apply the built integration to DuckPrep and inspect the exact additive diff**

Run:

```powershell
Set-Location D:\coding\DuckPrep-server
$auditFiles = @('AGENTS.md', 'CLAUDE.md', '.claude/settings.local.json', '.mcp.json', '.gitignore')
$beforeContent = @{}
foreach ($file in $auditFiles) {
  $beforeContent[$file] = if (Test-Path -LiteralPath $file) { Get-Content -Raw -LiteralPath $file } else { $null }
}
$before = git status --short
$before
knowl.cmd init claude --yes
$after = git status --short
$after
git diff -- .gitignore KNOWL.md AGENTS.md CLAUDE.md .claude/settings.local.json .mcp.json
foreach ($file in $auditFiles) {
  $current = if (Test-Path -LiteralPath $file) { Get-Content -Raw -LiteralPath $file } else { $null }
  if ($beforeContent[$file] -ne $current) {
    "Changed: $file"
    $beforeLines = if ($null -eq $beforeContent[$file]) { @() } else { @($beforeContent[$file] -split '\r?\n') }
    $afterLines = if ($null -eq $current) { @() } else { @($current -split '\r?\n') }
    Compare-Object -ReferenceObject $beforeLines -DifferenceObject $afterLines
  }
}
Get-Content -Raw KNOWL.md
$settings = Get-Content -Raw .claude\settings.local.json | ConvertFrom-Json
$beforeSettingsOutsideHooks = $beforeContent['.claude/settings.local.json'] | ConvertFrom-Json
$afterSettingsOutsideHooks = Get-Content -Raw .claude\settings.local.json | ConvertFrom-Json
$beforeSettingsOutsideHooks.PSObject.Properties.Remove('hooks')
$afterSettingsOutsideHooks.PSObject.Properties.Remove('hooks')
if (($beforeSettingsOutsideHooks | ConvertTo-Json -Depth 100 -Compress) -ne ($afterSettingsOutsideHooks | ConvertTo-Json -Depth 100 -Compress)) {
  throw 'DuckPrep Claude settings outside hooks changed.'
}
$reminders = @($settings.hooks.UserPromptSubmit | ForEach-Object { $_.hooks } | Where-Object { $_.command -match ' agent-reminder claude ' })
if ($reminders.Count -ne 1) { throw "Expected one Claude reminder, found $($reminders.Count)." }
if ($reminders[0].statusMessage -ne '') { throw 'Claude reminder statusMessage must be empty.' }
if ($beforeContent['CLAUDE.md'] -ne (Get-Content -Raw CLAUDE.md)) { throw 'DuckPrep CLAUDE.md changed.' }
if ((Get-Content -Raw CLAUDE.md).Trim() -ne '@AGENTS.md') { throw 'DuckPrep existing AGENTS import is invalid.' }
if ($beforeContent['.mcp.json'] -ne (Get-Content -Raw .mcp.json)) { throw 'DuckPrep .mcp.json changed unexpectedly.' }
if ($beforeContent['.gitignore'] -ne (Get-Content -Raw .gitignore)) { throw 'DuckPrep .gitignore changed unexpectedly.' }
$managedPattern = '(?s)<!-- KNOWL_PROJECT_MEMORY -->.*?<!-- /KNOWL_PROJECT_MEMORY -->'
$agentsBeforeOutside = [regex]::Replace($beforeContent['AGENTS.md'], $managedPattern, '<KNOWL_MANAGED>').Trim()
$agentsAfterOutside = [regex]::Replace((Get-Content -Raw AGENTS.md), $managedPattern, '<KNOWL_MANAGED>').Trim()
if ($agentsBeforeOutside -ne $agentsAfterOutside) { throw 'DuckPrep AGENTS.md content outside the managed section changed.' }
knowl.cmd doctor
```

The in-memory comparison is required because DuckPrep intentionally ignores `AGENTS.md`, `CLAUDE.md`, and `.claude/`, so ordinary `git diff` cannot display those files. Expected: `KNOWL.md` is created/refreshed, `AGENTS.md` has the synchronized managed section, `CLAUDE.md` keeps `@AGENTS.md`, `.mcp.json` stays valid, `.gitignore` remains unchanged because `.knowl/` is already present, one canonical reminder is installed, and all unrelated preflight changes remain.

- [ ] **Step 4: Verify three fresh Claude sessions and all routing groups**

This is a host-observed acceptance gate. Start a new trusted Claude Code session after init. In each of three fresh sessions, submit:

```text
Trace how this server validates authentication and identify the responsible files.
```

For each session, record that the first project action is either use of a directly relevant active lifecycle hit or `knowl_query` with 2-6 keywords before repository tools. Confirm Claude never calls `knowl_task_start`, `knowl_task_checkpoint`, `knowl_task_finish`, or `knowl_session_finish` while its verified hooks are active.

In one fresh session, without telling Claude to read an instruction file, submit:

```text
Without opening repository files, map the Knowl tool you would use for: a focused fact; broad state; a manual resumable task when hooks are unavailable; two durable atoms; evidence/history/conflict feedback; a learned skill; and explicit maintenance. Include the safety gate for each special or mutating tool.
```

Expected: the answer correctly covers all seven routing groups and their gates. Then submit `What is 2 + 2?` and confirm it causes no Knowl retrieval.

- [ ] **Step 5: Measure host-observed 20-prompt context growth**

In a fresh Claude session, record `/context`, submit twenty short benign prompts, then record `/context` again. Report separately:

1. Fixed card payload: `20 * CardTokens` from Step 2, at most 10,000 estimated tokens.
2. Any Claude hook wrapper/replay overhead visible in `/context`.
3. Ordinary conversation growth, which is not attributed to Knowl.

Do not claim the acceptance gate passed without the observed before/after evidence. Do not commit DuckPrep changes from this plan; hand its exact diff back to the user.

---

## Final completion checklist

- [ ] Every changed production line traces to the approved design.
- [ ] `tools/list`, full guidance, both compact cards, and README cover the same exact 24-tool set.
- [ ] The Claude and host-neutral cards differ only in the lifecycle mode line and remain below 2,000 characters.
- [ ] Base init always manages `KNOWL.md` and `AGENTS.md`; host-specific files appear only for selected hosts.
- [ ] User-authored content and mixed hook handlers survive migration.
- [ ] Automatic lifecycle and manual task/session modes never overlap.
- [ ] Reminder execution never reads stdin/prompt data or touches project/database/session state.
- [ ] Focused tests, full suite, build, diff check, benchmark, and DuckPrep acceptance evidence are recorded.
