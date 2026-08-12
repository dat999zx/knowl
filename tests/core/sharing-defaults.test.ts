import { describe, expect, it } from 'vitest';
import { KNOWLEDGE_CATEGORIES, type KnowledgeCategory } from '../../src/core/types.js';
import {
  SHARED_BY_DEFAULT, WITHHELD_BY_DEFAULT, withholdReason,
} from '../../src/core/sharing-defaults.js';

describe('what is worth sharing by default', () => {
  it('shares the five a peer cannot work without', () => {
    expect([...SHARED_BY_DEFAULT].sort())
      .toEqual(['architecture', 'constraint', 'decision', 'goal', 'skill']);
  });

  it('withholds the two that are this repo talking about itself', () => {
    // fact and state are ~66% of a mature store and churn on every merge: commit-level
    // changelog and PR verdicts. That volume is the pollution the default exists to prevent.
    expect([...WITHHELD_BY_DEFAULT].sort()).toEqual(['fact', 'state']);
  });

  it('covers every category exactly once, so a new one cannot be silently forgotten', () => {
    const covered = [...SHARED_BY_DEFAULT, ...WITHHELD_BY_DEFAULT].sort();
    expect(covered).toEqual([...KNOWLEDGE_CATEGORIES].sort());
    expect(new Set(covered).size).toBe(KNOWLEDGE_CATEGORIES.length);
  });

  it('reports zero recommended when the shared five are exhausted', async () => {
    // The state a repo lands in after sharing once: new writes reach the destination on their
    // own, so the recommended categories empty out while fact and state keep growing. Opening
    // a picker there offers a list of zeros, and dismissing it reads as a bug rather than as
    // "you are already up to date".
    const { recommendedTotal } = await import('../../src/core/sharing-defaults.js');
    const exhausted = {
      fact: 133, state: 146,
      decision: 0, goal: 0, constraint: 0, architecture: 0, skill: 0,
    } as Record<KnowledgeCategory, number>;

    expect(recommendedTotal(exhausted)).toBe(0);
    expect(recommendedTotal({ ...exhausted, decision: 4 })).toBe(4);
  });

  it('explains every withheld category and none of the shared ones', () => {
    for (const category of WITHHELD_BY_DEFAULT) {
      expect(withholdReason(category), category).toBeTruthy();
    }
    for (const category of SHARED_BY_DEFAULT) {
      expect(withholdReason(category), category).toBeNull();
    }
  });
});
