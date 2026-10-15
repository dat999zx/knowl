import { codeProfile } from './code.js';
import type { DomainProfile } from './types.js';

const BUILT_IN: DomainProfile[] = [codeProfile];
export const BUILT_IN_PROFILES: Record<string, DomainProfile> = Object.fromEntries(BUILT_IN.map(p => [p.id, p]));

const PROFILE_ID = /^[a-z][a-z0-9-]*$/;

/**
 * Resolves a domain profile by id: validate the id, then built-ins by own property.
 * Throws for anything unknown.
 */
export function domainProfile(id: string): DomainProfile {
  if (PROFILE_ID.test(id) && Object.prototype.hasOwnProperty.call(BUILT_IN_PROFILES, id)) {
    return BUILT_IN_PROFILES[id];
  }
  const available = Object.keys(BUILT_IN_PROFILES).sort().join(', ');
  throw new Error(`Unknown domain profile "${id}". Available: ${available}.`);
}
