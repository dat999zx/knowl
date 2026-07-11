import { getClient } from './database.js';
import { promoteSessionCandidates } from './candidate-promotion.js';
import { extractSessionMemoryCandidates } from './session-candidates.js';

export async function finalizeMemorySession(projectId: string, sessionId: string): Promise<{
  status: 'promoted' | 'skipped'; candidateCount: number; itemIds: string[]; usedAi: boolean;
}> {
  const row = (await getClient().execute({ sql: 'SELECT status FROM memory_sessions WHERE id = ?', args: [sessionId] })).rows[0];
  if (!row) throw new Error(`Memory session not found: ${sessionId}`);
  if (row.status === 'active') throw new Error('Cannot finalize an active memory session.');
  const candidates = await extractSessionMemoryCandidates(sessionId);
  const promoted = await promoteSessionCandidates(projectId, sessionId, candidates);
  return { ...promoted, candidateCount: candidates.length, usedAi: false };
}
