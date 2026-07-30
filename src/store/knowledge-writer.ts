import { CommitChange, EvidenceInput, KnowledgeCategory, KnowledgeItem, KnowledgeWriteValidationOptions } from '../core/types.js';
import { searchKnowledgeItems } from './search.js';
import * as repo from './repository.js';
import { checkKnowledgeConflict } from './conflicts.js';
import { KnowledgeConflictError } from '../core/errors.js';
import { getConfigRoot } from './database.js';
import type { CrossRepoOverlap, OverlapSubject } from '../workspace/cross-repo-overlap.js';
import type { ActiveWorkspace } from '../workspace/resolve.js';
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
  // Declared because both store paths already forward these to checkKnowledgeConflict and
  // createKnowledgeItem at runtime; without them the exclusive-conflict contract was
  // reachable only through an object literal that failed its own excess-property check.
  conflictKey?: string | null;
  conflictScope?: Record<string, unknown> | null;
  conflictExclusive?: boolean;
}

export interface StoreKnowledgeResult {
  /** 'duplicate' means nothing was written because the item was already held verbatim. */
  action: 'inserted' | 'duplicate';
  item: KnowledgeItem;
  /** The active item this write retired, when it replaced one. */
  superseded?: KnowledgeItem;
  /** An overlapping active item deliberately left active beside this write. */
  nearDuplicate?: KnowledgeItem;
  /**
   * Overlaps with linked repos. Advisory: those items belong to another repo and cannot be
   * retired from here.
   */
  crossRepo?: CrossRepoOverlap[];
}

export interface StoreKnowledgeAtomOutcome {
  action: 'inserted' | 'duplicate';
  itemId: string;
  title: string;
  supersededId?: string;
  nearDuplicateId?: string;
  nearDuplicateTitle?: string;
  /** Overlaps with linked repos, per atom: five findings can overlap five different repos. */
  crossRepo?: CrossRepoOverlap[];
}

