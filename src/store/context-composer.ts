import { KnowledgeItem } from '../core/types.js';
import { queryKnowledgeForAgent } from './agent-query.js';
import { queryKnowledgeBase } from './queries.js';
import { queryLayeredKnowledge } from './namespaces.js';

export type ContextKnowledgeItem = KnowledgeItem & { namespace?: string };
export type ContextRequest = { query?: string; task?: string; changedFiles?: string[]; tokenBudget: number; includeEvidence?: boolean; namespaceRoot?: string };
export type ContextPack = { sections: Array<{ name: string; items: ContextKnowledgeItem[]; estimatedTokens: number }>; excluded: Array<{ itemId: string; reason: 'duplicate' | 'budget' | 'stale' | 'lower-rank' }>; estimatedTokens: number };
const tokens = (item: KnowledgeItem) => Math.ceil(`${item.title}\n${item.content}`.length / 4);

export async function composeContext(projectId: string, request: ContextRequest): Promise<ContextPack> {
  if (!Number.isFinite(request.tokenBudget) || request.tokenBudget < 1) throw new Error('tokenBudget must be positive.');
  const candidates: ContextKnowledgeItem[] = request.namespaceRoot
    ? await queryLayeredKnowledge(request.namespaceRoot, request.query ?? request.task ?? '', undefined, 30, 'context_composer')
    : await queryKnowledgeForAgent(projectId, { query: request.query ?? request.task, limit: 30, surface: 'context_composer' });
  const pinned = await queryKnowledgeBase(projectId, { category: 'constraint', status: 'active' });
  const rest = candidates.filter(item => item.category !== 'constraint' && !pinned.some(constraint => constraint.id === item.id));
  const selected: ContextKnowledgeItem[] = []; const excluded: ContextPack['excluded'] = [];
  let used = 0;
  for (const item of [...pinned, ...rest]) {
    const cost = tokens(item);
    if (used + cost <= request.tokenBudget || (selected.length === 0 && item.category === 'constraint')) { selected.push(item); used += cost; }
    else excluded.push({ itemId: item.id, reason: 'budget' });
  }
  const constraints = selected.filter(item => item.category === 'constraint');
  const relevant = selected.filter(item => item.category !== 'constraint');
  return { sections: [{ name: 'Pinned constraints', items: constraints, estimatedTokens: constraints.reduce((sum, item) => sum + tokens(item), 0) }, { name: 'Relevant knowledge', items: relevant, estimatedTokens: relevant.reduce((sum, item) => sum + tokens(item), 0) }], excluded, estimatedTokens: used };
}
