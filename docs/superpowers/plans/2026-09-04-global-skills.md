# Global Skills Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A skill can live once on the machine as a reusable playbook, and each project supplies the commands and paths it needs — so the shared half is written once and the repo-specific half stays under that repo's review.

**Architecture:** The per-project skill system is the security model, extended rather than replaced. `SkillManifest`, `normalizeEntrypoints` (which already refuses `.bat`/`.cmd` on Windows) and `assertSkillApproved` (approved hash, allowed entrypoints, hash re-checked every run) all stay exactly as they are. This plan adds a global skill root, a manifest `requires` block declaring inputs, capabilities and preconditions, per-project bindings that fill those inputs, and a run banner that shows the fully resolved command. A playbook and a binding are two keys: neither runs anything alone.

**Tech Stack:** TypeScript (ESM, tsup), vitest, node child_process.

**Spec:** `docs/superpowers/specs/2026-09-04-global-skills-design.md`

## Global Constraints

- Governed by decision `d7bfb0ef36fe41d2`: global skills are reusable playbooks; **project bindings provide repo-specific commands and paths**. Executable ones require applicability checks, explicit capabilities, fail-closed preconditions, visible resolved commands, versioning/pinning, provenance, and stronger approval for writes, network, publishing and deletion.
- Depends on `2026-09-04-global-memory-layer.md` Task 1 for `globalStorePath()`/`knowlHome()` conventions; the skill root is `<knowlHome()>/skills/`.
- **Interpolation is `${inputs.*}` and nothing else.** No shell, no environment, no expressions. An unresolved reference is a refusal before execution, never an empty string on a command line.
- **Fail closed.** A precondition that fails, errors, or is not recognised all refuse.
- **A checkout must never approve itself.** The existing rule — auto-init refuses a repo shipping `.knowl/skill-trust.json` — extends to a repo shipping both a global skill and its binding.
- Capabilities are declarations, not a sandbox. Say so in the docs and the banner; never imply enforcement.
- Verify with `npm run build`, `npm test`, `npx eslint .`.
- Branch `feat/global-skills` off `main` (after the memory layer lands); commit after every task.

---

## File map

| File | Responsibility |
| --- | --- |
| `src/skills/paths.ts` (create) | global skill root, global trust file path |
| `src/skills/registry.ts` (modify) | layered list/read, `requires` on the manifest |
| `src/skills/bindings.ts` (create) | binding lookup and `${inputs.*}` interpolation |
| `src/skills/preconditions.ts` (create) | the named checks, fail-closed |
| `src/skills/trust.ts` (modify) | approval at the global root, capability confirmation |
| `src/skills/run-banner.ts` (create) | the resolved-command banner |
| `src/cli/program.ts` (modify) | `skill approve --global`, `skill run` banner, `skill list` layers |
| `src/core/types.ts` (modify) | `skills` bindings on `ProjectConfig` |
| `tests/skills/global-layer.test.ts` (create) | layering, shadowing, labels |
| `tests/skills/bindings.test.ts` (create) | interpolation, missing inputs, defaults |
| `tests/skills/preconditions.test.ts` (create) | each check, and unevaluable ones |
| `tests/skills/global-trust.test.ts` (create) | approval, capability changes, planted packages |

---

### Task 0: Branch

- [ ] **Step 1**

```bash
git checkout -b feat/global-skills main
```

---

### Task 1: The global skill root, and layering

**Files:**
- Create: `src/skills/paths.ts`
- Modify: `src/skills/registry.ts`
- Test: `tests/skills/global-layer.test.ts`

**Interfaces:**
- Produces: `globalSkillsRoot(): string` — `<knowlHome()>/skills`.
- Produces: `globalTrustPath(): string` — `<knowlHome()>/skill-trust.json`.
- Changes: `listSkillPackages(projectRoot)` returns `SkillSummary & { layer: 'project' | 'global' }`, with a project skill shadowing a global one of the same name.

- [ ] **Step 1: Write the failing test**

`tests/skills/global-layer.test.ts`:

