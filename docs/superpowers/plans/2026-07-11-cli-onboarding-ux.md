# CLI Onboarding UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace manual MCP connection setup and ambiguous configuration commands with idempotent agent-aware initialization, interactive CLI configuration, and default-on local vector search.

**Architecture:** Keep `src/index.ts` as a thin Commander entrypoint. Move configuration mutation/UI into `src/cli/config/`, agent detection/configuration into `src/cli/agents/`, then compose both through an init orchestrator. Agent adapters share safe JSON/TOML merge and backup helpers while owning target-specific paths and verification.

**Tech Stack:** TypeScript ESM, Commander, `@inquirer/prompts`, `smol-toml`, Node filesystem/process APIs, Vitest, tsup.

---

## File Map

**Create:**

- `src/cli/config/schema.ts` — known config keys, parsing, validation, defaults.
- `src/cli/config/service.ts` — get/set/reset operations and backup-before-save behavior.
- `src/cli/config/ui.ts` — interactive categorized configuration flow.
- `src/cli/agents/types.ts` — adapter/result contracts and supported agent names.
- `src/cli/agents/files.ts` — safe JSON/TOML read, merge, backup, atomic write helpers.
- `src/cli/agents/project-adapters.ts` — Codex and Claude Code project MCP adapters.
- `src/cli/agents/cursor.ts` — Cursor detection and project `.cursor/mcp.json` reconciliation.
- `src/cli/agents/desktop-adapter.ts` — Claude Desktop detection and global JSON reconciliation.
- `src/cli/agents/registry.ts` — adapter registry, detection, name validation.
- `src/cli/init-flow.ts` — selection, confirmations, reconciliation, summary, exit status.
- `tests/cli/config-service.test.ts` — typed config mutation/default tests.
- `tests/cli/agent-adapters.test.ts` — adapter detection/merge/idempotency tests.
- `tests/cli/init-flow.test.ts` — interactive/explicit init orchestration tests.

**Modify:**

- `package.json`, `package-lock.json` — add prompt and TOML dependencies.
- `src/core/config.ts` — vector default-on, raw load/save helpers, preserve explicit opt-out.
- `src/index.ts` — replace init arguments, remove connect, add config subcommands/UI delegation.
- `tests/cli/cli.test.ts` — update end-to-end command expectations.
- `README.md` — document new quick start and config UX.

## Task 1: Add CLI UI and TOML Dependencies

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`

- [ ] **Step 1: Install runtime dependencies**

Run:

```powershell
npm.cmd install @inquirer/prompts smol-toml
```

Expected: command succeeds; both packages appear under `dependencies`; lockfile updates.

- [ ] **Step 2: Verify the project still builds**

Run:

```powershell
npm.cmd run build
```

Expected: PASS; `dist/index.js` generated without module-resolution errors.

- [ ] **Step 3: Commit**

```powershell
git add package.json package-lock.json
git commit -m "build: add CLI prompt and TOML support"
```

## Task 2: Define Validated Configuration Operations

**Files:**
- Create: `src/cli/config/schema.ts`
- Create: `src/cli/config/service.ts`
- Test: `tests/cli/config-service.test.ts`
- Modify: `src/core/config.ts`
- Modify: `src/ai/embeddings.ts`
- Test: `tests/ai/embeddings.test.ts`

- [ ] **Step 1: Write failing tests for default-on vectors and explicit opt-out preservation**

Create `tests/cli/config-service.test.ts` with:

```ts
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { DEFAULT_CONFIG, upgradeConfigDefaults } from '../../src/core/config.js';

const ROOT = path.resolve('.knowl-config-service-test');

afterEach(async () => {
  await fs.rm(ROOT, { recursive: true, force: true });
});

describe('config defaults', () => {
  it('enables local vector search by default', () => {
    expect(DEFAULT_CONFIG.search?.vector).toEqual({
      enabled: true,
      provider: 'local',
      model: 'Xenova/all-MiniLM-L6-v2',
      dtype: 'q8',
    });
  });

  it('preserves an explicit vector opt-out during upgrade', async () => {
    await fs.mkdir(path.join(ROOT, '.knowl'), { recursive: true });
    await fs.writeFile(path.join(ROOT, '.knowl', 'config.json'), JSON.stringify({
      version: 1,
      security: { rejectSecrets: true, secretPatterns: [] },
      search: { vector: { enabled: false } },
    }));

    await upgradeConfigDefaults(ROOT);

    const saved = JSON.parse(await fs.readFile(path.join(ROOT, '.knowl', 'config.json'), 'utf8'));
    expect(saved.search.vector.enabled).toBe(false);
    expect(saved.search.vector.provider).toBe('local');
  });
});
```

- [ ] **Step 2: Run tests to verify the default test fails**

Run:

```powershell
npm.cmd test -- tests/cli/config-service.test.ts
```

Expected: FAIL because `DEFAULT_CONFIG.search.vector.enabled` is `false`.

- [ ] **Step 3: Change the vector default**

In `src/core/config.ts`, change only:

```ts
search: {
  vector: {
    enabled: true,
    provider: 'local',
    model: 'Xenova/all-MiniLM-L6-v2',
    dtype: 'q8',
  },
},
```

- [ ] **Step 4: Add failing tests for typed get/set/reset and backups**

Append to `tests/cli/config-service.test.ts`:

```ts
import { getConfigValue, resetConfigValue, setConfigValue } from '../../src/cli/config/service.js';

