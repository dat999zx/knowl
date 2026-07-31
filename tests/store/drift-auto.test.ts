import { execSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NormalizedHostHook } from '../../src/cli/agents/host-hook.js';
import { DEFAULT_CONTEXT_MAX_CHARS } from '../../src/core/token-budget.js';
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

  it('learns the baseline on first run and reports nothing', async () => {
    const first = await runAutoDriftCheck(projectId, ROOT);
    expect(first).toEqual({ checked: false, candidateCount: 0, candidateTitles: [] });

    const second = await runAutoDriftCheck(projectId, ROOT);
    expect(second?.checked).toBe(true);
    expect(second?.candidateCount).toBe(0);
  });

  it('detects candidates without mutating them, then advances the watermark', async () => {
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
    expect(result?.candidateCount).toBe(1);
    expect(result?.candidateTitles).toEqual(['Billing module']);

    // Detection only: freshness is untouched on both candidate and bystander.
    const rows = await getClient().execute({
      sql: 'SELECT id, freshness FROM knowledge_items WHERE id IN (?, ?)',
      args: [item.id, bystander.id],
    });
    for (const row of rows.rows) expect(String(row.freshness)).toBe('fresh');

    // Watermark advanced: the same window is not reported twice.
    const repeat = await runAutoDriftCheck(projectId, ROOT);
    expect(repeat?.candidateCount).toBe(0);
  });

  it('re-baselines quietly when the watermark commit no longer resolves', async () => {
    await getClient().execute({
      sql: 'UPDATE drift_state SET last_checked_commit = ? WHERE project_root = ?',
      args: ['0000000000000000000000000000000000000000', ROOT],
    });
    const result = await runAutoDriftCheck(projectId, ROOT);
    expect(result).toEqual({ checked: false, candidateCount: 0, candidateTitles: [] });
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

  it('renders the warning with the pinned review command, only when something matched', () => {
    expect(describeAutoDrift(null)).toBeUndefined();
    expect(describeAutoDrift({ checked: true, candidateCount: 0, candidateTitles: [], sinceCommit: 'abc' })).toBeUndefined();
    const warning = describeAutoDrift({
      checked: true, candidateCount: 4, candidateTitles: ['Billing module', 'Rate limits'],
      sinceCommit: 'abcdef0123456789',
    });
    expect(warning).toContain('4 knowledge item(s)');
    expect(warning).toContain('"Billing module"');
    expect(warning).toContain('…');
    expect(warning).toContain('knowl pr check --since abcdef012345');
  });

  it('charges the drift warning against the context budget instead of overflowing it', async () => {
    // Enough recent knowledge to fill the budget on its own, so a warning appended after
    // budgeting would push the total over the cap the host was promised.
    // Recent context is 3 items (each content-capped) plus 8 commit lines, so the budget is
    // filled from both ends.
    for (let i = 0; i < 3; i++) {
      await repo.createKnowledgeItem(projectId, {
        category: 'fact',
        title: `Bulky context item ${i} about the payments subsystem`,
        content: `Filler paragraph ${i} describing the payments subsystem at length. `.repeat(30),
        affectedPaths: ['src/bulky.ts'],
      });
    }
    for (let i = 0; i < 8; i++) {
      await repo.createKnowledgeCommit(
        projectId,
        `Bulky commit ${i}: ${`a long commit message segment ${i} `.repeat(8)}`,
        [],
      );
    }
    await commitFile('src/bulky.ts', 'export const a = 1;\n', 'add bulky');
    await runAutoDriftCheck(projectId, ROOT); // advance the watermark past creation
    await commitFile('src/bulky.ts', 'export const a = 2;\n', 'change bulky');

    const result = await handleHostLifecycleEvent(projectId, hook({
      externalSessionId: `drift-budget-${Date.now()}`,
      title: 'Agent session',
    }));

    expect(result.drift?.candidateCount).toBeGreaterThan(0);
    expect(result.context).toMatch(/^DRIFT: /);
    expect(result.context!.length).toBeLessThanOrEqual(DEFAULT_CONTEXT_MAX_CHARS);
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
    await commitFile('src/limits.ts', 'export const limit = 20;\n', 'raise limits');

    const result = await handleHostLifecycleEvent(projectId, hook({
      externalSessionId: `drift-session-${Date.now()}`,
      title: 'Agent session',
    }));

    expect(result.accepted).toBe(true);
    expect(result.drift?.candidateCount).toBe(1);
    expect(result.context).toMatch(/^DRIFT: 1 knowledge item/);

    // Still detection only, even through the lifecycle path.
    const row = (await getClient().execute({
      sql: 'SELECT freshness FROM knowledge_items WHERE id = ?',
      args: [flagged.id],
    })).rows[0];
    expect(String(row.freshness)).toBe('fresh');
  });
});
