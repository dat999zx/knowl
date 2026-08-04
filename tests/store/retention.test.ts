import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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
  SNAPSHOT_KEEP,
  compactKnowledgeCommits,
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
