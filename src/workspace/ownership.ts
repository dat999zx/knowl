import { getKnowledgeItem } from '../store/repository.js';
import { acquireClient } from '../store/connection-pool.js';
import type { ActiveWorkspace } from './resolve.js';

export class ForeignItemError extends Error {
  constructor(itemId: string, repo: string) {
    super(`Item ${itemId} belongs to repo "${repo}" and was not changed. Run this from that repo.`);
    this.name = 'ForeignItemError';
  }
}

async function ownerFromPeers(itemId: string, workspace: ActiveWorkspace): Promise<string | null> {
  for (const peer of workspace.peers) {
    if (!peer.present) continue;
    try {
      const client = await acquireClient(peer.databasePath, { readOnly: true });
      const rows = await client.execute({ sql: 'SELECT 1 FROM knowledge_items WHERE id = ? LIMIT 1', args: [itemId] });
      if (rows.rows.length > 0) return peer.name;
    } catch {
      // An unreadable peer cannot claim the item; keep looking.
    }
  }
  return null;
}

/**
 * Refuse an item-scoped operation on an item this repo does not own.
 *
 * These tools take a bare id and resolve it against the current database. Federated results
 * now carry a repo label, so an agent can ask about an item that is not here -- and
 * answering from the wrong database, or computing staleness against the wrong filesystem, is
 * a confident wrong answer rather than a missing one.
 *
 * A null origin means the item predates workspace ownership and is local by definition.
 */
export async function assertOwnedItem(itemId: string, workspace: ActiveWorkspace | null): Promise<void> {
  if (!workspace) return; // no workspace: every id is local
  const local = await getKnowledgeItem(itemId);
  if (local && (local.originRepo == null || local.originRepo === workspace.repo)) return;

  const owner = local?.originRepo ?? await ownerFromPeers(itemId, workspace);
  // An id that exists nowhere is left to the handler's own not-found path; only a positively
  // foreign item is refused here.
  if (!local && !owner) return;
  throw new ForeignItemError(itemId, owner ?? 'another linked repo');
}
