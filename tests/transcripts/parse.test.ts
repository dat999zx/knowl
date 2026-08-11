import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { extractProse, readProseFrom, streamProseFrom } from '../../src/transcripts/parse.js';

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'knowl-parse-'));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const userLine = (text: string) =>
  JSON.stringify({ type: 'user', timestamp: '2026-08-03T10:00:00Z', message: { content: text } });

const assistantLine = (blocks: unknown[]) =>
  JSON.stringify({ type: 'assistant', timestamp: '2026-08-03T10:00:01Z', message: { content: blocks } });

describe('extractProse', () => {
  it('reads a bare string user message', () => {
    expect(extractProse(JSON.parse(userLine('why did it crash?')))).toEqual({
      role: 'user',
      text: 'why did it crash?',
      timestamp: '2026-08-03T10:00:00Z',
    });
  });

  it('keeps only text blocks from an assistant message', () => {
    const entry = JSON.parse(assistantLine([
      { type: 'text', text: 'The batch size was wrong.' },
      { type: 'tool_use', name: 'Bash', input: { command: 'npm test' } },
      { type: 'text', text: ' It was a page size.' },
    ]));
    expect(extractProse(entry)?.text).toBe('The batch size was wrong. It was a page size.');
  });

  it('drops a message that is only tool output', () => {
    const entry = JSON.parse(JSON.stringify({
      type: 'user',
      message: { content: [{ type: 'tool_result', content: 'x'.repeat(5000) }] },
    }));
    expect(extractProse(entry)).toBeNull();
  });

  // Measured in this repo's archive: 49 of 183 assistant entries in one session are
  // thinking-only. It is not what the assistant said, so it is not prose.
  it('drops an assistant message that is only thinking', () => {
    const entry = JSON.parse(assistantLine([{ type: 'thinking', thinking: 'let me consider the batch size' }]));
    expect(extractProse(entry)).toBeNull();
  });

  it('drops entries that are neither user nor assistant', () => {
    expect(extractProse({ type: 'system', message: { content: 'hello' } })).toBeNull();
    expect(extractProse({ type: 'summary', summary: 'hello' })).toBeNull();
  });

  it('drops a message whose text is only whitespace', () => {
    expect(extractProse(JSON.parse(userLine('   \n  ')))).toBeNull();
  });

  it('tolerates a missing message object', () => {
    expect(extractProse({ type: 'user' })).toBeNull();
  });
});

describe('readProseFrom', () => {
  it('numbers lines from 1 and skips non-prose', async () => {
    const file = path.join(dir, 's.jsonl');
    await fs.writeFile(file, [
      JSON.stringify({ type: 'system', message: { content: 'boot' } }),
      userLine('first question'),
      assistantLine([{ type: 'text', text: 'first answer' }]),
    ].join('\n') + '\n');

    const result = await readProseFrom(file, 0, 0);

    expect(result.messages).toHaveLength(2);
    expect(result.messages[0]).toMatchObject({ line: 2, role: 'user', text: 'first question' });
    expect(result.messages[1]).toMatchObject({ line: 3, role: 'assistant', text: 'first answer' });
    expect(result.linesRead).toBe(3);
  });

  it('resumes from a byte offset and continues line numbering', async () => {
    const file = path.join(dir, 's.jsonl');
    const head = userLine('first') + '\n';
    await fs.writeFile(file, head);

    const first = await readProseFrom(file, 0, 0);
    expect(first.messages[0].line).toBe(1);
    expect(first.bytesRead).toBe(Buffer.byteLength(head));

    await fs.appendFile(file, userLine('second') + '\n');
    const second = await readProseFrom(file, first.bytesRead, first.linesRead);

    expect(second.messages).toHaveLength(1);
    expect(second.messages[0]).toMatchObject({ line: 2, text: 'second' });
  });

  it('stops before a trailing partial line so a half-written record is re-read next pass', async () => {
    const file = path.join(dir, 's.jsonl');
    const complete = userLine('done') + '\n';
    await fs.writeFile(file, complete + '{"type":"user","mess');

    const result = await readProseFrom(file, 0, 0);

    expect(result.messages).toHaveLength(1);
    expect(result.bytesRead).toBe(Buffer.byteLength(complete));
  });

  it('skips a corrupt line without aborting the file', async () => {
    const file = path.join(dir, 's.jsonl');
    await fs.writeFile(file, ['not json at all', userLine('still here')].join('\n') + '\n');

    const result = await readProseFrom(file, 0, 0);

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].line).toBe(2);
  });

  it('returns no messages for a file that is not there', async () => {
    // `knowl transcripts extract` reads through here, one session at a time; a throw at this
    // level ended the whole run on the first transcript that had been deleted since indexing.
    await expect(readProseFrom(path.join(dir, 'absent.jsonl'), 0, 0)).resolves.toEqual({
      messages: [],
      bytesRead: 0,
      linesRead: 0,
    });
  });
});

