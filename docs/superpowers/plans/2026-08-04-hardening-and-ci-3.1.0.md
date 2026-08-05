# Knowl 3.1.0 Hardening, Generated Docs, and CI Gates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put a real trust boundary around executable skills, bound the import surface, make config and diagnostic writes atomic and owner-only, generate the README sections that keep drifting, and add the automated gates that would have caught this year's defects.

**Architecture:** Skill execution gains a hash-pinned approval record stored outside the skill directory, an allowlisted environment, and run ceilings — so an imported or edited package cannot run until a human approves its exact bytes. Import gains explicit limits and a streaming line reader. File writes move to write-temp-then-rename with explicit modes. The MCP tool schemas move out of a closure into an exported module so documentation can be generated from them alongside the CLI help, the embedding presets, and the package version. CI grows a platform and Node matrix, a docs-drift check, and dependency scanning.

**Tech Stack:** TypeScript (ESM, `node:` builtins including `node:readline`), vitest, GitHub Actions, `commander`.

## Global Constraints

- Prerequisite: `docs/superpowers/plans/2026-08-04-security-fixes-3.0.1.md` is merged. Task 1 extends `src/skills/registry.ts` and Task 2 extends `src/store/portability.ts` as that plan leaves them.
- Baseline is **3.0.0** at commit `8a8aae4` plus that plan. Re-check every line reference with `grep` before editing.
- Node `>=22` unless Task 6 concludes otherwise and the change is made deliberately.
- No new **runtime** dependency. New dev dependencies are allowed for lint, formatting, and the docs loader.
- The CLI lives in `src/cli/program.ts`. `const skillCommand` is declared at line 1884 — **extend it**; a second declaration will not compile.
- Trust records live at `<projectRoot>/.knowl/skill-trust.json`, **outside** `.knowl/skills/`, so an imported package can never ship its own approval.
- File modes: `0o600` for files that may hold credentials or host metadata, `0o700` for their directories. These are no-ops on Windows; do not branch on platform, and gate mode assertions with `it.skipIf(process.platform === 'win32')`.
- Generated README regions are delimited by `<!-- generated:<id> -->` / `<!-- /generated:<id> -->`. Never hand-edit inside them.
- Commit messages use Conventional Commits. Every task ends with `npm test` green.

---

## File Structure

| File | Responsibility | Change |
| --- | --- | --- |
| `src/skills/trust.ts` | Skill package hashing and approval records | Create |
| `src/skills/registry.ts` | Skill execution | Modify: enforce trust, filter environment, add run ceilings |
| `src/cli/program.ts` | CLI | Modify: extend `skillCommand` with `approve`/`revoke`/`trust`; `diagnose-startup --clear` |
| `src/core/atomic-write.ts` | Durable, permission-controlled file replacement | Create |
| `src/core/config.ts` | Project config save | Modify: atomic write with `0o600` |
| `src/core/startup-trace.ts` | Startup diagnostics | Modify: `0o700` dir, `0o600` file, hashed project root, `clearStartupLog` |
| `src/store/portability.ts` | JSONL import | Modify: streaming line reader plus explicit ceilings |
| `src/mcp/tool-definitions.ts` | MCP tool schemas as data | Create (moved out of `src/mcp/tools.ts`) |
| `src/mcp/tools.ts` | MCP handlers | Modify: import definitions instead of inlining them |
| `src/core/vector-profile.ts` | Embedding presets | Modify: add `contextTokens`, and exclude it from the runtime profile |
| `scripts/generate-docs.ts` | README section generator and checker | Create |
| `eslint.config.mjs` | Lint rules | Create |
| `.github/workflows/ci.yml` | CI | Modify: matrix, lint, docs check, audit, tarball smoke test |
| `.github/workflows/codeql.yml`, `.github/dependabot.yml` | Static analysis, dependency updates | Create |
| `tests/skills/trust.test.ts`, `tests/store/import-limits.test.ts`, `tests/core/atomic-write.test.ts`, `tests/core/startup-trace.test.ts` | Regressions | Create |

---

### Task 1: Require hash-pinned approval, a filtered environment, and run ceilings for skill execution

3.0.0 closed the two sharpest edges here — `.cmd`/`.bat` are refused (`src/skills/registry.ts:84-93`), shell entrypoints reject runtime arguments (lines 322-326), and `autoRun` defaults to `false`. What remains is that nothing establishes *who approved this package*. `runSkillPackage` inherits the full `process.env` (line 329), sets no `timeout` and no `maxBuffer` (lines 256-261, 284-288), and `autoRun: true` is a boolean in a manifest the same agent can write. The MCP tool description tells the agent to run only a trusted skill after inspecting it, but that is guidance — and the same MCP surface both creates executable files and runs them.

Approval is recorded against a hash of the package's exact bytes. Symlinks are refused outright rather than followed: hashing a link's target while execution also follows it would let approved bytes change without changing the approval hash, and hashing the link text while execution follows the target is the same hole in reverse.

**Files:**
- Create: `src/skills/trust.ts`
- Modify: `src/skills/registry.ts` (execution path, environment, ceilings)
- Modify: `src/cli/program.ts:1884+` (extend the existing `skillCommand`)
- Modify: `src/mcp/tools.ts` (`knowl_skill_run` description)
- Test: `tests/skills/trust.test.ts` (create)

**Interfaces:**
- Consumes: `getSkillsDir`, `readSkillPackage` from `src/skills/registry.ts`.
- Produces, from `src/skills/trust.ts`:
  - `export type SkillTrustRecord = { approvedHash: string; approvedAt: string; approvedBy: string; allowedEntrypoints: string[] }`
  - `export async function hashSkillPackage(projectRoot: string, name: string): Promise<string>`
  - `export async function readTrust(projectRoot: string, name: string): Promise<SkillTrustRecord | null>`
  - `export async function listTrust(projectRoot: string): Promise<Record<string, SkillTrustRecord>>`
  - `export async function approveSkill(projectRoot: string, name: string, options?: { approvedBy?: string; allowedEntrypoints?: string[] }): Promise<SkillTrustRecord>`
  - `export async function revokeSkill(projectRoot: string, name: string): Promise<boolean>`
  - `export async function assertSkillApproved(projectRoot: string, name: string, entrypoint: string): Promise<void>`
- Produces, from `src/skills/registry.ts`: `export function skillEnvironment(projectRoot: string, skill: SkillPackage): NodeJS.ProcessEnv`, plus module constants `MAX_SKILL_RUNTIME_MS = 120_000` and `MAX_SKILL_OUTPUT_BYTES = 8 * 1024 * 1024`.

- [ ] **Step 1: Write the failing test**

Create `tests/skills/trust.test.ts`:

