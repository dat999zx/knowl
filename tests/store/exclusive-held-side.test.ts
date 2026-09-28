import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, initDb } from '../../src/store/database.js';
import * as repo from '../../src/store/repository.js';
import { resolveDuplicate, storeKnowledgeAtomsDeduped, storeKnowledgeItemDeduped } from '../../src/store/knowledge-writer.js';
import type { KnowledgeItem } from '../../src/core/types.js';
import { KnowledgeConflictError } from '../../src/core/errors.js';
import { checkKnowledgeConflict } from '../../src/store/conflicts.js';

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

  it('an exact restatement is still a no-op, not a twin', () => {
    expect(resolveDuplicate({ ...attack, content: 'Production runs on PostgreSQL 16.' }, held({}))).toBe('no-op');
  });

  it('an explicit supersedes still retires it', () => {
    expect(resolveDuplicate({ ...attack, supersedes: 'held-1' }, held({}))).toBe('supersede');
  });

  it('a non-exclusive item is superseded as before, even when it carries a key', () => {
    expect(resolveDuplicate(attack, held({ conflictExclusive: false }))).toBe('supersede');
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

describe('supersedes retires an exclusive item from a write claiming the same key (#165 R3 F2)', () => {
  const ROOT = path.resolve('./.knowl-exclusive-supersedes-test');
  let projectId = '';
  beforeAll(async () => {
    await fs.rm(ROOT, { recursive: true, force: true });
    await fs.mkdir(path.join(ROOT, '.knowl'), { recursive: true });
    await initDb(ROOT);
    projectId = (await repo.createProject(ROOT, 'exclusive-supersedes')).id;
  });
  afterAll(async () => { await closeDb(); await fs.rm(ROOT, { recursive: true, force: true }).catch(() => {}); });

  const seedKey = (conflictKey: string) => storeKnowledgeItemDeduped(projectId, {
    category: 'decision', title: `Engine for ${conflictKey}`, content: 'Production runs on PostgreSQL 16.',
    conflictKey, conflictExclusive: true,
  });
  const correction = (conflictKey: string, supersedes: string) => ({
    category: 'decision' as const, title: `Engine for ${conflictKey}`, content: 'Production now runs on MySQL 8.',
    conflictKey, conflictExclusive: true, supersedes,
  });

  it('single writer: the correction carrying the same key retires the named holder', async () => {
    const seed = await seedKey('db.single');
    const write = await storeKnowledgeItemDeduped(projectId, correction('db.single', seed.item.id));
    expect((await repo.getKnowledgeItem(seed.item.id))!.status).toBe('superseded');
    const after = (await repo.getKnowledgeItem(write.item.id))!;
    expect(after.status).toBe('active');
    expect(after.conflictKey).toBe('db.single');
    expect(after.conflictExclusive).toBe(true);
  });

  it('batch writer: the same', async () => {
    const seed = await seedKey('db.batch');
    const batch = await storeKnowledgeAtomsDeduped(projectId, [correction('db.batch', seed.item.id)]);
    expect((await repo.getKnowledgeItem(seed.item.id))!.status).toBe('superseded');
    expect(batch.supersededIds).toEqual([seed.item.id]);
    const after = (await repo.getKnowledgeItem(batch.outcomes[0].itemId))!;
    expect(after.status).toBe('active');
    expect(after.conflictKey).toBe('db.batch');
  });

  it('single writer: naming some other item does not clear the holder, and the write is refused', async () => {
    const seed = await seedKey('db.other.single');
    const bystander = await storeKnowledgeItemDeduped(projectId, {
      category: 'fact', title: 'Unrelated bystander one', content: 'Logs rotate daily.',
    });
    await expect(storeKnowledgeItemDeduped(projectId, correction('db.other.single', bystander.item.id)))
      .rejects.toBeInstanceOf(KnowledgeConflictError);
    expect((await repo.getKnowledgeItem(seed.item.id))!.status).toBe('active');
  });

  // The writer retires a qualifying duplicate ahead of the named item, so naming the holder must
  // not exempt it when something else is what actually gets retired.
  for (const [label, write] of [
    ['single writer', (input: any) => storeKnowledgeItemDeduped(projectId, input)],
    ['batch writer', (input: any) => storeKnowledgeAtomsDeduped(projectId, [input])],
  ] as const) {
    // An explicit `supersedes` outranks a detected duplicate (#165 R5), so the item named is the
    // one retired: the key keeps exactly one active answer, and the decoy stays beside the write.
    it(`${label}: naming the holder retires the holder, not a different duplicate`, async () => {
      const key = `db.decoy.${label.split(' ')[0]}`;
      const holder = await seedKey(key);
      const decoy = await storeKnowledgeItemDeduped(projectId, {
        category: 'decision', title: `Reporting cache layer ${label}`, content: 'Reports read from a nightly snapshot.',
      });
      await write({
        category: 'decision', title: `Reporting cache layer ${label}`, content: 'Reports read from a live replica.',
        conflictKey: key, conflictExclusive: true, supersedes: holder.item.id,
      });
      expect((await repo.getKnowledgeItem(holder.item.id))!.status).toBe('superseded');
      expect((await repo.getKnowledgeItem(decoy.item.id))!.status).toBe('active');
    });
  }

  // The single writer's in-transaction check would refuse either way, so this pins the early one alone.
  it('checkKnowledgeConflict drops only the holder the write names', async () => {
    const seed = await seedKey('db.check');
    const bystander = await storeKnowledgeItemDeduped(projectId, {
      category: 'fact', title: 'Unrelated bystander three', content: 'Alerts page the on-call rotation.',
    });
    const claim = { conflictKey: 'db.check', conflictExclusive: true };
    expect(await checkKnowledgeConflict({ ...claim, supersedes: seed.item.id })).toEqual([]);
    expect((await checkKnowledgeConflict({ ...claim, supersedes: bystander.item.id })).map(item => item.id))
      .toEqual([seed.item.id]);
  });

  it('batch writer: naming some other item does not clear the holder, and the write is refused', async () => {
    const seed = await seedKey('db.other.batch');
    const bystander = await storeKnowledgeItemDeduped(projectId, {
      category: 'fact', title: 'Unrelated bystander two', content: 'Metrics are scraped every 15 seconds.',
    });
    await expect(storeKnowledgeAtomsDeduped(projectId, [correction('db.other.batch', bystander.item.id)]))
      .rejects.toBeInstanceOf(KnowledgeConflictError);
    expect((await repo.getKnowledgeItem(seed.item.id))!.status).toBe('active');
  });
});
