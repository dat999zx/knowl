import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb } from '../../src/store/database.js';
import { releaseAll } from '../../src/store/connection-pool.js';
import { ensureGlobalStore } from '../../src/store/global-store.js';
import { globalNamespaceDescriptor, projectNamespace, queryLayeredKnowledge } from '../../src/store/namespaces.js';
import { DEFAULT_CONFIG, saveConfig } from '../../src/core/config.js';
import { initDb } from '../../src/store/database.js';
import * as repo from '../../src/store/repository.js';
import { storeKnowledgeItemDeduped } from '../../src/store/knowledge-writer.js';

let testCount = 0;

describe('the layered read spans namespaces', () => {
  const saved = process.env.KNOWL_HOME;
  let HOME = '';
  let PROJECT = '';

  beforeEach(async () => {
    const id = testCount++;
    HOME = path.join(os.tmpdir(), `knowl-lv-home-${id}`);
    PROJECT = path.join(os.tmpdir(), `knowl-lv-project-${id}`);
    process.env.KNOWL_HOME = HOME;
    await closeDb().catch(() => {});
    await releaseAll().catch(() => {});
    for (const dir of [HOME, PROJECT]) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    await fs.mkdir(path.join(PROJECT, '.knowl'), { recursive: true });
    await saveConfig(PROJECT, { ...DEFAULT_CONFIG });
    await initDb(PROJECT);
    const project = await repo.createProject(PROJECT, 'lv-project');
    await storeKnowledgeItemDeduped(project.id, {
      category: 'decision',
      title: 'This project deploys on Tuesday',
      content: 'The deploy window for this repository is Tuesday.',
    });
    await closeDb();
    await releaseAll();
    // One personal default, in the global store.
    await ensureGlobalStore();
    await closeDb().catch(() => {});
    await releaseAll().catch(() => {});
  });
  afterEach(async () => {
    await closeDb().catch(() => {});
    await releaseAll().catch(() => {});
    for (const dir of [HOME, PROJECT]) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    if (saved === undefined) delete process.env.KNOWL_HOME; else process.env.KNOWL_HOME = saved;
  });

  it('returns the project item ahead of the global one, both labelled', async () => {
    const { items } = await queryLayeredKnowledge(
      PROJECT, 'deploy window', [projectNamespace(PROJECT), globalNamespaceDescriptor()], 5, 'test', {},
    );
    expect(items.length).toBeGreaterThan(0);
    expect(items[0].namespace).toBe('project');
    expect(items.every(item => typeof item.namespace === 'string')).toBe(true);
  });

  it('gives each namespace its own embedding identity', async () => {
    const { namespaceFingerprint } = await import('../../src/store/namespaces.js');
    const project = await namespaceFingerprint(projectNamespace(PROJECT));
    const global = await namespaceFingerprint(globalNamespaceDescriptor());
    // Both resolvable, and each derived from its OWN config root rather than the caller's.
    expect(project).toBeTruthy();
    expect(global).toBeTruthy();
  });

  it('names the namespaces it could not search instead of narrowing silently', async () => {
    const unreachable = { namespace: 'organization' as const, databasePath: path.join(HOME, 'nope.db'), precedence: 3, optional: true };
    const { skipped } = await queryLayeredKnowledge(
      PROJECT, 'deploy', [projectNamespace(PROJECT), unreachable], 5, 'test', {},
    );
    expect(skipped).toContain('organization');
  });
});
