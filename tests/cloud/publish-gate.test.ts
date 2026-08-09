import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkPublishGate, currentBranchOf } from '../../src/cloud/publish-gate.js';

const ORIGIN = path.resolve('./.knowl-gate-origin');
const CLONE = path.resolve('./.knowl-gate-clone');

const git = (cwd: string, args: string[]) => spawnSync('git', args, { cwd, encoding: 'utf8' });

async function makeOriginAndClone(): Promise<void> {
  await fs.mkdir(ORIGIN, { recursive: true });
  git(ORIGIN, ['init', '-q', '-b', 'main']);
  git(ORIGIN, ['config', 'user.email', 'test@example.com']);
  git(ORIGIN, ['config', 'user.name', 'Test']);
  await fs.writeFile(path.join(ORIGIN, 'a.txt'), 'one', 'utf8');
  git(ORIGIN, ['add', '.']);
  git(ORIGIN, ['commit', '-qm', 'one']);
  git(process.cwd(), ['clone', '-q', ORIGIN, CLONE]);
  git(CLONE, ['config', 'user.email', 'test@example.com']);
  git(CLONE, ['config', 'user.name', 'Test']);
}

describe('checkPublishGate', () => {
  beforeEach(async () => {
    for (const dir of [ORIGIN, CLONE]) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    await makeOriginAndClone();
  });
  afterEach(async () => {
    for (const dir of [ORIGIN, CLONE]) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  it('passes on an up-to-date default branch', async () => {
    expect(checkPublishGate(CLONE)).toEqual({ ok: true });
  });

  it('refuses on a feature branch, because that code is nobody else\'s yet', async () => {
    // The scenario the gate exists for: an atom describing code only this branch has would be
    // false for every colleague on main, and there is no unpublish.
    git(CLONE, ['checkout', '-qb', 'feature/rollback']);

    const verdict = checkPublishGate(CLONE);
    expect(verdict).toMatchObject({ ok: false, reason: 'not-default-branch' });
    expect((verdict as { detail: string }).detail).toContain('feature/rollback');
  });

  it('refuses when the checkout is behind its remote', async () => {
    // Being behind main is indistinguishable from the code having been deleted. Publishing or
    // reporting drift from here would retire knowledge that is still correct for everyone
    // current -- the same collapse `fileContentHash` produced when every read error meant
    // "gone".
    await fs.writeFile(path.join(ORIGIN, 'b.txt'), 'two', 'utf8');
    git(ORIGIN, ['add', '.']);
    git(ORIGIN, ['commit', '-qm', 'two']);
    git(CLONE, ['fetch', '-q']);

    const verdict = checkPublishGate(CLONE);
    expect(verdict).toMatchObject({ ok: false, reason: 'behind-remote' });
  });

  it('passes again once the checkout catches up', async () => {
    await fs.writeFile(path.join(ORIGIN, 'b.txt'), 'two', 'utf8');
    git(ORIGIN, ['add', '.']);
    git(ORIGIN, ['commit', '-qm', 'two']);
    git(CLONE, ['pull', '-q']);

    expect(checkPublishGate(CLONE)).toEqual({ ok: true });
  });

  it('reports git being unavailable as its own reason, not as a branch problem', async () => {
    // The misdiagnosis this repo has already shipped twice: "could not determine" reported as
    // a confident wrong answer.
    const verdict = checkPublishGate(path.resolve('./.knowl-gate-not-a-repo'));
    expect(verdict).toMatchObject({ ok: false, reason: 'git-unavailable' });
  });

  it('reads the current branch', async () => {
    expect(currentBranchOf(CLONE)).toBe('main');
  });
});
