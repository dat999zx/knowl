import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { closeDb, getClient, getDb, initDb } from '../../src/store/database.js';
import { releaseAll } from '../../src/store/connection-pool.js';
import * as repo from '../../src/store/repository.js';
import { DEFAULT_CONFIG, saveConfig } from '../../src/core/config.js';
import { storeKnowledgeAtomsDeduped } from '../../src/store/knowledge-writer.js';
import { flagCorrectionSiblings } from '../../src/store/blast-radius.js';
import { startMemorySession } from '../../src/store/session-repository.js';
import { createSnapshot } from '../../src/store/snapshots.js';
import { upgradeExistingRepository } from '../../src/cli/upgrade.js';
import { claimCapture, HOOK_CAPTURE_DEBOUNCE_MS } from '../../src/store/hook-debounce.js';
import {
  CLAIM_SWEEP_BUDGET,
  CLAIM_MAX_AGE_MS,
  COMMIT_PAYLOAD_HORIZON_DAYS,
  MODEL_CACHE_HORIZON_DAYS,
  SNAPSHOT_KEEP,
  adoptLegacyModelCache,
  compactKnowledgeCommits,
  pruneModelCache,
  purgeExpiredMemorySessions,
  sweepDebounceClaims,
} from '../../src/store/retention.js';
import type { NormalizedHostHook } from '../../src/cli/agents/host-hook.js';

/**
 * K-43, K-44 and K-48 are one finding wearing three hats: nothing in this system ever
 * deletes anything. Snapshots accumulate on a schedule because the sync habit sweeps every
 * repository; debounce claim files accumulate one per tool call and are dead 1500ms later;
 * commit rows keep a full before/after copy of every item they touched, forever.
 *
 * So one policy module, applied at the three points where the growth actually happens,
 * rather than three sweeps someone has to remember to run.
 */

const ROOT = path.resolve('.knowl-retention-test');
const SNAPSHOT_DIR = path.join(ROOT, '.knowl', 'snapshots');
const CLAIM_DIR = path.join(ROOT, '.knowl', 'cache', 'hook-debounce');

const daysAgo = (days: number) => new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

function hook(overrides: Partial<NormalizedHostHook> = {}): NormalizedHostHook {
  return {
    host: 'claude',
    event: 'session-event',
    externalSessionId: 'retention-session',
    projectRoot: ROOT,
    type: 'checkpoint',
    payload: { summary: 'Tool completed' },
    captureKey: 'Read:{"file_path":"a.ts"}',
    ...overrides,
  } as NormalizedHostHook;
}

async function writeStaleClaims(count: number, ageMs: number): Promise<string[]> {
  await fs.mkdir(CLAIM_DIR, { recursive: true });
  const written: string[] = [];
  const when = new Date(Date.now() - ageMs);
  for (let i = 0; i < count; i++) {
    const file = path.join(CLAIM_DIR, `${String(i).padStart(4, '0')}${'a'.repeat(60)}.claim`);
    await fs.writeFile(file, `${Date.now() - ageMs}\n`, 'utf8');
    await fs.utimes(file, when, when);
    written.push(file);
  }
  return written;
}

const claimCount = () => fsSync.readdirSync(CLAIM_DIR).filter(name => name.endsWith('.claim')).length;

