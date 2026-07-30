import { describe, expect, it } from 'vitest';
import { hashKnowledgeContent, hashKnowledgeLifecycle } from '../../src/store/freshness.js';
import { classifyIncomingItem } from '../../src/store/import-policy.js';

const base = {
  status: 'active',
  freshness: 'fresh',
  supersededById: null,
  originRepo: 'server',
  visibility: 'repo',
};

describe('hashKnowledgeLifecycle', () => {
  it('changes when visibility changes', () => {
    // The case that silently did not converge: promoting an item to workspace visibility
    // left content_hash untouched, so an export carried nothing an importer could act on.
    expect(hashKnowledgeLifecycle({ ...base, visibility: 'workspace' }))
      .not.toBe(hashKnowledgeLifecycle(base));
  });

  it('changes when status changes', () => {
    expect(hashKnowledgeLifecycle({ ...base, status: 'superseded' }))
      .not.toBe(hashKnowledgeLifecycle(base));
  });

  it('changes when supersession changes', () => {
    expect(hashKnowledgeLifecycle({ ...base, supersededById: 'abc' }))
      .not.toBe(hashKnowledgeLifecycle(base));
  });

  it('changes when freshness changes', () => {
    expect(hashKnowledgeLifecycle({ ...base, freshness: 'stale' }))
      .not.toBe(hashKnowledgeLifecycle(base));
  });

  it('changes when the owning repo changes', () => {
    expect(hashKnowledgeLifecycle({ ...base, originRepo: 'api' }))
      .not.toBe(hashKnowledgeLifecycle(base));
  });

  it('excludes confidence, which moves on ordinary use', () => {
    // Including it would leave almost every item permanently divergent.
    expect(hashKnowledgeLifecycle({ ...base, confidence: 0.5 } as never))
      .toBe(hashKnowledgeLifecycle(base));
  });

  it('treats absent fields as the defaults a fresh item carries', () => {
    expect(hashKnowledgeLifecycle({})).toBe(hashKnowledgeLifecycle({
      status: 'active', freshness: 'fresh', supersededById: null, originRepo: null, visibility: 'repo',
    }));
  });

  it('leaves content_hash untouched, so item identity is unchanged', () => {
    // Widening content_hash was the alternative, and it would have changed every existing
    // item's identity and broken the verbatim adoption that makes re-import idempotent.
    const content = { title: 'T', content: 'C', reasoning: null, source: null, affectedPaths: null };
    const before = hashKnowledgeContent(content);
    hashKnowledgeLifecycle({ ...base, visibility: 'workspace' });
    expect(hashKnowledgeContent(content)).toBe(before);
  });
});

describe('classifyIncomingItem', () => {
  const local = {
    id: 'x',
    contentHash: 'c1',
    lifecycleHash: 'l1',
    updatedAt: '2026-01-02T00:00:00.000Z',
    version: 2,
  };

  it('is identical when both hashes match', () => {
    expect(classifyIncomingItem({ ...local }, local)).toBe('identical');
  });

  it('is metadata-divergent when only the lifecycle hash differs', () => {
    expect(classifyIncomingItem({ ...local, lifecycleHash: 'l2' }, local)).toBe('metadata-divergent');
  });

  it('is divergent when the content hash differs, whatever the lifecycle hash', () => {
    expect(classifyIncomingItem({ ...local, contentHash: 'c2' }, local)).toBe('divergent');
    expect(classifyIncomingItem({ ...local, contentHash: 'c2', lifecycleHash: 'l2' }, local)).toBe('divergent');
  });

  it('is new when there is no local row', () => {
    expect(classifyIncomingItem({ ...local }, undefined)).toBe('new');
  });

  it('derives a missing incoming lifecycle hash from the fields the file does carry', () => {
    // A version-1 export has no lifecycle hash, but it does carry status, freshness,
    // supersession, origin_repo and visibility -- it serialises whole item objects. Treating
    // the missing hash as agreement threw that information away, so a promotion exported by
    // an older build could never converge. Same for a row whose column was never backfilled.
    const fields = { status: 'active', freshness: 'fresh', supersededById: null, originRepo: 'server', visibility: 'repo' };
    const localRow = { ...local, ...fields, lifecycleHash: hashKnowledgeLifecycle(fields) };

    expect(classifyIncomingItem({ ...localRow, lifecycleHash: undefined }, localRow)).toBe('identical');
    expect(classifyIncomingItem({ ...localRow, lifecycleHash: undefined, visibility: 'workspace' }, localRow))
      .toBe('metadata-divergent');
  });

  it('derives a missing local lifecycle hash too, so an un-backfilled row still converges', () => {
    // The column is added without a backfill, so every row written before it existed has
    // NULL. Comparing an incoming hash against NULL as a plain string made every such row
    // report metadata-divergent on the first import even when nothing had changed.
    const fields = { status: 'active', freshness: 'fresh', supersededById: null, originRepo: 'server', visibility: 'repo' };
    const unbackfilled = { ...local, ...fields, lifecycleHash: null };

    expect(classifyIncomingItem({ ...unbackfilled, lifecycleHash: hashKnowledgeLifecycle(fields) }, unbackfilled))
      .toBe('identical');
    expect(classifyIncomingItem(
      { ...unbackfilled, visibility: 'workspace', lifecycleHash: hashKnowledgeLifecycle({ ...fields, visibility: 'workspace' }) },
      unbackfilled,
    )).toBe('metadata-divergent');
  });
});
