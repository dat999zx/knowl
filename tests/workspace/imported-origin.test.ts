import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, getClient, initDb } from '../../src/store/database.js';
import { releaseAll } from '../../src/store/connection-pool.js';
import * as repo from '../../src/store/repository.js';
import { storeKnowledgeItemDeduped } from '../../src/store/knowledge-writer.js';
import { exportKnowledge, importKnowledge } from '../../src/store/portability.js';
import { resetWriteOwnershipCache } from '../../src/store/write-ownership.js';
import { createManifest, writeManifest } from '../../src/workspace/manifest.js';
import { workspaceManifestPath } from '../../src/workspace/paths.js';
import { joinWorkspace } from '../../src/workspace/membership.js';
import { promoteItems } from '../../src/workspace/promote.js';
import { assertOwnedItem } from '../../src/workspace/ownership.js';
import { resolveWorkspace } from '../../src/workspace/resolve.js';
import { KNOWLEDGE_CATEGORIES } from '../../src/core/types.js';
import { DEFAULT_CONFIG, loadConfig, saveConfig } from '../../src/core/config.js';

/**
 * K-58: an imported item is not the importer's to claim, and not the importer's to publish.
 *
 * Every case here starts from the same fact: a Knowl JSONL file is written by some other
 * store, and until version 3 it said nothing about which. `origin_repo NULL` in the file
 * therefore landed as `origin_repo NULL` in the database -- the same value a row this repo
 * wrote itself before it joined a workspace carries -- and every ownership rule downstream
 * reads NULL as "mine".
 */

let counter = 0;
let A = '';
let B = '';
let DUMP = '';
let WS = '';

async function makeRepo(root: string) {
  await fs.mkdir(path.join(root, '.knowl'), { recursive: true });
  await saveConfig(root, { ...DEFAULT_CONFIG });
}

async function session<T>(root: string, run: () => Promise<T>): Promise<T> {
  await initDb(root);
  try {
    return await run();
  } finally {
    await closeDb();
  }
}

async function write(root: string, title: string, content: string): Promise<string> {
  const projectId = (await repo.createProject(root, 'p')).id;
  const result = await storeKnowledgeItemDeduped(projectId, { category: 'decision', title, content });
  return result.item.id;
}

type Row = { originRepo: string | null; visibility: string };

async function rowsOf(root: string): Promise<Map<string, Row>> {
  return session(root, async () => {
    const result = await getClient().execute('SELECT title, origin_repo, visibility FROM knowledge_items');
    const rows = new Map<string, Row>();
    for (const row of result.rows) {
      rows.set(String(row.title), {
        originRepo: row.origin_repo === null ? null : String(row.origin_repo),
        visibility: String(row.visibility),
      });
    }
    return rows;
  });
}

/** Rewrites a Knowl JSONL file's records and recomputes the trailing manifest checksum. */
async function rewrite(file: string, transform: (records: any[]) => any[]) {
  const lines = (await fs.readFile(file, 'utf8')).split('\n').filter(Boolean);
  const records = transform(lines.slice(0, -1).map(line => JSON.parse(line)));
  const body = `${records.map(record => JSON.stringify(record)).join('\n')}\n`;
  const sha256 = crypto.createHash('sha256').update(body).digest('hex');
  await fs.writeFile(file, `${body}${JSON.stringify({ type: 'manifest', sha256 })}\n`, 'utf8');
}

/** Link a repo without going through join's backfill, so ownership stays where the test put it. */
async function link(root: string, workspaceName: string, repoName: string) {
  const config = await loadConfig(root);
  await saveConfig(root, { ...config, workspace: { workspace: workspaceName, repo: repoName } });
}

