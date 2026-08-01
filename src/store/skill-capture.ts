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
