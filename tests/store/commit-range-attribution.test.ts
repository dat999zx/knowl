import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NormalizedHostHook } from '../../src/cli/agents/host-hook.js';
import { closeDb, initDb } from '../../src/store/database.js';
import { releaseAll } from '../../src/store/connection-pool.js';
import { handleHostLifecycleEvent } from '../../src/store/host-lifecycle.js';
import { readCommitHead } from '../../src/store/change-watermark.js';
import { recordMcpCallCommits } from '../../src/store/mcp-call-commits.js';
import * as repo from '../../src/store/repository.js';

const ROOT = path.resolve('./.knowl-range-attribution');
let projectId = '';
let tick = 0;

const hook = (input: Partial<NormalizedHostHook>): NormalizedHostHook => ({
  host: 'claude',
  event: 'turn-start',
  externalSessionId: 'range-session',
  externalTurnId: 'range-turn',
  projectRoot: ROOT,
  payload: {},
  ...input,
});

/** A Knowl tool event, as the hook normalizer would produce it for an MCP call. */
const knowlToolEvent = (toolName: string, keys: { ids: string[]; titles: string[] }) =>
  handleHostLifecycleEvent(projectId, hook({
    event: 'session-event',
    type: 'command',
    payload: { command: `tool-${tick++}`, exitCode: 0 },
    knowlTool: true,
    knowlToolName: toolName,
    knowlChangeKeys: keys,
  }));

const card = (result: Awaited<ReturnType<typeof knowlToolEvent>>): string =>
  String((result.hostOutput as any)?.hookSpecificOutput?.additionalContext ?? '');

const commit = (message: string, changes: Parameters<typeof repo.createKnowledgeCommit>[2]) =>
  repo.createKnowledgeCommit(projectId, message, changes);

describe('commit-range attribution', () => {
  beforeAll(async () => {
    await closeDb();
    await releaseAll();
    await fs.rm(ROOT, { recursive: true, force: true }).catch(() => {});
    await fs.mkdir(path.join(ROOT, '.knowl'), { recursive: true });
    await initDb(ROOT);
    projectId = (await repo.createProject(ROOT, 'range attribution')).id;
    await commit('Baseline', [
      { itemId: 'base', action: 'insert', after: { id: 'base', category: 'fact', title: 'Baseline' } },
    ]);
    await handleHostLifecycleEvent(projectId, hook({ title: 'Agent turn' }));
    await knowlToolEvent('knowl_query', { ids: [], titles: [] });
  });

  afterAll(async () => {
    await closeDb();
    await releaseAll();
    await fs.rm(ROOT, { recursive: true, force: true }).catch(() => {});
  });

  it('suppresses a write\'s indirect effects, which carry none of the callers keys', async () => {
    const from = await readCommitHead();
    // A knowl_store that deduped: it inserted its own item AND superseded a different one
    // with an unrelated title. Key matching catches the first and reports the second back
    // to its own author.
    await commit('Store with dedup supersede', [
      { itemId: 'new-1', action: 'insert', after: { id: 'new-1', category: 'fact', title: 'My new atom' } },
      { itemId: 'old-9', action: 'supersede', before: { id: 'old-9', category: 'fact', title: 'Some older unrelated item' } },
    ]);
    await recordMcpCallCommits({
      projectRoot: ROOT, toolName: 'knowl_store', range: { from, to: await readCommitHead() },
    });

    const result = await knowlToolEvent('knowl_store', { ids: [], titles: ['My new atom'] });
    expect(card(result)).not.toContain('Some older unrelated item');
    expect(result.changes).toBeUndefined();
  });

  it('reports a foreign change that merely shares a title with the callers own write', async () => {
    const from = await readCommitHead();
    await commit('My own write', [
      { itemId: 'mine-2', action: 'insert', after: { id: 'mine-2', category: 'fact', title: 'Shared title' } },
    ]);
    await recordMcpCallCommits({
      projectRoot: ROOT, toolName: 'knowl_store', range: { from, to: await readCommitHead() },
    });
    // A sibling happens to write an item with the same title, after this call finished.
    await commit('Sibling write', [
      { itemId: 'theirs-2', action: 'update', after: { id: 'theirs-2', category: 'fact', title: 'Shared title' } },
    ]);

    const result = await knowlToolEvent('knowl_store', { ids: [], titles: ['Shared title'] });
    expect(result.changes?.items.map(item => item.itemId)).toEqual(['theirs-2']);
  });

  it('ignores a recorded range that contains none of the callers keys', async () => {
    const from = await readCommitHead();
    // A different session's write, recorded under the same tool name in the same window.
    await commit('Another session write', [
      { itemId: 'other-3', action: 'insert', after: { id: 'other-3', category: 'fact', title: 'Not mine at all' } },
    ]);
    await recordMcpCallCommits({
      projectRoot: ROOT, toolName: 'knowl_store', range: { from, to: await readCommitHead() },
    });

    const result = await knowlToolEvent('knowl_store', { ids: [], titles: ['Something I wrote'] });
    expect(result.changes?.items.map(item => item.itemId)).toEqual(['other-3']);
  });

  it('falls back to key matching when no range was recorded', async () => {
    await commit('Unrecorded own write', [
      { itemId: 'mine-4', action: 'insert', after: { id: 'mine-4', category: 'fact', title: 'Unrecorded title' } },
    ]);

    const result = await knowlToolEvent('knowl_store', { ids: [], titles: ['Unrecorded title'] });
    expect(result.changes).toBeUndefined();
  });

  it('does not let one tool claim another tool\'s range', async () => {
    const from = await readCommitHead();
    await commit('Update write', [
      { itemId: 'upd-5', action: 'update', after: { id: 'upd-5', category: 'fact', title: 'Updated item' } },
    ]);
    await recordMcpCallCommits({
      projectRoot: ROOT, toolName: 'knowl_update', range: { from, to: await readCommitHead() },
    });

    // Same keys, wrong tool: the range must not apply, so key matching decides instead.
    const result = await knowlToolEvent('knowl_store', { ids: ['upd-5'], titles: [] });
    expect(result.changes).toBeUndefined(); // excluded by id, not by range
  });
});