describe('imported knowledge is not the importer\'s to claim or publish', () => {
  beforeEach(async () => {
    await closeDb();
    await releaseAll();
    resetWriteOwnershipCache();
    counter += 1;
    A = path.resolve(`./.knowl-k58-a${counter}`);
    B = path.resolve(`./.knowl-k58-b${counter}`);
    DUMP = path.resolve(`./.knowl-k58-dump${counter}.jsonl`);
    WS = `k58ws${counter}`;
    for (const dir of [A, B]) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    await fs.rm(DUMP, { force: true }).catch(() => {});
    await makeRepo(A);
    await makeRepo(B);
    await writeManifest(workspaceManifestPath(WS), createManifest(WS, null));
  });

  afterEach(async () => {
    await closeDb();
    await releaseAll();
    resetWriteOwnershipCache();
    for (const dir of [A, B]) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    await fs.rm(DUMP, { force: true }).catch(() => {});
    await fs.rm(workspaceManifestPath(WS), { force: true }).catch(() => {});
  });

  it('does not publish a third party\'s rows when B joins with --promote-existing', async () => {
    // The reproduction in full: A is a stranger's repo, unlinked, so its rows carry no owner.
    await session(A, async () => {
      await write(A, 'A owns the deploy key', 'The stranger\'s repo knows where the key lives.');
      await exportKnowledge('local', DUMP, A);
    });
    await session(B, async () => {
      await write(B, 'B caches for 60s', 'This repo genuinely wrote this before joining.');
      await importKnowledge(DUMP, { projectRoot: B });
    });

    await joinWorkspace({ projectRoot: B, workspaceName: WS, repoName: 'b' });
    const promoted = await promoteItems({
      projectRoot: B, repoName: 'b', categories: [...KNOWLEDGE_CATEGORIES], apply: true,
    });

    const rows = await rowsOf(B);
    // B's own pre-workspace row is B's: claimed on join, and promoted here.
    expect(rows.get('B caches for 60s')).toEqual({ originRepo: 'b', visibility: 'workspace' });
    // A's row is not. It must not be claimed and must not be published.
    expect(rows.get('A owns the deploy key')?.visibility).toBe('repo');
    expect(rows.get('A owns the deploy key')?.originRepo).not.toBe('b');
    expect(promoted.items.map(item => item.title)).toEqual(['B caches for 60s']);
    expect(promoted.skippedForeign).toBeGreaterThan(0);
  });

  it('does not claim an imported row on join', async () => {
    await session(A, async () => {
      await write(A, 'A owns the deploy key', 'The stranger\'s repo knows where the key lives.');
      await exportKnowledge('local', DUMP, A);
    });
    await session(B, () => importKnowledge(DUMP, { projectRoot: B }));

    await joinWorkspace({ projectRoot: B, workspaceName: WS, repoName: 'b' });

    expect((await rowsOf(B)).get('A owns the deploy key')?.originRepo).not.toBe('b');
  });

  it('does not honour a foreign export\'s workspace visibility', async () => {
    // Peers read a repo's database filtered on `visibility = 'workspace'` and nothing else,
    // so a row that arrives already marked workspace-visible is published to this repo's
    // peers on import -- no join, no promote, no flag. Carrying the field verbatim is only
    // right when both sides are the same workspace.
    await session(A, async () => {
      const id = await write(A, 'A shared this with its own peers', 'Not this repo\'s to republish.');
      await getClient().execute({
        sql: "UPDATE knowledge_items SET origin_repo = 'a', visibility = 'workspace' WHERE id = ?",
        args: [id],
      });
      await exportKnowledge('local', DUMP, A);
    });
    await session(B, () => importKnowledge(DUMP, { projectRoot: B }));

    expect((await rowsOf(B)).get('A shared this with its own peers')?.visibility).toBe('repo');
  });

  it('does not let a foreign owner name collide with a local repo of the same name', async () => {
    // A is linked as "server" in its own workspace, so its rows carry origin_repo = 'server'.
    // B is also "server", in a different workspace. The name is the ownership key, so the
    // imported rows read as B's own and promote publishes them.
    await session(A, async () => {
      const id = await write(A, 'A owns the deploy key', 'The stranger\'s repo knows where the key lives.');
      await getClient().execute({ sql: "UPDATE knowledge_items SET origin_repo = 'server' WHERE id = ?", args: [id] });
      await exportKnowledge('local', DUMP, A);
    });
    await session(B, () => importKnowledge(DUMP, { projectRoot: B }));

    await joinWorkspace({ projectRoot: B, workspaceName: WS, repoName: 'server' });
    const promoted = await promoteItems({
      projectRoot: B, repoName: 'server', categories: [...KNOWLEDGE_CATEGORIES], apply: true,
    });

    expect(promoted.items).toEqual([]);
    expect((await rowsOf(B)).get('A owns the deploy key')?.visibility).toBe('repo');
  });

  it('carries ownership verbatim between two machines of the same workspace', async () => {
    // The case the stamping must not break: one repo, two checkouts, both linked as "server"
    // in workspace WS. Here the file's owner names are in this repo's own namespace.
    const manifest = createManifest(WS, null);
    manifest.repos.push({ name: 'server', path: A, addedAt: new Date().toISOString() });
    await writeManifest(workspaceManifestPath(WS), manifest);
    await link(A, WS, 'server');
    await link(B, WS, 'server');

    await session(A, async () => {
      const id = await write(A, 'Retries cap at three', 'Outbound calls retry three times.');
      await getClient().execute({
        sql: "UPDATE knowledge_items SET origin_repo = 'server', visibility = 'workspace' WHERE id = ?",
        args: [id],
      });
      await exportKnowledge('local', DUMP, A);
    });
    await session(B, () => importKnowledge(DUMP, { projectRoot: B }));

    expect((await rowsOf(B)).get('Retries cap at three'))
      .toEqual({ originRepo: 'server', visibility: 'workspace' });
  });

  it('still lets this repo edit its own copy of an imported item', async () => {
    // The stamp must not turn into an edit ban. The ownership guard exists to stop an
    // operation reaching into another repo's live database; an imported row has no such
    // database behind it, and editing this copy changes nothing anywhere else -- which is
    // exactly what editing it did when it landed with a null owner.
    await session(A, async () => {
      await write(A, 'A owns the deploy key', 'The stranger\'s repo knows where the key lives.');
      await exportKnowledge('local', DUMP, A);
    });
    const id = await session(B, async () => {
      await importKnowledge(DUMP, { projectRoot: B });
      const rows = await getClient().execute('SELECT id FROM knowledge_items');
      return String(rows.rows[0].id);
    });
    await joinWorkspace({ projectRoot: B, workspaceName: WS, repoName: 'b' });

    await initDb(B);
    try {
      await expect(assertOwnedItem(id, (await resolveWorkspace(B))!)).resolves.toBeUndefined();
    } finally {
      await closeDb();
    }
  });

  it('treats a version-2 file, which names no exporter, as unknown rather than as mine', async () => {
    await session(A, async () => {
      await write(A, 'A owns the deploy key', 'The stranger\'s repo knows where the key lives.');
      await exportKnowledge('local', DUMP, A);
    });
    // Downgrade to exactly what 2.9.x wrote: version 2, and no origin block.
    await rewrite(DUMP, records => records.map(record => {
      if (record.type !== 'header') return record;
      const { origin, ...rest } = record;
      return { ...rest, version: 2 };
    }));

    const result = await session(B, () => importKnowledge(DUMP, { projectRoot: B }));
    // Still imports: a version-2 file is readable, and refusing it would strand every export
    // written before this build.
    expect(result.inserted).toBe(1);

    await joinWorkspace({ projectRoot: B, workspaceName: WS, repoName: 'b' });
    const promoted = await promoteItems({
      projectRoot: B, repoName: 'b', categories: [...KNOWLEDGE_CATEGORIES], apply: true,
    });

    expect(promoted.items).toEqual([]);
    expect((await rowsOf(B)).get('A owns the deploy key')?.originRepo).not.toBe('b');
  });
});
