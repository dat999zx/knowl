import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, initDb } from '../../src/store/database.js';
import { releaseAll } from '../../src/store/connection-pool.js';
import * as repo from '../../src/store/repository.js';
import { DEFAULT_CONFIG, saveConfig } from '../../src/core/config.js';

const CLI_PATH = path.resolve('./dist/index.js');

let root = '';

/**
 * The forget log's whole claim is that a collection policy stops being unfalsifiable, and that
 * claim is only true if somebody can read the rows back. These run the real binary rather than
 * the module, because the gap being closed was the wiring: the table and its two accessors
 * existed and nothing outside the test suite could reach them.
 */
function cli(...args: string[]): string {
  return execFileSync(process.execPath, [CLI_PATH, ...args], { cwd: root, encoding: 'utf-8' });
}

/** Vectors off: nothing here ranks anything, and loading the model costs ~45s per fresh repo. */
const LEXICAL_ONLY = {
  ...DEFAULT_CONFIG,
  search: { vector: { ...DEFAULT_CONFIG.search?.vector, enabled: false } },
};

async function seedDeletedItem(title: string, content: string): Promise<string> {
  await initDb(root);
  const projectId = (await repo.getProjectByRootPath(root))?.id
    ?? (await repo.createProject(root, 'forget-log-cli')).id;
  const item = await repo.createKnowledgeItem(projectId, { category: 'fact', title, content });
  await repo.deleteKnowledgeItem(item.id, undefined, {
    policy: 'gc:purge',
    reason: 'State item stale for 47 days and never retrieved',
  });
  await closeDb();
  return item.id;
}

describe('knowl forget-log', () => {
  beforeEach(async () => {
    await closeDb().catch(() => {});
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'knowl-forget-log-cli-'));
    await fs.mkdir(path.join(root, '.knowl'), { recursive: true });
    await saveConfig(root, LEXICAL_ONLY);
  });

  afterEach(async () => {
    await closeDb().catch(() => {});
    await releaseAll().catch(() => {});
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  });

  it('prints the deciding reason and the retrieval evidence behind a purge', async () => {
    const id = await seedDeletedItem('Collected fact', 'Taken by the duplicate rule.');

    const output = cli('forget-log');

    expect(output).toContain('KNOWL FORGET LOG');
    expect(output).toContain(id);
    expect(output).toContain('gc:purge');
    expect(output).toContain('Reason: State item stale for 47 days and never retrieved');
    expect(output).toContain('Retrievals: 0');
  });

  it('emits the entries as JSON for a caller that wants to retune a threshold', async () => {
    const id = await seedDeletedItem('Machine readable', 'Parsed, not read.');

    const parsed = JSON.parse(cli('forget-log', '--json')) as {
      entries: Array<{ itemId: string; policy: string; reason: string; retrievalCount: number }>;
    };

    expect(parsed.entries).toHaveLength(1);
    expect(parsed.entries[0].itemId).toBe(id);
    expect(parsed.entries[0].policy).toBe('gc:purge');
    expect(parsed.entries[0].retrievalCount).toBe(0);
  });

  it('says where entries come from rather than printing an empty list', async () => {
    await initDb(root);
    await repo.createProject(root, 'forget-log-cli');
    await closeDb();

    expect(cli('forget-log')).toContain('knowl gc --apply');
  });

  /**
   * Pruning is the mode that has to be asked for by name. The argument for a table separate
   * from `knowledge_tombstones` is that these rows survive when tombstones are dropped, so a
   * default that deleted them would give the separation away.
   */
  it('prunes only when asked, and reports how many rows went', async () => {
    await seedDeletedItem('Prunable', 'Removed on request.');

    expect(cli('forget-log', '--prune-days', '0')).toContain('Pruned 1 forget-log entries.');
    expect(cli('forget-log')).toContain('No recorded deletions');
  });

  it('refuses a non-numeric limit instead of silently listing everything', () => {
    expect(() => cli('forget-log', '--limit', 'lots')).toThrow(/--limit must be a number/);
  });
});
