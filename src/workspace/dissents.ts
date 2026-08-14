import crypto from 'node:crypto';
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
