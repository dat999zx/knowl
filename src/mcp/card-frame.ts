import { cardTrustNote, newCardCode, wrapCard } from '../core/card-marker.js';
import { hostProfile, isHookHost } from '../session/hosts/index.js';

/** One code per server process: the note and every wrapped block are born together here. */
const CODE = newCardCode();

/**
 * Whether this server frames the cards it appends and tells the model how to read them.
 *
 * Off when there is no project (global-only servers never produce notices) and when a verified
 * hook channel or a plugin already delivers the card -- those hosts must not read a note about
 * a carrier that is not theirs.
 */
export function cardFrameActive(host: string | undefined, projectRoot: string | null): boolean {
  if (!projectRoot) return false;
  if (!host || !isHookHost(host)) return true;
  const profile = hostProfile(host);
  // A host whose plugin frames its own cards (Hermes, OpenClaw) also has a note of its own;
  // a second one from this server would announce a second code.
  return !(profile.midTurnDeliveryVerified || profile.pluginEvents?.length);
}

export const frameCard = (text: string): string => wrapCard(text, CODE);

export const frameNote = (): string => cardTrustNote(CODE);
