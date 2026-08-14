import crypto from 'node:crypto';
import type { Client } from '@libsql/client';
import { getClient } from '../store/database.js';
import { getKnowledgeItem } from '../store/repository.js';
import { openPeerStore } from '../store/store-handle.js';
import { isImportedOrigin } from '../store/portability.js';
import { hashKnowledgeContent } from '../store/freshness.js';
import { validateKnowledgeWrite } from '../core/knowledge-validation.js';
import { peerVerdictFor, UnverifiedOwnerError } from './ownership.js';
import type { KnowledgeItem } from '../core/types.js';
import type { ActiveWorkspace } from './resolve.js';

/**
 * A dissent: this repo's recorded disagreement with an atom another repo owns.
 *
 * The rule the rest of the product enforces is that one repo owns an item and only that repo
 * may change it -- `assertOwnedItem`. That rule is right and this does not weaken it. What it
 * adds is the thing a single-owner rule leaves missing: a way for the repo that noticed the
 * error to say so, where the owner will see it, without editing anything it does not own.
 *
 * Two rows in two stores, joined when something is read:
 *
 * - the dissent lives HERE, written by the repo that disagrees
 * - the resolution lives THERE, written by the repo that owns the atom
 *
 * Neither ever writes the other's database. That is what makes this safe to allow at all, and
 * it is why the upstream workspace-v2 plan stalled: it promised cross-owner editing and forbade
 * it in the same document, because the only shape it considered was one repo reaching into
 * another's rows.
 */

export class NotInWorkspaceError extends Error {
  constructor() {
    super(
      'A dissent is addressed to another repo, so there has to be one. This repo is not in a ' +
      'workspace -- link it with `knowl workspace add`, or correct the item directly if it is yours.',
    );
    this.name = 'NotInWorkspaceError';
  }
}

export class OwnItemError extends Error {
  constructor(itemId: string) {
    super(
      `Item ${itemId} is yours to change: supersede or update it directly. A dissent is for an ` +
      'atom another repo owns and you cannot edit.',
    );
    this.name = 'OwnItemError';
  }
}

/**
 * A dissent that could never reach its owner is worse than no dissent at all.
 *
 * The team replica is a local copy of rows other people's machines wrote. Recording a dissent
 * against one would leave it sitting here forever, invisible to the person who could act on it,
 * while reading as though something had been done. That is the failure mode this whole design
 * exists to avoid -- knowledge filed where nobody will look for it -- so it is refused rather
 * than allowed to look like it worked.
 */
export class CloudOwnedItemError extends Error {
  constructor(itemId: string, workspaceName: string) {
    super(
      `Item ${itemId} belongs to team workspace "${workspaceName}", not to a repo on this ` +
      'machine. A dissent is workspace-local and would never reach its owner, so it was not ' +
      'recorded. Team corrections go through the cloud path.',
    );
    this.name = 'CloudOwnedItemError';
  }
}

export class UnknownItemError extends Error {
  constructor(itemId: string) {
    super(
      `No knowledge item "${itemId}" in this repo's store or in any linked repo readable from ` +
      'here. Ids must be given in full -- a truncated one matches nothing.',
    );
    this.name = 'UnknownItemError';
  }
}

export class NoSuchDissentError extends Error {
  constructor(dissentId: string) {
    super(
      `No dissent "${dissentId}" in this repo's store. A dissent is held by the repo that raised ` +
      'it, so withdraw it from there.',
    );
    this.name = 'NoSuchDissentError';
  }
}

export type DissentTarget = { repo: string; item: KnowledgeItem };

function generateId(): string {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 16);
}

/**
 * Whether the cloud replica holds this id.
 *
 * Consulted only after every local peer has said no, because it answers a different question --
 * "is this someone else's, on another machine" -- and the answer changes the refusal rather than
 * the outcome. Failure to read the replica is treated as "not there": it downgrades a precise
 * refusal to a vaguer one, and never turns a refusal into a write.
 */
async function heldByCloudReplica(itemId: string, workspace: ActiveWorkspace): Promise<boolean> {
  const replica = workspace.cloud;
  if (!replica?.present) return false;
  try {
    const store = await openPeerStore(replica.databasePath);
    return (await getKnowledgeItem(itemId, store.db)) !== null;
  } catch {
    return false;
  }
}

/**
 * Who owns the atom being dissented against, or a refusal explaining why nobody can be named.
 *
 * The local lookup comes first and can end two ways. A row here that this repo originated --
 * including a null origin, which predates ownership stamping, and an `import:` origin, which is
 * a copy with no live database behind it -- is ours, and the answer is to edit it. A row here
 * stamped with another repo's origin is a legitimate target: it is held locally but owned
 * elsewhere, exactly the case `assertOne` refuses writes for.
 */
