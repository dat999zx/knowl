import { streamProseFrom } from './parse.js';

export type TranscriptExcerpt = {
  line: number;
  role: 'user' | 'assistant';
  text: string;
  timestamp: string | null;
};

/**
 * Prose at the given 1-indexed lines, in a single streaming pass.
 *
 * The batch shape is the whole point. Fetching one line at a time re-reads the transcript per
 * message: a 3,717-message backfill against ~3 MB files is roughly 11 GB of I/O, and it makes
 * every time budget in the system unenforceable. Callers with more than one line to fetch --
 * search rendering its hits, the embedder filling a batch -- must group by file and come here
 * once.
 *
 * Lines holding no prose are simply absent from the map rather than present and null, so
 * `size` is a truthful count of what was found.
 */
export async function readMessagesAt(
  filePath: string,
  lines: number[],
): Promise<Map<number, TranscriptExcerpt>> {
  const found = new Map<number, TranscriptExcerpt>();
  if (lines.length === 0) return found;

  const wanted = new Set(lines);
  const last = Math.max(...lines);

  try {
    for await (const chunk of streamProseFrom(filePath, 0, 0)) {
      if (wanted.has(chunk.message.line)) {
        const { line, role, text, timestamp } = chunk.message;
        found.set(line, { line, role, text, timestamp });
        if (found.size === wanted.size) break;
      }
      // Nothing further can match; stop rather than stream the rest of the file.
      if (chunk.message.line >= last) break;
    }
  } catch {
    // The transcript was deleted since it was indexed. A dead pointer is a miss, not an error;
    // the next index pass drops its rows.
    return found;
  }

  return found;
}

export async function readMessageAt(filePath: string, line: number): Promise<TranscriptExcerpt | null> {
  return (await readMessagesAt(filePath, [line])).get(line) ?? null;
}

/**
 * A stored pointer: the line, and what the index recorded about where it is.
 *
 * `byteOffset` is null for rows written before the column existed; `chars` is the length the
 * indexer saw, which is what makes a stale offset detectable.
 */
export type MessagePointer = {
  line: number;
  byteOffset?: number | null;
  chars?: number | null;
};

/**
 * One message, read by seeking to where the indexer said its line begins.
 *
 * Null when the offset does not produce that message -- the file was rewritten, the row predates
 * the column, the read failed. The caller falls back to a scan, which is slower but cannot be
 * wrong, so a stale offset costs time rather than correctness. Rendering the *wrong body* is the
 * one outcome this must not have, since nothing downstream could tell.
 */
async function readAtOffset(
  filePath: string,
  pointer: MessagePointer,
): Promise<TranscriptExcerpt | null> {
  if (typeof pointer.byteOffset !== 'number' || pointer.byteOffset < 0) return null;

  // Numbered from one before the target, so the first line the stream completes is the target's.
  const iterator = streamProseFrom(filePath, pointer.byteOffset, pointer.line - 1);
  try {
    const next = await iterator.next();
    if (next.done) return null;

    const { line, role, text, timestamp } = next.value.message;
    // Two guards, because an offset is a claim about a file that may have changed since. A
    // different line number means the offset landed mid-file somewhere else; a different length
    // means the line moved under it.
    if (line !== pointer.line) return null;
    if (typeof pointer.chars === 'number' && text.length !== pointer.chars) return null;
    return { line, role, text, timestamp };
  } catch {
    return null;
  } finally {
    // Ends the iteration, which destroys the underlying read stream. Windows keeps the file
    // handle otherwise, and the stream would go on reading a file nobody is listening to.
    await iterator.return({ bytesConsumed: 0, linesConsumed: 0 }).catch(() => {});
  }
}

/**
 * Prose for a set of stored pointers into one file.
 *
 * Each pointer with a usable byte offset is a seek: one read of the region the message lives in,
 * whatever the file's size. Measured before this existed, rendering a single ~400-byte hit
 * streamed 16.1 MB and took 224 ms, because the reader knew only the line number and had to
 * count newlines from the start of the file to find it.
 *
 * Anything without a usable offset falls back to the one grouped streaming pass, which is what
 * an index built before offsets were recorded still gets.
 */
export async function readMessagesFor(
  filePath: string,
  pointers: MessagePointer[],
): Promise<Map<number, TranscriptExcerpt>> {
  const found = new Map<number, TranscriptExcerpt>();
  const unresolved: number[] = [];

  for (const pointer of pointers) {
    const excerpt = await readAtOffset(filePath, pointer);
    if (excerpt) found.set(pointer.line, excerpt);
    else unresolved.push(pointer.line);
  }

  if (unresolved.length > 0) {
    for (const [line, excerpt] of await readMessagesAt(filePath, unresolved)) {
      found.set(line, excerpt);
    }
  }

  return found;
}

/**
 * The target message plus `context` prose turns on each side.
 *
 * Counts *turns*, not physical lines. Taking a line window and filtering it afterwards is what
 * an earlier draft did, and in a real transcript almost every prose message is separated from
 * the next by tool-result lines -- so `context: 2` routinely returned the target alone. The
 * caller asked for surrounding conversation, not for a slice of the file.
 *
 * One streaming pass: prose before the target is kept in a ring of at most `context` entries,
 * and the walk stops once `context` messages after it have been collected.
 */
export async function readWithContext(
  filePath: string,
  line: number,
  context: number,
): Promise<TranscriptExcerpt[]> {
  const before: TranscriptExcerpt[] = [];
  const after: TranscriptExcerpt[] = [];
  let target: TranscriptExcerpt | null = null;

  try {
    for await (const chunk of streamProseFrom(filePath, 0, 0)) {
      const { line: at, role, text, timestamp } = chunk.message;
      const excerpt: TranscriptExcerpt = { line: at, role, text, timestamp };

      if (at < line) {
        if (context > 0) {
          before.push(excerpt);
          if (before.length > context) before.shift();
        }
        continue;
      }

      if (at === line) { target = excerpt; continue; }

      // Past the target. Only reached once it has been seen, or when the requested line holds
      // no prose -- in which case there is nothing to anchor on and the walk should stop.
      if (!target) break;
      // Checked before pushing, not after: with `context: 0` a push-then-check appends one
      // trailing turn the caller did not ask for before noticing it is over budget.
      if (after.length >= context) break;
      after.push(excerpt);
      if (after.length >= context) break;
    }
  } catch {
    return [];
  }

  return target ? [...before, target, ...after] : [];
}
