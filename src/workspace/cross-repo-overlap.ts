import { rankKnowledge } from '../store/agent-query.js';
import { checkKnowledgeConflict } from '../store/conflicts.js';
import { sameSubjectTitle } from '../store/knowledge-writer.js';
import { openPeerStore } from '../store/store-handle.js';
import type { ActiveWorkspace } from './resolve.js';

export type CrossRepoOverlap = {
  repo: string;
  id: string;
  title: string;
  kind: 'conflict' | 'duplicate';
};

export type OverlapSubject = {
  category: string;
  title: string;
  content: string;
  reasoning?: string | null;
  tags?: string[] | null;
  conflictKey?: string | null;
  conflictScope?: Record<string, unknown> | null;
  conflictExclusive?: boolean;
};

/** Per peer, per write. Bounded because this runs on every knowledge write in a workspace. */
const PEER_CANDIDATES = 3;

/**
 * What the linked repos already say about this subject.
 *
 * Reports only. The colliding item belongs to another repo, and only that repo can retire it --
 * a write here silently superseding it is the failure a single owner per item exists to
 * prevent, and `assertOwnedItem` already refuses it on the update path. Detection is the part
 * federation could not do: duplicate and conflict checks only ever looked in the writing repo's
 * own database, so two linked repos could hold contradictory active knowledge and nothing
 * noticed.
 *
 * Bounded and never fatal: a handful of candidates per peer, an unreadable peer skipped rather
 * than raised, and any failure degrading to "no report" rather than a failed write. Outside a
 * workspace it costs one null check.
 */
export async function findCrossRepoOverlap(input: {
  workspace: ActiveWorkspace | null;
  item: OverlapSubject;
}): Promise<CrossRepoOverlap[]> {
  const workspace = input.workspace;
  if (!workspace || workspace.peers.length === 0) return [];

  const query = [
    input.item.title,
    input.item.content,
    input.item.reasoning ?? '',
    ...(input.item.tags ?? []),
  ].join(' ');

  const found: CrossRepoOverlap[] = [];

  for (const peer of workspace.peers) {
    if (!peer.present) continue;
    try {
      const store = await openPeerStore(peer.databasePath);

      // An exclusive key held by another repo is a genuine contradiction, not a near miss.
      // `visibility` goes into the query rather than being checked on the way out: a peer's
      // private row must not be read into this process at all.
      const conflicts = await checkKnowledgeConflict({ ...input.item, visibility: 'workspace' }, store);
      for (const conflict of conflicts) {
        found.push({ repo: peer.name, id: conflict.id, title: conflict.title, kind: 'conflict' });
      }

      // The same ranker the local duplicate check uses, pointed at the peer.
      const candidates = await rankKnowledge('local', {
        query,
        status: 'active',
        visibility: 'workspace',
        limit: PEER_CANDIDATES,
      }, store);

      for (const candidate of candidates) {
        if (found.some(entry => entry.id === candidate.id)) continue;
        // The local matcher, reused rather than restated. A second title comparison here
        // would be the duplication this whole change removes, and the two would drift the
        // moment either is tuned.
        if (!sameSubjectTitle(input.item, candidate)) continue;
        found.push({ repo: peer.name, id: candidate.id, title: candidate.title, kind: 'duplicate' });
      }
    } catch {
      // A peer that cannot be read must never fail the write it was consulted for.
    }
  }

  return found;
}
