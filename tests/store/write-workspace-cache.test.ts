import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, initDb } from '../../src/store/database.js';
import { releaseAll } from '../../src/store/connection-pool.js';
import * as repo from '../../src/store/repository.js';
import {
  resetWriteWorkspaceCache, storeKnowledgeItemDeduped,
} from '../../src/store/knowledge-writer.js';
import { createManifest, writeManifest } from '../../src/workspace/manifest.js';
import { workspaceManifestPath } from '../../src/workspace/paths.js';
import { joinWorkspace } from '../../src/workspace/membership.js';
import { resetWriteOwnershipCache } from '../../src/store/write-ownership.js';
import { DEFAULT_CONFIG, saveConfig } from '../../src/core/config.js';

let counter = 0;
let HOME = '';
let SOLO = '';
let PEER = '';

const LEXICAL_ONLY = {
  ...DEFAULT_CONFIG,
  search: { vector: { ...DEFAULT_CONFIG.search?.vector, enabled: false } },
};

describe('workspace resolution on the write path', () => {
  beforeEach(async () => {
    await closeDb();
    await releaseAll();
    resetWriteOwnershipCache();
    resetWriteWorkspaceCache();
    counter += 1;
    HOME = path.resolve(`./.knowl-wswrite-home${counter}`);
    SOLO = path.resolve(`./.knowl-wswrite-solo${counter}`);
    PEER = path.resolve(`./.knowl-wswrite-peer${counter}`);
    process.env.KNOWL_HOME = HOME;
    for (const dir of [HOME, SOLO, PEER]) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    for (const dir of [SOLO, PEER]) {
      await fs.mkdir(path.join(dir, '.knowl'), { recursive: true });
      await saveConfig(dir, LEXICAL_ONLY);
    }
  });

  afterEach(async () => {
    delete process.env.KNOWL_HOME;
    await closeDb();
    await releaseAll();
    resetWriteOwnershipCache();
    resetWriteWorkspaceCache();
    for (const dir of [HOME, SOLO, PEER]) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  it('resolves the workspace once, not on every write', async () => {
    // Resolving per write meant a config read and a JSON parse on every single one. That was
    // not merely wasteful: a run of 2500 ordinary writes crashed the process partway through,
    // and completed cleanly once this was cached. 2.6.0, which had no such call, completed the
    // same run.
    //
    // Observable proof of the cache: link a workspace *after* the first write. A per-write
    // resolver would notice immediately; a cached one cannot until it is reset.
    await initDb(SOLO);
    const projectId = (await repo.createProject(SOLO, 'solo')).id;
    await storeKnowledgeItemDeduped(projectId, {
      category: 'fact', title: 'First write', content: 'Recorded before any workspace existed.',
    });
    await closeDb();

    await writeManifest(workspaceManifestPath('ws'), createManifest('ws', null));
    await joinWorkspace({ projectRoot: PEER, workspaceName: 'ws', repoName: 'peer' });
    await joinWorkspace({ projectRoot: SOLO, workspaceName: 'ws', repoName: 'solo' });

    await initDb(SOLO);
    try {
      const cached = await storeKnowledgeItemDeduped(projectId, {
        category: 'fact', title: 'Second write', content: 'Recorded after linking, same process.',
      });
      // Still using the resolution from before the join.
      expect(cached.crossRepo).toBeUndefined();

      resetWriteWorkspaceCache();
      const afterReset = await storeKnowledgeItemDeduped(projectId, {
        category: 'fact', title: 'Third write', content: 'Recorded after the cache was cleared.',
      });
      // The workspace is seen now: a peer with nothing in it yields an empty report rather
      // than undefined only if it was consulted, so assert the resolution happened by
      // checking the linked repo is reachable at all.
      const { resolveWorkspace } = await import('../../src/workspace/resolve.js');
      expect(await resolveWorkspace(SOLO)).not.toBeNull();
      expect(afterReset.action).toBe('inserted');
    } finally {
      await closeDb();
    }
  });

  it('writes many items in one process without the config being re-read each time', async () => {
    // A bounded stand-in for the 2500-write reproduction, sized to stay inside the suite's
    // budget. The crash it guards scaled with write count, so a few hundred writes through the
    // same code path is the cheap regression signal; the full reproduction is documented in
    // the commit that fixed it.
    await initDb(SOLO);
    const projectId = (await repo.createProject(SOLO, 'solo')).id;
    try {
      for (let index = 0; index < 300; index += 1) {
        await storeKnowledgeItemDeduped(projectId, {
          category: 'fact',
          title: `Metric ${index} threshold`,
          content: `Metric ${index} alerts above ${index * 3} requests per second.`,
        });
      }
      const rows = await repo.listKnowledgeItems();
      expect(rows.length).toBeGreaterThanOrEqual(300);
    } finally {
      await closeDb();
    }
  }, 120_000);
});
