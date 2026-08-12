import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/core/config.js';
import { writeCredential } from '../../src/cloud/credentials.js';
import { runConnect } from '../../src/cloud/connect.js';
import type { CloudApi } from '../../src/cloud/api-client.js';

const HOME = path.resolve('./.knowl-connect-home');
const REPO = path.resolve('./.knowl-connect-repo');
const HOST = 'https://api.knowl.test';

// Distinctive values on purpose. The "no credential in config" assertion below is a substring
// search, and a one-character token like 'a' matches the "a" in "apiHost" -- an assertion that
// can never pass no matter how correct the code is.
const credential = {
  accessToken: 'ACCESS-TOKEN-9f3c1e',
  refreshToken: 'REFRESH-TOKEN-7b20da',
  expiresAt: '2099-01-01T00:00:00.000Z',
  sessionId: 'sess-1',
};

function api(workspaces: Array<{ id: string; name: string; role: 'owner' | 'admin' | 'editor' | 'reader' }>): CloudApi {
  return {
    startDeviceAuthorization: async () => { throw new Error('unused'); },
    pollForToken: async () => 'pending',
    refresh: async () => credential,
    listWorkspaces: async () => workspaces,
  };
}

async function makeRepo(remote: string | null): Promise<void> {
  await fs.mkdir(path.join(REPO, '.knowl'), { recursive: true });
  await fs.writeFile(
    path.join(REPO, '.knowl', 'config.json'),
    JSON.stringify({ version: 1 }, null, 2),
    'utf8',
  );
  spawnSync('git', ['init', '-q'], { cwd: REPO });
  if (remote) spawnSync('git', ['remote', 'add', 'origin', remote], { cwd: REPO });
}

