import { createHash } from 'node:crypto';

/**
 * A failure reduced to the part two sessions would share.
 *
 * Two sessions that hit "the same problem" never see byte-identical text: the path is their
 * own worktree's, the line number moved, the timestamp and the pid differ, the test runner
 * prefixed a different elapsed time. Matching on raw text therefore never fires, and the
 * whole feature would be a table nobody's rows ever join. What survives across sessions is the
 * error's *kind* and the first line that names it, so that is what is hashed.
 *
 * `head` is kept beside the hash for the card: an agent told "a peer hit signature 3f9a…" has
 * nothing to act on, while "a peer hit `SQLITE_BUSY: database is locked`" is a sentence it can
 * recognise from its own screen.
 */
export interface ErrorSignature {
  /** Stable across sessions: sha1 of the normalised head. */
  sig: string;
  /** The normalised first meaningful line, for display. */
  head: string;
}

const MAX_HEAD_CHARS = 160;

/** ANSI colour sequences, built from the escape's code point so the pattern holds no control character. */
const ANSI_SEQUENCE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');

/** Lines that name a runner, a shell prompt or a frame rather than the error itself. */
const NOISE_LINE = /^(\s*$|\s*at\s|\s*\d+\s*\||>|\$|npm (ERR|warn)|\s*(FAIL|PASS|RUNS)\s|.*node:internal|\s*-{3,}|\s*={3,})/i;

/**
 * Runner totals and per-file tallies. They contain the word "failed" and say nothing about
 * what failed, so they must lose to any line that does.
 */
const SUMMARY_LINE = /^\s*(test files|tests|snapshots|duration|start at|errors)\s*[:|]?\s*\d|\(\d+\s+tests?\b|\b\d+\s+(passed|failed|skipped)\b.*\b\d+\s+(passed|failed|skipped)\b/i;

/**
 * Lines that name the failure itself: an exception class, an errno-style code, a shouted
 * constant, or a runner's own "this is the error" marker. The LAST such line in the tail wins,
 * because both Node and vitest print the cause after the context -- a `caused by:` chain ends
 * at the root, and vitest's `→ message` follows its `× test name`.
 */
const STRONG_ERROR = /^\s*[→×✖✗]|\b\w+(Error|Exception)\b|\bE[A-Z]{3,}\b|\b[A-Z]{2,}_[A-Z_]{2,}\b|\berror:/;

/** Weaker evidence, used only when nothing strong appears. The FIRST such line wins. */
const ERROR_LINE = /\b(error|exception|failed|failure|cannot|could not|unable|not found|denied|refused|timeout|timed out|assert|expected|unexpected|invalid|missing|undefined|null|busy|locked|conflict)\b/i;

/**
 * Lowercase, one space, and every token that is unique to one session replaced by a
 * placeholder: absolute and relative paths, line:column pairs, hex ids and hashes, numbers,
 * quoted strings longer than a word, ISO timestamps and durations.
 */
export function normalizeErrorLine(line: string): string {
  return line
    .replace(ANSI_SEQUENCE, '')
    .replace(/\b[A-Za-z]:[\\/][^\s'"`:)]+/g, '<path>')
    .replace(/(^|[\s'"`(])(?:\.{1,2}[\\/]|~[\\/]|[\\/])[^\s'"`:)]+/g, '$1<path>')
    .replace(/\b[\w.-]+\.(ts|tsx|js|mjs|cjs|json|py|rs|go|java|sql|md|css|html)\b/g, '<file>')
    .replace(/\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}[:\d.]*Z?\b/g, '<time>')
    .replace(/\b[0-9a-f]{7,64}\b/gi, '<hex>')
    .replace(/:\d+\b/g, ':<n>')
    .replace(/\b\d+(\.\d+)?\s?(ms|s|m|h|kb|mb|gb|%)\b/gi, '<n>')
    .replace(/\b\d+\b/g, '<n>')
    .replace(/(["'`])(?:(?!\1).){24,}\1/g, '$1<str>$1')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * The line that names the failure, chosen from the tail of the output.
 *
 * The tail, because a failing command prints its build log first and its error last, and the
 * head of a 400-line vitest run is a list of files that passed. Among the last lines the last
 * `STRONG_ERROR` match wins; failing that, the first `ERROR_LINE` match; failing that, the last
 * non-noise line; failing that, the last line at all -- an empty signature would silently
 * match every other empty signature.
 */
export function errorHeadLine(text: string): string {
  const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if (lines.length === 0) return '';
  const tail = lines.slice(-40).filter(line => !NOISE_LINE.test(line) && !SUMMARY_LINE.test(line));
  const strong = [...tail].reverse().find(line => STRONG_ERROR.test(line));
  if (strong) return strong;
  const weak = tail.find(line => ERROR_LINE.test(line));
  if (weak) return weak;
  return tail[tail.length - 1] ?? lines[lines.length - 1];
}

export function errorSignature(text: string): ErrorSignature | undefined {
  const head = normalizeErrorLine(errorHeadLine(text)).slice(0, MAX_HEAD_CHARS);
  if (head.length < 8) return undefined;
  return { sig: createHash('sha1').update(head).digest('hex').slice(0, 16), head };
}

/**
 * Whether two normalised heads describe the same failure without being byte-equal.
 *
 * Token Jaccard over the placeholder-normalised heads. The threshold is deliberately high:
 * this decides whether one session is told to stop and coordinate, and a false "same problem"
 * costs a real interruption, while a missed one costs nothing that was not already the status
 * quo. 0.8 keeps `expected 3 to be 4` apart from `expected undefined to be defined` (shared
 * tokens 2 of 5) and joins `sqlite_busy: database is locked (<path>)` with
 * `error: sqlite_busy: database is locked` (5 of 6).
 */
export function sameErrorHead(a: string, b: string, threshold = 0.8): boolean {
  if (a === b) return true;
  const left = new Set(a.split(' ').filter(Boolean));
  const right = new Set(b.split(' ').filter(Boolean));
  if (left.size === 0 || right.size === 0) return false;
  let shared = 0;
  for (const token of left) if (right.has(token)) shared += 1;
  const union = left.size + right.size - shared;
  return shared / union >= threshold;
}
