import { hashKnowledgeLifecycle } from './freshness.js';

export type DivergencePolicy = 'newer' | 'skip' | 'theirs' | 'fail';

export const DIVERGENCE_POLICIES: readonly DivergencePolicy[] = ['newer', 'skip', 'theirs', 'fail'];

/**
 * The dominant case is one person's two machines, where trust is total and divergence
 * means "I edited this in both places". Silently keeping the older copy is the surprising
 * outcome, and every loser is reported either way.
 */
export const DEFAULT_DIVERGENCE_POLICY: DivergencePolicy = 'newer';

/** The fields `lifecycle_hash` fingerprints, carried on every exported item since v1. */
export type LifecycleFields = {
  status?: string | null;
  freshness?: string | null;
  supersededById?: string | null;
  originRepo?: string | null;
  visibility?: string | null;
};

export type ImportCandidate = LifecycleFields & { id: string; contentHash?: string | null; lifecycleHash?: string | null; updatedAt: string; version: number };
export type LocalItemRow = LifecycleFields & { id: string; contentHash: string | null; lifecycleHash?: string | null; updatedAt: string; version: number };

/**
 * The stored hash when there is one, otherwise computed from the fields it covers.
 *
 * Neither side can be relied on to have it. A version-1 export predates the column, and the
 * column is added without a backfill so every row written before it exists holds NULL. But
 * both sides always carry the underlying fields -- export serialises whole item objects -- so
 * the absence of a hash is never an absence of information.
 *
 * Treating a missing hash as agreement was wrong in both directions: a promotion exported by
 * an older build silently never converged, and an un-backfilled local row reported
 * metadata-divergent on the first import even when nothing had changed.
 */
function lifecycleFingerprint(row: LifecycleFields & { lifecycleHash?: string | null }): string {
  return row.lifecycleHash ?? hashKnowledgeLifecycle(row);
}

/**
 * `metadata-divergent` exists because content and lifecycle diverge independently.
 *
 * An item whose visibility, status, freshness, supersession or owner changed has identical
 * content, so classifying on `content_hash` alone called it `identical` and the plan skipped
 * it. Promotion, retirement and supersession therefore could not travel through an export at
 * all -- see `hashKnowledgeLifecycle`.
 */
export function classifyIncomingItem(
  incoming: ImportCandidate,
  local: LocalItemRow | undefined,
): 'new' | 'identical' | 'divergent' | 'metadata-divergent' {
  if (!local) return 'new';
  if (String(incoming.contentHash ?? '') !== String(local.contentHash ?? '')) return 'divergent';
  return lifecycleFingerprint(incoming) === lifecycleFingerprint(local) ? 'identical' : 'metadata-divergent';
}

export function resolveDivergence(
  policy: DivergencePolicy,
  incoming: ImportCandidate,
  local: LocalItemRow,
): 'incoming' | 'local' {
  if (policy === 'theirs') return 'incoming';
  if (policy === 'skip' || policy === 'fail') return 'local';

  // `newer`: latest write wins, with `version` breaking an identical timestamp. A true tie
  // keeps local, so an import is never gratuitously destructive.
  if (incoming.updatedAt > local.updatedAt) return 'incoming';
  if (incoming.updatedAt < local.updatedAt) return 'local';
  return incoming.version > local.version ? 'incoming' : 'local';
}
