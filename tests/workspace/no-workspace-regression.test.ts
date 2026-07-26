import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, getClient, initDb } from '../../src/store/database.js';
import { releaseAll } from '../../src/store/connection-pool.js';
import * as repo from '../../src/store/repository.js';
import { storeKnowledgeItemDeduped } from '../../src/store/knowledge-writer.js';
import { queryKnowledgeForAgent } from '../../src/store/agent-query.js';
import { compactItemResponse, compactMcpJson } from '../../src/mcp/response-format.js';
import { getRecentContext } from '../../src/store/recent-context.js';
import { composeContext } from '../../src/store/context-composer.js';
import { startWorkLoop } from '../../src/store/work-loop.js';
import { resolveWorkspace } from '../../src/workspace/resolve.js';
import { formatWorkspaceBlock, workspaceDoctorChecks } from '../../src/cli/workspace-report.js';
import { formatStatusReport } from '../../src/cli/status-report.js';
import { DEFAULT_CONFIG, saveConfig } from '../../src/core/config.js';

const ROOT = path.resolve('./.knowl-no-workspace-test');

/**
 * The contract that makes v1 safe to ship: a project that never links anything must behave
 * exactly as it did before workspaces existed.
 *
 * KNOWL_HOME points at a directory that does not exist, so this also proves nothing tries
 * to read a manifest -- an attempt would surface rather than quietly returning null.
 */
describe('a project with no workspace is untouched by v1', () => {
  let projectId = '';

  beforeAll(async () => {
    process.env.KNOWL_HOME = path.resolve('./.knowl-no-workspace-absent-home');
    await closeDb();
    await releaseAll();
    await fs.rm(ROOT, { recursive: true, force: true }).catch(() => {});
    await fs.mkdir(path.join(ROOT, '.knowl'), { recursive: true });
    await saveConfig(ROOT, { ...DEFAULT_CONFIG });
    await initDb(ROOT);
    projectId = (await repo.createProject(ROOT, 'no-workspace')).id;
    await storeKnowledgeItemDeduped(projectId, {
      category: 'decision', title: 'Storage is libSQL',
      content: 'Knowledge is stored in a libSQL database under .knowl.',
    });
    await storeKnowledgeItemDeduped(projectId, {
      category: 'fact', title: 'Storage bootstrap is self-contained',
      content: 'Schema bootstrap runs from the store layer on every open.',
    });
    await closeDb();
  });

  afterAll(async () => {
    delete process.env.KNOWL_HOME;
    await closeDb();
    await releaseAll();
    await fs.rm(ROOT, { recursive: true, force: true }).catch(() => {});
  });

  it('resolves no workspace, without reading a manifest', async () => {
    await expect(resolveWorkspace(ROOT, DEFAULT_CONFIG)).resolves.toBeNull();
    await expect(fs.access(path.resolve('./.knowl-no-workspace-absent-home'))).rejects.toThrow();
  });

  it('serializes query results with no repo or namespace field', async () => {
    await initDb(ROOT);
    try {
      const items = await queryKnowledgeForAgent('local', { query: 'storage', limit: 3, surface: 'test' });
      const serialized = JSON.parse(compactMcpJson(items.map(item => compactItemResponse(item))));
      expect(serialized.length).toBeGreaterThan(0);
      expect(serialized.every((item: Record<string, unknown>) => !('repo' in item))).toBe(true);
      expect(serialized.every((item: Record<string, unknown>) => !('namespace' in item))).toBe(true);
    } finally {
      await closeDb();
    }
  });

  it('leaves every write unowned and repo-visible', async () => {
    await initDb(ROOT);
    try {
      await storeKnowledgeItemDeduped(projectId, {
        category: 'fact', title: 'Vector search default',
        content: 'search.vector.enabled defaults to true.',
      });
      const rows = await getClient().execute('SELECT origin_repo, visibility FROM knowledge_items');
      expect(rows.rows.length).toBeGreaterThan(0);
      expect(rows.rows.every(row => row.origin_repo === null)).toBe(true);
      expect(rows.rows.every(row => row.visibility === 'repo')).toBe(true);
    } finally {
      await closeDb();
    }
  });

  it('renders no workspace section in status or doctor', async () => {
    expect(formatWorkspaceBlock(null)).toEqual([]);
    expect(workspaceDoctorChecks(null, DEFAULT_CONFIG)).toEqual([]);

    const report = formatStatusReport({
      project: { id: 'local', name: 'no-workspace', rootPath: ROOT } as never,
      config: DEFAULT_CONFIG,
      activeItems: [], supersededItems: [], deprecatedItems: [], commits: [],
    });
    expect(report).not.toMatch(/WORKSPACE/);
  });

  it('leaves implicit reads returning what they returned before', async () => {
    await initDb(ROOT);
    try {
      const recent = await getRecentContext('local', { itemLimit: 5 });
      expect(recent.items.length).toBeGreaterThan(0);

      const pack = await composeContext('local', { query: 'storage', tokenBudget: 2000, namespaceRoot: ROOT });
      expect(pack.sections.flatMap(section => section.items).length).toBeGreaterThan(0);

      const started = await startWorkLoop('local', 'Investigate storage');
      expect(started.taskId).toBeTruthy();
    } finally {
      await closeDb();
    }
  });

  it('creates no workspace files anywhere', async () => {
    // Nothing in v1 may write to KNOWL_HOME unless the user linked a repo.
    await expect(fs.access(path.resolve('./.knowl-no-workspace-absent-home'))).rejects.toThrow();
  });
});