describe('retention', () => {
  let projectId = '';

  beforeAll(async () => {
    await fs.rm(ROOT, { recursive: true, force: true }).catch(() => {});
    await fs.mkdir(path.join(ROOT, '.knowl'), { recursive: true });
    await saveConfig(ROOT, { ...DEFAULT_CONFIG });
    await initDb(ROOT);
    projectId = (await repo.createProject(ROOT, 'Retention test')).id;
  });

  afterAll(async () => {
    await closeDb();
    await releaseAll();
    await fs.rm(ROOT, { recursive: true, force: true }).catch(() => {});
  });

  describe('K-44: hook debounce claim files', () => {
    beforeEach(async () => {
      await fs.rm(CLAIM_DIR, { recursive: true, force: true }).catch(() => {});
      await fs.mkdir(CLAIM_DIR, { recursive: true });
    });

    it('removes claims that are past any possible use', async () => {
      const stale = await writeStaleClaims(5, CLAIM_MAX_AGE_MS * 2);
      expect(claimCount()).toBe(5);

      expect(claimCapture(hook())).toBe(true);

      for (const file of stale) expect(fsSync.existsSync(file)).toBe(false);
      // Its own claim survives: the window is what the file is for.
      expect(claimCount()).toBe(1);
    });

    it('leaves a claim that is still inside the debounce window', async () => {
      const live = hook({ captureKey: 'Grep:{"pattern":"x"}' });
      expect(claimCapture(live)).toBe(true);
      expect(claimCount()).toBe(1);

      // A different capture, moments later: the live claim must still be there to debounce.
      expect(claimCapture(hook({ captureKey: 'Read:{"file_path":"b.ts"}' }))).toBe(true);
      expect(claimCount()).toBe(2);
      expect(claimCapture(live)).toBe(false);
    });

    it('bounds one sweep so the first pass over a huge directory does not stall a turn', async () => {
      // The budget is a parameter, so the bounding is testable without writing seven
      // thousand files: what matters is that one pass stops at the budget and the next
      // continues, rather than one turn paying for all of history.
      await writeStaleClaims(11, CLAIM_MAX_AGE_MS * 2);

      expect(sweepDebounceClaims(CLAIM_DIR, Date.now(), CLAIM_MAX_AGE_MS, 4)).toBe(4);
      expect(claimCount()).toBe(7);
      expect(sweepDebounceClaims(CLAIM_DIR, Date.now(), CLAIM_MAX_AGE_MS, 4)).toBe(4);
      expect(sweepDebounceClaims(CLAIM_DIR, Date.now(), CLAIM_MAX_AGE_MS, 4)).toBe(3);
      expect(claimCount()).toBe(0);
    });

    it('is dead only well after the window it enforces, and bounded per pass', () => {
      expect(CLAIM_MAX_AGE_MS).toBeGreaterThan(HOOK_CAPTURE_DEBOUNCE_MS * 10);
      expect(CLAIM_SWEEP_BUDGET).toBeGreaterThan(0);
      expect(Number.isFinite(CLAIM_SWEEP_BUDGET)).toBe(true);
    });
  });

  describe('K-43: snapshots', () => {
    beforeEach(async () => {
      await fs.rm(SNAPSHOT_DIR, { recursive: true, force: true }).catch(() => {});
    });

    it('keeps a bounded number and reports what it removed', async () => {
      const made: string[] = [];
      for (let i = 0; i < SNAPSHOT_KEEP + 2; i++) {
        const snapshot = await createSnapshot(ROOT);
        made.push(snapshot.path);
        // Distinct mtimes: "newest" has to be decidable.
        const when = new Date(Date.now() - (SNAPSHOT_KEEP + 2 - i) * 60_000);
        await fs.utimes(snapshot.path, when, when);
      }

      const last = await createSnapshot(ROOT);

      const remaining = (await fs.readdir(SNAPSHOT_DIR)).filter(name => name.endsWith('.db'));
      expect(remaining).toHaveLength(SNAPSHOT_KEEP);
      expect(remaining).toContain(path.basename(last.path));
      expect(last.pruned.length).toBeGreaterThan(0);

      // A manifest never outlives its snapshot, and vice versa.
      for (const pruned of last.pruned) expect(fsSync.existsSync(pruned)).toBe(false);
      for (const name of remaining) {
        expect(fsSync.existsSync(path.join(SNAPSHOT_DIR, `${name}.manifest.json`))).toBe(true);
      }
    });

    it('names every snapshot it pruned, through the CLI', async () => {
      for (let i = 0; i < SNAPSHOT_KEEP + 1; i++) await createSnapshot(ROOT);
      const before = (await fs.readdir(SNAPSHOT_DIR)).filter(name => name.endsWith('.db'));
      expect(before).toHaveLength(SNAPSHOT_KEEP);
      await closeDb();

      const result = spawnSync(process.execPath, [path.resolve('./dist/index.js'), 'snapshot', 'create'], {
        cwd: ROOT, encoding: 'utf8',
      });
      await initDb(ROOT);

      expect(result.status, result.stderr).toBe(0);
      // A snapshot that disappears without being named is the one someone goes looking for.
      expect(result.stdout).toContain('Pruned:');
      expect(result.stdout).toMatch(/Pruned: .+\.db/);
    });

    it('touches nothing it did not put there', async () => {
      await fs.mkdir(SNAPSHOT_DIR, { recursive: true });
      const stranger = path.join(SNAPSHOT_DIR, 'why-is-this-here.txt');
      await fs.writeFile(stranger, 'a human put this here', 'utf8');

      for (let i = 0; i < SNAPSHOT_KEEP + 2; i++) await createSnapshot(ROOT);

      expect(fsSync.existsSync(stranger)).toBe(true);
    });
  });

  describe('K-48: commit payloads and expired sessions', () => {
    beforeEach(async () => {
      const db = getDb() as any;
      await db.run(sql`DELETE FROM knowledge_commits`);
      await db.run(sql`DELETE FROM knowledge_items`);
      await db.run(sql`DELETE FROM memory_sessions`);
    });

    it('drops the before/after snapshots from commits past the horizon', async () => {
      const batch = await storeKnowledgeAtomsDeduped(projectId, [
        { category: 'fact', title: 'Port is 5000', content: 'The dev server listens on port 5000.' },
        { category: 'fact', title: 'Database is Postgres', content: 'Primary storage is Postgres, not SQLite.' },
      ]);
      expect(batch.itemIds).toHaveLength(2);

      const client = getClient();
      await client.execute({
        sql: 'UPDATE knowledge_commits SET created_at = ?',
        args: [daysAgo(COMMIT_PAYLOAD_HORIZON_DAYS + 1)],
      });
      const before = (await client.execute('SELECT changes FROM knowledge_commits')).rows[0];
      expect(String(before.changes)).toContain('"after"');

      const compacted = await compactKnowledgeCommits();
      expect(compacted.commits).toBeGreaterThan(0);
      expect(compacted.bytesFreed).toBeGreaterThan(0);

      const after = (await client.execute('SELECT changes FROM knowledge_commits')).rows[0];
      expect(String(after.changes)).not.toContain('"before"');
      expect(String(after.changes)).not.toContain('"after"');
      // What changed, and to which item, is the part the audit trail is for.
      expect(String(after.changes)).toContain(batch.itemIds[0]);
      expect(String(after.changes)).toContain('"action"');
    });

    it('keeps the last copy of a hard-deleted item however old the commit is', async () => {
      const batch = await storeKnowledgeAtomsDeduped(projectId, [
        { category: 'fact', title: 'Ephemeral fact', content: 'This one is about to be deleted.' },
      ]);
      const client = getClient();
      await repo.createKnowledgeCommit(projectId, 'Hard delete', [{
        itemId: batch.itemIds[0],
        action: 'delete',
        before: { id: batch.itemIds[0], title: 'Ephemeral fact', content: 'This one is about to be deleted.' } as any,
        after: null,
      }]);
      await client.execute({
        sql: 'UPDATE knowledge_commits SET created_at = ?',
        args: [daysAgo(COMMIT_PAYLOAD_HORIZON_DAYS + 1)],
      });

      await compactKnowledgeCommits();

      const rows = (await client.execute("SELECT changes FROM knowledge_commits WHERE changes LIKE '%delete%'")).rows;
      // A hard delete is the only action whose item is not still in knowledge_items, so this
      // payload is the last copy there is.
      expect(String(rows[0].changes)).toContain('This one is about to be deleted.');
    });

    it('leaves recent commits whole', async () => {
      await storeKnowledgeAtomsDeduped(projectId, [
        { category: 'fact', title: 'Cache lives in the home directory', content: 'The embedding cache is machine-wide.' },
      ]);

      const compacted = await compactKnowledgeCommits();

      expect(compacted.commits).toBe(0);
      const row = (await getClient().execute('SELECT changes FROM knowledge_commits')).rows[0];
      expect(String(row.changes)).toContain('"after"');
    });

    it('keeps blast radius working on a compacted history', async () => {
      const batch = await storeKnowledgeAtomsDeduped(projectId, [
        { category: 'fact', title: 'Queue is Redis', content: 'Background jobs run through Redis.' },
        { category: 'fact', title: 'Queue retries thrice', content: 'A failed job is retried three times.' },
      ]);
      await getClient().execute({
        sql: 'UPDATE knowledge_commits SET created_at = ?',
        args: [daysAgo(COMMIT_PAYLOAD_HORIZON_DAYS + 1)],
      });
      await compactKnowledgeCommits();

      const result = await flagCorrectionSiblings(projectId, batch.itemIds[0], 'a correction');

      expect(result.flaggedIds).toContain(batch.itemIds[1]);
    });

    it('runs from `knowl upgrade`, which is the sweep that already visits every repo', async () => {
      const client = getClient();
      await storeKnowledgeAtomsDeduped(projectId, [
        { category: 'fact', title: 'Upgrade sweeps this repo', content: 'The sync habit visits every repository.' },
      ]);
      await client.execute({
        sql: 'UPDATE knowledge_commits SET created_at = ?',
        args: [daysAgo(COMMIT_PAYLOAD_HORIZON_DAYS + 1)],
      });
      const dead = await startMemorySession({ title: 'Expired before the upgrade' });
      await client.execute({
        sql: 'UPDATE memory_sessions SET expires_at = ? WHERE id = ?',
        args: [daysAgo(1), dead.id],
      });
      await closeDb();

      const result = await upgradeExistingRepository(ROOT, 'Retention test');

      expect(result.retention.commits).toBeGreaterThan(0);
      expect(result.retention.sessions).toBe(1);

      await initDb(ROOT);
      const rows = (await getClient().execute('SELECT changes FROM knowledge_commits')).rows;
      expect(rows.every(row => !String(row.changes).includes('"after"'))).toBe(true);
    });

    it('deletes memory sessions that have outlived their own expiry', async () => {
      const live = await startMemorySession({ title: 'Still running' });
      const dead = await startMemorySession({ title: 'Long gone' });
      await getClient().execute({
        sql: 'UPDATE memory_sessions SET expires_at = ? WHERE id = ?',
        args: [daysAgo(1), dead.id],
      });

      const purged = await purgeExpiredMemorySessions();

      expect(purged).toBe(1);
      const ids = (await getClient().execute('SELECT id FROM memory_sessions')).rows.map(row => String(row.id));
      expect(ids).toContain(live.id);
      expect(ids).not.toContain(dead.id);
    });
  });
});

