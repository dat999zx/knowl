import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb } from '../../src/store/database.js';
import { releaseAll } from '../../src/store/connection-pool.js';
import { DEFAULT_CONFIG, loadConfig, saveConfig } from '../../src/core/config.js';
import { setGlobalNamespace } from '../../src/core/config.js';
import { globalStorePath } from '../../src/core/paths.js';
import { configuredNamespaces } from '../../src/store/namespaces.js';

let testCount = 0;

describe('linking a project to the global store', () => {
  const saved = process.env.KNOWL_HOME;
  let HOME = '';
  let PROJECT = '';

  beforeEach(async () => {
    const id = testCount++;
    HOME = path.join(os.tmpdir(), `knowl-link-home-${id}`);
    PROJECT = path.join(os.tmpdir(), `knowl-link-project-${id}`);
    process.env.KNOWL_HOME = HOME;
    await closeDb().catch(() => {});
    await releaseAll().catch(() => {});
    for (const dir of [HOME, PROJECT]) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    await fs.mkdir(path.join(PROJECT, '.knowl'), { recursive: true });
    await saveConfig(PROJECT, { ...DEFAULT_CONFIG });
  });
  afterEach(async () => {
    await closeDb().catch(() => {});
    await releaseAll().catch(() => {});
    for (const dir of [HOME, PROJECT]) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    if (saved === undefined) delete process.env.KNOWL_HOME; else process.env.KNOWL_HOME = saved;
  });

  it('adds the namespace on link and removes it on unlink', async () => {
    expect(configuredNamespaces(PROJECT, await loadConfig(PROJECT)).map(d => d.namespace)).not.toContain('global');

    await setGlobalNamespace(PROJECT, true);
    const linked = await loadConfig(PROJECT);
    expect(linked.memory?.global).toEqual({ enabled: true, path: globalStorePath() });
    expect(configuredNamespaces(PROJECT, linked).map(d => d.namespace)).toContain('global');
    // Linking creates the store, so the very next query has something to read.
    await expect(fs.access(globalStorePath())).resolves.toBeUndefined();

    await setGlobalNamespace(PROJECT, false);
    const unlinked = await loadConfig(PROJECT);
    expect(unlinked.memory?.global?.enabled).toBe(false);
    expect(configuredNamespaces(PROJECT, unlinked).map(d => d.namespace)).not.toContain('global');
    // Unlinking is reversible and never destroys the store.
    await expect(fs.access(globalStorePath())).resolves.toBeUndefined();
  });
});

describe('writing to the global namespace', () => {
  it('demands absolute paths and says they are not indexed', async () => {
    const { assertGlobalWrite } = await import('../../src/store/global-store.js');
    // A relative path in a store that spans repositories names nothing.
    expect(() => assertGlobalWrite(['src/auth.ts'])).toThrow(/absolute/i);
    expect(assertGlobalWrite([path.join(os.tmpdir(), 'src/auth.ts')])).toMatch(/not indexed/i);
    expect(assertGlobalWrite([])).toMatch(/not indexed/i);
  });

  it('writes directly to the global database', async () => {
    const { ensureGlobalStore } = await import('../../src/store/global-store.js');
    const { storeKnowledgeItemDeduped } = await import('../../src/store/knowledge-writer.js');
    const { withDbPath } = await import('../../src/store/database.js');
    const { queryLayeredKnowledge, configuredNamespaces } = await import('../../src/store/namespaces.js');
    const { setGlobalNamespace, loadConfig } = await import('../../src/core/config.js');

    const home = path.join(os.tmpdir(), `knowl-link-write-${testCount++}`);
    const project = path.join(os.tmpdir(), `knowl-link-pwrite-${testCount++}`);
    const saved = process.env.KNOWL_HOME;
    try {
      process.env.KNOWL_HOME = home;
      await fs.mkdir(path.join(project, '.knowl'), { recursive: true });
      await saveConfig(project, { ...DEFAULT_CONFIG });

      const { path: storePath } = await ensureGlobalStore();
      await withDbPath(storePath, async () => {
        await storeKnowledgeItemDeduped('local', {
          category: 'constraint',
          title: 'Global preference',
          content: 'I prefer pnpm everywhere',
        });
      });

      await setGlobalNamespace(project, true);
      const config = await loadConfig(project);
      const { items } = await queryLayeredKnowledge(project, 'pnpm preference', configuredNamespaces(project, config), 5);
      expect(items.some(it => it.title === 'Global preference' && it.namespace === 'global')).toBe(true);
    } finally {
      await closeDb().catch(() => {});
      await releaseAll().catch(() => {});
      for (const dir of [home, project]) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
      if (saved === undefined) delete process.env.KNOWL_HOME; else process.env.KNOWL_HOME = saved;
    }
  });
});