async function writeConfig(value = DEFAULT_CONFIG) {
  await fs.mkdir(path.join(ROOT, '.knowl'), { recursive: true });
  await fs.writeFile(
    path.join(ROOT, '.knowl', 'config.json'),
    JSON.stringify(value, null, 2),
    'utf8',
  );
}

describe('config service', () => {
  it('gets and validates known keys', async () => {
    await writeConfig();
    expect(await getConfigValue(ROOT, 'search.vector.enabled')).toBe(true);
    await expect(getConfigValue(ROOT, 'search.unknown')).rejects.toThrow('Unknown config key');
  });

  it('sets typed values and creates a backup', async () => {
    await writeConfig();
    await setConfigValue(ROOT, 'search.vector.enabled', 'false');
    expect(await getConfigValue(ROOT, 'search.vector.enabled')).toBe(false);
    await expect(fs.access(path.join(ROOT, '.knowl', 'config.json.backup'))).resolves.toBeUndefined();
  });

  it('rejects invalid enum values', async () => {
    await writeConfig();
    await expect(setConfigValue(ROOT, 'search.vector.dtype', 'q2')).rejects.toThrow('Expected one of');
  });

  it('resets one key to its default', async () => {
    await writeConfig();
    await setConfigValue(ROOT, 'security.rejectSecrets', 'false');
    await resetConfigValue(ROOT, 'security.rejectSecrets');
    expect(await getConfigValue(ROOT, 'security.rejectSecrets')).toBe(true);
  });

  it('preserves env placeholders and redacts API keys', async () => {
    await writeConfig({
      ...DEFAULT_CONFIG,
      ai: { provider: 'openai', model: 'gpt-4o-mini', apiKey: '${OPENAI_API_KEY}' },
    });
    await setConfigValue(ROOT, 'search.vector.enabled', 'false');
    const raw = JSON.parse(await fs.readFile(path.join(ROOT, '.knowl', 'config.json'), 'utf8'));
    expect(raw.ai.apiKey).toBe('${OPENAI_API_KEY}');
    expect(await getConfigValue(ROOT, 'ai.apiKey')).toBe('********');
  });
});
```

- [ ] **Step 5: Run tests to verify missing modules fail**

Run:

```powershell
npm.cmd test -- tests/cli/config-service.test.ts
```

Expected: FAIL because `src/cli/config/service.ts` does not exist.

- [ ] **Step 6: Implement the schema registry**

Create `src/cli/config/schema.ts`:

```ts
import { DEFAULT_CONFIG } from '../../core/config.js';

export type ConfigKey =
  | 'security.rejectSecrets'
  | 'security.secretPatterns'
  | 'search.vector.enabled'
  | 'search.vector.provider'
  | 'search.vector.model'
  | 'search.vector.dtype'
  | 'search.vector.cacheDir'
  | 'ai.provider'
  | 'ai.model'
  | 'ai.temperature'
  | 'ai.baseUrl'
  | 'ai.apiKey';

type ConfigField = {
  key: ConfigKey;
  category: 'Search' | 'Security' | 'AI provider';
  secret?: boolean;
  parse(raw: string): unknown;
  defaultValue?: unknown;
};

const booleanValue = (raw: string) => {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  throw new Error('Expected true or false');
};

const enumValue = <T extends string>(values: readonly T[]) => (raw: string): T => {
  if (values.includes(raw as T)) return raw as T;
  throw new Error(`Expected one of: ${values.join(', ')}`);
};

const optionalNumber = (raw: string) => {
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error('Expected a number');
  return value;
};

const stringList = (raw: string) => raw.split(',').map(value => value.trim()).filter(Boolean);

export const CONFIG_FIELDS: ConfigField[] = [
  { key: 'search.vector.enabled', category: 'Search', parse: booleanValue, defaultValue: DEFAULT_CONFIG.search?.vector?.enabled },
  { key: 'search.vector.provider', category: 'Search', parse: enumValue(['local'] as const), defaultValue: DEFAULT_CONFIG.search?.vector?.provider },
  { key: 'search.vector.model', category: 'Search', parse: String, defaultValue: DEFAULT_CONFIG.search?.vector?.model },
  { key: 'search.vector.dtype', category: 'Search', parse: enumValue(['q4', 'q8', 'fp16', 'fp32'] as const), defaultValue: DEFAULT_CONFIG.search?.vector?.dtype },
  { key: 'search.vector.cacheDir', category: 'Search', parse: String },
  { key: 'security.rejectSecrets', category: 'Security', parse: booleanValue, defaultValue: DEFAULT_CONFIG.security.rejectSecrets },
  { key: 'security.secretPatterns', category: 'Security', parse: stringList, defaultValue: DEFAULT_CONFIG.security.secretPatterns },
  { key: 'ai.provider', category: 'AI provider', parse: enumValue(['openai', 'anthropic', 'ollama', 'custom'] as const) },
  { key: 'ai.model', category: 'AI provider', parse: String },
  { key: 'ai.temperature', category: 'AI provider', parse: optionalNumber },
  { key: 'ai.baseUrl', category: 'AI provider', parse: String },
  { key: 'ai.apiKey', category: 'AI provider', parse: String, secret: true },
];