/**
 * K-42's retention half.
 *
 * The forward half shipped: a new download resolves to a shared cache under `knowlHome()`
 * instead of `<repo>/.knowl/models`. What it deliberately did not do is touch what was
 * already on disk, because switching the path outright would have orphaned it. Measured on
 * one machine: DuckPrep-server 71 files / 2,495 MB across 16 models, SAT-tests-server and
 * students 8 files / 336 MB each and byte-identical. Roughly 2.8 GB duplicated or dead.
 *
 * So `knowl upgrade` adopts the tree and then prunes what nothing names. Both halves obey the
 * same two rules as the rest of this module: an interrupted adoption must never leave the
 * only copy of a model missing, and nothing is removed that this module did not put there.
 */
const MODELS_ROOT = path.resolve('.knowl-models-test');
const SHARED = path.join(MODELS_ROOT, 'shared');
const MODEL_REPO = path.join(MODELS_ROOT, 'repo');
const LEGACY = path.join(MODEL_REPO, '.knowl', 'models');

const ARCTIC = 'Snowflake/snowflake-arctic-embed-m-v2.0';
const MINILM = 'Xenova/all-MiniLM-L6-v2';

/** The real on-disk shape: config + tokenizer beside an `onnx/` directory of weights. */
async function writeModel(cacheDir: string, model: string, weightBytes = 64): Promise<void> {
  const dir = path.join(cacheDir, ...model.split('/'));
  await fs.mkdir(path.join(dir, 'onnx'), { recursive: true });
  await fs.writeFile(path.join(dir, 'config.json'), '{"model_type":"bert"}', 'utf8');
  await fs.writeFile(path.join(dir, 'tokenizer.json'), '{"version":"1.0"}', 'utf8');
  await fs.writeFile(path.join(dir, 'onnx', 'model_quantized.onnx'), Buffer.alloc(weightBytes, 7));
}

