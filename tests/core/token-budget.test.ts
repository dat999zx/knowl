import { describe, expect, it } from 'vitest';
import { KnowledgeItem } from '../../src/core/types.js';
import {
  compactKnowledgeItem, estimateTokens, truncateText,
  MAX_AFFECTED_PATHS, MAX_ITEM_CONTENT_CHARS, MAX_PATH_CHARS,
  MAX_PREVIEW_CHARS, MAX_SUMMARY_ITEM_CHARS, MAX_TITLE_CHARS,
} from '../../src/core/token-budget.js';
import { formatRecentContextToMarkdown } from '../../src/core/format.js';

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
  });

  /**
   * `affectedPaths` used to be excluded here alongside `reasoning` and `alternatives`, under
   * the heading "verbose provenance". Those two are prose; this is a pointer list -- median 3
   * entries, 29 characters each, measured over the three real stores on this machine. Grouping
   * them cost the response the only field that says where to look, which matters most for the
   * items whose content still arrives truncated.
   */
  it('carries affectedPaths, which is a pointer list rather than prose', () => {
    expect(compactKnowledgeItem(item).affectedPaths).toEqual(['src/store.ts']);
    expect(compactKnowledgeItem({ ...item, affectedPaths: [] })).not.toHaveProperty('affectedPaths');
    expect(compactKnowledgeItem({ ...item, affectedPaths: undefined })).not.toHaveProperty('affectedPaths');
  });

  it('bounds the path list the same way it bounds tags', () => {
    const many = Array.from({ length: 20 }, (_, index) => `src/file-${index}.ts`);
    const compact = compactKnowledgeItem({ ...item, affectedPaths: many });
    expect(compact.affectedPaths).toHaveLength(MAX_AFFECTED_PATHS);
    expect(compact.affectedPaths![0]).toBe('src/file-0.ts');
    const long = `src/${'a'.repeat(400)}.ts`;
    expect(compactKnowledgeItem({ ...item, affectedPaths: [long] }).affectedPaths![0]).toHaveLength(MAX_PATH_CHARS);
  });

  /**
   * The cut itself is old; the silence about it is what this pins. `truncateText` is called
   * with the empty marker, so a caller reading a prefix of a longer atom sees no ellipsis and
   * no flag, and cannot tell a short complete fact from the opening of a long one.
   */
  it('flags a truncated content body, and stays silent when nothing was cut', () => {
    expect(compactKnowledgeItem(item)).not.toHaveProperty('truncated');
    const long = { ...item, content: 'x'.repeat(MAX_ITEM_CONTENT_CHARS + 1) };
    expect(compactKnowledgeItem(long).truncated).toBe(true);
    expect(compactKnowledgeItem(long).content).toHaveLength(MAX_ITEM_CONTENT_CHARS);
    // Exactly at the ceiling is complete, not truncated.
    expect(compactKnowledgeItem({ ...item, content: 'x'.repeat(MAX_ITEM_CONTENT_CHARS) })).not.toHaveProperty('truncated');
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

  it('carries an uncalibrated marker through the score field untouched', () => {
    // "The ranker has no opinion" has to be distinguishable from "the ranker forgot to say",
    // and it is said where the reader is already told to look -- the score field -- rather
    // than in a sibling field the silence would hide.
    expect(compactKnowledgeItem(item, { score: 'uncalibrated (lexical-only)' }).score)
      .toBe('uncalibrated (lexical-only)');
    expect(compactKnowledgeItem(item, { score: 'uncalibrated (layered namespaces)' }).score)
      .toBe('uncalibrated (layered namespaces)');
    expect(compactKnowledgeItem(item, { score: 'uncalibrated (not embedded)' }).score)
      .toBe('uncalibrated (not embedded)');
  });

  it('survives the MCP serialization boundary, which is where provenance actually died', async () => {
    // compactItemResponse -> compactMcpJson is the path every knowl_query result takes.
    // Asserting on the in-memory object would pass even with the field stripped downstream.
    const { compactItemResponse, compactMcpJson } = await import('../../src/mcp/response-format.js');
    const long = { ...item, content: 'x'.repeat(MAX_ITEM_CONTENT_CHARS + 50) };
    const serialized = JSON.parse(compactMcpJson([compactItemResponse(long, { repo: 'server', namespace: 'project' })]));
    expect(serialized[0].repo).toBe('server');
    expect(serialized[0].namespace).toBe('project');
    // The two fields a reader needs to act on a partial answer: what is missing, and where the
    // rest of it lives.
    expect(serialized[0].truncated).toBe(true);
    expect(serialized[0].affectedPaths).toEqual(['src/store.ts']);
  });
});

/**
 * One number used to stand in for four unrelated policies. These pin them apart.
 *
 * The values are asserted as literals rather than against each other on purpose: the whole
 * point of the split is that raising one must never drag the others, and an assertion written
 * as `toBe(MAX_ITEM_CONTENT_CHARS)` would have moved with it and caught nothing.
 */
describe('truncation ceilings', () => {
  it('returns 2000 characters of content whole and flags anything longer', () => {
    expect(MAX_ITEM_CONTENT_CHARS).toBe(2000);

    const exact = compactKnowledgeItem({ ...item, content: 'x'.repeat(2000) });
    expect(exact.content).toHaveLength(2000);
    expect(exact).not.toHaveProperty('truncated');

    const over = compactKnowledgeItem({ ...item, content: 'x'.repeat(2001) });
    expect(over.content).toHaveLength(2000);
    expect(over.truncated).toBe(true);
  });

  it('caps a title at 200 without flagging it', () => {
    expect(MAX_TITLE_CHARS).toBe(200);

    const long = compactKnowledgeItem({ ...item, title: 'y'.repeat(300), content: 'short' });
    expect(long.title).toHaveLength(200);
    // No flag: 200 is four times the longest title measured on the real store (133), so a cut
    // title is a data problem rather than a budget one, and a flag nobody can act on is noise.
    expect(long).not.toHaveProperty('truncated');
  });

  it('leaves the summary and preview ceilings where they were', () => {
    expect(MAX_SUMMARY_ITEM_CHARS).toBe(600);
    expect(MAX_PREVIEW_CHARS).toBe(600);
  });

  it('does not widen the recent-context formatter when the item ceiling moves', () => {
    // The failure the split exists to prevent. This formatter bounds the WHOLE response at
    // DEFAULT_CONTEXT_MAX_CHARS, so one item taking the item ceiling would eat two thirds of
    // knowl_recent and knowl_state.
    const long: KnowledgeItem = { ...item, content: 'x'.repeat(MAX_ITEM_CONTENT_CHARS + 500) };
    const md = formatRecentContextToMarkdown({ items: [long], commits: [] });

    expect(md).toContain('x'.repeat(MAX_SUMMARY_ITEM_CHARS));
    expect(md).not.toContain('x'.repeat(MAX_SUMMARY_ITEM_CHARS + 1));
  });
});
