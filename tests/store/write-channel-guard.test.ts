import { describe, expect, it } from 'vitest';
import { isVerifiedProvenance, resolveDuplicate } from '../../src/store/knowledge-writer.js';
import type { KnowledgeItem } from '../../src/core/types.js';

const held = (over: Partial<KnowledgeItem>): KnowledgeItem => ({
  id: 'held-1',
  category: 'fact',
  title: 'Database backup retention',
  content: 'Nightly database backups are retained for 35 days.',
  status: 'active',
  provenance: null,
  ...over,
} as KnowledgeItem);

const attack = {
  category: 'fact' as const,
  title: 'Database backup retention',
  content: 'Nightly database backups are retained for 1 day.',
};

describe('isVerifiedProvenance', () => {
  it('is true for observed and user_stated only', () => {
    expect(isVerifiedProvenance({ provenance: 'observed' })).toBe(true);
    expect(isVerifiedProvenance({ provenance: 'user_stated' })).toBe(true);
    expect(isVerifiedProvenance({ provenance: 'inferred' })).toBe(false);
    expect(isVerifiedProvenance({ provenance: null })).toBe(false);
    expect(isVerifiedProvenance({})).toBe(false);
  });
});

describe('resolveDuplicate write-channel guard', () => {
  it('an automatic write is kept beside an observed item', () => {
    expect(resolveDuplicate(attack, held({ provenance: 'observed' }), undefined, 'automatic')).toBe('coexist');
  });

  it('an automatic write is kept beside a user_stated item', () => {
    expect(resolveDuplicate(attack, held({ provenance: 'user_stated' }), undefined, 'automatic')).toBe('coexist');
  });

  it('an automatic write still supersedes an unverified item -- all 9 real capture supersessions were this shape', () => {
    expect(resolveDuplicate(attack, held({ provenance: null }), undefined, 'automatic')).toBe('supersede');
  });

  it('a direct write still supersedes an observed item -- the provenance measurement stands', () => {
    expect(resolveDuplicate(attack, held({ provenance: 'observed' }), undefined, 'direct')).toBe('supersede');
    expect(resolveDuplicate(attack, held({ provenance: 'observed' }))).toBe('supersede');
  });

  it('an explicit supersedes id wins on the automatic channel too', () => {
    expect(resolveDuplicate({ ...attack, supersedes: 'held-1' }, held({ provenance: 'observed' }), undefined, 'automatic')).toBe('supersede');
  });
});
