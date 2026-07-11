import fs from 'node:fs/promises';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { collectSessionGitEvidence } from '../../src/store/session-evidence.js';

const ROOT = path.resolve('./.knowl-session-evidence-test');

describe('session evidence', () => {
  beforeAll(async () => {
    await fs.rm(ROOT, { recursive: true, force: true }); await fs.mkdir(path.join(ROOT, 'src'), { recursive: true });
    execSync('git init', { cwd: ROOT }); execSync('git config user.email test@example.test', { cwd: ROOT }); execSync('git config user.name Test', { cwd: ROOT });
    await fs.writeFile(path.join(ROOT, 'src', 'app.ts'), 'export const version = 1;\n');
    await fs.writeFile(path.join(ROOT, '.env'), 'SECRET=value\n');
    execSync('git add .', { cwd: ROOT }); execSync('git commit -m base', { cwd: ROOT });
    await fs.writeFile(path.join(ROOT, 'src', 'app.ts'), 'export const version = 2;\n');
    await fs.writeFile(path.join(ROOT, '.env'), 'SECRET=changed\n');
    await fs.writeFile(path.join(ROOT, 'src', 'asset.bin'), Buffer.from([0, 1, 2]));
  });
  afterAll(async () => { await fs.rm(ROOT, { recursive: true, force: true }).catch(() => {}); });

  it('collects bounded git metadata and excludes sensitive or binary paths', async () => {
    const baselineCommit = execSync('git rev-parse HEAD', { cwd: ROOT, encoding: 'utf-8' }).trim();
    const evidence = await collectSessionGitEvidence(ROOT, baselineCommit);
    expect(evidence.changedPaths).toEqual(['src/app.ts']);
    expect(evidence.currentCommit).toMatch(/^[a-f0-9]{40}$/);
    expect(evidence.fileEvidence).toEqual([expect.objectContaining({ type: 'file', locator: 'src/app.ts', contentHash: expect.any(String) })]);
    expect(evidence.diffStat).toContain('src/app.ts');
  });
});
