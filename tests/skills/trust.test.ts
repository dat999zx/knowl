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