```ts
import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createSkillPackage, runSkillPackage } from '../../src/skills/registry.js';
import { approveSkill, listTrust, readTrust, revokeSkill } from '../../src/skills/trust.js';

const TEST_ROOT = path.resolve('./.knowl-skill-trust-test');
const TRUST_FILE = path.join(TEST_ROOT, '.knowl', 'skill-trust.json');

async function makeSkill(name: string, body: string) {
  await createSkillPackage(TEST_ROOT, {
    name,
    purpose: `Test package ${name}`,
    files: [{ path: 'run.js', content: body }],
    entrypoints: { default: { type: 'script', path: 'run.js', autoRun: true } },
  });
}

describe('skill trust', () => {
  beforeAll(async () => {
    await fs.rm(TEST_ROOT, { recursive: true, force: true }).catch(() => {});
    await fs.mkdir(path.join(TEST_ROOT, '.knowl'), { recursive: true });
  });

  beforeEach(async () => {
    await fs.rm(TRUST_FILE, { force: true }).catch(() => {});
  });

  afterAll(async () => {
    await fs.rm(TEST_ROOT, { recursive: true, force: true }).catch(() => {});
  });

  it('refuses to run an unapproved skill and names the approval command', async () => {
    await makeSkill('unapproved', "console.log('ran')");
    await expect(runSkillPackage(TEST_ROOT, 'unapproved'))
      .rejects.toThrow(/knowl skill approve unapproved/);
  });

  it('runs an approved skill', async () => {
    await makeSkill('approved', "console.log('approved-ran')");
    await approveSkill(TEST_ROOT, 'approved', { approvedBy: 'test' });
    const result = await runSkillPackage(TEST_ROOT, 'approved');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('approved-ran');
  });

  it('invalidates approval when any package byte changes', async () => {
    await makeSkill('mutable', "console.log('first')");
    await approveSkill(TEST_ROOT, 'mutable', { approvedBy: 'test' });
    await fs.writeFile(path.join(TEST_ROOT, '.knowl', 'skills', 'mutable', 'run.js'), "console.log('second')", 'utf-8');
    await expect(runSkillPackage(TEST_ROOT, 'mutable')).rejects.toThrow(/changed since it was approved/i);
  });

  it('invalidates approval when a file is added to the package', async () => {
    await makeSkill('growing', "console.log('base')");
    await approveSkill(TEST_ROOT, 'growing', { approvedBy: 'test' });
    await fs.writeFile(path.join(TEST_ROOT, '.knowl', 'skills', 'growing', 'extra.js'), '// added', 'utf-8');
    await expect(runSkillPackage(TEST_ROOT, 'growing')).rejects.toThrow(/changed since it was approved/i);
  });

  it.skipIf(process.platform === 'win32')('refuses to hash or run a package containing a symlink', async () => {
    await makeSkill('linked', "console.log('linked')");
    const outside = path.join(TEST_ROOT, 'outside.js');
    await fs.writeFile(outside, "console.log('outside')", 'utf-8');
    await fs.symlink(outside, path.join(TEST_ROOT, '.knowl', 'skills', 'linked', 'link.js'));
    await expect(approveSkill(TEST_ROOT, 'linked', { approvedBy: 'test' })).rejects.toThrow(/symlink/i);
  });

  it('restricts approval to the named entrypoints', async () => {
    await createSkillPackage(TEST_ROOT, {
      name: 'two_ways',
      purpose: 'Two entrypoints',
      files: [
        { path: 'run.js', content: "console.log('default-ran')" },
        { path: 'other.js', content: "console.log('other-ran')" },
      ],
      entrypoints: {
        default: { type: 'script', path: 'run.js', autoRun: true },
        other: { type: 'script', path: 'other.js', autoRun: true },
      },
    });
    await approveSkill(TEST_ROOT, 'two_ways', { approvedBy: 'test', allowedEntrypoints: ['default'] });
    await expect(runSkillPackage(TEST_ROOT, 'two_ways', 'default')).resolves.toMatchObject({ exitCode: 0 });
    await expect(runSkillPackage(TEST_ROOT, 'two_ways', 'other')).rejects.toThrow(/not approved/i);
  });

  it('does not pass secrets from the parent environment to a skill', async () => {
    process.env.KNOWL_TRUST_TEST_SECRET = 'must-not-leak';
    try {
      await createSkillPackage(TEST_ROOT, {
        name: 'env_probe',
        purpose: 'Report the environment it received',
        files: [{
          path: 'run.js',
          content: 'console.log(JSON.stringify({ secret: process.env.KNOWL_TRUST_TEST_SECRET ?? null, root: process.env.KNOWL_PROJECT_ROOT ?? null }))',
        }],
        entrypoints: { default: { type: 'script', path: 'run.js', autoRun: true } },
      });
      await approveSkill(TEST_ROOT, 'env_probe', { approvedBy: 'test' });
      const reported = JSON.parse((await runSkillPackage(TEST_ROOT, 'env_probe')).stdout.trim());
      expect(reported.secret).toBeNull();
      expect(reported.root).toBe(TEST_ROOT);
    } finally {
      delete process.env.KNOWL_TRUST_TEST_SECRET;
    }
  });

  it('revokes approval and lists what remains', async () => {
    await makeSkill('temporary', "console.log('temp')");
    await approveSkill(TEST_ROOT, 'temporary', { approvedBy: 'test' });
    expect(await readTrust(TEST_ROOT, 'temporary')).not.toBeNull();
    expect(await revokeSkill(TEST_ROOT, 'temporary')).toBe(true);
    expect(await readTrust(TEST_ROOT, 'temporary')).toBeNull();
    expect(await listTrust(TEST_ROOT)).toEqual({});
    expect(await revokeSkill(TEST_ROOT, 'temporary')).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/skills/trust.test.ts`
Expected: FAIL — `Cannot find module '../../src/skills/trust.js'`.

- [ ] **Step 3: Write the trust module**

Create `src/skills/trust.ts`:

```ts
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { getSkillsDir } from './registry.js';

export type SkillTrustRecord = {
  approvedHash: string;
  approvedAt: string;
  approvedBy: string;
  allowedEntrypoints: string[];
};

type TrustFile = Record<string, SkillTrustRecord>;

/**
 * The trust file sits beside `.knowl/skills`, never inside it.
 *
 * Import normalises every skill file under its own package directory, so a malicious export
 * cannot reach this path and ship its own approval.
 */
function trustPath(projectRoot: string): string {
  return path.join(projectRoot, '.knowl', 'skill-trust.json');
}

/**
 * Walk the package, refusing symlinks rather than resolving them.
 *
 * A link is unhashable in the sense that matters here: hashing its target lets the approved
 * bytes change without changing the hash, and hashing the link text lets execution -- which
 * follows the link -- run something the hash never saw. Either way approval stops meaning
 * "these bytes". A skill package is a handful of files it owns; refusing is not a hardship.
 */
async function collectFiles(dir: string, prefix = ''): Promise<Array<{ relative: string; absolute: string }>> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files: Array<{ relative: string; absolute: string }> = [];
  for (const entry of entries) {
    const absolute = path.join(dir, entry.name);
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) {
      throw new Error(`Skill package file "${relative}" is a symlink, which cannot be approved. Replace it with a real file.`);
    }
    if (entry.isDirectory()) files.push(...await collectFiles(absolute, relative));
    else if (entry.isFile()) files.push({ relative, absolute });
  }
  return files;
}

/**
 * A hash over every byte of the package, including its manifest and markdown.
 *
 * Path and length are folded in alongside content, so moving a file or adding an empty one
 * changes the hash. Sorting by path makes it independent of directory-read order.
 */
export async function hashSkillPackage(projectRoot: string, name: string): Promise<string> {
  const dir = path.join(getSkillsDir(projectRoot), name);
  const files = (await collectFiles(dir)).sort((a, b) => a.relative.localeCompare(b.relative));
  const hash = crypto.createHash('sha256');
  for (const file of files) {
    const content = await fs.readFile(file.absolute);
    hash.update(`${file.relative}\0${content.length}\0`);
    hash.update(content);
  }
  return `sha256:${hash.digest('hex')}`;
}

async function readTrustFile(projectRoot: string): Promise<TrustFile> {
  try {
    return JSON.parse(await fs.readFile(trustPath(projectRoot), 'utf-8')) as TrustFile;
  } catch (error: any) {
    if (error.code === 'ENOENT') return {};
    throw error;
  }
}

async function writeTrustFile(projectRoot: string, trust: TrustFile): Promise<void> {
  const target = trustPath(projectRoot);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, JSON.stringify(trust, null, 2), { encoding: 'utf-8', mode: 0o600 });
  await fs.chmod(target, 0o600).catch(() => {});
}

export async function listTrust(projectRoot: string): Promise<TrustFile> {
  return readTrustFile(projectRoot);
}

export async function readTrust(projectRoot: string, name: string): Promise<SkillTrustRecord | null> {
  return (await readTrustFile(projectRoot))[name] ?? null;
}

export async function approveSkill(
  projectRoot: string,
  name: string,
  options: { approvedBy?: string; allowedEntrypoints?: string[] } = {},
): Promise<SkillTrustRecord> {
  const record: SkillTrustRecord = {
    approvedHash: await hashSkillPackage(projectRoot, name),
    approvedAt: new Date().toISOString(),
    approvedBy: options.approvedBy ?? 'cli',
    allowedEntrypoints: options.allowedEntrypoints ?? ['*'],
  };
  const trust = await readTrustFile(projectRoot);
  trust[name] = record;
  await writeTrustFile(projectRoot, trust);
  return record;
}

export async function revokeSkill(projectRoot: string, name: string): Promise<boolean> {
  const trust = await readTrustFile(projectRoot);
  if (!(name in trust)) return false;
  delete trust[name];
  await writeTrustFile(projectRoot, trust);
  return true;
}

/**
 * Execution is refused unless a human approved these exact bytes for this entrypoint.
 *
 * The error names the command that fixes it, because the caller is usually an agent relaying
 * the message to the person who has to make the decision.
 */
export async function assertSkillApproved(projectRoot: string, name: string, entrypoint: string): Promise<void> {
  const record = await readTrust(projectRoot, name);
  if (!record) {
    throw new Error(`Skill "${name}" has not been approved for execution. Inspect it, then run: knowl skill approve ${name}`);
  }
  if (!record.allowedEntrypoints.includes('*') && !record.allowedEntrypoints.includes(entrypoint)) {
    throw new Error(
      `Entrypoint "${entrypoint}" of skill "${name}" is not approved. Approved: ` +
      `${record.allowedEntrypoints.join(', ')}. Re-approve with: knowl skill approve ${name}`,
    );
  }
  if (await hashSkillPackage(projectRoot, name) !== record.approvedHash) {
    throw new Error(`Skill "${name}" has changed since it was approved. Re-inspect it, then run: knowl skill approve ${name}`);
  }
}
```