describe('setup outside a repository', () => {
  it('creates only the global store under --global', async () => {
    const home = path.join(os.tmpdir(), `knowl-link-global-init-${testCount++}`);
    const saved = process.env.KNOWL_HOME;
    try {
      process.env.KNOWL_HOME = home;
      const { runGlobalInit } = await import('../../src/cli/global-init.js');
      const result = await runGlobalInit();
      expect(result.created).toBe(true);
      await expect(fs.access(globalStorePath())).resolves.toBeUndefined();
      // No project was made anywhere.
      await expect(fs.access(path.join(home, '.knowl'))).rejects.toThrow();
      expect((await runGlobalInit()).created).toBe(false);
    } finally {
      await closeDb().catch(() => {});
      await releaseAll().catch(() => {});
      await fs.rm(home, { recursive: true, force: true }).catch(() => {});
      if (saved === undefined) delete process.env.KNOWL_HOME; else process.env.KNOWL_HOME = saved;
    }
  });
});

describe('CLI query with global layer', () => {
  it('returns project item ahead of global item in a linked project, and queries global outside project', async () => {
    const { ensureGlobalStore } = await import('../../src/store/global-store.js');
    const { storeKnowledgeItemDeduped } = await import('../../src/store/knowledge-writer.js');
    const { withDbPath, initDb } = await import('../../src/store/database.js');
    const { setGlobalNamespace } = await import('../../src/core/config.js');
    const { runCliQuery } = await import('../../src/cli/query-command.js');
    const repo = await import('../../src/store/repository.js');

    const home = path.join(os.tmpdir(), `knowl-link-cli-home-${testCount++}`);
    const project = path.join(os.tmpdir(), `knowl-link-cli-project-${testCount++}`);
    const saved = process.env.KNOWL_HOME;
    try {
      process.env.KNOWL_HOME = home;
      await fs.mkdir(path.join(project, '.knowl'), { recursive: true });
      await saveConfig(project, { ...DEFAULT_CONFIG });
      await initDb(project);
      await repo.createProject(project, 'cli-test');

      // Project item
      await storeKnowledgeItemDeduped('local', {
        category: 'constraint',
        title: 'Project package manager',
        content: 'This project uses yarn',
      });

      // Global item
      const { path: storePath } = await ensureGlobalStore();
      await withDbPath(storePath, async () => {
        await storeKnowledgeItemDeduped('local', {
          category: 'constraint',
          title: 'Preferred package manager',
          content: 'I prefer pnpm everywhere',
        });
      });

      await setGlobalNamespace(project, true);

      // Query from project
      const result = await runCliQuery({ projectRoot: project, projectId: 'local', query: 'package manager' });
      expect(result.items.length).toBeGreaterThanOrEqual(2);
      expect(result.items[0].title).toBe('Project package manager');
      expect(result.items[0].namespace).toBe('project');
      expect(result.items.some(it => it.title === 'Preferred package manager' && it.namespace === 'global')).toBe(true);

      // Query outside project
      const outsideResult = await runCliQuery({ query: 'package manager' });
      expect(outsideResult.items.length).toBeGreaterThanOrEqual(1);
      expect(outsideResult.items[0].title).toBe('Preferred package manager');
      expect(outsideResult.items[0].namespace).toBe('global');
    } finally {
      await closeDb().catch(() => {});
      await releaseAll().catch(() => {});
      for (const dir of [home, project]) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
      if (saved === undefined) delete process.env.KNOWL_HOME; else process.env.KNOWL_HOME = saved;
    }
  });
});


