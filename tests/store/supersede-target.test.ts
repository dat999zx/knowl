import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, initDb } from '../../src/store/database.js';
import * as repo from '../../src/store/repository.js';
import type { KnowledgeCategory } from '../../src/core/types.js';
import {
  findLikelyDuplicateKnowledgeItem, resolveDuplicate, storeKnowledgeAtomsDeduped, storeKnowledgeItemDeduped,
} from '../../src/store/knowledge-writer.js';
import { recordDecisionDirect } from '../../src/store/knowledge-actions.js';

const ROOT = path.resolve('./.knowl-supersede-target-test');

/**
 * A write that names X in `supersedes` while fuzzy-matching a same-subject Y used to retire Y and
 * leave X active: the detected duplicate outranked the id the caller asked for. Each case seeds
 * the pair, asks the duplicate search which one it finds, and names the OTHER, so the test holds
 * whichever of the two the search happens to rank first.
 */
describe('an explicit supersedes target outranks a detected duplicate', () => {
  let projectId = '';
  beforeAll(async () => {
    await fs.rm(ROOT, { recursive: true, force: true });
    await fs.mkdir(path.join(ROOT, '.knowl'), { recursive: true });
    await initDb(ROOT);
    projectId = (await repo.createProject(ROOT, 'supersede-target')).id;
  });
  afterAll(async () => { await closeDb(); await fs.rm(ROOT, { recursive: true, force: true }).catch(() => {}); });

  const CACHE_TTL = {
    x: { title: 'Cache TTL policy', content: 'API responses are cached for 60 seconds by policy.' },
    y: { title: 'Cache TTL', content: 'Cached API responses expire after 60 seconds.' },
    incoming: { title: 'Cache TTL policy for the API tier', content: 'API tier responses are cached for 120 seconds.' },
  };
  const incoming = (category: KnowledgeCategory, texts = CACHE_TTL) => ({ category, ...texts.incoming });

  async function seedPair(category: KnowledgeCategory, texts = CACHE_TTL) {
    // Written past the dedup path: the two titles are the same subject, so storing the second
    // through it would retire the first before the case under test began.
    const x = await repo.createKnowledgeItem(projectId, { category, ...texts.x });
    const y = await repo.createKnowledgeItem(projectId, { category, ...texts.y });
    const detected = await findLikelyDuplicateKnowledgeItem(projectId, incoming(category, texts));
    expect([x.id, y.id]).toContain(detected?.id);
    // The detected one must qualify on its own, or the explicit id already won before the fix.
    expect(resolveDuplicate(incoming(category, texts), detected!)).toBe('supersede');
    const named = detected!.id === x.id ? y : x;
    return { detected: detected!, named };
  }

  it('retires the named item and reports the detected one as left beside it', async () => {
    const { detected, named } = await seedPair('fact');
    const written = await storeKnowledgeItemDeduped(projectId, { ...incoming('fact'), supersedes: named.id });

    expect(written.superseded?.id).toBe(named.id);
    expect((await repo.getKnowledgeItem(named.id))!.status).toBe('superseded');
    expect((await repo.getKnowledgeItem(detected.id))!.status).toBe('active');
    expect(written.nearDuplicate?.id).toBe(detected.id);
  });

  it('does the same in the batch path', async () => {
    const { detected, named } = await seedPair('constraint');
    const result = await storeKnowledgeAtomsDeduped(projectId, [{ ...incoming('constraint'), supersedes: named.id }]);

    expect(result.supersededIds).toEqual([named.id]);
    expect((await repo.getKnowledgeItem(detected.id))!.status).toBe('active');
    expect(result.outcomes[0].nearDuplicateId).toBe(detected.id);
  });

  it('does the same for a recorded decision', async () => {
    const { detected, named } = await seedPair('decision');
    const { category: _category, ...decision } = incoming('decision');
    const result = await recordDecisionDirect(projectId, { ...decision, supersedes: named.id });

    expect(result.superseded?.id).toBe(named.id);
    expect((await repo.getKnowledgeItem(named.id))!.status).toBe('superseded');
    expect((await repo.getKnowledgeItem(detected.id))!.status).toBe('active');
    expect(result.nearDuplicate?.id).toBe(detected.id);
  });

  // The duplicate left beside is announced once, as `nearDuplicate`, and not a second time as the
  // reversal the write's own content names. Unique titles, because the reversal detector only
  // counts title tokens that few active titles share, and this file's "Cache TTL" pairs share them.
  const LEDGER = {
    x: { title: 'Ledger export format policy', content: 'The ledger export format policy is CSV for every consumer.' },
    y: { title: 'Ledger export format', content: 'The ledger export format is CSV with a header row.' },
    incoming: { title: 'Ledger export format policy for auditors', content: 'The ledger export format is no longer CSV; auditors receive Parquet.' },
  };
  const JOURNAL = {
    x: { title: 'Journal archive layout policy', content: 'The journal archive layout policy is one tarball per month.' },
    y: { title: 'Journal archive layout', content: 'The journal archive layout is one tarball per month, gzip.' },
    incoming: { title: 'Journal archive layout policy for auditors', content: 'The journal archive layout is no longer monthly tarballs; auditors receive daily zips.' },
  };

  it('does not also announce the duplicate left beside as a reversal', async () => {
    const { detected, named } = await seedPair('state', LEDGER);
    const written = await storeKnowledgeItemDeduped(projectId, { ...incoming('state', LEDGER), supersedes: named.id });

    expect(written.nearDuplicate?.id).toBe(detected.id);
    expect(written.reversal).toBeUndefined();
  });

  it('does not also announce it as a reversal in the batch path', async () => {
    const { detected, named } = await seedPair('constraint', JOURNAL);
    const result = await storeKnowledgeAtomsDeduped(projectId, [{ ...incoming('constraint', JOURNAL), supersedes: named.id }]);

    expect(result.outcomes[0].nearDuplicateId).toBe(detected.id);
    expect(result.outcomes[0].reversal).toBeUndefined();
  });

  it('a duplicate that WAS retired is not also reported as left beside', async () => {
    const { detected } = await seedPair('goal');
    const written = await storeKnowledgeItemDeduped(projectId, incoming('goal'));

    expect(written.superseded?.id).toBe(detected.id);
    expect(written.nearDuplicate).toBeUndefined();
  });

  it('an explicit id that is no longer active falls back to the detected duplicate', async () => {
    // Re-retiring it would overwrite the successor its history already names.
    const { detected, named } = await seedPair('architecture');
    await repo.updateKnowledgeItem(named.id, { status: 'superseded', supersededById: detected.id });
    const written = await storeKnowledgeItemDeduped(projectId, { ...incoming('architecture'), supersedes: named.id });

    expect(written.superseded?.id).toBe(detected.id);
    expect((await repo.getKnowledgeItem(named.id))!.supersededById).toBe(detected.id);
  });

  it('a verbatim restatement that retires another item by id reports the twin it left active', async () => {
    // The write is inserted only because it names another item, so its byte-identical twin stays
    // active beside it -- two active copies of one answer, which the caller has to be told about.
    const twin = await repo.createKnowledgeItem(projectId, {
      category: 'fact', title: 'Queue driver', content: 'Background jobs run on Redis.',
    });
    const retired = await repo.createKnowledgeItem(projectId, {
      category: 'fact', title: 'Worker transport', content: 'Workers poll a Postgres table for jobs.',
    });
    const written = await storeKnowledgeItemDeduped(projectId, {
      category: 'fact', title: 'Queue driver', content: 'Background jobs run on Redis.', supersedes: retired.id,
    });

    expect(written.superseded?.id).toBe(retired.id);
    expect((await repo.getKnowledgeItem(twin.id))!.status).toBe('active');
    expect(written.nearDuplicate?.id).toBe(twin.id);
  });
});
