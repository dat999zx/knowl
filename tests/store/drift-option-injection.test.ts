import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GIT_IDENTITY_FLAGS } from '../git-identity.js';
import { listChangedFilesSince, listRenamedPathsSince } from '../../src/store/drift.js';

const ROOT = path.resolve('.knowl-drift-injection-test');
const git = (args: string) => execSync(`git ${GIT_IDENTITY_FLAGS} ${args}`, { cwd: ROOT, encoding: 'utf-8' });

/**
 * The revision range is an operand, and git must be told so.
 *
 * `listChangedFilesSince` and `listRenamedPathsSince` interpolate a caller-supplied commit into
 * an argv OPTION position. The caller is not always the engine: `knowl_drift` exposes `since` as
 * an MCP tool argument whose schema accepts any string up to 200 characters, so a prompt-injected
 * agent chooses it. `spawnSync` runs without a shell, so this was never command injection -- it
 * was git-option injection, which is enough: `git diff --output=<path>` exits 0 and writes the
 * diff over the named file.
 *
 * The separator has to be `--end-of-options`, not `--`. To `git diff` a bare `--` means "pathspecs
 * follow", which would quietly demote the range to a path and make every drift check return
 * nothing -- a silent correctness regression wearing the shape of a security fix. The last test
 * here is what tells those two apart.
 */
describe('a caller-chosen revision cannot reach git as an option', () => {
  let base = '';

  beforeAll(async () => {
    await fs.rm(ROOT, { recursive: true, force: true }).catch(() => {});
    await fs.mkdir(path.join(ROOT, 'src'), { recursive: true });
    git('init');
    await fs.writeFile(path.join(ROOT, 'src/a.ts'), 'export const a = 1;\n');
    git('add -A');
    git('commit -m "base"');
    base = git('rev-parse HEAD').trim();

    await fs.writeFile(path.join(ROOT, 'src/a.ts'), 'export const a = 2;\n');
    git('add -A');
    git('commit -m "change"');
  });

  afterAll(async () => {
    await fs.rm(ROOT, { recursive: true, force: true }).catch(() => {});
  });

  it('does not let --output write a file of the caller\'s choosing', () => {
    const target = path.join(ROOT, 'pwned.txt');
    // Exactly the shape a prompt-injected agent would pass to knowl_drift's `since`.
    const hostile = `--output=${target}`;

    // Whether it throws or returns nothing is not the contract; not writing the file is.
    try { listChangedFilesSince(ROOT, hostile, null); } catch { /* a rejected revision is fine */ }
    try { listRenamedPathsSince(ROOT, hostile, null); } catch { /* likewise */ }

    expect(existsSync(target)).toBe(false);
  });

  it('refuses the hostile value rather than silently succeeding', () => {
    // git should fail to resolve it AS A REVISION, which is the state we want to be in: the
    // argument was parsed as an operand and found not to name a commit.
    expect(() => listChangedFilesSince(ROOT, '--output=x.txt', null)).toThrow();
  });

  it('still reports a real range, so the separator did not demote it to a pathspec', () => {
    // The regression guard for using `--` here instead of `--end-of-options`: with `--`, git
    // reads the range as a path, matches nothing, and this comes back empty while every other
    // test above still passes.
    expect(listChangedFilesSince(ROOT, base, 'HEAD')).toEqual(['src/a.ts']);
  });
});
