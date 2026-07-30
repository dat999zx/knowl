import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, initDb } from '../../src/store/database.js';
import { releaseAll } from '../../src/store/connection-pool.js';
import * as repo from '../../src/store/repository.js';
import { recordDecisionDirect } from '../../src/store/knowledge-actions.js';
import { createManifest, writeManifest } from '../../src/workspace/manifest.js';
import { workspaceManifestPath } from '../../src/workspace/paths.js';
import { joinWorkspace } from '../../src/workspace/membership.js';
import { promoteItems } from '../../src/workspace/promote.js';
import { resetWriteOwnershipCache } from '../../src/store/write-ownership.js';
import { resetWriteWorkspaceCache } from '../../src/store/knowledge-writer.js';
import { DEFAULT_CONFIG, saveConfig } from '../../src/core/config.js';

let counter = 0;
let HOME = '';
let API = '';
let WEB = '';

const LEXICAL_ONLY = {
  ...DEFAULT_CONFIG,
  search: { vector: { ...DEFAULT_CONFIG.search?.vector, enabled: false } },
};

describe('knowl decide reports cross-repo overlap', () => {
  beforeEach(async () => {
    await closeDb();
    await releaseAll();
    resetWriteOwnershipCache();
    resetWriteWorkspaceCache();
    counter += 1;
    HOME = path.resolve(`./.knowl-decidex-home${counter}`);
    API = path.resolve(`./.knowl-decidex-api${counter}`);
    WEB = path.resolve(`./.knowl-decidex-web${counter}`);
    process.env.KNOWL_HOME = HOME;
    for (const dir of [HOME, API, WEB]) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    for (const dir of [API, WEB]) {
      await fs.mkdir(path.join(dir, '.knowl'), { recursive: true });
      await saveConfig(dir, LEXICAL_ONLY);
    }
    await writeManifest(workspaceManifestPath('ws'), createManifest('ws', null));
    await joinWorkspace({ projectRoot: WEB, workspaceName: 'ws', repoName: 'web' });
    await joinWorkspace({ projectRoot: API, workspaceName: 'ws', repoName: 'api' });
    resetWriteOwnershipCache();
    resetWriteWorkspaceCache();

    // web records a decision and shares it.
    await initDb(WEB);
    const project = await repo.createProject(WEB, 'web');
    const stored = await recordDecisionDirect(project.id, {
      title: 'Wire format is JSON',
      content: 'The client and server exchange JSON over HTTP.',
    });
    await closeDb();
    await promoteItems({ projectRoot: WEB, repoName: 'web', ids: [stored.item.id], apply: true });
    resetWriteOwnershipCache();
    resetWriteWorkspaceCache();
  });

  afterEach(async () => {
    delete process.env.KNOWL_HOME;
    await closeDb();
    await releaseAll();
    resetWriteOwnershipCache();
    resetWriteWorkspaceCache();
    for (const dir of [HOME, API, WEB]) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  it('reports a linked repo already covering the subject', async () => {
    // Found by using the feature: `knowl decide` recorded a decision on exactly the subject a
    // linked repo had already shared and said nothing. recordDecisionDirect writes through the
    // repository directly, so it never reached the overlap check that storeKnowledgeItemDeduped
    // performs -- and it backs both the CLI command and the knowl_decide MCP tool, so the
    // headline cross-repo feature was off for the category most likely to conflict and the one
    // shared by default.
    await initDb(API);
    try {
      const project = await repo.createProject(API, 'api');
      const result = await recordDecisionDirect(project.id, {
        title: 'Wire format',
        content: 'Reopening this: the wire format is under review.',
      });

      expect(result.crossRepo).toHaveLength(1);
      expect(result.crossRepo![0]).toMatchObject({ repo: 'web', title: 'Wire format is JSON' });
    } finally {
      await closeDb();
    }
  });

  it('says nothing when no linked repo covers the subject', async () => {
    await initDb(API);
    try {
      const project = await repo.createProject(API, 'api');
      const result = await recordDecisionDirect(project.id, {
        title: 'Deploy cadence is weekly',
        content: 'Releases go out every Thursday.',
      });
      expect(result.crossRepo).toBeUndefined();
    } finally {
      await closeDb();
    }
  });
});
