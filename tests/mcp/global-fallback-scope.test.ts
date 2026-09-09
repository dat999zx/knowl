import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { shouldServeGlobalOnly } from '../../src/mcp/server.js';
import { ProjectNotFoundError } from '../../src/core/errors.js';

/**
 * When `serve` may answer from the global store, and when it must refuse.
 *
 * The layer is for a session with **no project**: a Hermes Desktop window with no folder open, or
 * `knowl` run outside a repository. It is not a safety net for a project that exists and cannot
 * be opened.
 *
 * The distinction is easy to lose because one `try` resolves the root *and* loads the config, so
 * "there is no project here" and "this project's config is broken" arrive at a single `catch`.
 * Treating them alike makes a repository with a malformed config serve someone's machine-wide
 * preferences while looking healthy, and its own memory read as empty -- the silent wrong scope
 * this layer exists to prevent.
 */

describe('the rule for answering from global', () => {
  it('answers from global only when there was no project to find', () => {
    expect(shouldServeGlobalOnly(new ProjectNotFoundError('/nowhere'), true)).toBe(true);
  });

  it('refuses when the project exists and something else failed', () => {
    // A malformed config, a permissions error, a corrupt store: all reach the same catch, and
    // none of them mean "this directory has no project".
    expect(shouldServeGlobalOnly(new SyntaxError('Unexpected token } in JSON'), true)).toBe(false);
    expect(shouldServeGlobalOnly(new Error('EACCES: permission denied'), true)).toBe(false);
  });

  it('refuses when there is no global store to answer from', () => {
    expect(shouldServeGlobalOnly(new ProjectNotFoundError('/nowhere'), false)).toBe(false);
  });
});

const CLI = path.resolve('./dist/index.js');
let counter = 0;

const run = (cwd: string, home: string, args: string[]): Promise<{ stdout: string; stderr: string; code: number }> =>
  promisify(execFile)(process.execPath, [CLI, ...args], { cwd, env: { ...process.env, KNOWL_HOME: home } })
    .then(result => ({ ...result, code: 0 }))
    // The exit code is the assertion for a broken store, not just the text: the defect this
    // guards emitted a well-formed atom on stdout and exited 0, so a stdout-only test passes
    // against it.
    .catch((error: any) => ({ stdout: error.stdout ?? '', stderr: error.stderr ?? '', code: error.code ?? 1 }));

describe('a directory with no project', () => {
  let HOME = '';
  let NOWHERE = '';

  beforeEach(async () => {
    const id = `gfs-${counter++}`;
    HOME = path.join(os.tmpdir(), `knowl-${id}-home`);
    NOWHERE = path.join(os.tmpdir(), `knowl-${id}-nowhere`);
    for (const dir of [HOME, NOWHERE]) {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
      await fs.mkdir(dir, { recursive: true });
    }
    await run(NOWHERE, HOME, ['init', '--global', '-y']);
    await run(NOWHERE, HOME, [
      'store', 'I always prefer pnpm over npm on this machine',
      '--title', 'Package manager preference', '--category', 'constraint', '--namespace', 'global',
    ]);
  });

  afterEach(async () => {
    for (const dir of [HOME, NOWHERE]) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  it('reads the personal-defaults layer, with no project anywhere above it', async () => {
    const { stdout } = await run(NOWHERE, HOME, ['query', 'package manager preference', '--limit', '3']);
    expect(stdout).toContain('Package manager preference');
  });
});

/**
 * The other half of the same rule, on the CLI's own query path.
 *
 * `knowl query` had its own untyped `catch` around `findProjectRoot` *and* `initDb` *and* the
 * project-row lookup, gated on nothing but "a global store exists". So a project whose store
 * would not open was answered from the machine-wide personal defaults: `status` and `list` exited
 * 1 with the real `SQLITE_NOTADB`, while `query` printed a cross-project atom under this
 * repository's name and exited 0.
 *
 * Driven through the built CLI rather than the predicate, because the predicate has never been
 * the part that was wrong -- it was already correct in two other modules while this call site
 * did not use it. Assert the exit code and the *absence* of the global atom, not just an error
 * string: the failing shape here is a success, not a different message.
 */
describe('a project whose store will not open', () => {
  let HOME = '';
  let PROJECT = '';

  beforeEach(async () => {
    const id = `gfs-broken-${counter++}`;
    HOME = path.join(os.tmpdir(), `knowl-${id}-home`);
    PROJECT = path.join(os.tmpdir(), `knowl-${id}-project`);
    for (const dir of [HOME, PROJECT]) {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
      await fs.mkdir(dir, { recursive: true });
    }
    // A global store, so the fallback is genuinely available -- otherwise the command would
    // refuse for the wrong reason and the test would pass without the guard.
    await run(PROJECT, HOME, ['init', '--global', '-y']);
    await run(PROJECT, HOME, [
      'store', 'I always prefer pnpm over npm on this machine',
      '--title', 'Package manager preference', '--category', 'constraint', '--namespace', 'global',
    ]);
    await run(PROJECT, HOME, ['init', '-y']);
    // Present but unopenable. Overwritten rather than deleted: a missing file is caught much
    // earlier by `assertDatabasePresentForCommand`, which is a different guard entirely.
    await fs.writeFile(path.join(PROJECT, '.knowl', 'knowl.db'), 'not a database', 'utf8');
  });

  afterEach(async () => {
    for (const dir of [HOME, PROJECT]) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  it('refuses instead of answering from the machine-wide store', async () => {
    const { stdout, code } = await run(PROJECT, HOME, ['query', 'package manager preference', '--limit', '3']);
    expect(stdout).not.toContain('Package manager preference');
    expect(code).not.toBe(0);
  });

  it('fails the way its sibling commands already failed', async () => {
    const query = await run(PROJECT, HOME, ['query', 'package manager preference']);
    const status = await run(PROJECT, HOME, ['status']);
    expect(status.code).not.toBe(0);
    expect(query.code).toBe(status.code);
  });
});