`writeTrustFile` writes directly here because `src/core/atomic-write.ts` does not exist yet — Task 3 creates it and switches this function over. The mode is set now regardless, since the trust file is the thing that decides what may execute.

- [ ] **Step 4: Enforce trust, filter the environment, and cap the run**

In `src/skills/registry.ts`, add `import { assertSkillApproved } from './trust.js';` to the imports.

Add above `runShell` (line 255):

```ts
/**
 * Ceilings on one skill run. A learned skill is agent-authored and agent-triggered, so an
 * accidental infinite loop or a gigabyte of stdout is an ordinary outcome, not an attack.
 */
const MAX_SKILL_RUNTIME_MS = 120_000;
const MAX_SKILL_OUTPUT_BYTES = 8 * 1024 * 1024;

function spawnLimits(projectRoot: string, env: NodeJS.ProcessEnv) {
  return {
    cwd: projectRoot,
    env,
    encoding: 'utf-8' as const,
    timeout: MAX_SKILL_RUNTIME_MS,
    maxBuffer: MAX_SKILL_OUTPUT_BYTES,
  };
}

/**
 * Variables a child process needs to function, and nothing else.
 *
 * Inheriting `process.env` handed every skill run the host's model-provider keys, cloud
 * credentials, GitHub tokens and SSH-agent socket. A learned skill is agent-authored; the
 * default has to be that it sees none of that.
 */
const ENV_ALLOWLIST = [
  'PATH', 'Path', 'PATHEXT', 'HOME', 'USERPROFILE', 'SystemRoot', 'SystemDrive', 'windir',
  'ComSpec', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL', 'SHELL', 'TZ', 'NUMBER_OF_PROCESSORS',
];

export function skillEnvironment(projectRoot: string, skill: SkillPackage): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ENV_ALLOWLIST) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  env.KNOWL_PROJECT_ROOT = projectRoot;
  env.KNOWL_SKILL_NAME = skill.manifest.name;
  env.KNOWL_SKILL_DIR = skill.path;
  return env;
}
```

Replace the two `spawnSync` option objects so they use the limits — in `runShell` (lines 256-261):

```ts
function runShell(projectRoot: string, command: string, env: NodeJS.ProcessEnv) {
  return spawnSync(command, { ...spawnLimits(projectRoot, env), shell: true });
}
```

and in `runScript` (lines 284-288):

```ts
  const child = spawnSync(command.command, command.args, spawnLimits(projectRoot, env));
```

In `runSkillPackage`'s `runNamed`, replace the `const env = { ...process.env, … }` block (lines 328-333) with a trust check plus the filtered environment:

```ts
    await assertSkillApproved(projectRoot, name, nameToRun);

    const env = skillEnvironment(projectRoot, skill);
```

- [ ] **Step 5: Extend the existing CLI skill command**

In `src/cli/program.ts`, add to the imports:

```ts
import { approveSkill, listTrust, revokeSkill } from '../skills/trust.js';
```

Add after the existing `skillCommand` subcommands (the `run` subcommand ends around line 1998 — place these before `const evidenceCommand` at line 2000). `skillCommand` is already declared at line 1884; do **not** redeclare it:

```ts
skillCommand
  .command('approve')
  .description('Approve a skill package for execution, pinned to its current contents')
  .argument('<name>', 'Skill package name')
  .option('--entrypoint <name...>', 'Approve only these entrypoints (defaults to all)')
  .action(async (name, options) => {
    try {
      const root = await findProjectRoot(process.cwd());
      const record = await approveSkill(root, name, {
        approvedBy: `cli:${process.env.USER ?? process.env.USERNAME ?? 'unknown'}`,
        allowedEntrypoints: options.entrypoint,
      });
      console.log(`Approved skill "${name}".`);
      console.log(`Hash: ${record.approvedHash}`);
      console.log(`Entrypoints: ${record.allowedEntrypoints.join(', ')}`);
      console.log('Any change to the package revokes this approval.');
    } catch (error: any) {
      console.error(`Error approving skill: ${error.message}`);
      process.exit(1);
    }
  });

skillCommand
  .command('revoke')
  .description('Withdraw approval for a skill package')
  .argument('<name>', 'Skill package name')
  .action(async name => {
    try {
      const root = await findProjectRoot(process.cwd());
      const removed = await revokeSkill(root, name);
      console.log(removed ? `Revoked skill "${name}".` : `Skill "${name}" was not approved.`);
    } catch (error: any) {
      console.error(`Error revoking skill: ${error.message}`);
      process.exit(1);
    }
  });

skillCommand
  .command('trust')
  .description('List approved skill packages')
  .action(async () => {
    try {
      const root = await findProjectRoot(process.cwd());
      const trust = await listTrust(root);
      const names = Object.keys(trust).sort();
      if (names.length === 0) {
        console.log('No skill package is approved for execution.');
        return;
      }
      for (const name of names) {
        const record = trust[name];
        console.log(`${name}\t${record.approvedHash}\t${record.approvedAt}\t${record.allowedEntrypoints.join(',')}`);
      }
    } catch (error: any) {
      console.error(`Error listing skill trust: ${error.message}`);
      process.exit(1);
    }
  });
```

Confirm the helper name with `grep -n "findProjectRoot" src/cli/program.ts | head -3` and match whatever the surrounding commands use.

- [ ] **Step 6: Update the tests that now need approval**

Every test that runs a skill needs its package approved first. Add `import { approveSkill } from '../../src/skills/trust.js';` and an `await approveSkill(<root>, '<name>', { approvedBy: 'test' });` after each `createSkillPackage` whose package is later executed, in:

- `tests/skills/registry.test.ts`
- `tests/skills/identity.test.ts` (created by the 3.0.1 plan)
- `tests/store/skill-loop-integration.test.ts`

Run `grep -rln "runSkillPackage" tests/` first and cover every hit.

- [ ] **Step 7: Update the MCP tool description**

In `src/mcp/tools.ts`, find the `knowl_skill_run` definition and replace its `description`:

```ts
          description: 'Run an approved learned-skill entrypoint. A skill must be approved by the user with `knowl skill approve <name>` before it will run, and any edit to the package revokes that approval. If the call is refused, relay the approval command to the user rather than trying to work around it.',
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `npx vitest run tests/skills/ tests/store/skill-loop-integration.test.ts tests/store/skill-surface.test.ts tests/mcp/`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/skills/trust.ts src/skills/registry.ts src/cli/program.ts src/mcp/tools.ts tests/skills/ tests/store/skill-loop-integration.test.ts
git commit -m "feat(skills): require hash-pinned approval, a filtered environment, and run ceilings to execute a skill"
```

