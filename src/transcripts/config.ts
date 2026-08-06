import type { ProjectConfig } from '../core/types.js';
import { isTranscriptSearchEnabled } from '../core/config.js';

/**
 * `isTranscriptSearchEnabled` now lives in `core/config.ts` — it is a predicate over a core
 * type and `core/knowl-guidance.ts` needs it, which it could not reach from here without core
 * depending on a feature. Re-exported so this module stays the obvious place to look.
 */
export { isTranscriptSearchEnabled } from '../core/config.js';

/**
 * Sharing is meaningless without a local index, so it is an AND rather than its own flag.
 * A repo that turned search off but left `share: true` behind would otherwise advertise an
 * index that no longer exists, and every peer would take an `absent` skip for it.
 */
export function isTranscriptSharingEnabled(config: ProjectConfig): boolean {
  return isTranscriptSearchEnabled(config) && config.search?.transcripts?.share === true;
}