```ts
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { globalSkillsRoot } from '../../src/skills/paths.js';
import { createSkillPackage, listSkillPackages, readSkillPackage } from '../../src/skills/registry.js';

const HOME = path.join(os.tmpdir(), 'knowl-gs-home');
const PROJECT = path.join(os.tmpdir(), 'knowl-gs-project');

const write = async (root: string, name: string, purpose: string) => {
  await fs.mkdir(path.join(root, name), { recursive: true });
  await fs.writeFile(path.join(root, name, 'skill.yaml'),
    `name: ${name}\npurpose: ${purpose}\nversion: 1\nentrypoints: {}\n`, 'utf8');
};

describe('global skills layer under project skills', () => {
  const saved = process.env.KNOWL_HOME;
  beforeEach(async () => {
    process.env.KNOWL_HOME = HOME;
    for (const dir of [HOME, PROJECT]) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    await fs.mkdir(path.join(PROJECT, '.knowl', 'skills'), { recursive: true });
    await fs.mkdir(globalSkillsRoot(), { recursive: true });
  });
  afterEach(async () => {
    for (const dir of [HOME, PROJECT]) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    if (saved === undefined) delete process.env.KNOWL_HOME; else process.env.KNOWL_HOME = saved;
  });

  it('lists both layers and labels each one', async () => {
    await write(globalSkillsRoot(), 'release', 'global release');
    await write(path.join(PROJECT, '.knowl', 'skills'), 'localonly', 'project only');
    const listed = await listSkillPackages(PROJECT);
    expect(listed.find(s => s.name === 'release')?.layer).toBe('global');
    expect(listed.find(s => s.name === 'localonly')?.layer).toBe('project');
  });

  it('lets a project skill shadow a global one of the same name', async () => {
    await write(globalSkillsRoot(), 'release', 'global release');
    await write(path.join(PROJECT, '.knowl', 'skills'), 'release', 'project release');
    const listed = await listSkillPackages(PROJECT);
    expect(listed.filter(s => s.name === 'release')).toHaveLength(1);
    expect(listed.find(s => s.name === 'release')?.layer).toBe('project');
    // And reading resolves to the shadowing one, so "which will run" is never a guess.
    expect((await readSkillPackage(PROJECT, 'release')).manifest.purpose).toBe('project release');
  });
});
```

- [ ] **Step 2: Run, expect failure**

Run: `npx vitest run tests/skills/global-layer.test.ts`
Expected: FAIL — `globalSkillsRoot` is not exported.

- [ ] **Step 3: Implement the paths**

`src/skills/paths.ts`:

```ts
import path from 'node:path';
import { knowlHome } from '../core/paths.js';

/** Playbooks shared across every project on this machine. */
export function globalSkillsRoot(): string {
  return path.join(knowlHome(), 'skills');
}

/**
 * Approvals for those playbooks, mirroring a project's `.knowl/skill-trust.json`.
 *
 * Separate from the project file on purpose: one approval here applies wherever the skill is
 * bound, so it is a bigger decision than approving a skill in one repository, and it must not be
 * writable by a checkout.
 */
export function globalTrustPath(): string {
  return path.join(knowlHome(), 'skill-trust.json');
}
```

- [ ] **Step 4: Layer the registry**

In `src/skills/registry.ts`, have `listSkillPackages` read the project root then the global root, tag each entry with `layer`, and drop a global entry whose name a project entry already claimed. `readSkillPackage` and `runSkillPackage` resolve project-first for the same reason. Add `layer: 'project' | 'global'` to `SkillSummary`.

- [ ] **Step 5: Run, expect pass**

Run: `npx vitest run tests/skills/global-layer.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add src/skills/paths.ts src/skills/registry.ts tests/skills/global-layer.test.ts
git commit -m "feat(skills): a global skill layer, shadowed by project skills"
```

---

### Task 2: `requires` on the manifest, and bindings

**Files:**
- Modify: `src/skills/registry.ts` (manifest type and parsing)
- Modify: `src/core/types.ts` (`ProjectConfig.skills`)
- Create: `src/skills/bindings.ts`
- Test: `tests/skills/bindings.test.ts`

**Interfaces:**
- Produces types:

```ts
export interface SkillRequires {
  capabilities?: SkillCapability[];          // 'process' | 'network' | 'write' | 'publish' | 'delete'
  inputs?: Record<string, { description?: string; default?: string }>;
  preconditions?: string[];
}
export interface SkillBinding { inputs?: Record<string, string>; version?: number }
```
- Produces: `resolveBinding(manifest, binding): { values: Record<string,string> } | { missing: string[] }`
- Produces: `interpolate(args: string[], values: Record<string,string>): string[]` — substitutes `${inputs.NAME}` only; throws on any other `${...}`.

