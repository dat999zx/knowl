import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, initDb } from '../../src/store/database.js';
import * as repo from '../../src/store/repository.js';
import { dropsValuesOnly, resolveDuplicate, storeKnowledgeItemDeduped } from '../../src/store/knowledge-writer.js';
import type { KnowledgeItem } from '../../src/core/types.js';

const BACKUP = 'Nightly database backups are retained for 35 days and encrypted at rest.';
const VAGUE = 'Nightly database backups are retained for the value documented in the ops runbook and encrypted at rest.';

describe('dropsValuesOnly', () => {
  it('fires when the incoming write drops the held value and adds none (the #165 N2 shape)', () => {
    expect(dropsValuesOnly({ content: VAGUE }, { content: BACKUP })).toBe(true);
  });

  it('fires on a dropped mid-sentence proper noun', () => {
    expect(dropsValuesOnly(
      { content: 'Card payments are processed through a hosted page.' },
      { content: 'Card payments are processed through Stripe Checkout.' },
    )).toBe(true);
  });

  it('does not fire on a correction that swaps the value', () => {
    expect(dropsValuesOnly(
      { content: 'Nightly database backups are retained for 90 days and encrypted at rest.' },
      { content: BACKUP },
    )).toBe(false);
  });

  it('does not fire when every value is kept and prose is added', () => {
    expect(dropsValuesOnly(
      { content: `${BACKUP} Restores are tested monthly.` },
      { content: BACKUP },
    )).toBe(false);
  });

  it('does not fire when the held item carries no values', () => {
    expect(dropsValuesOnly(
      { content: 'Backups are kept for a while.' },
      { content: 'Backups are kept for some time and encrypted.' },
    )).toBe(false);
  });

  it('does not fire when a value is swapped, even if another is dropped', () => {
    expect(dropsValuesOnly(
      { content: 'Backups are retained for 90 days.' },
      { content: 'Backups are retained for 35 days in eu-central-1.' },
    )).toBe(false);
  });

  it('does not count a sentence-initial capital as a value', () => {
    // Were "Postgres" counted, the held item would carry a value the incoming one drops.
    expect(dropsValuesOnly(
      { content: 'the project data is stored locally.' },
      { content: 'Postgres stores the project data.' },
    )).toBe(false);
  });

  it('reads a version and a region as one token each', () => {
    expect(dropsValuesOnly(
      { content: 'All customer data is stored in the primary region.' },
      { content: 'All customer data is stored in eu-central-1 on v5.23.1.' },
    )).toBe(true);
    // Split on hyphens, both regions would share the token `1` and nothing would read as dropped.
    expect(dropsValuesOnly(
      { content: 'Replicas run in eu-west-1.' },
      { content: 'Replicas run in eu-central-1 and eu-west-1.' },
    )).toBe(true);
  });

  it('strips a sentence-ending dot before comparing', () => {
    expect(dropsValuesOnly(
      { content: 'Backups go to eu-central-1 and are kept a while.' },
      { content: 'Backups go to eu-central-1. They are kept 35 days.' },
    )).toBe(true);
  });

  it('compares values case-insensitively', () => {
    expect(dropsValuesOnly(
      { content: 'Stored in eu-central-1 for a while.' },
      { content: 'Stored in EU-Central-1 for 35 days.' },
    )).toBe(true);
  });

  it('treats a line break as a sentence boundary', () => {
    expect(dropsValuesOnly(
      { content: 'Payments:\nthey are handled elsewhere.' },
      { content: 'Payments:\nStripe handles cards.' },
    )).toBe(false);
  });

});

const held = (content: string): KnowledgeItem => ({
  id: 'held-1', category: 'fact', title: 'Database backup retention', content, status: 'active', provenance: null,
} as KnowledgeItem);

describe('resolveDuplicate value-free guard', () => {
  it('clamps a value-dropping restatement to coexist', () => {
    expect(resolveDuplicate({ category: 'fact', title: 'Database backup retention', content: VAGUE }, held(BACKUP))).toBe('coexist');
  });

  it('an explicit supersedes still wins', () => {
    expect(resolveDuplicate({ category: 'fact', title: 'Database backup retention', content: VAGUE, supersedes: 'held-1' }, held(BACKUP))).toBe('supersede');
  });

  it('a value-changing correction still supersedes', () => {
    expect(resolveDuplicate(
      { category: 'fact', title: 'Database backup retention', content: 'Nightly database backups are retained for 90 days and encrypted at rest.' },
      held(BACKUP),
    )).toBe('supersede');
  });
});

describe('a value-free restatement through a real write', () => {
  const ROOT = path.resolve('./.knowl-value-free-restatement-test');
  let projectId = '';
  beforeAll(async () => {
    await fs.rm(ROOT, { recursive: true, force: true });
    await fs.mkdir(path.join(ROOT, '.knowl'), { recursive: true });
    await initDb(ROOT);
    projectId = (await repo.createProject(ROOT, 'value-free')).id;
  });
  afterAll(async () => { await closeDb(); await fs.rm(ROOT, { recursive: true, force: true }).catch(() => {}); });

  it('leaves both active and reports the held one', async () => {
    const seed = await storeKnowledgeItemDeduped(projectId, { category: 'fact', title: 'Database backup retention', content: BACKUP });
    const vague = await storeKnowledgeItemDeduped(projectId, { category: 'fact', title: 'Database backup retention', content: VAGUE });

    expect((await repo.getKnowledgeItem(seed.item.id))!.status).toBe('active');
    expect(vague.superseded).toBeUndefined();
    expect(vague.nearDuplicate?.id).toBe(seed.item.id);
  });
});