export interface StoreKnowledgeBatchResult {
  /** One id per atom: the inserted item, or the existing item for a verbatim no-op. */
  itemIds: string[];
  insertedCount: number;
  duplicateCount: number;
  supersededIds: string[];
  /** Per-atom outcomes, so a caller can report exactly what happened to each one. */
  outcomes: StoreKnowledgeAtomOutcome[];
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

// Whether two items are about the same subject, judged on titles alone: one title's
// significant tokens are wholly contained in the other's. This is deliberately a title
// test and not a whole-text similarity test, because content overlap cannot tell a
// correction apart from a lifecycle trail. "Work Loop: Implement search UI" and
// "Work Loop finish" overlap on ~86% of their body tokens yet must stay side by side,
// while their titles are not in a subset relation. "Cache TTL" twice, and
// "Database is SQLite" against "Project database uses SQLite", are.
//
// A one-token title ("Auth") is too coarse to carry this and is excluded.
export function sameSubjectTitle(a: { title: string }, b: { title: string }): boolean {
  const left = duplicateTokens(a.title);
  const right = duplicateTokens(b.title);
  const [smaller, larger] = left.size <= right.size ? [left, right] : [right, left];
  if (smaller.size < 2) return false;
  for (const token of smaller) {
    if (!larger.has(token)) return false;
  }
  return true;
}

export type DuplicateResolution =
  /** Byte-for-byte the knowledge already held: write nothing, report the existing item. */
  | 'no-op'
  /** Same subject, different content: insert and retire the predecessor. */
  | 'supersede'
  /** Overlapping but not the same subject: insert, leave the other active, report it. */
  | 'coexist';

// How a detected near-duplicate is reconciled with the incoming write. The one
// invariant that holds for every category and every calling agent: content is never
// silently discarded. Only an exact re-store is a no-op, because only then is there
// nothing to lose. Everything else is written.
//
// An explicit `supersedes` id always wins. Otherwise a subset-title match reads as
// "same subject, new information" and supersedes, which keeps exactly one active answer
// and leaves the predecessor queryable via supersededById -- supersession is not
// deletion. When the titles are unrelated the engine cannot know whether this is a
// correction or a genuinely distinct record, so it keeps both and tells the caller,
// which is recoverable in a way that dropping the write is not.
export function resolveDuplicate(
  input: { category: KnowledgeCategory; title: string; content: string; supersedes?: string },
  duplicate: KnowledgeItem,
): DuplicateResolution {
  if (input.supersedes && input.supersedes === duplicate.id) return 'supersede';
  if (normalizedIdentity(input) === normalizedIdentity(duplicate)) return 'no-op';
  return sameSubjectTitle(input, duplicate) ? 'supersede' : 'coexist';
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

/**
 * Linked repos, resolved once per write operation rather than once per atom.
 *
 * Lazy for the same reason `resolveWritingRepo` is: an unlinked project must pay nothing, and
 * a broken workspace must not block an ordinary write.
 */
let workspaceCache: { root: string; workspace: ActiveWorkspace | null } | null = null;

/** Tests only: the cache is process-lifetime and would otherwise leak between fixtures. */
export function resetWriteWorkspaceCache(): void {
  workspaceCache = null;
}

/**
 * Cached per config root, for the same reason `resolveWritingRepo` is: a write must not pay a
 * config read, and the overwhelming majority of writes happen in projects with no workspace.
 *
 * The batch writer resolved this once per batch from the start; the single-atom writer resolved
 * it per call, which meant a config read and a JSON parse on every write. That was not merely
 * wasteful -- a run of 2500 ordinary writes crashed the process partway through, and completed
 * cleanly with this call removed. The same run passes on 2.6.0, which did not have it.
 */
async function activeWorkspaceForWrite(): Promise<ActiveWorkspace | null> {
  let root: string;
  try {
    root = getConfigRoot();
  } catch {
    return null; // no open store: nothing to resolve against
  }

  if (workspaceCache?.root === root) return workspaceCache.workspace;

  let workspace: ActiveWorkspace | null = null;
  try {
    const { resolveWorkspace } = await import('../workspace/resolve.js');
    workspace = await resolveWorkspace(root);
  } catch {
    workspace = null; // a broken workspace must not block an ordinary write
  }

  workspaceCache = { root, workspace };
  return workspace;
}

/** Advisory and non-fatal: a peer that cannot be consulted must not fail the write. */
/**
 * The cross-repo overlap report for a single write, workspace resolution included.
 *
 * Exported because `recordDecisionDirect` writes through the repository rather than through this
 * module, so it never reached the private version -- and it backs both `knowl decide` and the
 * `knowl_decide` MCP tool. The result was that the cross-repo advisory was silently off for
 * decisions: the category most likely to contradict across repos, and the one a workspace default
 * shares automatically. Found by linking two repos and using them, not by reading the code.
 *
 * Any future writer that produces a result envelope should call this rather than reimplement it.
 */
export async function crossRepoOverlapForWrite(item: OverlapSubject): Promise<CrossRepoOverlap[] | undefined> {
  return overlapFor(await activeWorkspaceForWrite(), item);
}

async function overlapFor(
  workspace: ActiveWorkspace | null,
  item: OverlapSubject,
): Promise<CrossRepoOverlap[] | undefined> {
  if (!workspace) return undefined;
  try {
    const { findCrossRepoOverlap } = await import('../workspace/cross-repo-overlap.js');
    const found = await findCrossRepoOverlap({ workspace, item });
    return found.length ? found : undefined;
  } catch {
    return undefined;
  }
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
  const resolution = duplicate ? resolveDuplicate(input, duplicate) : null;
  if (duplicate && resolution === 'no-op' && !input.supersedes) {
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
  const superseded = await resolveSupersedeTarget(input, duplicate, resolution === 'supersede');
  if (superseded && superseded.id !== item.id) {
    await repo.updateKnowledgeItem(superseded.id, { status: 'superseded', supersededById: item.id });
    changes.push({ itemId: superseded.id, action: 'supersede', before: superseded });
  }
  changes.push({ itemId: item.id, action: 'insert', after: item });
  await repo.createKnowledgeCommit(projectId, commitMessage || `Store ${input.category}: ${input.title}`, changes);
  await indexKnowledgeItemsBestEffort(projectId, [item]);

  return {
    action: 'inserted',
    item,
    superseded: superseded || undefined,
    nearDuplicate: resolution === 'coexist' && duplicate ? duplicate : undefined,
    crossRepo: await overlapFor(await activeWorkspaceForWrite(), input),
  };
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
  const supersededIds: string[] = [];
  const outcomes: StoreKnowledgeAtomOutcome[] = [];
  let duplicateCount = 0;
  let insertedCount = 0;
  // Resolved once for the whole batch, not once per atom. Ten atoms against three peers is
  // thirty workspace resolutions inside the loop, for something that cannot change mid-batch.
  const workspace = await activeWorkspaceForWrite();

  for (const atom of atoms) {
    const duplicate = await findLikelyDuplicateKnowledgeItem(projectId, {
      category: atom.category,
      title: atom.title,
      content: atom.content,
      reasoning: atom.reasoning,
      tags: atom.tags,
    });

    const resolution = duplicate ? resolveDuplicate(atom, duplicate) : null;
    if (duplicate && resolution === 'no-op' && !atom.supersedes) {
      itemIds.push(duplicate.id);
      duplicateCount++;
      outcomes.push({ action: 'duplicate', itemId: duplicate.id, title: atom.title });
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

    const superseded = await resolveSupersedeTarget(atom, duplicate, resolution === 'supersede');
    if (superseded && superseded.id !== item.id) {
      await repo.updateKnowledgeItem(superseded.id, { status: 'superseded', supersededById: item.id });
      changes.push({ itemId: superseded.id, action: 'supersede', before: superseded });
      supersededIds.push(superseded.id);
    }

    itemIds.push(item.id);
    insertedCount++;
    inserted.push(item);
    changes.push({ itemId: item.id, action: 'insert', after: item });
    outcomes.push({
      action: 'inserted',
      itemId: item.id,
      title: atom.title,
      ...(superseded && superseded.id !== item.id ? { supersededId: superseded.id } : {}),
      ...(resolution === 'coexist' && duplicate
        ? { nearDuplicateId: duplicate.id, nearDuplicateTitle: duplicate.title }
        : {}),
      // Per atom, so an agent can tell which of five findings overlapped rather than being
      // told only that something in the batch did.
      crossRepo: await overlapFor(workspace, atom),
    });
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
    supersededIds,
    outcomes,
  };
}
