import { describe, expect, it } from 'vitest';
import { formatRecentContextToMarkdown } from '../../src/core/format.js';
import { DEFAULT_CONTEXT_MAX_CHARS } from '../../src/core/token-budget.js';
import { compactMcpJson } from '../../src/mcp/response-format.js';

describe('token delivery budgets', () => {
  it('bounds automatic recent context and emits compact MCP JSON', () => {
    const context = formatRecentContextToMarkdown({
      items: [{ id: 'item', category: 'fact', status: 'active', title: 'Large', content: 'x'.repeat(DEFAULT_CONTEXT_MAX_CHARS * 2), freshness: 'fresh', confidence: 1, version: 1, createdAt: '', updatedAt: '' }],
      commits: [],
    });
    expect(context.length).toBeLessThanOrEqual(DEFAULT_CONTEXT_MAX_CHARS);
    expect(compactMcpJson({ item: { id: 'item' } })).toBe('{"item":{"id":"item"}}');
  });
});
