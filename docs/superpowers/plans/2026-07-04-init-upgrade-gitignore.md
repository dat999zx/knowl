# Init Upgrade And Gitignore Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `knowl init` safely upgrade existing Knowl projects and ensure initialized projects ignore local `.knowl/` data in `.gitignore`.

**Architecture:** Move reusable init maintenance into small core helpers, then have `init` call them for both new and existing repositories. Upgrades are additive and idempotent: merge missing default config keys, rerun schema bootstrap through `initDb`, refresh AGENTS.md, and update project `.gitignore` without removing user content.

**Tech Stack:** TypeScript, Node fs/path APIs, Commander CLI, libSQL bootstrap via existing `initDb`, Vitest CLI integration tests.

---

## File Structure

- Modify `src/core/config.ts`: add a deep default merge helper that preserves existing user config while adding missing defaults such as `search.vector`.
- Create `src/core/gitignore.ts`: own `.gitignore` read/append behavior for `.knowl/`.
- Modify `src/index.ts`: replace duplicated init logic with existing-project upgrade flow, and add `knowl upgrade`.
- Modify `tests/cli/cli.test.ts`: cover `.gitignore` creation/update, existing-project config upgrade, existing-project DB schema upgrade, and explicit `upgrade`.

---

### Task 1: Config Upgrade Helper

**Files:**
- Modify: `src/core/config.ts`
- Test: `tests/cli/cli.test.ts`

- [ ] **Step 1: Add CLI test for old config upgrade on `init`**

Add a test near existing init rerun tests:

```ts
it('should merge missing default config keys when init is rerun in an existing repository', async () => {
  const oldProjectDir = path.resolve('./.knowl-cli-old-config-test');
  await fs.rm(oldProjectDir, { recursive: true, force: true }).catch(() => {});
  await fs.mkdir(path.join(oldProjectDir, '.knowl'), { recursive: true });
  await fs.writeFile(
    path.join(oldProjectDir, '.knowl', 'config.json'),
    JSON.stringify({
      version: 1,
      project: { name: 'Old Config Project' },
      ai: { provider: 'openai', model: 'gpt-4o-mini', apiKey: '${OPENAI_API_KEY}' },
      security: { rejectSecrets: true, secretPatterns: ['password'] },
    }, null, 2),
    'utf-8'
  );

  execSync(`node "${CLI_PATH}" init "Old Config Project"`, {
    cwd: oldProjectDir,
    encoding: 'utf-8',
  });

  const config = JSON.parse(await fs.readFile(path.join(oldProjectDir, '.knowl', 'config.json'), 'utf-8'));
  expect(config.ai.provider).toBe('openai');
  expect(config.security.secretPatterns).toEqual(['password']);
  expect(config.search.vector.enabled).toBe(false);
  expect(config.search.vector.provider).toBe('local');

  await fs.rm(oldProjectDir, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run focused CLI test and verify failure**

Run: `npm.cmd test -- tests/cli/cli.test.ts -t "merge missing default config keys"`

Expected: FAIL because existing `init` does not merge missing default config keys.

- [ ] **Step 3: Implement config merge helper**

In `src/core/config.ts`, add:

```ts
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function mergeConfigDefaults<T extends Record<string, any>>(config: T, defaults: Record<string, any> = DEFAULT_CONFIG): T {
  const merged: Record<string, any> = { ...config };

  for (const [key, defaultValue] of Object.entries(defaults)) {
    const currentValue = merged[key];
    if (currentValue === undefined) {
      merged[key] = defaultValue;
    } else if (isPlainObject(currentValue) && isPlainObject(defaultValue)) {
      merged[key] = mergeConfigDefaults(currentValue, defaultValue);
    }
  }

  return merged as T;
}

