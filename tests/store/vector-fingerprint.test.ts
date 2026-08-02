import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { closeDb, getClient, initDb } from '../../src/store/database.js';
import * as repo from '../../src/store/repository.js';
import { fingerprintProfile } from '../../src/core/vector-profile.js';
import {
  purgeEmbeddingsNotMatching, searchKnowledgeEmbeddings, upsertKnowledgeEmbedding,
} from '../../src/store/vector.js';

const TEST_ROOT = path.resolve('./.knowl-test-vector-fingerprint');

const Q8 = fingerprintProfile({ provider: 'local', model: 'a/b', dtype: 'q8', pooling: 'cls' });
const FP32 = fingerprintProfile({ provider: 'local', model: 'a/b', dtype: 'fp32', pooling: 'cls' });
const MEAN = fingerprintProfile({ provider: 'local', model: 'a/b', dtype: 'q8', pooling: 'mean' });

let projectId: string;

async function seedOneItem() {
  const item = await repo.createKnowledgeItem(projectId, {
    category: 'fact', title: 'first', content: 'first body',
  });
  return { projectId, itemId: item.id };
}

async function seedTwoItems() {
  const first = await seedOneItem();
  const other = await repo.createKnowledgeItem(projectId, {
    category: 'fact', title: 'second', content: 'second body',
  });
  return { ...first, otherItemId: other.id };
}

describe('embedding profile fingerprint', () => {
  beforeAll(async () => {
    await fs.rm(TEST_ROOT, { recursive: true, force: true }).catch(() => {});
    await fs.mkdir(path.join(TEST_ROOT, '.knowl'), { recursive: true });
    await initDb(TEST_ROOT);
    const project = await repo.createProject(TEST_ROOT, 'fingerprint fixture');
    projectId = project.id;
  });

  afterAll(async () => {
    await closeDb();
    await fs.rm(TEST_ROOT, { recursive: true, force: true }).catch(() => {});
  });

  beforeEach(async () => {
    await getClient().execute('DELETE FROM knowledge_embeddings');
    await getClient().execute('DELETE FROM knowledge_items');
  });

  it('hides rows written under a different dtype', async () => {
    const { itemId } = await seedOneItem();
    await upsertKnowledgeEmbedding({
      projectId, knowledgeItemId: itemId,
      provider: 'local', model: 'a/b', profileFingerprint: Q8,
      dimensions: 3, vector: [1, 0, 0],
    });

    const sameProfile = await searchKnowledgeEmbeddings(projectId, { vector: [1, 0, 0], profileFingerprint: Q8 });
    expect(sameProfile).toHaveLength(1);

    const afterDtypeChange = await searchKnowledgeEmbeddings(projectId, { vector: [1, 0, 0], profileFingerprint: FP32 });
    expect(afterDtypeChange).toHaveLength(0);
  });

  it('hides rows written under a different pooling', async () => {
    const { itemId } = await seedOneItem();
    await upsertKnowledgeEmbedding({
      projectId, knowledgeItemId: itemId,
      provider: 'local', model: 'a/b', profileFingerprint: Q8,
      dimensions: 3, vector: [1, 0, 0],
    });

    expect(await searchKnowledgeEmbeddings(projectId, { vector: [1, 0, 0], profileFingerprint: MEAN })).toHaveLength(0);
  });

  it('purges only rows that do not match the current fingerprint', async () => {
    const { itemId, otherItemId } = await seedTwoItems();
    await upsertKnowledgeEmbedding({
      projectId, knowledgeItemId: itemId,
      provider: 'local', model: 'a/b', profileFingerprint: Q8, dimensions: 3, vector: [1, 0, 0],
    });
    await upsertKnowledgeEmbedding({
      projectId, knowledgeItemId: otherItemId,
      provider: 'local', model: 'a/b', profileFingerprint: FP32, dimensions: 3, vector: [0, 1, 0],
    });

    expect(await purgeEmbeddingsNotMatching(projectId, Q8)).toBe(1);
    expect(await searchKnowledgeEmbeddings(projectId, { vector: [1, 0, 0], profileFingerprint: Q8 })).toHaveLength(1);
  });
});
