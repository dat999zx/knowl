import { createReadStream } from 'node:fs';

export type ProseMessage = {
  /** 1-indexed line within the `.jsonl`. This is the pointer stored instead of the text. */
  line: number;
  role: 'user' | 'assistant';
  text: string;
  timestamp: string | null;
};

type Extracted = Omit<ProseMessage, 'line'>;

/**
 * The prose in one transcript entry, or null if it holds none.
 *
 * `tool_use` and `tool_result` blocks are dropped rather than down-weighted. They are the bulk
 * of the archive by bytes -- prose is 2.7% of it -- and almost none of the value; a search for
 * "embedding crash" should hit the discussion, not forty log lines containing the word.
 *
 * `thinking` blocks are dropped for a different reason: they are not what was said. They are
 * a third of assistant entries in this archive, and indexing them would surface reasoning the
 * user never saw as though it were the answer they were given.
 */
export function extractProse(entry: unknown): Extracted | null {
  if (!entry || typeof entry !== 'object') return null;
  const record = entry as Record<string, unknown>;
  const role = record.type;
  if (role !== 'user' && role !== 'assistant') return null;

  const message = record.message;
  if (!message || typeof message !== 'object') return null;
  const content = (message as Record<string, unknown>).content;

  let text = '';
  if (typeof content === 'string') {
    text = content;
  } else if (Array.isArray(content)) {
    for (const block of content) {
      if (!block || typeof block !== 'object') continue;
      const typed = block as Record<string, unknown>;
      if (typed.type === 'text' && typeof typed.text === 'string') text += typed.text;
    }
  }

  text = text.trim();
  if (!text) return null;

  const timestamp = typeof record.timestamp === 'string' ? record.timestamp : null;
  return { role, text, timestamp };
}

export type ProseWatermark = { bytesConsumed: number; linesConsumed: number };

export type ProseChunk = {
  message: ProseMessage;
  /**
   * The watermark that becomes correct once this message is committed: the byte offset just
   * past its line, and the line count including it.
   *
   * Carried per message so the indexer can advance `bytes_indexed` in the *same* transaction
   * as the rows. Committing rows and the watermark separately is not crash-safe -- a crash
   * between them replays those lines into `UNIQUE(path, line)` on the next pass.
   */
  bytesConsumed: number;
  linesConsumed: number;
};

/**
 * Stream prose from `startByte`, continuing line numbering from `startLine`.
 *
 * Peak memory is one read chunk plus one partial line, whatever the file's size. Buffering the
 * remainder instead would scale with session length and make the caller's time budgets
 * unenforceable -- a multi-megabyte allocation happens before any budget can be checked.
 *
 * The returned watermark is the offset of the last *complete* line, never the file length. A
 * transcript being appended to while this runs has a partial final record; committing past it
 * would skip that message forever once the rest arrives.
 */
export async function* streamProseFrom(
  filePath: string,
  startByte: number,
  startLine: number,
): AsyncGenerator<ProseChunk, ProseWatermark> {
  let carry = Buffer.alloc(0);
  /** Absolute file offset of `carry[0]`. */
  let consumed = startByte;
  let line = startLine;

  let stream: import('node:fs').ReadStream;
  try {
    stream = createReadStream(filePath, { start: startByte });
  } catch {
    return { bytesConsumed: startByte, linesConsumed: startLine };
  }

  for await (const chunk of stream) {
    carry = carry.length === 0 ? Buffer.from(chunk) : Buffer.concat([carry, Buffer.from(chunk)]);
    let cursor = 0;

    for (;;) {
      const newline = carry.indexOf(0x0a, cursor);
      if (newline === -1) break;

      // Safe to decode here: 0x0a cannot occur inside a multi-byte UTF-8 sequence, so a
      // complete line is always a complete sequence of characters.
      const raw = carry.subarray(cursor, newline).toString('utf8');
      cursor = newline + 1;
      line++;

      const trimmed = raw.trim();
      if (trimmed) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(trimmed);
        } catch {
          // One unreadable line must not cost the rest of the file.
          parsed = undefined;
        }
        const prose = parsed === undefined ? null : extractProse(parsed);
        if (prose) {
          yield { message: { line, ...prose }, bytesConsumed: consumed + cursor, linesConsumed: line };
        }
      }
    }

    consumed += cursor;
    carry = carry.subarray(cursor);
  }

  // Past any trailing non-prose lines, which advanced the watermark without yielding.
  return { bytesConsumed: consumed, linesConsumed: line };
}

/** Drain `streamProseFrom` into an array. For tests and small files; the indexer streams. */
export async function readProseFrom(
  filePath: string,
  startByte: number,
  startLine: number,
): Promise<{ messages: ProseMessage[]; bytesRead: number; linesRead: number }> {
  const messages: ProseMessage[] = [];
  const iterator = streamProseFrom(filePath, startByte, startLine);
  for (;;) {
    const next = await iterator.next();
    if (next.done) {
      return { messages, bytesRead: next.value.bytesConsumed, linesRead: next.value.linesConsumed };
    }
    messages.push(next.value.message);
  }
}