async function resolveTarget(itemId: string, workspace: ActiveWorkspace): Promise<DissentTarget> {
  const local = await getKnowledgeItem(itemId);
  if (local && (local.originRepo == null || isImportedOrigin(local.originRepo) || local.originRepo === workspace.repo)) {
    throw new OwnItemError(itemId);
  }
  if (local?.originRepo) return { repo: local.originRepo, item: local };

  const verdict = await peerVerdictFor(itemId, workspace);
  if (verdict.repo && verdict.item) return { repo: verdict.repo, item: verdict.item };

  if (await heldByCloudReplica(itemId, workspace)) {
    throw new CloudOwnedItemError(itemId, workspace.cloud!.workspaceName);
  }
  // A peer that could not be read was never asked. Reporting the id as unknown would send
  // someone to correct an id that was never wrong.
  if (verdict.unverified.length > 0) throw new UnverifiedOwnerError(itemId, verdict.unverified);
  throw new UnknownItemError(itemId);
}

/**
 * The revision a dissent was raised against.
 *
 * Computed rather than read off `content_hash`, so the pin and every later comparison come from
 * one function over one set of fields. Reading the stored column here and recomputing it there
 * would make a null column, or any drift between the two, present as a permanently stale dissent.
 */
export function revisionPin(item: KnowledgeItem): string {
  return hashKnowledgeContent({
    title: item.title,
    content: item.content,
    reasoning: item.reasoning,
    source: item.source,
    affectedPaths: item.affectedPaths,
  });
}

/**
 * Record this repo's disagreement with an atom another repo owns.
 *
 * Writes one row, into this repo's own store. The owning repo's database is opened read-only to
 * read the revision being disputed and is not written to at any point.
 */
export async function createDissent(
  input: { targetItemId: string; claim: string; replacementItemId?: string; provenance?: string },
  workspace: ActiveWorkspace | null,
): Promise<{ id: string; targetRepo: string }> {
  if (!workspace) throw new NotInWorkspaceError();

  // The caller's own text, checked before anything is looked up: it is the cheapest refusal
  // available and the only one that depends on nothing but the input. Every knowledge write is
  // secret-validated and a claim is knowledge, so it goes through the same gate.
  validateKnowledgeWrite({ content: input.claim });

  const target = await resolveTarget(input.targetItemId, workspace);

  const id = generateId();
  await getClient().execute({
    sql: `INSERT INTO dissents
            (id, target_repo, target_item_id, target_content_hash, claim, replacement_item_id, provenance, created_at, status)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open')`,
    args: [
      id,
      target.repo,
      input.targetItemId,
      revisionPin(target.item),
      input.claim,
      input.replacementItemId ?? null,
      input.provenance ?? null,
      new Date().toISOString(),
    ],
  });
  return { id, targetRepo: target.repo };
}

/**
 * Take back a dissent this repo raised.
 *
 * Status rather than deletion, and `withdrawn_at` beside it, because "we said this and stopped
 * saying it" is a different fact from never having said it -- and the owner may have already
 * read it. Only rows in this store can be withdrawn, which needs no ownership check: a peer's
 * dissent is not in this database to find.
 */
export async function withdrawDissent(dissentId: string): Promise<void> {
  const result = await getClient().execute({
    sql: `UPDATE dissents SET status = 'withdrawn', withdrawn_at = ? WHERE id = ? AND status = 'open'`,
    args: [new Date().toISOString(), dissentId],
  });
  if (Number(result.rowsAffected ?? 0) === 0) throw new NoSuchDissentError(dissentId);
}

export type IncomingDissent = {
  dissentId: string;
  fromRepo: string;
  targetItemId: string;
  targetTitle: string;
  claim: string;
  replacementItemId: string | null;
  createdAt: string;
  /** The atom has been rewritten since the objection was raised. */
  staleAgainstCurrentRevision: boolean;
};

export type OutgoingDissent = {
  id: string;
  targetRepo: string;
  targetItemId: string;
  claim: string;
  status: string;
  createdAt: string;
};

/** Dissent rows a peer holds against atoms this repo owns. Unreadable peers contribute nothing. */
async function openDissentsFromPeers(workspace: ActiveWorkspace): Promise<Array<{ fromRepo: string; row: Record<string, unknown> }>> {
  const found: Array<{ fromRepo: string; row: Record<string, unknown> }> = [];
  for (const peer of workspace.peers) {
    if (!peer.present) continue;
    try {
      const store = await openPeerStore(peer.databasePath);
      const rows = await store.client.execute({
        sql: `SELECT id, target_item_id, target_content_hash, claim, replacement_item_id, created_at
              FROM dissents WHERE target_repo = ? AND status = 'open'`,
        args: [workspace.repo],
      });
      for (const row of rows.rows) found.push({ fromRepo: peer.name, row: row as Record<string, unknown> });
    } catch {
      // A peer written by an older build has no `dissents` table, and one that is corrupt or
      // locked cannot be asked. Neither may fail the caller: this runs on the read path, so an
      // unreadable neighbour must cost a missing annotation and never a failed query.
    }
  }
  return found;
}

