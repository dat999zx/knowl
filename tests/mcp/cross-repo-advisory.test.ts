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

  describe('governing decision', () => {
    const governed = () => describeWriteReconciliation({
      item: { id: 'new-3' },
      governingDecision: {
        id: 'dec-1',
        title: 'Do not strip MCP tool-argument descriptions — quality over token savings',
        score: 0.93,
        via: 'calibrated',
      },
    });

    it('names the decision and its id, because a note you cannot look up is not actionable', () => {
      expect(governed()).toContain('dec-1');
      expect(governed()).toContain('Do not strip MCP tool-argument descriptions');
    });

    // The measured behaviour is that this retrieves a plausible-but-wrong decision a minority of
    // the time, so the note has to read as a question. If it ever starts asserting that the
    // decision governs, it will be confidently wrong on those and teach agents to discount it.
    it('says the write stands and hedges rather than ruling', () => {
      const note = governed();
      expect(note).toMatch(/may already govern/i);
      expect(note).toMatch(/nothing was blocked/i);
      expect(note).toMatch(/if it is about something else, ignore/i);
      expect(note).not.toMatch(/\brefused\b|\bblocked your\b|\bcannot store\b/i);
    });

    it('says nothing at all when no decision matched', () => {
      expect(describeWriteReconciliation({ item: { id: 'new-4' } })).toBe('');
    });
  });
});
