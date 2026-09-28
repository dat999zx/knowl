import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, initDb } from '../../src/store/database.js';
import * as repo from '../../src/store/repository.js';
import { runMerge } from '../../src/pipeline/merge.js';
import type { VerifiedAtomAction } from '../../src/pipeline/verify.js';

const ROOT = path.resolve('./.knowl-write-channel-merge-test');
let projectId = '';

beforeAll(async () => {
  await fs.rm(ROOT, { recursive: true, force: true });
  await fs.mkdir(path.join(ROOT, '.knowl'), { recursive: true });
  await initDb(ROOT);
  projectId = (await repo.createProject(ROOT, 'merge-channel')).id;
});
afterAll(async () => { await closeDb(); await fs.rm(ROOT, { recursive: true, force: true }).catch(() => {}); });

const seed = (provenance: 'observed' | null) => repo.createKnowledgeItem(projectId, {
  category: 'fact', title: 'Production database engine', content: 'PostgreSQL 16', provenance,
});
const atom = { category: 'fact' as const, title: 'Production database engine', content: 'MySQL 5.7' };

describe('runMerge on the automatic channel (#165)', () => {
  it('an update does not rewrite a verified item in place', async () => {
    const held = await seed('observed');
    const action: VerifiedAtomAction = { atom, action: 'update', existingItemId: held.id,
      compareResult: { relationship: 'update', reason: 'stub', updatedContent: 'MySQL 5.7' } };

    const result = await runMerge(projectId, [action], { channel: 'automatic' });

    const after = await repo.getKnowledgeItem(held.id);
    expect(after!.content).toBe('PostgreSQL 16');
    expect(after!.status).toBe('active');
    expect(result.keptBesideIds).toEqual([held.id]);
    expect(result.insertedIds).toHaveLength(1);
    expect(result.updatedIds).toHaveLength(0);
  });

  it('an auto-resolved contradiction does not retire a verified item', async () => {
    const held = await seed('observed');
    const action: VerifiedAtomAction = { atom, action: 'contradiction', existingItemId: held.id,
      compareResult: { relationship: 'contradiction', reason: 'stub' } };

    const result = await runMerge(projectId, [action], { channel: 'automatic', autoResolveContradictions: true });

    expect((await repo.getKnowledgeItem(held.id))!.status).toBe('active');
    expect(result.keptBesideIds).toEqual([held.id]);
    expect(result.insertedIds).toHaveLength(1);
    expect(result.supersededIds).toHaveLength(0);
  });

  it('an unverified item is updated in place as before', async () => {
    const held = await seed(null);
    const action: VerifiedAtomAction = { atom, action: 'update', existingItemId: held.id,
      compareResult: { relationship: 'update', reason: 'stub', updatedContent: 'MySQL 5.7' } };

    const result = await runMerge(projectId, [action], { channel: 'automatic' });

    expect((await repo.getKnowledgeItem(held.id))!.content).toBe('MySQL 5.7');
    expect(result.keptBesideIds).toEqual([]);
  });

  it('the direct channel (knowl decide) is unchanged', async () => {
    const held = await seed('observed');
    const action: VerifiedAtomAction = { atom, action: 'update', existingItemId: held.id,
      compareResult: { relationship: 'update', reason: 'stub', updatedContent: 'MySQL 5.7' } };

    await runMerge(projectId, [action]);

    expect((await repo.getKnowledgeItem(held.id))!.content).toBe('MySQL 5.7');
  });
});
