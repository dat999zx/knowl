import { MemoryCandidate } from '../core/types.js';
import { getClient } from './database.js';
import { storeKnowledgeAtomsDeduped } from './knowledge-writer.js';

export async function promoteSessionCandidates(projectId: string, sessionId: string, candidates: MemoryCandidate[]): Promise<{ itemIds: string[]; status: 'promoted' | 'skipped' }> {
  const client = getClient();
  const session = (await client.execute({ sql: 'SELECT title, promotion_status, promotion_items FROM memory_sessions WHERE id = ?', args: [sessionId] })).rows[0];
  if (!session) throw new Error(`Memory session not found: ${sessionId}`);
  if (session.promotion_status === 'promoted') return { itemIds: JSON.parse(String(session.promotion_items || '[]')), status: 'promoted' };
  if (candidates.length === 0) { await client.execute({ sql: "UPDATE memory_sessions SET promotion_status = 'skipped', finalized_at = ? WHERE id = ?", args: [new Date().toISOString(), sessionId] }); return { itemIds: [], status: 'skipped' }; }
  const result = await storeKnowledgeAtomsDeduped(projectId, candidates.slice(0, 5), `Finalize memory session: ${String(session.title)}`);
  await client.execute({ sql: "UPDATE memory_sessions SET promotion_status = 'promoted', promotion_items = ?, finalized_at = ? WHERE id = ?", args: [JSON.stringify(result.itemIds), new Date().toISOString(), sessionId] });
  return { itemIds: result.itemIds, status: 'promoted' };
}
