import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, getClient, withDbPath } from '../../src/store/database.js';
import { releaseAll } from '../../src/store/connection-pool.js';
import { globalStorePath } from '../../src/core/paths.js';

const CLI = path.resolve('./dist/index.js');
let testCount = 0;

/**
 * `--local` has to mean the same thing in the global namespace as it does in a project.
 *
 * The project branch of `knowl store` pairs `excludeFromPublish` with `unstagePublish` after the
 * write. The global branch printed the same "Marked local. It will not be published." line and
 * did neither, so the promise was made by the message alone.
 *
 * It matters because the global namespace is not exempt from the staging seam. `maybeAutoStage`
 * skips exactly one namespace, `session`, and the machine store can itself be cloud-connected --
 * so the atom a person marked local was queued for the team while being told it never would be.
 * A knowledge system's `--local` is the one flag that has to be true.
 *
 * End-to-end through the built CLI rather than against the function, because the defect lived in
 * the wiring of a commander action and no unit test could see it: the code that was missing was
 * missing from the branch, not from the helper it should have called.
 */
describe('knowl store --namespace global --local', () => {
  const saved = process.env.KNOWL_HOME;
  let HOME = '';
  let WORK = '';

  const run = (args: string[]) =>
    promisify(execFile)(process.execPath, [CLI, ...args], {
      cwd: WORK,
      env: { ...process.env, KNOWL_HOME: HOME },
    }).catch((error: any) => ({ stdout: error.stdout ?? '', stderr: error.stderr ?? '' }));

  beforeEach(async () => {
    const id = testCount++;
    HOME = path.join(os.tmpdir(), `knowl-globallocal-home-${id}`);
    WORK = path.join(os.tmpdir(), `knowl-globallocal-work-${id}`);
    process.env.KNOWL_HOME = HOME;
    await closeDb().catch(() => {});
    await releaseAll().catch(() => {});
    for (const d of [HOME, WORK]) await fs.rm(d, { recursive: true, force: true }).catch(() => {});
    await fs.mkdir(WORK, { recursive: true });
    await run(['init', '--global', '-y']);
  });

  afterEach(async () => {
    if (saved === undefined) delete process.env.KNOWL_HOME;
    else process.env.KNOWL_HOME = saved;
    await closeDb().catch(() => {});
    await releaseAll().catch(() => {});
    for (const d of [HOME, WORK]) await fs.rm(d, { recursive: true, force: true }).catch(() => {});
  });

  /** Ids the global store has been told never to publish. */
  const excludedIds = async (): Promise<string[]> =>
    withDbPath(globalStorePath(), async () => {
      const rows = (await getClient().execute('SELECT item_id FROM cloud_excluded')).rows;
      return rows.map(row => String(row.item_id));
    });

  const storedId = (stdout: string): string => {
    const match = /Stored \w+ ([0-9a-f]+):/.exec(stdout);
    if (!match) throw new Error(`no id in CLI output: ${stdout}`);
    return match[1];
  };

  it('records the exclusion it prints, in the store that holds the atom', async () => {
    const { stdout } = await run([
      'store', 'A machine-wide note that must never reach the team.',
      '--category', 'fact', '--title', 'local global probe',
      '--namespace', 'global', '--local',
    ]);

    expect(stdout).toContain('Marked local');
    expect(await excludedIds()).toContain(storedId(stdout));
  });

  it('excludes nothing when --local is absent, so the flag is what does it', async () => {
    // The other half of the claim: without this, an exclusion applied unconditionally would pass
    // the test above while quietly making every global write local.
    const { stdout } = await run([
      'store', 'A machine-wide note that may be shared.',
      '--category', 'fact', '--title', 'shared global probe',
      '--namespace', 'global',
    ]);

    expect(await excludedIds()).not.toContain(storedId(stdout));
  });
});
