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
