import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, initDb } from '../../src/store/database.js';
import { releaseAll } from '../../src/store/connection-pool.js';
import * as repo from '../../src/store/repository.js';
import { storeKnowledgeItemDeduped } from '../../src/store/knowledge-writer.js';
import { createManifest, readManifest, writeManifest } from '../../src/workspace/manifest.js';
import { workspaceManifestPath } from '../../src/workspace/paths.js';
import { DEFAULT_CONFIG, saveConfig } from '../../src/core/config.js';

const HOME = path.resolve('./.knowl-addvis-home');
const A = path.resolve('./.knowl-addvis-a');
const B = path.resolve('./.knowl-addvis-b');
const CLI = path.resolve('./dist/index.js');

function knowl(cwd: string, ...args: string[]) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: 'utf-8',
    env: { ...process.env, KNOWL_HOME: HOME },
  });
  return { stdout: result.stdout ?? '', stderr: result.stderr ?? '', status: result.status };
}

/**
 * Seeded with one item on purpose. An empty repo never prints `existingItemsNotice`, so a
 * fixture with nothing in it cannot see what that notice tells someone to type next -- and that
 * notice is now reachable with no flags at all.
 */
async function seed(root: string, name: string) {
  await fs.mkdir(path.join(root, '.knowl'), { recursive: true });
  await saveConfig(root, { ...DEFAULT_CONFIG });
  await initDb(root);
  const project = await repo.createProject(root, name);
  await storeKnowledgeItemDeduped(project.id, {
    category: 'fact', title: `${name} knows something`, content: `Written by ${name} before it linked.`,
  });
  await closeDb();
}

/**
 * A repo joining a `linked` workspace shares by default; a repo already in one never moves.
 *
 * The second half is the load-bearing one. Changing what an ABSENT `defaultVisibility` resolves
 * to would publish every linked repo's next write on account of a release rather than a decision,
 * and `workspace set --default-visibility repo` only stops future writes -- there is no demote.
 * So the new default is applied at the moment a person runs `add`, to the entry that command
 * creates, and nowhere else.
 */
