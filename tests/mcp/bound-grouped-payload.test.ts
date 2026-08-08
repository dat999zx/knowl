import { describe, expect, it } from 'vitest';
import { boundQueryPayload } from '../../src/mcp/tools.js';

const row = (id: string, size: number) => ({ id, title: id, content: 'x'.repeat(size) });

/**
 * The payload bound has to survive the response becoming an object.
 *
 * It shrank a bare array by walking the tail, which is the ranked end. Grouped output has no
 * single tail unless the groups are laid end to end -- and because groups arrive with an empty
 * local group pinned first and the rest in relevance order, laying them end to end puts the
 * weakest rows of the least relevant repo last. The existing rule therefore already trims peers
 * before local, with no separate rule to state.
 */
describe('boundQueryPayload', () => {
  it('serializes a single group as a bare array, for callers that parse one', () => {
    const { text } = boundQueryPayload([{ repo: 'a', rows: [row('one', 10)] }], 'flat');

    expect(JSON.parse(text)).toEqual([{ id: 'one', title: 'one', content: 'x'.repeat(10) }]);
  });

  it('serializes groups as an object keyed by repo, in the order given', () => {
    const { text } = boundQueryPayload([
      { repo: 'a', rows: [] },
      { repo: 'b', rows: [row('two', 10)] },
    ], 'grouped');

    expect(Object.keys(JSON.parse(text))).toEqual(['a', 'b']);
  });

  it('keeps an empty group as an empty array rather than dropping the key', () => {
    // The empty local group IS the "your repo has nothing on this" signal. A serializer that
    // omitted it would delete the message the shape exists to carry.
    const { text } = boundQueryPayload([
      { repo: 'a', rows: [] },
      { repo: 'b', rows: [row('two', 10)] },
    ], 'grouped');

    expect(JSON.parse(text).a).toEqual([]);
  });

  it('shortens a trailing group body before an earlier one', () => {
    // 8k + 8k overruns the 12k ceiling; excerpting the trailing row alone brings it back under,
    // so the walk stops there and the earlier group keeps its body whole. Sized deliberately:
    // two rows that both had to be cut would pass an assertion about order while proving
    // nothing about it.
    const { text, shortened } = boundQueryPayload([
      { repo: 'a', rows: [row('local', 8_000)] },
      { repo: 'b', rows: [row('peer', 8_000)] },
    ], 'grouped');
    const parsed = JSON.parse(text);

    expect(shortened).toBe(1);
    expect(parsed.b[0].truncated).toBe(true);
    expect(parsed.a[0].content).toHaveLength(8_000);
  });

  it('keeps at least one row rather than returning a page that reads as a miss', () => {
    const { text } = boundQueryPayload([{ repo: 'a', rows: [row('only', 200_000)] }], 'flat');

    expect(JSON.parse(text)).toHaveLength(1);
  });
});