/**
 * What the linked repos are disputing about this repo's atoms.
 *
 * Three things drop a dissent out of this list, and each corresponds to one of the ways a
 * dispute genuinely ends:
 *
 * - the dissenter withdrew it (its own row is no longer `open`)
 * - this repo rejected it (a local resolution row)
 * - this repo answered it by rewriting or retiring the atom -- the revision pin no longer
 *   matches, or the item is no longer active
 *
 * Accepting therefore needs no API. Superseding the atom is an ordinary local write, and the
 * dispute clears itself because a retired atom is not scanned.
 */
export async function listIncomingDissents(workspace: ActiveWorkspace | null): Promise<IncomingDissent[]> {
  if (!workspace) return [];
  const candidates = await openDissentsFromPeers(workspace);
  if (candidates.length === 0) return [];

  const resolved = new Set<string>();
  const resolutions = await getClient().execute({ sql: 'SELECT dissent_id FROM dissent_resolutions', args: [] });
  for (const row of resolutions.rows) resolved.add(String(row.dissent_id));

  const incoming: IncomingDissent[] = [];
  for (const { fromRepo, row } of candidates) {
    const dissentId = String(row.id);
    if (resolved.has(dissentId)) continue;
    const target = await getKnowledgeItem(String(row.target_item_id));
    // Not ours, or no longer standing. Either way there is nothing here left to defend.
    if (!target || target.status !== 'active') continue;
    incoming.push({
      dissentId,
      fromRepo,
      targetItemId: target.id,
      targetTitle: target.title,
      claim: String(row.claim),
      replacementItemId: row.replacement_item_id === null ? null : String(row.replacement_item_id),
      createdAt: String(row.created_at),
      staleAgainstCurrentRevision: String(row.target_content_hash) !== revisionPin(target),
    });
  }
  return incoming;
}

/**
 * Reject a dissent raised against one of this repo's atoms.
 *
 * The row is written HERE, keyed by a `dissent_id` that lives in the peer's store. That
 * asymmetry is the design rather than an oversight: the dissenter keeps its record of what it
 * believes, this repo keeps its record of having answered, and neither writes the other's
 * database. The peer's row stays `open` because it still describes that repo's position.
 *
 * There is no matching `accept`: accepting is superseding the atom, which needs no new verb.
 */
export async function rejectDissent(dissentId: string, targetItemId: string, reason?: string): Promise<void> {
  const target = await getKnowledgeItem(targetItemId);
  if (!target) throw new UnknownItemError(targetItemId);
  await getClient().execute({
    sql: `INSERT INTO dissent_resolutions (dissent_id, target_item_id, resolution, reason, resolved_at)
          VALUES (?, ?, 'rejected', ?, ?)
          ON CONFLICT (dissent_id) DO UPDATE SET
            resolution = excluded.resolution, reason = excluded.reason, resolved_at = excluded.resolved_at`,
    args: [dissentId, targetItemId, reason ?? null, new Date().toISOString()],
  });
}

export type Dispute = {
  /** The repo that raised it. */
  by: string;
  claim: string;
  at: string;
  replacementItemId?: string;
};

/** Every store this machine can read in the workspace: this repo's own, then each present peer. */
async function readableStores(workspace: ActiveWorkspace): Promise<Array<{ repo: string; client: Client }>> {
  const stores: Array<{ repo: string; client: Client }> = [{ repo: workspace.repo, client: getClient() }];
  for (const peer of workspace.peers) {
    if (!peer.present) continue;
    try {
      stores.push({ repo: peer.name, client: (await openPeerStore(peer.databasePath)).client });
    } catch {
      // Unreadable is not "has nothing", but on the read path it has to behave like it.
    }
  }
  return stores;
}

/**
 * Attach the disputes standing against each returned atom.
 *
 * **Annotation only.** The order of `items` is preserved exactly and no score is touched. A
 * dispute adds a line to a result; it never demotes one. Demoting on dissent would let a
 * neighbouring repo push another's knowledge down the ranking, which is the blast radius the
 * single-owner rule exists to prevent -- arriving by a quieter route. If disputed atoms should
 * one day rank lower, that is a separate change with its own measurement, and this makes it
 * cheap to try rather than making it happen by accident.
 *
 * **Both halves of a dispute are read, from wherever they live.** The dissent is in the raising
 * repo's store and the resolution in the owning repo's, so a THIRD repo holds neither. Reading
 * only this store would leave every settled dispute looking open to everyone except the two
 * repos involved.
 *
 * Staleness is judged against the owner's current row rather than against the item passed in:
 * callers hand this compact search results whose content is truncated, and hashing that would
 * make every atom read as rewritten.
 */
