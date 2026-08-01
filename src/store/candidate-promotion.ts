import { MemoryCandidate } from '../core/types.js';
import { getClient } from './database.js';
import { storeKnowledgeAtomsDeduped } from './knowledge-writer.js';

// Promote up to this many candidates per session, ranked by importance rather than
// arbitrary insertion order. Higher than the old hard cap of 5 so a busy session
// with several real decisions is not silently truncated.
export const MAX_PROMOTED_CANDIDATES = 8;

export function candidateImportance(candidate: MemoryCandidate): number {
  // Weights follow the measured value of each source: a resolved failure is the
  // most valuable single thing a session yields, and a commit subject is the most
  // common. Both outrank the outcome and verified-command types, which measured
  // at zero.
  const typeWeight = candidate.candidateType === 'decision' ? 1
    : candidate.candidateType === 'error' ? 0.8
    : candidate.candidateType === 'commit' ? 0.75
    : candidate.candidateType === 'outcome' ? 0.6
    : candidate.candidateType === 'verified-command' ? 0.5
    : candidate.candidateType === 'task-state' ? 0.45
    : 0.4;
  return (candidate.confidence ?? 0.5) * 0.6 + typeWeight * 0.4;
}

export function rankCandidatesByImportance(candidates: MemoryCandidate[]): MemoryCandidate[] {
  return [...candidates].sort((a, b) => candidateImportance(b) - candidateImportance(a));
}

export async function promoteSessionCandidates(projectId: string, sessionId: string, candidates: MemoryCandidate[]): Promise<{ itemIds: string[]; status: 'promoted' | 'skipped' }> {
  const client = getClient();
  const session = (await client.execute({ sql: 'SELECT title, promotion_status, promotion_items FROM memory_sessions WHERE id = ?', args: [sessionId] })).rows[0];
  if (!session) throw new Error(`Memory session not found: ${sessionId}`);
  if (session.promotion_status === 'promoted') return { itemIds: JSON.parse(String(session.promotion_items || '[]')), status: 'promoted' };
  if (candidates.length === 0) { await client.execute({ sql: "UPDATE memory_sessions SET promotion_status = 'skipped', finalized_at = ? WHERE id = ?", args: [new Date().toISOString(), sessionId] }); return { itemIds: [], status: 'skipped' }; }
  const result = await storeKnowledgeAtomsDeduped(projectId, rankCandidatesByImportance(candidates).slice(0, MAX_PROMOTED_CANDIDATES), `Finalize memory session: ${String(session.title)}`);
  await client.execute({ sql: "UPDATE memory_sessions SET promotion_status = 'promoted', promotion_items = ?, finalized_at = ? WHERE id = ?", args: [JSON.stringify(result.itemIds), new Date().toISOString(), sessionId] });
  return { itemIds: result.itemIds, status: 'promoted' };
}
