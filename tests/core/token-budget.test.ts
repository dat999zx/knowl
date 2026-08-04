import { describe, expect, it } from 'vitest';
import { KnowledgeItem } from '../../src/core/types.js';
import { compactKnowledgeItem, estimateTokens, truncateText } from '../../src/core/token-budget.js';

const item: KnowledgeItem = {
  id: 'item-1', category: 'decision', status: 'active', title: 'Use SQLite', content: 'Local storage.',
  reasoning: 'Small and portable.', alternatives: ['Postgres'], affectedPaths: ['src/store.ts'],
  tags: ['storage', 'local', 'durable', 'extra', 'more'], freshness: 'fresh', confidence: 0.9,
  version: 1, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
};

describe('token budget', () => {
  it('truncates deterministically and estimates tokens', () => {
    expect(truncateText('abcdef', 4)).toBe('abcd');
    expect(truncateText('abcdef', 4, '...')).toBe('a...');
    expect(estimateTokens('12345678')).toBe(2);
  });

  it('compacts knowledge items without verbose provenance', () => {
    expect(compactKnowledgeItem(item)).toEqual(expect.objectContaining({ id: item.id, title: item.title, content: item.content }));
    expect(compactKnowledgeItem(item)).not.toHaveProperty('reasoning');
    expect(compactKnowledgeItem(item)).not.toHaveProperty('alternatives');
    expect(compactKnowledgeItem(item)).not.toHaveProperty('affectedPaths');
  });

  it('omits repo and namespace when none are supplied, so existing output is unchanged', () => {
    const compact = compactKnowledgeItem(item);
    expect(compact).not.toHaveProperty('repo');
    expect(compact).not.toHaveProperty('namespace');
  });

  it('carries a repo label into the compact shape', () => {
    expect(compactKnowledgeItem(item, { repo: 'server' }).repo).toBe('server');
  });

  it('carries a namespace label, which layered queries attach and this dropped', () => {
    expect(compactKnowledgeItem(item, { namespace: 'organization' }).namespace).toBe('organization');
  });

  it('carries the calibrated score, rounded to three decimals', () => {
    expect(compactKnowledgeItem(item, { score: 0.5730000000000001 }).score).toBe(0.573);
    // A response with no calibrated number stays byte-identical to what it was.
    expect(compactKnowledgeItem(item)).not.toHaveProperty('score');
  });

  it('keeps a zero score, which is the one value a truthiness test would drop', () => {
    // "The store found nothing worth reading" is the single most useful thing this field can
    // say, and `extras.score ? ...` is exactly the check that would silence it.
    expect(compactKnowledgeItem(item, { score: 0 })).toHaveProperty('score', 0);
    // Non-finite is not a score. NaN would serialize to null and read as "no opinion".
    expect(compactKnowledgeItem(item, { score: Number.NaN })).not.toHaveProperty('score');
  });

  it('survives the MCP serialization boundary, which is where provenance actually died', async () => {
    // compactItemResponse -> compactMcpJson is the path every knowl_query result takes.
    // Asserting on the in-memory object would pass even with the field stripped downstream.
    const { compactItemResponse, compactMcpJson } = await import('../../src/mcp/response-format.js');
    const serialized = JSON.parse(compactMcpJson([compactItemResponse(item, { repo: 'server', namespace: 'project' })]));
    expect(serialized[0].repo).toBe('server');
    expect(serialized[0].namespace).toBe('project');
  });
});