export async function annotateDisputes<T extends { id: string }>(
  items: T[],
  workspace: ActiveWorkspace | null,
): Promise<Array<T & { disputed?: Dispute[] }>> {
  if (!workspace || items.length === 0) return items;

  const ids = [...new Set(items.map(item => item.id))];
  const placeholders = ids.map(() => '?').join(', ');
  const stores = await readableStores(workspace);

  const open: Array<{ by: string; row: Record<string, unknown> }> = [];
  for (const store of stores) {
    try {
      const rows = await store.client.execute({
        sql: `SELECT id, target_repo, target_item_id, target_content_hash, claim, replacement_item_id, created_at
              FROM dissents WHERE status = 'open' AND target_item_id IN (${placeholders})`,
        args: ids,
      });
      for (const row of rows.rows) open.push({ by: store.repo, row: row as Record<string, unknown> });
    } catch {
      // No `dissents` table: a store written by a build that predates them. Nothing to add.
    }
  }
  if (open.length === 0) return items;

  const resolved = new Set<string>();
  for (const store of stores) {
    try {
      const rows = await store.client.execute({
        sql: `SELECT dissent_id FROM dissent_resolutions WHERE target_item_id IN (${placeholders})`,
        args: ids,
      });
      for (const row of rows.rows) resolved.add(String(row.dissent_id));
    } catch {
      // Same tolerance, and it matters more here: failing to read a resolution would show a
      // dispute that is already settled, so this must not become an error either.
    }
  }

  const current = new Map<string, KnowledgeItem | null>();
  const currentItem = async (itemId: string, ownerRepo: string): Promise<KnowledgeItem | null> => {
    if (current.has(itemId)) return current.get(itemId)!;
    let item: KnowledgeItem | null = null;
    try {
      if (ownerRepo === workspace.repo) {
        item = await getKnowledgeItem(itemId);
      } else {
        const peer = workspace.peers.find(entry => entry.name === ownerRepo && entry.present);
        if (peer) item = await getKnowledgeItem(itemId, (await openPeerStore(peer.databasePath)).db);
      }
    } catch {
      item = null;
    }
    current.set(itemId, item);
    return item;
  };

  const byItem = new Map<string, Dispute[]>();
  for (const { by, row } of open) {
    if (resolved.has(String(row.id))) continue;
    const itemId = String(row.target_item_id);
    const item = await currentItem(itemId, String(row.target_repo));
    // Retired, unreachable, or rewritten since the objection was raised. A dissent is against
    // what the atom SAID, so the owner changing it is an answer, not something to keep flagging.
    if (!item || item.status !== 'active') continue;
    if (String(row.target_content_hash) !== revisionPin(item)) continue;
    const dispute: Dispute = {
      by,
      claim: String(row.claim),
      at: String(row.created_at),
      ...(row.replacement_item_id ? { replacementItemId: String(row.replacement_item_id) } : {}),
    };
    byItem.set(itemId, [...(byItem.get(itemId) ?? []), dispute]);
  }
  if (byItem.size === 0) return items;

  return items.map(item => {
    const disputes = byItem.get(item.id);
    return disputes?.length ? { ...item, disputed: disputes } : item;
  });
}

/**
 * Undo a rejection, putting the dispute back in front of this repo.
 *
 * Deliberately present from the start. A rejection is a judgement made on partial information --
 * that is the normal case, since the other repo is the one that saw the problem -- and an
 * irreversible one would make reconsidering impossible for no gain. `workspace promote` shipped
 * without its inverse and the cost has been paid ever since; there is no reason to repeat the
 * shape in a feature whose entire subject is disagreement being revisable.
 *
 * Safe because the resolution is local and additive: deleting the row restores exactly the state
 * before the rejection, and the peer's dissent was never touched by either operation.
 */
export async function reopenDissent(dissentId: string): Promise<void> {
  const result = await getClient().execute({
    sql: 'DELETE FROM dissent_resolutions WHERE dissent_id = ?',
    args: [dissentId],
  });
  if (Number(result.rowsAffected ?? 0) === 0) throw new NoSuchDissentError(dissentId);
}

/** What this repo has raised against its neighbours. Own store only; no peer is consulted. */
export async function listOutgoingDissents(): Promise<OutgoingDissent[]> {
  const rows = await getClient().execute({
    sql: `SELECT id, target_repo, target_item_id, claim, status, created_at FROM dissents ORDER BY created_at DESC`,
    args: [],
  });
  return rows.rows.map(row => ({
    id: String(row.id),
    targetRepo: String(row.target_repo),
    targetItemId: String(row.target_item_id),
    claim: String(row.claim),
    status: String(row.status),
    createdAt: String(row.created_at),
  }));
}