describe('runConnect', () => {
  beforeEach(async () => {
    process.env.KNOWL_HOME = HOME;
    for (const dir of [HOME, REPO]) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  });
  afterEach(async () => {
    delete process.env.KNOWL_HOME;
    for (const dir of [HOME, REPO]) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  it('refuses before login rather than after doing the work', async () => {
    await makeRepo('git@github.com:acme/web.git');

    expect(await runConnect({ projectRoot: REPO, apiHost: HOST, api: api([]) }))
      .toEqual({ status: 'not-logged-in' });
  });

  it('connects when the caller belongs to exactly one workspace', async () => {
    await makeRepo('git@github.com:acme/web.git');
    await writeCredential(HOST, credential);

    const result = await runConnect({
      projectRoot: REPO,
      apiHost: HOST,
      api: api([{ id: 'w1', name: 'Acme', role: 'editor' }]),
    });

    expect(result).toEqual({
      status: 'connected',
      role: 'editor',
      pointer: {
        apiHost: HOST,
        workspaceId: 'w1',
        workspaceName: 'Acme',
        repo: 'github.com/acme/web',
        remote: 'origin',
      },
    });
  });

  it('writes the pointer into config and no credential anywhere near it', async () => {
    await makeRepo('git@github.com:acme/web.git');
    await writeCredential(HOST, credential);

    await runConnect({
      projectRoot: REPO,
      apiHost: HOST,
      api: api([{ id: 'w1', name: 'Acme', role: 'editor' }]),
    });

    const config = await loadConfig(REPO);
    expect(config.cloud).toEqual({
      apiHost: HOST,
      workspaceId: 'w1',
      workspaceName: 'Acme',
      repo: 'github.com/acme/web',
      remote: 'origin',
    });
    const raw = await fs.readFile(path.join(REPO, '.knowl', 'config.json'), 'utf8');
    expect(raw).not.toContain(credential.accessToken);
    expect(raw).not.toContain(credential.refreshToken);
  });

  it('tells a caller who belongs to no workspace apart from one who belongs to several', async () => {
    // Signed in, but invited nowhere. Reporting this as "pick one" would print an empty list
    // and an instruction the user cannot follow.
    await makeRepo('git@github.com:acme/web.git');
    await writeCredential(HOST, credential);

    expect(await runConnect({ projectRoot: REPO, apiHost: HOST, api: api([]) }))
      .toEqual({ status: 'no-workspaces' });
  });

  it('asks which workspace when the caller belongs to several', async () => {
    await makeRepo('git@github.com:acme/web.git');
    await writeCredential(HOST, credential);

    const result = await runConnect({
      projectRoot: REPO,
      apiHost: HOST,
      api: api([
        { id: 'w1', name: 'Acme', role: 'editor' },
        { id: 'w2', name: 'Other', role: 'reader' },
      ]),
    });

    expect(result.status).toBe('ambiguous');
  });

  it('accepts an explicit workspace id when several exist', async () => {
    await makeRepo('git@github.com:acme/web.git');
    await writeCredential(HOST, credential);

    const result = await runConnect({
      projectRoot: REPO,
      apiHost: HOST,
      workspaceId: 'w2',
      api: api([
        { id: 'w1', name: 'Acme', role: 'editor' },
        { id: 'w2', name: 'Other', role: 'reader' },
      ]),
    });

    expect(result).toMatchObject({ status: 'connected', role: 'reader' });
  });

  it('commits a normalized api host, since the pointer travels to every teammate', async () => {
    await makeRepo('git@github.com:acme/web.git');
    await writeCredential(HOST, credential);

    const result = await runConnect({
      projectRoot: REPO,
      apiHost: 'https://API.knowl.test/',
      api: api([{ id: 'w1', name: 'Acme', role: 'editor' }]),
    });

    expect(result).toMatchObject({ status: 'connected' });
    expect((await loadConfig(REPO)).cloud?.apiHost).toBe(HOST);
  });

  it('names a workspace id that matches nothing instead of calling it ambiguous', async () => {
    // A typo'd --workspace used to fall through to "you belong to more than one workspace,
    // re-run with --workspace <id>" -- advice the user had just followed. It also fired when
    // they belonged to exactly one.
    await makeRepo('git@github.com:acme/web.git');
    await writeCredential(HOST, credential);

    const result = await runConnect({
      projectRoot: REPO,
      apiHost: HOST,
      workspaceId: 'w-typo',
      api: api([{ id: 'w1', name: 'Acme', role: 'editor' }]),
    });

    expect(result).toMatchObject({ status: 'unknown-workspace', workspaceId: 'w-typo' });
  });

  it('leaves config untouched when the named workspace does not exist', async () => {
    await makeRepo('git@github.com:acme/web.git');
    await writeCredential(HOST, credential);

    await runConnect({
      projectRoot: REPO,
      apiHost: HOST,
      workspaceId: 'w-typo',
      api: api([{ id: 'w1', name: 'Acme', role: 'editor' }]),
    });

    expect((await loadConfig(REPO)).cloud).toBeUndefined();
  });

  /*
   * This asserted `refuses a repo with no git remote` until the requirement was dropped. Connecting
   * used to be gated on git, for a product people pay for by how much they store; the server has
   * only ever validated `originRepo` as a non-empty string and treats it as a label.
   */
  it('connects a repo with no git remote, naming it after the directory', async () => {
    await makeRepo(null);
    await writeCredential(HOST, credential);

    const result = await runConnect({
      projectRoot: REPO,
      apiHost: HOST,
      api: api([{ id: 'w1', name: 'Acme', role: 'editor' }]),
    });

    expect(result.status).toBe('connected');
    const pointer = (await loadConfig(REPO)).cloud;
    expect(pointer?.repo).toBe(path.basename(REPO).toLowerCase());
    // Absent, not 'origin': recording a remote it never read would make the pointer claim the
    // identity is shared when it is one machine's folder name.
    expect(pointer?.remote).toBeUndefined();
  });

  it('publishes under an explicit name when one is given', async () => {
    await makeRepo(null);
    await writeCredential(HOST, credential);

    const result = await runConnect({
      projectRoot: REPO,
      apiHost: HOST,
      repo: 'Team Notes',
      api: api([{ id: 'w1', name: 'Acme', role: 'editor' }]),
    });

    expect(result.status).toBe('connected');
    expect((await loadConfig(REPO)).cloud?.repo).toBe('team-notes');
  });

  /*
   * The trap the fallback introduces, and the reason connect guards rather than just writing.
   *
   * Identity is derived, so adding a remote to a project that had none moves it — from the folder
   * name to the remote URL — with nobody deciding to move it. Atoms already pushed stay filed under
   * the old name, and the server refuses a write carrying a different origin as `foreign_origin`,
   * so the next push half-fails with an ownership error rather than anything about renaming.
   */
  it('refuses to re-key a project whose identity has moved, and says how to keep it', async () => {
    await makeRepo(null);
    await writeCredential(HOST, credential);
    await runConnect({
      projectRoot: REPO,
      apiHost: HOST,
      repo: 'original-name',
      api: api([{ id: 'w1', name: 'Acme', role: 'editor' }]),
    });

    const result = await runConnect({
      projectRoot: REPO,
      apiHost: HOST,
      api: api([{ id: 'w1', name: 'Acme', role: 'editor' }]),
    });

    expect(result).toEqual({
      status: 'identity-changed',
      current: 'original-name',
      next: path.basename(REPO).toLowerCase(),
    });
    // And the pointer is left exactly as it was, so the refusal costs nothing to recover from.
    expect((await loadConfig(REPO)).cloud?.repo).toBe('original-name');
  });

  it('still re-connects when only the workspace changes', async () => {
    // The ordinary reason to re-run connect. It must not be caught by the guard above, or changing
    // workspace would require naming the repo you already publish as.
    await makeRepo('git@github.com:acme/web.git');
    await writeCredential(HOST, credential);
    const workspaces = [
      { id: 'w1', name: 'Acme', role: 'editor' as const },
      { id: 'w2', name: 'Beta', role: 'editor' as const },
    ];
    await runConnect({ projectRoot: REPO, apiHost: HOST, workspaceId: 'w1', api: api(workspaces) });

    const result = await runConnect({
      projectRoot: REPO, apiHost: HOST, workspaceId: 'w2', api: api(workspaces),
    });

    expect(result.status).toBe('connected');
    expect((await loadConfig(REPO)).cloud?.workspaceId).toBe('w2');
  });
});

describe('runConnect and the workspace embedding profile', () => {
  beforeEach(async () => {
    process.env.KNOWL_HOME = HOME;
    for (const dir of [HOME, REPO]) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    await makeRepo('git@github.com:acme/web.git');
    await writeCredential(HOST, {
      accessToken: 'at', refreshToken: 'rt', sessionId: 's',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
  });
  afterEach(async () => {
    delete process.env.KNOWL_HOME;
    for (const dir of [HOME, REPO]) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  /**
   * Derived from what this repository actually resolves to, not hardcoded.
   *
   * A config with no `search.vector.preset` does not resolve to today's default -- it resolves by
   * matching its model string, which is what keeps an existing repo on the model its vectors were
   * built with. Hardcoding the current default here asserted a profile this fixture never has.
   */
  async function localProfile() {
    const { resolveVectorProfile } = await import('../../src/core/vector-profile.js');
    const { EMBED_RECIPE_VERSION } = await import('../../src/core/embed-recipe.js');
    const profile = resolveVectorProfile(await loadConfig(REPO));
    return { ...profile, dimensions: 384, recipeVersion: EMBED_RECIPE_VERSION };
  }

  const apiWithProfile = (profile: Record<string, unknown>) => ({
    listWorkspaces: async () => [{ id: 'ws-1', name: 'Acme', role: 'owner' as const }],
    workspaceProfile: async () => profile,
  }) as never;

  it('connects when the profiles match', async () => {
    const result = await runConnect({
      projectRoot: REPO, apiHost: HOST, api: apiWithProfile(await localProfile()),
    });
    expect(result.status).toBe('connected');
  });

  it('refuses rather than connecting when the model differs', async () => {
    const result = await runConnect({
      projectRoot: REPO, apiHost: HOST,
      api: apiWithProfile({ ...(await localProfile()), model: 'a-different-model' }),
    });

    expect(result.status).toBe('profile-mismatch');
    expect((result as { differing: string[] }).differing).toEqual(['model']);

    // Nothing written: a repo pointed at a workspace it cannot publish to is worse than one
    // pointed nowhere, because every later command looks connected and every push fails.
    const config = await loadConfig(REPO);
    expect(config.cloud).toBeUndefined();
  });

  it('refuses on a recipe difference even when every model field matches', async () => {
    // The case no model-only comparison can see, and the whole reason the fingerprint has five
    // fields: an older client on the same model builds different text.
    const result = await runConnect({
      projectRoot: REPO, apiHost: HOST,
      api: apiWithProfile({ ...(await localProfile()), recipeVersion: 99 }),
    });
    expect(result.status).toBe('profile-mismatch');
    expect((result as { differing: string[] }).differing).toEqual(['recipeVersion']);
  });

  it('connects against a server too old to report a profile', async () => {
    // It cannot be running the validation either, so refusing here would break connecting to it
    // for a rule it does not enforce.
    const result = await runConnect({
      projectRoot: REPO, apiHost: HOST,
      api: { listWorkspaces: async () => [{ id: 'ws-1', name: 'Acme', role: 'owner' as const }] } as never,
    });
    expect(result.status).toBe('connected');
  });
});