describe('streamProseFrom', () => {
  it('carries a per-message watermark that resumes exactly after it', async () => {
    const file = path.join(dir, 's.jsonl');
    const first = userLine('one') + '\n';
    const second = userLine('two') + '\n';
    await fs.writeFile(file, first + second);

    const chunks = [];
    for await (const chunk of streamProseFrom(file, 0, 0)) chunks.push(chunk);

    expect(chunks[0].bytesConsumed).toBe(Buffer.byteLength(first));
    expect(chunks[0].linesConsumed).toBe(1);

    // Resuming from the first message's watermark must yield exactly the second.
    const resumed = [];
    for await (const chunk of streamProseFrom(file, chunks[0].bytesConsumed, chunks[0].linesConsumed)) {
      resumed.push(chunk.message.text);
    }
    expect(resumed).toEqual(['two']);
  });

  it('returns a final watermark covering trailing non-prose lines', async () => {
    const file = path.join(dir, 's.jsonl');
    const body = userLine('prose') + '\n' + JSON.stringify({ type: 'system', message: { content: 'x' } }) + '\n';
    await fs.writeFile(file, body);

    const iterator = streamProseFrom(file, 0, 0);
    let final;
    for (;;) {
      const next = await iterator.next();
      if (next.done) { final = next.value; break; }
    }

    // Past the system line, not stopped at the last prose message.
    expect(final.bytesConsumed).toBe(Buffer.byteLength(body));
    expect(final.linesConsumed).toBe(2);
  });

  it('does not load the file into memory', async () => {
    const file = path.join(dir, 'big.jsonl');
    // 20 MB of prose across 2,001 lines. A whole-file read would allocate all of it.
    const body = userLine('y'.repeat(10_000)) + '\n';
    await fs.writeFile(file, userLine('x'.repeat(10_000)) + '\n' + body.repeat(2_000));

    global.gc?.();
    const before = process.memoryUsage().heapUsed;
    let count = 0;
    let peak = 0;
    for await (const _ of streamProseFrom(file, 0, 0)) {
      count++;
      if (count % 200 === 0) peak = Math.max(peak, process.memoryUsage().heapUsed - before);
    }

    expect(count).toBe(2_001);
    // Generous bound: the point is that growth is unrelated to the 20 MB file size.
    expect(peak).toBeLessThan(8 * 1024 * 1024);
  });

  it('decodes a multibyte character split across chunk boundaries', async () => {
    const file = path.join(dir, 'utf8.jsonl');
    // Long enough to span several 64 KB reads, with multibyte characters throughout.
    await fs.writeFile(file, userLine('π'.repeat(100_000)) + '\n');

    const chunks = [];
    for await (const chunk of streamProseFrom(file, 0, 0)) chunks.push(chunk);

    expect(chunks[0].message.text).toBe('π'.repeat(100_000));
  });

  it('reports the watermark it was given for a file that is not there', async () => {
    // `createReadStream` succeeds on a missing path and reports ENOENT by emitting `error`, which
    // rejects the iteration rather than the construction — so a guard around the construction
    // alone caught nothing, and every caller inherited a throw where this promises silence.
    const iterator = streamProseFrom(path.join(dir, 'never-written.jsonl'), 40, 7);

    const next = await iterator.next();

    expect(next.done).toBe(true);
    expect(next.value).toEqual({ bytesConsumed: 40, linesConsumed: 7 });
  });

  it('reports the watermark it was given for a path that is a directory', async () => {
    // The other shape of unreadable, and the one that is not ENOENT: something is there, and it
    // is not a file. It must degrade the same way rather than throw EISDIR at the caller.
    const iterator = streamProseFrom(dir, 0, 0);

    const next = await iterator.next();

    expect(next.done).toBe(true);
    expect(next.value).toEqual({ bytesConsumed: 0, linesConsumed: 0 });
  });
});
