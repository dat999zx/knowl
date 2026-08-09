import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveWorkspace } from '../../src/workspace/resolve.js';
import { teamStorePath } from '../../src/cloud/team-store.js';
import type { ProjectConfig } from '../../src/core/types.js';

const HOME = path.resolve('./.knowl-resolve-cloud-home');
const ROOT = path.resolve('./.knowl-resolve-cloud-root');

const cloudOnly: ProjectConfig = {
  version: 1,
  cloud: {
    apiHost: 'https://api.knowl.dev', workspaceId: 'ws-9', workspaceName: 'Acme',
    repo: 'github.com/acme/web', remote: 'origin',
  },
};

describe('resolveWorkspace with a cloud pointer', () => {
  beforeEach(async () => {
    process.env.KNOWL_HOME = HOME;
    for (const dir of [HOME, ROOT]) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    await fs.mkdir(path.join(ROOT, '.knowl'), { recursive: true });
    await fs.writeFile(path.join(ROOT, '.knowl', 'config.json'), JSON.stringify({ version: 1 }), 'utf8');
  });
  afterEach(async () => {
    delete process.env.KNOWL_HOME;
    for (const dir of [HOME, ROOT]) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  it('still returns null for a repo with neither a link nor a pointer', async () => {
    // The no-workspace guarantee. Every caller reads null as "behave exactly as before", and
    // that is what keeps an unconnected repo paying nothing for any of this.
    expect(await resolveWorkspace(ROOT, { version: 1 })).toBeNull();
  });

  it('becomes active on a cloud pointer alone, with no local workspace link', async () => {
    // The gap this task closes: `queryFederated` is reachable only from a non-null
    // resolveWorkspace, so without this a cloud-connected repo syncs a replica nothing reads.
    const active = await resolveWorkspace(ROOT, cloudOnly);

    expect(active).not.toBeNull();
    expect(active?.peers).toEqual([]);
    expect(active?.cloud?.workspaceId).toBe('ws-9');
    expect(active?.cloud?.databasePath).toBe(teamStorePath('ws-9'));
  });

  it('reports the replica absent until the first pull, rather than failing', async () => {
    // Connected but never pulled is the ordinary state between `cloud connect` and the first
    // `cloud pull`. Federation skips an absent store; treating it as an error would break
    // every query in that window.
    expect((await resolveWorkspace(ROOT, cloudOnly))?.cloud?.present).toBe(false);
  });

  it('reports the replica present once it exists', async () => {
    await fs.mkdir(path.dirname(teamStorePath('ws-9')), { recursive: true });
    await fs.writeFile(teamStorePath('ws-9'), '', 'utf8');

    expect((await resolveWorkspace(ROOT, cloudOnly))?.cloud?.present).toBe(true);
  });

  it('carries a manifest naming only this repo, so kin logic finds no false relatives', async () => {
    // `queryFederated` reads `manifest.repos` to decide which peers are kin. A synthesized
    // manifest listing only this repo yields no kin, which is correct: a cloud workspace is
    // not a fork lineage.
    const active = await resolveWorkspace(ROOT, cloudOnly);

    expect(active?.manifest.repos.map(repo => repo.name)).toEqual([active?.repo]);
  });

  it('leaves `cloud` null for a link-only workspace', async () => {
    // Existing linked repos must be byte-identical to before. A non-null `cloud` here would
    // send federation looking for a replica that does not exist.
    const linked = await resolveWorkspace(ROOT, { version: 1 });
    expect(linked?.cloud ?? null).toBeNull();
  });
});
