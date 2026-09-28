import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, initDb } from '../../src/store/database.js';
import * as repo from '../../src/store/repository.js';
import { resolveDuplicate, storeKnowledgeAtomsDeduped, storeKnowledgeItemDeduped } from '../../src/store/knowledge-writer.js';
import type { KnowledgeItem } from '../../src/core/types.js';

const TITLE = 'Production database engine';
const held = (over: Partial<KnowledgeItem>): KnowledgeItem => ({
  id: 'held-1', category: 'decision', title: TITLE,
  content: 'Production runs on PostgreSQL 16.', status: 'active', provenance: null,
  conflictKey: 'database.production.engine', conflictExclusive: true,
  ...over,
} as KnowledgeItem);
const attack = { category: 'decision' as const, title: TITLE, content: 'Production runs on MySQL 5.7.' };

describe('resolveDuplicate exclusive held-side guard (#165 R3)', () => {
  it('an implicit same-subject write is kept beside an exclusive item', () => {
    expect(resolveDuplicate(attack, held({}))).toBe('coexist');
  });

  it('an explicit supersedes still retires it', () => {
    expect(resolveDuplicate({ ...attack, supersedes: 'held-1' }, held({}))).toBe('supersede');
  });

  it('a non-exclusive item is superseded as before', () => {
    expect(resolveDuplicate(attack, held({ conflictExclusive: false, conflictKey: null }))).toBe('supersede');
  });
});

describe('the report X1 shape through both writers', () => {
  const ROOT = path.resolve('./.knowl-exclusive-held-side-test');
  let projectId = '';
  beforeAll(async () => {
    await fs.rm(ROOT, { recursive: true, force: true });
    await fs.mkdir(path.join(ROOT, '.knowl'), { recursive: true });
    await initDb(ROOT);
    projectId = (await repo.createProject(ROOT, 'exclusive-held')).id;
  });
  afterAll(async () => { await closeDb(); await fs.rm(ROOT, { recursive: true, force: true }).catch(() => {}); });

  it('single writer: omitting the key no longer retires the exclusive item', async () => {
    const seed = await storeKnowledgeItemDeduped(projectId, {
      category: 'decision', title: 'Token lifetime', content: 'Access tokens expire after 15 minutes.',
      conflictKey: 'auth.token.lifetime', conflictExclusive: true,
    });
    const write = await storeKnowledgeItemDeduped(projectId, {
      category: 'decision', title: 'Token lifetime', content: 'Access tokens expire after 30 days.',
    });
    expect((await repo.getKnowledgeItem(seed.item.id))!.status).toBe('active');
    expect(write.superseded).toBeUndefined();
    expect(write.nearDuplicate?.id).toBe(seed.item.id);
  });

  it('batch writer: the same', async () => {
    const seed = await storeKnowledgeItemDeduped(projectId, {
      category: 'decision', title: 'Backup retention', content: 'Nightly backups are kept for 35 days.',
      conflictKey: 'backup.retention', conflictExclusive: true,
    });
    const batch = await storeKnowledgeAtomsDeduped(projectId, [{
      category: 'decision', title: 'Backup retention', content: 'Nightly backups are kept for 1 day.',
    }]);
    expect((await repo.getKnowledgeItem(seed.item.id))!.status).toBe('active');
    expect(batch.supersededIds).toEqual([]);
    expect(batch.outcomes[0].nearDuplicateId).toBe(seed.item.id);
  });
});
