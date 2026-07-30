import type { CrossRepoOverlap } from '../workspace/cross-repo-overlap.js';

/**
 * Terminal lines telling the user a linked repo already covers this subject.
 *
 * A separate renderer from the MCP one (`describeWriteReconciliation`) because the audiences
 * differ: an agent gets told which tool call is refused, a person gets told which repo to go and
 * talk to. Shared across the CLI write paths so they cannot drift, and exported so the delivery
 * is testable -- producing this report and never printing it is the failure mode that hid the
 * gap in the first place.
 */
export function formatCrossRepoNotice(overlaps?: CrossRepoOverlap[]): string[] {
  if (!overlaps?.length) return [];

  return overlaps.map(overlap => {
    const what = overlap.kind === 'conflict' ? 'contradicts' : 'overlaps';
    const lineage = overlap.kin ? ', which shares this repo\'s lineage' : '';
    const role = overlap.role ? ` (${overlap.role})` : '';
    return `🔗 This ${what} linked repo "${overlap.repo}"${role}${lineage}: `
      + `"${overlap.title}" (${overlap.id}). It belongs to that repo, so it cannot be changed `
      + `from here — raise it with whoever owns it.`;
  });
}