---

### Task 2: Bound and stream the JSONL import

`importKnowledge` reads the whole file into a string, splits every line, and parses every record before doing anything (`src/store/portability.ts:327-333`). A large or hostile export exhausts memory before any validation runs. There are no ceilings on total bytes, record count, record size, or skill-file count.

`stream-json` is a dependency, but it parses one large JSON document — the wrong tool for JSON Lines. `node:readline` is the right one: it yields one line at a time, so the checksum accumulates and each record is parsed and counted as it arrives, and an oversized file is refused at the limit rather than after allocating everything.

**Files:**
- Modify: `src/store/portability.ts:311-333`, and `planSkillInstalls` (added by the 3.0.1 plan)
- Test: `tests/store/import-limits.test.ts` (create)

**Interfaces:**
- Consumes: `planSkillInstalls` from the 3.0.1 plan's Task 1.
- Produces: `importKnowledge` keeps its signature. New `export const IMPORT_LIMITS = { maxBytes: 268_435_456, maxRecords: 500_000, maxRecordBytes: 4_194_304, maxSkillFiles: 200 }` and module-private `async function readImportRecords(inputPath: string): Promise<any[]>`.

- [ ] **Step 1: Write the failing test**

Create `tests/store/import-limits.test.ts`:

```ts
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, initDb } from '../../src/store/database.js';
import { IMPORT_LIMITS, importKnowledge } from '../../src/store/portability.js';

const TEST_ROOT = path.resolve('./.knowl-import-limits-test');
const HEADER = { type: 'header', format: 'knowl-jsonl', version: 2, namespace: 'project' };

async function writeStream(name: string, records: unknown[]): Promise<string> {
  const body = `${records.map(record => JSON.stringify(record)).join('\n')}\n`;
  const sha256 = crypto.createHash('sha256').update(body).digest('hex');
  const streamPath = path.join(TEST_ROOT, name);
  await fs.writeFile(streamPath, `${body}${JSON.stringify({ type: 'manifest', sha256 })}\n`, 'utf8');
  return streamPath;
}

describe('import limits', () => {
  beforeAll(async () => {
    await fs.rm(TEST_ROOT, { recursive: true, force: true }).catch(() => {});
    await fs.mkdir(path.join(TEST_ROOT, '.knowl'), { recursive: true });
    await initDb(TEST_ROOT);
  });

  afterAll(async () => {
    await closeDb();
    await fs.rm(TEST_ROOT, { recursive: true, force: true }).catch(() => {});
  });

  it('rejects a stream larger than the byte ceiling without reading it', async () => {
    const streamPath = path.join(TEST_ROOT, 'huge-stream.jsonl');
    const handle = await fs.open(streamPath, 'w');
    await handle.truncate(IMPORT_LIMITS.maxBytes + 1);
    await handle.close();
    await expect(importKnowledge(streamPath, { projectRoot: TEST_ROOT })).rejects.toThrow(/import limit/i);
  });

  it('rejects a single record larger than the record ceiling', async () => {
    const streamPath = await writeStream('huge-record.jsonl', [
      HEADER,
      { type: 'skill_package', name: 'big', files: [{ path: 'big.txt', content: 'x'.repeat(IMPORT_LIMITS.maxRecordBytes + 10) }] },
    ]);
    await expect(importKnowledge(streamPath, { projectRoot: TEST_ROOT })).rejects.toThrow(/record limit/i);
  });

  it('rejects a skill package with too many files', async () => {
    const files = Array.from({ length: IMPORT_LIMITS.maxSkillFiles + 1 }, (_, index) => ({
      path: `file-${index}.txt`,
      content: 'x',
    }));
    const streamPath = await writeStream('too-many-files.jsonl', [
      HEADER,
      { type: 'skill_package', name: 'wide', files },
    ]);
    await expect(importKnowledge(streamPath, { projectRoot: TEST_ROOT })).rejects.toThrow(/more than the limit/i);
  });

  it('still imports a well-formed stream', async () => {
    const streamPath = await writeStream('fine.jsonl', [
      HEADER,
      { type: 'skill_package', name: 'small', files: [{ path: 'run.sh', content: 'echo ok\n' }] },
    ]);
    expect((await importKnowledge(streamPath, { projectRoot: TEST_ROOT })).applied).toBe(true);
  });

  it('still rejects a tampered checksum', async () => {
    const streamPath = await writeStream('tampered.jsonl', [HEADER]);
    const contents = await fs.readFile(streamPath, 'utf8');
    await fs.writeFile(streamPath, contents.replace('"namespace":"project"', '"namespace":"global"'), 'utf8');
    await expect(importKnowledge(streamPath, { projectRoot: TEST_ROOT })).rejects.toThrow(/checksum/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/store/import-limits.test.ts`
Expected: FAIL — `IMPORT_LIMITS` is not exported.

- [ ] **Step 3: Write the implementation**

In `src/store/portability.ts`, add to the imports:

```ts
import { createReadStream } from 'node:fs';
import readline from 'node:readline';
```

Add above `importKnowledge` (line 311):

```ts
/**
 * Ceilings on one import.
 *
 * The reader loaded the whole file, split it, and parsed every line before any validation ran,
 * so an oversized export exhausted memory before it could be rejected. These bounds are
 * generous for a real repository and fatal for a hostile one.
 */
export const IMPORT_LIMITS = {
  maxBytes: 268_435_456,
  maxRecords: 500_000,
  maxRecordBytes: 4_194_304,
  maxSkillFiles: 200,
};

/**
 * Stream the JSONL body, accumulating the checksum as lines arrive.
 *
 * One line is held back at all times, because the last line is the manifest and is excluded
 * from the hashed body. `stream-json` is not the tool here despite being a dependency -- it
 * parses one large JSON document, and this format is one JSON value per line.
 */
async function readImportRecords(inputPath: string): Promise<any[]> {
  const stat = await fs.stat(inputPath);
  if (stat.size > IMPORT_LIMITS.maxBytes) {
    throw new Error(`Import stream is ${stat.size} bytes, over the ${IMPORT_LIMITS.maxBytes}-byte import limit.`);
  }

  const hash = crypto.createHash('sha256');
  const records: any[] = [];
  let held: string | null = null;

  const consume = (line: string) => {
    if (line.length > IMPORT_LIMITS.maxRecordBytes) {
      throw new Error(`Import record is over the ${IMPORT_LIMITS.maxRecordBytes}-byte record limit.`);
    }
    if (records.length >= IMPORT_LIMITS.maxRecords) {
      throw new Error(`Import stream holds more than ${IMPORT_LIMITS.maxRecords} records.`);
    }
    hash.update(`${line}\n`);
    records.push(JSON.parse(line));
  };

  const input = createReadStream(inputPath, { encoding: 'utf8' });
  const reader = readline.createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of reader) {
      if (!line) continue;
      if (held !== null) consume(held);
      held = line;
    }
  } finally {
    reader.close();
    input.destroy();
  }

  if (held === null || records.length < 1) throw new Error('Invalid Knowl JSONL stream.');
  const manifest = JSON.parse(held);
  if (manifest.type !== 'manifest' || manifest.sha256 !== hash.digest('hex')) {
    throw new Error('JSONL manifest checksum mismatch.');
  }
  return records;
}
```

Replace lines 327-333 of `importKnowledge` — from `const source = await fs.readFile(inputPath, 'utf8');` through `const records = lines.slice(0, -1).map(line => JSON.parse(line));` — with:

```ts
  const records = await readImportRecords(inputPath);
```

Leave the `const header = records.shift();` line and everything after it unchanged.

- [ ] **Step 4: Add the skill-file ceiling**

In `planSkillInstalls` (added by the 3.0.1 plan), insert after `validateSkillName(skill.name);`:

```ts
    const files = skill.files ?? [];
    if (files.length > IMPORT_LIMITS.maxSkillFiles) {
      throw new Error(
        `Imported skill "${skill.name}" declares ${files.length} files, more than the limit of ` +
        `${IMPORT_LIMITS.maxSkillFiles}.`,
      );
    }
```

