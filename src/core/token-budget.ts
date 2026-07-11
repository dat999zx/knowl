import { KnowledgeCategory, KnowledgeFreshness, KnowledgeItem } from './types.js';

export const DEFAULT_CONTEXT_MAX_CHARS = 3_000;
export const DEFAULT_CONTEXT_TOKEN_BUDGET = 1_200;
export const DEFAULT_RESULT_LIMIT = 3;
export const MAX_ITEM_CONTENT_CHARS = 600;
export const MAX_TAGS = 4;
export const MAX_TAG_CHARS = 48;
export const MAX_EVIDENCE_ITEMS = 5;

export type CompactKnowledgeItem = Pick<KnowledgeItem, 'id' | 'category' | 'title' | 'content' | 'freshness' | 'confidence'> & {
  tags?: string[];
};

export function truncateText(value: string, maxChars: number, marker = ''): string {
  if (value.length <= maxChars) return value;
  if (maxChars <= marker.length) return marker.slice(0, maxChars);
  return `${value.slice(0, maxChars - marker.length)}${marker}`;
}

export function estimateTokens(value: string): number {
  return Math.ceil(value.length / 4);
}

export function compactKnowledgeItem(item: KnowledgeItem): CompactKnowledgeItem {
  const tags = item.tags?.slice(0, MAX_TAGS).map(tag => truncateText(tag, MAX_TAG_CHARS));
  return {
    id: item.id,
    category: item.category as KnowledgeCategory,
    title: truncateText(item.title, MAX_ITEM_CONTENT_CHARS),
    content: truncateText(item.content, MAX_ITEM_CONTENT_CHARS),
    freshness: item.freshness as KnowledgeFreshness,
    confidence: item.confidence,
    ...(tags?.length ? { tags } : {}),
  };
}
