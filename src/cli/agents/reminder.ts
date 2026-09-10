import { promptReminderFor } from '../../core/knowl-guidance.js';
import { hostProfile, isHookHost, HostOutput } from '../../session/hosts/index.js';
import { HookHost } from '../../core/host-hook-types.js';
import {
  driftReminderEvery, findProjectRoot, isDriftBackoffEnabled, loadConfig, shouldSendDriftReminder,
} from '../../core/config.js';
import { closeDb, initDb } from '../../store/database.js';
import { conversationKey, readCaptureOutcome } from '../../store/capture-outcome.js';
import { captureEventsMode } from '../../store/capture-config.js';
import { detectCorrectionSignal } from '../../core/lesson-signals.js';
import { recordCorrectionLesson, renderCorrectionNudge } from '../../store/pending-lessons.js';
import { assertKnowledgeDatabasePresent } from '../database-presence.js';
import { fleetTurnStartBestEffort } from '../../session/fleet-lifecycle.js';
import { readLifecyclePayload } from './lifecycle.js';
import { HookOutputOptions, REMINDER_HOSTS, reportHookFailure } from './hook-failure.js';

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
export function createAgentReminderOutput(host: string, text: string = promptReminderFor(hostLabel(host))): HostOutput {
  const unsupported = new Error(`Unsupported reminder host: ${host}`);
  if (!isHookHost(host)) throw unsupported;
  const profile = hostProfile(host);
  if (!profile.promptEvent) throw unsupported;
  const output = profile.startContext('turn-start', text);
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
export async function runAgentReminder(host: string, options: HookOutputOptions = {}): Promise<void> {
  // Enforced here because nothing else does. `src/index.ts` dispatches straight to this function
  // for the speed reason its own comment gives, which means commander never parses the argument
  // and the `<host>` it declares is not required of anybody: `knowl agent-reminder` with no host
  // reached `hostLabel(undefined)` and exited with `TypeError: Cannot read properties of
  // undefined (reading 'charAt')` and a stack trace through the bundle. In an editor that is not
  // untidiness -- it is a hook process crashing inside somebody's session.
  if (!isHookHost(host) || !hostProfile(host).promptEvent) {
    const said = host
      ? `"${host}" does not declare a prompt event.`
      : 'agent-reminder requires a host argument.';
    if (reportHookFailure(host ?? '', options, 'Error emitting agent reminder', new Error(
      `${said} Hosts that declare one: ${REMINDER_HOSTS.join(', ')}.`,
    ))) process.exitCode = 1;
    return;
  }

  let send = true;
  // The fleet's half of the prompt event: this turn's ask goes into the fleet store, and in
  // maximal posture the digest of what other sessions moved on to comes back. It shares the
  // one envelope with the card rather than printing a second, since a host reads one JSON
  // object from a hook.
  let digest: string | undefined;
  // The correction lesson. `host-lifecycle`'s `turn-start` branch does this for hosts whose
  // prompt event reaches `agent-hook`, and claude/codex/copilot/openhands are not those hosts:
  // `hook-config.ts` registers THIS command under their prompt event and strips any lifecycle
  // handler from the same key. So the classifier ran nowhere in production (#289). It runs here,
  // where the prompt, the project root and an open store are all already in hand.
  let correctionLine: string | undefined;
  try {
    const payload = await readLifecyclePayload();
    const identity = hostProfile(host as HookHost).identity(payload);
    const root = await findProjectRoot(typeof payload.cwd === 'string' ? payload.cwd : process.cwd());
    assertKnowledgeDatabasePresent(root);
    await initDb(root);
    try {
      const conversation = conversationKey({ host, projectRoot: root, externalSessionId: identity.externalSessionId });
      const outcome = await readCaptureOutcome(conversation);
      const turns = outcome?.turns ?? 0;
      const config = await loadConfig(root).catch(() => null);
      send = turns === 0
        || shouldSendDriftReminder(turns, driftReminderEvery(config), isDriftBackoffEnabled(config));
      const eventsMode = captureEventsMode(config ?? undefined);
      // Same order as the engine's: classify, pend, and speak only in enforce. The verdict is
      // a boolean -- no user text is stored, here or in the row.
      if (eventsMode !== 'off' && typeof payload.prompt === 'string' && detectCorrectionSignal(payload.prompt)
        && await recordCorrectionLesson(conversation) && eventsMode === 'enforce') {
        correctionLine = renderCorrectionNudge();
      }
      if (identity.externalSessionId) {
        digest = await fleetTurnStartBestEffort({
          host,
          externalSessionId: identity.externalSessionId,
          projectRoot: root,
          prompt: typeof payload.prompt === 'string' ? payload.prompt : undefined,
        }, config);
      }
    } finally {
      await closeDb().catch(() => {});
    }
  } catch {
    // Fail open: `send` is already true. See the docblock -- guidance must never switch itself
    // off for the rest of a session because the store could not be read.
  }
  // Silence is an empty stdout, not an empty envelope: a host that reads `hookSpecificOutput`
  // with a blank `additionalContext` may still spend a line on it.
  //
  // Inside a try of its own, and deliberately not inside the fail-open one above: that one
  // answers "the store could not be read", whose correct response is to emit the card anyway.
  // This one answers "the card could not be emitted", where emitting it again is the failure
  // repeating. These two lines used to sit outside every try in the function.
  try {
    const parts = [correctionLine, send ? promptReminderFor(hostLabel(host)) : undefined, digest].filter((part): part is string => Boolean(part));
    if (parts.length > 0) console.log(JSON.stringify(createAgentReminderOutput(host, parts.join('\n\n'))));
  } catch (error) {
    if (reportHookFailure(host, options, 'Error emitting agent reminder', error)) process.exitCode = 1;
  }
}