export function getConfigField(key: string): ConfigField {
  const field = CONFIG_FIELDS.find(candidate => candidate.key === key);
  if (!field) throw new Error(`Unknown config key: ${key}`);
  return field;
}
```

- [ ] **Step 7: Implement config mutation and backup**

Create `src/cli/config/service.ts` with exported `getConfigValue`, `setConfigValue`, `resetConfigValue`, and `resetAllConfig`. Use dot-path helpers, `DEFAULT_CONFIG`, and copy `.knowl/config.json` to `.knowl/config.json.backup` before each mutation. Read raw JSON for mutations so `${ENV_VAR}` placeholders are preserved; do not use the env-resolved `loadConfig` result when writing unrelated keys. `getConfigValue('ai.apiKey')` returns `********` rather than a secret. Delete optional leaf keys when resetting a field without a default. `resetAllConfig` writes `structuredClone(DEFAULT_CONFIG)`.

Core implementation shape:

```ts
async function backupConfig(root: string) {
  const source = path.join(root, '.knowl', 'config.json');
  await fs.copyFile(source, `${source}.backup`);
}

export async function setConfigValue(root: string, key: string, raw: string) {
  const field = getConfigField(key);
  const configPath = path.join(root, '.knowl', 'config.json');
  const config = JSON.parse(await fs.readFile(configPath, 'utf8')) as Record<string, unknown>;
  const value = field.parse(raw);
  setAtPath(config, key, value);
  await backupConfig(root);
  await saveConfig(root, config as ProjectConfig);
  return value;
}
```

- [ ] **Step 8: Run focused tests**

Run:

```powershell
npm.cmd test -- tests/cli/config-service.test.ts
```

Expected: PASS.

- [ ] **Step 9: Add lazy model-load notification coverage**

Create `tests/ai/embeddings.test.ts` with an injected Transformers loader and assert the first provider creation calls the callback once while a cached provider does not:

```ts
it('reports the first local model load and caches subsequent providers', async () => {
  const onLoad = vi.fn();
  const loadPipeline = vi.fn(async () => async () => ({ data: [1], dims: [1, 1] }));
  const config = { ...DEFAULT_CONFIG, search: { vector: { ...DEFAULT_CONFIG.search!.vector, enabled: true } } };
  await createLocalEmbeddingProvider(config, ROOT, { loadPipeline, onFirstLoad: onLoad });
  await createLocalEmbeddingProvider(config, ROOT, { loadPipeline, onFirstLoad: onLoad });
  expect(loadPipeline).toHaveBeenCalledTimes(1);
  expect(onLoad).toHaveBeenCalledTimes(1);
});
```

- [ ] **Step 10: Implement lazy load callback**

Change `createLocalEmbeddingProvider` to accept optional `{ loadPipeline?, onFirstLoad? }`. Keep model loading inside the existing first-use cache miss. Call `onFirstLoad({ model: vector.model, cacheDir })` immediately before the Transformers import/pipeline call. The CLI passes a message such as `Downloading local embedding model ...`; MCP callers omit the callback. Do not download or initialize the model during `init`.

- [ ] **Step 11: Run vector tests**

Run:

```powershell
npm.cmd test -- tests/ai/embeddings.test.ts tests/cli/config-service.test.ts
```

Expected: PASS.

- [ ] **Step 12: Commit**

```powershell
git add src/core/config.ts src/ai/embeddings.ts src/cli/config/schema.ts src/cli/config/service.ts tests/cli/config-service.test.ts tests/ai/embeddings.test.ts
git commit -m "feat: add validated config operations"
```

## Task 3: Build the Interactive Configuration UI

**Files:**
- Create: `src/cli/config/ui.ts`
- Test: `tests/cli/config-service.test.ts`

- [ ] **Step 1: Write a failing prompt-adapter test**

Append a test that injects a fake prompt interface rather than driving a real terminal:

```ts
import { runConfigUi, ConfigPrompts } from '../../src/cli/config/ui.js';

