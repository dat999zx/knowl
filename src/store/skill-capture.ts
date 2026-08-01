import { getClient } from './database.js';

/** A command must run at least this many times before it is worth suggesting. */
export const SKILL_CAPTURE_MIN_REPEATS = 3;

/** Below this length a command carries nothing worth remembering. */
const MIN_COMMAND_CHARS = 4;

/** How much of the command the nudge shows before truncating. */
const NUDGE_COMMAND_CHARS = 160;

/**
 * Marks of a command that encodes project knowledge rather than a plain invocation:
 * a pipe, a redirect, a filter flag, or a platform-specific binary. Repetition alone
 * is not enough -- running the test suite three times is Tuesday, not a workflow.
 */
const NON_OBVIOUS = /(\||>|2>&1|\bgrep\b|\btail\b|\bhead\b|\bsed\b|\bawk\b|\.cmd\b)/;

export function qualifiesForSkillCapture(command: string, repeatCount: number): boolean {
  const trimmed = command.trim();
  if (trimmed.length < MIN_COMMAND_CHARS) return false;
  if (repeatCount < SKILL_CAPTURE_MIN_REPEATS) return false;
  return NON_OBVIOUS.test(trimmed);
}

export function renderSkillCaptureNudge(command: string, repeatCount: number): string {
  const shown = command.trim().slice(0, NUDGE_COMMAND_CHARS);
  return [
    `KNOWL: you have run this ${repeatCount} times this session:`,
    `  ${shown}`,
    'If it is a reusable workflow, save it with knowl_skill_create — give it a name and say what it is for.',
    'Saving records it for later; it is never run for you.',
  ].join('\n');
}

/**
 * How many times this exact command has already run in this session, counting the
 * current one. Case-insensitive on the trimmed text, matching how a human would
 * judge "the same command".
 */
export async function countCommandRepeats(sessionId: string, command: string): Promise<number> {
  const key = command.trim().toLowerCase();
  if (!key) return 0;
  const rows = (await getClient().execute({
    sql: `SELECT payload FROM memory_session_events WHERE session_id = ? AND type = 'command'`,
    args: [sessionId],
  })).rows;
  let count = 0;
  for (const row of rows) {
    try {
      const payload = JSON.parse(String(row.payload));
      if (typeof payload.command === 'string' && payload.command.trim().toLowerCase() === key) count++;
    } catch {
      // A malformed payload is not a match; never let one row abort the count.
    }
  }
  return count;
}