describe('workspace add default visibility', () => {
  beforeEach(async () => {
    // In-process too, not only in the spawned CLI's env. `workspaceManifestPath` resolves
    // through `knowlHome()`, so without this the manifest is written under vitest's global
    // scratch home while the child process looks for it under HOME -- and every case fails with
    // "not a member of workspace", which reads like the feature is broken rather than the
    // fixture. (vitest.config.ts pins KNOWL_HOME suite-wide precisely so that mismatch lands in
    // a scratch directory instead of the developer's real ~/.knowl.)
    process.env.KNOWL_HOME = HOME;
    await closeDb();
    await releaseAll();
    for (const dir of [HOME, A, B]) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    await seed(A, 'a');
    await seed(B, 'b');
    await writeManifest(workspaceManifestPath('ws'), createManifest('ws', null));
  });

  afterEach(async () => {
    delete process.env.KNOWL_HOME;
    await closeDb();
    await releaseAll();
    for (const dir of [HOME, A, B]) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  it('defaults a new linked member to workspace visibility', () => {
    expect(knowl(A, 'workspace', 'add', 'ws', '--name', 'a').status).toBe(0);

    return readManifest(workspaceManifestPath('ws')).then(manifest => {
      expect(manifest.repos.find(entry => entry.name === 'a')?.defaultVisibility).toBe('workspace');
    });
  });

  it('says a default decided it, and how to decline', () => {
    // A default that publishes must announce itself. Someone who passed no flag has to learn both
    // that the choice was made for them and what the opt-out is, in the same breath.
    const { stdout } = knowl(A, 'workspace', 'add', 'ws', '--name', 'a');

    expect(stdout).toContain('default to workspace visibility');
    expect(stdout).toContain('--default-visibility repo');
  });

  it('does not repeat the notice when the flag was passed explicitly', () => {
    const { stdout } = knowl(A, 'workspace', 'add', 'ws', '--name', 'a', '--default-visibility', 'workspace');

    expect(stdout).not.toContain('default to workspace visibility');
  });

  it('still honours --default-visibility repo', async () => {
    expect(knowl(A, 'workspace', 'add', 'ws', '--name', 'a', '--default-visibility', 'repo').status).toBe(0);

    const manifest = await readManifest(workspaceManifestPath('ws'));
    // Written as undefined, which is how a manifest spells 'repo'.
    expect(manifest.repos.find(entry => entry.name === 'a')?.defaultVisibility).toBeUndefined();
  });

  it('leaves an already-linked entry exactly as it was', async () => {
    // The invariant Dat's review turns on: linking a DIFFERENT repo must not change what an
    // already-linked repo's omitted defaultVisibility resolves to. `a` joins declining the
    // default, which writes the field as absent -- the same shape every pre-existing manifest
    // entry has -- and then `b` joins and takes it.
    expect(knowl(A, 'workspace', 'add', 'ws', '--name', 'a', '--default-visibility', 'repo').status).toBe(0);
    expect(knowl(B, 'workspace', 'add', 'ws', '--name', 'b').status).toBe(0);

    const after = await readManifest(workspaceManifestPath('ws'));
    expect(after.repos.find(entry => entry.name === 'a')?.defaultVisibility).toBeUndefined();
    expect(after.repos.find(entry => entry.name === 'b')?.defaultVisibility).toBe('workspace');
  });

  it('does not let the default stand in for saying --promote-existing out loud', () => {
    // The two decisions differ by orders of magnitude and must not be merged because they name
    // the same enum. Defaulting FUTURE writes to workspace is small, announced and per-command.
    // Publishing everything the repo ALREADY knows is the largest irreversible action here, and
    // if the default satisfied its precondition then `workspace add ws --promote-existing` would
    // bulk-publish an entire history with nobody having typed a visibility at all.
    const refused = knowl(A, 'workspace', 'add', 'ws', '--name', 'a', '--promote-existing');

    expect(refused.status).toBe(1);
    expect(refused.stderr).toMatch(/explicit --default-visibility workspace/);
  });

  it('prints a follow-up command that the --promote-existing guard actually accepts', () => {
    // The two halves of this change pull against each other, and this is where they meet.
    // Defaulting the visibility makes `existingItemsNotice` reachable with no flags typed;
    // requiring an EXPLICIT --default-visibility workspace for --promote-existing makes the
    // short form of its advice fail. So the notice is not asserted as a string here -- the line
    // it prints is parsed and run, and the test fails if the tool contradicts itself.
    const linked = knowl(A, 'workspace', 'add', 'ws', '--name', 'a');
    expect(linked.status).toBe(0);

    const suggestion = linked.stdout.split('\n').find(line => line.includes('re-run add with'));
    expect(suggestion, 'the existing-items notice did not print').toBeDefined();
    const flags = suggestion!.trim().replace(/^Or re-run add with /, '').replace(/ to do it in one step\.$/, '').split(' ');

    const followed = knowl(B, 'workspace', 'add', 'ws', '--name', 'b', ...flags);
    expect(followed.status, `following "${suggestion!.trim()}" failed: ${followed.stderr}`).toBe(0);
    expect(followed.stdout).toMatch(/Promoted \d+ existing item/);
  });

  it('does not default when the workspace is not in linked mode', async () => {
    // The branch ships unconditional today -- nothing constructs 'shared' -- so this pins intent
    // rather than a reachable path. Under 'shared' a workspace row would mean "another person",
    // and consent recorded before any counterparty existed cannot be inherited.
    const manifestPath = workspaceManifestPath('sharedws');
    await writeManifest(manifestPath, { ...createManifest('sharedws', null), mode: 'shared' });

    expect(knowl(B, 'workspace', 'add', 'sharedws', '--name', 'b').status).toBe(0);

    const manifest = await readManifest(manifestPath);
    expect(manifest.repos.find(entry => entry.name === 'b')?.defaultVisibility).toBeUndefined();
  });
});
