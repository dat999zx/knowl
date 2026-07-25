import { CommitChange, EvidenceInput, KnowledgeCategory, KnowledgeItem, KnowledgeWriteValidationOptions } from '../core/types.js';
import { searchKnowledgeItems } from './search.js';
import * as repo from './repository.js';
import { checkKnowledgeConflict } from './conflicts.js';
import { KnowledgeConflictError } from '../core/errors.js';
import { attachEvidenceToKnowledge } from './evidence-repository.js';
import { indexKnowledgeItemsBestEffort } from './write-embedding.js';

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
  sourceCommit?: string | null;
  affectedPaths?: string[] | null;
  confidence?: number;
  steps?: string[];
  evidence?: EvidenceInput[];
  /** Explicitly mark this active item id superseded by the new write. */
  supersedes?: string;
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

function normalizedIdentity(item: { title: string; content: string }): string {
  return `${item.title}\n${item.content}`.toLowerCase().replace(/\s+/g, ' ').trim();
}

function normalizedTitle(item: { title: string }): string {
  return item.title.toLowerCase().replace(/\s+/g, ' ').trim();
}

// Decide whether a detected duplicate should be superseded by the new write rather
// than causing the new write to be dropped. An explicit `supersedes` id always wins.
//
// Otherwise the rule is the same for every category: an identical normalized title with
// materially different content is "same subject, new information", so the new write
// supersedes. Dropping it instead would leave the STALE value active and lose the
// correction with no durable trace -- the worst outcome for a memory system, and the
// reason this is not restricted to `state`. Supersession is not deletion: the
// predecessor keeps status 'superseded' and stays queryable via supersededById.
//
// Distinct titles (e.g. a work loop's start / checkpoint / finish records) stay side by
// side even though their text overlaps heavily, and are reported to the caller instead.
function supersedesDuplicate(input: { category: KnowledgeCategory; title: string; content: string; supersedes?: string }, duplicate: KnowledgeItem): boolean {
  if (input.supersedes && input.supersedes === duplicate.id) return true;
  return normalizedTitle(input) === normalizedTitle(duplicate)
    && normalizedIdentity(input) !== normalizedIdentity(duplicate);
}

// Resolve the item (if any) that a new write should mark superseded: the detected
// duplicate when it qualifies, otherwise an explicitly named active item.
async function resolveSupersedeTarget(
  input: { supersedes?: string },
  duplicate: KnowledgeItem | null,
  qualifies: boolean,
): Promise<KnowledgeItem | null> {
  if (duplicate && qualifies) return duplicate;
  if (input.supersedes) {
    const explicit = await repo.getKnowledgeItem(input.supersedes);
    if (explicit && explicit.status === 'active') return explicit;
  }
  return null;
}

export async function storeKnowledgeItemDeduped(
  projectId: string,
  input: StoreKnowledgeInput,
  commitMessage?: string,
  validationOptions?: KnowledgeWriteValidationOptions,
): Promise<StoreKnowledgeResult> {
  const conflicts = await checkKnowledgeConflict(input);
  if (conflicts.length) throw new KnowledgeConflictError(conflicts.map(item => ({ id: item.id, title: item.title })));
  const duplicate = await findLikelyDuplicateKnowledgeItem(projectId, input);
  const qualifies = duplicate ? supersedesDuplicate(input, duplicate) : false;
  if (duplicate && !qualifies && !input.supersedes) {
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
      sourceCommit: input.sourceCommit,
      affectedPaths: input.affectedPaths,
      confidence: input.confidence,
      conflictKey: input.conflictKey,
      conflictScope: input.conflictScope,
      conflictExclusive: input.conflictExclusive,
    },
    input.steps,
    undefined,
    validationOptions,
  );
  await attachEvidenceToKnowledge(item.id, input.evidence, input);

  const changes: CommitChange[] = [];
  const superseded = await resolveSupersedeTarget(input, duplicate, qualifies);
  if (superseded && superseded.id !== item.id) {
    await repo.updateKnowledgeItem(superseded.id, { status: 'superseded', supersededById: item.id });
    changes.push({ itemId: superseded.id, action: 'supersede', before: superseded });
  }
  changes.push({ itemId: item.id, action: 'insert', after: item });
  await repo.createKnowledgeCommit(projectId, commitMessage || `Store ${input.category}: ${input.title}`, changes);
  await indexKnowledgeItemsBestEffort(projectId, [item]);

  return { action: 'inserted', item };
}

export async function storeKnowledgeAtomsDeduped(
  projectId: string,
  atoms: StoreKnowledgeInput[],
  commitMessage?: string,
  validationOptions?: KnowledgeWriteValidationOptions,
): Promise<StoreKnowledgeBatchResult> {
  const changes: CommitChange[] = [];
  const itemIds: string[] = [];
  const inserted: KnowledgeItem[] = [];
  let duplicateCount = 0;
  let insertedCount = 0;

  for (const atom of atoms) {
    const duplicate = await findLikelyDuplicateKnowledgeItem(projectId, {
      category: atom.category,
      title: atom.title,
      content: atom.content,
      reasoning: atom.reasoning,
      tags: atom.tags,
    });

    const qualifies = duplicate ? supersedesDuplicate(atom, duplicate) : false;
    if (duplicate && !qualifies && !atom.supersedes) {
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
        sourceCommit: atom.sourceCommit,
        affectedPaths: atom.affectedPaths,
        confidence: atom.confidence,
      },
      atom.steps,
      undefined,
      validationOptions,
    );
    await attachEvidenceToKnowledge(item.id, atom.evidence, atom);

    const superseded = await resolveSupersedeTarget(atom, duplicate, qualifies);
    if (superseded && superseded.id !== item.id) {
      await repo.updateKnowledgeItem(superseded.id, { status: 'superseded', supersededById: item.id });
      changes.push({ itemId: superseded.id, action: 'supersede', before: superseded });
    }

    itemIds.push(item.id);
    insertedCount++;
    inserted.push(item);
    changes.push({ itemId: item.id, action: 'insert', after: item });
  }

  if (changes.length > 0) {
    await repo.createKnowledgeCommit(
      projectId,
      commitMessage || `Store ${atoms.length} structured knowledge atom(s)`,
      changes
    );
  }
  await indexKnowledgeItemsBestEffort(projectId, inserted);

  return {
    itemIds,
    insertedCount,
    duplicateCount,
  };
}
