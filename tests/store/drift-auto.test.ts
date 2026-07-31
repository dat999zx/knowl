import { execSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NormalizedHostHook } from '../../src/cli/agents/host-hook.js';
import { closeDb, getClient, initDb } from '../../src/store/database.js';
import { describeAutoDrift, runAutoDriftCheck } from '../../src/store/drift-auto.js';
import { handleHostLifecycleEvent } from '../../src/store/host-lifecycle.js';
import * as repo from '../../src/store/repository.js';

const ROOT = path.resolve('.knowl-drift-auto-test');

const git = (args: string) => execSync(`git ${args}`, { cwd: ROOT, encoding: 'utf-8' });

const commitFile = async (relPath: string, content: string, message: string): Promise<string> => {
  const filePath = path.join(ROOT, relPath);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content);
  git(`add ${relPath}`);
  git(`commit -m "${message}"`);
  return git('rev-parse HEAD').trim();
};

const hook = (input: Partial<NormalizedHostHook>): NormalizedHostHook => ({
  host: 'generic',
  event: 'session-start',
  externalSessionId: 'drift-session',
  externalTurnId: undefined,
  projectRoot: ROOT,
  payload: {},
  ...input,
});

describe('automatic drift check', () => {
  let projectId = '';

  beforeAll(async () => {
    await fs.rm(ROOT, { recursive: true, force: true });
    await fs.mkdir(path.join(ROOT, '.knowl'), { recursive: true });
    git('init');
    git('config user.email test@example.com');
    git('config user.name Test');
    await commitFile('src/billing.ts', 'export const rate = 1;\n', 'add billing');
    await initDb(ROOT);
    projectId = (await repo.createProject(ROOT, 'Drift auto test')).id;
  });

  afterAll(async () => {
    await closeDb();
    await fs.rm(ROOT, { recursive: true, force: true }).catch(() => {});
  });

  it('learns the baseline on first run and flags nothing', async () => {
    const first = await runAutoDriftCheck(projectId, ROOT);
    expect(first).toEqual({ checked: false, flagged: 0 });

    const second = await runAutoDriftCheck(projectId, ROOT);
    expect(second?.checked).toBe(true);
    expect(second?.flagged).toBe(0);
  });

  it('flags knowledge whose paths changed since the watermark, then advances it', async () => {
    const item = await repo.createKnowledgeItem(projectId, {
      category: 'architecture',
      title: 'Billing module',
      content: 'Billing rates live in src/billing.ts.',
      affectedPaths: ['src/billing.ts'],
    });
    const bystander = await repo.createKnowledgeItem(projectId, {
      category: 'fact',
      title: 'Unrelated fact',
      content: 'Nothing to do with billing paths.',
    });

    await commitFile('src/billing.ts', 'export const rate = 2;\n', 'change billing');
    const result = await runAutoDriftCheck(projectId, ROOT);
    expect(result?.checked).toBe(true);
    expect(result?.flagged).toBe(1);

    const rows = await getClient().execute({
      sql: 'SELECT id, freshness FROM knowledge_items WHERE id IN (?, ?)',
      args: [item.id, bystander.id],
    });
    const freshnessById = new Map(rows.rows.map(row => [String(row.id), String(row.freshness)]));
    expect(freshnessById.get(item.id)).toBe('needs_review');
    expect(freshnessById.get(bystander.id)).toBe('fresh');

    // Watermark advanced: the same change is not reported twice.
    const repeat = await runAutoDriftCheck(projectId, ROOT);
    expect(repeat?.flagged).toBe(0);
  });

  it('re-baselines quietly when the watermark commit no longer resolves', async () => {
    await getClient().execute({
      sql: 'UPDATE drift_state SET last_checked_commit = ? WHERE project_root = ?',
      args: ['0000000000000000000000000000000000000000', ROOT],
    });
    const result = await runAutoDriftCheck(projectId, ROOT);
    expect(result).toEqual({ checked: false, flagged: 0 });
  });

  it('returns null outside a git repository', async () => {
    // In the system temp dir, not the repo tree: rev-parse walks up, so a bare
    // directory inside this repository would resolve to this repository's HEAD.
    const bare = path.join(os.tmpdir(), 'knowl-drift-auto-nogit-test');
    await fs.rm(bare, { recursive: true, force: true });
    await fs.mkdir(bare, { recursive: true });
    try {
      expect(await runAutoDriftCheck(projectId, bare)).toBeNull();
    } finally {
      await fs.rm(bare, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('renders the warning only when something was flagged', () => {
    expect(describeAutoDrift(null)).toBeUndefined();
    expect(describeAutoDrift({ checked: true, flagged: 0, sinceCommit: 'abc' })).toBeUndefined();
    expect(describeAutoDrift({ checked: true, flagged: 2, sinceCommit: 'abcdef0123456789' }))
      .toContain('2 knowledge item(s)');
  });

  it('leads the session-start context with the drift warning', async () => {
    const flagged = await repo.createKnowledgeItem(projectId, {
      category: 'architecture',
      title: 'Rate limits',
      content: 'Limits are configured in src/limits.ts.',
      affectedPaths: ['src/limits.ts'],
    });
    await commitFile('src/limits.ts', 'export const limit = 10;\n', 'add limits');
    await runAutoDriftCheck(projectId, ROOT); // advance watermark past the file's creation
    // The advance itself flagged the item (its file changed); reset so the lifecycle
    // event is what flips it — drift skips items already at needs_review.
    await getClient().execute({
      sql: "UPDATE knowledge_items SET freshness = 'fresh' WHERE id = ?",
      args: [flagged.id],
    });
    await commitFile('src/limits.ts', 'export const limit = 20;\n', 'raise limits');

    const result = await handleHostLifecycleEvent(projectId, hook({
      externalSessionId: `drift-session-${Date.now()}`,
      title: 'Agent session',
    }));

    expect(result.accepted).toBe(true);
    expect(result.drift?.flagged).toBe(1);
    expect(result.context).toMatch(/^DRIFT: 1 knowledge item/);

    const row = (await getClient().execute({
      sql: 'SELECT freshness FROM knowledge_items WHERE id = ?',
      args: [flagged.id],
    })).rows[0];
    expect(String(row.freshness)).toBe('needs_review');
  });
});
