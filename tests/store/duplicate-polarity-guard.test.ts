import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, initDb } from '../../src/store/database.js';
import * as repo from '../../src/store/repository.js';
import {
  differsOnlyInPolarity,
  resolveDuplicate,
  sameSubjectTitle,
  storeKnowledgeItemDeduped,
} from '../../src/store/knowledge-writer.js';
import type { KnowledgeItem } from '../../src/core/types.js';

/**
 * Both guards on the supersede branch. The cases below are the ones that were measured to
 * supersede before the guards existed, so each `toBe('coexist')` is a regression pin on a write
 * that used to be silently lost.
 */

const held = (over: Partial<KnowledgeItem>): KnowledgeItem => ({
  id: 'held-1',
  category: 'fact',
  title: '',
  content: '',
  status: 'active',
  provenance: null,
  ...over,
} as KnowledgeItem);

describe('differsOnlyInPolarity', () => {
  it('sees a negation added to an otherwise identical title', () => {
    expect(differsOnlyInPolarity(
      { title: 'Reranker is the right call' },
      { title: 'Reranker is not the right call' },
    )).toBe(true);
  });

  it('is symmetric -- the affirmative arriving second is the same pair', () => {
    expect(differsOnlyInPolarity(
      { title: 'Reranker is not the right call' },
      { title: 'Reranker is the right call' },
    )).toBe(true);
  });

  it('sees the multi-word "no longer" form', () => {
    expect(differsOnlyInPolarity(
      { title: 'Push gate blocks default branch' },
      { title: 'Push gate no longer blocks default branch' },
    )).toBe(true);
  });

  it('does not fire when the longer title adds real information', () => {
    expect(differsOnlyInPolarity(
      { title: 'Cloud send works' },
      { title: 'Cloud send works end to end in production' },
    )).toBe(false);
  });

  it('does not fire on identical token sets -- that is a plain duplicate, not a polarity pair', () => {
    expect(differsOnlyInPolarity(
      { title: 'Cache TTL' },
      { title: 'Cache TTL' },
    )).toBe(false);
  });

  it('leaves ambiguous stems alone: "can" is a real title word, not a negation', () => {
    expect(differsOnlyInPolarity(
      { title: 'Gate blocks the branch' },
      { title: 'Gate can blocks the branch' },
    )).toBe(false);
  });
});

describe('resolveDuplicate polarity guard', () => {
  const incoming = { category: 'fact' as const, title: 'Reranker is the right call', content: 'Yes.' };
  const negation = held({ title: 'Reranker is not the right call', content: 'No.' });

  it('the titles are still the same subject -- the guard is a resolution rule, not a subject test', () => {
    expect(sameSubjectTitle(incoming, negation)).toBe(true);
  });

  it('clamps to coexist instead of retiring the negation', () => {
    expect(resolveDuplicate(incoming, negation)).toBe('coexist');
  });

  it('an explicit supersedes id still wins -- the caller may always be deliberate', () => {
    expect(resolveDuplicate({ ...incoming, supersedes: negation.id }, negation)).toBe('supersede');
  });

  it('still supersedes when the longer title adds information rather than polarity', () => {
    expect(resolveDuplicate(
      { category: 'fact', title: 'Cloud send works end to end in production', content: 'Verified.' },
      held({ title: 'Cloud send works', content: 'Probably.' }),
    )).toBe('supersede');
  });
});

describe('resolveDuplicate grounding guard', () => {
  const grounded = held({ title: 'Vector dim', content: 'It is 768.', provenance: 'observed' });

  it('an unclaimed write does not retire an observed one', () => {
    expect(resolveDuplicate(
      { category: 'fact', title: 'Vector dim setting', content: 'It is 1024.' },
      grounded,
    )).toBe('coexist');
  });

  it('a write that claims grounding may retire an observed one', () => {
    expect(resolveDuplicate(
      { category: 'fact', title: 'Vector dim setting', content: 'It is 1024.', provenance: 'observed' },
      grounded,
    )).toBe('supersede');
  });

  it('user_stated counts as a claim on both sides', () => {
    expect(resolveDuplicate(
      { category: 'fact', title: 'Vector dim setting', content: 'It is 1024.', provenance: 'user_stated' },
      held({ title: 'Vector dim', content: 'It is 768.', provenance: 'user_stated' }),
    )).toBe('supersede');
  });

  it('is one-directional: an observed write may retire an unclaimed predecessor', () => {
    expect(resolveDuplicate(
      { category: 'fact', title: 'Vector dim setting', content: 'It is 1024.', provenance: 'observed' },
      held({ title: 'Vector dim', content: 'It is 768.' }),
    )).toBe('supersede');
  });

  it('leaves the unclaimed-to-unclaimed majority path untouched', () => {
    expect(resolveDuplicate(
      { category: 'fact', title: 'Vector dim setting', content: 'It is 1024.' },
      held({ title: 'Vector dim', content: 'It is 768.' }),
    )).toBe('supersede');
  });
});

describe('the negation survives a real write', () => {
  const ROOT = path.resolve('./.knowl-polarity-guard-test');
  let projectId = '';

  beforeAll(async () => {
    await fs.rm(ROOT, { recursive: true, force: true });
    await fs.mkdir(path.join(ROOT, '.knowl'), { recursive: true });
    await initDb(ROOT);
    projectId = (await repo.createProject(ROOT, 'polarity')).id;
  });
  afterAll(async () => {
    await closeDb();
    await fs.rm(ROOT, { recursive: true, force: true }).catch(() => {});
  });

  it('the 2026-08-13 push-gate reversal shape leaves both claims active', async () => {
    const reversal = await storeKnowledgeItemDeduped(projectId, {
      category: 'decision',
      title: 'Push gate no longer blocks default branch',
      content: 'The default-branch and behind-remote blocking gate was removed.',
    });
    expect(reversal.action).toBe('inserted');

    const restatement = await storeKnowledgeItemDeduped(projectId, {
      category: 'decision',
      title: 'Push gate blocks default branch',
      content: 'Pushing from the default branch is refused.',
    });
    expect(restatement.action).toBe('inserted');

    // The load-bearing assertion: before the guard this read 'superseded', and the store was
    // left asserting the opposite of a decision it had recorded.
    const first = await repo.getKnowledgeItem(reversal.item.id);
    expect(first!.status).toBe('active');
    expect(first!.supersededById).toBeFalsy();
    expect((await repo.getKnowledgeItem(restatement.item.id))!.status).toBe('active');
  });
});
