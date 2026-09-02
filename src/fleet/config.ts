import type { ProjectConfig } from '../core/types.js';

/**
 * The fleet's switches, read the way `capture-config.ts` reads its own: an optional argument,
 * and anything unrecognised falls to the quietest value. A typo in a config file must fail
 * toward silence, never toward a card.
 */
export type FleetCardMode = 'off' | 'shadow' | 'enforce';
const CARD_MODES: readonly FleetCardMode[] = ['off', 'shadow', 'enforce'];

/**
 * ON unless explicitly off. The roster costs a directory listing and prints nothing when the
 * session is alone, so the default that ships is the default that helps; an opt-in switch for
 * "tell me other sessions exist" is one nobody discovers until after the collision.
 */
export function isFleetEnabled(config?: ProjectConfig | null): boolean {
  return config?.fleet?.enabled !== false;
}

/** The per-turn delta digest. Off by default: it costs lines on every turn of a busy fleet. */
export function isFleetDigestEnabled(config?: ProjectConfig | null): boolean {
  return isFleetEnabled(config) && config?.fleet?.digest === 'on';
}

/**
 * The same-problem and shared-surface cards. `enforce` by default -- they are advice riding a
 * channel the agent already gets, never a refusal -- and `shadow` records what would have
 * been said for anyone measuring before trusting.
 */
export function fleetCardsMode(config?: ProjectConfig | null): FleetCardMode {
  if (!isFleetEnabled(config)) return 'off';
  const mode = config?.fleet?.cards;
  return CARD_MODES.includes(mode as FleetCardMode) ? mode as FleetCardMode : 'enforce';
}

/**
 * The stop-time nudge, which withholds a stop and so costs a turn. Shadow by default, on the
 * same ladder `capture.nudge` climbs: the measurement of how often it would fire is what any
 * decision to enforce it has to be made on.
 */
export function fleetNudgeMode(config?: ProjectConfig | null): FleetCardMode {
  if (!isFleetEnabled(config)) return 'off';
  const mode = config?.fleet?.nudge;
  return CARD_MODES.includes(mode as FleetCardMode) ? mode as FleetCardMode : 'shadow';
}
