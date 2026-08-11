import fs from 'node:fs/promises';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GIT_IDENTITY_FLAGS } from '../git-identity.js';
import { collectSessionGitEvidence } from '../../src/store/session-evidence.js';

const ROOT = path.resolve('./.knowl-session-evidence-test');

// Identity on every invocation, never `git config` -- see `tests/git-identity.ts`.
const git = (args: string) => execSync(`git ${GIT_IDENTITY_FLAGS} ${args}`, { cwd: ROOT });

describe('session evidence', () => {
  beforeAll(async () => {
    await fs.rm(ROOT, { recursive: true, force: true }); await fs.mkdir(path.join(ROOT, 'src'), { recursive: true });
    git('init');
    await fs.writeFile(path.join(ROOT, 'src', 'app.ts'), 'export const version = 1;\n');
    await fs.writeFile(path.join(ROOT, '.env'), 'SECRET=value\n');
    git('add .'); git('commit -m base');
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
