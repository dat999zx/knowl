import { execSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GIT_IDENTITY_FLAGS } from '../git-identity.js';
import { NormalizedHostHook } from '../../src/cli/agents/host-hook.js';
import { DEFAULT_CONTEXT_MAX_CHARS } from '../../src/core/token-budget.js';
import { closeDb, getClient, initDb } from '../../src/store/database.js';
import { describeAutoDrift, runAutoDriftCheck } from '../../src/store/drift-auto.js';
import { handleHostLifecycleEvent } from '../../src/session/host-lifecycle.js';
import { recordKnowledgeAccess } from '../../src/store/access-feedback.js';
import { OBSERVED_USE_MIN_DAYS } from '../../src/store/tier.js';
import * as repo from '../../src/store/repository.js';

const ROOT = path.resolve('.knowl-drift-auto-test');

// Identity on every invocation, never `git config` -- see `tests/git-identity.ts`. This suite is
// the one that leaked: its values are what turned up in this repository's own `.git/config`.
const git = (args: string) => execSync(`git ${GIT_IDENTITY_FLAGS} ${args}`, { cwd: ROOT, encoding: 'utf-8' });

const commitFile = async (relPath: string, content: string, message: string): Promise<string> => {
  const filePath = path.join(ROOT, relPath);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content);
  git(`add ${relPath}`);
  git(`commit -m "${message}"`);
  return git('rev-parse HEAD').trim();
};

/**
 * Delete a cited file and commit it.
 *
 * Since 2026-08-13 an edit is not drift -- a file being touched says nothing about whether an
 * atom is still true, and treating it as drift is what produced 339 unread observations against
 * 42 real ones on this repository's own store. A removal is. These fixtures use it because they
 * are about the lifecycle around a candidate (stamping, watermarks, warnings), and need a
 * candidate that qualifies; `an edited file is not drift on its own` covers the other side.
 */
