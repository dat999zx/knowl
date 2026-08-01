import { getClient } from './database.js';

/** A command must run at least this many times before it is worth suggesting. */
export const SKILL_CAPTURE_MIN_REPEATS = 3;

/** Below this length a command carries nothing worth remembering. */
const MIN_COMMAND_CHARS = 4;

/** How much of the command the nudge shows before truncating. */
const NUDGE_COMMAND_CHARS = 160;

/**
 * Marks of a command that encodes project knowledge rather than a plain invocation:
 * a pipe, a redirect, or a filter. Repetition alone is not enough -- running the test
 * suite three times is Tuesday, not a workflow.
 *
 * `.cmd` used to be here as a "platform-specific binary". It is not: this project runs on
 * Windows, where `npm.cmd test` *is* `npm test` with the shell's own suffix attached. It
 * encoded nothing and made the bare command it was meant to exclude qualify.
 */
const NON_OBVIOUS = /(\||>|\bgrep\b|\btail\b|\bhead\b|\bsed\b|\bawk\b)/;

/**
 * Fires on the run that reaches the threshold and on no other.
 *
 * Equality, not `>=`: the nudge is a request to save the command once, so runs 4, 5 and 20
 * must stay silent whether or not the agent complied. Whether a saved skill already covers
 * the command is a separate question, answered by the caller.
 */
export function qualifiesForSkillCapture(command: string, repeatCount: number): boolean {
  const trimmed = command.trim();
  if (trimmed.length < MIN_COMMAND_CHARS) return false;
  if (repeatCount !== SKILL_CAPTURE_MIN_REPEATS) return false;
  return NON_OBVIOUS.test(trimmed);
}

export function renderSkillCaptureNudge(command: string, repeatCount: number): string {
  const shown = command.trim().slice(0, NUDGE_COMMAND_CHARS);
  return [
    // "this turn", not "this session": the count comes from the memory session bound to
    // the turn key, and Stop closes that binding, so repeats reset at every turn boundary.
    `KNOWL: you have run this ${repeatCount} times this turn:`,
    `  ${shown}`,
    'If it is a reusable workflow, save it with knowl_skill_create — give it a name and say what it is for.',
    'Saving records it for later; it is never run for you.',
  ].join('\n');
}

/**
 * How many times this exact command has already run successfully in this session, counting
 * the current one. Case-insensitive on the trimmed text, matching how a human would judge
 * "the same command".
 *
 * Counted in SQLite rather than by parsing every command row in JavaScript: this sits on
 * the per-tool-call path, where reading the whole event log to find a handful of matches
 * is work the database can do in one scalar query.
 *
 * A non-zero exit code does not count. Three failures then a success is a command being
 * debugged, not a workflow worth saving. An absent exit code counts as success, matching
 * the default the hook normalizer already applies when the host reports none.
 */
export async function countCommandRepeats(sessionId: string, command: string): Promise<number> {
  const key = command.trim().toLowerCase();
  if (!key) return 0;
  const rows = (await getClient().execute({
    sql: `SELECT COUNT(*) AS n FROM memory_session_events
          WHERE session_id = ? AND type = 'command'
            AND lower(trim(json_extract(payload, '$.command'))) = ?
            AND coalesce(json_extract(payload, '$.exitCode'), 0) = 0`,
    args: [sessionId, key],
  })).rows;
  return Number(rows[0]?.n ?? 0);
}
