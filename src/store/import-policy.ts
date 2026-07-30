export type DivergencePolicy = 'newer' | 'skip' | 'theirs' | 'fail';

export const DIVERGENCE_POLICIES: readonly DivergencePolicy[] = ['newer', 'skip', 'theirs', 'fail'];

/**
 * The dominant case is one person's two machines, where trust is total and divergence
 * means "I edited this in both places". Silently keeping the older copy is the surprising
 * outcome, and every loser is reported either way.
 */
export const DEFAULT_DIVERGENCE_POLICY: DivergencePolicy = 'newer';

export type ImportCandidate = { id: string; contentHash?: string | null; lifecycleHash?: string | null; updatedAt: string; version: number };
export type LocalItemRow = { id: string; contentHash: string | null; lifecycleHash?: string | null; updatedAt: string; version: number };

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
  // A version-1 export carries no lifecycle hash. Treat its absence as agreement rather than
  // as a difference, or every legacy file would import as metadata-divergent.
  if (incoming.lifecycleHash == null) return 'identical';
  return String(incoming.lifecycleHash) === String(local.lifecycleHash ?? '') ? 'identical' : 'metadata-divergent';
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
