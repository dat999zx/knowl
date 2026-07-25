export type DivergencePolicy = 'newer' | 'skip' | 'theirs' | 'fail';

export const DIVERGENCE_POLICIES: readonly DivergencePolicy[] = ['newer', 'skip', 'theirs', 'fail'];

/**
 * The dominant case is one person's two machines, where trust is total and divergence
 * means "I edited this in both places". Silently keeping the older copy is the surprising
 * outcome, and every loser is reported either way.
 */
export const DEFAULT_DIVERGENCE_POLICY: DivergencePolicy = 'newer';

export type ImportCandidate = { id: string; contentHash?: string | null; updatedAt: string; version: number };
export type LocalItemRow = { id: string; contentHash: string | null; updatedAt: string; version: number };

export function classifyIncomingItem(
  incoming: ImportCandidate,
  local: LocalItemRow | undefined,
): 'new' | 'identical' | 'divergent' {
  if (!local) return 'new';
  return String(incoming.contentHash ?? '') === String(local.contentHash ?? '') ? 'identical' : 'divergent';
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
