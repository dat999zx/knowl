import { cardTrustNote, newCardCode, wrapCard } from '../core/card-marker.js';
import { hostProfile, isHookHost } from '../session/hosts/index.js';

/** One code per server process: the note and every wrapped block are born together here. */
const CODE = newCardCode();

/**
 * Whether this server frames the cards it appends and tells the model how to read them.
 *
 * Off when there is no project (global-only servers never produce notices) and when a verified
 * hook channel already delivers the card -- those hosts must not read a note about a carrier
 * that is not theirs.
 */
export function cardFrameActive(host: string | undefined, projectRoot: string | null): boolean {
  if (!projectRoot) return false;
  return !(host && isHookHost(host) && hostProfile(host).midTurnDeliveryVerified);
}

export const frameCard = (text: string): string => wrapCard(text, CODE);

export const frameNote = (): string => cardTrustNote(CODE);
