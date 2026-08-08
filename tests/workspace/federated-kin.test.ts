import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, getClient, initDb } from '../../src/store/database.js';
import { releaseAll } from '../../src/store/connection-pool.js';
import * as repo from '../../src/store/repository.js';
import { storeKnowledgeItemDeduped } from '../../src/store/knowledge-writer.js';
import { flattenGroups, queryFederated } from '../../src/workspace/federated-query.js';
import { resolveWorkspace } from '../../src/workspace/resolve.js';
import { createManifest, writeManifest } from '../../src/workspace/manifest.js';
import { workspaceManifestPath } from '../../src/workspace/paths.js';
import { joinWorkspace } from '../../src/workspace/membership.js';
import { updateRepoSettings } from '../../src/workspace/repo-settings.js';
import { DEFAULT_CONFIG, saveConfig } from '../../src/core/config.js';

const HOME = path.resolve('./.knowl-kin-home');
const API = path.resolve('./.knowl-kin-api');
const WEB = path.resolve('./.knowl-kin-web');

async function seed(root: string, name: string, title: string, content: string, visibility: string) {
  await fs.mkdir(path.join(root, '.knowl'), { recursive: true });
  await saveConfig(root, { ...DEFAULT_CONFIG });
  await initDb(root);
  const projectId = (await repo.createProject(root, name)).id;
  const stored = await storeKnowledgeItemDeduped(projectId, { category: 'decision', title, content });
  await getClient().execute({
    sql: 'UPDATE knowledge_items SET visibility = ?, origin_repo = ? WHERE id = ?',
    args: [visibility, name, stored.item.id],
  });
  await closeDb();
}

async function federate(query: string) {
  await initDb(API);
  try {
    return await queryFederated({ workspace: (await resolveWorkspace(API))!, query, limit: 5 });
  } finally {
    await closeDb();
  }
}

/**
 * Kin was a write-time signal only.
 *
 * `findCrossRepoOverlap` looks wider in a kin peer and the CLI advisory says "shares this repo's
 * lineage" -- so the person STORING a fact was told the other repo has diverged, and the agent
 * READING one was not. Reading is where the wrong convention gets applied: `question_bank` is
 * alive in one repo of a kin pair and dropped in the other, and a federated hit says neither.
 */
describe('kin divergence on the read path', () => {
  beforeEach(async () => {
    process.env.KNOWL_HOME = HOME;
    await closeDb();
    await releaseAll();
    for (const dir of [HOME, API, WEB]) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    await writeManifest(workspaceManifestPath('ws'), createManifest('ws', null));
    await seed(API, 'api', 'Local session note', 'Sessions are handled here too.', 'repo');
    await seed(WEB, 'web', 'Session store is redis', 'Sessions are kept in redis.', 'workspace');
    await joinWorkspace({ projectRoot: API, workspaceName: 'ws', repoName: 'api' });
    await joinWorkspace({ projectRoot: WEB, workspaceName: 'ws', repoName: 'web' });
  });

  afterEach(async () => {
    delete process.env.KNOWL_HOME;
    await closeDb();
    await releaseAll();
    for (const dir of [HOME, API, WEB]) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  it('marks a result from a kin peer', async () => {
    await updateRepoSettings({ workspaceName: 'ws', repoName: 'web', settings: { kin: 'services' } });
    await updateRepoSettings({ workspaceName: 'ws', repoName: 'api', settings: { kin: 'services' } });

    const result = await federate('session store');
    const fromWeb = flattenGroups(result).find(item => item.repo === 'web');

    expect(fromWeb).toBeDefined();
    expect(fromWeb!.kinDivergent).toBe(true);
  });

  it('does not mark a peer that merely declares a kin group of its own', async () => {
    // Kin is a shared group, not a claim one repo can make about another -- the same rule the
    // write path holds. Only web declares one, so the pair is not kin.
    await updateRepoSettings({ workspaceName: 'ws', repoName: 'web', settings: { kin: 'services' } });

    const result = await federate('session store');
    const fromWeb = flattenGroups(result).find(item => item.repo === 'web');

    expect(fromWeb).toBeDefined();
    expect(fromWeb!.kinDivergent).toBeUndefined();
  });

  it('never marks the querying repo\'s own items', async () => {
    // The caller cannot have diverged from itself, and a marker here would fire the notice on
    // a page with nothing foreign on it.
    await updateRepoSettings({ workspaceName: 'ws', repoName: 'web', settings: { kin: 'services' } });
    await updateRepoSettings({ workspaceName: 'ws', repoName: 'api', settings: { kin: 'services' } });

    const result = await federate('session');
    const mine = flattenGroups(result).filter(item => item.repo === 'api');

    expect(mine.length).toBeGreaterThan(0);
    expect(mine.every(item => item.kinDivergent === undefined)).toBe(true);
  });

  it('leaves results unmarked when no repo declares kin at all', async () => {
    const result = await federate('session store');

    expect(flattenGroups(result).length).toBeGreaterThan(0);
    expect(flattenGroups(result).every(item => item.kinDivergent === undefined)).toBe(true);
  });
});