async function listAllFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (current: string) => {
    let entries;
    try { entries = await fs.readdir(current, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const next = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(next); else out.push(next);
    }
  };
  await walk(dir);
  return out;
}

const weightsPath = (cacheDir: string, model: string) =>
  path.join(cacheDir, ...model.split('/'), 'onnx', 'model_quantized.onnx');

const hasModel = (cacheDir: string, model: string) => fsSync.existsSync(weightsPath(cacheDir, model));

async function ageModel(cacheDir: string, model: string, days: number): Promise<void> {
  const when = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const dir = path.join(cacheDir, ...model.split('/'));
  for (const file of ['config.json', 'tokenizer.json', path.join('onnx', 'model_quantized.onnx')]) {
    await fs.utimes(path.join(dir, file), when, when);
  }
}

describe('K-42: the model cache', () => {
  beforeEach(async () => {
    await fs.rm(MODELS_ROOT, { recursive: true, force: true }).catch(() => {});
    await fs.mkdir(SHARED, { recursive: true });
  });

  afterAll(async () => {
    await fs.rm(MODELS_ROOT, { recursive: true, force: true }).catch(() => {});
  });

  describe('adoption', () => {
    it('moves a model the shared cache does not have, and frees the repo copy', async () => {
      await writeModel(LEGACY, ARCTIC, 4096);

      const report = await adoptLegacyModelCache(LEGACY, SHARED);

      expect(hasModel(SHARED, ARCTIC)).toBe(true);
      expect(fsSync.existsSync(LEGACY)).toBe(false);
      expect(report.adopted).toBe(3);
      expect(report.bytesFreed).toBeGreaterThan(4096);
    });

    it('drops a duplicate without rewriting the copy that is already shared', async () => {
      // Two of the three repos measured held byte-identical 336 MB trees. Copying them over
      // each other would move a third of a gigabyte to change nothing.
      await writeModel(SHARED, ARCTIC, 4096);
      await writeModel(LEGACY, ARCTIC, 4096);
      const before = (await fs.stat(weightsPath(SHARED, ARCTIC))).mtimeMs;

      const report = await adoptLegacyModelCache(LEGACY, SHARED);

      expect((await fs.stat(weightsPath(SHARED, ARCTIC))).mtimeMs).toBe(before);
      expect(fsSync.existsSync(LEGACY)).toBe(false);
      expect(report.adopted).toBe(0);
      expect(report.deduplicated).toBe(3);
    });

    it('keeps both copies and says so when they disagree', async () => {
      // Different sizes mean different revisions of the same file. Neither one is safe to
      // declare the loser, so nothing is deleted and the path is reported.
      await writeModel(SHARED, ARCTIC, 4096);
      await writeModel(LEGACY, ARCTIC, 8192);

      const report = await adoptLegacyModelCache(LEGACY, SHARED);

      expect(hasModel(LEGACY, ARCTIC)).toBe(true);
      expect((await fs.stat(weightsPath(SHARED, ARCTIC))).size).toBe(4096);
      expect(report.conflicts).toHaveLength(1);
      expect(report.conflicts[0]).toContain('model_quantized.onnx');
    });

    it('never leaves the only copy missing when the copy fails partway', async () => {
      // The one rule that matters. The source is unlinked only after the destination is
      // completely written and renamed into place, so every interruption point has at least
      // one whole copy of the weights.
      await writeModel(LEGACY, ARCTIC, 4096);

      const report = await adoptLegacyModelCache(LEGACY, SHARED, {
        copyFile: async () => { throw new Error('disk full'); },
      });

      expect(report.adopted).toBe(0);
      expect(hasModel(LEGACY, ARCTIC)).toBe(true);
      expect(hasModel(SHARED, ARCTIC)).toBe(false);
      // And no half-written file left looking like a model to the next resolver.
      const onnx = path.join(SHARED, ...ARCTIC.split('/'), 'onnx');
      const leftovers = fsSync.existsSync(onnx) ? await fs.readdir(onnx) : [];
      expect(leftovers).toEqual([]);
    });

    it('collects a partial file a killed run left behind', async () => {
      const onnx = path.join(SHARED, ...ARCTIC.split('/'), 'onnx');
      await fs.mkdir(onnx, { recursive: true });
      const orphan = path.join(onnx, 'model_quantized.onnx.9999.knowl-partial');
      await fs.writeFile(orphan, Buffer.alloc(128));
      await fs.utimes(orphan, new Date(Date.now() - 86_400_000), new Date(Date.now() - 86_400_000));
      await writeModel(LEGACY, ARCTIC, 4096);

      await adoptLegacyModelCache(LEGACY, SHARED);

      expect(fsSync.existsSync(orphan)).toBe(false);
      expect(hasModel(SHARED, ARCTIC)).toBe(true);
    });

    it('collects one even when the tree it came from is already gone', async () => {
      // Found by killing a real migration: SIGKILL during the last file leaves an orphan
      // behind an emptied legacy tree, and a sweep that only runs when there is something
      // left to adopt would never come back for it. It was 110 MB.
      const onnx = path.join(SHARED, ...ARCTIC.split('/'), 'onnx');
      await fs.mkdir(onnx, { recursive: true });
      const orphan = path.join(onnx, 'model_quantized.onnx.11300.knowl-partial');
      await fs.writeFile(orphan, Buffer.alloc(128));
      await fs.utimes(orphan, new Date(Date.now() - 86_400_000), new Date(Date.now() - 86_400_000));

      await adoptLegacyModelCache(LEGACY, SHARED);

      expect(fsSync.existsSync(orphan)).toBe(false);
    });

    it('leaves a partial another upgrade is still writing', async () => {
      // Two upgrades can overlap. Taking a live partial costs the other process a gigabyte
      // of recopying and buys nothing.
      const onnx = path.join(SHARED, ...ARCTIC.split('/'), 'onnx');
      await fs.mkdir(onnx, { recursive: true });
      const inflight = path.join(onnx, 'model_quantized.onnx.4242.knowl-partial');
      await fs.writeFile(inflight, Buffer.alloc(128));

      await adoptLegacyModelCache(LEGACY, SHARED);

      expect(fsSync.existsSync(inflight)).toBe(true);
    });

    it('does nothing at all when there is no legacy tree', async () => {
      const report = await adoptLegacyModelCache(LEGACY, SHARED);

      expect(report).toMatchObject({ adopted: 0, deduplicated: 0, bytesFreed: 0 });
      expect(await fs.readdir(SHARED)).toEqual([]);
    });
  });

  describe('pruning', () => {
    it('removes a model no repository on this machine names', async () => {
      await writeModel(SHARED, ARCTIC);
      await writeModel(SHARED, MINILM);
      await ageModel(SHARED, MINILM, MODEL_CACHE_HORIZON_DAYS + 1);

      const report = await pruneModelCache(SHARED, [ARCTIC]);

      expect(hasModel(SHARED, ARCTIC)).toBe(true);
      expect(hasModel(SHARED, MINILM)).toBe(false);
      expect(report.pruned).toEqual([path.join(SHARED, ...MINILM.split('/'))]);
    });

    it('keeps a model some config names however old it is', async () => {
      // This is what stops a running `serve` losing its weights: the model it loaded is the
      // model its config names, and a named model is never pruned. The filesystem is no help
      // here -- measured on this machine, an open file can be deleted and the holder keeps
      // reading it, so "it is in use" is not something the OS will refuse on our behalf.
      await writeModel(SHARED, ARCTIC);
      await ageModel(SHARED, ARCTIC, MODEL_CACHE_HORIZON_DAYS * 10);

      const report = await pruneModelCache(SHARED, [ARCTIC]);

      expect(hasModel(SHARED, ARCTIC)).toBe(true);
      expect(report.pruned).toEqual([]);
    });

    it('leaves an unnamed model alone until it is past the horizon', async () => {
      // A model-selection sweep downloads a dozen models no config names, and running an
      // upgrade the next morning must not undo the afternoon.
      await writeModel(SHARED, MINILM);

      const report = await pruneModelCache(SHARED, [ARCTIC]);

      expect(hasModel(SHARED, MINILM)).toBe(true);
      expect(report.pruned).toEqual([]);
    });

    it('prunes nothing when it could not find out what is named', async () => {
      // Fail closed. An empty keep set means the configs could not be read, not that no
      // model is wanted, and the difference is 2.5 GB.
      await writeModel(SHARED, ARCTIC);
      await ageModel(SHARED, ARCTIC, MODEL_CACHE_HORIZON_DAYS + 1);

      const report = await pruneModelCache(SHARED, []);

      expect(hasModel(SHARED, ARCTIC)).toBe(true);
      expect(report.pruned).toEqual([]);
    });


    it('never leaves a model that exists but has lost its weights', async () => {
      // `fs.rm(recursive)` is not atomic, and on Windows it does not even stop when it
      // fails: measured, it rejects with EBUSY on a locked file while sibling deletions
      // carry on in the background for hundreds of milliseconds afterwards. A prune that
      // dies partway through a model directory therefore leaves the directory present and
      // the weights gone -- and `resolveModelCache` decides a model is cached by asking
      // whether that directory EXISTS. The model would read as present and fail to load.
      //
      // So the directory leaves the cache's namespace in one atomic rename, and only the
      // renamed copy is deleted. Whether that delete succeeds decides how much disk is
      // reclaimed, never whether the cache is coherent.
      await writeModel(SHARED, MINILM);
      await ageModel(SHARED, MINILM, MODEL_CACHE_HORIZON_DAYS + 1);

      const report = await pruneModelCache(SHARED, [ARCTIC], Date.now(), MODEL_CACHE_HORIZON_DAYS, {
        removeTree: async () => { throw new Error('EBUSY'); },
      });

      // Gone from where a resolver looks, even though the delete failed.
      expect(fsSync.existsSync(path.join(SHARED, ...MINILM.split('/')))).toBe(false);
      expect(report.pruned).toEqual([path.join(SHARED, ...MINILM.split('/'))]);
    });

    it('collects the leftovers of a prune that could not finish', async () => {
      await writeModel(SHARED, MINILM);
      await ageModel(SHARED, MINILM, MODEL_CACHE_HORIZON_DAYS + 1);
      await pruneModelCache(SHARED, [ARCTIC], Date.now(), MODEL_CACHE_HORIZON_DAYS, {
        removeTree: async () => { throw new Error('EBUSY'); },
      });
      const stranded = await listAllFiles(SHARED);
      expect(stranded.length).toBeGreaterThan(0);

      await pruneModelCache(SHARED, [ARCTIC]);

      expect(await listAllFiles(SHARED)).toEqual([]);
    });

    it('stays inside the cache it was given, even through a link out of it', async () => {
      // The one way a directory walk reaches somewhere it was never pointed at. Nothing
      // above the cache root is ever a candidate, and a link is removed as a link.
      const outside = path.join(MODELS_ROOT, 'not-the-cache');
      await fs.mkdir(outside, { recursive: true });
      await fs.writeFile(path.join(outside, 'precious.bin'), Buffer.alloc(16));
      await fs.mkdir(path.join(SHARED, 'Xenova'), { recursive: true });
      let linked = true;
      try {
        await fs.symlink(outside, path.join(SHARED, 'Xenova', 'escape'), 'junction');
      } catch {
        linked = false; // unprivileged Windows without developer mode
      }
      await writeModel(SHARED, ARCTIC);

      await pruneModelCache(SHARED, [ARCTIC], Date.now() + 400 * 86_400_000);

      expect(fsSync.existsSync(path.join(outside, 'precious.bin'))).toBe(true);
      expect(linked).toBe(true);
    });

    it('reads no ambient state, so two caches pruned at once cannot reach each other', async () => {
      // `pruneModelCache` takes its cache and its keep set as arguments and consults no
      // environment: KNOWL_HOME moving under it -- which is exactly what a suite does
      // between tests -- can never redirect a prune that is already running.
      const other = path.join(MODELS_ROOT, 'other-home', 'models');
      await fs.mkdir(other, { recursive: true });
      await writeModel(SHARED, ARCTIC);
      await writeModel(SHARED, MINILM);
      await writeModel(other, ARCTIC);
      await writeModel(other, MINILM);
      for (const cache of [SHARED, other]) {
        await ageModel(cache, ARCTIC, MODEL_CACHE_HORIZON_DAYS + 1);
        await ageModel(cache, MINILM, MODEL_CACHE_HORIZON_DAYS + 1);
      }

      process.env.KNOWL_HOME = path.join(MODELS_ROOT, 'a-third-home-entirely');
      const [mine, theirs] = await Promise.all([
        pruneModelCache(SHARED, [ARCTIC]),
        pruneModelCache(other, [MINILM]),
      ]);
      delete process.env.KNOWL_HOME;

      // Each honoured its own keep set, and neither touched the other's cache.
      expect(hasModel(SHARED, ARCTIC)).toBe(true);
      expect(hasModel(SHARED, MINILM)).toBe(false);
      expect(hasModel(other, MINILM)).toBe(true);
      expect(hasModel(other, ARCTIC)).toBe(false);
      expect(mine.pruned).toEqual([path.join(SHARED, ...MINILM.split('/'))]);
      expect(theirs.pruned).toEqual([path.join(other, ...ARCTIC.split('/'))]);
    });

    it('leaves a model another process is still downloading', async () => {
      // Two upgrades can overlap, and the shared cache is written by every repo's processes.
      // A model directory that exists but holds only an in-flight file is the shape of a
      // download in progress -- and its file is by definition new, so the horizon covers it.
      const onnx = path.join(SHARED, ...MINILM.split('/'), 'onnx');
      await fs.mkdir(onnx, { recursive: true });
      await fs.writeFile(path.join(onnx, 'model_quantized.onnx.tmp.4242.a1b2'), Buffer.alloc(32));

      const report = await pruneModelCache(SHARED, [ARCTIC]);

      expect(fsSync.existsSync(onnx)).toBe(true);
      expect(report.pruned).toEqual([]);
    });

    it('touches nothing it did not put there', async () => {
      await writeModel(SHARED, ARCTIC);
      const stranger = path.join(SHARED, 'notes.txt');
      await fs.writeFile(stranger, 'a human put this here', 'utf8');
      const strangerDir = path.join(SHARED, 'my-own-things');
      await fs.mkdir(strangerDir, { recursive: true });
      await fs.writeFile(path.join(strangerDir, 'keep.bin'), Buffer.alloc(8));

      await pruneModelCache(SHARED, [ARCTIC]);

      expect(fsSync.existsSync(stranger)).toBe(true);
      // A top-level entry is an org, not a model: only `<org>/<name>` is ours to remove.
      expect(fsSync.existsSync(path.join(strangerDir, 'keep.bin'))).toBe(true);
    });
  });

  describe('through `knowl upgrade`', () => {
    // The command that already visits every repository on the machine is the one that pays
    // for the migration, exactly as it does for snapshots and commit payloads.
    //
    // A fresh root per test, rather than one root deleted and rebuilt between them.
    // `fs.rm(recursive)` over a tree holding an open libSQL database rejects with EBUSY --
    // and does not stop. Measured on this machine: 200 files elsewhere in the tree are still
    // present at the moment of rejection and all gone 400 ms later, deleted in the
    // background after the caller has moved on. The rejection was swallowed by a `.catch`,
    // the next test began writing its fixture, and that still-running delete removed the
    // directory between its `mkdir` and its last `writeFile`. Which is a race no amount of
    // retrying at the call site closes: a unique root removes it by construction, and global
    // teardown collects what is left, which is precisely what it is for.
    let fixtureSequence = 0;
    let UPGRADE_ROOT = '';
    let UPGRADE_HOME = '';
    let UPGRADE_REPO = '';

    beforeEach(async () => {
      await closeDb();
      UPGRADE_ROOT = path.resolve(`.knowl-models-upgrade-test-${++fixtureSequence}`);
      UPGRADE_HOME = path.join(UPGRADE_ROOT, 'home');
      UPGRADE_REPO = path.join(UPGRADE_ROOT, 'repo');
      await fs.mkdir(path.join(UPGRADE_REPO, '.knowl'), { recursive: true });
      await saveConfig(UPGRADE_REPO, {
        ...DEFAULT_CONFIG,
        search: { ...DEFAULT_CONFIG.search, vector: { ...DEFAULT_CONFIG.search?.vector, enabled: true, model: ARCTIC } },
      } as any);
      process.env.KNOWL_HOME = UPGRADE_HOME;
    });

    afterEach(async () => {
      delete process.env.KNOWL_HOME;
      await closeDb();
      await releaseAll();
      await fs.rm(UPGRADE_ROOT, { recursive: true, force: true }).catch(() => {});
    });

    it('adopts this repository tree and reports the bytes it gave back', async () => {
      await writeModel(path.join(UPGRADE_REPO, '.knowl', 'models'), ARCTIC, 4096);

      const result = await upgradeExistingRepository(UPGRADE_REPO, 'Model cache test');

      expect(result.retention.models.adopted).toBe(3);
      expect(result.retention.models.bytesFreed).toBeGreaterThan(4096);
      expect(hasModel(path.join(UPGRADE_HOME, 'models'), ARCTIC)).toBe(true);
      expect(fsSync.existsSync(path.join(UPGRADE_REPO, '.knowl', 'models'))).toBe(false);
    });

    it('never prunes the model this repository is configured to use', async () => {
      // The upgrade that adopts a model must not then decide nothing needs it. This is the
      // path a `serve` holding those weights would be destroyed by.
      const shared = path.join(UPGRADE_HOME, 'models');
      await writeModel(shared, ARCTIC);
      await ageModel(shared, ARCTIC, MODEL_CACHE_HORIZON_DAYS * 5);

      const result = await upgradeExistingRepository(UPGRADE_REPO, 'Model cache test');

      expect(result.retention.models.pruned).toEqual([]);
      expect(hasModel(shared, ARCTIC)).toBe(true);
    });

    it('prunes a stale model this machine no longer names', async () => {
      const shared = path.join(UPGRADE_HOME, 'models');
      await writeModel(shared, ARCTIC);
      await writeModel(shared, MINILM);
      await ageModel(shared, MINILM, MODEL_CACHE_HORIZON_DAYS + 1);

      const result = await upgradeExistingRepository(UPGRADE_REPO, 'Model cache test');

      expect(hasModel(shared, ARCTIC)).toBe(true);
      expect(hasModel(shared, MINILM)).toBe(false);
      expect(result.retention.models.pruned).toHaveLength(1);
    });
  });
});
