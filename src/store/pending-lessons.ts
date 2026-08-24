import crypto from 'node:crypto';
import { getClient } from './database.js';
import { DESTRUCTIVE_LABELS, type DestructiveCommandHit, type DestructiveCommandId } from '../core/lesson-signals.js';

/**
 * Pending lessons: specific events whose knowledge has not been stored yet.
 *
 * `capture_outcomes` answers "did this conversation store anything at all", and its scoping is
 * exactly why it missed the incident that motivated this table: a session that stores plenty of
 * unrelated atoms reads as healthy while the one thing that mattered -- a destructive command
 * that took out more than it aimed at, a correction the user had to make -- goes unwritten.
 * Both of the existing backstops (the drift reminder and the silence nudge) are disarmed by
 * unrelated memory activity for the same structural reason. A pending lesson is the opposite
 * shape: one row per event, claimed per event, and only a write that lands AFTER the event can
 * settle it.
 *
 * Everything here is advisory-path plumbing and fails open: this runs inside a hook with the
 * host blocked on the answer, and a lost measurement is always cheaper than a lost session.
 */

export type PendingLessonKind = 'destructive' | 'correction';

export type PendingLesson = {
  id: string;
  conversation: string;
  kind: PendingLessonKind;
  /** Command class for destructive lessons; null for corrections. */
  class: string | null;
  /** A short clip of the command; corrections deliberately carry no text at all. */
  snippet: string | null;
  observedAt: string;
};

/** One nudge per command class per conversation; corrections capped separately. */
export const MAX_CORRECTION_LESSONS = 3;
/** The hard annoyance budget: at most this many blocked stops per conversation, ever. */
export const MAX_LESSON_BLOCKS = 3;
const SNIPPET_CHARS = 120;

const clip = (text: string): string => (text.length > SNIPPET_CHARS ? `${text.slice(0, SNIPPET_CHARS)}…` : text);

/**
 * Record a destructive-command lesson. True only when this class had not fired for this
 * conversation yet -- the caller nudges exactly when this returns true, so "one nudge per
 * class per session" is decided here, race-safe, rather than by a read the next hook process
 * cannot see.
 */
export async function recordDestructiveLesson(conversation: string, hit: DestructiveCommandHit, command: string): Promise<boolean> {
  const id = (conversation ?? '').trim();
  if (!id) return false;
  try {
    const client = getClient();
    const existing = await client.execute({
      sql: 'SELECT 1 FROM pending_lessons WHERE conversation = ? AND class = ? LIMIT 1',
      args: [id, hit.id],
    });
    if (existing.rows.length > 0) return false;
    await client.execute({
      sql: `INSERT INTO pending_lessons (id, conversation, kind, class, snippet, observed_at)
            VALUES (?, ?, 'destructive', ?, ?, ?)`,
      args: [crypto.randomUUID(), id, hit.id, clip(String(command ?? '')), new Date().toISOString()],
    });
    return true;
  } catch {
    return false;
  }
}

/** Record a correction lesson, capped at `MAX_CORRECTION_LESSONS`: separate corrections are usually separate things. */
export async function recordCorrectionLesson(conversation: string): Promise<boolean> {
  const id = (conversation ?? '').trim();
  if (!id) return false;
  try {
    const client = getClient();
    const count = await client.execute({
      sql: "SELECT COUNT(*) AS n FROM pending_lessons WHERE conversation = ? AND kind = 'correction'",
      args: [id],
    });
    if (Number(count.rows[0]?.n ?? 0) >= MAX_CORRECTION_LESSONS) return false;
    await client.execute({
      sql: `INSERT INTO pending_lessons (id, conversation, kind, class, snippet, observed_at)
            VALUES (?, ?, 'correction', NULL, NULL, ?)`,
      args: [crypto.randomUUID(), id, new Date().toISOString()],
    });
    return true;
  } catch {
    return false;
  }
}

export async function openPendingLessons(conversation: string): Promise<PendingLesson[]> {
  const id = (conversation ?? '').trim();
  if (!id) return [];
  try {
    const rows = await getClient().execute({
      sql: 'SELECT id, conversation, kind, class, snippet, observed_at FROM pending_lessons WHERE conversation = ? AND resolved IS NULL ORDER BY observed_at',
      args: [id],
    });
    return rows.rows.map(row => ({
      id: String(row.id),
      conversation: String(row.conversation),
      kind: String(row.kind) as PendingLessonKind,
      class: row.class === null || row.class === undefined ? null : String(row.class),
      snippet: row.snippet === null || row.snippet === undefined ? null : String(row.snippet),
      observedAt: String(row.observed_at),
    }));
  } catch {
    return [];
  }
}

/**
 * A durable write settles the lessons that were already on the table when it happened --
 * temporal, not blanket. Clearing everything on any write is the same flaw one level down
 * that disarms the drift counter: unrelated activity reading as the thing it is not. An
 * event recorded after the write still stands, because the write cannot have been about it.
 */