export async function upgradeConfigDefaults(projectRoot: string): Promise<'updated' | 'unchanged'> {
  const config = await loadConfig(projectRoot);
  const upgraded = mergeConfigDefaults(config as any) as ProjectConfig;

  if (JSON.stringify(config) === JSON.stringify(upgraded)) {
    return 'unchanged';
  }

  await saveConfig(projectRoot, upgraded);
  return 'updated';
}
```

- [ ] **Step 4: Wire helper into existing-project `init` path**

In `src/index.ts`, import `upgradeConfigDefaults`:

```ts
import { findProjectRoot, loadConfig, saveConfig, hasAiConfigured, upgradeConfigDefaults } from './core/config.js';
```

In existing `init` path, call:

```ts
const configStatus = await upgradeConfigDefaults(cwd);
if (configStatus === 'updated') {
  console.log(`Updated .knowl/config.json with missing default settings.`);
}
```

- [ ] **Step 5: Run focused test and verify pass**

Run: `npm.cmd test -- tests/cli/cli.test.ts -t "merge missing default config keys"`

Expected: PASS.

---

### Task 2: Project `.gitignore` Installer

**Files:**
- Create: `src/core/gitignore.ts`
- Modify: `src/index.ts`
- Test: `tests/cli/cli.test.ts`

- [ ] **Step 1: Add tests for `.gitignore` behavior**

Add tests after the repository init test:

```ts
it('should create project .gitignore with .knowl during init', async () => {
  const ignorePath = path.join(TEST_DIR, '.gitignore');
  const content = await fs.readFile(ignorePath, 'utf-8');
  expect(content).toContain('.knowl/');
});

