import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, getClient, initDb } from '../../src/store/database.js';
import * as repo from '../../src/store/repository.js';
import { storeKnowledgeItemDeduped } from '../../src/store/knowledge-writer.js';
import { flattenGroups, queryFederated } from '../../src/workspace/federated-query.js';
import { resolveWorkspace } from '../../src/workspace/resolve.js';
import { createManifest, writeManifest } from '../../src/workspace/manifest.js';
import { workspaceManifestPath } from '../../src/workspace/paths.js';
import { joinWorkspace } from '../../src/workspace/membership.js';
import { DEFAULT_CONFIG, saveConfig } from '../../src/core/config.js';
import { releaseAll } from '../../src/store/connection-pool.js';

/**
 * A fresh directory triple per test, rather than one triple wiped between them.
 *
 * `fs.rm` on a fixture root fails EBUSY on Windows -- a SQLite handle outlives `closeDb()` and
 * `releaseAll()` -- and the shared pattern in this directory swallows that with `.catch(() => {})`.
 * The wipe therefore never happens: state accumulates across tests, and a test asserting that
 * this repo holds *nothing* passes or fails on its position in the file. Sibling suites escape it
 * only because their one mutating test runs last.
 *
 * Numbering sidesteps the lock instead of fighting it. Nothing is ever removed mid-run, so
 * nothing can fail to be.
 */
let fixture = 0;
// Per test, not per file: KNOWL_HOME is process-global and vitest shares a process across
// files, so a literal workspace name lets one file overwrite another file's manifest.
let ws = '';
let HOME = '';
let A = '';
let B = '';

type Seed = { title: string; content: string; visibility: string };

async function seed(root: string, name: string, items: Seed[]) {
  await fs.mkdir(path.join(root, '.knowl'), { recursive: true });
  await saveConfig(root, { ...DEFAULT_CONFIG });
  await initDb(root);
  const projectId = (await repo.createProject(root, name)).id;
  for (const item of items) {
    const stored = await storeKnowledgeItemDeduped(projectId, {
      category: 'decision', title: item.title, content: item.content,
    });
    await getClient().execute({
      sql: 'UPDATE knowledge_items SET visibility = ?, origin_repo = ? WHERE id = ?',
      args: [item.visibility, name, stored.item.id],
    });
  }
  await closeDb();
}

/** Adds items to an already-linked repo, without rewriting the config that holds the link. */
async function addItems(root: string, name: string, items: Seed[]) {
  await initDb(root);
  const projectId = (await repo.createProject(root, name)).id;
  for (const item of items) {
    const stored = await storeKnowledgeItemDeduped(projectId, {
      category: 'decision', title: item.title, content: item.content,
    });
    await getClient().execute({
      sql: 'UPDATE knowledge_items SET visibility = ?, origin_repo = ? WHERE id = ?',
      args: [item.visibility, name, stored.item.id],
    });
  }
  await closeDb();
}

async function federate(query: string, limit: number, repos?: string[]) {
  await initDb(A);
  try {
    const active = (await resolveWorkspace(A))!;
    return await queryFederated({ workspace: active, query, limit, repos });
  } finally {
    await closeDb();
  }
}

/**
 * The reported bug in fixture form: repo `a` has never touched deployment and repo `b` has.
 *
 * Asking `a` about deployment used to return `b`'s answer in a shape indistinguishable from
 * `a`'s own, because local and peer candidates were fused into one ranking and the top rows won
 * outright. What separates them now is ownership, not score.
 */