export async function resolveLessonsBefore(conversation: string, timestamp: string): Promise<void> {
  const id = (conversation ?? '').trim();
  if (!id) return;
  try {
    await getClient().execute({
      sql: "UPDATE pending_lessons SET resolved = 'write' WHERE conversation = ? AND resolved IS NULL AND observed_at <= ?",
      args: [id, timestamp],
    });
  } catch {
    // Advisory; a lesson that stays open one stop longer costs a sentence, not a session.
  }
}

/**
 * Settle lessons with the reason they settled: 'blocked' was delivered, 'shadow' would have
 * been, 'budget' hit the ceiling and was delivered nothing. Three words instead of one so the
 * measurement this exists to produce cannot conflate a message the agent saw with one it never
 * could have.
 */
export async function markPendingLessons(ids: string[], how: 'blocked' | 'shadow' | 'budget'): Promise<void> {
  if (ids.length === 0) return;
  try {
    const client = getClient();
    for (const id of ids) {
      await client.execute({ sql: 'UPDATE pending_lessons SET resolved = ? WHERE id = ? AND resolved IS NULL', args: [how, id] });
    }
  } catch {
    // Advisory.
  }
}

/**
 * Claim one of the conversation's blocked stops. True only for the caller that won it, by the
 * same conditional-write rule as `claimSilenceNudge`: two stop hooks race here, and the budget
 * must be spent exactly once. The budget is a hard ceiling on what this feature may ever cost
 * a conversation -- after `MAX_LESSON_BLOCKS`, everything else settles silently.
 */
export async function claimLessonBlock(conversation: string): Promise<boolean> {
  const id = (conversation ?? '').trim();
  if (!id) return false;
  try {
    const client = getClient();
    await client.execute({
      sql: 'INSERT OR IGNORE INTO pending_lesson_claims (conversation, blocks) VALUES (?, 0)',
      args: [id],
    });
    const result = await client.execute({
      sql: 'UPDATE pending_lesson_claims SET blocks = blocks + 1 WHERE conversation = ? AND blocks < ?',
      args: [id, MAX_LESSON_BLOCKS],
    });
    return Number(result.rowsAffected ?? 0) > 0;
  } catch {
    return false;
  }
}

const describe = (lesson: PendingLesson): string => {
  if (lesson.kind === 'correction') return '  - the user corrected you';
  // From the classifier's own table, not a second copy: the two had already drifted, and a
  // class this build does not know (an older row, a newer writer) falls back rather than
  // renders blank.
  const label = DESTRUCTIVE_LABELS[lesson.class as DestructiveCommandId] ?? 'an irreversible command';
  return `  - ${label}${lesson.snippet ? `: \`${lesson.snippet}\`` : ''}`;
};

const HOW_TO_STORE =
  'knowl_store (category "constraint", tags ["operational-safety"], provenance "observed") naming the exact command, '
  + 'what it actually matched beyond what you intended, the damage, and the narrower form to use instead.';

/** The mid-turn nudge for a destructive command, sent while the agent still knows what else matched. */
export function renderLessonNudge(hit: DestructiveCommandHit, command: string): string {
  return [
    `KNOWL LESSON: that was ${hit.label}: \`${clip(String(command ?? ''))}\``,
    'Ask now, while you still know: what else matched that predicate? If it touched anything you did not own,',
    `store it immediately -- ${HOW_TO_STORE}`,
    'If it did exactly what you intended and nothing else, carry on. This fires once per command class per session.',
  ].join(' ');
}

/** The turn-start line for a correction. The lesson exists in the agent's own context; no text is echoed. */
export function renderCorrectionNudge(): string {
  return [
    'KNOWL LESSON: this prompt reads as a CORRECTION, not a new task.',
    'A correction is durable knowledge you were supposed to be holding and were not -- store the rule that',
    'prevents it next time with knowl_store (or knowl_update if it corrects something already stored), then answer.',
    'If it is already in memory, say so with the item id in one line. If this is not actually a correction,',
    'say that instead: this is a local pattern on the prompt text, not a verdict.',
  ].join(' ');
}

/** The stop-block reason. Every escape hatch is honest, and (d) exists so the gate can never teach fabrication. */
export function renderLessonStopReason(lessons: PendingLesson[]): string {
  return [
    'KNOWL LESSON GATE: this conversation contains something durable that was never written to memory:',
    ...lessons.map(describe),
    'No durable write followed it. Operational hazards and corrections are more important to persist than',
    'technical findings, not less -- the next session repeats them blind. Do one of these now, then stop again:',
    `  (a) store it -- ${HOW_TO_STORE}`,
    '  (b) if it is already in memory, say so in one line with the item id.',
    '  (c) if it was routine and harmed nothing, say so in one sentence.',
    '  (d) if no such event actually happened, say so and stop. Never invent an incident to satisfy this',
    '      gate -- an empty answer is a correct outcome, a fabricated memory is not.',
    'This gate has already disarmed itself for these events; it will not raise them again.',
  ].join('\n');
}
