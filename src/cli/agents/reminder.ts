import { promptReminderFor } from '../../core/knowl-guidance.js';
import { hostProfile, isHookHost, HostOutput } from '../../session/hosts/index.js';
import { HookHost } from '../../core/host-hook-types.js';
import {
  driftReminderEvery, findProjectRoot, isDriftBackoffEnabled, loadConfig, shouldSendDriftReminder,
} from '../../core/config.js';
import { closeDb, initDb } from '../../store/database.js';
import { conversationKey, readCaptureOutcome } from '../../store/capture-outcome.js';
import { assertKnowledgeDatabasePresent } from '../database-presence.js';
import { readLifecyclePayload } from './lifecycle.js';

/**
 * Hosts whose key does not title-case into their own name.
 *
 * Every other host does -- `codex` -> `Codex`, `windsurf` -> `Windsurf` -- so listing them here
 * would be six lines restating what the fallback already returns, and a seventh host would be
 * assumed to need one.
 */
const HOST_LABELS: Record<string, string> = {
  openhands: 'OpenHands',
};

const hostLabel = (host: string): string =>
  HOST_LABELS[host] ?? host.charAt(0).toUpperCase() + host.slice(1);

/**
 * Prompt-time guidance card for hosts that declare a prompt event. The envelope comes
 * from the host profile, so a host is supported here exactly when it says it can
 * receive context at turn start.
 *
 * The card names this host rather than always naming Claude: its closing line is the one that
 * tells the agent not to open a manual task loop, and a Codex session told that *Claude's*
 * hooks own the lifecycle can reasonably read the sentence as being about a different session.
 */
export function createAgentReminderOutput(host: string): HostOutput {
  const unsupported = new Error(`Unsupported reminder host: ${host}`);
  if (!isHookHost(host)) throw unsupported;
  const profile = hostProfile(host);
  if (!profile.promptEvent) throw unsupported;
  const output = profile.startContext('turn-start', promptReminderFor(hostLabel(host)));
  if (!output) throw unsupported;
  return output;
}

/**
 * Decide whether this prompt earns the card, then emit it or say nothing.
 *
 * The card is a static paragraph restating KNOWL.md, and every host already carries that text
 * in its system prompt -- `CLAUDE.md` -> `@KNOWL.md` for claude (`instruction-files.ts`), the
 * managed block in `AGENTS.md` for the rest (`agents-guidance.ts`). Sending it on every prompt
 * spent ~153 tokens a turn and, because turn-start context stays in the transcript rather than
 * replacing the previous copy, it accumulated: a 40-turn session carried 40 identical copies.
 *
 * So it now follows the schedule the mid-turn continuation reminder already uses --
 * `reminders.driftEvery` with `reminders.driftBackoff`, via `shouldSendDriftReminder` -- read
 * off `capture_outcomes.turns`.
 *
 * Why that counter and not `host_session_bindings.successful_tool_count`, which is what the
 * mid-turn reminder counts: the binding is keyed on the host session *and turn*, and Claude's
 * `Stop` closes it, so at `UserPromptSubmit` the row for the turn about to begin does not exist
 * yet and the previous turn's is already inactive. `capture_outcomes` is keyed on the
 * conversation for exactly this reason (see `conversationKey`), it survives every turn
 * boundary, and it is already maintained unconditionally.
 *
 * Turn 0 always speaks: a conversation that has never seen the card gets it once. After that
 * backoff lands deliveries at 12, 36, 84, 180 completed turns.
 *
 * Fail-open. Every failure emits the card, because a store that cannot be read must not
 * silently switch guidance off for the rest of a session -- it degrades to the old behaviour,
 * which was wasteful but never wrong.
 */
export async function runAgentReminder(host: string): Promise<void> {
  let send = true;
  try {
    const payload = await readLifecyclePayload();
    const identity = hostProfile(host as HookHost).identity(payload);
    const root = await findProjectRoot(typeof payload.cwd === 'string' ? payload.cwd : process.cwd());
    assertKnowledgeDatabasePresent(root);
    await initDb(root);
    try {
      const outcome = await readCaptureOutcome(conversationKey({
        host,
        projectRoot: root,
        externalSessionId: identity.externalSessionId,
      }));
      const turns = outcome?.turns ?? 0;
      const config = await loadConfig(root).catch(() => null);
      send = turns === 0
        || shouldSendDriftReminder(turns, driftReminderEvery(config), isDriftBackoffEnabled(config));
    } finally {
      await closeDb().catch(() => {});
    }
  } catch {
    // Fail open: `send` is already true. See the docblock -- guidance must never switch itself
    // off for the rest of a session because the store could not be read.
  }
  // Silence is an empty stdout, not an empty envelope: a host that reads `hookSpecificOutput`
  // with a blank `additionalContext` may still spend a line on it.
  if (send) console.log(JSON.stringify(createAgentReminderOutput(host)));
}