and change the inner loop header from `for (const file of skill.files ?? [])` to `for (const file of files)`.

- [ ] **Step 5: Rename the misleading "manifest-verified" wording**

Run: `grep -rn "manifest-verified\|manifest verified" src/ README.md`

Replace each hit with "checksum-verified". A SHA-256 manifest proves the bytes are intact; it says nothing about who produced the export, and whoever builds a malicious one computes a valid checksum for it.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run tests/store/import-limits.test.ts tests/store/import-skill-safety.test.ts tests/store/portability.test.ts tests/store/import-policy.test.ts tests/store/import-commit-trail.test.ts tests/store/export-ownership.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/store/portability.ts tests/store/import-limits.test.ts README.md
git commit -m "fix(portability): stream JSONL imports and bound stream, record, and skill-file size"
```

---

### Task 3: Write config, trust, and diagnostics files atomically and owner-only

`saveConfig` (`src/core/config.ts:197-208`) calls `fs.writeFile` directly. An interrupted write leaves truncated JSON that `loadConfig` cannot parse, two writers can interleave, and the mode is whatever the umask produces. That file can hold a literal `ai.apiKey` — 3.0.0 added env-reference support (`preserveEnvReferences`, `envReferenceName`), which is the better path, but a literal is still accepted.

`append` in `src/core/startup-trace.ts:103-112` creates a machine-wide diagnostics directory and log with default permissions, and each `boot-start` record carries the literal project root alongside hostname, PID, load average and free memory (line 152). On a shared Unix host that tells every local account which projects this user works on and when. A hash answers the log's actual questions — "same project?", "several servers stalling together?" — without being identifying.

**Files:**
- Create: `src/core/atomic-write.ts`
- Modify: `src/core/config.ts:197-208`
- Modify: `src/core/startup-trace.ts:82-112, 147-161`
- Modify: `src/cli/program.ts:2208` (`diagnose-startup --clear`)
- Test: `tests/core/atomic-write.test.ts`, `tests/core/startup-trace.test.ts` (create)

**Interfaces:**
- Consumes: nothing from earlier tasks; Task 1's `writeTrustFile` consumes this module.
- Produces: `export async function writeFileAtomic(target: string, contents: string, options?: { mode?: number }): Promise<void>` from `src/core/atomic-write.ts`; `export function clearStartupLog(): void` from `src/core/startup-trace.ts`. The `boot-start` record's `projectRoot` field becomes `projectHash`.

- [ ] **Step 1: Write the failing tests**

Create `tests/core/atomic-write.test.ts`:

```ts
import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { writeFileAtomic } from '../../src/core/atomic-write.js';
import { loadConfig, saveConfig } from '../../src/core/config.js';

const TEST_ROOT = path.resolve('./.knowl-atomic-write-test');

describe('atomic writes', () => {
  beforeAll(async () => {
    await fs.rm(TEST_ROOT, { recursive: true, force: true }).catch(() => {});
    await fs.mkdir(path.join(TEST_ROOT, '.knowl'), { recursive: true });
  });

  afterAll(async () => {
    await fs.rm(TEST_ROOT, { recursive: true, force: true }).catch(() => {});
  });

  it('replaces a file in one step and leaves no temporary behind', async () => {
    const target = path.join(TEST_ROOT, 'value.json');
    await writeFileAtomic(target, '{"a":1}');
    await writeFileAtomic(target, '{"a":2}');
    expect(await fs.readFile(target, 'utf8')).toBe('{"a":2}');
    expect((await fs.readdir(TEST_ROOT)).filter(entry => entry.includes('.tmp'))).toEqual([]);
  });

  it.skipIf(process.platform === 'win32')('creates the file owner-readable only', async () => {
    const target = path.join(TEST_ROOT, 'secret.json');
    await writeFileAtomic(target, '{"apiKey":"x"}', { mode: 0o600 });
    expect((await fs.stat(target)).mode & 0o777).toBe(0o600);
  });

  it.skipIf(process.platform === 'win32')('saves project config owner-readable only', async () => {
    await saveConfig(TEST_ROOT, { ai: { provider: 'openai', model: 'gpt-4o-mini' } } as any);
    expect((await fs.stat(path.join(TEST_ROOT, '.knowl', 'config.json'))).mode & 0o777).toBe(0o600);
    expect((await loadConfig(TEST_ROOT)).ai?.model).toBe('gpt-4o-mini');
  });
});
```

Create `tests/core/startup-trace.test.ts`:

```ts
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const HOME = path.resolve('./.knowl-startup-trace-test-home');
const DISTINCTIVE = path.join(os.tmpdir(), 'a-very-distinctive-project-name');

