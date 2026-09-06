import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * An id that search hands out must resolve everywhere search can reach.
 *
 * Search is layered -- `queryLayeredKnowledge` visits every namespace. Nothing addressed BY ID
 * was, so `knowl query` would return a global atom and then every id-addressed command failed on
 * the id it had just printed: `supersede` and `reviewed` with "Knowledge item not found", and the
 * MCP `knowl_timeline` with `[]`. The reported symptom was "Knowl is bad at superseding".
 *
 * Driven through the built CLI as a subprocess rather than in-process, deliberately. Two earlier
 * in-process attempts at this test PASSED against the unfixed code: the seeded atom landed in the
 * project store instead of the global one, so they only ever asserted that a project-resident item
 * is readable -- which was never in doubt. A subprocess gets the real `KNOWL_HOME` resolution, the
 * real config load and the real store selection, and `global.db` is asserted directly with the CLI
 * rather than taken on trust from a helper that might be writing somewhere else entirely.
 *
 * `store --namespace global` is the seeding path BECAUSE it is the one production uses; a
 * hand-rolled `withDbPath` write is what produced the false green the first time.
 */

const CLI = path.resolve('./dist/index.js');
const HOME = path.join(os.tmpdir(), `knowl-nsid-home-${process.pid}`);
const ROOT = path.join(os.tmpdir(), `knowl-nsid-proj-${process.pid}`);

function knowl(args: string[]): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, KNOWL_HOME: HOME },
  });
  return { status: result.status ?? -1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

/** The id the CLI printed, which is the only handle a caller ever has. */
function storedId(output: string): string {
  const match = /Stored \w+ ([0-9a-f]{16})/.exec(output);
  if (!match) throw new Error(`no id in: ${output}`);
  return match[1];
}

describe('an id that lives in the global namespace', () => {
  let globalId = '';
  let projectId = '';

  beforeAll(() => {
    knowl(['--version']); // resolves the CLI before anything depends on its output
  });

  beforeAll(async () => {
    await fs.mkdir(HOME, { recursive: true });
    await fs.mkdir(ROOT, { recursive: true });
    const init = knowl(['init', '--yes']);
    expect(init.status, init.stderr).toBe(0);

    const seeded = knowl(['store', 'a machine-wide default', '--category', 'state', '--title', 'stale global fact', '--namespace', 'global']);
    expect(seeded.status, seeded.stderr).toBe(0);
    // The premise of every assertion below. If this text ever stops appearing, the atom is
    // landing in the project store and the rest of this file is testing nothing.
    expect(seeded.stdout).toContain('Stored in the global namespace');
    globalId = storedId(seeded.stdout);

    const replacement = knowl(['store', 'the correction', '--category', 'fact', '--title', 'a project fact']);
    expect(replacement.status, replacement.stderr).toBe(0);
    projectId = storedId(replacement.stdout);
    expect(projectId).not.toBe(globalId);
  });

  afterAll(async () => {
    // Left in place on Windows: libSQL holds the -shm/-wal sidecars, so a failing rm here would
    // be swallowed and report a clean teardown that did not happen.
    await fs.rm(ROOT, { recursive: true, force: true }).catch(() => {});
    await fs.rm(HOME, { recursive: true, force: true }).catch(() => {});
  });

  it('is found by a search that reaches the global store', () => {
    const found = knowl(['query', 'stale global fact']);
    expect(found.status, found.stderr).toBe(0);
    expect(found.stdout).toContain(globalId);
  });

  it('can be reviewed by that id from a project checkout', () => {
    const reviewed = knowl(['reviewed', globalId]);
    expect(reviewed.status, reviewed.stderr).toBe(0);
    expect(reviewed.stdout).toContain('stale global fact');
  });

  it('can be retired by that id, and the retirement lands in the global store', () => {
    const retired = knowl(['supersede', globalId, projectId]);
    expect(retired.status, retired.stderr).toBe(0);
    expect(retired.stdout).toContain('"status": "superseded"');
    expect(retired.stdout).toContain(`"supersededById": "${projectId}"`);

    // Asserted against the store rather than the command's own report: writing to the project
    // database while reporting success is the exact half-fix this replaced, and a test that
    // reads only stdout cannot tell the two apart. `query` has no --id, so the retired atom is
    // read back by the keyword search that reaches the global store.
    const after = knowl(['query', 'stale global fact']);
    expect(after.stdout).toContain('superseded');

    // ...and the replacement, which lives in the OTHER store, is untouched.
    const replacement = knowl(['query', 'the correction']);
    expect(replacement.stdout).toContain(projectId);
  });

  it('still refuses an id that exists in no namespace', () => {
    const missing = knowl(['supersede', 'deadbeefdeadbeef', projectId]);
    expect(missing.status).not.toBe(0);
    expect(`${missing.stdout}${missing.stderr}`).toContain('deadbeefdeadbeef');
  });
});
