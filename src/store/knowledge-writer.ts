import { CommitChange, KnowledgeCategory, KnowledgeItem } from '../core/types.js';
import { searchKnowledgeItems } from './search.js';
import * as repo from './repository.js';

const DUPLICATE_STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'do', 'does', 'for', 'from', 'in', 'is',
  'it', 'of', 'on', 'or', 'our', 'the', 'this', 'to', 'use', 'uses', 'using', 'what', 'with',
]);

export interface StoreKnowledgeInput {
  category: KnowledgeCategory;
  title: string;
  content: string;
  reasoning?: string | null;
  alternatives?: string[] | null;
  tags?: string[] | null;
  source?: string | null;
  confidence?: number;
  steps?: string[];
}

export interface StoreKnowledgeResult {
  action: 'inserted' | 'duplicate';
  item: KnowledgeItem;
}

export interface StoreKnowledgeBatchResult {
  itemIds: string[];
  insertedCount: number;
  duplicateCount: number;
}

function duplicateTokens(value: string): Set<string> {
  return new Set(
    value
      .toLowerCase()
      .split(/[^a-z0-9_]+/)
      .map(token => token.trim())
      .filter(token => token.length >= 2 && !DUPLICATE_STOP_WORDS.has(token))
  );
}

function tokenOverlapScore(a: string, b: string): number {
  const left = duplicateTokens(a);
  const right = duplicateTokens(b);
  if (left.size === 0 || right.size === 0) return 0;

  let intersection = 0;
  for (const token of left) {
    if (right.has(token)) intersection++;
  }

  return intersection / Math.min(left.size, right.size);
}

function searchableText(item: {
  title: string;
  content: string;
  reasoning?: string | null;
  tags?: string[] | null;
}): string {
  return `${item.title}\n${item.content}\n${item.reasoning || ''}\n${(item.tags || []).join(' ')}`;
}

export async function findLikelyDuplicateKnowledgeItem(
  projectId: string,
  item: {
    category: KnowledgeCategory;
    title: string;
    content: string;
    reasoning?: string | null;
    tags?: string[] | null;
  }
): Promise<KnowledgeItem | null> {
  const query = [
    item.title,
    item.content,
    item.reasoning || '',
    ...(item.tags || []),
  ].join(' ');

  const candidates = await searchKnowledgeItems(projectId, {
    query,
    category: item.category,
    status: 'active',
    limit: 3,
  });

  const incomingText = searchableText(item);
  return candidates.find(candidate =>
    tokenOverlapScore(incomingText, searchableText(candidate)) >= 0.35
  ) || null;
}

export async function storeKnowledgeItemDeduped(
  projectId: string,
  input: StoreKnowledgeInput,
  commitMessage?: string
): Promise<StoreKnowledgeResult> {
  const duplicate = await findLikelyDuplicateKnowledgeItem(projectId, input);
  if (duplicate) {
    return { action: 'duplicate', item: duplicate };
  }

  const item = await repo.createKnowledgeItem(
    projectId,
    {
      category: input.category,
      title: input.title,
      content: input.content,
      reasoning: input.reasoning,
      alternatives: input.alternatives,
      tags: input.tags,
      source: input.source,
      confidence: input.confidence,
    },
    input.steps
  );

  await repo.createKnowledgeCommit(projectId, commitMessage || `Store ${input.category}: ${input.title}`, [
    { itemId: item.id, action: 'insert', after: item },
  ]);

  return { action: 'inserted', item };
}

export async function storeKnowledgeAtomsDeduped(
  projectId: string,
  atoms: StoreKnowledgeInput[],
  commitMessage?: string
): Promise<StoreKnowledgeBatchResult> {
  const changes: CommitChange[] = [];
  const itemIds: string[] = [];
  let duplicateCount = 0;

  for (const atom of atoms) {
    const duplicate = await findLikelyDuplicateKnowledgeItem(projectId, {
      category: atom.category,
      title: atom.title,
      content: atom.content,
      reasoning: atom.reasoning,
      tags: atom.tags,
    });

    if (duplicate) {
      itemIds.push(duplicate.id);
      duplicateCount++;
      continue;
    }

    const item = await repo.createKnowledgeItem(
      projectId,
      {
        category: atom.category,
        title: atom.title,
        content: atom.content,
        reasoning: atom.reasoning,
        alternatives: atom.alternatives,
        tags: atom.tags,
        source: atom.source,
        confidence: atom.confidence,
      },
      atom.steps
    );

    itemIds.push(item.id);
    changes.push({ itemId: item.id, action: 'insert', after: item });
  }

  if (changes.length > 0) {
    await repo.createKnowledgeCommit(
      projectId,
      commitMessage || `Store ${atoms.length} structured knowledge atom(s)`,
      changes
    );
  }

  return {
    itemIds,
    insertedCount: changes.length,
    duplicateCount,
  };
}
