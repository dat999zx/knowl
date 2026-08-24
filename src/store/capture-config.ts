import type { ProjectConfig } from '../core/types.js';

export type CaptureNudgeMode = 'off' | 'shadow' | 'enforce';

const NUDGE_MODES: readonly CaptureNudgeMode[] = ['off', 'shadow', 'enforce'];

/**
 * How a session that stored nothing should be handled, resolved in one place.
 *
 * Anything unrecognised is `off`, following `impactGateMode`'s rule and for the same reason
 * stated in its own terms: `enforce` blocks a stop, which spends a turn the person did not ask
 * for, and `config.json` is a file people edit by hand. A typo must fail towards silence.
 *
 * The argument is optional because the callers sit on the lifecycle path, where the config is
 * only present once a project root has resolved -- making each of them write
 * `config ? captureNudgeMode(config) : 'off'` is how one of them eventually writes the negation
 * by mistake.
 *
 * Note what this does *not* gate: the counting. `capture_outcomes` is written whatever this
 * returns, because measurement before mechanism is the whole point -- a repo that never turns
 * the nudge on should still be able to answer "how often does this happen here?".
 */
export function captureNudgeMode(config?: ProjectConfig): CaptureNudgeMode {
  const mode = config?.capture?.nudge;
  return NUDGE_MODES.includes(mode as CaptureNudgeMode) ? mode as CaptureNudgeMode : 'off';
}

/**
 * How event-shaped lessons -- a destructive command that ran, a prompt that reads as a user
 * correction -- are handled. Same ladder and same typo rule as `capture.nudge`, and a separate
 * switch from it for the reason `impact.gate` is separate from `impact.enabled`: the silence
 * nudge speaks once per conversation about a total; this inspects individual events and can
 * withhold a stop over one, which is a different risk armed by a different, deliberate act.
 */
export function captureEventsMode(config?: ProjectConfig): CaptureNudgeMode {
  const mode = config?.capture?.events;
  return NUDGE_MODES.includes(mode as CaptureNudgeMode) ? mode as CaptureNudgeMode : 'off';
}

export type CaptureScope = 'conversation' | 'turn';

/**
 * At what granularity the silence question is asked. `conversation` is today's behaviour and
 * the default; `turn` additionally watches each turn as it runs and can prompt mid-turn --
 * through the free context channel, never a blocked stop -- when a turn has done substantial
 * work and stored nothing. A typo falls back to `conversation` by the same rule as the modes
 * above: the narrower, quieter reading.
 */
export function captureScope(config?: ProjectConfig): CaptureScope {
  return config?.capture?.scope === 'turn' ? 'turn' : 'conversation';
}
