import { describe, expect, it } from 'vitest';
import { buildEmbedText, EMBED_RECIPE_VERSION } from '../../src/core/embed-recipe.js';

/**
 * THE CROSS-REPO FIXTURE.
 *
 * `knowl-cloud/tests/knowledge/embed-recipe.test.ts` holds a byte-identical copy of this atom
 * and of `EXPECTED`. They are duplicated by value and never imported across repos, because an
 * OSS repo cannot depend on the proprietary one -- and because two independent copies are what
 * turn a drift into a failing test instead of a silent change on one side.
 *
 * Changing either constant here REQUIRES the same change there and a bump of
 * `EMBED_RECIPE_VERSION` in both. A vector built under version N is not comparable to one built
 * under N+1, and nothing else in either system can detect that.
 */
const FIXTURE = {
  title: 'SQLite WAL checkpointing',
  content: 'A checkpoint must run before copying the database file.',
  reasoning: 'Otherwise the copy misses committed pages still in the WAL.',
  tags: ['sqlite', 'backup'],
};

const EXPECTED =
  'SQLite WAL checkpointing\n' +
  'A checkpoint must run before copying the database file.\n' +
  'Reasoning: Otherwise the copy misses committed pages still in the WAL.\n' +
  'Tags: sqlite, backup';

describe('embed recipe v1', () => {
  it('builds exactly the fixture string', () => {
    expect(buildEmbedText(FIXTURE)).toBe(EXPECTED);
  });

  it('is version 1', () => {
    expect(EMBED_RECIPE_VERSION).toBe(1);
  });

  it('omits the reasoning line entirely when there is none', () => {
    expect(buildEmbedText({ title: 'T', content: 'C', reasoning: null, tags: ['a'] }))
      .toBe('T\nC\nTags: a');
  });

  it('omits the tags line entirely when the array is empty', () => {
    expect(buildEmbedText({ title: 'T', content: 'C', reasoning: 'R', tags: [] }))
      .toBe('T\nC\nReasoning: R');
  });

  it('treats absent and empty the same way, so an optional field cannot change the shape', () => {
    expect(buildEmbedText({ title: 'T', content: 'C' }))
      .toBe(buildEmbedText({ title: 'T', content: 'C', reasoning: null, tags: [] }));
  });

  it('joins tags with a comma and a space, in the order given', () => {
    expect(buildEmbedText({ title: 'T', content: 'C', tags: ['b', 'a'] }))
      .toBe('T\nC\nTags: b, a');
  });
});
