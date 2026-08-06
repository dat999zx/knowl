import { Evidence, KnowledgeAssertion, KnowledgeItem } from '../core/types.js';
import { compactKnowledgeItem, CompactKnowledgeItem, CompactProvenance, MAX_EVIDENCE_ITEMS, MAX_PREVIEW_CHARS, truncateText } from '../core/token-budget.js';

export const DEFAULT_EVIDENCE_LIMIT = MAX_EVIDENCE_ITEMS;
export function compactMcpJson(value: unknown): string { return JSON.stringify(value); }
export function compactItemResponse(item: KnowledgeItem, provenance?: CompactProvenance): CompactKnowledgeItem { return compactKnowledgeItem(item, provenance); }
export function compactAssertionResponse(assertion: KnowledgeAssertion): Record<string, unknown> {
  return {
    id: assertion.id,
    knowledgeItemId: assertion.knowledgeItemId,
    content: truncateText(assertion.content, MAX_PREVIEW_CHARS),
    validFrom: assertion.validFrom,
    ...(assertion.validTo ? { validTo: assertion.validTo } : {}),
    recordedAt: assertion.recordedAt,
    confidence: assertion.confidence,
  };
}
export function boundedEvidence(items: Evidence[], limit = DEFAULT_EVIDENCE_LIMIT): Array<Record<string, unknown>> {
  return items.slice(0, limit).map(item => {
    const extended = item as Evidence & { relationship?: string; stale?: boolean };
    return {
      id: item.id,
      type: item.type,
      locator: item.locator,
      ...(item.excerpt ? { excerpt: truncateText(item.excerpt, MAX_PREVIEW_CHARS) } : {}),
      observedAt: item.observedAt,
      ...(extended.relationship ? { relationship: extended.relationship } : {}),
      ...(typeof extended.stale === 'boolean' ? { stale: extended.stale } : {}),
    };
  });
}
