import { getClient } from './database.js';

/**
 * The write side's negative signal: what a session was given the chance to store, and did not.
 *
 * Knowl's write path is all admission control -- secret validation, categories, conflict keys,
 * dedup. Every one of those gates decides what gets *in*. None of them notices what should have
 * got in and did not, and the read side has been growing exactly that kind of telemetry
 * (`knowledge_access` records retrieved-but-never-used) while the write side had no twin. The
 * only writer-side detector that existed was a person noticing afterwards and asking for the
 * save by hand.
 *
 * **Counted as it happens, not reconstructed at the end.** `memory_session_events` rows carry an
 * `expires_at` roughly two days out, so a count derived from them at finalization is a count that
 * silently becomes zero for any session finalized late -- and a measurement that reads zero when
 * it means "I no longer know" is worse than no measurement. Both counters are incremented on the
 * event that causes them.
 *
 * **Not swept.** These rows outlive the sessions they describe, which is the point: the sessions
 * expire and the question "how often does this repo talk and store nothing" is asked over months.
 * One row per session, a handful of integers wide.
 */

/**
 * The tools that put durable knowledge in the store.
 *
 * `knowl_query` is not here, and neither is any other read: an agent that queried diligently and
 * stored nothing is precisely the session this measures, so counting reads as writes would hide
 * the thing being looked for. Bare names, as `bareKnowlToolName` produces them.
 */
const DURABLE_WRITE_TOOLS = new Set([
  'knowl_store',
  'knowl_decide',
  'knowl_update',
  'knowl_ingest_atoms',
  'knowl_ingest',
]);

export function isDurableWriteTool(toolName?: string): boolean {
  return typeof toolName === 'string' && DURABLE_WRITE_TOOLS.has(toolName);
}

/**
 * Assistant turns a session must have produced before its silence means anything.
 *
 * A floor rather than a ratio, and a low one. The sessions this exists to catch are strategy
 * conversations -- long on turns, short on tool calls -- so any threshold counted in *tool
 * events* would exclude exactly them. Three turns is enough to distinguish "the person asked one
 * question and got one answer", where storing nothing is correct, from a working conversation.
 */
export const MIN_SUBSTANTIVE_TURNS = 3;

export type CaptureOutcome = {
  conversation: string;
  turns: number;
  durableWrites: number;
  /** Which mode acted on this session's silence, or null if none has. */
  nudged: string | null;
};

/**
 * The stable identity of one conversation, across every turn it contains.
 *
 * Deliberately not a memory session id. A Claude turn binds its own memory session and `Stop`
 * closes it, so the following turn gets a new one -- a counter keyed that way reports one turn
 * forever, however long the conversation runs. The host's own session id does not move, and it is
 * already on every hook event, so reading it costs nothing on the tool path.
 *
 * NUL-joined because a separator that can appear inside a project path lets two different
 * conversations collide on one row.
 */
export function conversationKey(input: {
  host: string;
  projectRoot: string;
  externalSessionId?: string;
}): string {
  return [input.host, input.projectRoot, input.externalSessionId ?? ''].join('\u0000');
}

/** Every counter starts its row, so neither caller has to know which of them ran first. */
async function bump(conversation: string, column: 'turns' | 'durable_writes'): Promise<void> {
  const id = (conversation ?? '').trim();
  if (!id) return;
  try {
    await getClient().execute({
      sql: `INSERT INTO capture_outcomes (conversation, observed_at, turns, durable_writes)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(conversation) DO UPDATE SET ${column} = ${column} + 1, observed_at = excluded.observed_at`,
      args: [id, new Date().toISOString(), column === 'turns' ? 1 : 0, column === 'durable_writes' ? 1 : 0],
    });
  } catch {
    // Advisory throughout. This runs inside a hook with the host blocked on the answer, and a
    // store mid-snapshot or a schema older than this table costs one measurement -- never a
    // session. A diagnostic must not change the process it observes.
  }
}

/** One assistant turn ended in this conversation. */
export async function recordSessionTurn(conversation: string): Promise<void> {
  await bump(conversation, 'turns');
}

/** One durable-write tool call was made in this conversation. */
export async function recordDurableWrite(conversation: string): Promise<void> {
  await bump(conversation, 'durable_writes');
}

export async function readCaptureOutcome(conversation: string): Promise<CaptureOutcome | null> {
  const id = (conversation ?? '').trim();
  if (!id) return null;
  try {
    const rows = await getClient().execute({
      sql: 'SELECT conversation, turns, durable_writes, nudged FROM capture_outcomes WHERE conversation = ?',
      args: [id],
    });
    const row = rows.rows[0];
    if (!row) return null;
    return {
      conversation: String(row.conversation),
      turns: Number(row.turns ?? 0),
      durableWrites: Number(row.durable_writes ?? 0),
      nudged: row.nudged === null || row.nudged === undefined ? null : String(row.nudged),
    };
  } catch {
    return null;
  }
}

