import { createKnowledgeItem, listKnowledgeItems } from './repository.js';

export async function synthesizeKnowledge(projectId: string, scope: string) {
  const sources = (await listKnowledgeItems(projectId)).filter(item => item.status === 'active' && item.category !== 'state' && (item.tags ?? []).includes(scope) && !item.tags?.includes('synthesized')).slice(0, 8);
  if (sources.length < 2) throw new Error('Synthesis requires at least two durable active sources.');
  return createKnowledgeItem(projectId, {
    category: 'architecture', title: `Synthesized understanding: ${scope}`,
    content: sources.map(item => `- ${item.title}: ${item.content}`).join('\n'),
    tags: ['synthesized', scope], confidence: Math.min(...sources.map(item => item.confidence)),
    source: `derived from: ${sources.map(item => item.id).join(', ')}`,
  });
}
