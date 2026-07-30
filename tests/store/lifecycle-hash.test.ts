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

  it('treats a missing incoming lifecycle hash as agreement, so v1 exports still import', () => {
    // A version-1 export carries no lifecycle hash at all. Reading its absence as a
    // difference would classify every legacy file as metadata-divergent.
    expect(classifyIncomingItem({ ...local, lifecycleHash: undefined }, local)).toBe('identical');
    expect(classifyIncomingItem({ ...local, lifecycleHash: null }, local)).toBe('identical');
  });

  it('is metadata-divergent when the local row has no lifecycle hash but the incoming one does', () => {
    // The upgrade direction: a v2 export landing on a database bootstrapped before the
    // column was backfilled must still converge rather than silently skip.
    expect(classifyIncomingItem({ ...local, lifecycleHash: 'l1' }, { ...local, lifecycleHash: null }))
      .toBe('metadata-divergent');
  });
});
