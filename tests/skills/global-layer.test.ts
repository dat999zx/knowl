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