const removeFile = async (relPath: string, message: string): Promise<string> => {
  await fs.rm(path.join(ROOT, relPath), { force: true });
  git(`add -A ${relPath}`);
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

  it('marks survivors needs_review, leaves bystanders alone, then advances the watermark', async () => {
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

    await removeFile('src/billing.ts', 'drop billing');
    const result = await runAutoDriftCheck(projectId, ROOT);
    expect(result?.checked).toBe(true);
    expect(result?.candidateCount).toBe(1);
    expect(result?.candidateTitles).toEqual(['Billing module']);

    // The candidate is acted on; the bystander is not touched at all. Detection-only was the
    // right answer while 39% of the store qualified -- see the `apply` comment in drift-auto.ts.
    const rows = await getClient().execute({
      sql: 'SELECT id, freshness, last_drift_at FROM knowledge_items WHERE id IN (?, ?) ORDER BY id = ? DESC',
      args: [item.id, bystander.id, item.id],
    });
    expect(String(rows.rows[0].freshness)).toBe('needs_review');
    expect(String(rows.rows[1].freshness)).toBe('fresh');
    // ...but the observation itself is recorded, on the candidate only. This is the whole
    // difference between a warning and a fact a later pass can act on.
    expect(rows.rows[0].last_drift_at).toBeTruthy();
    expect(rows.rows[1].last_drift_at).toBeNull();

    // Watermark advanced: the same window is not reported twice.
    const repeat = await runAutoDriftCheck(projectId, ROOT);
    expect(repeat?.candidateCount).toBe(0);

    // And the stamp survives that advance. The window is gone, the warning was said once,
    // and the only remaining trace that this item's files moved is the column.
    const after = (await getClient().execute({
      sql: 'SELECT last_drift_at FROM knowledge_items WHERE id = ?',
      args: [item.id],
    })).rows[0];
    expect(after.last_drift_at).toBeTruthy();
  });

  it('does not call an edited file drift on its own', async () => {
    // The rule that removes most of the noise, and the reason the fixtures above delete rather
    // than edit. Measured on this repository's own store, 226 of 339 observations were exactly
    // this -- a cited file that had been edited and was still there. A file being touched is not
    // evidence that anything written about it became false.
    const item = await repo.createKnowledgeItem(projectId, {
      category: 'fact',
      title: 'Edited but still true',
      content: 'A claim about src/edited.ts.',
      affectedPaths: ['src/edited.ts'],
    });

    await commitFile('src/edited.ts', 'export const a = 1;\n', 'add edited');
    await runAutoDriftCheck(projectId, ROOT); // baseline past creation
    await commitFile('src/edited.ts', 'export const a = 2;\n', 'edit edited');

    const result = await runAutoDriftCheck(projectId, ROOT);
    expect(result?.checked).toBe(true);
    expect(result?.candidateTitles).not.toContain('Edited but still true');

    // Not merely unreported -- unrecorded. Stamping it would leave a later pass acting on the
    // same false positive from a column instead of from a warning.
    const stamped = (await getClient().execute({
      sql: 'SELECT last_drift_at FROM knowledge_items WHERE id = ?',
      args: [item.id],
    })).rows[0];
    expect(stamped.last_drift_at).toBeNull();
  });

  it('clears the stamp when the item is reviewed, and not when it is merely touched', async () => {
    const item = await repo.createKnowledgeItem(projectId, {
      category: 'fact',
      title: 'Reviewable fact',
      content: 'Something about src/reviewable.ts.',
      affectedPaths: ['src/reviewable.ts'],
    });
    const stamp = async (): Promise<unknown> => (await getClient().execute({
      sql: 'SELECT last_drift_at FROM knowledge_items WHERE id = ?',
      args: [item.id],
    })).rows[0].last_drift_at;

    await commitFile('src/reviewable.ts', 'export const a = 1;\n', 'add reviewable');
    await runAutoDriftCheck(projectId, ROOT); // baseline past creation
    await removeFile('src/reviewable.ts', 'drop reviewable');
    await runAutoDriftCheck(projectId, ROOT);
    expect(await stamp()).toBeTruthy();

    // A lifecycle-only write is not a review. Visibility, status and supersession all move
    // `updated_at`, and discharging a drift observation on one of those would clear the block
    // without anybody having read the item.
    await repo.updateKnowledgeItem(item.id, { visibility: 'workspace' });
    expect(await stamp()).toBeTruthy();

    // Setting freshness is the review verb at both ends: `pr check` flags, `knowl_update`
    // clears. Either way somebody has now looked.
    await repo.updateKnowledgeItem(item.id, { freshness: 'fresh' });
    expect(await stamp()).toBeNull();
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
    expect(warning).toContain('knowl pr --since abcdef012345');
  });

  // The other half of the same rule. `affected_paths` is required because an item with none
  // can never be contradicted; a run where drift could not be computed is that same state one
  // level up — nothing this session was in a position to contradict anything — so "no
  // candidates" must not be read as "everything is clean".
  it('promotes nothing on a session where the drift check could not compare anything', async () => {
    const item = await repo.createKnowledgeItem(projectId, {
      category: 'fact',
      title: 'Otherwise eligible fact',
      content: 'A claim about src/eligible.ts.',
      affectedPaths: ['src/eligible.ts'],
    });
    const since = Date.parse((await repo.getKnowledgeItem(item.id))!.tierSince!);
    for (let day = 0; day < OBSERVED_USE_MIN_DAYS; day++) {
      await recordKnowledgeAccess({
        itemId: item.id,
        query: `question ${day}`,
        surface: 'mcp',
        rank: 0,
        retrievedAt: new Date(since + day * 86_400_000 + 60_000).toISOString(),
      });
    }

    // Drop the watermark: the next check re-baselines and reports `checked: false`, exactly
    // as it does after a rebase rewrites the commit it was pinned to.
    await getClient().execute({ sql: 'DELETE FROM drift_state WHERE project_root = ?', args: [ROOT] });
    await handleHostLifecycleEvent(projectId, hook({
      externalSessionId: `drift-baseline-${Date.now()}`,
      title: 'Agent session',
    }));
    expect((await repo.getKnowledgeItem(item.id))?.tier).toBe('asserted');

    // The very next session has a watermark to compare against, so the same item now earns it.
    await handleHostLifecycleEvent(projectId, hook({
      externalSessionId: `drift-baselined-${Date.now()}`,
      title: 'Agent session',
    }));
    expect((await repo.getKnowledgeItem(item.id))?.tier).toBe('verified');
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
    await removeFile('src/bulky.ts', 'drop bulky');

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
    await removeFile('src/limits.ts', 'drop limits');

    const result = await handleHostLifecycleEvent(projectId, hook({
      externalSessionId: `drift-session-${Date.now()}`,
      title: 'Agent session',
    }));

    expect(result.accepted).toBe(true);
    expect(result.drift?.candidateCount).toBe(1);
    expect(result.context).toMatch(/^DRIFT: 1 knowledge item/);

    // Acted on through the lifecycle path too, not only through the direct call -- the warning
    // and the mark are one pass, so a session cannot report drift it did not record.
    const row = (await getClient().execute({
      sql: 'SELECT freshness FROM knowledge_items WHERE id = ?',
      args: [flagged.id],
    })).rows[0];
    expect(String(row.freshness)).toBe('needs_review');
  });
});
