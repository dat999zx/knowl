import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, initDb } from '../../src/store/database.js';
import * as repo from '../../src/store/repository.js';
import { indexSkillPackage } from '../../src/skills/knowledge-index.js';
import { storeKnowledgeItemDeduped } from '../../src/store/knowledge-writer.js';
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

  it('a package whose name contains another package name does not retire it', async () => {
    // Skill titles are package names and `sameSubjectTitle` is a token-subset test, so
    // "deploy-app-staging" read as a correction of "deploy-app": two packages on disk, one index
    // entry, and `recordSkillRun('deploy-app')` finding nothing to count against.
    const named = (name: string, purpose: string) => ({ ...manifest(purpose), name } as SkillManifest);
    await indexSkillPackage(projectId, named('deploy-app', 'Deploy the app to production.'));
    await indexSkillPackage(projectId, named('deploy-app-staging', 'Deploy the app to staging.'));

    const active = (await repo.listKnowledgeItems())
      .filter(item => item.category === 'skill' && item.status === 'active')
      .map(item => item.title);
    expect(active).toEqual(expect.arrayContaining(['deploy-app', 'deploy-app-staging']));
  });

  it('two agent skill atoms with no source still supersede on the same subject', async () => {
    // The source clamp is for file-backed packages only; an agent's revised procedure without a
    // source is the same skill, and must still retire the one it revises.
    const first = await storeKnowledgeItemDeduped(projectId, {
      category: 'skill', title: 'Rotate signing keys',
      content: 'Rotate the release signing keys with the vault CLI.', steps: ['Open the vault', 'Rotate'],
    });
    const revised = await storeKnowledgeItemDeduped(projectId, {
      category: 'skill', title: 'Rotate signing keys quarterly',
      content: 'Rotate the release signing keys with the vault CLI every quarter.', steps: ['Open the vault', 'Rotate', 'Announce'],
    });

    expect(revised.superseded?.id).toBe(first.item.id);
    expect((await repo.getKnowledgeItem(first.item.id))!.status).toBe('superseded');
  });

  it('a file-backed package does not retire an agent skill atom of the same subject either way round', async () => {
    // The clamp needs BOTH sides to carry a source. An agent atom with none is not a different
    // package, so the ordinary same-subject rule still decides it.
    const atom = await storeKnowledgeItemDeduped(projectId, {
      category: 'skill', title: 'publish docs',
      content: 'Publish the docs site to the production bucket.', steps: ['Build', 'Upload'],
    });
    await indexSkillPackage(projectId, { ...manifest('Publish the docs site to the production bucket.'), name: 'publish-docs-site' } as SkillManifest);

    expect((await repo.getKnowledgeItem(atom.item.id))!.status).toBe('superseded');
  });
});
