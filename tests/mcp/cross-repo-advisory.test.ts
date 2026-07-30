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
});