it('should append .knowl to existing project .gitignore without overwriting content', async () => {
  const gitignoreDir = path.resolve('./.knowl-cli-gitignore-test');
  await fs.rm(gitignoreDir, { recursive: true, force: true }).catch(() => {});
  await fs.mkdir(gitignoreDir, { recursive: true });
  await fs.writeFile(path.join(gitignoreDir, '.gitignore'), 'node_modules/\n.env\n', 'utf-8');

  execSync(`node "${CLI_PATH}" init "Gitignore Project"`, {
    cwd: gitignoreDir,
    encoding: 'utf-8',
  });

  const content = await fs.readFile(path.join(gitignoreDir, '.gitignore'), 'utf-8');
  expect(content).toContain('node_modules/');
  expect(content).toContain('.env');
  expect(content).toContain('.knowl/');
  expect((content.match(/\.knowl\//g) || []).length).toBe(1);

  await fs.rm(gitignoreDir, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run focused tests and verify failure**

Run: `npm.cmd test -- tests/cli/cli.test.ts -t "gitignore"`

Expected: FAIL because init does not manage target project `.gitignore`.

- [ ] **Step 3: Implement gitignore helper**

Create `src/core/gitignore.ts`:

```ts
import fs from 'node:fs/promises';
import path from 'node:path';

export type GitignoreInstallStatus = 'created' | 'updated' | 'unchanged';

const KNOWL_IGNORE_ENTRY = '.knowl/';

export async function installKnowlGitignoreEntry(projectRoot: string): Promise<GitignoreInstallStatus> {
  const gitignorePath = path.join(projectRoot, '.gitignore');

  try {
    const existing = await fs.readFile(gitignorePath, 'utf-8');
    const lines = existing.split(/\r?\n/).map(line => line.trim());
    if (lines.includes(KNOWL_IGNORE_ENTRY) || lines.includes('.knowl')) {
      return 'unchanged';
    }

    const separator = existing.endsWith('\n') ? '' : '\n';
    await fs.writeFile(gitignorePath, `${existing}${separator}${KNOWL_IGNORE_ENTRY}\n`, 'utf-8');
    return 'updated';
  } catch (error: any) {
    if (error?.code !== 'ENOENT') {
      throw error;
    }

    await fs.writeFile(gitignorePath, `${KNOWL_IGNORE_ENTRY}\n`, 'utf-8');
    return 'created';
  }
}
```

- [ ] **Step 4: Wire helper into `init`**

In `src/index.ts`, import:

```ts
import { installKnowlGitignoreEntry } from './core/gitignore.js';
```

Call it in both new and existing `init` paths:

```ts
const gitignoreStatus = await installKnowlGitignoreEntry(cwd);
if (gitignoreStatus === 'created') {
  console.log(`Created .gitignore with .knowl/ entry.`);
} else if (gitignoreStatus === 'updated') {
  console.log(`Updated .gitignore with .knowl/ entry.`);
}
```

- [ ] **Step 5: Run focused tests and verify pass**

Run: `npm.cmd test -- tests/cli/cli.test.ts -t "gitignore"`

Expected: PASS.

---

### Task 3: Existing Project Schema Upgrade

**Files:**
- Modify: `src/index.ts`
- Test: `tests/cli/cli.test.ts`

- [ ] **Step 1: Add CLI test for schema upgrade**

Add:

```ts
it('should bootstrap missing database tables when init is rerun in an existing repository', async () => {
  const oldDbDir = path.resolve('./.knowl-cli-old-db-test');
  await fs.rm(oldDbDir, { recursive: true, force: true }).catch(() => {});
  await fs.mkdir(path.join(oldDbDir, '.knowl'), { recursive: true });
  await fs.writeFile(
    path.join(oldDbDir, '.knowl', 'config.json'),
    JSON.stringify({
      version: 1,
      project: { name: 'Old DB Project' },
      security: { rejectSecrets: true, secretPatterns: [] },
    }, null, 2),
    'utf-8'
  );

  execSync(`node "${CLI_PATH}" init "Old DB Project"`, {
    cwd: oldDbDir,
    encoding: 'utf-8',
  });

  const output = execSync(`node "${CLI_PATH}" doctor`, {
    cwd: oldDbDir,
    encoding: 'utf-8',
  });

  expect(output).toContain('[OK] Repository initialized');
  expect(output).toContain('[OK] Config loaded');

  await fs.rm(oldDbDir, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run focused test and verify failure or current behavior**

Run: `npm.cmd test -- tests/cli/cli.test.ts -t "bootstrap missing database tables"`

Expected today may FAIL if `initDb` is skipped for existing repositories. If it passes because DB is absent and created indirectly, still continue to make existing path explicit.

- [ ] **Step 3: Update existing-project `init` path to call `initDb`**

In `src/index.ts`, existing branch should run:

```ts
await initDb(cwd);
let project = await repo.getProjectByRootPath(cwd);
if (!project) {
  project = await repo.createProject(cwd, name);
  console.log(`Registered project: "${project.name}" (ID: ${project.id})`);
}
await closeDb();
```

Keep this before printing final status so schema creation failures surface as init errors.

- [ ] **Step 4: Run focused test and verify pass**

Run: `npm.cmd test -- tests/cli/cli.test.ts -t "bootstrap missing database tables"`

Expected: PASS.

---

### Task 4: Extract Shared Upgrade Function And Add `knowl upgrade`

**Files:**
- Modify: `src/index.ts`
- Test: `tests/cli/cli.test.ts`

- [ ] **Step 1: Add CLI test for explicit upgrade**

Add:

```ts
it('should run explicit upgrade for existing repositories', async () => {
  const upgradeDir = path.resolve('./.knowl-cli-upgrade-test');
  await fs.rm(upgradeDir, { recursive: true, force: true }).catch(() => {});
  await fs.mkdir(upgradeDir, { recursive: true });

  execSync(`node "${CLI_PATH}" init "Upgrade Project"`, {
    cwd: upgradeDir,
    encoding: 'utf-8',
  });

  const output = execSync(`node "${CLI_PATH}" upgrade`, {
    cwd: upgradeDir,
    encoding: 'utf-8',
  });

  expect(output).toContain('KNOWL repository upgrade complete');
  expect(output).toContain('AGENTS.md');
  expect(output).toContain('.gitignore');

  await fs.rm(upgradeDir, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run focused test and verify failure**

Run: `npm.cmd test -- tests/cli/cli.test.ts -t "explicit upgrade"`

Expected: FAIL because `upgrade` command does not exist.

- [ ] **Step 3: Extract reusable upgrade helper inside `src/index.ts`**

Add near helper print functions:

```ts
async function upgradeExistingRepository(projectRoot: string, name: string) {
  const configStatus = await upgradeConfigDefaults(projectRoot);
  const agentsStatus = await installKnowlAgentsGuidance(projectRoot);
  const gitignoreStatus = await installKnowlGitignoreEntry(projectRoot);

  await initDb(projectRoot);
  let project = await repo.getProjectByRootPath(projectRoot);
  if (!project) {
    project = await repo.createProject(projectRoot, name);
  }
  await closeDb();

  return {
    project,
    configStatus,
    agentsStatus,
    gitignoreStatus,
  };
}
```

- [ ] **Step 4: Reuse helper in existing `init` branch**

Replace current existing branch body with:

```ts
const result = await upgradeExistingRepository(cwd, name);
console.log(`⚠️  KNOWL repository already initialized in this directory: ${knowlDir}`);
printUpgradeStatus(result);
printMcpSetupHint();
process.exit(0);
```

Add status helper:

```ts
function printUpgradeStatus(result: Awaited<ReturnType<typeof upgradeExistingRepository>>) {
  console.log(`KNOWL repository upgrade complete.`);
  console.log(`Project: "${result.project.name}" (ID: ${result.project.id})`);
  console.log(`Config: ${result.configStatus}`);
  console.log(`AGENTS.md: ${result.agentsStatus}`);
  console.log(`.gitignore: ${result.gitignoreStatus}`);
}
```

- [ ] **Step 5: Add `upgrade` command**

Add before `doctor` command:

```ts
program
  .command('upgrade')
  .description('Upgrade an existing KNOWL repository with the latest config, schema, and agent files')
  .action(async () => {
    try {
      const root = await findProjectRoot(process.cwd());
      const result = await upgradeExistingRepository(root, 'My Project');
      printUpgradeStatus(result);
    } catch (error: any) {
      console.error(`❌ Error upgrading KNOWL: ${error.message}`);
      process.exit(1);
    }
  });
```

- [ ] **Step 6: Run focused test and verify pass**

Run: `npm.cmd test -- tests/cli/cli.test.ts -t "explicit upgrade"`

Expected: PASS.

---

### Task 5: Doctor Coverage For Upgrade Readiness

**Files:**
- Modify: `src/cli/doctor-report.ts`
- Test: `tests/cli/cli.test.ts`

- [ ] **Step 1: Add doctor assertions**

In existing doctor test, add:

```ts
expect(output).toContain('[OK] Config includes vector search defaults');
expect(output).toContain('[OK] Database schema includes knowledge_embeddings');
expect(output).toContain('[OK] .gitignore ignores .knowl/');
```

- [ ] **Step 2: Run focused doctor test and verify failure**

Run: `npm.cmd test -- tests/cli/cli.test.ts -t "agent readiness with doctor"`

Expected: FAIL because doctor does not report these checks.

- [ ] **Step 3: Implement doctor checks**

In `src/cli/doctor-report.ts`, after config load:

```ts
checks.push({
  status: config.search?.vector?.provider ? 'OK' : 'WARN',
  message: config.search?.vector?.provider
    ? 'Config includes vector search defaults'
    : 'Config missing vector search defaults; run knowl upgrade',
});
```

After DB init:

```ts
const db = (await import('../store/database.js')).getDb();
try {
  await (db as any).all(`SELECT 1 FROM knowledge_embeddings LIMIT 1`);
  checks.push({ status: 'OK', message: 'Database schema includes knowledge_embeddings' });
} catch {
  checks.push({ status: 'WARN', message: 'Database schema missing knowledge_embeddings; run knowl upgrade' });
}
```

After AGENTS check:

```ts
const gitignorePath = path.join(root, '.gitignore');
let ignoresKnowl = false;
try {
  const gitignore = await fs.readFile(gitignorePath, 'utf-8');
  ignoresKnowl = gitignore.split(/\r?\n/).map(line => line.trim()).some(line => line === '.knowl/' || line === '.knowl');
} catch {
  ignoresKnowl = false;
}
checks.push({
  status: ignoresKnowl ? 'OK' : 'WARN',
  message: ignoresKnowl ? '.gitignore ignores .knowl/' : '.gitignore should ignore .knowl/; run knowl upgrade',
});
```

- [ ] **Step 4: Run focused doctor test and verify pass**

Run: `npm.cmd test -- tests/cli/cli.test.ts -t "agent readiness with doctor"`

Expected: PASS.

---

### Task 6: Full Verification And Memory Update

**Files:**
- Modify only if required by failures found above.

- [ ] **Step 1: Run full tests**

Run: `npm.cmd test`

Expected: all tests pass.

- [ ] **Step 2: Run build**

Run: `npm.cmd run build`

Expected: tsup build succeeds.

- [ ] **Step 3: Check whitespace**

Run: `git diff --check`

Expected: no output.

- [ ] **Step 4: Inspect diff**

Run: `git diff -- src/core/config.ts src/core/gitignore.ts src/index.ts src/cli/doctor-report.ts tests/cli/cli.test.ts`

Expected: diff only contains init upgrade, gitignore, doctor checks, and related tests.

- [ ] **Step 5: Store durable Knowl memory**

Use `knowl_store` or `knowl_ingest_atoms` to record:

```json
{
  "category": "architecture",
  "title": "Init upgrades existing Knowl repositories",
  "content": "knowl init and knowl upgrade run additive project maintenance: merge missing config defaults, bootstrap schema, refresh AGENTS.md, and ensure .gitignore ignores .knowl/.",
  "tags": ["init", "upgrade", "gitignore", "config", "schema"]
}
```

