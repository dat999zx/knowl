import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, initDb } from '../../src/store/database.js';
import * as repo from '../../src/store/repository.js';
import { indexSkillPackage } from '../../src/skills/knowledge-index.js';
import type { SkillManifest } from '../../src/skills/registry.js';

const manifest = (purpose: string): SkillManifest => ({
  name: 'run-tests', purpose, triggers: [], entrypoints: [], version: 1, createdAt: '', updatedAt: '',
} as unknown as SkillManifest);

describe('re-indexing a skill package', () => {
  const ROOT = path.resolve('./.knowl-skill-reindex-test');
  let projectId = '';
  beforeAll(async () => {
    await fs.rm(ROOT, { recursive: true, force: true });
    await fs.mkdir(path.join(ROOT, '.knowl'), { recursive: true });
    await initDb(ROOT);
    projectId = (await repo.createProject(ROOT, 'skill-reindex')).id;
  });
  afterAll(async () => { await closeDb(); await fs.rm(ROOT, { recursive: true, force: true }).catch(() => {}); });

  it('the manifest wins even when the new purpose drops a value', async () => {
    // The item mirrors a file, so the value-free restatement guard must not keep the stale copy.
    await indexSkillPackage(projectId, manifest('Run the Vitest suite on Node 22.'));
    await indexSkillPackage(projectId, manifest('Run the unit test suite.'));

    const active = (await repo.listKnowledgeItems()).filter(item =>
      item.category === 'skill' && item.status === 'active' && item.title === 'run-tests');
    expect(active).toHaveLength(1);
    expect(active[0].content).toContain('Run the unit test suite.');
  });

  it('an unchanged manifest is still a no-op, keeping the item and its run counts', async () => {
    const activeIds = async () => (await repo.listKnowledgeItems())
      .filter(item => item.category === 'skill' && item.status === 'active' && item.title === 'run-tests')
      .map(item => item.id);
    const [before] = await activeIds();
    await indexSkillPackage(projectId, manifest('Run the unit test suite.'));
    expect(await activeIds()).toEqual([before]);
  });
});