describe('startup diagnostics', () => {
  beforeAll(async () => {
    await fs.rm(HOME, { recursive: true, force: true }).catch(() => {});
    process.env.KNOWL_HOME = HOME;
    delete process.env.KNOWL_DISABLE_STARTUP_TRACE;
  });

  afterAll(async () => {
    delete process.env.KNOWL_HOME;
    await fs.rm(HOME, { recursive: true, force: true }).catch(() => {});
  });

  it('records a hashed project root, never the path', async () => {
    const { beginStartupTrace, startupLogPath } = await import('../../src/core/startup-trace.js');
    beginStartupTrace({ projectRoot: DISTINCTIVE, version: '0.0.0-test' });
    const contents = await fs.readFile(startupLogPath(), 'utf8');
    expect(contents).not.toContain('a-very-distinctive-project-name');
    const record = JSON.parse(contents.split('\n').filter(Boolean)[0]);
    expect(record.projectHash).toMatch(/^[0-9a-f]{16}$/);
    expect(record.projectRoot).toBeUndefined();
  });

  it.skipIf(process.platform === 'win32')('keeps the diagnostics directory and log owner-only', async () => {
    const { diagnosticsDir, startupLogPath } = await import('../../src/core/startup-trace.js');
    expect((await fs.stat(diagnosticsDir())).mode & 0o777).toBe(0o700);
    expect((await fs.stat(startupLogPath())).mode & 0o777).toBe(0o600);
  });

  it('clears the log on request', async () => {
    const { clearStartupLog, startupLogPath } = await import('../../src/core/startup-trace.js');
    clearStartupLog();
    await expect(fs.access(startupLogPath())).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/core/atomic-write.test.ts tests/core/startup-trace.test.ts`
Expected: FAIL — `Cannot find module '../../src/core/atomic-write.js'`; the trace log contains the literal path and `clearStartupLog` is not exported.

- [ ] **Step 3: Write the atomic writer**

Create `src/core/atomic-write.ts`:

```ts
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Replace a file's contents in one observable step.
 *
 * A direct `writeFile` truncates first, so an interrupted write leaves a half file that
 * `loadConfig` cannot parse, and two concurrent writers can interleave. The temporary lives in
 * the same directory so the rename stays on one filesystem, and the contents are flushed before
 * the rename makes them visible.
 *
 * `mode` is applied at create time and again after, because a permissive umask can widen the
 * mode passed to `open`.
 */
export async function writeFileAtomic(
  target: string,
  contents: string,
  options: { mode?: number } = {},
): Promise<void> {
  const directory = path.dirname(target);
  const staged = path.join(directory, `.${path.basename(target)}.${crypto.randomUUID().slice(0, 8)}.tmp`);
  await fs.mkdir(directory, { recursive: true });
  try {
    const handle = await fs.open(staged, 'w', options.mode);
    try {
      await handle.writeFile(contents, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (options.mode !== undefined) await fs.chmod(staged, options.mode).catch(() => {});
    await fs.rename(staged, target);
  } catch (error) {
    await fs.rm(staged, { force: true }).catch(() => {});
    throw error;
  }
}
```

In `src/skills/trust.ts`, add `import { writeFileAtomic } from '../core/atomic-write.js';` and replace the whole body of `writeTrustFile` — Task 1 wrote it directly because this module did not exist yet:

```ts
async function writeTrustFile(projectRoot: string, trust: TrustFile): Promise<void> {
  await writeFileAtomic(trustPath(projectRoot), JSON.stringify(trust, null, 2), { mode: 0o600 });
}
```

In `src/core/config.ts`, add `import { writeFileAtomic } from './atomic-write.js';` and replace the `try` block inside `saveConfig` (lines 202-207):

```ts
  try {
    await fs.mkdir(configDir, { recursive: true });
    // 0600: this file can still hold a literal `ai.apiKey`, and its mode should not depend on
    // the user's umask. A no-op on Windows, where ACLs govern instead.
    await writeFileAtomic(configPath, JSON.stringify(normalized, null, 2), { mode: 0o600 });
  } catch (error: any) {
    throw new ConfigError(`Failed to save config to "${configPath}": ${error.message}`);
  }
```

- [ ] **Step 4: Restrict and redact the diagnostics log**

In `src/core/startup-trace.ts`, add `import crypto from 'node:crypto';` and replace `append` (lines 103-112):

```ts
/**
 * Append one record. Synchronous on purpose: this is called from watchdogs and exit handlers,
 * where an async write may never flush before the process dies -- which is precisely the record
 * worth keeping.
 *
 * The modes matter because this file is machine-wide rather than per-project: on a shared host
 * it would otherwise tell every local account which projects this user runs, and when.
 */
function append(record: Record<string, unknown>): void {
  try {
    fs.mkdirSync(diagnosticsDir(), { recursive: true, mode: 0o700 });
    fs.chmodSync(diagnosticsDir(), 0o700);
    const file = startupLogPath();
    if (!fs.existsSync(file)) fs.writeFileSync(file, '', { mode: 0o600 });
    fs.appendFileSync(file, JSON.stringify(record) + '\n');
    fs.chmodSync(file, 0o600);
    trimStartupLog(file);
  } catch {
    // A diagnostic must never be the reason a server fails to start.
  }
}

/**
 * A stable, non-identifying handle for one project.
 *
 * The log's questions are "was this the same project?" and "were several servers stalling
 * together?". A hash answers both; the path itself answers neither better.
 */
function projectHash(projectRoot: string): string {
  return crypto.createHash('sha256').update(path.resolve(projectRoot)).digest('hex').slice(0, 16);
}

/** Remove the machine-wide diagnostics log. Exposed as `knowl diagnose-startup --clear`. */
export function clearStartupLog(): void {
  try {
    fs.rmSync(startupLogPath(), { force: true });
  } catch {
    // Same rule as append.
  }
}
```

In `beginStartupTrace`, replace line 152:

```ts
    projectHash: projectHash(context.projectRoot ?? process.cwd()),
```

In `trimStartupLog`, preserve the mode at line 92:

```ts
    fs.writeFileSync(file, boundary === -1 ? contents : contents.slice(boundary + 1), { mode: 0o600 });
```

- [ ] **Step 5: Add the clear command and fix any reader of the old field**

In `src/cli/program.ts`, on the `diagnose-startup` command at line 2208, add:

```ts
  .option('--clear', 'Delete the machine-wide startup diagnostics log')
```

and at the top of its action:

```ts
    if (options.clear) {
      clearStartupLog();
      console.log(`Cleared ${startupLogPath()}`);
      return;
    }
```

adding `clearStartupLog` to whatever import already brings `startupLogPath` into that file.

Run: `grep -rn "projectRoot" src/core/startup-trace.ts src/cli/startup-report.ts src/cli/program.ts | grep -i "diagnos\|trace"` and update any reader of the record's old `projectRoot` field to `projectHash`.

- [ ] **Step 6: Document what the log stores and prefer env references**

In the README's diagnostics section (`grep -n "diagnose-startup" README.md`):

```markdown
Each record holds a boot id, PID, elapsed and per-phase timings, Node version, hostname, load
average, free memory, and a 16-character hash of the project root — never the path itself, and
never environment variables or command-line arguments. The file is capped at 4MB, written
owner-only, and removable with `knowl diagnose-startup --clear`. Set
`KNOWL_DISABLE_STARTUP_TRACE=1` to turn it off entirely.
```

In the AI configuration section (`grep -n "apiKey" README.md`):

```markdown
`ai.apiKey` may be set literally in `.knowl/config.json`, which Knowl writes owner-readable
(`0600`) on POSIX systems. Prefer an environment reference or the provider variables —
`OPENAI_API_KEY`, `ANTHROPIC_API_KEY` — so the credential never lands in a file inside the
repository directory.
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npx vitest run tests/core/ tests/skills/trust.test.ts tests/cli/`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/core/atomic-write.ts src/core/config.ts src/core/startup-trace.ts src/cli/program.ts tests/core/ README.md
git commit -m "fix(core): write config atomically and keep config and diagnostics owner-only"
```

---

### Task 4: Generate the README sections that keep drifting

Six README claims were wrong at 2.17.0 and all six were still wrong at 3.0.0 — the version, the default embedding model, the MCP tool count, the tool table, the CLI command list, and the preset table. Every one restates something the code already knows. Hand-maintained restatements drift; generated ones cannot.

The MCP tool list lives inside a closure in `registerTools`, so nothing can read it. Moving the array literal to its own module is what makes generation possible and costs nothing at runtime — but the literal references `KNOWLEDGE_CATEGORIES` at lines 223 and 302, so the new module must import it too.

**Files:**
- Create: `src/mcp/tool-definitions.ts`
- Modify: `src/mcp/tools.ts` (import definitions rather than inlining)
- Modify: `src/core/vector-profile.ts:20-68, 149-152`
- Create: `scripts/generate-docs.ts`
- Modify: `package.json` (dev dependency and scripts), `README.md`

**Interfaces:**
- Consumes: `VECTOR_PRESETS`, `DEFAULT_PRESET_ID` from `src/core/vector-profile.ts`.
- Produces: `export const CORE_TOOL_DEFINITIONS: Array<Record<string, unknown>>` and `export const TRANSCRIPT_TOOL_DEFINITIONS: Array<Record<string, unknown>>` from `src/mcp/tool-definitions.ts`; new `PresetDefinition.contextTokens: number`.

- [ ] **Step 1: Resolve the loader before writing the generator**

The generator must import TypeScript source. `tsx` is present in `node_modules/.bin` only as a transitive dependency of `tsup` — relying on that is a broken build waiting for an unrelated upgrade. Make it explicit:

Run: `npm install --save-dev tsx@latest`

- [ ] **Step 2: Move the tool definitions into their own module**

Create `src/mcp/tool-definitions.ts`:

```ts
import { KNOWLEDGE_CATEGORIES } from '../core/types.js';

/**
 * The MCP tool schemas, as data.
 *
 * They lived inside `registerTools`, which meant nothing outside the running server could read
 * them -- so the README's tool table and its "exactly N tools" line were maintained by hand and
 * drifted to three different numbers at once. `scripts/generate-docs.ts` reads this module.
 */
export const CORE_TOOL_DEFINITIONS: Array<Record<string, unknown>> = [
  // ... every non-transcript entry, moved verbatim from the array in src/mcp/tools.ts ...
];

export const TRANSCRIPT_TOOL_DEFINITIONS: Array<Record<string, unknown>> = [
  // ... knowl_transcript_search, knowl_transcript_read, knowl_session_list, moved verbatim ...
];
```

In `src/mcp/tools.ts`, add `import { CORE_TOOL_DEFINITIONS, TRANSCRIPT_TOOL_DEFINITIONS } from './tool-definitions.js';`, replace the inline array with `const tools: Array<Record<string, unknown>> = [...CORE_TOOL_DEFINITIONS];`, and where the transcript tools are conditionally appended, push `...TRANSCRIPT_TOOL_DEFINITIONS` instead of the inline literals. Leave every request handler exactly where it is — this step moves schemas only. `KNOWLEDGE_CATEGORIES` stays imported in `tools.ts` as well; lines 986 and 1038 still use it.

Run: `npx vitest run tests/mcp/` — expected PASS with no test changes, since the same 30 names are registered.

- [ ] **Step 3: Add the context length without leaking it into the vector fingerprint**

In `src/core/vector-profile.ts`, add `contextTokens: number;` to `PresetDefinition` (line 20) and set it on each preset: `8192` for `granite-small-en-r2`, `32768` for `granite-97m-multilingual`, `512` for `bge-small-en`, `512` for `minilm-l6-en`.

Then extend the destructure in `presetProfile` (line 150), which strips documentation fields from the runtime profile. Missing this would fold `contextTokens` into `VectorProfile` and therefore into `fingerprintProfile`, invalidating every stored embedding on upgrade:

```ts
function presetProfile(id: Exclude<PresetId, 'custom'>): VectorProfile {
  const {
    label: _label, sizeMb: _sizeMb, languages: _languages, contextTokens: _contextTokens, ...profile
  } = VECTOR_PRESETS[id];
  return profile;
}
```

Run: `npx vitest run tests/store/vector-fingerprint.test.ts tests/store/embedding-identity.test.ts` — expected PASS. A failure here means the fingerprint changed and the destructure is wrong.

- [ ] **Step 4: Write the generator**

Create `scripts/generate-docs.ts`:

```ts
// Generates the README regions that restate something the code already knows.
// `npm run docs:generate` rewrites them; `npm run docs:check` fails if they are stale.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CORE_TOOL_DEFINITIONS, TRANSCRIPT_TOOL_DEFINITIONS } from '../src/mcp/tool-definitions.js';
import { DEFAULT_PRESET_ID, VECTOR_PRESETS } from '../src/core/vector-profile.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const readmePath = path.join(root, 'README.md');
const check = process.argv.includes('--check');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

function firstSentence(description: unknown): string {
  const text = String(description).replace(/\s+/g, ' ').trim();
  const stop = text.indexOf('. ');
  return stop === -1 ? text : text.slice(0, stop + 1).trim();
}

function contextLabel(tokens: number): string {
  return tokens >= 1024 ? `${tokens / 1024}k` : String(tokens);
}

const regions: Record<string, string> = {
  version: `Knowl ${pkg.version}`,

  'mcp-tools': [
    'Knowl exposes the following MCP tools. Three further tools —',
    `\`${TRANSCRIPT_TOOL_DEFINITIONS.map(tool => tool.name).join('`, `')}\` — are registered`,
    'in addition when transcript indexing is enabled for the repository.',
    '',
    '| Tool | Purpose |',
    '| --- | --- |',
    ...CORE_TOOL_DEFINITIONS.map(tool => `| \`${tool.name}\` | ${firstSentence(tool.description)} |`),
  ].join('\n'),

  'embedding-presets': [
    '| Preset | Model | Size (q8) | Context | Languages |',
    '| --- | --- | --- | --- | --- |',
    ...Object.entries(VECTOR_PRESETS).map(([id, preset]) =>
      `| \`${id}\`${id === DEFAULT_PRESET_ID ? ' *(default)*' : ''} | \`${preset.model}\` | ~${preset.sizeMb}MB | ${contextLabel(preset.contextTokens)} | ${preset.languages} |`),
    '| `custom` | whatever you name | varies | varies | varies |',
  ].join('\n'),

  'cli-commands': (() => {
    const help = execFileSync(process.execPath, [path.join(root, 'dist', 'index.js'), '--help'], {
      encoding: 'utf8',
      env: { ...process.env, NO_COLOR: '1' },
    });
    const marker = help.indexOf('Commands:');
    if (marker === -1) throw new Error('Could not find a "Commands:" section in `knowl --help`.');
    return ['```', help.slice(marker + 'Commands:'.length).trim(), '```'].join('\n');
  })(),
};

const current = fs.readFileSync(readmePath, 'utf8');
let next = current;
for (const [id, body] of Object.entries(regions)) {
  const open = `<!-- generated:${id} -->`;
  const close = `<!-- /generated:${id} -->`;
  const pattern = new RegExp(`${open}[\\s\\S]*?${close}`);
  if (!pattern.test(next)) throw new Error(`README is missing the ${open} region.`);
  next = next.replace(pattern, `${open}\n${body}\n${close}`);
}

if (check) {
  if (current !== next) {
    console.error('README generated sections are stale. Run: npm run docs:generate');
    process.exit(1);
  }
  console.log('README generated sections are current.');
} else if (current !== next) {
  fs.writeFileSync(readmePath, next);
  console.log('README generated sections updated.');
} else {
  console.log('README generated sections already current.');
}
```

- [ ] **Step 5: Add the region markers to the README**

Wrap each drifting section in its markers:

- `README.md:39` — the version line, in `<!-- generated:version -->` / `<!-- /generated:version -->`.
- The tool-table intro and table (currently from line 1074) in `<!-- generated:mcp-tools -->`.
- The model table (currently lines 207-213) in `<!-- generated:embedding-presets -->`.
- The CLI reference section's hand-written command list in `<!-- generated:cli-commands -->`.

- [ ] **Step 6: Wire up the npm scripts**

In `package.json`:

```json
    "docs:generate": "npm run build && tsx scripts/generate-docs.ts",
    "docs:check": "npm run build && tsx scripts/generate-docs.ts --check",
```

- [ ] **Step 7: Generate and verify**

Run: `npm run docs:generate`
Expected: "README generated sections updated." Inspect `git diff README.md`: the tool table should list every core tool, the preset table should mark `granite-small-en-r2` as the default with an 8k context, and the version line should read the current version.

Run: `npm run docs:check`
Expected: exit 0.

- [ ] **Step 8: Commit**

```bash
git add src/mcp/tool-definitions.ts src/mcp/tools.ts src/core/vector-profile.ts scripts/generate-docs.ts package.json package-lock.json README.md
git commit -m "docs: generate the README version, tool table, CLI reference, and preset table from source"
```

---

### Task 5: Add the CI gates that would have caught this

`.github/workflows/ci.yml` runs one job: `ubuntu-latest`, Node 22, `npm ci` → `npm run build` → `npm test`. There is no Windows or macOS runner even though the primary development host is Windows, no Node matrix, no lint, no format check, no coverage threshold, no dependency audit, and no static analysis. `package.json` declares no lint or typecheck script, and no ESLint config exists at the repo root though `src/store/database.ts:11` carries an `eslint-disable` comment.

**Files:**
- Create: `eslint.config.mjs`, `.github/workflows/codeql.yml`, `.github/dependabot.yml`
- Modify: `package.json`, `.github/workflows/ci.yml`

- [ ] **Step 1: Add lint and typecheck tooling**

Run: `npm install --save-dev eslint@latest typescript-eslint@latest @eslint/js@latest`

Create `eslint.config.mjs`:

```js
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', '.benchmark-dist/**', 'benchmarks/**/dist/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // The base rule does not understand type-only usage or TypeScript's parameter forms and
      // double-reports everything the TS rule already covers. `tseslint.configs.recommended`
      // disables it, but it is named here so an added config block cannot silently reinstate it.
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      // The codebase uses `any` deliberately at storage and import boundaries where the shape is
      // genuinely unknown until validated. Flagging every one trains the team to ignore the linter.
      '@typescript-eslint/no-explicit-any': 'off',
      'no-console': 'off',
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
);
```

Add to `package.json` scripts:

```json
    "lint": "eslint .",
    "typecheck": "tsc --noEmit",
    "test:coverage": "vitest run --coverage",
    "audit:prod": "npm audit --omit=dev --audit-level=high"
```

- [ ] **Step 2: Make lint and typecheck pass**

Run: `npm run typecheck`
Expected: exit 0. Fix what it reports — `tsup --dts` does not fail the build on every type error the way `tsc --noEmit` does, so this may surface real problems.

Run: `npm run lint`
Expected: exit 0. Fix genuine findings. Where a rule is wrong for this codebase, disable it in `eslint.config.mjs` with a comment saying why, rather than scattering inline disables.

- [ ] **Step 3: Replace the CI workflow**

Replace `.github/workflows/ci.yml`:

```yaml
name: CI

on:
  push:
    branches:
      - main
  pull_request:
  workflow_dispatch:

concurrency:
  group: ci-${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: true

permissions:
  contents: read

jobs:
  test:
    name: test (${{ matrix.os }}, node ${{ matrix.node }})
    runs-on: ${{ matrix.os }}
    strategy:
      fail-fast: false
      matrix:
        # Windows is the primary development host and was never covered; macOS catches the
        # POSIX-but-not-Linux differences in path, permission and shell handling.
        os: [ubuntu-latest, windows-latest, macos-latest]
        node: [22, 24]
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: ${{ matrix.node }}
          cache: npm
      - run: npm ci
      - run: npm run build
      - run: npm test

  quality:
    name: lint, types, and docs
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - run: npm run typecheck
      - run: npm run lint
      - name: README generated sections are current
        run: npm run docs:check

  audit:
    name: dependency audit
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - run: npm run audit:prod

  package:
    name: package tarball smoke test
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - run: npm pack
      - name: Install the tarball into a clean directory and run the CLI
        run: |
          mkdir -p /tmp/knowl-smoke && cd /tmp/knowl-smoke
          npm init -y
          npm install "$GITHUB_WORKSPACE"/knowl-*.tgz
          ./node_modules/.bin/knowl --version
          ./node_modules/.bin/knowl --help
```

- [ ] **Step 4: Add CodeQL and Dependabot**

Create `.github/workflows/codeql.yml`:

```yaml
name: CodeQL

on:
  push:
    branches: [main]
  pull_request:
  schedule:
    - cron: '17 4 * * 1'

permissions:
  contents: read
  security-events: write

jobs:
  analyze:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: github/codeql-action/init@v3
        with:
          languages: javascript-typescript
          queries: security-extended
      - uses: github/codeql-action/analyze@v3
```

Create `.github/dependabot.yml`:

```yaml
version: 2
updates:
  - package-ecosystem: npm
    directory: /
    schedule:
      interval: weekly
    open-pull-requests-limit: 5
    groups:
      dev-dependencies:
        dependency-type: development
  - package-ecosystem: github-actions
    directory: /
    schedule:
      interval: monthly
```

- [ ] **Step 5: Verify locally, then commit**

Run: `npm run typecheck && npm run lint && npm run docs:check && npm test`
Expected: all exit 0.

```bash
git add eslint.config.mjs package.json package-lock.json .github/
git commit -m "ci: add platform and Node matrix, lint, typecheck, docs drift, audit, CodeQL, and Dependabot"
```

- [ ] **Step 6: Confirm the matrix is actually green**

Push the branch and open a PR. Windows and macOS runners are new; expect failures the Linux-only job never surfaced — most likely path separators in tests, the file-mode assertions from Task 3, and anything depending on a POSIX shell. Fix each properly rather than by narrowing the matrix. A matrix trimmed to stay green is worse than no matrix, because it looks like coverage. Do not merge with a red matrix job.

---

### Task 6: Decide the dependency upgrades on evidence, then release

The lockfile at 3.0.0 resolves `commander@12.1.0`, `dotenv@16.6.1`, `zod@3.25.76`, `@libsql/client@0.14.0`, `@modelcontextprotocol/sdk@1.29.0`, and `drizzle-orm@0.45.2`. Newer major lines exist for several. Nothing here establishes that the current versions carry known vulnerabilities — that is what Task 5's `audit:prod` job now answers continuously. This task is about not being three majors behind when a real advisory lands.

**Files:**
- Modify: `package.json`, `package-lock.json`, `CHANGELOG.md`
- Create: `docs/dependency-review-2026-08.md`

- [ ] **Step 1: Establish the current security position**

Run: `npm audit --omit=dev --json > audit.json && node -e "console.log(JSON.stringify(require('./audit.json').metadata.vulnerabilities))" && rm audit.json`

Record the result in `docs/dependency-review-2026-08.md`. If it is not all zeroes, those advisories jump ahead of everything below.

- [ ] **Step 2: Check what each upgrade actually requires**

```bash
npm view commander@latest version engines
npm view dotenv@latest version engines
npm view zod@latest version engines
npm view @libsql/client@latest version engines
npm view @modelcontextprotocol/sdk@latest version engines
```

Record each result. In particular, read Commander's own `engines.node` before assuming it forces a change to Knowl's `>=22` floor — do not take that from any review summary, including this one.

- [ ] **Step 3: Upgrade `@libsql/client` first**

It sits under every read and write, and is furthest behind relative to its release cadence. On its own branch:

```bash
npm install @libsql/client@latest && npm run build && npm test
```

Pay attention to `tests/store/write-transaction.test.ts` and `tests/store/connection-pool.test.ts`. The measurement table at `src/store/database.ts:141-161` documents a native-state leak in `drizzle-orm@0.45.2`'s libSQL `transaction()` that `withClientTransaction` exists to avoid; re-run that shape after upgrading and record whether the workaround is still needed.

- [ ] **Step 4: Upgrade dotenv, then commander, each on its own commit**

```bash
npm install dotenv@latest && npm run build && npm test
npm install commander@latest && npm run build && npm test && npm run docs:check
```

Commander governs every CLI surface, and the generated CLI reference comes from `--help` output, so `docs:check` catches a formatting change that tests would not.

- [ ] **Step 5: Schedule Zod separately**

Zod 3 → 4 is a migration, not an upgrade: error shapes and several APIs changed, and Zod types reach MCP input validation. Do not bundle it. Write the scope into `docs/dependency-review-2026-08.md` — which modules import it (`grep -rln "from 'zod'" src/`), what each uses it for, what the migration touches — and leave it for its own branch.

- [ ] **Step 6: Release 3.1.0**

Run: `npm test && npm run build && npm run lint && npm run typecheck && npm run docs:check`
Expected: all exit 0.

Set `"version": "3.1.0"` in `package.json` and add a `CHANGELOG.md` entry covering: hash-pinned skill approval with a filtered environment and run ceilings; import ceilings and streaming; atomic config writes with owner-only permissions; restricted and redacted startup diagnostics; generated README sections; and the CI matrix with CodeQL, audit, and Dependabot. State plainly under a **Breaking** heading that **existing skill packages will not run until approved once with `knowl skill approve <name>`**, and that a skill no longer inherits the parent environment.

```bash
git add package.json package-lock.json CHANGELOG.md docs/dependency-review-2026-08.md
git commit -m "chore(release): 3.1.0"
```

---

## Self-Review Notes

- **Earlier review blockers, resolved here:** Task 1 extends the existing `skillCommand` at `src/cli/program.ts:1884` rather than redeclaring it, and refuses symlinks instead of hashing across them; Task 4 imports `KNOWLEDGE_CATEGORIES` into the moved definitions module, excludes `contextTokens` from `presetProfile` so the vector fingerprint does not change, and makes `tsx` an explicit dev dependency instead of relying on it transitively; Task 5 names `no-unused-vars: 'off'` explicitly rather than assuming a preset config disables it.
- **One earlier blocker is now moot.** The concern that snapshot restore's `closeDb()` would tear down every pooled client underneath an async-scoped handle no longer applies: 3.0.0's restore uses `ATTACH` plus `withClientTransaction` and never closes the database.
- **Task 1 is a breaking change.** Every existing skill package stops running until approved once, and skills lose the parent environment. That is what a trust boundary does, but it must be in the release notes rather than discovered.
- **Task 4 depends on a large mechanical refactor** — roughly 600 lines of tool schemas moved from a closure into a module. It changes no behaviour, but it is the biggest diff here and deserves its own commit and its own review pass, separate from the generator.
- **Task 6 asserts nothing about vulnerabilities.** `npm audit` had not been run when this plan was written. Step 1 establishes the position before any upgrade is justified by it.
- **Still not covered anywhere:** fuzzing imports, skill manifests, transcript locators and MCP arguments; multi-process database contention tests; restore and upgrade tests across every retained schema version; and separating a Cloud viewer/API from the local one. Those need their own plan once the Cloud data path exists.
