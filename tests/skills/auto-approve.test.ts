import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createSkillPackage, runSkillPackage } from '../../src/skills/registry.js';
import { isAutoApproveSkills } from '../../src/skills/trust.js';
import { DEFAULT_CONFIG, saveConfig } from '../../src/core/config.js';
import type { ProjectConfig } from '../../src/core/types.js';

const CLI = path.resolve('./dist/index.js');

describe('running a skill without knowl skill approve', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'knowl-autoapprove-'));
    await fs.mkdir(path.join(root, '.knowl'), { recursive: true });
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  });

  const make = (name: string, capabilities?: string[]) => createSkillPackage(root, {
    name,
    purpose: 'probe',
    files: [{ path: 'run.js', content: "console.log('auto-ran')" }],
    entrypoints: { default: { type: 'script', path: 'run.js', autoRun: true } },
    requires: capabilities ? { capabilities } : undefined,
  } as any);

  it('is on when the key is unset or true, off only for the literal false', () => {
    expect(isAutoApproveSkills(undefined)).toBe(true);
    expect(isAutoApproveSkills(null)).toBe(true);
    expect(isAutoApproveSkills({ ...DEFAULT_CONFIG } as ProjectConfig)).toBe(true);
    expect(isAutoApproveSkills({ ...DEFAULT_CONFIG, trust: { autoApproveSkills: true } })).toBe(true);
    expect(isAutoApproveSkills({ ...DEFAULT_CONFIG, trust: { autoApproveSkills: false } })).toBe(false);
  });

  it('runs a never-approved skill by default, whoever made it and whatever it declares', async () => {
    await saveConfig(root, { ...DEFAULT_CONFIG });
    await make('plain');
    await make('net', ['network']);
    for (const name of ['plain', 'net']) {
      const result = await runSkillPackage(root, name);
      expect(result.exitCode, name).toBe(0);
      expect(result.stdout).toContain('auto-ran');
    }
  });

  it('keeps running a skill after its files change, since nothing pins the bytes', async () => {
    await saveConfig(root, { ...DEFAULT_CONFIG });
    await make('mutable');
    await fs.writeFile(path.join(root, '.knowl', 'skills', 'mutable', 'run.js'), "console.log('second')", 'utf-8');
    expect((await runSkillPackage(root, 'mutable')).stdout).toContain('second');
  });

  it('refuses an unapproved skill again when the key is false', async () => {
    await saveConfig(root, { ...DEFAULT_CONFIG, trust: { autoApproveSkills: false } });
    await make('gated');
    await expect(runSkillPackage(root, 'gated')).rejects.toThrow(/knowl skill approve gated/);
  });

  it('runs a created skill straight from the built CLI, and the config command turns the gate back on', () => {
    const run = (args: string[]) => spawnSync(process.execPath, [CLI, ...args], { cwd: root, encoding: 'utf-8' });
    expect(run(['init', '--yes']).status).toBe(0);
    const created = run(['skill', 'create', 'hello', '--purpose', 'say hi', '--file', "hi.js=console.log('cli-auto-ok');\n", '--script', 'hi.js']);
    expect(created.status, created.stderr).toBe(0);
    const ran = run(['skill', 'run', 'hello']);
    expect(ran.status, ran.stderr).toBe(0);
    expect(ran.stdout).toContain('cli-auto-ok');

    expect(run(['config', 'set', 'trust.autoApproveSkills', 'false']).status).toBe(0);
    const refused = run(['skill', 'run', 'hello']);
    expect(refused.status).not.toBe(0);
    expect(refused.stderr).toMatch(/knowl skill approve hello/);
  }, 120_000);
});
