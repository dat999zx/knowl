import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listKnownRepos, recordKnownRepo, repoRegistryPath } from '../../src/cli/repo-registry.js';

const HOME = path.resolve('./.knowl-registry-home');
const A = path.resolve('./.knowl-registry-a');
const B = path.resolve('./.knowl-registry-b');

async function makeRepo(root: string): Promise<void> {
  await fs.mkdir(path.join(root, '.knowl'), { recursive: true });
}

describe('known repo registry', () => {
  beforeEach(async () => {
    process.env.KNOWL_HOME = HOME;
    for (const dir of [HOME, A, B]) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    await makeRepo(A);
    await makeRepo(B);
  });

  afterEach(async () => {
    delete process.env.KNOWL_HOME;
    for (const dir of [HOME, A, B]) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  it('starts empty rather than failing when nothing has been recorded', async () => {
    expect(await listKnownRepos()).toEqual([]);
  });

  it('records a repo once however many times it is upgraded', async () => {
    await recordKnownRepo(A);
    await recordKnownRepo(A);
    await recordKnownRepo(B);

    expect(await listKnownRepos()).toEqual([A, B].sort());
  });

  it('forgets a repo whose .knowl directory is gone', async () => {
    // A registry that keeps naming deleted checkouts turns every sweep into a list of
    // failures the user cannot act on.
    await recordKnownRepo(A);
    await recordKnownRepo(B);
    await fs.rm(B, { recursive: true, force: true });

    expect(await listKnownRepos()).toEqual([A]);
  });

  it('survives a corrupt registry instead of blocking the command that writes it', async () => {
    // This file is machine-local convenience state. Nothing in it is worth failing an
    // upgrade over, so a truncated or hand-edited file is replaced, not reported.
    await fs.mkdir(path.dirname(repoRegistryPath()), { recursive: true });
    await fs.writeFile(repoRegistryPath(), '{ this is not json', 'utf-8');

    await recordKnownRepo(A);

    expect(await listKnownRepos()).toEqual([A]);
  });
});
