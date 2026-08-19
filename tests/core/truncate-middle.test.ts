import { describe, expect, it } from 'vitest';
import {
  MAX_ITEM_CONTENT_CHARS,
  compactKnowledgeItem,
  truncateMiddle,
} from '../../src/core/token-budget.js';
import type { KnowledgeItem } from '../../src/core/types.js';

const ELISION = '[... elided ...]';

describe('truncateMiddle', () => {
  it('leaves anything within budget byte-identical', () => {
    expect(truncateMiddle('short', 100)).toBe('short');
    expect(truncateMiddle('x'.repeat(50), 50)).toBe('x'.repeat(50));
  });

  it('spends exactly the budget, so the existing length contract holds', () => {
    for (const max of [40, 100, 999, 2000, 2001]) {
      expect(truncateMiddle('x'.repeat(10_000), max)).toHaveLength(max);
    }
  });

  it('keeps both ends -- the head to judge relevance, the tail for the verdict', () => {
    const body = `OPENING${'-'.repeat(5000)}CONCLUSION`;
    const cut = truncateMiddle(body, 200);
    expect(cut.startsWith('OPENING')).toBe(true);
    expect(cut.endsWith('CONCLUSION')).toBe(true);
    expect(cut).toContain(ELISION);
  });

  it('weights the head more heavily than the tail', () => {
    const cut = truncateMiddle('x'.repeat(10_000), 1000);
    const [head, tail] = cut.split(ELISION);
    expect(head.length).toBeGreaterThan(tail.length);
  });

  /**
   * The real shape this exists for: an atom whose last paragraph is the caveat that must travel
   * with the finding. Head-slicing delivers the setup and drops it.
   */
  it('preserves a trailing caveat that a head slice would have dropped', () => {
    const body = [
      'MEASURED 2026-08-16 by parsing tool results in the session archive.',
      'x'.repeat(4000),
      'THE LIMIT OF THIS EVIDENCE, which must travel with it: this is revealed preference.',
    ].join('\n\n');

    expect(truncateMiddle(body, MAX_ITEM_CONTENT_CHARS)).toContain('THE LIMIT OF THIS EVIDENCE');
    expect(body.slice(0, MAX_ITEM_CONTENT_CHARS)).not.toContain('THE LIMIT OF THIS EVIDENCE');
  });

  it('degrades to a prefix when there is no room for the marker', () => {
    const tiny = truncateMiddle('abcdefghij', 4);
    expect(tiny).toBe('abcd');
    expect(truncateMiddle('abcdefghij', 0)).toBe('');
  });

  it('survives a negative budget without throwing or over-spending', () => {
    expect(truncateMiddle('abcdefghij', -5)).toBe('');
  });
});

describe('compactKnowledgeItem uses it for content only', () => {
  const item = {
    id: 'k1',
    category: 'fact',
    title: 'T',
    content: '',
    freshness: 'fresh',
    confidence: 1,
  } as KnowledgeItem;

  it('elides the middle of an over-long body and still flags it', () => {
    const body = `HEAD${'-'.repeat(MAX_ITEM_CONTENT_CHARS * 2)}TAIL`;
    const compact = compactKnowledgeItem({ ...item, content: body });

    expect(compact.content).toHaveLength(MAX_ITEM_CONTENT_CHARS);
    expect(compact.content.startsWith('HEAD')).toBe(true);
    expect(compact.content.endsWith('TAIL')).toBe(true);
    expect(compact).toHaveProperty('truncated', true);
  });

  it('leaves a body that fits completely alone, flag included', () => {
    const body = 'x'.repeat(MAX_ITEM_CONTENT_CHARS);
    const compact = compactKnowledgeItem({ ...item, content: body });
    expect(compact.content).toBe(body);
    expect(compact).not.toHaveProperty('truncated');
  });

  /**
   * A path with its middle removed is not a shorter path, it is an unusable one, and neither
   * titles nor paths have a conclusion at the end worth preserving.
   */
  it('does not middle-elide paths', () => {
    const compact = compactKnowledgeItem({
      ...item,
      affectedPaths: [`src/${'deep/'.repeat(80)}file.ts`],
    } as KnowledgeItem);
    expect(compact.affectedPaths?.[0]).not.toContain(ELISION);
    expect(compact.affectedPaths?.[0].startsWith('src/deep/')).toBe(true);
  });
});