- [ ] **Step 1: Write the failing test**

`tests/skills/bindings.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { interpolate, resolveBinding } from '../../src/skills/bindings.js';

const manifest = {
  name: 'release', purpose: 'cut a release', version: 1, entrypoints: {},
  createdAt: '', updatedAt: '',
  requires: {
    inputs: { test_command: { description: 'must pass' }, release_branch: { default: 'main' } },
  },
} as any;

describe('bindings fill a playbook in', () => {
  it('takes bound values and falls back to declared defaults', () => {
    const resolved = resolveBinding(manifest, { inputs: { test_command: 'npm test' } });
    expect('values' in resolved && resolved.values).toEqual({ test_command: 'npm test', release_branch: 'main' });
  });

  it('reports what is missing instead of running with a hole in the command', () => {
    const resolved = resolveBinding(manifest, {});
    expect('missing' in resolved && resolved.missing).toEqual(['test_command']);
  });

  it('substitutes only ${inputs.*}', () => {
    expect(interpolate(['--run', '${inputs.test_command}'], { test_command: 'npm test' }))
      .toEqual(['--run', 'npm test']);
  });

  it('refuses any other interpolation, rather than resolving it to nothing', () => {
    // The injection surface is exactly this. No environment, no expressions, no shell.
    for (const bad of ['${env.PATH}', '${process.cwd()}', '$(whoami)', '${inputs.nope}']) {
      expect(() => interpolate([bad], { test_command: 'npm test' }), bad).toThrow();
    }
  });
});
```

- [ ] **Step 2: Run, expect failure**

Run: `npx vitest run tests/skills/bindings.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`src/skills/bindings.ts`:

```ts
import type { SkillManifest } from './registry.js';

export interface SkillBinding { inputs?: Record<string, string>; version?: number }

const REFERENCE = /\$\{([^}]*)\}/g;

/**
 * The values an entrypoint will actually run with: the project's bindings, with declared defaults
 * filling the gaps.
 *
 * A missing input is reported rather than defaulted to empty. An unbound playbook is listed and
 * readable but not runnable, which is the point of sharing one: discovery without running it in a
 * repository nobody bound it to.
 */
export function resolveBinding(
  manifest: SkillManifest,
  binding: SkillBinding | undefined,
): { values: Record<string, string> } | { missing: string[] } {
  const declared = manifest.requires?.inputs ?? {};
  const values: Record<string, string> = {};
  const missing: string[] = [];
  for (const [name, spec] of Object.entries(declared)) {
    const bound = binding?.inputs?.[name];
    if (typeof bound === 'string' && bound.length > 0) values[name] = bound;
    else if (typeof spec.default === 'string') values[name] = spec.default;
    else missing.push(name);
  }
  return missing.length > 0 ? { missing } : { values };
}

/**
 * Substitute `${inputs.NAME}` and refuse everything else.
 *
 * This is the whole injection surface of a shared playbook, so it stays as small as it can be:
 * no environment, no expressions, no shell. An unknown reference throws rather than resolving to
 * an empty string, because a hole spliced into a command line is how a harmless-looking template
 * becomes a different command.
 */
export function interpolate(args: string[], values: Record<string, string>): string[] {
  return args.map(arg => arg.replace(REFERENCE, (whole, reference: string) => {
    const name = reference.startsWith('inputs.') ? reference.slice('inputs.'.length) : null;
    if (!name || !(name in values)) {
      throw new Error(
        `Skill entrypoint references ${whole}, which is not a bound input. Only \${inputs.<name>} `
        + 'is substituted, and every referenced input must be bound or have a default.',
      );
    }
    return values[name];
  }));
}
```

Add `requires?: SkillRequires` to `SkillManifest`, and `skills?: Record<string, SkillBinding>` to `ProjectConfig`.

- [ ] **Step 4: Run, expect pass**

Run: `npx vitest run tests/skills/bindings.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/skills/bindings.ts src/skills/registry.ts src/core/types.ts tests/skills/bindings.test.ts
git commit -m "feat(skills): playbook inputs, project bindings, and a one-form interpolation"
```

---

### Task 3: Preconditions, fail-closed

**Files:**
- Create: `src/skills/preconditions.ts`
- Test: `tests/skills/preconditions.test.ts`

**Interfaces:**
- Produces: `checkPreconditions(names: string[], context: { cwd: string }): Promise<{ ok: true } | { ok: false; failed: string; reason: string }>`
- Supported: `clean_worktree`, `on_branch:<name>`, `command_exists:<bin>`.

- [ ] **Step 1: Write the failing test**

`tests/skills/preconditions.test.ts`:

```ts
import os from 'node:os';
import { describe, expect, it } from 'vitest';
import { checkPreconditions } from '../../src/skills/preconditions.js';

