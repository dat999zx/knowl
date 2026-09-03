# Harness Integrations (DeepSeek harness, OpenClaw, Hermes) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `knowl init deepseek|openclaw|hermes` gives each harness the MCP tool surface plus automatic lifecycle capture through the existing `knowl agent-hook` entry, at the same capability level Claude Code has.

**Architecture:** Each host is one `HookHost` value, one `HostProfile` in `src/session/hosts/`, and one adapter `knowl init` drives. dsh consumes Claude-format hooks directly, so it is a `hookHostSpecs` row. OpenClaw and Hermes run in-process plugins, so each gets a shipped translator under `integrations/<host>/` that maps the harness's events onto `knowl agent-hook <host> <event> --json` — exactly what `integrations/cline/knowl-plugin.mjs` does. A new `yaml` merge target covers the two user-owned YAML config files.

**Tech Stack:** TypeScript (ESM, tsup bundle), vitest, `yaml` (npm, currently a transitive dep), Node `child_process`, Python 3 stdlib (Hermes plugin only).

**Spec:** `docs/superpowers/specs/2026-09-03-harness-integrations-design.md`

## Global Constraints

- Capability is expressed by return value: a profile member that has not been verified is absent, never a flag set to true. Read `src/session/hosts/profile.ts` before writing a profile.
- A hook failure must allow the action. Plugins never throw into the host; the `agent-hook` process is the only place a refusal is computed.
- User-owned config files are merged, never overwritten: YAML/JSON that fails to parse is left alone and reported.
- Windows spawns `knowl.cmd`, everything else `knowl` (`knowlHookCommand` in `hook-config.ts` is the existing rule).
- Never call `knowl_task_*` lifecycle tools from this work; Claude hooks own the session.
- Verify before claiming done: `npm run build`, `npm test`, `npx eslint .` (the repo's "Verify Knowl code changes before completion" skill).
- `CHANGELOG.md` has no `## Unreleased` heading right now (the release commit renames it). Task 10 creates it.
- Commit after every task, on a feature branch `feat/harness-integrations` off `main`.

## Execution order — Hermes ships first

The maintainer needs Hermes out quickly. Every task adds only its own host's type values, so the
phases are independent and Phase A is releasable on its own.

- **Phase A (Hermes, ship it):** Task 0 → Task 1 → Task 7 → Task 8 → Task 9 → Task 10 (Hermes
  lines only) → Task 11. Branch `feat/hermes-host`, PR, release.
- **Phase B (dsh):** Task 2 → Task 3 → Task 10 (dsh lines) → Task 11.
- **Phase C (OpenClaw):** Task 4 → Task 5 → Task 6 → Task 10 (OpenClaw lines) → Task 11.

Task numbers below are kept as written; follow the order above, not the numbering.

---

## File map

| File | Responsibility |
| --- | --- |
| `src/cli/agents/files.ts` (modify) | `mergeYamlDocument`, `readYamlDocument`, `packageRootDir` |
| `src/cli/agents/hook-host-adapter.ts` (modify) | `McpTarget` gains `kind: 'yaml'`; dsh row in `hookHostSpecs` |
| `src/cli/agents/deepseek-patch.ts` (create) | Cordis patch rows for dsh: merge and configured-check |
| `src/session/hosts/deepseek.ts` (create) | dsh profile (Claude dialect, exit-2 deny) |
| `src/session/hosts/openclaw.ts` (create) | OpenClaw profile (normalized events, plugin reader) |
| `src/session/hosts/hermes.ts` (create) | Hermes profile (normalized events, no stop channel) |
| `src/session/hosts/index.ts` (modify) | register the three profiles, display names |
| `src/core/host-hook-types.ts` (modify) | three `HookHost` values |
| `src/cli/agents/types.ts` (modify) | three `AgentName` values |
| `src/cli/agents/registry.ts` (modify) | `SUPPORTED_AGENT_NAMES`, adapter registration |
| `src/cli/agents/openclaw.ts` (create) | OpenClaw adapter: `openclaw.json` merge + plugin link |
| `src/cli/agents/hermes.ts` (create) | Hermes adapter: plugin copy + `config.yaml` merge |
| `src/cli/program.ts` (modify) | `agent-hook` host list text |
| `integrations/openclaw/{package.json,openclaw.plugin.json,index.mjs}` (create) | OpenClaw plugin |
| `integrations/hermes/knowl/{plugin.yaml,__init__.py}` (create) | Hermes plugin |
| `tests/cli/yaml-merge.test.ts` (create) | yaml merge helper |
| `tests/cli/hosts/profile-conformance.test.ts` (modify) | `ALL_HOSTS` |
| `tests/cli/deepseek-adapter.test.ts` (create) | dsh row: hooks file + patch rows |
| `tests/cli/openclaw-plugin.test.ts` (create) | plugin translation + payload acceptance |
| `tests/cli/openclaw-adapter.test.ts` (create) | `openclaw.json` merge |
| `tests/cli/hermes-plugin.test.ts` (create) | payload acceptance + runs the Python self-test |
| `tests/integrations/hermes/test_plugin.py` (create) | Python unit test for the Hermes plugin |
| `tests/cli/hermes-adapter.test.ts` (create) | plugin copy + `config.yaml` merge |
| `README.md`, `docs/hosts.md`, `CHANGELOG.md` (modify) | docs |

---

### Task 0: Branch

- [ ] **Step 1: Create the branch**

```bash
git checkout -b feat/hermes-host main      # Phase A
# later: feat/deepseek-host, feat/openclaw-host, each off main after the previous merged
```

---

### Task 1: `yaml` dependency and the YAML document merge helper

**Files:**
- Modify: `package.json` (dependencies)
- Modify: `src/cli/agents/files.ts`
- Test: `tests/cli/yaml-merge.test.ts`

**Interfaces:**
- Produces: `readYamlDocument(configPath: string): Promise<Document | undefined>` — parsed `yaml` `Document` or `undefined` when the file is absent; throws on a parse error.
- Produces: `mergeYamlDocument(configPath: string, mutate: (doc: Document) => boolean): Promise<MergeStatus>` — `mutate` edits the document in place and returns `true` if it changed anything. Returns `'unchanged'` when it did not, `'configured'` when the file did not exist, `'updated'` otherwise. Writes through `writeWithBackup`.
- Produces: `packageRootDir(): string` — the directory containing this package's `package.json` (works from `dist/*.js` and from `src/**/*.ts` under vitest).

- [ ] **Step 1: Add the dependency**

```bash
npm install yaml@^2.4.2
```

Confirm `package.json` `dependencies` now lists `"yaml": "^2.4.2"` (or the resolved 2.x).

- [ ] **Step 2: Write the failing test**

`tests/cli/yaml-merge.test.ts`:

```ts
import path from 'node:path';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { afterAll, describe, expect, it } from 'vitest';
import { Scalar, YAMLSeq } from 'yaml';
import { mergeYamlDocument, packageRootDir, readYamlDocument } from '../../src/cli/agents/files.js';

const dirs: string[] = [];
const workspace = async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'knowl-yaml-'));
  dirs.push(dir);
  return dir;
};
afterAll(async () => { for (const dir of dirs) await rm(dir, { recursive: true, force: true }); });

describe('mergeYamlDocument', () => {
  it('creates the file when absent and reports configured', async () => {
    const file = path.join(await workspace(), 'config.yaml');
    const status = await mergeYamlDocument(file, doc => { doc.setIn(['mcp_servers', 'knowl', 'command'], 'knowl'); return true; });
    expect(status).toBe('configured');
    expect(await readFile(file, 'utf8')).toContain('knowl:\n    command: knowl');
  });

  it('keeps unrelated keys and comments, and reports updated', async () => {
    const file = path.join(await workspace(), 'config.yaml');
    await writeFile(file, '# my config\nmodel: gpt\nmcp_servers:\n  other:\n    command: other\n', 'utf8');
    const status = await mergeYamlDocument(file, doc => { doc.setIn(['mcp_servers', 'knowl', 'command'], 'knowl'); return true; });
    expect(status).toBe('updated');
    const text = await readFile(file, 'utf8');
    expect(text).toContain('# my config');
    expect(text).toContain('model: gpt');
    expect(text).toContain('other:\n    command: other');
    expect(text).toContain('knowl:\n    command: knowl');
  });

  it('does not touch the file when mutate reports no change', async () => {
    const file = path.join(await workspace(), 'config.yaml');
    await writeFile(file, 'a: 1\n', 'utf8');
    expect(await mergeYamlDocument(file, () => false)).toBe('unchanged');
    expect(await readFile(file, 'utf8')).toBe('a: 1\n');
  });

  it('round-trips a !!js tagged scalar', async () => {
    const file = path.join(await workspace(), 'patch.yml');
    await writeFile(file, '- insert:\n    - id: x\n      config:\n        cwd: !!js process.cwd()\n', 'utf8');
    await mergeYamlDocument(file, doc => {
      const seq = doc.getIn([0, 'insert']) as YAMLSeq;
      const row = doc.createNode({ id: 'y', config: { cwd: 'process.cwd()' } });
      (row.getIn(['config', 'cwd'], true) as Scalar).tag = 'tag:yaml.org,2002:js';
      seq.add(row);
      return true;
    });
    const text = await readFile(file, 'utf8');
    expect(text.match(/cwd: !!js process\.cwd\(\)/g)).toHaveLength(2);
  });

  it('leaves a malformed file alone and throws', async () => {
    const file = path.join(await workspace(), 'bad.yaml');
    await writeFile(file, 'a: [unclosed\n', 'utf8');
    await expect(mergeYamlDocument(file, () => true)).rejects.toThrow();
    expect(await readFile(file, 'utf8')).toBe('a: [unclosed\n');
    await expect(readYamlDocument(file)).rejects.toThrow();
  });

  it('returns undefined for an absent document', async () => {
    expect(await readYamlDocument(path.join(await workspace(), 'nope.yaml'))).toBeUndefined();
  });
});

describe('packageRootDir', () => {
  it('names the directory that holds this package.json', async () => {
    const pkg = JSON.parse(await readFile(path.join(packageRootDir(), 'package.json'), 'utf8'));
    expect(pkg.name).toBe('@dat999zx/knowl');
  });
});
```

- [ ] **Step 3: Run the test, expect failure**

Run: `npx vitest run tests/cli/yaml-merge.test.ts`
Expected: FAIL — `mergeYamlDocument` is not exported.

- [ ] **Step 4: Implement in `src/cli/agents/files.ts`**

Add to the imports at the top:

```ts
import { fileURLToPath } from 'node:url';
import fsSync from 'node:fs';
import { Document, parseDocument } from 'yaml';
```

Append at the end of the file:

```ts
/**
 * A user-owned YAML file as a `yaml` Document, so comments, ordering and tags survive a merge.
 *
 * dsh keeps `cwd: !!js process.cwd()` in its patch rows and Hermes users annotate their
 * `config.yaml`; parse-to-object-and-stringify would erase both. A parse error is thrown, not
 * swallowed: the adapter reports it and leaves the file exactly as it found it.
 */
export async function readYamlDocument(configPath: string): Promise<Document | undefined> {
  const existing = await readTextIfExists(configPath);
  if (existing === undefined) return undefined;
  const doc = parseDocument(existing, { logLevel: 'silent' });
  if (doc.errors.length > 0) throw new Error(`${configPath}: ${doc.errors[0].message}`);
  return doc;
}

export async function mergeYamlDocument(
  configPath: string,
  mutate: (doc: Document) => boolean,
): Promise<MergeStatus> {
  const existing = await readTextIfExists(configPath);
  const doc = existing === undefined
    ? new Document({})
    : parseDocument(existing, { logLevel: 'silent' });
  if (doc.errors.length > 0) throw new Error(`${configPath}: ${doc.errors[0].message}`);
  if (!mutate(doc)) return 'unchanged';
  await writeWithBackup(configPath, doc.toString(), existing);
  return existing === undefined ? 'configured' : 'updated';
}

/**
 * The installed package root, found by walking up from this module.
 *
 * The bundle puts every module in `dist/`, and vitest runs this from `src/cli/agents/`, so a
 * fixed `..` count is wrong in one of the two. The shipped plugins under `integrations/` are
 * addressed from here.
 */
export function packageRootDir(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (;;) {
    if (fsSync.existsSync(path.join(dir, 'package.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error('Knowl package root not found.');
    dir = parent;
  }
}
```

Note on the `new Document({})` branch: a `Document` with an empty map still stringifies to `{}\n` if `mutate` adds nothing; every caller adds something on a fresh file, and the `'unchanged'` return above covers the case where it does not.

- [ ] **Step 5: Run the test, expect pass**

Run: `npx vitest run tests/cli/yaml-merge.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json src/cli/agents/files.ts tests/cli/yaml-merge.test.ts
git commit -m "feat(agents): yaml document merge for user-owned host configs"
```

---

### Task 2: DeepSeek harness profile

**Files:**
- Create: `src/session/hosts/deepseek.ts`
- Modify: `src/core/host-hook-types.ts:13-15`
- Modify: `src/session/hosts/index.ts` (imports, `HOST_PROFILES`, `HOST_DISPLAY_NAMES`)
- Modify: `tests/cli/hosts/profile-conformance.test.ts:5-8` (`ALL_HOSTS`)
- Test: `tests/cli/hosts/deepseek-profile.test.ts`

**Interfaces:**
- Produces: `deepseekProfile: HostProfile` with `host: 'deepseek'`, `hookEvents: ['SessionStart', 'PreToolUse', 'PostToolUse', 'Stop']`, `promptEvent: 'UserPromptSubmit'`, `denyExitCode: 2`, `hookConfigStyle: 'claude-nested'`.
- Consumes from `src/session/hosts/claude.ts`: `PASCAL_EVENT_MAP_WITH_PRETOOL`, `anthropicDenyToolCall`, `anthropicStopContext`, `hookSpecificOutput`, `startEventName`.

- [ ] **Step 1: Write the failing test**

`tests/cli/hosts/deepseek-profile.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { hostProfile } from '../../../src/session/hosts/index.js';

describe('deepseek profile', () => {
  const profile = hostProfile('deepseek');

  it('speaks the Claude dialect on the events dsh bridges', () => {
    expect(profile.normalizedEvent('SessionStart')).toBe('session-start');
    expect(profile.normalizedEvent('UserPromptSubmit')).toBe('turn-start');
    expect(profile.normalizedEvent('PreToolUse')).toBe('tool-precheck');
    expect(profile.normalizedEvent('PostToolUse')).toBe('session-event');
    expect(profile.normalizedEvent('Stop')).toBe('turn-stop');
    expect(profile.normalizedEvent('SubagentStart')).toBe('agent-start');
    // dsh does not bridge these; a mapping would be read downstream as a channel it has.
    expect(profile.normalizedEvent('SessionEnd')).toBeUndefined();
    expect(profile.normalizedEvent('PreCompact')).toBeUndefined();
  });

  it('refuses on exit 2 and still renders the Claude JSON verdict', () => {
    expect(profile.denyExitCode).toBe(2);
    expect(profile.denyToolCall?.('no')).toEqual({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'no' },
    });
    expect(profile.stopContext?.('store first')).toEqual({ decision: 'block', reason: 'store first' });
  });

  it('knows dsh tool names', () => {
    expect(profile.readsFiles?.('PostToolUse', 'read')).toBe(true);
    expect(profile.writesFiles?.('PreToolUse', 'write')).toBe(true);
    expect(profile.writesFiles?.('PreToolUse', 'edit')).toBe(true);
    expect(profile.writesFiles?.('PreToolUse', 'str_replace_editor')).toBe(true);
    expect(profile.writesFiles?.('PreToolUse', 'read')).toBe(false);
    expect(profile.isShellEvent('PostToolUse', 'bash')).toBe(true);
  });

  it('writes a Claude-shaped hooks file without the prompt event in it', () => {
    expect(profile.hookConfigStyle).toBe('claude-nested');
    expect(profile.hookEvents).not.toContain('UserPromptSubmit');
    expect(profile.promptEvent).toBe('UserPromptSubmit');
    expect(profile.nativeOutput).toBe(true);
    expect(profile.midTurnDeliveryVerified).toBe(false);
  });
});
```

- [ ] **Step 2: Run, expect failure**

Run: `npx vitest run tests/cli/hosts/deepseek-profile.test.ts`
Expected: FAIL — `Unsupported hook host: deepseek` (and a type error on `hostProfile('deepseek')`).

- [ ] **Step 3: Add the `HookHost` value**

In `src/core/host-hook-types.ts` append `'deepseek'` to the union (Tasks 4 and 7 append their own):

```ts
export type HookHost =
  | 'codex' | 'claude' | 'cursor' | 'claude-desktop' | 'generic'
  | 'copilot' | 'openhands' | 'antigravity' | 'windsurf' | 'cline'
  | 'deepseek';
```

- [ ] **Step 4: Write the profile**

`src/session/hosts/deepseek.ts`:

```ts
import type { NormalizedHookEventName } from '../../core/host-hook-types.js';
import type { HostIdentity, HostProfile } from './profile.js';
import { agentIdentityFrom, hostString, toolNameIsShell } from './profile.js';
import {
  PASCAL_EVENT_MAP_WITH_PRETOOL, anthropicDenyToolCall, anthropicStopContext, hookSpecificOutput, startEventName,
} from './claude.js';

/**
 * The Claude Code events dsh's `dsh-hooks-claude-code` bridge actually runs (its README, read
 * 2026-09-03): SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, Stop, SubagentStart,
 * SubagentStop. `SessionEnd`, `PreCompact` and the failure variants are not bridged, and a
 * mapping for an event the host never fires is read downstream as a channel it has.
 */
const DEEPSEEK_EVENT_MAP: Record<string, NormalizedHookEventName> = Object.fromEntries(
  ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'SubagentStart', 'SubagentStop']
    .map(event => [event, PASCAL_EVENT_MAP_WITH_PRETOOL[event]]),
);

/** Registered by `knowl init deepseek`; the prompt event is delivered by the reminder entry. */
export const DEEPSEEK_HOOK_EVENTS = ['SessionStart', 'PreToolUse', 'PostToolUse', 'Stop'] as const;

/**
 * DeepSeek harness, through its own Claude Code hook bridge.
 *
 * dsh does not read `.claude/settings.json`; it reads whatever file the
 * `@deepseek-ai/dsh-hooks-claude-code` row's `configPath` names, in Claude's shape, and runs the
 * commands in the session workspace with a Claude-style payload on stdin. So this profile is
 * Claude's dialect on the way in and OpenHands' refusal on the way out: the bridge blocks on
 * **exit 2** and honours `hookSpecificOutput`, so both are emitted and either reader blocks.
 *
 * `Stop` returning `{decision: "block"}` forces another step with the reason — the bridge's own
 * README says so — which is what makes `stopContext` a real channel here.
 *
 * **Tool vocabulary.** dsh ships two editor suites: `dsh-tool-fs` (`read`, `write`, `edit`) and
 * `dsh-tool-str-replace-editor` (one `str_replace_editor` tool whose `view` reads and whose
 * `create`/`str_replace`/`insert` write, discriminated by an argument this layer does not see).
 * The single tool is listed as a writer only, on the OpenHands rule: a false write costs a
 * re-index, a false read manufactures a belief the session does not hold.
 *
 * `midTurnDeliveryVerified` stays false until someone watches a `PostToolUse` `additionalContext`
 * arrive in a real dsh session; until then the MCP tool-result channel keeps talking too.
 */
export const deepseekProfile: HostProfile = {
  host: 'deepseek',
  hookEvents: DEEPSEEK_HOOK_EVENTS,
  promptEvent: 'UserPromptSubmit',
  sharesSessionBinding: true,
  nativeOutput: true,
  midTurnDeliveryVerified: false,
  hookConfigStyle: 'claude-nested',
  denyExitCode: 2,
  readsFiles: (_event, tool) => tool === 'read',
  writesFiles: (_event, tool) => ['write', 'edit', 'str_replace_editor'].includes(tool),
  identity(raw): HostIdentity {
    return {
      externalSessionId: hostString(raw.session_id),
      externalTurnId: hostString(raw.turn_id),
      ...agentIdentityFrom(raw),
    };
  },
  normalizedEvent(hostEvent) {
    return DEEPSEEK_EVENT_MAP[hostEvent];
  },
  isShellEvent(_hostEvent, toolName) {
    return toolNameIsShell(toolName) || toolName === 'pwsh';
  },
  startContext(event, context) {
    return hookSpecificOutput(startEventName(event), context);
  },
  midTurnContext(text) {
    return hookSpecificOutput('PostToolUse', text);
  },
  denyToolCall: anthropicDenyToolCall,
  preToolContext: text => hookSpecificOutput('PreToolUse', text),
  stopContext: anthropicStopContext,
};
```

- [ ] **Step 5: Register it**

In `src/session/hosts/index.ts`:

```ts
import { deepseekProfile } from './deepseek.js';
```

In `HOST_PROFILES` add `deepseek: deepseekProfile,`. In `HOST_DISPLAY_NAMES` add `deepseek: 'DeepSeek harness',`.

In `tests/cli/hosts/profile-conformance.test.ts` append `'deepseek'` to `ALL_HOSTS`.

- [ ] **Step 6: Run, expect pass**

Run: `npx vitest run tests/cli/hosts/`
Expected: PASS, including the conformance suite.

- [ ] **Step 7: Commit**

```bash
git add src/core/host-hook-types.ts src/session/hosts/deepseek.ts src/session/hosts/index.ts tests/cli/hosts/
git commit -m "feat(hosts): DeepSeek harness profile"
```

---

### Task 3: DeepSeek harness adapter — hooks file plus Cordis patch rows

**Files:**
- Create: `src/cli/agents/deepseek-patch.ts`
- Modify: `src/cli/agents/hook-host-adapter.ts` (`McpTarget`, `createHookHostAdapter`, `hookHostSpecs`)
- Modify: `src/cli/agents/types.ts:1-3` (`AgentName`)
- Modify: `src/cli/agents/registry.ts:10-13` (`SUPPORTED_AGENT_NAMES`)
- Test: `tests/cli/deepseek-adapter.test.ts`

**Interfaces:**
- Produces: `McpTarget` variant `{ kind: 'yaml'; scope: 'global'; configPath: (root: string) => string; mutate: (doc: Document, entry: McpEntry) => boolean; configured: (doc: Document, entry: McpEntry) => boolean }`.
- Produces: `mutateDeepseekPatch(doc: Document, entry: McpEntry): boolean` and `deepseekPatchConfigured(doc: Document, entry: McpEntry): boolean` in `deepseek-patch.ts`.
- Produces: `deepseekHomeDir(environment: AgentEnvironment): string` — `process.env.DSH_HOME` or `<home>/.dsh`.

- [ ] **Step 1: Write the failing test**

`tests/cli/deepseek-adapter.test.ts`:

```ts
import path from 'node:path';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAgentRegistry, parseAgentNames } from '../../src/cli/agents/registry.js';

const dirs: string[] = [];
const workspace = async (prefix: string) => {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};
afterAll(async () => { for (const dir of dirs) await rm(dir, { recursive: true, force: true }); });

describe('deepseek adapter', () => {
  let home: string;
  let root: string;
  const savedDshHome = process.env.DSH_HOME;
  beforeEach(async () => {
    home = await workspace('knowl-dsh-home-');
    root = await workspace('knowl-dsh-root-');
    process.env.DSH_HOME = home;
  });
  afterEach(() => {
    if (savedDshHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = savedDshHome;
  });

  const adapter = () => createAgentRegistry({
    platform: 'linux', homeDir: '/nowhere', commandExists: async cmd => cmd === 'dsh',
  }).get('deepseek')!;

  it('is a supported agent name', () => {
    expect(parseAgentNames(['deepseek'])).toEqual(['deepseek']);
  });

  it('writes both Cordis rows into a fresh $DSH_HOME/cordis.patch.yml', async () => {
    const result = await adapter().configure(root);
    expect(result.status).toBe('configured');
    expect(result.scope).toBe('global');
    const text = await readFile(path.join(home, 'cordis.patch.yml'), 'utf8');
    expect(text).toContain("name: '@deepseek-ai/dsh-hooks-claude-code'");
    expect(text).toContain('configPath: ./.dsh/hooks.json');
    expect(text).toContain("name: '@deepseek-ai/dsh-mcp-client'");
    expect(text).toContain('serverName: knowl');
    expect(text).toContain('command: knowl');
    expect(text).toContain('- serve\n');
    expect(text).toContain('- --host\n');
    expect(text).toContain('- deepseek\n');
    expect(text).toContain('cwd: !!js process.cwd()');
    expect(await adapter().verify(root)).toBe(true);
  });

  it('keeps a user patch row in place and is idempotent', async () => {
    const file = path.join(home, 'cordis.patch.yml');
    await writeFile(file, "# mine\n- insert:\n    - id: acp\n      name: '@agenticcontrolplane/dsh'\n      config:\n        agentTier: interactive\n", 'utf8');
    expect((await adapter().configure(root)).status).toBe('updated');
    expect((await adapter().configure(root)).status).toBe('unchanged');
    const text = await readFile(file, 'utf8');
    expect(text).toContain('# mine');
    expect(text).toContain("name: '@agenticcontrolplane/dsh'");
    expect(text.match(/id: knowl-mcp/g)).toHaveLength(1);
  });

  it('replaces a stale knowl row rather than adding a second', async () => {
    const file = path.join(home, 'cordis.patch.yml');
    await writeFile(file, "- insert:\n    - id: knowl-mcp\n      name: '@deepseek-ai/dsh-mcp-client'\n      config:\n        serverName: knowl\n        transport: stdio\n        command: knowl\n        args: [serve]\n", 'utf8');
    expect((await adapter().configure(root)).status).toBe('updated');
    const text = await readFile(file, 'utf8');
    expect(text.match(/id: knowl-mcp/g)).toHaveLength(1);
    expect(text).toContain('- deepseek\n');
  });

  it('reports a malformed patch file and leaves it alone', async () => {
    const file = path.join(home, 'cordis.patch.yml');
    await writeFile(file, '- insert: [\n', 'utf8');
    const result = await adapter().configure(root);
    expect(result.status).toBe('failed');
    expect(result.message).toContain('cordis.patch.yml');
    expect(await readFile(file, 'utf8')).toBe('- insert: [\n');
  });

  it('writes a Claude-shaped hooks file at .dsh/hooks.json', async () => {
    const result = await adapter().configureLifecycle!(root);
    expect(result.status).toBe('configured');
    const config = JSON.parse(await readFile(path.join(root, '.dsh', 'hooks.json'), 'utf8'));
    expect(Object.keys(config.hooks)).toEqual(expect.arrayContaining(['SessionStart', 'PreToolUse', 'PostToolUse', 'Stop']));
    expect(config.hooks.PreToolUse[0].hooks[0].command).toBe('knowl agent-hook deepseek PreToolUse --json');
    expect(await adapter().verifyLifecycle!(root)).toBe(true);
  });

  it('detects configured only when both rows are present', async () => {
    expect((await adapter().detect(root)).configured).toBe(false);
    await adapter().configure(root);
    expect((await adapter().detect(root)).configured).toBe(true);
  });
});
```

- [ ] **Step 2: Run, expect failure**

Run: `npx vitest run tests/cli/deepseek-adapter.test.ts`
Expected: FAIL — `Unsupported agent "deepseek"`.

- [ ] **Step 3: Add the agent name**

Append `'deepseek'` to the `AgentName` union in `src/cli/agents/types.ts` and to `SUPPORTED_AGENT_NAMES` in `src/cli/agents/registry.ts` (Tasks 6 and 9 append their own).

- [ ] **Step 4: Write the patch-row module**

`src/cli/agents/deepseek-patch.ts`:

```ts
import path from 'node:path';
import { Document, Scalar, YAMLMap, YAMLSeq, isMap, isSeq } from 'yaml';
import type { McpEntry } from './files.js';
import type { AgentEnvironment } from './types.js';

/** `$DSH_HOME`, else `~/.dsh` -- the default every dsh config-catalog entry names. */
export function deepseekHomeDir(environment: AgentEnvironment): string {
  return process.env.DSH_HOME || path.join(environment.homeDir, '.dsh');
}

export const DEEPSEEK_HOOKS_ROW_ID = 'knowl-hooks';
export const DEEPSEEK_MCP_ROW_ID = 'knowl-mcp';
/** Relative to dsh's launch cwd, on purpose: the patch is global and the hooks file is per project. */
export const DEEPSEEK_HOOKS_CONFIG_PATH = './.dsh/hooks.json';

/**
 * dsh is composed from Cordis plugin rows, and a user adds plugins by writing a patch file of
 * `- insert: [rows]` operations. Two rows make Knowl work: the Claude hook bridge pointed at a
 * project-relative hooks file, and the MCP client pointed at `knowl serve`.
 *
 * The patch is read once at dsh launch and relative paths resolve against the launch cwd, so a
 * single global row with `configPath: ./.dsh/hooks.json` fires in exactly the projects that ran
 * `knowl init deepseek` -- dsh logs a warning and runs no hooks where the file is missing.
 *
 * `cwd: !!js process.cwd()` is what dsh's own reference rows use for a stdio server that should
 * start in the workspace; the tag has to survive the round trip, which is why this works on a
 * `yaml` Document rather than a plain object.
 */
function knowlRows(entry: McpEntry): Array<{ id: string; row: Record<string, unknown>; jsTagPath?: string[] }> {
  return [
    {
      id: DEEPSEEK_HOOKS_ROW_ID,
      row: { id: DEEPSEEK_HOOKS_ROW_ID, name: '@deepseek-ai/dsh-hooks-claude-code', config: { configPath: DEEPSEEK_HOOKS_CONFIG_PATH } },
    },
    {
      id: DEEPSEEK_MCP_ROW_ID,
      row: {
        id: DEEPSEEK_MCP_ROW_ID,
        name: '@deepseek-ai/dsh-mcp-client',
        config: { serverName: 'knowl', transport: 'stdio', command: entry.command, args: entry.args, env: {}, cwd: 'process.cwd()' },
      },
      jsTagPath: ['config', 'cwd'],
    },
  ];
}

/** The first `insert` sequence in the patch, created when there is none. */
function insertSeq(doc: Document, create: boolean): YAMLSeq | undefined {
  if (!isSeq(doc.contents)) {
    if (!create) return undefined;
    doc.contents = doc.createNode([]) as YAMLSeq;
  }
  const ops = doc.contents as YAMLSeq;
  for (const op of ops.items) {
    if (isMap(op) && isSeq(op.get('insert', true))) return op.get('insert', true) as YAMLSeq;
  }
  if (!create) return undefined;
  const op = doc.createNode({ insert: [] }) as YAMLMap;
  ops.add(op);
  return op.get('insert', true) as YAMLSeq;
}

function rowIndex(seq: YAMLSeq, id: string): number {
  return seq.items.findIndex(item => isMap(item) && item.get('id') === id);
}

function sameRow(existing: unknown, wanted: Record<string, unknown>): boolean {
  const json = JSON.stringify(existing);
  // The `!!js` scalar serialises as its text, which is what `wanted` carries too.
  return json === JSON.stringify(wanted);
}

export function deepseekPatchConfigured(doc: Document, entry: McpEntry): boolean {
  const seq = insertSeq(doc, false);
  if (!seq) return false;
  return knowlRows(entry).every(({ id, row }) => {
    const index = rowIndex(seq, id);
    return index >= 0 && sameRow((seq.items[index] as YAMLMap).toJSON(), row);
  });
}

export function mutateDeepseekPatch(doc: Document, entry: McpEntry): boolean {
  let changed = false;
  const seq = insertSeq(doc, true)!;
  for (const { id, row, jsTagPath } of knowlRows(entry)) {
    const index = rowIndex(seq, id);
    if (index >= 0 && sameRow((seq.items[index] as YAMLMap).toJSON(), row)) continue;
    const node = doc.createNode(row) as YAMLMap;
    if (jsTagPath) (node.getIn(jsTagPath, true) as Scalar).tag = 'tag:yaml.org,2002:js';
    if (index >= 0) seq.items[index] = node; else seq.add(node);
    changed = true;
  }
  return changed;
}
```

- [ ] **Step 5: Teach the hook-host adapter the `yaml` target**

In `src/cli/agents/hook-host-adapter.ts`:

Imports — add:

```ts
import type { Document } from 'yaml';
import { mergeYamlDocument, readYamlDocument } from './files.js';
import { DEEPSEEK_HOOKS_CONFIG_PATH, deepseekHomeDir, deepseekPatchConfigured, mutateDeepseekPatch } from './deepseek-patch.js';
```

Replace the `McpTarget` type:

```ts
type McpTarget =
  | { kind: 'json'; scope: IntegrationScope; configPath: (root: string) => string }
  | { kind: 'manual'; configPath: (root: string) => string; message: string }
  /**
   * A user-owned YAML file merged as a Document, so their comments and tags survive.
   * `mutate` edits in place and says whether it changed anything; `configured` answers detect.
   */
  | {
    kind: 'yaml';
    scope: 'global';
    configPath: (root: string) => string;
    mutate: (doc: Document, entry: McpEntry) => boolean;
    configured: (doc: Document, entry: McpEntry) => boolean;
  };
```

In `createHookHostAdapter`, change `mcpScope`:

```ts
  const mcpScope: IntegrationScope = spec.mcp.kind === 'manual' ? 'project' : spec.mcp.scope;
```

In `detect`, replace the `configured:` line with:

```ts
        configured: spec.mcp.kind === 'json'
          ? await jsonMcpConfigured(configPath, entry)
          : spec.mcp.kind === 'yaml'
            ? await yamlMcpConfigured(configPath, spec.mcp.configured, entry)
            : installed,
```

and add beside `jsonMcpConfigured`:

```ts
async function yamlMcpConfigured(
  pathname: string,
  configured: (doc: Document, entry: McpEntry) => boolean,
  entry: McpEntry,
): Promise<boolean> {
  try {
    const doc = await readYamlDocument(pathname);
    return doc !== undefined && configured(doc, entry);
  } catch {
    // Same rule as the JSON reader: absent or unparseable is "not configured by us".
    return false;
  }
}
```

In `configure`, after the `manual` branch and before the JSON merge:

```ts
      if (spec.mcp.kind === 'yaml') {
        const { mutate } = spec.mcp;
        try {
          const status = await mergeYamlDocument(configPath, doc => mutate(doc, entry));
          return { agent: spec.name, status, scope: mcpScope, configPath };
        } catch (error: any) {
          // The file is theirs and it did not parse. Say so; do not rewrite it.
          return { agent: spec.name, status: 'failed', scope: mcpScope, configPath, message: `Could not merge ${configPath}: ${error.message}` };
        }
      }
```

In `verify`, the existing `if (spec.mcp.kind === 'manual') return true;` stays; `yaml` falls through to `(await this.detect(root)).configured`, which is right.

Add the row to `hookHostSpecs`, after windsurf:

```ts
    {
      name: 'deepseek',
      label: 'DeepSeek harness',
      command: 'dsh',
      mcp: {
        kind: 'yaml',
        scope: 'global',
        // `$DSH_HOME/cordis.patch.yml` applies to every profile; dsh's own docs say to merge
        // into it rather than copy over it, which is what the Document merge does.
        configPath: () => path.join(deepseekHomeDir(environment), 'cordis.patch.yml'),
        mutate: mutateDeepseekPatch,
        configured: deepseekPatchConfigured,
      },
      // The path the hooks row names, relative to dsh's launch cwd -- keep the two in step.
      hooksPath: root => path.join(root, ...DEEPSEEK_HOOKS_CONFIG_PATH.replace(/^\.\//, '').split('/')),
    },
```

- [ ] **Step 6: Run, expect pass**

Run: `npx vitest run tests/cli/deepseek-adapter.test.ts tests/cli/agent-adapters.test.ts tests/cli/host-config-shapes.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/cli/agents/ tests/cli/deepseek-adapter.test.ts
git commit -m "feat(agents): knowl init deepseek writes the hooks file and Cordis patch rows"
```

---

### Task 4: OpenClaw profile

**Files:**
- Create: `src/session/hosts/openclaw.ts`
- Modify: `src/session/hosts/index.ts` (replace the placeholder)
- Test: `tests/cli/hosts/openclaw-profile.test.ts`

**Interfaces:**
- Produces: `openclawProfile: HostProfile` — `host: 'openclaw'`, `hookEvents: []`, `hookConfigStyle: 'none'`, `nativeOutput: false`, `lifecycleClaimable: false`, `denyToolCall` present (returns `{ denied: reason }`), `stopContext` present (returns `{ stop: reason }`), `readsFiles`/`writesFiles` on OpenClaw tool ids.
- Produces: `OPENCLAW_EVENTS: NormalizedHookEventName[]` = `['session-start', 'turn-start', 'tool-precheck', 'session-event', 'turn-stop', 'session-stop']`.

- [ ] **Step 1: Write the failing test**

`tests/cli/hosts/openclaw-profile.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { hostProfile } from '../../../src/session/hosts/index.js';

describe('openclaw profile', () => {
  const profile = hostProfile('openclaw');

  it('accepts the normalized events the plugin sends and nothing else', () => {
    for (const event of ['session-start', 'turn-start', 'tool-precheck', 'session-event', 'turn-stop', 'session-stop']) {
      expect(profile.normalizedEvent(event), event).toBe(event);
    }
    expect(profile.normalizedEvent('before_tool_call')).toBeUndefined();
    expect(profile.normalizedEvent('checkpoint')).toBeUndefined();
  });

  it('registers no hooks file and does not claim the lifecycle unconditionally', () => {
    expect(profile.hookEvents).toEqual([]);
    expect(profile.hookConfigStyle).toBe('none');
    expect(profile.nativeOutput).toBe(false);
    expect(profile.lifecycleClaimable).toBe(false);
    expect(profile.startContext('session-start', 'x')).toBeUndefined();
    expect(profile.midTurnContext('x')).toBeUndefined();
  });

  it('can refuse and can speak at stop, in a shape the plugin lifts', () => {
    expect(profile.denyToolCall?.('why')).toEqual({ denied: 'why' });
    expect(profile.stopContext?.('store it')).toEqual({ stop: 'store it' });
  });

  it('knows OpenClaw tool ids', () => {
    expect(profile.readsFiles?.('', 'read')).toBe(true);
    for (const tool of ['write', 'edit', 'apply_patch']) expect(profile.writesFiles?.('', tool), tool).toBe(true);
    expect(profile.writesFiles?.('', 'read')).toBe(false);
    expect(profile.isShellEvent('', 'exec')).toBe(true);
  });
});
```

- [ ] **Step 2: Run, expect failure**

Run: `npx vitest run tests/cli/hosts/openclaw-profile.test.ts`
Expected: FAIL (the placeholder is Cline's profile).

- [ ] **Step 3: Write the profile**

`src/session/hosts/openclaw.ts`:

```ts
import type { NormalizedHookEventName } from '../../core/host-hook-types.js';
import type { HostIdentity, HostProfile } from './profile.js';
import { hostString, toolNameIsShell } from './profile.js';

/**
 * The events `integrations/openclaw/index.mjs` sends -- normalized names, because the mapping
 * from OpenClaw's `before_tool_call` and friends happens in the plugin, the only code that sees
 * them. Same arrangement as Cline.
 */
export const OPENCLAW_EVENTS: NormalizedHookEventName[] = [
  'session-start', 'turn-start', 'tool-precheck', 'session-event', 'turn-stop', 'session-stop',
];

/**
 * OpenClaw, whose lifecycle arrives through an in-process npm plugin.
 *
 * `nativeOutput: false`: the reader is our own plugin, which lifts `context`, `denied` and
 * `hostOutput` off the host-neutral result. The two envelopes below are therefore *plugin*
 * contracts, not OpenClaw's -- the plugin turns `{denied}` into `{block: true, blockReason}` on
 * `before_tool_call`, and `{stop}` into a `prependSystemContext` on the next `before_prompt_build`.
 *
 * **`stopContext` is delivery without enforcement.** OpenClaw's `agent_end` cannot block, so the
 * capture nudge cannot withhold the stop the way Claude Code's `Stop` does; the text reaches the
 * model at the start of its next turn instead. Present because `capture.nudge: enforce` should
 * still produce the sentence here; documented in `docs/hosts.md` as the one caveat.
 *
 * `lifecycleClaimable: false`, like Cline: the plugin is installed by `knowl init openclaw` but
 * a person can disable it in `openclaw.json`, and the MCP card must not tell an agent its hooks
 * own the lifecycle when they may not be loaded.
 *
 * Tool ids from docs.openclaw.ai/tools (2026-09-03): `read`, `write`, `edit`, `apply_patch`,
 * `exec`. `event.params` carries `path` or `filePath`, both of which `changedPaths` reads.
 */
export const openclawProfile: HostProfile = {
  host: 'openclaw',
  hookEvents: [],
  promptEvent: undefined,
  sharesSessionBinding: true,
  nativeOutput: false,
  midTurnDeliveryVerified: false,
  hookConfigStyle: 'none',
  lifecycleClaimable: false,
  identity(raw): HostIdentity {
    return {
      externalSessionId: hostString(raw.session_id),
      externalTurnId: hostString(raw.turn_id),
      agentId: hostString(raw.agent_id),
    };
  },
  normalizedEvent(hostEvent) {
    return OPENCLAW_EVENTS.includes(hostEvent as NormalizedHookEventName)
      ? hostEvent as NormalizedHookEventName
      : undefined;
  },
  isShellEvent(_hostEvent, toolName) {
    return toolNameIsShell(toolName) || toolName === 'exec' || toolName === 'process';
  },
  startContext() {
    return undefined;
  },
  midTurnContext() {
    return undefined;
  },
  denyToolCall: reason => ({ denied: reason }),
  stopContext: reason => ({ stop: reason }),
  readsFiles: (_event, tool) => tool === 'read',
  writesFiles: (_event, tool) => ['write', 'edit', 'apply_patch'].includes(tool),
};
```

- [ ] **Step 4: Register it**

Append `'openclaw'` to the `HookHost` union in `src/core/host-hook-types.ts`. In `src/session/hosts/index.ts`: add `import { openclawProfile } from './openclaw.js';`, `openclaw: openclawProfile,` in `HOST_PROFILES`, and `openclaw: 'OpenClaw',` in `HOST_DISPLAY_NAMES`. Append `'openclaw'` to `ALL_HOSTS` in `tests/cli/hosts/profile-conformance.test.ts`.

- [ ] **Step 5: Run, expect pass**

Run: `npx vitest run tests/cli/hosts/`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/session/hosts/openclaw.ts src/session/hosts/index.ts tests/cli/hosts/openclaw-profile.test.ts
git commit -m "feat(hosts): OpenClaw profile"
```

---

### Task 5: OpenClaw plugin (shipped under `integrations/openclaw/`)

**Files:**
- Create: `integrations/openclaw/package.json`
- Create: `integrations/openclaw/openclaw.plugin.json`
- Create: `integrations/openclaw/index.mjs`
- Test: `tests/cli/openclaw-plugin.test.ts`

**Interfaces:**
- Produces: `index.mjs` default export `{ id: 'knowl', name: 'Knowl', register(api) }`, plus a named export `createKnowlPlugin({ run })` where `run(event, payload) => Promise<object | null>` is injectable for tests. The default export uses the real spawner.
- The plugin sends payloads `normalizeHostHook('openclaw', …)` accepts: `session_id`, `cwd`, `tool_name`, `tool_input`, `prompt`, `agent_id`, `title`.

- [ ] **Step 1: Write the failing test**

`tests/cli/openclaw-plugin.test.ts`:

```ts
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { normalizeHostHook } from '../../src/cli/agents/host-hook.js';
// The plugin is plain ESM outside tsconfig; vitest imports it directly.
import { createKnowlPlugin } from '../../integrations/openclaw/index.mjs';

const ROOT = path.resolve('.knowl-openclaw-plugin-test');
const ctx = { sessionId: 'sess-1', workspaceDir: ROOT, runId: 'run-1', agentId: 'main' };

type Call = { event: string; payload: Record<string, any> };

function harness(results: Record<string, unknown> = {}) {
  const calls: Call[] = [];
  const handlers: Record<string, (event: any, ctx: any) => any> = {};
  const plugin = createKnowlPlugin({
    run: async (event: string, payload: Record<string, any>) => { calls.push({ event, payload }); return results[event] ?? null; },
  });
  plugin.register({ on: (name: string, handler: any) => { handlers[name] = handler; } });
  return { calls, handlers };
}

describe('OpenClaw plugin', () => {
  it('registers every hook the design names', () => {
    const { handlers } = harness();
    expect(Object.keys(handlers).sort()).toEqual([
      'after_tool_call', 'agent_end', 'agent_turn_prepare', 'before_prompt_build', 'before_tool_call', 'session_end', 'session_start',
    ]);
  });

  it('sends payloads the normaliser accepts, for every event', async () => {
    const { calls, handlers } = harness();
    await handlers.session_start({}, ctx);
    await handlers.before_prompt_build({ prompt: 'fix the bug', messages: [] }, ctx);
    await handlers.before_tool_call({ toolName: 'edit', params: { path: path.join(ROOT, 'src/a.ts') } }, ctx);
    await handlers.after_tool_call({ toolName: 'edit', params: { path: path.join(ROOT, 'src/a.ts') } }, ctx);
    await handlers.agent_end({ success: true }, ctx);
    await handlers.session_end({ reason: 'idle' }, ctx);
    expect(calls.map(c => c.event)).toEqual(['session-start', 'turn-start', 'tool-precheck', 'session-event', 'turn-stop', 'session-stop']);
    for (const { event, payload } of calls) {
      const normalized = normalizeHostHook('openclaw', event, payload);
      expect(normalized.externalSessionId, event).toBe('sess-1');
      expect(normalized.projectRoot, event).toBe(ROOT);
    }
    const precheck = normalizeHostHook('openclaw', 'tool-precheck', calls[2].payload);
    expect(precheck.toolName).toBe('edit');
    expect(precheck.payload.changedPaths).toEqual(['src/a.ts']);
  });

  it('puts the turn card into the system prompt', async () => {
    const { handlers } = harness({ 'turn-start': { context: 'KNOWL: remember X' } });
    const out = await handlers.before_prompt_build({ prompt: 'p', messages: [] }, ctx);
    expect(out).toEqual({ prependSystemContext: 'KNOWL: remember X' });
  });

  it('blocks a tool call the gate refused, and holds an impact card for the next turn prepare', async () => {
    const { handlers } = harness({ 'tool-precheck': { denied: 'trap: see atom abc' } });
    const out = await handlers.before_tool_call({ toolName: 'write', params: { path: 'x' } }, ctx);
    expect(out).toEqual({ block: true, blockReason: 'trap: see atom abc' });

    const advisory = harness({ 'tool-precheck': { context: 'heads up' } });
    expect(await advisory.handlers.before_tool_call({ toolName: 'write', params: { path: 'x' } }, ctx)).toBeUndefined();
    expect(await advisory.handlers.agent_turn_prepare({}, ctx)).toEqual({ appendContext: 'heads up' });
    // Delivered once.
    expect(await advisory.handlers.agent_turn_prepare({}, ctx)).toBeUndefined();
  });

  it('carries a stop nudge into the next prompt build', async () => {
    const { handlers } = harness({ 'turn-stop': { hostOutput: { stop: 'you stored nothing' } } });
    expect(await handlers.agent_end({}, ctx)).toBeUndefined();
    expect(await handlers.before_prompt_build({ prompt: 'p' }, ctx)).toEqual({ prependSystemContext: 'you stored nothing' });
  });

  it('returns nothing when the hook fails', async () => {
    const plugin = createKnowlPlugin({ run: async () => { throw new Error('boom'); } });
    const handlers: Record<string, any> = {};
    plugin.register({ on: (n: string, h: any) => { handlers[n] = h; } });
    expect(await handlers.before_tool_call({ toolName: 'write', params: {} }, ctx)).toBeUndefined();
    expect(await handlers.before_prompt_build({ prompt: 'p' }, ctx)).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run, expect failure**

Run: `npx vitest run tests/cli/openclaw-plugin.test.ts`
Expected: FAIL — cannot resolve `integrations/openclaw/index.mjs`.

- [ ] **Step 3: Write the manifest files**

`integrations/openclaw/package.json`:

```json
{
  "name": "knowl-openclaw",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "description": "Knowl project memory lifecycle for OpenClaw",
  "openclaw": { "extensions": ["./index.mjs"] }
}
```

`integrations/openclaw/openclaw.plugin.json`:

```json
{
  "id": "knowl",
  "name": "Knowl",
  "description": "Project memory: bootstrap, per-turn recall, change impact, and a write gate backed by the knowl CLI.",
  "activation": { "onStartup": true },
  "configSchema": { "type": "object", "additionalProperties": false, "properties": {} }
}
```

- [ ] **Step 4: Write the plugin**

`integrations/openclaw/index.mjs`:

```js
/**
 * Knowl lifecycle plugin for OpenClaw.
 *
 * OpenClaw's hooks are `api.on(name, handler)` registrations inside its own process, not a hooks
 * file, so `knowl init openclaw` links this directory as a plugin and this file is the other
 * half: every handler forwards one normalized event to `knowl agent-hook openclaw <event> --json`
 * -- the same entry point every other host's hooks use -- and maps the result back into the
 * return shape OpenClaw documents for that hook.
 *
 * ## Install
 *
 *   knowl init openclaw
 *
 * which runs `openclaw plugins install --link <this dir> --force`, `openclaw plugins enable
 * knowl`, and sets `plugins.entries.knowl.hooks.allowConversationAccess: true` so the prompt
 * hooks are allowed to register.
 *
 * ## What reaches the model, and where
 *
 * - `before_prompt_build` returns `prependSystemContext`: the turn card lands in the system
 *   prompt. This is the slot Claude Code's hooks do not have.
 * - `before_tool_call` returns `{block: true, blockReason}` when the write gate refused; an
 *   advisory impact card is held and returned as `appendContext` from `agent_turn_prepare`.
 * - `agent_end` cannot block, so a stop nudge is held and prepended on the next prompt build.
 *   Delivery, not enforcement -- the stop itself is not withheld.
 *
 * ## Failure
 *
 * This runs inside OpenClaw's process. A hook that throws is a failed agent turn, not a failed
 * hook, so nothing here throws and every path returns `undefined` on a miss, a timeout or a
 * crash. A refusal is only ever the `denied` string the CLI computed.
 */

import { spawn } from 'node:child_process';
import process from 'node:process';

const HOOK_TIMEOUT_MS = 10_000;

/** OpenClaw hook name -> the normalized event `knowl agent-hook openclaw` accepts. */
const EVENTS = {
  session_start: 'session-start',
  before_prompt_build: 'turn-start',
  before_tool_call: 'tool-precheck',
  after_tool_call: 'session-event',
  agent_end: 'turn-stop',
  session_end: 'session-stop',
};

/** Run one hook process and resolve its parsed stdout, or null. Never rejects. */
function spawnHook(event, payload) {
  return new Promise(resolve => {
    let settled = false;
    const done = value => { if (!settled) { settled = true; resolve(value); } };
    try {
      // No shell: `knowl.cmd` is named explicitly on Windows, so nothing needs PATHEXT, and a
      // shell between us and the process would make `kill()` orphan the real child on timeout.
      const command = process.platform === 'win32' ? 'knowl.cmd' : 'knowl';
      const child = spawn(command, ['agent-hook', 'openclaw', event, '--json'], { stdio: ['pipe', 'pipe', 'ignore'] });
      const timer = setTimeout(() => { child.kill(); done(null); }, HOOK_TIMEOUT_MS);
      timer.unref?.();
      let out = '';
      child.stdout.on('data', chunk => { out += chunk; });
      child.on('error', () => { clearTimeout(timer); done(null); });
      child.on('close', () => {
        clearTimeout(timer);
        try { done(out.trim() ? JSON.parse(out) : null); } catch { done(null); }
      });
      child.stdin.on('error', () => {});
      child.stdin.end(JSON.stringify(payload));
    } catch {
      done(null);
    }
  });
}

const FALLBACK_SESSION_ID = `openclaw-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;

/** The identity Knowl keys a memory session on. Neither field may end up undefined. */
function basePayload(ctx = {}) {
  return {
    session_id: ctx.sessionId ?? ctx.sessionKey ?? FALLBACK_SESSION_ID,
    turn_id: ctx.runId,
    agent_id: ctx.agentId,
    cwd: ctx.workspaceDir ?? ctx.cwd ?? process.cwd(),
  };
}

const textOf = value => (typeof value === 'string' && value.length > 0 ? value : null);

/**
 * Build the plugin. `run(event, payload)` is injectable so the translation can be tested
 * without a `knowl` binary; the default export uses the real spawner.
 */
export function createKnowlPlugin({ run = spawnHook } = {}) {
  // Text waiting for a channel that can carry it: an advisory impact card until the next
  // `agent_turn_prepare`, a stop nudge until the next `before_prompt_build`.
  let heldTurnContext = null;
  let heldSystemContext = null;

  const call = async (hook, ctx, extra = {}) => {
    try {
      return await run(EVENTS[hook], { ...basePayload(ctx), ...extra });
    } catch {
      return null;
    }
  };

  return {
    id: 'knowl',
    name: 'Knowl',
    description: 'Knowl project memory lifecycle',
    register(api) {
      api.on('session_start', async (_event, ctx) => {
        const result = await call('session_start', ctx, { title: 'Agent session' });
        // No context channel on this hook; the bootstrap card rides the first prompt build.
        heldSystemContext = textOf(result?.context) ?? heldSystemContext;
      });

      api.on('before_prompt_build', async (event, ctx) => {
        const result = await call('before_prompt_build', ctx, { title: 'Agent turn', prompt: textOf(event?.prompt) ?? undefined });
        const parts = [heldSystemContext, textOf(result?.context)].filter(Boolean);
        heldSystemContext = null;
        return parts.length > 0 ? { prependSystemContext: parts.join('\n\n') } : undefined;
      });

      api.on('before_tool_call', async (event, ctx) => {
        const result = await call('before_tool_call', ctx, { tool_name: event?.toolName, tool_input: event?.params ?? {} });
        const denied = textOf(result?.denied);
        if (denied) return { block: true, blockReason: denied };
        const advice = textOf(result?.context);
        if (advice) heldTurnContext = advice;
        return undefined;
      });

      api.on('agent_turn_prepare', async () => {
        if (!heldTurnContext) return undefined;
        const text = heldTurnContext;
        heldTurnContext = null;
        return { appendContext: text };
      });

      api.on('after_tool_call', async (event, ctx) => {
        await call('after_tool_call', ctx, {
          tool_name: event?.toolName,
          tool_input: event?.params ?? {},
          ...(event?.error ? { error: { message: String(event.error?.message ?? event.error) } } : {}),
        });
      });

      api.on('agent_end', async (event, ctx) => {
        const result = await call('agent_end', ctx, { title: 'Agent turn', status: event?.success === false ? 'failed' : 'finished' });
        const nudge = textOf(result?.hostOutput?.stop);
        if (nudge) heldSystemContext = nudge;
      });

      api.on('session_end', async (_event, ctx) => {
        await call('session_end', ctx, { title: 'Agent session' });
      });
    },
  };
}

export default createKnowlPlugin();
```

- [ ] **Step 5: Run, expect pass**

Run: `npx vitest run tests/cli/openclaw-plugin.test.ts`
Expected: PASS (6 tests). If vitest refuses to import `.mjs` from outside `src/`, add `integrations/**/*.mjs` to `test.include`'s sibling `server.deps.inline` is not needed — plain ESM imports resolve; check `vitest.config.*` only if the import fails.

- [ ] **Step 6: Commit**

```bash
git add integrations/openclaw tests/cli/openclaw-plugin.test.ts
git commit -m "feat(integrations): OpenClaw plugin translating hooks to knowl agent-hook"
```

---

### Task 6: OpenClaw adapter — `openclaw.json` merge and plugin link

**Files:**
- Create: `src/cli/agents/openclaw.ts`
- Modify: `src/cli/agents/registry.ts` (register)
- Test: `tests/cli/openclaw-adapter.test.ts`

**Interfaces:**
- Produces: `createOpenclawAdapter(environment: AgentEnvironment, options?: { exec?: (file: string, args: string[]) => Promise<void> }): AgentAdapter`.
- Produces: `openclawConfigPath(environment): string` — `process.env.OPENCLAW_CONFIG_PATH` or `<home>/.openclaw/openclaw.json`.
- Produces: `mergeOpenclawConfig(configPath: string, entry: McpEntry): Promise<MergeStatus>` — sets `mcp.servers.knowl = { command, args, transport: 'stdio', enabled: true }` and `plugins.entries.knowl = { enabled: true, hooks: { allowConversationAccess: true } }` (deep-merged, existing keys kept).
- Produces: `openclawPluginDir(): string` — `<packageRootDir()>/integrations/openclaw`.

- [ ] **Step 1: Write the failing test**

`tests/cli/openclaw-adapter.test.ts`:

```ts
import path from 'node:path';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createOpenclawAdapter, mergeOpenclawConfig, openclawPluginDir } from '../../src/cli/agents/openclaw.js';
import { parseAgentNames } from '../../src/cli/agents/registry.js';

const dirs: string[] = [];
const workspace = async () => { const d = await mkdtemp(path.join(tmpdir(), 'knowl-openclaw-')); dirs.push(d); return d; };
afterAll(async () => { for (const d of dirs) await rm(d, { recursive: true, force: true }); });

describe('openclaw adapter', () => {
  let home: string;
  let configPath: string;
  const saved = process.env.OPENCLAW_CONFIG_PATH;
  beforeEach(async () => {
    home = await workspace();
    configPath = path.join(home, 'openclaw.json');
    process.env.OPENCLAW_CONFIG_PATH = configPath;
  });
  afterEach(() => { if (saved === undefined) delete process.env.OPENCLAW_CONFIG_PATH; else process.env.OPENCLAW_CONFIG_PATH = saved; });

  const env = (installed: boolean) => ({ platform: 'linux' as const, homeDir: home, appDataDir: home, commandExists: async () => installed });

  it('is a supported agent name', () => {
    expect(parseAgentNames(['openclaw'])).toEqual(['openclaw']);
  });

  it('writes the MCP server and the plugin entry into a fresh openclaw.json', async () => {
    const calls: string[][] = [];
    const adapter = createOpenclawAdapter(env(true), { exec: async (file, args) => { calls.push([file, ...args]); } });
    const result = await adapter.configure('/repo');
    expect(result.status).toBe('configured');
    expect(result.scope).toBe('global');
    const saved = JSON.parse(await readFile(configPath, 'utf8'));
    expect(saved.mcp.servers.knowl).toEqual({ command: 'knowl', args: ['serve', '--host', 'openclaw'], transport: 'stdio', enabled: true });
    expect(saved.plugins.entries.knowl).toEqual({ enabled: true, hooks: { allowConversationAccess: true } });
    expect(calls).toEqual([
      ['openclaw', 'plugins', 'install', '--link', openclawPluginDir(), '--force'],
      ['openclaw', 'plugins', 'enable', 'knowl'],
    ]);
    expect(await adapter.verify('/repo')).toBe(true);
  });

  it('keeps other servers, other plugins and other keys of the knowl plugin entry', async () => {
    await writeFile(configPath, JSON.stringify({
      agents: { default: 'x' },
      mcp: { servers: { other: { url: 'https://o', transport: 'streamable-http' } } },
      plugins: { entries: { knowl: { config: { verbose: true } }, other: { enabled: true } } },
    }), 'utf8');
    expect(await mergeOpenclawConfig(configPath, { command: 'knowl', args: ['serve', '--host', 'openclaw'] })).toBe('updated');
    const saved = JSON.parse(await readFile(configPath, 'utf8'));
    expect(saved.agents.default).toBe('x');
    expect(saved.mcp.servers.other.url).toBe('https://o');
    expect(saved.plugins.entries.other).toEqual({ enabled: true });
    expect(saved.plugins.entries.knowl).toEqual({ config: { verbose: true }, enabled: true, hooks: { allowConversationAccess: true } });
    expect(await mergeOpenclawConfig(configPath, { command: 'knowl', args: ['serve', '--host', 'openclaw'] })).toBe('unchanged');
  });

  it('prints the commands instead of running them when openclaw is not on PATH', async () => {
    const adapter = createOpenclawAdapter(env(false), { exec: async () => { throw new Error('must not run'); } });
    const result = await adapter.configure('/repo');
    expect(result.status).toBe('configured');
    expect(result.message).toContain('openclaw plugins install --link');
    expect(result.message).toContain('openclaw plugins enable knowl');
  });

  it('leaves a file it cannot parse alone and says so', async () => {
    await writeFile(configPath, '{ // json5 comment\n mcp: {} }\n', 'utf8');
    const adapter = createOpenclawAdapter(env(true), { exec: async () => {} });
    const result = await adapter.configure('/repo');
    expect(result.status).toBe('failed');
    expect(result.message).toContain('openclaw mcp add knowl --command knowl --arg serve --arg --host --arg openclaw');
    expect(await readFile(configPath, 'utf8')).toBe('{ // json5 comment\n mcp: {} }\n');
    expect((await adapter.detect('/repo')).configured).toBe(false);
  });

  it('ships the plugin directory with both manifests', async () => {
    const dir = openclawPluginDir();
    expect(JSON.parse(await readFile(path.join(dir, 'openclaw.plugin.json'), 'utf8')).id).toBe('knowl');
    expect(JSON.parse(await readFile(path.join(dir, 'package.json'), 'utf8')).openclaw.extensions).toEqual(['./index.mjs']);
  });
});
```

- [ ] **Step 2: Run, expect failure**

Run: `npx vitest run tests/cli/openclaw-adapter.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the adapter**

`src/cli/agents/openclaw.ts`:

```ts
import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { McpEntry, MergeStatus, mcpEntryMatches, packageRootDir, readTextIfExists, writeWithBackup } from './files.js';
import { AgentAdapter, AgentDetection, AgentEnvironment, AgentIntegrationResult } from './types.js';
import { KNOWL_MCP_SERVER_KEY } from '../../core/knowl-guidance.js';

const execFileAsync = promisify(execFile);

/** `OPENCLAW_CONFIG_PATH`, else `~/.openclaw/openclaw.json` -- the documented default. */
export function openclawConfigPath(environment: AgentEnvironment): string {
  return process.env.OPENCLAW_CONFIG_PATH || path.join(environment.homeDir, '.openclaw', 'openclaw.json');
}

/** The plugin shipped inside this package; `openclaw plugins install --link` points at it. */
export function openclawPluginDir(): string {
  return path.join(packageRootDir(), 'integrations', 'openclaw');
}

const PLUGIN_ID = 'knowl';

const record = (value: unknown): Record<string, any> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};

/**
 * OpenClaw keeps MCP servers under `mcp.servers.<name>` with an explicit `transport`, and the
 * plugin's own switch under `plugins.entries.<id>`. Prompt hooks register only when
 * `hooks.allowConversationAccess` is true for the plugin, which is why it is written here rather
 * than left to the person.
 *
 * `openclaw.json` may be JSON5. `JSON.parse` handles the plain-JSON files `openclaw` itself
 * writes; a hand-commented file throws and the caller reports the CLI commands instead.
 */
export async function mergeOpenclawConfig(configPath: string, entry: McpEntry): Promise<MergeStatus> {
  const existing = await readTextIfExists(configPath);
  const config = existing === undefined ? {} : record(JSON.parse(existing));
  const mcp = record(config.mcp);
  const servers = record(mcp.servers);
  const plugins = record(config.plugins);
  const entries = record(plugins.entries);
  const knowlEntry = record(entries[PLUGIN_ID]);
  const knowlHooks = record(knowlEntry.hooks);

  const serverOk = mcpEntryMatches(servers[KNOWL_MCP_SERVER_KEY], entry)
    && servers[KNOWL_MCP_SERVER_KEY]?.transport === 'stdio'
    && servers[KNOWL_MCP_SERVER_KEY]?.enabled !== false;
  const pluginOk = knowlEntry.enabled === true && knowlHooks.allowConversationAccess === true;
  if (serverOk && pluginOk) return 'unchanged';

  config.mcp = { ...mcp, servers: { ...servers, [KNOWL_MCP_SERVER_KEY]: { command: entry.command, args: entry.args, transport: 'stdio', enabled: true } } };
  config.plugins = { ...plugins, entries: { ...entries, [PLUGIN_ID]: { ...knowlEntry, enabled: true, hooks: { ...knowlHooks, allowConversationAccess: true } } } };
  await writeWithBackup(configPath, `${JSON.stringify(config, null, 2)}\n`, existing);
  return existing === undefined ? 'configured' : 'updated';
}

async function openclawConfigured(configPath: string, entry: McpEntry): Promise<boolean> {
  try {
    const text = await readTextIfExists(configPath);
    if (text === undefined) return false;
    const config = record(JSON.parse(text));
    const server = record(record(config.mcp).servers)[KNOWL_MCP_SERVER_KEY];
    const plugin = record(record(record(config.plugins).entries)[PLUGIN_ID]);
    return mcpEntryMatches(server, entry) && plugin.enabled === true && record(plugin.hooks).allowConversationAccess === true;
  } catch {
    return false;
  }
}

const manualCommands = (entry: McpEntry) => [
  `openclaw mcp add knowl --command ${entry.command} ${entry.args.map(a => `--arg ${a}`).join(' ')}`,
  `openclaw plugins install --link ${openclawPluginDir()} --force`,
  'openclaw plugins enable knowl',
  'and set plugins.entries.knowl.hooks.allowConversationAccess to true in openclaw.json',
].join('\n  ');

/**
 * OpenClaw: a home-scoped config plus a linked plugin.
 *
 * `exec` is injectable so tests never run `openclaw`. When the binary is absent the config is
 * still written -- OpenClaw reads it on next start -- and the two plugin commands are printed for
 * the person to run once it is installed.
 */
export function createOpenclawAdapter(
  environment: AgentEnvironment,
  options: { exec?: (file: string, args: string[]) => Promise<void> } = {},
): AgentAdapter {
  const exec = options.exec ?? (async (file, args) => { await execFileAsync(file, args); });
  const entry: McpEntry = { command: environment.platform === 'win32' ? 'knowl.cmd' : 'knowl', args: ['serve', '--host', 'openclaw'] };
  return {
    name: 'openclaw',
    label: 'OpenClaw',
    async detect(): Promise<AgentDetection> {
      const configPath = openclawConfigPath(environment);
      return {
        installed: await environment.commandExists('openclaw'),
        configured: await openclawConfigured(configPath, entry),
        scope: 'global',
        configPath,
      };
    },
    async configure(): Promise<AgentIntegrationResult> {
      const configPath = openclawConfigPath(environment);
      let status: MergeStatus;
      try {
        status = await mergeOpenclawConfig(configPath, entry);
      } catch (error: any) {
        return { agent: 'openclaw', status: 'failed', scope: 'global', configPath, message: `Could not merge ${configPath} (${error.message}). Run:\n  ${manualCommands(entry)}` };
      }
      if (!(await environment.commandExists('openclaw'))) {
        return { agent: 'openclaw', status, scope: 'global', configPath, message: `openclaw is not on PATH. Once it is, run:\n  ${manualCommands(entry)}` };
      }
      try {
        await exec('openclaw', ['plugins', 'install', '--link', openclawPluginDir(), '--force']);
        await exec('openclaw', ['plugins', 'enable', PLUGIN_ID]);
      } catch (error: any) {
        return { agent: 'openclaw', status, scope: 'global', configPath, message: `Plugin link failed (${error.message}). Run:\n  ${manualCommands(entry)}` };
      }
      return { agent: 'openclaw', status, scope: 'global', configPath };
    },
    async verify() {
      return (await this.detect('')).configured;
    },
    // The lifecycle is the linked plugin; there is no hooks file to write or verify.
    async lifecycleCapability() { return 'supported'; },
    async configureLifecycle() {
      return { agent: 'openclaw', status: 'unchanged', scope: 'global', configPath: openclawPluginDir(), message: 'Lifecycle runs through the linked plugin.' };
    },
    async verifyLifecycle() { return true; },
  };
}
```

- [ ] **Step 4: Register**

Append `'openclaw'` to the `AgentName` union in `src/cli/agents/types.ts` and to `SUPPORTED_AGENT_NAMES`. In `src/cli/agents/registry.ts`: `import { createOpenclawAdapter } from './openclaw.js';` and in `createAgentRegistry` add `['openclaw', createOpenclawAdapter(environment)],` after the `opencode` line.

- [ ] **Step 5: Run, expect pass**

Run: `npx vitest run tests/cli/openclaw-adapter.test.ts tests/cli/init-flow.test.ts tests/cli/doctor-report.test.ts`
Expected: PASS. If an init/doctor test enumerates adapters by count, update the expected count.

- [ ] **Step 6: Commit**

```bash
git add src/cli/agents/openclaw.ts src/cli/agents/registry.ts tests/cli/openclaw-adapter.test.ts
git commit -m "feat(agents): knowl init openclaw links the plugin and merges openclaw.json"
```

---

### Task 7: Hermes profile

**Files:**
- Create: `src/session/hosts/hermes.ts`
- Modify: `src/session/hosts/index.ts` (replace the placeholder)
- Test: `tests/cli/hosts/hermes-profile.test.ts`

**Interfaces:**
- Produces: `hermesProfile: HostProfile` — `host: 'hermes'`, `hookEvents: []`, `hookConfigStyle: 'none'`, `nativeOutput: false`, `lifecycleClaimable: false`, `denyToolCall` present (`{ denied: reason }`), **no** `stopContext`, `readsFiles`/`writesFiles` on Hermes tool names.
- Produces: `HERMES_EVENTS: NormalizedHookEventName[]` = `['session-start', 'turn-start', 'tool-precheck', 'session-event', 'session-stop']`.

- [ ] **Step 1: Write the failing test**

`tests/cli/hosts/hermes-profile.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { hostProfile } from '../../../src/session/hosts/index.js';

describe('hermes profile', () => {
  const profile = hostProfile('hermes');

  it('accepts the normalized events the plugin sends, and has no turn-stop', () => {
    for (const event of ['session-start', 'turn-start', 'tool-precheck', 'session-event', 'session-stop']) {
      expect(profile.normalizedEvent(event), event).toBe(event);
    }
    // Hermes has no hook between the model's last step and the end of the turn.
    expect(profile.normalizedEvent('turn-stop')).toBeUndefined();
    expect(profile.stopContext).toBeUndefined();
  });

  it('can refuse, in the plugin shape', () => {
    expect(profile.denyToolCall?.('why')).toEqual({ denied: 'why' });
    expect(profile.nativeOutput).toBe(false);
    expect(profile.hookEvents).toEqual([]);
    expect(profile.hookConfigStyle).toBe('none');
    expect(profile.lifecycleClaimable).toBe(false);
  });

  it('knows Hermes tool names', () => {
    expect(profile.readsFiles?.('', 'read_file')).toBe(true);
    for (const tool of ['write_file', 'patch']) expect(profile.writesFiles?.('', tool), tool).toBe(true);
    expect(profile.writesFiles?.('', 'read_file')).toBe(false);
    expect(profile.isShellEvent('', 'terminal')).toBe(true);
  });
});
```

- [ ] **Step 2: Run, expect failure**

Run: `npx vitest run tests/cli/hosts/hermes-profile.test.ts`
Expected: FAIL.

- [ ] **Step 3: Write the profile**

`src/session/hosts/hermes.ts`:

```ts
import type { NormalizedHookEventName } from '../../core/host-hook-types.js';
import type { HostIdentity, HostProfile } from './profile.js';
import { hostString, toolNameIsShell } from './profile.js';

/** The events `integrations/hermes/knowl/__init__.py` sends. No `turn-stop`: see below. */
export const HERMES_EVENTS: NormalizedHookEventName[] = [
  'session-start', 'turn-start', 'tool-precheck', 'session-event', 'session-stop',
];

/**
 * Hermes Agent, whose lifecycle arrives through a Python plugin in `~/.hermes/plugins/knowl`.
 *
 * Hermes plugin hooks (developer guide, 2026-09-03): `on_session_start`, `pre_llm_call`
 * (returns context appended to the user message), `pre_tool_call` (returns
 * `{"action": "block", "message"}` to veto), `post_tool_call`, `on_session_end`. There is **no
 * hook between the model's last step and the end of the turn**, so `stopContext` is absent and
 * the capture nudge rides the MCP tool-result channel, exactly as for MCP-only hosts. Present
 * it would be a claim about a channel the host does not have.
 *
 * `nativeOutput: false`: the plugin reads `context` and `denied` off the host-neutral result.
 * `{denied}` is the plugin contract for the refusal, turned into Hermes' block directive there.
 *
 * Tool names from `tools/file_tools.py` and `tools/terminal_tool.py` in NousResearch/hermes-agent:
 * `read_file`, `write_file`, `patch`, `search_files`, `terminal`; the path argument is `path`.
 */
export const hermesProfile: HostProfile = {
  host: 'hermes',
  hookEvents: [],
  promptEvent: undefined,
  sharesSessionBinding: true,
  nativeOutput: false,
  midTurnDeliveryVerified: false,
  hookConfigStyle: 'none',
  lifecycleClaimable: false,
  identity(raw): HostIdentity {
    return {
      externalSessionId: hostString(raw.session_id),
      externalTurnId: hostString(raw.turn_id),
    };
  },
  normalizedEvent(hostEvent) {
    return HERMES_EVENTS.includes(hostEvent as NormalizedHookEventName)
      ? hostEvent as NormalizedHookEventName
      : undefined;
  },
  isShellEvent(_hostEvent, toolName) {
    return toolNameIsShell(toolName) || toolName === 'terminal';
  },
  startContext() {
    return undefined;
  },
  midTurnContext() {
    return undefined;
  },
  denyToolCall: reason => ({ denied: reason }),
  readsFiles: (_event, tool) => tool === 'read_file',
  writesFiles: (_event, tool) => ['write_file', 'patch'].includes(tool),
};
```

- [ ] **Step 4: Register**

Append `'hermes'` to the `HookHost` union in `src/core/host-hook-types.ts`:

```ts
export type HookHost =
  | 'codex' | 'claude' | 'cursor' | 'claude-desktop' | 'generic'
  | 'copilot' | 'openhands' | 'antigravity' | 'windsurf' | 'cline'
  | 'hermes';
```

In `src/session/hosts/index.ts`: `import { hermesProfile } from './hermes.js';`, add `hermes: hermesProfile,` to `HOST_PROFILES` and `hermes: 'Hermes',` to `HOST_DISPLAY_NAMES`. Append `'hermes'` to `ALL_HOSTS` in `tests/cli/hosts/profile-conformance.test.ts`.

- [ ] **Step 5: Run, expect pass**

Run: `npx vitest run tests/cli/hosts/`
Expected: PASS, including the full conformance suite.

- [ ] **Step 6: Commit**

```bash
git add src/session/hosts/hermes.ts src/session/hosts/index.ts tests/cli/hosts/hermes-profile.test.ts
git commit -m "feat(hosts): Hermes profile"
```

---

### Task 8: Hermes plugin (Python, shipped under `integrations/hermes/knowl/`)

**Files:**
- Create: `integrations/hermes/knowl/plugin.yaml`
- Create: `integrations/hermes/knowl/__init__.py`
- Create: `tests/integrations/hermes/test_plugin.py`
- Test: `tests/cli/hermes-plugin.test.ts` (payload acceptance in TS; runs the Python test when `python` is on PATH)

**Interfaces:**
- Produces: `register(ctx)` registering `on_session_start`, `pre_llm_call`, `pre_tool_call`, `post_tool_call`, `on_session_end`.
- Produces: module-level `run_hook(event: str, payload: dict) -> dict | None` that tests monkeypatch (`knowl.run_hook = fake`), used by every handler through the module global.
- Payloads: `session_id`, `cwd`, `title`, `prompt`, `tool_name`, `tool_input`, `status`.

- [ ] **Step 1: Write the failing Python test**

`tests/integrations/hermes/test_plugin.py`:

```python
"""Unit test for the shipped Hermes plugin. Run: python -m unittest tests/integrations/hermes/test_plugin.py"""
import importlib.util
import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
PLUGIN = os.path.join(HERE, "..", "..", "..", "integrations", "hermes", "knowl", "__init__.py")


def load_plugin():
    spec = importlib.util.spec_from_file_location("knowl_hermes_plugin", PLUGIN)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class FakeCtx:
    def __init__(self):
        self.hooks = {}

    def register_hook(self, name, fn):
        self.hooks[name] = fn


class PluginTest(unittest.TestCase):
    def setUp(self):
        self.plugin = load_plugin()
        self.calls = []
        self.results = {}

        def fake_run(event, payload):
            self.calls.append((event, payload))
            return self.results.get(event)

        self.plugin.run_hook = fake_run
        self.ctx = FakeCtx()
        self.plugin.register(self.ctx)

    def test_registers_the_five_hooks(self):
        self.assertEqual(
            sorted(self.ctx.hooks),
            ["on_session_end", "on_session_start", "post_tool_call", "pre_llm_call", "pre_tool_call"],
        )

    def test_session_id_flows_from_session_start(self):
        self.ctx.hooks["on_session_start"]("sess-1", model="m", platform="cli")
        self.ctx.hooks["pre_llm_call"]("sess-1", "fix it", [], True, model="m", platform="cli")
        self.assertEqual(self.calls[0][0], "session-start")
        self.assertEqual(self.calls[1][0], "turn-start")
        for _event, payload in self.calls:
            self.assertEqual(payload["session_id"], "sess-1")
            self.assertTrue(payload["cwd"])

    def test_turn_card_and_held_bootstrap_are_returned_as_context(self):
        self.results["session-start"] = {"context": "BOOT"}
        self.results["turn-start"] = {"context": "TURN"}
        self.ctx.hooks["on_session_start"]("s")
        out = self.ctx.hooks["pre_llm_call"]("s", "hello there", [], True)
        self.assertEqual(out, {"context": "BOOT\n\nTURN"})
        # Bootstrap is delivered once.
        out2 = self.ctx.hooks["pre_llm_call"]("s", "again please", [], False)
        self.assertEqual(out2, {"context": "TURN"})

    def test_pre_tool_call_blocks_on_denied_and_holds_advice(self):
        self.results["tool-precheck"] = {"denied": "trap"}
        self.ctx.hooks["on_session_start"]("s")
        out = self.ctx.hooks["pre_tool_call"]("write_file", {"path": "a.py"}, "s")
        self.assertEqual(out, {"action": "block", "message": "trap"})
        self.assertEqual(self.calls[-1][1]["tool_name"], "write_file")
        self.assertEqual(self.calls[-1][1]["tool_input"], {"path": "a.py"})

        self.results["tool-precheck"] = {"context": "heads up"}
        self.assertIsNone(self.ctx.hooks["pre_tool_call"]("write_file", {"path": "a.py"}, "s"))
        out = self.ctx.hooks["pre_llm_call"]("s", "next turn text", [], False)
        self.assertEqual(out, {"context": "heads up"})

    def test_context_is_capped(self):
        self.results["turn-start"] = {"context": "x" * 20_000}
        self.ctx.hooks["on_session_start"]("s")
        out = self.ctx.hooks["pre_llm_call"]("s", "long", [], False)
        self.assertLessEqual(len(out["context"]), self.plugin.MAX_CONTEXT_CHARS)

    def test_a_failing_hook_allows(self):
        def boom(event, payload):
            raise RuntimeError("boom")

        self.plugin.run_hook = boom
        self.ctx.hooks["on_session_start"]("s")
        self.assertIsNone(self.ctx.hooks["pre_tool_call"]("write_file", {}, "s"))
        self.assertIsNone(self.ctx.hooks["pre_llm_call"]("s", "p", [], False))
        self.assertIsNone(self.ctx.hooks["post_tool_call"]("read_file", {}, "ok", "s", 3))
        self.assertIsNone(self.ctx.hooks["on_session_end"]("s", completed=True, interrupted=False))


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Write the vitest wrapper and payload test**

`tests/cli/hermes-plugin.test.ts`:

```ts
import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { normalizeHostHook } from '../../src/cli/agents/host-hook.js';
import { commandExistsOnPath } from '../../src/cli/agents/command-exists.js';

const ROOT = path.resolve('.knowl-hermes-plugin-test');

/** Mirrors `_base_payload` in `integrations/hermes/knowl/__init__.py`. */
const basePayload = { session_id: 'sess-1', cwd: ROOT };

describe('Hermes plugin payloads', () => {
  it('are accepted for every event the plugin sends', () => {
    for (const event of ['session-start', 'turn-start', 'tool-precheck', 'session-event', 'session-stop'] as const) {
      const normalized = normalizeHostHook('hermes', event, {
        ...basePayload,
        ...(event === 'tool-precheck' || event === 'session-event'
          ? { tool_name: 'write_file', tool_input: { path: path.join(ROOT, 'src/a.py') } }
          : {}),
      });
      expect(normalized.event, event).toBe(event);
      expect(normalized.externalSessionId, event).toBe('sess-1');
    }
    const precheck = normalizeHostHook('hermes', 'tool-precheck', { ...basePayload, tool_name: 'write_file', tool_input: { path: path.join(ROOT, 'src/a.py') } });
    expect(precheck.toolName).toBe('write_file');
    expect(precheck.payload.changedPaths).toEqual(['src/a.py']);
  });
});

describe('Hermes plugin (python)', () => {
  it('passes its unittest when python is available', async () => {
    const python = (await commandExistsOnPath('python')) ? 'python' : (await commandExistsOnPath('python3')) ? 'python3' : null;
    if (!python) return; // No interpreter here; CI on the Linux leg has one.
    const { stderr } = await promisify(execFile)(python, ['-m', 'unittest', 'tests/integrations/hermes/test_plugin.py'], { cwd: path.resolve('.') });
    expect(stderr).toContain('OK');
  }, 30_000);
});
```

- [ ] **Step 3: Run, expect failure**

Run: `npx vitest run tests/cli/hermes-plugin.test.ts`
Expected: the payload test PASSES already (the profile exists); the Python test FAILS with `No such file` for the plugin (or is skipped without Python — then run `python -m unittest tests/integrations/hermes/test_plugin.py` by hand and see it fail).

- [ ] **Step 4: Write the manifest**

`integrations/hermes/knowl/plugin.yaml`:

```yaml
name: knowl
version: 1.0.0
description: Knowl project memory — bootstrap context, per-turn recall, change impact and a write gate, backed by the knowl CLI.
provides_hooks:
  - on_session_start
  - pre_llm_call
  - pre_tool_call
  - post_tool_call
  - on_session_end
```

- [ ] **Step 5: Write the plugin**

`integrations/hermes/knowl/__init__.py`:

```python
"""Knowl lifecycle plugin for Hermes Agent.

Hermes plugins are Python modules under ``~/.hermes/plugins/<name>/`` that register hook callbacks
in ``register(ctx)``. Every callback here forwards one normalized event to
``knowl agent-hook hermes <event> --json`` -- the same entry point every other host's hooks use --
and maps the result into the return value Hermes documents for that hook.

Install: ``knowl init hermes`` copies this directory into place, adds the ``mcp_servers.knowl`` entry
to ``~/.hermes/config.yaml``, and runs ``hermes plugins enable knowl``.

What reaches the model, and where:

* ``pre_llm_call`` returns ``{"context": ...}``, which Hermes appends to the user message (capped at
  10,000 characters). The bootstrap card from ``on_session_start`` -- whose own return value Hermes
  ignores -- and any impact card held from ``pre_tool_call`` ride the next one of these.
* ``pre_tool_call`` returns ``{"action": "block", "message": ...}`` when the write gate refused.
* There is no turn-stop hook in Hermes, so the capture nudge is not delivered here; it rides the
  MCP tool results instead.

Failure: this runs inside Hermes' process, so nothing here raises. A miss, a timeout or a crash
returns ``None``, which allows the action. ``run_hook`` is a module global so tests can replace it.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import time
import random

HOOK_TIMEOUT_S = 10
# Hermes caps injected context at 10,000 characters; overflow is spilled to a file with a preview,
# which is worse than a shorter card. Stay under the cap so the card itself arrives.
MAX_CONTEXT_CHARS = 9_000

_FALLBACK_SESSION_ID = f"hermes-{int(time.time()):x}-{random.randrange(1 << 20):x}"
_state = {"session_id": None, "held": []}


def run_hook(event: str, payload: dict):
    """Run one ``knowl agent-hook`` process; return its parsed stdout, or ``None``. Never raises."""
    try:
        command = "knowl.cmd" if sys.platform == "win32" else "knowl"
        completed = subprocess.run(
            [command, "agent-hook", "hermes", event, "--json"],
            input=json.dumps(payload),
            capture_output=True,
            text=True,
            timeout=HOOK_TIMEOUT_S,
        )
        out = completed.stdout.strip()
        return json.loads(out) if out else None
    except Exception:  # noqa: BLE001 -- a hook failure must allow the action
        return None


def _call(event: str, **extra):
    payload = {
        "session_id": _state["session_id"] or _FALLBACK_SESSION_ID,
        "cwd": os.getcwd(),
        **extra,
    }
    try:
        return run_hook(event, payload)
    except Exception:  # noqa: BLE001
        return None


def _text(value):
    return value if isinstance(value, str) and value else None


def _hold(text):
    if text:
        _state["held"].append(text)


def _on_session_start(session_id, *args, **kwargs):
    _state["session_id"] = session_id or _state["session_id"]
    result = _call("session-start", title="Agent session")
    _hold(_text((result or {}).get("context")))


def _pre_llm_call(session_id, user_message, conversation_history=None, is_first_turn=False, *args, **kwargs):
    if session_id:
        _state["session_id"] = session_id
    result = _call("turn-start", title="Agent turn", prompt=user_message if isinstance(user_message, str) else None)
    parts = list(_state["held"])
    _state["held"] = []
    card = _text((result or {}).get("context"))
    if card:
        parts.append(card)
    if not parts:
        return None
    text = "\n\n".join(parts)
    if len(text) > MAX_CONTEXT_CHARS:
        # Trim the held (older) part first; the current turn's card is the one that matters now.
        text = text[-MAX_CONTEXT_CHARS:]
    return {"context": text}


def _pre_tool_call(tool_name, args, task_id=None, *rest, **kwargs):
    result = _call("tool-precheck", tool_name=tool_name, tool_input=args if isinstance(args, dict) else {}) or {}
    denied = _text(result.get("denied"))
    if denied:
        return {"action": "block", "message": denied}
    _hold(_text(result.get("context")))
    return None


def _post_tool_call(tool_name, args, result=None, task_id=None, duration_ms=None, *rest, **kwargs):
    _call("session-event", tool_name=tool_name, tool_input=args if isinstance(args, dict) else {})
    return None


def _on_session_end(session_id, completed=True, interrupted=False, *args, **kwargs):
    _call("session-stop", title="Agent session", status="failed" if interrupted else "finished")
    return None


def register(ctx):
    ctx.register_hook("on_session_start", _on_session_start)
    ctx.register_hook("pre_llm_call", _pre_llm_call)
    ctx.register_hook("pre_tool_call", _pre_tool_call)
    ctx.register_hook("post_tool_call", _post_tool_call)
    ctx.register_hook("on_session_end", _on_session_end)
```

- [ ] **Step 6: Run, expect pass**

Run: `python -m unittest tests/integrations/hermes/test_plugin.py` (or `python3`)
Expected: `OK` (6 tests).

Run: `npx vitest run tests/cli/hermes-plugin.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add integrations/hermes tests/integrations tests/cli/hermes-plugin.test.ts
git commit -m "feat(integrations): Hermes plugin translating hooks to knowl agent-hook"
```

---

### Task 9: Hermes adapter — copy the plugin and merge `config.yaml`

**Files:**
- Create: `src/cli/agents/hermes.ts`
- Modify: `src/cli/agents/registry.ts` (register)
- Test: `tests/cli/hermes-adapter.test.ts`

**Interfaces:**
- Produces: `createHermesAdapter(environment: AgentEnvironment, options?: { exec?: (file: string, args: string[]) => Promise<void> }): AgentAdapter`.
- Produces: `hermesHomeDir(environment): string` — `process.env.HERMES_HOME` or `<home>/.hermes`.
- Produces: `hermesPluginSourceDir(): string` — `<packageRootDir()>/integrations/hermes/knowl`.

- [ ] **Step 1: Write the failing test**

`tests/cli/hermes-adapter.test.ts`:

```ts
import path from 'node:path';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHermesAdapter } from '../../src/cli/agents/hermes.js';
import { parseAgentNames } from '../../src/cli/agents/registry.js';

const dirs: string[] = [];
const workspace = async () => { const d = await mkdtemp(path.join(tmpdir(), 'knowl-hermes-')); dirs.push(d); return d; };
afterAll(async () => { for (const d of dirs) await rm(d, { recursive: true, force: true }); });

describe('hermes adapter', () => {
  let home: string;
  const saved = process.env.HERMES_HOME;
  beforeEach(async () => { home = await workspace(); process.env.HERMES_HOME = home; });
  afterEach(() => { if (saved === undefined) delete process.env.HERMES_HOME; else process.env.HERMES_HOME = saved; });

  const env = (installed: boolean) => ({ platform: 'linux' as const, homeDir: '/nowhere', appDataDir: '/nowhere', commandExists: async () => installed });

  it('is a supported agent name', () => {
    expect(parseAgentNames(['hermes'])).toEqual(['hermes']);
  });

  it('copies the plugin, writes mcp_servers.knowl and enables the plugin', async () => {
    const calls: string[][] = [];
    const adapter = createHermesAdapter(env(true), { exec: async (f, a) => { calls.push([f, ...a]); } });
    const result = await adapter.configure('/repo');
    expect(result.status).toBe('configured');
    expect(result.scope).toBe('global');
    const config = await readFile(path.join(home, 'config.yaml'), 'utf8');
    expect(config).toContain('mcp_servers:\n  knowl:\n    command: knowl\n    args:\n      - serve\n      - --host\n      - hermes');
    const init = await readFile(path.join(home, 'plugins', 'knowl', '__init__.py'), 'utf8');
    expect(init).toContain('agent-hook');
    expect(await readFile(path.join(home, 'plugins', 'knowl', 'plugin.yaml'), 'utf8')).toContain('name: knowl');
    expect(calls).toEqual([['hermes', 'plugins', 'enable', 'knowl']]);
    expect(await adapter.verify('/repo')).toBe(true);
    expect(result.message).toContain('/reload-mcp');
  });

  it('keeps the rest of config.yaml and is idempotent', async () => {
    await writeFile(path.join(home, 'config.yaml'), '# hermes\nmodel: x\nmcp_servers:\n  other:\n    command: other\n', 'utf8');
    const adapter = createHermesAdapter(env(true), { exec: async () => {} });
    expect((await adapter.configure('/repo')).status).toBe('updated');
    expect((await adapter.configure('/repo')).status).toBe('unchanged');
    const config = await readFile(path.join(home, 'config.yaml'), 'utf8');
    expect(config).toContain('# hermes');
    expect(config).toContain('model: x');
    expect(config).toContain('other:\n    command: other');
  });

  it('prints the enable command when hermes is not on PATH', async () => {
    const adapter = createHermesAdapter(env(false), { exec: async () => { throw new Error('must not run'); } });
    const result = await adapter.configure('/repo');
    expect(result.status).toBe('configured');
    expect(result.message).toContain('hermes plugins enable knowl');
  });

  it('reports an unparseable config.yaml and leaves it alone', async () => {
    await writeFile(path.join(home, 'config.yaml'), 'a: [\n', 'utf8');
    const adapter = createHermesAdapter(env(true), { exec: async () => {} });
    const result = await adapter.configure('/repo');
    expect(result.status).toBe('failed');
    expect(await readFile(path.join(home, 'config.yaml'), 'utf8')).toBe('a: [\n');
  });
});
```

- [ ] **Step 2: Run, expect failure**

Run: `npx vitest run tests/cli/hermes-adapter.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the adapter**

`src/cli/agents/hermes.ts`:

```ts
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { Document } from 'yaml';
import { McpEntry, MergeStatus, mcpEntryMatches, mergeYamlDocument, packageRootDir, readYamlDocument } from './files.js';
import { AgentAdapter, AgentDetection, AgentEnvironment, AgentIntegrationResult } from './types.js';
import { KNOWL_MCP_SERVER_KEY } from '../../core/knowl-guidance.js';

const execFileAsync = promisify(execFile);

/** `HERMES_HOME`, else `~/.hermes` -- Hermes' own constant. */
export function hermesHomeDir(environment: AgentEnvironment): string {
  return process.env.HERMES_HOME || path.join(environment.homeDir, '.hermes');
}

export function hermesPluginSourceDir(): string {
  return path.join(packageRootDir(), 'integrations', 'hermes', 'knowl');
}

const PLUGIN_FILES = ['plugin.yaml', '__init__.py'];

function serverMatches(doc: Document, entry: McpEntry): boolean {
  const server = doc.getIn(['mcp_servers', KNOWL_MCP_SERVER_KEY]);
  const json = server && typeof (server as any).toJSON === 'function' ? (server as any).toJSON() : server;
  return mcpEntryMatches(json, entry);
}

function mutateHermesConfig(doc: Document, entry: McpEntry): boolean {
  if (serverMatches(doc, entry)) return false;
  doc.setIn(['mcp_servers', KNOWL_MCP_SERVER_KEY], doc.createNode({ command: entry.command, args: entry.args }));
  return true;
}

async function pluginInstalled(home: string): Promise<boolean> {
  try {
    await Promise.all(PLUGIN_FILES.map(file => fs.access(path.join(home, 'plugins', 'knowl', file))));
    return true;
  } catch {
    return false;
  }
}

/**
 * Hermes: a global `config.yaml` (there is no project-local one) plus a plugin directory.
 *
 * The plugin files are copied, not linked: Hermes runs from a managed venv and `hermes update`
 * re-runs install hooks, and a symlink into a `node_modules` that npm may replace is a plugin
 * that vanishes on the next `npm update`. Only the files Knowl ships are overwritten.
 */
export function createHermesAdapter(
  environment: AgentEnvironment,
  options: { exec?: (file: string, args: string[]) => Promise<void> } = {},
): AgentAdapter {
  const exec = options.exec ?? (async (file, args) => { await execFileAsync(file, args); });
  const entry: McpEntry = { command: environment.platform === 'win32' ? 'knowl.cmd' : 'knowl', args: ['serve', '--host', 'hermes'] };
  const configPath = () => path.join(hermesHomeDir(environment), 'config.yaml');
  const reload = 'In a running Hermes chat, type /reload-mcp to connect the knowl server.';
  return {
    name: 'hermes',
    label: 'Hermes Agent',
    async detect(): Promise<AgentDetection> {
      let configured = false;
      try {
        const doc = await readYamlDocument(configPath());
        configured = doc !== undefined && serverMatches(doc, entry) && await pluginInstalled(hermesHomeDir(environment));
      } catch {
        configured = false;
      }
      return { installed: await environment.commandExists('hermes'), configured, scope: 'global', configPath: configPath() };
    },
    async configure(): Promise<AgentIntegrationResult> {
      const home = hermesHomeDir(environment);
      let status: MergeStatus;
      try {
        status = await mergeYamlDocument(configPath(), doc => mutateHermesConfig(doc, entry));
      } catch (error: any) {
        return { agent: 'hermes', status: 'failed', scope: 'global', configPath: configPath(), message: `Could not merge ${configPath()}: ${error.message}` };
      }
      const target = path.join(home, 'plugins', 'knowl');
      await fs.mkdir(target, { recursive: true });
      for (const file of PLUGIN_FILES) await fs.copyFile(path.join(hermesPluginSourceDir(), file), path.join(target, file));
      if (!(await environment.commandExists('hermes'))) {
        return { agent: 'hermes', status, scope: 'global', configPath: configPath(), message: `hermes is not on PATH. Once it is, run: hermes plugins enable knowl. ${reload}` };
      }
      try {
        await exec('hermes', ['plugins', 'enable', 'knowl']);
      } catch (error: any) {
        return { agent: 'hermes', status, scope: 'global', configPath: configPath(), message: `Could not enable the plugin (${error.message}). Run: hermes plugins enable knowl. ${reload}` };
      }
      return { agent: 'hermes', status, scope: 'global', configPath: configPath(), message: reload };
    },
    async verify() {
      return (await this.detect('')).configured;
    },
    async lifecycleCapability() { return 'supported'; },
    async configureLifecycle() {
      return { agent: 'hermes', status: 'unchanged', scope: 'global', configPath: path.join(hermesHomeDir(environment), 'plugins', 'knowl'), message: 'Lifecycle runs through the installed plugin.' };
    },
    async verifyLifecycle() { return pluginInstalled(hermesHomeDir(environment)); },
  };
}
```

- [ ] **Step 4: Register**

Append `'hermes'` to the `AgentName` union in `src/cli/agents/types.ts`:

```ts
export type AgentName =
  | 'codex' | 'claude' | 'cursor' | 'claude-desktop'
  | 'copilot' | 'openhands' | 'antigravity' | 'windsurf' | 'cline' | 'opencode'
  | 'hermes';
```

and to `SUPPORTED_AGENT_NAMES` in `src/cli/agents/registry.ts`. Then `import { createHermesAdapter } from './hermes.js';` and add `['hermes', createHermesAdapter(environment)],` after the `opencode` line in `createAgentRegistry`.

- [ ] **Step 5: Run, expect pass**

Run: `npx vitest run tests/cli/hermes-adapter.test.ts tests/cli/agent-adapters.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/cli/agents/hermes.ts src/cli/agents/registry.ts tests/cli/hermes-adapter.test.ts
git commit -m "feat(agents): knowl init hermes installs the plugin and merges config.yaml"
```

---

### Task 10: CLI text, docs, changelog

**Files:**
- Modify: `src/cli/program.ts:3665` (agent-hook `<host>` description)
- Modify: `README.md:353-362` (host table)
- Modify: `docs/hosts.md:22-34` (support matrix) and the Setup section (`## Setup`, line 46 onward)
- Modify: `CHANGELOG.md` (create `## Unreleased` above `## 5.18.0`)

- [ ] **Step 1: agent-hook description**

In `src/cli/program.ts`, the `.argument('<host>', …)` under `.command('agent-hook')` becomes:

```ts
  .argument('<host>', 'claude, codex, copilot, cursor, openhands, antigravity, windsurf, cline, deepseek, openclaw, hermes, claude-desktop, or generic')
```

- [ ] **Step 2: README host table**

Insert after the `| Cline |` row:

```markdown
| DeepSeek harness | Yes | Yes | Yes | Yes | Claude-format hooks via dsh's bridge; one global patch row |
| OpenClaw | Yes | Yes | Yes | Yes* | Turn card lands in the system prompt; *stop nudge is delivered next turn, not enforced |
| Hermes Agent | Yes | Yes | Yes | via MCP | Python plugin; Hermes has no stop hook |
```

- [ ] **Step 3: docs/hosts.md matrix and setup**

In the support matrix insert after the Cline row:

```markdown
| **DeepSeek harness** (dsh) | ✅ | ✅ | ⚠️ MCP | ✅ | ✅ |
| **OpenClaw** (with the plugin) | ✅ | ✅ system prompt | ⚠️ | ✅ | ⚠️ next turn |
| **Hermes Agent** (with the plugin) | ✅ | ✅ | ⚠️ | ✅ | via MCP |
```

After the paragraph explaining ⚠️ (line ~38), add:

```markdown
"⚠️ next turn" is OpenClaw's stop nudge: `agent_end` cannot block, so the sentence is prepended to the next prompt build instead of withholding the stop. Same words, weaker teeth.
```

In `## Setup`, after the Cline paragraph (ends line ~109), add:

```markdown
**DeepSeek harness** reads Claude Code's hook format through its own bridge, so `knowl init deepseek` writes a Claude-shaped `.dsh/hooks.json` in the project and merges two rows into `$DSH_HOME/cordis.patch.yml` (default `~/.dsh`): the `@deepseek-ai/dsh-hooks-claude-code` bridge pointed at `./.dsh/hooks.json`, and the `@deepseek-ai/dsh-mcp-client` row for `knowl serve --host deepseek`. The patch is global and read once at launch; the hooks path is relative to the directory you launch `dsh` from, so start dsh in the project root. dsh blocks a tool on exit code 2 and its `Stop` hook can force another step, which makes it a full 6/6 host.

**OpenClaw** loads plugins into its own process. `knowl init openclaw` runs `openclaw plugins install --link <knowl>/integrations/openclaw --force` and `openclaw plugins enable knowl`, and merges `mcp.servers.knowl` plus `plugins.entries.knowl.hooks.allowConversationAccess: true` into `~/.openclaw/openclaw.json` (or `$OPENCLAW_CONFIG_PATH`). The plugin returns the turn card as `prependSystemContext` from `before_prompt_build` — the system-prompt slot no shell-hook host has — and blocks a refused write from `before_tool_call`. If your `openclaw.json` uses JSON5 comments, init prints the `openclaw mcp add` command instead of editing the file.

**Hermes Agent** loads Python plugins from `~/.hermes/plugins/`. `knowl init hermes` copies `integrations/hermes/knowl/` there, adds `mcp_servers.knowl` to `~/.hermes/config.yaml` and runs `hermes plugins enable knowl`; type `/reload-mcp` in a running chat to pick the server up. The plugin's `pre_llm_call` returns the turn card as context (Hermes appends it to the user message), and `pre_tool_call` returns `{"action": "block"}` for a refused write. Hermes has no hook at turn stop, so the capture nudge rides MCP tool results there. A `MemoryProvider` implementation, which would add a system-prompt slot and compaction hooks, is a follow-up contribution to NousResearch/hermes-agent.
```

- [ ] **Step 4: CHANGELOG**

At the top of `CHANGELOG.md`, directly above `## 5.18.0 — 2026-09-03`, insert:

```markdown
## Unreleased

Three more hosts at Claude Code parity: `knowl init deepseek`, `knowl init openclaw`, `knowl init hermes`.

**DeepSeek harness** consumes Claude Code's hook format through its own bridge, so the integration is a Claude-shaped `.dsh/hooks.json` plus two rows merged into `$DSH_HOME/cordis.patch.yml` — the hook bridge and the MCP client. Deny is exit code 2, and dsh's `Stop` block forces another step, so every capability including the capture nudge is real there.

**OpenClaw** gets an in-process plugin, shipped under `integrations/openclaw/` and linked by init. Its `before_prompt_build` hook puts the turn card in the system prompt, which no shell-hook host can do; `before_tool_call` blocks a refused write. `agent_end` cannot block, so the stop nudge is delivered on the next turn rather than by withholding the stop.

**Hermes Agent** gets a Python plugin, shipped under `integrations/hermes/knowl/` and copied into `~/.hermes/plugins/` by init, plus an `mcp_servers.knowl` entry in `config.yaml`. `pre_llm_call` carries the turn card, `pre_tool_call` blocks a refused write. Hermes has no turn-stop hook, so the capture nudge rides MCP tool results.

User-owned YAML config files (`cordis.patch.yml`, `config.yaml`) are merged as documents: comments, ordering and the `!!js` tag dsh uses all survive, and a file that fails to parse is reported and left untouched. `yaml` is now a direct dependency.
```

- [ ] **Step 5: Commit**

```bash
git add src/cli/program.ts README.md docs/hosts.md CHANGELOG.md
git commit -m "docs: DeepSeek harness, OpenClaw and Hermes hosts"
```

---

### Task 11: Full verification

- [ ] **Step 1: Build**

Run: `npm run build`
Expected: exit 0. Confirm `integrations/openclaw` and `integrations/hermes` are inside the published file set: `npm pack --dry-run 2>&1 | grep integrations` lists `integrations/openclaw/index.mjs`, `integrations/openclaw/package.json`, `integrations/openclaw/openclaw.plugin.json`, `integrations/hermes/knowl/__init__.py`, `integrations/hermes/knowl/plugin.yaml` (the `files` array already includes `integrations`).

- [ ] **Step 2: Tests**

Run: `npm test`
Expected: all green. Known places that count hosts or agent names and may need their expectation raised by three: `tests/cli/hosts/profile-conformance.test.ts` (done in Task 2), `tests/cli/init-flow.test.ts`, `tests/cli/doctor-report.test.ts`, any snapshot of `knowl init --help`.

- [ ] **Step 3: Lint**

Run: `npx eslint .`
Expected: clean.

- [ ] **Step 4: Smoke the CLI**

```bash
node dist/index.js init --help | grep -E 'deepseek|openclaw|hermes'
echo '{"session_id":"s1","cwd":"'"$PWD"'","tool_name":"write","tool_input":{"path":"src/x.ts"}}' | node dist/index.js agent-hook openclaw tool-precheck --json
```

Expected: the three names appear; the second command prints a JSON object (host-neutral result) and exits 0.

- [ ] **Step 5: Record manual-verification status**

In the PR description, list per host whether a real session was observed (bootstrap card, turn card, a denied write, and for dsh/OpenClaw a stop nudge). Any host not observed keeps `midTurnDeliveryVerified: false` — that is already what the profiles say.

- [ ] **Step 6: Commit any fixes, then open the PR**

```bash
git push -u origin feat/harness-integrations
gh pr create --title "feat(hosts): DeepSeek harness, OpenClaw and Hermes at Claude Code parity" --body-file docs/superpowers/specs/2026-09-03-harness-integrations-design.md
```