describe('federated grouping', () => {
  beforeEach(async () => {
    fixture += 1;
    ws = `slot${fixture}`;
    HOME = path.resolve(`./.knowl-slot-${fixture}-home`);
    A = path.resolve(`./.knowl-slot-${fixture}-a`);
    B = path.resolve(`./.knowl-slot-${fixture}-b`);
    process.env.KNOWL_HOME = HOME;
    await closeDb();
    await releaseAll();
    await writeManifest(workspaceManifestPath(ws), createManifest(ws, null));
    await seed(A, 'a', [
      { title: 'Local auth note', content: 'Auth tokens expire locally.', visibility: 'repo' },
    ]);
    await seed(B, 'b', [
      { title: 'Deploy runs on tag push', content: 'Deployment is triggered by pushing a tag.', visibility: 'workspace' },
    ]);
    await joinWorkspace({ projectRoot: A, workspaceName: ws, repoName: 'a' });
    await joinWorkspace({ projectRoot: B, workspaceName: ws, repoName: 'b' });
  }, 120_000);

  afterEach(async () => {
    delete process.env.KNOWL_HOME;
    await closeDb();
    await releaseAll();
  }, 120_000);

  // Removal is deferred to the very end, where every handle is closed and EBUSY cannot fire.
  // Best-effort even here: a leftover fixture directory is residue, while a failed teardown
  // that fails the run is a false red.
  afterAll(async () => {
    for (let index = 1; index <= fixture; index += 1) {
      for (const suffix of ['home', 'a', 'b']) {
        await fs.rm(path.resolve(`./.knowl-slot-${index}-${suffix}`), { recursive: true, force: true })
          .catch(() => {});
      }
    }
  }, 120_000);

  it('groups by repo when a peer row wins a slot, with local first and empty', async () => {
    const result = await federate('deployment tag push', 5);

    expect(result.shape).toBe('grouped');
    expect(result.groups[0].repo).toBe('a');
    expect(result.groups[0].items).toEqual([]);
    expect(result.groups[1].repo).toBe('b');
    expect(result.groups[1].items[0].title).toBe('Deploy runs on tag push');
  }, 120_000);

  it('stays flat when every returned row is local', async () => {
    const result = await federate('auth tokens expire', 5);

    expect(result.shape).toBe('flat');
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0].repo).toBe('a');
    expect(result.groups[0].items[0].title).toBe('Local auth note');
  }, 120_000);

  it('keeps every row of one repo together, rather than interleaving by score', async () => {
    // What grouping actually changes. Page membership is still the ranker's -- an ownership
    // priority that gave local every slot before any peer was measured against
    // `docs/evals/cross-repo-archetypes.json` and collapsed recall on all five archetypes,
    // because `perRepoCap` admits ten candidates per repo whatever their quality and peers
    // never reached the page. See `groupingCost` in the baseline for the numbers.
    await addItems(A, 'a', [
      { title: 'Deploy notes for a', content: 'Deployment here is manual.', visibility: 'repo' },
    ]);
    const result = await federate('deployment', 5);

    for (const group of result.groups) {
      expect(new Set(group.items.map(item => item.repo)).size).toBeLessThanOrEqual(1);
    }
    expect(result.groups.map(group => group.repo).sort()).toEqual(['a', 'b']);
  }, 120_000);

  it('orders groups by their best row, so a better peer answer is not buried', async () => {
    // Local first is a rule about an EMPTY local group, not a licence to outrank a better
    // answer. Local matches one query term here and the peer matches three; pushing the peer
    // below this repo's weaker row would overturn the ranker's verdict under the reader, which
    // is exactly what cost recall on all five archetypes.
    await addItems(A, 'a', [
      { title: 'Deployment mentioned once', content: 'Deployment is someone else problem.', visibility: 'repo' },
    ]);
    const result = await federate('deployment tag push', 5);

    expect(result.groups.map(group => group.repo)).toEqual(['b', 'a']);
  }, 120_000);

  it('reports a peer match that won no slot, by name and count only', async () => {
    // Two matching rows in the peer, one slot. The row that misses is named and counted, never
    // quoted -- content in a pointer would reintroduce exactly the silent substitution that
    // grouping exists to remove.
    await addItems(B, 'b', [
      { title: 'Deploy also needs a changelog', content: 'Deployment requires a changelog entry.', visibility: 'workspace' },
    ]);
    const result = await federate('deployment', 1);

    expect(result.unshown).toEqual([{ repo: 'b', matches: 1 }]);
  }, 120_000);

  it('never returns more than the limit across all groups', async () => {
    await addItems(A, 'a', [
      { title: 'Deploy notes for a', content: 'Deployment here is manual.', visibility: 'repo' },
    ]);
    const result = await federate('deployment', 2);
    const total = result.groups.reduce((count, group) => count + group.items.length, 0);

    expect(total).toBe(2);
  }, 120_000);

  it('flattens in group order, for callers that score one ranking', async () => {
    const result = await federate('deployment tag push', 5);

    expect(flattenGroups(result).map(item => item.repo)).toEqual(['b']);
  }, 120_000);
});
