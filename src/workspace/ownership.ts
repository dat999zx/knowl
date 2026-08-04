import { getKnowledgeItem } from '../store/repository.js';
import { acquireClient, PeerDatabaseMissingError } from '../store/connection-pool.js';
import { isImportedOrigin } from '../store/portability.js';
import type { ActiveWorkspace } from './resolve.js';

export class ForeignItemError extends Error {
  constructor(itemId: string, repo: string) {
    super(`Item ${itemId} belongs to repo "${repo}" and was not changed. Run this from that repo.`);
    this.name = 'ForeignItemError';
  }
}

/**
 * Refuse an operation whose ownership could not be established, rather than assume it is local.
 *
 * The guard used to answer "not foreign" when what it meant was "I could not look". Partial
 * checkout is a supported state -- two of five repos on a laptop is the documented case -- so
 * on such a machine the guard was simply off for every repo that was not there.
 */
export class UnverifiedOwnerError extends Error {
  constructor(itemId: string, repos: string[]) {
    super(
      `Item ${itemId} is not in this repo, and linked repo${repos.length === 1 ? '' : 's'} ` +
      `${repos.map(repo => `"${repo}"`).join(', ')} could not be read here, so it cannot be shown ` +
      'to be yours to change. Check the id, or run this from the repo that owns it.',
    );
    this.name = 'UnverifiedOwnerError';
  }
}

type PeerVerdict = {
  /** The peer that holds the item, when one positively does. */
  owner: string | null;
  /** Peers that could not answer at all. Empty means every peer was asked and said no. */
  unverified: string[];
};

async function ownerFromPeers(itemId: string, workspace: ActiveWorkspace): Promise<PeerVerdict> {
  const unverified: string[] = [];
  // Members with no path at all never become peers: `resolveWorkspace` drops them before it
  // even computes `present`. They are the extreme case of not checked out here -- listed in a
  // manifest copied off another machine and never cloned -- and on such a machine they are
  // precisely the repos likeliest to own an id this one has never seen. Read from the
  // manifest rather than by widening `peers`, whose consumers all assume a usable root.
  for (const entry of workspace.manifest.repos) {
    if (entry.name === workspace.repo || entry.path) continue;
    unverified.push(entry.name);
  }
  for (const peer of workspace.peers) {
    // Not checked out here. Nothing on this machine can say whether it holds the item, and
    // that is precisely the peer most likely to own an id this repo has never seen.
    if (!peer.present) {
      unverified.push(peer.name);
      continue;
    }
    try {
      const client = await acquireClient(peer.databasePath, { readOnly: true });
      const rows = await client.execute({ sql: 'SELECT 1 FROM knowledge_items WHERE id = ? LIMIT 1', args: [itemId] });
      if (rows.rows.length > 0) return { owner: peer.name, unverified };
    } catch (error) {
      // A repo with no knowledge database holds no items. That is an answer, not a gap --
      // and it is the ordinary state of a member repo that has been cloned but not used.
      if (error instanceof PeerDatabaseMissingError) continue;
      // Anything else -- corrupt, locked, written by a newer Knowl -- is a gap.
      unverified.push(peer.name);
    }
  }
  return { owner: null, unverified };
}

async function assertOne(itemId: string, workspace: ActiveWorkspace): Promise<void> {
  const local = await getKnowledgeItem(itemId);
  // A null origin means the item predates workspace ownership and is local by definition.
  //
  // An imported origin is local for this purpose too, and deliberately so. This guard exists
  // to stop an operation reaching into another repo's live database -- that is what makes a
  // wrong answer confident rather than missing. An imported row has no such database behind
  // it: it is a copy sitting here, and editing it changes nothing anywhere else, exactly as
  // editing a null-origin row always did. The stamp's job is to keep `join` from claiming it
  // and `promote` from publishing it, and neither of those comes through here.
  if (local && (local.originRepo == null || isImportedOrigin(local.originRepo) || local.originRepo === workspace.repo)) return;
  // Held here, owned elsewhere: no peer needs consulting, and none may be reachable anyway.
  if (local?.originRepo) throw new ForeignItemError(itemId, local.originRepo);

  const { owner, unverified } = await ownerFromPeers(itemId, workspace);
  if (owner) throw new ForeignItemError(itemId, owner);
  // Every peer was asked and none holds it: the id exists nowhere, and the handler's own
  // not-found path is the more accurate error. Only silence that is *complete* earns this.
  if (unverified.length === 0) return;
  throw new UnverifiedOwnerError(itemId, unverified);
}

/**
 * Refuse an item-scoped operation on an item this repo does not own.
 *
 * These tools take bare ids and resolve them against the current database. Federated results
 * carry a repo label, so an agent can ask about an item that is not here -- and answering from
 * the wrong database, or computing staleness against the wrong filesystem, is a confident
 * wrong answer rather than a missing one.
 *
 * Takes **every** id the operation will touch, not just the one it is named after.
 * `knowl_update` checked `id` and then retired `supersedeId` unchecked, and `supersedes` has
 * the same gap in `knowl_store`, `knowl_ingest_atoms` and `knowl_decide`: half a guard on a
 * two-item write. Null and empty entries are dropped, so an optional second id costs the
 * caller nothing and cannot be left out for being absent.
 */
export async function assertOwnedItem(
  itemIds: string | ReadonlyArray<string | null | undefined>,
  workspace: ActiveWorkspace | null,
): Promise<void> {
  if (!workspace) return; // no workspace: every id is local
  const ids = (typeof itemIds === 'string' ? [itemIds] : itemIds)
    .filter((id): id is string => typeof id === 'string' && id.length > 0);
  for (const itemId of new Set(ids)) await assertOne(itemId, workspace);
}
