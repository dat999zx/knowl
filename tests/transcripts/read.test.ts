import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as parse from '../../src/transcripts/parse.js';
import { readMessageAt, readMessagesAt, readWithContext } from '../../src/transcripts/read.js';

/**
 * Counts streaming passes without changing what they do.
 *
 * Spying on `node:fs.createReadStream` does not work here: `parse.ts` destructures it at module
 * load, and a named import from a CJS builtin is bound at instantiation, so a later patch of the
 * namespace object is invisible to the call site -- the spy reports zero calls while the file is
 * plainly being read. `streamProseFrom` opens exactly one stream per call, so counting calls to
 * it measures the same thing at a seam the test can actually reach.
 */
vi.mock('../../src/transcripts/parse.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/transcripts/parse.js')>();
  return { ...actual, streamProseFrom: vi.fn(actual.streamProseFrom) };
});

let dir: string;
let file: string;

const line = (role: 'user' | 'assistant', text: string) =>
  JSON.stringify({ type: role, timestamp: '2026-08-03T10:00:00Z', message: { content: text } });

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'knowl-read-'));
  file = path.join(dir, 's.jsonl');
  await fs.writeFile(file, [
    line('user', 'one'),
    line('assistant', 'two'),
    line('user', 'three'),
    line('assistant', 'four'),
    line('user', 'five'),
  ].join('\n') + '\n');
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
});

describe('readMessagesAt', () => {
  it('returns every requested line in one pass', async () => {
    const found = await readMessagesAt(file, [1, 3, 5]);
    expect([...found.keys()].sort((a, b) => a - b)).toEqual([1, 3, 5]);
    expect(found.get(3)?.text).toBe('three');
  });

  it('omits lines that hold no prose instead of returning null entries', async () => {
    const found = await readMessagesAt(file, [3, 99]);
    expect(found.has(99)).toBe(false);
    expect(found.size).toBe(1);
  });

  it('returns an empty map for a missing file', async () => {
    expect((await readMessagesAt(path.join(dir, 'gone.jsonl'), [1])).size).toBe(0);
  });

  it('returns an empty map when asked for nothing', async () => {
    expect((await readMessagesAt(file, [])).size).toBe(0);
  });

  it('reads the file once regardless of how many lines are requested', async () => {
    vi.mocked(parse.streamProseFrom).mockClear();
    await readMessagesAt(file, [1, 2, 3, 4, 5]);
    expect(parse.streamProseFrom).toHaveBeenCalledTimes(1);
  });

  // The per-message shape this batch API exists to replace: five separate reads for five lines.
  it('costs one pass for a batch where per-message reads would cost five', async () => {
    vi.mocked(parse.streamProseFrom).mockClear();
    for (const at of [1, 2, 3, 4, 5]) await readMessageAt(file, at);
    expect(parse.streamProseFrom).toHaveBeenCalledTimes(5);

    vi.mocked(parse.streamProseFrom).mockClear();
    const batched = await readMessagesAt(file, [1, 2, 3, 4, 5]);
    expect(parse.streamProseFrom).toHaveBeenCalledTimes(1);
    expect(batched.size).toBe(5);
  });
});

describe('readMessageAt', () => {
  it('returns the message at a 1-indexed line', async () => {
    expect(await readMessageAt(file, 3)).toMatchObject({ line: 3, role: 'user', text: 'three' });
  });

  it('returns null past the end of the file', async () => {
    expect(await readMessageAt(file, 99)).toBeNull();
  });

  it('returns null for a file that no longer exists', async () => {
    expect(await readMessageAt(path.join(dir, 'gone.jsonl'), 1)).toBeNull();
  });
});

describe('readWithContext', () => {
  it('returns the target plus surrounding turns', async () => {
    const excerpts = await readWithContext(file, 3, 1);
    expect(excerpts.map(e => e.text)).toEqual(['two', 'three', 'four']);
  });

  // The regression test for the semantics blocker: a line window filtered afterwards returns
  // the target alone here, because every prose turn is separated by tool-result lines -- which
  // is what a real transcript looks like.
  it('counts turns, not physical lines, when tool output sits between them', async () => {
    const noisy = path.join(dir, 'noisy.jsonl');
    const toolLine = JSON.stringify({
      type: 'user',
      message: { content: [{ type: 'tool_result', content: 'x'.repeat(200) }] },
    });
    await fs.writeFile(noisy, [
      line('user', 'first'), toolLine, toolLine,
      line('assistant', 'second'), toolLine, toolLine,
      line('user', 'third'), toolLine, toolLine,
      line('assistant', 'fourth'),
    ].join('\n') + '\n');

    // "second" is on physical line 4; one turn either side is "first" and "third".
    const excerpts = await readWithContext(noisy, 4, 1);
    expect(excerpts.map(e => e.text)).toEqual(['first', 'second', 'third']);
  });

  it('returns nothing when the requested line holds no prose', async () => {
    const noisy = path.join(dir, 'noprose.jsonl');
    await fs.writeFile(noisy, [
      line('user', 'first'),
      JSON.stringify({ type: 'system', message: { content: 'boot' } }),
      line('user', 'second'),
    ].join('\n') + '\n');

    expect(await readWithContext(noisy, 2, 2)).toEqual([]);
  });

  it('clamps at the start of the file', async () => {
    const excerpts = await readWithContext(file, 1, 2);
    expect(excerpts.map(e => e.text)).toEqual(['one', 'two', 'three']);
  });

  it('clamps at the end of the file', async () => {
    const excerpts = await readWithContext(file, 5, 2);
    expect(excerpts.map(e => e.text)).toEqual(['three', 'four', 'five']);
  });

  it('returns just the target when context is zero', async () => {
    const excerpts = await readWithContext(file, 2, 0);
    expect(excerpts.map(e => e.text)).toEqual(['two']);
  });
});
