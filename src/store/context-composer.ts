import { KnowledgeItem } from '../core/types.js';
import { queryKnowledgeForAgent } from './agent-query.js';
import { queryKnowledgeBase } from './queries.js';
import { queryLayeredKnowledge } from './namespaces.js';
import { estimateTokens } from '../core/token-budget.js';
import { truncateText } from '../core/token-budget.js';

export type ContextKnowledgeItem = Pick<KnowledgeItem, 'category' | 'title' | 'content'> & { namespace?: string };
export type ContextRequest = { query?: string; task?: string; changedFiles?: string[]; tokenBudget: number; includeEvidence?: boolean; namespaceRoot?: string };
export type ContextPack = { sections: Array<{ name: string; items: ContextKnowledgeItem[]; estimatedTokens: number }>; excluded: Array<{ itemId: string; reason: 'duplicate' | 'budget' | 'stale' | 'lower-rank' }>; estimatedTokens: number };
const compact = (item: KnowledgeItem & { namespace?: string }): ContextKnowledgeItem => ({ category: item.category, title: item.title, content: item.content, ...(item.namespace ? { namespace: item.namespace } : {}) });
const tokens = (item: KnowledgeItem & { namespace?: string }) => estimateTokens(JSON.stringify(compact(item)));

export async function composeContext(projectId: string, request: ContextRequest): Promise<ContextPack> {
  if (!Number.isFinite(request.tokenBudget) || request.tokenBudget < 1) throw new Error('tokenBudget must be positive.');
  const candidates: ContextKnowledgeItem[] = request.namespaceRoot
    ? await queryLayeredKnowledge(request.namespaceRoot, request.query ?? request.task ?? '', undefined, 30, 'context_composer')
    : await queryKnowledgeForAgent(projectId, { query: request.query ?? request.task, limit: 30, surface: 'context_composer' });
  const pinned = await queryKnowledgeBase(projectId, { category: 'constraint', status: 'active' });
  const rest = candidates.filter(item => item.category !== 'constraint' && !pinned.some(constraint => constraint.id === item.id));
  const selected: Array<KnowledgeItem & { namespace?: string }> = []; const excluded: ContextPack['excluded'] = [];
  let used = 0;
  for (const original of [...pinned, ...rest]) {
    let item = original;
    let cost = tokens(item);
    if (selected.length === 0 && item.category === 'constraint' && cost > request.tokenBudget) {
      const overflowChars = (cost - request.tokenBudget) * 4;
      item = { ...item, content: truncateText(item.content, Math.max(0, item.content.length - overflowChars), '…') };
      cost = tokens(item);
    }
    if (used + cost <= request.tokenBudget) { selected.push(item); used += cost; }
    else excluded.push({ itemId: item.id, reason: 'budget' });
  }
  const constraints = selected.filter(item => item.category === 'constraint').map(compact);
  const relevant = selected.filter(item => item.category !== 'constraint').map(compact);
  const compactTokens = (items: ContextKnowledgeItem[]) => items.reduce((sum, item) => sum + estimateTokens(JSON.stringify(item)), 0);
  return { sections: [{ name: 'Pinned constraints', items: constraints, estimatedTokens: compactTokens(constraints) }, { name: 'Relevant knowledge', items: relevant, estimatedTokens: compactTokens(relevant) }], excluded, estimatedTokens: used };
}
