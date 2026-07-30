import { describe, expect, it } from 'vitest';
import { describeWriteReconciliation } from '../../src/mcp/tools.js';

describe('cross-repo advisory reaches the agent', () => {
  it('names the owning repo and says the item cannot be changed from here', () => {
    const text = describeWriteReconciliation({
      item: { id: 'new-1' },
      crossRepo: [{ repo: 'web', id: 'web-9', title: 'Session store is redis', kind: 'duplicate' }],
    });

    expect(text).toContain('web');
    expect(text).toContain('web-9');
    expect(text).toContain('Session store is redis');
    // The instruction that differs from the local near-duplicate note: no knowl_update here.
    // That item belongs to another repo and assertOwnedItem refuses the call.
    expect(text).toMatch(/cannot .*(retire|change|edit)/i);
  });

  it('distinguishes a contradiction from an overlap', () => {
    const conflict = describeWriteReconciliation({
      item: { id: 'new-1' },
      crossRepo: [{ repo: 'api', id: 'api-3', title: 'Session store is memcached', kind: 'conflict' }],
    });
    const duplicate = describeWriteReconciliation({
      item: { id: 'new-1' },
      crossRepo: [{ repo: 'api', id: 'api-3', title: 'Session store is memcached', kind: 'duplicate' }],
    });

    expect(conflict).toMatch(/contradict/i);
    expect(duplicate).not.toMatch(/contradict/i);
  });

  it('says nothing when there is no overlap, so ordinary writes are unchanged', () => {
    expect(describeWriteReconciliation({ item: { id: 'new-1' } })).toBe('');
  });

  it('still renders the local supersede and near-duplicate notes', () => {
    // Regression guard: the existing two branches must survive the third being added.
    const text = describeWriteReconciliation({
      item: { id: 'new-1' },
      superseded: { id: 'old-1', title: 'Old thing' },
      nearDuplicate: { id: 'dup-1', title: 'Similar thing' },
    });
    expect(text).toContain('old-1');
    expect(text).toContain('dup-1');
  });

  it('reports every overlapping repo, not just the first', () => {
    const text = describeWriteReconciliation({
      item: { id: 'new-1' },
      crossRepo: [
        { repo: 'web', id: 'web-9', title: 'Session store is redis', kind: 'duplicate' },
        { repo: 'api', id: 'api-3', title: 'Session store is redis', kind: 'conflict' },
      ],
    });
    expect(text).toContain('web-9');
    expect(text).toContain('api-3');
  });

  it('marks a kin repo and names what it is, so a same-subject hit reads as divergence', () => {
    const note = describeWriteReconciliation({
      item: { id: 'new-1' },
      crossRepo: [{
        repo: 'duck', id: 'peer-1', title: 'Wire format is JSON',
        kind: 'conflict', kin: true, role: 'the other fork of this service',
      }],
    });
    expect(note).toContain('"duck"');
    expect(note).toContain('the other fork of this service');
    expect(note).toMatch(/shares this repo's lineage/i);
  });

  it('leaves an unrelated repo advisory exactly as it was', () => {
    const note = describeWriteReconciliation({
      item: { id: 'new-2' },
      crossRepo: [{ repo: 'other', id: 'peer-2', title: 'Something', kind: 'duplicate' }],
    });
    expect(note).not.toMatch(/lineage/i);
    expect(note).toContain('OVERLAPS linked repo "other"');
  });
});
