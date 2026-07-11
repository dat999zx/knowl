import { createKnowledgeItem, listKnowledgeItems, updateKnowledgeItem } from './repository.js';
import { createEvidence, linkKnowledgeEvidence, listEvidenceForItem, unlinkKnowledgeEvidence } from './evidence-repository.js';
import type { KnowledgeItem } from '../core/types.js';

const MAX_SOURCES = 8;
const MAX_SOURCE_CONTENT = 500;

function sourceItems(items: KnowledgeItem[], scope: string): KnowledgeItem[] {
  return items
    .filter(item => item.status === 'active' && item.freshness === 'fresh' && item.category !== 'state' && (item.tags ?? []).includes(scope) && !(item.tags ?? []).includes('synthesized'))
    .slice(0, MAX_SOURCES);
}

function synthesizedContent(sources: KnowledgeItem[]): string {
  return sources.map(item => `- ${item.title}: ${item.content.replace(/\s+/g, ' ').trim().slice(0, MAX_SOURCE_CONTENT)}`).join('\n');
}

async function replaceDerivedEvidence(itemId: string, sources: KnowledgeItem[]): Promise<void> {
  for (const evidence of await listEvidenceForItem(itemId)) {
    await unlinkKnowledgeEvidence(itemId, evidence.id);
  }
  for (const source of sources) {
    const evidence = await createEvidence({
      type: 'agent',
      locator: `knowledge://${source.id}`,
      contentHash: source.contentHash ?? null,
      excerpt: source.title,
      observedAt: source.updatedAt,
    });
    await linkKnowledgeEvidence({ knowledgeItemId: itemId, evidenceId: evidence.id, relationship: 'derived_from' });
  }
}

export async function synthesizeKnowledge(projectId: string, scope: string) {
  const items = await listKnowledgeItems(projectId);
  const sources = sourceItems(items, scope);
  if (sources.length < 2) throw new Error('Synthesis requires at least two durable fresh active sources.');

  const content = synthesizedContent(sources);
  const existing = items.find(item => item.status === 'active' && item.category === 'architecture' && item.title === `Synthesized understanding: ${scope}` && (item.tags ?? []).includes('synthesized'));
  const input = {
    category: 'architecture' as const,
    title: `Synthesized understanding: ${scope}`,
    content,
    tags: ['synthesized', scope],
    confidence: Math.min(...sources.map(item => item.confidence)),
    source: `derived from: ${sources.map(item => item.id).join(', ')}`,
  };
  const item = existing
    ? await updateKnowledgeItem(existing.id, input)
    : await createKnowledgeItem(projectId, input);
  await replaceDerivedEvidence(item.id, sources);
  return item;
}
