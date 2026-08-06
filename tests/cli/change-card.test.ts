import { describe, expect, it } from 'vitest';
import { createClaudeChangeCardOutput, renderChangeCard } from '../../src/session/change-card.js';
import { ChangeSummary } from '../../src/store/change-watermark.js';

const item = (index: number, action: 'insert' | 'update' = 'insert') => ({
  itemId: `item-${index}`,
  category: 'fact',
  title: `Item ${index}`,
  action,
});

describe('change card rendering', () => {
  it('renders a singular header, one line per item, and the closing instruction', () => {
    const summary: ChangeSummary = { count: 1, items: [item(1)] };

    expect(renderChangeCard(summary)).toBe([
      'KNOWL CHANGED: 1 item since you last looked.',
      '- fact: Item 1',
      'Call knowl_query before relying on earlier memory in these areas.',
    ].join('\n'));
  });

  it('pluralises the header and marks non-insert actions', () => {
    const summary: ChangeSummary = { count: 2, items: [item(1), item(2, 'update')] };

    expect(renderChangeCard(summary)).toContain('KNOWL CHANGED: 2 items since you last looked.');
    expect(renderChangeCard(summary)).toContain('- fact: Item 1');
    expect(renderChangeCard(summary)).toContain('- fact (update): Item 2');
  });

  it('caps at five item lines and reports the overflow', () => {
    const items = [1, 2, 3, 4, 5, 6, 7].map(index => item(index));
    const card = renderChangeCard({ count: 7, items });
    const lines = card.split('\n').filter(line => line.startsWith('- '));

    expect(lines).toHaveLength(6);
    expect(lines[5]).toBe('- +2 more');
    expect(card).toContain('KNOWL CHANGED: 7 items since you last looked.');
  });

  it('truncates titles to 90 characters', () => {
    const long = 'x'.repeat(200);
    const card = renderChangeCard({ count: 1, items: [{ ...item(1), title: long }] });
    const line = card.split('\n')[1];

    expect(line).toBe(`- fact: ${'x'.repeat(90)}`);
  });

  it('counts items dropped for having no title in the header only', () => {
    const card = renderChangeCard({ count: 3, items: [item(1)] });

    expect(card).toContain('KNOWL CHANGED: 3 items since you last looked.');
    expect(card.split('\n').filter(line => line.startsWith('- '))).toHaveLength(2);
    expect(card).toContain('- +2 more');
  });

  it('stays within the documented character budget', () => {
    const items = [1, 2, 3, 4, 5].map(index => ({ ...item(index), title: 'y'.repeat(120) }));

    expect(renderChangeCard({ count: 50, items }).length).toBeLessThanOrEqual(700);
  });

  it('wraps the card in the Claude PostToolUse envelope', () => {
    const summary: ChangeSummary = { count: 1, items: [item(1)] };

    expect(createClaudeChangeCardOutput(summary)).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext: renderChangeCard(summary),
      },
    });
  });
});
