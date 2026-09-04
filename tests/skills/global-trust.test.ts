import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { globalSkillsRoot } from '../../src/skills/paths.js';
import {
  approveSkill,
  assertBindingNotSelfApproved,
  assertSkillApproved,
  requiresStrongerApproval,
} from '../../src/skills/trust.js';

const HOME = path.join(os.tmpdir(), 'knowl-gt-home');
const PROJECT = path.join(os.tmpdir(), 'knowl-gt-project');

const writeSkill = async (root: string, name: string, purpose: string, capabilities: string[] = []) => {
  const dir = path.join(root, name);
  await fs.mkdir(dir, { recursive: true });
  const caps = capabilities.length > 0 ? `requires:\n  capabilities: [${capabilities.join(', ')}]\n` : '';
  await fs.writeFile(
    path.join(dir, 'skill.yaml'),
    `name: ${name}\npurpose: ${purpose}\nversion: 1\n${caps}entrypoints:\n  default:\n    type: shell\n    command: echo ok\n`,
    'utf8',
  );
};

const addCapability = async (name: string, cap: string) => {
  const skillPath = path.join(globalSkillsRoot(), name, 'skill.yaml');
  const current = await fs.readFile(skillPath, 'utf8');
  const updated = current.includes('capabilities:')
    ? current.replace(/capabilities:\s*\[(.*?)\]/, `capabilities: [$1, ${cap}]`)
    : current + `requires:\n  capabilities: [${cap}]\n`;
  await fs.writeFile(skillPath, updated, 'utf8');
};

describe('global skill trust and capabilities', () => {
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

  it('invalidates approval when a capability is added', async () => {
    await writeSkill(globalSkillsRoot(), 'release', 'cut a release', ['process']);
    await approveSkill(globalSkillsRoot(), 'release', ['default']);
    await expect(assertSkillApproved(globalSkillsRoot(), 'release', 'default')).resolves.toBeUndefined();

    await addCapability('release', 'publish'); // rewrites skill.yaml
    await expect(assertSkillApproved(globalSkillsRoot(), 'release', 'default')).rejects.toThrow(/changed since it was approved/);
  });

  it('names the capabilities that need a second confirmation', () => {
    expect(requiresStrongerApproval(['process'])).toEqual([]);
    expect(requiresStrongerApproval(['process', 'publish', 'network'])).toEqual(['network', 'publish']);
  });

  it('refuses a repository that ships both a global skill and its binding', async () => {
    await writeSkill(path.join(PROJECT, '.knowl', 'skills'), 'release', 'local copy');
    await fs.writeFile(
      path.join(PROJECT, '.knowl', 'config.json'),
      JSON.stringify({ skills: { release: { inputs: {} } } }, null, 2),
      'utf8',
    );
    await expect(assertBindingNotSelfApproved(PROJECT, 'release')).rejects.toThrow(/ships/i);
  });
});
