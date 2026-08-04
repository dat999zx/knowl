import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, initDb } from '../../src/store/database.js';
import { releaseAll } from '../../src/store/connection-pool.js';
import * as repo from '../../src/store/repository.js';
import { storeKnowledgeItemDeduped } from '../../src/store/knowledge-writer.js';
import { runCliQuery } from '../../src/cli/query-command.js';
import { createManifest, writeManifest } from '../../src/workspace/manifest.js';
import { workspaceManifestPath } from '../../src/workspace/paths.js';
import { joinWorkspace } from '../../src/workspace/membership.js';
import { resetWriteOwnershipCache } from '../../src/store/write-ownership.js';
import { DEFAULT_CONFIG, saveConfig } from '../../src/core/config.js';

let counter = 0;
let HOME = '';
let SOLO = '';
let LINKED = '';
let PEER = '';

/**
 * Vector search off, deliberately.
 *
 * These tests assert that the CLI applies the shared ranker's boosts and that it ranks the
 * same linked or not -- both visible on the lexical path. Leaving vectors on made each test
 * load the embedding model into a fresh repo, adding roughly 45 seconds to the suite to
 * exercise wiring that tests/workspace/cross-repo-semantic.test.ts already covers end to end.
 * The measured cost to a real user is unaffected: `knowl query` runs in ~1.7s against a warm
 * model cache.
 */
const LEXICAL_ONLY = {
  ...DEFAULT_CONFIG,
  search: { vector: { ...DEFAULT_CONFIG.search?.vector, enabled: false } },
};

async function makeRepo(root: string) {
  await fs.mkdir(path.join(root, '.knowl'), { recursive: true });
  await saveConfig(root, LEXICAL_ONLY);
}

/** Two atoms with identical body text, so lexical scoring ties and only the boosts decide. */
async function seedStaleThenFresh(root: string) {
  await initDb(root);
  const projectId = (await repo.createProject(root, 'p')).id;
  const body = 'Deployments roll out region by region with a health gate between each.';
  const stale = await storeKnowledgeItemDeduped(projectId, {
    category: 'fact', title: 'Rollout order superseded note', content: body,
  });
  await storeKnowledgeItemDeduped(projectId, {
    category: 'fact', title: 'Rollout order current note', content: body,
  });
  // Marked stale after both exist, so it is also the more recently touched of the two --
  // the freshness penalty has to outweigh its recency advantage.
  await repo.updateKnowledgeItem(stale.item.id, { freshness: 'stale' });
  await closeDb();
}