it('edits a selected field and confirms the diff', async () => {
  await writeConfig();
  const prompts: ConfigPrompts = {
    selectCategory: async () => 'Search',
    selectField: async () => 'search.vector.enabled',
    inputValue: async () => 'false',
    confirmSave: async changes => changes[0]?.key === 'search.vector.enabled',
    continueEditing: async () => false,
  };

  const result = await runConfigUi(ROOT, prompts);

  expect(result.saved).toBe(true);
  expect(await getConfigValue(ROOT, 'search.vector.enabled')).toBe(false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```powershell
npm.cmd test -- tests/cli/config-service.test.ts
```

Expected: FAIL because `src/cli/config/ui.ts` is missing.

- [ ] **Step 3: Implement injectable UI orchestration**

Create `src/cli/config/ui.ts`. Export:

```ts
export interface ConfigPrompts {
  selectCategory(categories: string[]): Promise<string>;
  selectField(fields: ConfigFieldView[]): Promise<string>;
  inputValue(field: ConfigFieldView, current: unknown): Promise<string>;
  confirmSave(changes: ConfigChange[]): Promise<boolean>;
  continueEditing(): Promise<boolean>;
}

export async function runConfigUi(root: string, prompts: ConfigPrompts = createInquirerPrompts())
```

Accumulate changes in memory, show secrets as `********`, validate through `getConfigField().parse`, save only after confirmation, and return `{ saved, changes }`. Implement `createInquirerPrompts()` with `select`, `input`, `password`, `confirm`, and `checkbox` from `@inquirer/prompts`.

- [ ] **Step 4: Add cancellation and secret-redaction tests**

Append:

```ts
it('does not save when confirmation is rejected', async () => {
  await writeConfig();
  const before = await fs.readFile(path.join(ROOT, '.knowl', 'config.json'), 'utf8');
  const prompts: ConfigPrompts = {
    selectCategory: async () => 'Search',
    selectField: async () => 'search.vector.enabled',
    inputValue: async () => 'false',
    confirmSave: async () => false,
    continueEditing: async () => false,
  };
  expect((await runConfigUi(ROOT, prompts)).saved).toBe(false);
  expect(await fs.readFile(path.join(ROOT, '.knowl', 'config.json'), 'utf8')).toBe(before);
});

it('redacts secret values in the confirmation diff', async () => {
  await writeConfig({ ...DEFAULT_CONFIG, ai: { provider: 'openai', model: 'gpt-4o-mini' } });
  let displayed: unknown;
  const prompts: ConfigPrompts = {
    selectCategory: async () => 'AI provider',
    selectField: async () => 'ai.apiKey',
    inputValue: async () => 'super-secret',
    confirmSave: async changes => { displayed = changes; return false; },
    continueEditing: async () => false,
  };
  await runConfigUi(ROOT, prompts);
  expect(JSON.stringify(displayed)).not.toContain('super-secret');
  expect(JSON.stringify(displayed)).toContain('********');
});
```

- [ ] **Step 5: Run focused tests**

Run:

```powershell
npm.cmd test -- tests/cli/config-service.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```powershell
git add src/cli/config/ui.ts tests/cli/config-service.test.ts
git commit -m "feat: add interactive config UI"
```

## Task 4: Add Shared Agent Integration Contracts and Safe File Merging

**Files:**
- Create: `src/cli/agents/types.ts`
- Create: `src/cli/agents/files.ts`
- Test: `tests/cli/agent-adapters.test.ts`

- [ ] **Step 1: Write failing safe-merge tests**

Create `tests/cli/agent-adapters.test.ts` with tests that:

```ts
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'smol-toml';
import { mergeCodexTomlConfig, mergeJsonMcpConfig } from '../../src/cli/agents/files.js';

const ROOT = path.resolve('.knowl-agent-adapters-test');
const configPath = path.join(ROOT, 'mcp.json');
const writeJson = (filePath: string, value: unknown) => fs.writeFile(filePath, JSON.stringify(value, null, 2), 'utf8');
const readJson = async (filePath: string) => JSON.parse(await fs.readFile(filePath, 'utf8'));

afterEach(async () => fs.rm(ROOT, { recursive: true, force: true }));

it('preserves unrelated JSON MCP servers and creates a backup', async () => {
  await fs.mkdir(ROOT, { recursive: true });
  await writeJson(configPath, { mcpServers: { existing: { command: 'existing' } } });
  await mergeJsonMcpConfig(configPath, { command: 'knowl', args: ['serve'] });
  const saved = await readJson(configPath);
  expect(saved.mcpServers.existing.command).toBe('existing');
  expect(saved.mcpServers.knowl).toEqual({ command: 'knowl', args: ['serve'] });
  await expect(fs.access(`${configPath}.backup`)).resolves.toBeUndefined();
});

it('does not rewrite an unchanged JSON MCP entry', async () => {
  await fs.mkdir(ROOT, { recursive: true });
  await writeJson(configPath, { mcpServers: { knowl: { command: 'knowl', args: ['serve'] } } });
  const before = await fs.readFile(configPath, 'utf8');
  expect(await mergeJsonMcpConfig(configPath, { command: 'knowl', args: ['serve'] })).toBe('unchanged');
  expect(await fs.readFile(configPath, 'utf8')).toBe(before);
});

it('preserves unrelated Codex TOML sections', async () => {
  await fs.mkdir(ROOT, { recursive: true });
  await fs.writeFile(configPath, 'model = "test-model"\n[mcp_servers.other]\ncommand = "other"\n', 'utf8');
  await mergeCodexTomlConfig(configPath, { command: 'knowl', args: ['serve'] });
  const saved = parse(await fs.readFile(configPath, 'utf8')) as Record<string, any>;
  expect(saved.model).toBe('test-model');
  expect(saved.mcp_servers.other.command).toBe('other');
  expect(saved.mcp_servers.knowl.args).toEqual(['serve']);
});

it('rejects malformed config without overwriting it', async () => {
  await fs.mkdir(ROOT, { recursive: true });
  await fs.writeFile(configPath, '{broken', 'utf8');
  await expect(mergeJsonMcpConfig(configPath, { command: 'knowl', args: ['serve'] })).rejects.toThrow();
  expect(await fs.readFile(configPath, 'utf8')).toBe('{broken');
});
```

- [ ] **Step 2: Run tests to verify missing modules fail**

Run:

```powershell
npm.cmd test -- tests/cli/agent-adapters.test.ts
```

Expected: FAIL because agent file helpers do not exist.

- [ ] **Step 3: Define adapter contracts**

Create `src/cli/agents/types.ts`:

```ts
export type AgentName = 'codex' | 'claude' | 'cursor' | 'claude-desktop';
export type IntegrationScope = 'project' | 'global';
export type IntegrationStatus = 'configured' | 'updated' | 'unchanged' | 'skipped' | 'failed';

export interface AgentDetection {
  installed: boolean;
  configured: boolean;
  scope: IntegrationScope;
  configPath: string;
}

export interface AgentIntegrationResult {
  agent: AgentName;
  status: IntegrationStatus;
  scope: IntegrationScope;
  configPath: string;
  message?: string;
}

export interface AgentAdapter {
  name: AgentName;
  label: string;
  detect(projectRoot: string): Promise<AgentDetection>;
  configure(projectRoot: string): Promise<AgentIntegrationResult>;
  verify(projectRoot: string): Promise<boolean>;
}
```

- [ ] **Step 4: Implement atomic merge helpers**

Create `src/cli/agents/files.ts` exporting:

```ts
export async function mergeJsonMcpConfig(
  configPath: string,
  entry: { command: string; args: string[] },
): Promise<'configured' | 'updated' | 'unchanged'>;

export async function mergeCodexTomlConfig(
  configPath: string,
  entry: { command: string; args: string[] },
): Promise<'configured' | 'updated' | 'unchanged'>;
```

Both functions must parse before writing, preserve unrelated keys, create parent directories, copy an existing file to `<path>.backup`, write to `<path>.tmp`, then rename the temporary file over the target. Compare the existing `knowl` entry before writing so idempotent runs return `unchanged` without creating a new backup.

- [ ] **Step 5: Run focused tests**

Run:

```powershell
npm.cmd test -- tests/cli/agent-adapters.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```powershell
git add src/cli/agents/types.ts src/cli/agents/files.ts tests/cli/agent-adapters.test.ts
git commit -m "feat: add safe agent config merging"
```

## Task 5: Implement Agent Adapters and Registry

**Files:**
- Create: `src/cli/agents/project-adapters.ts`
- Create: `src/cli/agents/cursor.ts`
- Create: `src/cli/agents/desktop-adapter.ts`
- Create: `src/cli/agents/registry.ts`
- Test: `tests/cli/agent-adapters.test.ts`

- [ ] **Step 1: Write failing adapter tests with injected environments**

Add tests using temporary `home`, `projectRoot`, `platform`, and PATH fixtures. Cover these exact targets:

```text
Codex project config:          <project>/.codex/config.toml
Claude Code project config:    <project>/.mcp.json
Cursor project config:         <project>/.cursor/mcp.json
Claude Desktop Windows config: `path.join(appDataDir, 'Claude', 'claude_desktop_config.json')`
Claude Desktop macOS config:   `path.join(homeDir, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')`
Claude Desktop Linux config:   `path.join(homeDir, '.config', 'Claude', 'claude_desktop_config.json')`
```

Inject command detection instead of depending on the developer machine:

```ts
const env = {
  platform: 'win32' as NodeJS.Platform,
  homeDir: HOME,
  commandExists: async (command: string) => command === 'codex',
};
const adapter = createCodexAdapter(env);
expect((await adapter.detect(PROJECT)).installed).toBe(true);
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```powershell
npm.cmd test -- tests/cli/agent-adapters.test.ts
```

Expected: FAIL because adapters are missing.

- [ ] **Step 3: Implement project-local adapters**

Implement factory functions `createCodexAdapter`, `createClaudeCodeAdapter`, and `createCursorAdapter`. Each accepts an environment object containing `platform`, `homeDir`, and `commandExists` for deterministic tests. Use `knowl.cmd` on Windows and `knowl` elsewhere. Claude Code/Cursor entries use:

```json
{
  "command": "knowl",
  "args": ["serve"]
}
```

Codex TOML uses:

```toml
[mcp_servers.knowl]
command = "knowl"
args = ["serve"]
```

- [ ] **Step 4: Implement the global Claude Desktop adapter**

Use the platform paths listed in Step 1. Mark detection scope as `global`. Preserve unrelated desktop MCP servers through `mergeJsonMcpConfig`.

- [ ] **Step 5: Implement registry and validation**

Create `src/cli/agents/registry.ts` exporting:

```ts
export const SUPPORTED_AGENT_NAMES: AgentName[] = ['codex', 'claude', 'cursor', 'claude-desktop'];
export function createAgentRegistry(env?: Partial<AgentEnvironment>): Map<AgentName, AgentAdapter>;
export function parseAgentNames(values: string[]): AgentName[];
export async function detectAgents(projectRoot: string, registry: Map<AgentName, AgentAdapter>): Promise<DetectedAgent[]>;
```

`parseAgentNames` deduplicates while preserving order and throws `Unsupported agent "x". Supported: codex, claude, cursor, claude-desktop.` before any writes.

- [ ] **Step 6: Run focused tests**

Run:

```powershell
npm.cmd test -- tests/cli/agent-adapters.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```powershell
git add src/cli/agents tests/cli/agent-adapters.test.ts
git commit -m "feat: add MCP agent adapters"
```

## Task 6: Implement Init Selection and Reconciliation

**Files:**
- Create: `src/cli/init-flow.ts`
- Create: `tests/cli/init-flow.test.ts`

- [ ] **Step 1: Write failing orchestration tests**

Create `tests/cli/init-flow.test.ts` using fake adapters and injected prompts. Test:

```ts
function fakeAdapter(name: AgentName, detection: AgentDetection, configureStatus: IntegrationStatus = 'configured'): AgentAdapter {
  return {
    name,
    label: name,
    detect: async () => detection,
    configure: async () => ({ agent: name, status: configureStatus, scope: detection.scope, configPath: detection.configPath }),
    verify: async () => configureStatus !== 'failed',
  };
}

function makeRegistry(names: AgentName[], calls: AgentName[]) {
  return new Map(names.map(name => [name, {
    ...fakeAdapter(name, { installed: true, configured: false, scope: 'project', configPath: name }),
    configure: async () => {
      calls.push(name);
      return { agent: name, status: 'configured' as const, scope: 'project' as const, configPath: name };
    },
  }]));
}

it('offers detected agents and preserves configured selections', async () => {
  const registry = new Map<AgentName, AgentAdapter>([
    ['codex', fakeAdapter('codex', { installed: true, configured: true, scope: 'project', configPath: 'codex' })],
    ['claude', fakeAdapter('claude', { installed: true, configured: false, scope: 'project', configPath: 'claude' })],
    ['cursor', fakeAdapter('cursor', { installed: false, configured: false, scope: 'project', configPath: 'cursor' })],
  ]);
  let choices: InitAgentChoice[] = [];
  await runAgentInitFlow(ROOT, {
    agentNames: [], yes: false, interactive: true, registry,
    prompts: { selectAgents: async value => { choices = value; return []; }, confirmGlobal: async () => false },
  });
  expect(choices.find(choice => choice.value === 'codex')?.checked).toBe(true);
  expect(choices.find(choice => choice.value === 'cursor')).toBeUndefined();
});

it('configures explicit agents without opening the selector', async () => {
  const calls: AgentName[] = [];
  const registry = makeRegistry(['codex', 'claude'], calls);
  const result = await runAgentInitFlow(ROOT, {
    agentNames: ['codex', 'claude'], yes: false, interactive: false, registry,
    prompts: { selectAgents: async () => { throw new Error('unexpected prompt'); }, confirmGlobal: async () => true },
  });
  expect(calls).toEqual(['codex', 'claude']);
  expect(result.exitCode).toBe(0);
});

it('requires confirmation before global configuration', async () => {
  const registry = new Map([[ 'claude-desktop', fakeAdapter('claude-desktop', { installed: true, configured: false, scope: 'global', configPath: 'desktop' }) ]]);
  const result = await runAgentInitFlow(ROOT, {
    agentNames: ['claude-desktop'], yes: false, interactive: true, registry,
    prompts: { selectAgents: async () => [], confirmGlobal: async () => false },
  });
  expect(result.results[0]?.status).toBe('skipped');
});

it('returns partial failure without rolling back successes', async () => {
  const good = fakeAdapter('codex', { installed: true, configured: false, scope: 'project', configPath: 'codex' });
  const bad = { ...fakeAdapter('claude', { installed: true, configured: false, scope: 'project', configPath: 'claude' }), configure: async () => { throw new Error('denied'); } };
  const result = await runAgentInitFlow(ROOT, {
    agentNames: ['codex', 'claude'], yes: false, interactive: false,
    registry: new Map([['codex', good], ['claude', bad]]),
    prompts: { selectAgents: async () => [], confirmGlobal: async () => true },
  });
  expect(result.results.map(item => item.status)).toEqual(['configured', 'failed']);
  expect(result.exitCode).toBe(1);
});

it('does not prompt in non-TTY mode without explicit agents', async () => {
  const result = await runAgentInitFlow(ROOT, {
    agentNames: [], yes: false, interactive: false, registry: new Map(),
    prompts: { selectAgents: async () => { throw new Error('unexpected prompt'); }, confirmGlobal: async () => false },
  });
  expect(result).toEqual({ results: [], exitCode: 0 });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```powershell
npm.cmd test -- tests/cli/init-flow.test.ts
```

Expected: FAIL because `src/cli/init-flow.ts` is missing.

- [ ] **Step 3: Implement init flow contracts**

Export:

```ts
export interface InitFlowOptions {
  agentNames: string[];
  yes: boolean;
  interactive: boolean;
  registry?: Map<AgentName, AgentAdapter>;
  prompts?: InitPrompts;
}

export async function runAgentInitFlow(
  projectRoot: string,
  options: InitFlowOptions,
): Promise<{ results: AgentIntegrationResult[]; exitCode: number }>;
```

The flow validates explicit names first, detects agents, invokes `checkbox` only for interactive plain init, confirms global targets unless `yes`, configures each target independently, verifies success, catches per-agent failures, and returns exit code `1` when any selected target fails.

Define the prompt contract alongside the flow:

```ts
export interface InitAgentChoice { value: AgentName; name: string; checked?: boolean }
export interface InitPrompts {
  selectAgents(choices: InitAgentChoice[]): Promise<AgentName[]>;
  confirmGlobal(agent: AgentName, configPath: string): Promise<boolean>;
}
```

- [ ] **Step 4: Implement terminal prompts and summary formatter**

Use `@inquirer/prompts` checkbox/confirm. Export a pure `formatAgentInitSummary(results)` that produces aligned status lines such as:

```text
Knowl project: already initialized
Codex:         unchanged (project)
Claude Code:   configured (project)
Claude Desktop: skipped (global permission declined)
Result: ready
```

- [ ] **Step 5: Run focused tests**

Run:

```powershell
npm.cmd test -- tests/cli/init-flow.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```powershell
git add src/cli/init-flow.ts tests/cli/init-flow.test.ts
git commit -m "feat: add interactive agent init flow"
```

## Task 7: Rewire Commander Commands

**Files:**
- Modify: `src/index.ts`
- Modify: `tests/cli/cli.test.ts`

- [ ] **Step 1: Replace obsolete CLI integration expectations with failing tests**

Update `tests/cli/cli.test.ts`:

- initialize with `knowl init --yes` rather than a project name;
- expect `search.vector.enabled` to be `true` for new projects;
- expect explicit existing `false` to remain false;
- delete tests for `knowl connect` instructions;
- add a test that `knowl connect codex` exits non-zero with `unknown command 'connect'`;
- add tests for `knowl config get`, `set`, and `reset`;
- add tests that old config positional forms exit non-zero with migration guidance;
- add a non-TTY `knowl init` test proving it initializes without agent writes;
- add an explicit-agent test using injected HOME/PATH fixtures and a temporary project-local config.

Representative assertions:

```ts
expect(execSync(`node "${CLI_PATH}" config get search.vector.enabled`, options).trim()).toBe('true');
expect(() => execSync(`node "${CLI_PATH}" config search.vector.enabled true`, options))
  .toThrow(/Use `knowl config set <key> <value>`/);
expect(() => execSync(`node "${CLI_PATH}" connect codex`, options))
  .toThrow(/unknown command 'connect'/);
```

- [ ] **Step 2: Build and run CLI tests to verify failures**

Run:

```powershell
npm.cmd run build
npm.cmd test -- tests/cli/cli.test.ts
```

Expected: FAIL on old init/config/connect behavior.

- [ ] **Step 3: Rewire `init`**

In `src/index.ts`:

- change `.argument('[name]')` to `.argument('[agents...]', 'Agent integrations to configure')`;
- add `.option('-y, --yes', 'Accept global configuration confirmations')`;
- keep existing new/upgrade repository maintenance;
- delete `printMcpSetupHint` and `printConnectInstructions`;
- call `runAgentInitFlow(cwd, { agentNames: agents, yes: options.yes, interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY) })` after project maintenance;
- print the summary and set `process.exitCode` from its result rather than calling `process.exit(0)` early.

- [ ] **Step 4: Delete the `connect` command**

Remove the entire Commander registration for `connect`. Confirm `knowl --help` no longer lists it.

- [ ] **Step 5: Rewire `config` as a command group**

Replace the positional command with:

```ts
const configCommand = program.command('config').description('Interactively view or edit project configuration');

configCommand.action(async () => {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('Interactive config requires a TTY. Use `knowl config get`, `set`, or `reset`.');
  }
  const root = await findProjectRoot(process.cwd());
  await runConfigUi(root);
});

configCommand.command('get').argument('<key>').action(async key => {
  const root = await findProjectRoot(process.cwd());
  console.log(JSON.stringify(await getConfigValue(root, key)));
});
configCommand.command('set').argument('<key>').argument('<value>').action(async (key, value) => {
  const root = await findProjectRoot(process.cwd());
  const typedValue = await setConfigValue(root, key, value);
  console.log(`Set ${key} = ${JSON.stringify(typedValue)}`);
});
configCommand.command('reset').argument('[key]').option('-y, --yes').action(async (key, options) => {
  const root = await findProjectRoot(process.cwd());
  if (!key && !options.yes && (!process.stdin.isTTY || !(await confirm({ message: 'Reset all config to defaults?' })))) {
    throw new Error('Reset cancelled. Use `--yes` for non-interactive full reset.');
  }
  if (key) await resetConfigValue(root, key);
  else await resetAllConfig(root);
  console.log(key ? `Reset ${key}` : 'Reset all configuration to defaults');
});
```

Add Commander excess-argument handling so old forms print the exact new command syntax.

- [ ] **Step 6: Run build and focused CLI tests**

Run:

```powershell
npm.cmd run build
npm.cmd test -- tests/cli/config-service.test.ts tests/cli/agent-adapters.test.ts tests/cli/init-flow.test.ts tests/cli/cli.test.ts
```

Expected: PASS.

When wiring `reindex --vectors`, pass the notification callback:

```ts
const embedder = await createLocalEmbeddingProvider(config, root, {
  onFirstLoad: ({ model }) => console.log(`Downloading local embedding model ${model}...`),
});
```

- [ ] **Step 7: Commit**

```powershell
git add src/index.ts tests/cli/cli.test.ts
git commit -m "feat: unify init and config CLI UX"
```

## Task 8: Document New Setup and Migration

**Files:**
- Modify: `README.md`
- Modify: `src/cli/doctor-report.ts`
- Modify: `tests/cli/cli.test.ts`

- [ ] **Step 1: Write failing documentation/doctor assertions**

Update the doctor integration test with:

```ts
expect(output).toContain('[OK] Vector search enabled with local/Xenova/all-MiniLM-L6-v2');
expect(output).not.toContain('knowl connect');
```

Add a README scan to the verification step rather than a brittle snapshot test. Update stale doctor remediation from manual connection instructions to `knowl init <agent>`.

- [ ] **Step 2: Update README**

Replace quick start with:

```powershell
npm install -g @dat999zx/knowl
knowl init
```

Document:

```powershell
knowl init codex claude
knowl config
knowl config get search.vector.enabled
knowl config set search.vector.enabled false
knowl config reset search.vector.enabled
```

Remove `knowl connect`, manual MCP snippets as the primary path, project-name init syntax, and old positional config syntax. Explain project-local preference, confirmation for global-only clients, repeat initialization, default-on local vectors, and lazy first-use download.

- [ ] **Step 3: Update doctor output**

Ensure doctor guidance uses the new commands and still distinguishes enabled vectors from BM25 fallback. Do not make doctor download the model.

- [ ] **Step 4: Run focused tests and text scans**

Run:

```powershell
npm.cmd run build
npm.cmd test -- tests/cli/cli.test.ts
rg -n "knowl connect|knowl config [a-z].* true|knowl init \[name\]" README.md src tests
```

Expected: tests PASS; `rg` returns no user-facing obsolete syntax except tests that verify rejection.

- [ ] **Step 5: Commit**

```powershell
git add README.md src/cli/doctor-report.ts tests/cli/cli.test.ts
git commit -m "docs: update Knowl onboarding workflow"
```

## Task 9: Full Verification and Durable Knowledge Update

**Files:**
- Modify only if verification exposes a feature-scoped defect.

- [ ] **Step 1: Run formatting/diff validation**

Run:

```powershell
git diff --check
```

Expected: no output; exit code `0`.

- [ ] **Step 2: Run the full build and test suite**

Run:

```powershell
npm.cmd run build
npm.cmd test
```

Expected: PASS.

- [ ] **Step 3: Run doctor in this repository**

Run:

```powershell
node dist/index.js doctor
```

Expected: `Result: READY`; vector search reported enabled; no obsolete connection guidance.

- [ ] **Step 4: Perform CLI smoke checks in a temporary project**

Run from a disposable directory:

```powershell
node D:\coding\knowl\dist\index.js init --yes
node D:\coding\knowl\dist\index.js config get search.vector.enabled
node D:\coding\knowl\dist\index.js config set search.vector.enabled false
node D:\coding\knowl\dist\index.js config reset search.vector.enabled
```

Expected: initialization succeeds; values print `true`, then `false`, then restore to `true`.

- [ ] **Step 5: Store verified durable project knowledge**

Use `knowl_ingest_atoms` to record:

- agent-aware additive init implementation and supported adapters;
- new config UI/subcommands and removed syntax;
- vector default-on/lazy-download behavior;
- verification commands/results.

- [ ] **Step 6: Commit any final feature-scoped fixes**

If Step 1–4 required fixes:

```powershell
git add <only-feature-files>
git commit -m "fix: finalize CLI onboarding UX"
```

If no fixes were needed, do not create an empty commit.
