import type { ProjectConfig } from '../core/types.js';

export function isTranscriptSearchEnabled(config: ProjectConfig): boolean {
  return config.search?.transcripts?.enabled === true;
}

/**
 * Sharing is meaningless without a local index, so it is an AND rather than its own flag.
 * A repo that turned search off but left `share: true` behind would otherwise advertise an
 * index that no longer exists, and every peer would take an `absent` skip for it.
 */
export function isTranscriptSharingEnabled(config: ProjectConfig): boolean {
  return isTranscriptSearchEnabled(config) && config.search?.transcripts?.share === true;
}