describe('preconditions fail closed', () => {
  it('passes a check that holds', async () => {
    const node = process.platform === 'win32' ? 'node.exe' : 'node';
    expect(await checkPreconditions([`command_exists:${node}`], { cwd: process.cwd() })).toEqual({ ok: true });
  });

  it('refuses a check that does not hold, naming it', async () => {
    const result = await checkPreconditions(['command_exists:definitely-not-a-real-binary'], { cwd: process.cwd() });
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ failed: 'command_exists:definitely-not-a-real-binary' });
  });

  it('refuses a check it does not recognise, rather than ignoring it', async () => {
    // An unknown precondition is one that did not pass. Skipping it would let a typo disable a gate.
    const result = await checkPreconditions(['no_such_check'], { cwd: process.cwd() });
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ failed: 'no_such_check' });
  });

  it('refuses when a check cannot be evaluated at all', async () => {
    // Outside a git worktree there is no answer to "is it clean", and no answer is not a pass.
    const result = await checkPreconditions(['clean_worktree'], { cwd: os.tmpdir() });
    expect(result.ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run, expect failure**

Run: `npx vitest run tests/skills/preconditions.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`src/skills/preconditions.ts` — one `switch` over the three supported names using `execFile` for `git status --porcelain`, `git rev-parse --abbrev-ref HEAD` and a PATH probe. Every branch returns `{ ok: false, failed, reason }` on failure, on error, and for an unrecognised name. The module header states the rule:

```ts
/**
 * Named checks an entrypoint must pass before it runs.
 *
 * Fail-closed in all three directions, which is the whole point: a check that fails, a check that
 * errors, and a check nobody implemented are the same answer. Treating an unknown name as a pass
 * would let a typo silently disable the gate a person added deliberately.
 */
```

- [ ] **Step 4: Run, expect pass**

Run: `npx vitest run tests/skills/preconditions.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/skills/preconditions.ts tests/skills/preconditions.test.ts
git commit -m "feat(skills): fail-closed preconditions"
```

---

### Task 4: Approval at the global root, and capabilities

**Files:**
- Modify: `src/skills/trust.ts`
- Test: `tests/skills/global-trust.test.ts`

**Interfaces:**
- Changes: `approveSkill`, `readTrust`, `revokeSkill`, `assertSkillApproved` take a root that may be `globalSkillsRoot()`, writing `globalTrustPath()` in that case.
- Produces: `requiresStrongerApproval(capabilities: SkillCapability[]): SkillCapability[]` — the subset among `write`, `network`, `publish`, `delete`.

- [ ] **Step 1: Write the failing test**

`tests/skills/global-trust.test.ts` — assert that:

```ts
it('invalidates approval when a capability is added', async () => {
  // The hash covers the manifest, so declaring a new intent needs a new approval. This is the
  // decision's "stronger approval rules" made mechanical rather than advisory.
  await approveSkill(globalSkillsRoot(), 'release', ['default']);
  await expect(assertSkillApproved(globalSkillsRoot(), 'release', 'default')).resolves.toBeUndefined();

  await addCapability('release', 'publish');           // rewrites skill.yaml
  await expect(assertSkillApproved(globalSkillsRoot(), 'release', 'default')).rejects.toThrow(/changed since it was approved/);
});

it('names the capabilities that need a second confirmation', () => {
  expect(requiresStrongerApproval(['process'])).toEqual([]);
  expect(requiresStrongerApproval(['process', 'publish', 'network'])).toEqual(['network', 'publish']);
});

it('refuses a repository that ships both a global skill and its binding', async () => {
  // A checkout must never be able to approve itself -- the rule auto-init already applies to
  // `.knowl/skill-trust.json`, arriving through a different door.
  await expect(assertBindingNotSelfApproved(PROJECT, 'release')).rejects.toThrow(/ships/i);
});
```

- [ ] **Step 2: Run, expect failure**

Run: `npx vitest run tests/skills/global-trust.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

Thread the root through `trust.ts` (it already takes `projectRoot`; make the trust-file location a function of it, `globalTrustPath()` when the root is the global skills root). Add `requiresStrongerApproval`, and `assertBindingNotSelfApproved`, which refuses when a repository contains both `.knowl/skills/<name>` and a `skills.<name>` binding for a *global* skill of that name.

- [ ] **Step 4: Run, expect pass; then commit**

```bash
npx vitest run tests/skills/global-trust.test.ts
git add src/skills/trust.ts tests/skills/global-trust.test.ts
git commit -m "feat(skills): approve global playbooks, per capability"
```

---

### Task 5: The run banner, and wiring the gate

**Files:**
- Create: `src/skills/run-banner.ts`
- Modify: `src/skills/registry.ts` (`runSkillPackage`), `src/cli/program.ts`
- Test: `tests/skills/global-layer.test.ts` (extend)

**Interfaces:**
- Produces: `formatRunBanner(input: { name, layer, version, approvedAt, command, cwd, capabilities, preconditions })` → string.
- `runSkillPackage` order: resolve layer → load binding → `resolveBinding` (refuse on missing) → `interpolate` → `assertSkillApproved` → `checkPreconditions` (refuse on failure) → print banner → execute.

- [ ] **Step 1: Write the failing test**

```ts
it('shows the fully resolved command before running it', () => {
  const banner = formatRunBanner({
    name: 'release', layer: 'global', version: 3, approvedAt: '2026-09-01',
    command: 'bash ~/.knowl/skills/release/release.sh "npm test" "main"',
    cwd: 'D:/coding/knowl', capabilities: ['process', 'publish'], preconditions: ['clean_worktree'],
  });
  expect(banner).toContain('npm test');          // substituted, not the template
  expect(banner).not.toContain('${inputs.');
  expect(banner).toContain('publish');           // what it intends to do
  expect(banner).toContain('global');            // which layer will run
});
```

- [ ] **Step 2–4: Implement, run, commit**

The banner prints on every run, not only the first: the person running a shared playbook did not write it. Its header comment says capabilities are declarations rather than a sandbox, and the docs repeat it.

```bash
git add src/skills/run-banner.ts src/skills/registry.ts src/cli/program.ts tests/skills/
git commit -m "feat(skills): show the resolved command, capabilities and checks before running"
```

---

### Task 6: Pinning and provenance

**Files:**
- Modify: `src/skills/registry.ts`, `src/skills/bindings.ts`
- Test: `tests/skills/bindings.test.ts` (extend)

- [ ] **Step 1: Test**

```ts
it('refuses a pinned binding when the playbook has moved on, naming both versions', () => {
  expect(() => assertPinned({ ...manifest, version: 4 }, { version: 3 }))
    .toThrow(/pinned to 3.*now 4/i);
  expect(() => assertPinned({ ...manifest, version: 3 }, { version: 3 })).not.toThrow();
  expect(() => assertPinned({ ...manifest, version: 4 }, {})).not.toThrow();   // unpinned: fine
});
```

- [ ] **Steps 2–4:** implement `assertPinned`; add `provenance` (authored locally, or imported with its source) to the manifest and show it in `knowl skill read`; run; commit.

---

### Task 7: Documentation

- [ ] Reference: the two layers and shadowing; `requires` (inputs, capabilities, preconditions); bindings in project config; `${inputs.*}` and nothing else; approval at both roots; the banner; pinning.
- [ ] State plainly, twice, that **capabilities are declarations and not a sandbox**.
- [ ] Changelog entry.
- [ ] `npm run docs:check`, then commit.

---

### Task 8: Full verification

- [ ] `npm run build`, `npm test`, `npx eslint .`, `npm run docs:check`
- [ ] Manual: create a global playbook with one input and a `clean_worktree` precondition; run it unbound (refused, names the input); bind it in a project; approve it; run with a dirty worktree (refused, names the check); commit and run (banner shows the resolved command); edit the playbook and confirm approval is invalidated.
- [ ] Open the PR.