describe('knowl query', () => {
  beforeEach(async () => {
    await closeDb();
    await releaseAll();
    resetWriteOwnershipCache();
    counter += 1;
    HOME = path.resolve(`./.knowl-cliq-home${counter}`);
    SOLO = path.resolve(`./.knowl-cliq-solo${counter}`);
    LINKED = path.resolve(`./.knowl-cliq-linked${counter}`);
    PEER = path.resolve(`./.knowl-cliq-peer${counter}`);
    process.env.KNOWL_HOME = HOME;
    for (const dir of [HOME, SOLO, LINKED, PEER]) {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
    for (const dir of [SOLO, LINKED, PEER]) await makeRepo(dir);
  });

  afterEach(async () => {
    delete process.env.KNOWL_HOME;
    await closeDb();
    await releaseAll();
    resetWriteOwnershipCache();
    for (const dir of [HOME, SOLO, LINKED, PEER]) {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('ranks with the same boosts the MCP tool applies, not raw lexical order', async () => {
    // queryKnowledgeBase orders by BM25 alone. With identical body text the two atoms tie
    // and insertion order wins, putting the stale one first. The shared ranker demotes it.
    await seedStaleThenFresh(SOLO);
    await initDb(SOLO);
    try {
      const result = await runCliQuery({ projectRoot: SOLO, projectId: 'local', query: 'rollout order region' });
      expect(result.items[0].title).toBe('Rollout order current note');
    } finally {
      await closeDb();
    }
  });

  // `knowl query` printed a bare ordering, so a human could not tell a confident answer from
  // the least-bad row in the store -- the same gap knowl_query had before K-35. It reaches the
  // CLI through the same explanation, and the bulky contribution terms stay off the page.
  it('prints the ranker score and never the whole explanation', async () => {
    await seedStaleThenFresh(SOLO);
    await initDb(SOLO);
    try {
      const result = await runCliQuery({ projectRoot: SOLO, projectId: 'local', query: 'rollout order region' });
      expect(result.items.length).toBeGreaterThan(0);
      for (const item of result.items) {
        expect(typeof item.score).toBe('number');
        expect(item.score).toBeGreaterThanOrEqual(0);
        expect(item.score).toBeLessThanOrEqual(1);
        // Three decimals, matching the MCP surface rather than inventing a second convention.
        expect(String(item.score)).toMatch(/^\d+(\.\d{1,3})?$/);
        expect(item).not.toHaveProperty('explanation');
      }
      // Ordered by the number that is printed, so the page explains its own order.
      expect([...result.items].sort((a, b) => (b.score ?? 0) - (a.score ?? 0)).map(item => item.title))
        .toEqual(result.items.map(item => item.title));
    } finally {
      await closeDb();
    }
  });

  it('ranks the same whether or not the repo is linked to a workspace', async () => {
    // The inconsistency this fixes: the workspace branch went through the shared ranker while
    // the solo branch did not, so the same command answered differently depending on whether
    // the caller happened to be in a workspace.
    await seedStaleThenFresh(SOLO);
    await seedStaleThenFresh(LINKED);
    await writeManifest(workspaceManifestPath('ws'), createManifest('ws', null));
    await joinWorkspace({ projectRoot: PEER, workspaceName: 'ws', repoName: 'peer' });
    await joinWorkspace({ projectRoot: LINKED, workspaceName: 'ws', repoName: 'linked' });
    resetWriteOwnershipCache();

    await initDb(SOLO);
    const solo = await runCliQuery({ projectRoot: SOLO, projectId: 'local', query: 'rollout order region' });
    await closeDb();

    await initDb(LINKED);
    const linked = await runCliQuery({ projectRoot: LINKED, projectId: 'local', query: 'rollout order region' });
    await closeDb();

    expect(linked.items.map(item => item.title)).toEqual(solo.items.map(item => item.title));
  });

  it('returns more than three results by default, as it always has', async () => {
    // The workspace branch defaulted to 3 while the solo branch returned up to 20, so the
    // same query printed a different number of results depending on linkage.
    await initDb(SOLO);
    const projectId = (await repo.createProject(SOLO, 'p')).id;
    // Distinct subjects, not numbered variants of one. `duplicateTokens` drops tokens
    // shorter than two characters, so "Cache eviction rule 0" and "Cache eviction rule 1"
    // reduce to the same token set, read as the same subject, and supersede each other --
    // six writes would leave one active item.
    for (const subject of ['tier', 'window', 'threshold', 'sweep', 'budget', 'backstop']) {
      await storeKnowledgeItemDeduped(projectId, {
        category: 'fact',
        title: `Cache eviction ${subject}`,
        content: `Cache eviction ${subject} governs how the shared tier releases entries.`,
      });
    }
    try {
      const result = await runCliQuery({ projectRoot: SOLO, projectId: 'local', query: 'cache eviction' });
      expect(result.items.length).toBeGreaterThan(3);
    } finally {
      await closeDb();
    }
  });

  it('honours an explicit limit', async () => {
    await seedStaleThenFresh(SOLO);
    await initDb(SOLO);
    try {
      const result = await runCliQuery({ projectRoot: SOLO, projectId: 'local', query: 'rollout order region', limit: 1 });
      expect(result.items).toHaveLength(1);
    } finally {
      await closeDb();
    }
  });

  it('keeps --as-of on the historical path, which the ranker does not implement', async () => {
    await seedStaleThenFresh(SOLO);
    await initDb(SOLO);
    try {
      const result = await runCliQuery({
        projectRoot: SOLO, projectId: 'local', query: 'rollout order region',
        asOf: '2099-01-01T00:00:00.000Z',
      });
      expect(result.items.length).toBeGreaterThan(0);
      expect(result.skipped).toEqual([]);
    } finally {
      await closeDb();
    }
  });

  it('reports an absent linked repo rather than swallowing it', async () => {
    await seedStaleThenFresh(LINKED);
    await writeManifest(workspaceManifestPath('ws'), createManifest('ws', null));
    await joinWorkspace({ projectRoot: PEER, workspaceName: 'ws', repoName: 'peer' });
    await joinWorkspace({ projectRoot: LINKED, workspaceName: 'ws', repoName: 'linked' });
    resetWriteOwnershipCache();
    // Repoint the peer at a path that was never checked out, rather than deleting its
    // directory: on Windows the removal can fail silently while libSQL still holds the WAL
    // sidecars, leaving the peer present and the test asserting nothing.
    const { readManifest } = await import('../../src/workspace/manifest.js');
    const manifest = await readManifest(workspaceManifestPath('ws'));
    manifest.repos = manifest.repos.map(entry =>
      entry.name === 'peer' ? { ...entry, path: path.resolve('./.knowl-cliq-never-cloned') } : entry);
    await writeManifest(workspaceManifestPath('ws'), manifest);

    await initDb(LINKED);
    try {
      const result = await runCliQuery({ projectRoot: LINKED, projectId: 'local', query: 'rollout order region' });
      expect(result.skipped).toEqual([{ repo: 'peer', reason: 'absent' }]);
    } finally {
      await closeDb();
    }
  });
});