/**
 * Whether this session's silence is worth acting on.
 *
 * Both halves are required and neither is a proxy for the other. Zero durable writes alone
 * catches the one-question session where storing nothing was the right call; enough turns alone
 * says nothing about whether anything was stored.
 *
 * Note this deliberately does not consult whether the *extractor* promoted anything.
 * `finalizeMemorySession` reporting `skipped` means automatic promotion found no candidate,
 * which is true of nearly every conversation and says nothing about what the agent stored by
 * hand -- a session with five `knowl_store` calls still finalizes `skipped`. Reading that as
 * "stored nothing" is how this fires on the sessions that did everything right.
 */
export function shouldNudgeForSilence(outcome: CaptureOutcome | null): boolean {
  if (!outcome) return false;
  if (outcome.nudged) return false;
  return outcome.durableWrites === 0 && outcome.turns >= MIN_SUBSTANTIVE_TURNS;
}

/**
 * Claim the one nudge this session gets. True only for the caller that won it.
 *
 * **This is the no-loop guarantee, and it is the reason the flag is written before the message
 * is delivered rather than after.** In `enforce` the nudge is delivered by blocking a stop, and a
 * block that fires on the condition "this session stored nothing" would fire again on the next
 * stop, and the one after -- the agent cannot clear the condition by any action except a write it
 * may reasonably decline to make. A gate that can trap an agent is strictly worse than no gate.
 *
 * The conditional UPDATE is what makes it a claim rather than a check: two concurrent stop hooks
 * race here, and exactly one sees a row change.
 */
export async function claimSilenceNudge(conversation: string, mode: string): Promise<boolean> {
  const id = (conversation ?? '').trim();
  if (!id) return false;
  try {
    const result = await getClient().execute({
      sql: 'UPDATE capture_outcomes SET nudged = ? WHERE conversation = ? AND nudged IS NULL',
      args: [mode, id],
    });
    return Number(result.rowsAffected ?? 0) > 0;
  } catch {
    return false;
  }
}

export type CaptureHealth = {
  sessions: number;
  /** Conversations that finished having stored nothing durable, of any length. */
  silent: number;
  /** Of those, the ones long enough for the silence to be worth a look. */
  substantiveSilent: number;
  /** Sessions where a nudge fired or would have. */
  nudged: number;
};

/**
 * The repo's capture health, for `knowl status`.
 *
 * Reported whatever `capture.nudge` says, because the number is the deliverable: a repo can see
 * how often this happens before deciding whether it wants anything done about it. That ordering
 * is the same one the access-count work followed, and the one `impact.gate` is still following.
 */
export async function captureHealth(): Promise<CaptureHealth> {
  try {
    const rows = await getClient().execute({
      sql: `SELECT COUNT(*) AS sessions,
                   SUM(CASE WHEN durable_writes = 0 THEN 1 ELSE 0 END) AS silent,
                   SUM(CASE WHEN durable_writes = 0 AND turns >= ? THEN 1 ELSE 0 END) AS substantive_silent,
                   SUM(CASE WHEN nudged IS NOT NULL THEN 1 ELSE 0 END) AS nudged
            FROM capture_outcomes`,
      args: [MIN_SUBSTANTIVE_TURNS],
    });
    const row = rows.rows[0];
    return {
      sessions: Number(row?.sessions ?? 0),
      silent: Number(row?.silent ?? 0),
      substantiveSilent: Number(row?.substantive_silent ?? 0),
      nudged: Number(row?.nudged ?? 0),
    };
  } catch {
    return { sessions: 0, silent: 0, substantiveSilent: 0, nudged: 0 };
  }
}

/** The nudge text, and the only place it is written. */
/**
 * The mid-session variant, for the MCP channel.
 *
 * The stop-hook text opens "this session is ending", which is true where it fires and false
 * here: this rides a tool result on the fifth Knowl call of a live session. A nudge that
 * misdescribes when it is speaking invites the agent to defer -- the session is not ending, so
 * there is nothing to do yet -- which is the opposite of what it is for.
 */
export function renderMidSessionSilenceNudge(): string {
  return [
    'KNOWL: this session has consulted memory several times and stored nothing durable.',
    'If anything you have established here would help a later session -- a verified finding, a decision and its reasoning, a diagnosis that will recur -- store it now with knowl_store or knowl_decide.',
    'If there is genuinely nothing durable yet, carry on; this will not ask again.',
  ].join(' ');
}

export function renderSilenceNudge(): string {
  return [
    'KNOWL: this session is ending and nothing durable was stored.',
    'If any of it was a decision, a plan, or a direction you were given — store it now with knowl_store or knowl_decide. Stated intent counts before it settles.',
    'If there was genuinely nothing worth keeping, say so and stop; this will not ask again.',
  ].join('\n');
}
