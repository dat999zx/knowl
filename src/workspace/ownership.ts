import { getKnowledgeItem } from '../store/repository.js';
import { PeerDatabaseMissingError } from '../store/connection-pool.js';
import { openPeerStore } from '../store/store-handle.js';
import { isImportedOrigin } from '../store/portability.js';
import type { KnowledgeItem } from '../core/types.js';
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
  /**
   * The row that peer holds, read on the same probe that established ownership.
   *
   * A second lookup for the same id would be a second walk over the same peers, which is the
   * divergence `store-handle.ts` records: `federated-query.ts` re-implemented selection for want
   * of a way to point the existing code at another store, and the two drifted.
   */
  item: KnowledgeItem | null;
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
      // The whole row, through the same mapper the local path uses, rather than `SELECT 1`.
      // The probe answered the ownership question and nothing else, so a caller that also
      // wanted the record had to walk every peer a second time. Reading it here costs one
      // indexed primary-key lookup instead of an existence check on the same index.
      //
      // A row this build cannot map throws, and is caught below as a gap rather than as a hit.
      // That is the honest verdict for "written by a newer Knowl", which the catch already
      // names -- and it is safer than reporting ownership for a record we could not read.
      const store = await openPeerStore(peer.databasePath);
      const item = await getKnowledgeItem(itemId, store.db);
      if (item) return { owner: peer.name, item, unverified };
    } catch (error) {
      // A repo with no knowledge database holds no items. That is an answer, not a gap --
      // and it is the ordinary state of a member repo that has been cloned but not used.
      if (error instanceof PeerDatabaseMissingError) continue;
      // Anything else -- corrupt, locked, written by a newer Knowl -- is a gap.
      unverified.push(peer.name);
    }
  }
  return { owner: null, item: null, unverified };
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

/**
 * The whole row for an id a linked repo owns, for reading only.
 *
 * The refusal this serves was a *not-found*, not a guard: `getKnowledgeItem` reads the local
 * store, so a sibling's id was simply absent, and the message explained that absence in
 * ownership terms. Withholding the record was never the protection. The protection is that
 * `affectedPaths` and evidence staleness resolve against the OWNING repo's checkout, and the
 * caller drops those rather than answering them from the wrong working tree.
 *
 * `assertOwnedItem` is deliberately untouched. This widens what may be read; nothing here
 * widens what may be written, and a foreign write is refused exactly as it was before.
 *
 * **Shared rows only.** `federated-query.ts` reads a peer with `visibility = 'workspace'` in
 * the SQL, so a repo-private row is never loaded into that process at all. Fetching by id has
 * to reach the same rows and no others, or knowing an id becomes a way around the rule that
 * `knowl workspace promote` exists to apply -- and the id of an unshared atom is not secret:
 * it travels in supersession chains, conflict reports and anything the peer published later.
 * The filter is here rather than in `ownerFromPeers` on purpose: the write guard must keep
 * seeing private rows, since a foreign item is still foreign and must still be refused.
 *
 * Null covers four situations on purpose -- no workspace, no peer holds it, every peer that
 * might hold it is unreadable, and the peer holds it privately. The caller's own not-found path
 * already words all of them correctly, and collapsing them here would let an unreadable peer
 * report as one that said no, which is the mistake `UnverifiedOwnerError` exists to prevent on
 * the write side. A private row reports as a miss for a second reason: "that one is private"
 * would confirm the row exists, which the caller was no more entitled to know than the body.
 */
export async function findForeignItem(
  itemId: string,
  workspace: ActiveWorkspace | null,
): Promise<{ repo: string; item: KnowledgeItem } | null> {
  if (!workspace) return null;
  const { owner, item } = await ownerFromPeers(itemId, workspace);
  if (!owner || !item) return null;
  // Strict equality, matching the search path's predicate exactly. The column is NOT NULL
  // DEFAULT 'repo', so there is no third state to decide about: anything not positively shared
  // is private.
  if (item.visibility !== 'workspace') return null;
  return { repo: owner, item };
}
