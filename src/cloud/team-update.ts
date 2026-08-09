import { readSyncState } from './sync-state.js';
import { withTeamStore } from './team-store.js';

/**
 * Tell the agent when team knowledge arrived after it last looked.
 *
 * Freshness is a notification problem here rather than a latency one: the query answers from
 * the replica immediately, so an answer can be slightly behind. What must never happen is that
 * it is behind *silently* -- an agent that acted on a superseded fact and was never told is
 * exactly the failure the change-card machinery exists to prevent locally.
 *
 * Returns null far more often than not, on purpose. A notice that fires every query is one the
 * agent learns to skip, and this one asks it to consider re-querying.
 */
export async function teamUpdateNotice(input: {
  workspaceId: string;
  configRoot: string;
  /** The watermark this session last reported. Null for a session that has not seen one. */
  seenSeq: string | null;
}): Promise<{ notice: string; seq: string } | null> {
  const state = await withTeamStore(input.workspaceId, input.configRoot, () => readSyncState())
    .catch(() => null);
  const current = state?.since;
  if (!current) return null;

  // BigInt, not Number. The sequence is a bigint by contract, so `Number()` collapses distinct
  // values above 2^53 -- and string comparison is worse still, since '9' sorts above '10' and
  // the notice would fire backwards at every digit boundary, then go silent.
  if (input.seenSeq !== null && BigInt(current) <= BigInt(input.seenSeq)) return null;

  return {
    seq: current,
    notice:
      'TEAM UPDATE: team knowledge has changed since your last query in this session. ' +
      'If your last answer came from the team, re-query before relying on it.',
  };
}
