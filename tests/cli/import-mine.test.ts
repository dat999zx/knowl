import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createClient } from '@libsql/client';
import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * `--mine` has to be exercised through the real CLI, not just the store function.
 *
 * The flag exists only as a person's deliberate assertion, so the thing worth proving is that
 * the assertion actually arrives: an option declared on the command but never threaded into
 * `importKnowledge` would pass every unit test in the store and do nothing at all in the hands
 * of the person it was built for.
 */

const CLI = path.resolve('./dist/index.js');
const TITLE = 'Deploys are blue-green';

/**
 * A fresh directory set per test.
 *
 * Windows keeps a handle on a closed SQLite file long enough that a `rm` in `beforeEach`
 * routinely fails and is swallowed, and the next `knowl init` then lands in a half-deleted
 * directory -- which surfaced here as an ENOENT on the config file it had just written.
 * Never reusing a path is what the suites that spawn databases already do.
 */
let index = 0;
let A = '';
let B = '';
let HOME = '';
let DUMP = '';

function knowl(cwd: string, args: string[]): string {
  return execFileSync(process.execPath, [CLI, ...args], {
    cwd, encoding: 'utf8', env: { ...process.env, KNOWL_HOME: HOME },
  });
}

async function ownershipIn(root: string) {
  const client = createClient({ url: `file:${path.join(root, '.knowl', 'knowl.db').split(path.sep).join('/')}` });
  const rows = await client.execute({
    sql: 'SELECT origin_repo, visibility FROM knowledge_items WHERE title = ?',
    args: [TITLE],
  });
  const row = rows.rows[0];
  return row ? { originRepo: row.origin_repo, visibility: String(row.visibility) } : null;
}

describe('knowl import --mine', () => {
  beforeEach(async () => {
    index += 1;
    A = path.resolve(`./.knowl-import-mine-a${index}`);
    B = path.resolve(`./.knowl-import-mine-b${index}`);
    HOME = path.resolve(`./.knowl-import-mine-home${index}`);
    DUMP = path.resolve(`./.knowl-import-mine${index}.jsonl`);
    for (const dir of [A, B, HOME]) await fs.mkdir(dir, { recursive: true });
    knowl(A, ['init']);
    knowl(A, ['decide', TITLE, 'Two identical fleets swap on release.']);
    knowl(A, ['export', DUMP]);
    knowl(B, ['init']);
  });

  afterEach(async () => {
    for (const dir of [A, B, HOME]) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    await fs.rm(DUMP, { force: true }).catch(() => {});
  });

  it('claims the file for this repo, where a plain import marks it imported', async () => {
    knowl(B, ['import', DUMP, '--mine']);
    // An unlinked repo owns its own writes as NULL, and a claimed import is treated as one.
    expect(await ownershipIn(B)).toEqual({ originRepo: null, visibility: 'repo' });
  });

  it('marks the same file imported without the flag, so the default is the safe one', async () => {
    knowl(B, ['import', DUMP]);
    expect(await ownershipIn(B)).toEqual({ originRepo: 'import:unknown', visibility: 'repo' });
  });

  it('reports the decision in the result, and the flag is discoverable in help', async () => {
    const output = knowl(B, ['import', DUMP, '--mine']);
    expect(JSON.parse(output).ownership).toBe('claimed');

    const help = knowl(B, ['import', '--help']);
    expect(help).toContain('--mine');
    // The person is asserting something no file can prove, so the help has to say so rather
    // than describe a switch.
    expect(help).toMatch(/prove|assert/i);
  });
});
