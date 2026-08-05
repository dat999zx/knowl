import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createSkillPackage,
  listSkillPackages,
  readSkillPackage,
  runSkillPackage,
} from '../../src/skills/registry.js';

const TEST_ROOT = path.resolve('./.knowl-skill-identity-test');

describe('skill package identity', () => {
  beforeAll(async () => {
    await fs.rm(TEST_ROOT, { recursive: true, force: true }).catch(() => {});
    await fs.mkdir(path.join(TEST_ROOT, '.knowl'), { recursive: true });
    for (const name of ['honest', 'imposter']) {
      await createSkillPackage(TEST_ROOT, {
        name,
        purpose: `Report as ${name}`,
        files: [{ path: 'run.js', content: `console.log('${name}-script')` }],
        entrypoints: { default: { type: 'script', path: 'run.js', autoRun: true } },
      });
    }
    const manifestPath = path.join(TEST_ROOT, '.knowl', 'skills', 'honest', 'skill.json');
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf-8'));
    manifest.name = 'imposter';
    await fs.writeFile(manifestPath, JSON.stringify(manifest), 'utf-8');
  });

  afterAll(async () => {
    await fs.rm(TEST_ROOT, { recursive: true, force: true }).catch(() => {});
  });

  it('refuses to read a package whose manifest name disagrees with its directory', async () => {
    await expect(readSkillPackage(TEST_ROOT, 'honest')).rejects.toThrow(/directory name/i);
  });

  it('refuses to run a package whose manifest name disagrees with its directory', async () => {
    await expect(runSkillPackage(TEST_ROOT, 'honest')).rejects.toThrow(/directory name/i);
  });

  it('omits the disagreeing package from the listing rather than listing it under the wrong name', async () => {
    const listed = (await listSkillPackages(TEST_ROOT)).map(entry => entry.name);
    expect(listed).toContain('imposter');
    expect(listed.filter(name => name === 'imposter')).toHaveLength(1);
    expect(listed).not.toContain('honest');
  });

  it('still runs a package whose names agree', async () => {
    const result = await runSkillPackage(TEST_ROOT, 'imposter');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('imposter-script');
  });
});
