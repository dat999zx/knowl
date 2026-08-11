import type { KnowledgeItem } from '../core/types.js';
import { listWorkspaceVisibleSkillItems } from '../store/repository.js';
import { openPeerStore } from '../store/store-handle.js';
import type { ActiveWorkspace } from './resolve.js';

/** A linked repo's shared skill, carrying the repo that owns it. */
export type PeerSkillItem = { repo: string; item: KnowledgeItem };

/**
 * Per peer, not overall.
 *
 * The card's character budget already decides how many rows survive; this cap decides whose.
 * Without it a single repo sharing forty skills would fill every peer slot before the second
 * repo was read, and "what else is in this workspace" is exactly the question the section
 * exists to answer.
 */
const MAX_PER_PEER = 3;

/**
 * Every linked repo's workspace-visible skills, most recently updated first.
 *
 * This is the ambient half of workspace reach. `queryFederated` already lets an agent *find* a
 * sibling repo's skill, but only if it knows to ask -- and an agent that does not know a
 * pipeline exists is precisely the one that will not ask. The knowledge most worth sharing
 * across a workspace is reusable tooling, which is the kind nobody queries for by name.
 *
 * **Never fatal.** A peer that is absent, unreadable, or holds a schema this build does not
 * understand contributes nothing and is skipped in silence. This runs inside session-start
 * bootstrap, where the cost of throwing is the whole context card -- and the section is an
 * enrichment, so degrading to today's local-only behaviour is always the right failure.
 */
export async function listPeerSkillItems(workspace: ActiveWorkspace): Promise<PeerSkillItem[]> {
  const found: PeerSkillItem[] = [];

  for (const peer of workspace.peers) {
    if (!peer.present) continue;
    try {
      const store = await openPeerStore(peer.databasePath);
      const items = await listWorkspaceVisibleSkillItems(store.db);
      // The query has no ORDER BY, so the cap needs one of its own or which three survive is
      // whatever order the index happened to return. Recency is the same tie-break the rest of
      // the card uses.
      const ordered = [...items].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
      for (const item of ordered.slice(0, MAX_PER_PEER)) found.push({ repo: peer.name, item });
    } catch {
      continue;
    }
  }

  return found;
}
