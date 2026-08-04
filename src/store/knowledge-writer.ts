import { CommitChange, EvidenceInput, KnowledgeCategory, KnowledgeItem, KnowledgeProvenance, KnowledgeWriteValidationOptions } from '../core/types.js';
import { searchKnowledgeItems } from './search.js';
import * as repo from './repository.js';
import { checkKnowledgeConflict, normalizeConflictScope } from './conflicts.js';
import { KnowledgeConflictError } from '../core/errors.js';
import { getConfigRoot, withClientTransaction } from './database.js';
import type { CrossRepoOverlap, OverlapSubject } from '../workspace/cross-repo-overlap.js';
import type { ActiveWorkspace } from '../workspace/resolve.js';
import { attachEvidenceToKnowledge, listEvidenceForItem } from './evidence-repository.js';
import { normalizeAffectedPaths } from './freshness.js';
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
  provenance?: KnowledgeProvenance | null;
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

/**
 * Everything an item carries that a title-and-content comparison cannot see.
 *
 * Named as a type because two places decide "is this copy redundant" -- the write path, when
 * it answers "already held verbatim", and GC, when it picks which of two twins to hard delete.
 * Both used to compare title and content alone, and both therefore discarded whatever else the
 * losing copy held. One definition, so the two cannot drift apart.
 */
export type KnowledgePayload = {
  reasoning?: string | null;
  alternatives?: string[] | null;
  tags?: string[] | null;
  source?: string | null;
  sourceCommit?: string | null;
  affectedPaths?: string[] | null;
  provenance?: KnowledgeProvenance | null;
  confidence?: number | null;
  conflictKey?: string | null;
  conflictScope?: Record<string, unknown> | null;
  conflictExclusive?: boolean;
  /** Evidence identity, as `type:locator`. Absent means "not compared", not "none". */
  evidence?: string[];
  /** Skill steps, in order. Absent means "not compared", not "none". */
  steps?: string[];
};

function nonEmptySet(values: string[] | null | undefined): Set<string> | null {
  if (!values || values.length === 0) return null;
  const set = new Set(values.filter(value => value !== null && value !== undefined && value !== ''));
  return set.size > 0 ? set : null;
}

function scalarCarriesNothingNew(incoming: unknown, held: unknown): boolean {
  if (incoming === undefined || incoming === null || incoming === '') return true;
  return incoming === held;
}

function setCarriesNothingNew(incoming: string[] | null | undefined, held: string[] | null | undefined): boolean {
  const left = nonEmptySet(incoming);
  if (!left) return true;
  const right = nonEmptySet(held) ?? new Set<string>();
  for (const value of left) {
    if (!right.has(value)) return false;
  }
  return true;
}

/**
 * Whether `incoming` adds nothing `held` does not already carry.
 *
 * Deliberately asymmetric, and deliberately not "are these equal". A write that merely *omits*
 * what the store already holds adds nothing, so it must stay a no-op -- treating any
 * difference as new information would let a barer restatement retire a richer record, which is
 * the same field-blindness pointed the other way. A write that adds a tag, a path, a source
 * commit or a lower confidence is carrying something, and gets written.
 *
 * A field left `undefined` on either side is not compared. That is what lets the same function
 * serve a caller that knows an item's evidence and one that does not, without either having to
 * pretend it knows the answer is "none".
 */
export function carriesNothingNew(incoming: KnowledgePayload, held: KnowledgePayload): boolean {
  return scalarCarriesNothingNew(incoming.reasoning, held.reasoning)
    && scalarCarriesNothingNew(incoming.source, held.source)
    && scalarCarriesNothingNew(incoming.sourceCommit, held.sourceCommit)
    && scalarCarriesNothingNew(incoming.provenance, held.provenance)
    && scalarCarriesNothingNew(incoming.conflictKey, held.conflictKey)
    && scalarCarriesNothingNew(incoming.confidence, held.confidence)
    // Only a declared exclusivity is information; not declaring it says nothing.
    && (incoming.conflictExclusive !== true || held.conflictExclusive === true)
    && scalarCarriesNothingNew(
      incoming.conflictScope ? JSON.stringify(normalizeConflictScope(incoming.conflictScope)) : null,
      held.conflictScope ? JSON.stringify(normalizeConflictScope(held.conflictScope)) : null,
    )
    && setCarriesNothingNew(incoming.alternatives, held.alternatives)
    && setCarriesNothingNew(incoming.tags, held.tags)
    // Normalized on both sides: the stored copy was normalized on the way in and the incoming
    // one has not been yet, so `./src/a.ts` and `src/a.ts` would otherwise read as different.
    && setCarriesNothingNew(normalizeAffectedPaths(incoming.affectedPaths), normalizeAffectedPaths(held.affectedPaths))
    && setCarriesNothingNew(incoming.evidence, held.evidence)
    // Steps are ordered, so a reordering is a different procedure rather than a subset.
    && (incoming.steps === undefined || incoming.steps.length === 0
      || (held.steps !== undefined && held.steps.join('\n') === incoming.steps.join('\n')));
}

/** Evidence identity, matched the way `createEvidence` stores it. */
function evidenceKey(type: string, locator: string): string {
  return `${type}:${locator.trim().replace(/\\/g, '/')}`;
}

/**
 * What the stored item holds beyond its own columns, fetched only when a no-op is possible.
 *
 * Two extra reads on every write would be two too many. Title and content already have to
 * match byte-for-byte before anything else can make the difference, and that is a rare path.
 */
export async function heldPayloadFor(
  input: { title: string; content: string },
  duplicate: KnowledgeItem,
): Promise<KnowledgePayload | undefined> {
  if (normalizedIdentity(input) !== normalizedIdentity(duplicate)) return undefined;
  const [evidence, steps] = await Promise.all([
    listEvidenceForItem(duplicate.id).catch(() => []),
    duplicate.category === 'skill' ? repo.getSkillSteps(duplicate.id).catch(() => []) : Promise.resolve([]),
  ]);
  return {
    ...duplicate,
    evidence: evidence.map(entry => evidenceKey(entry.type, entry.locator)),
    steps: steps.map(step => step.instruction),
  };
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
// silently discarded. Only a re-store that adds nothing is a no-op, because only then is
// there nothing to lose. Everything else is written.
//
// "Adds nothing" used to mean "same title and content", which is where this went wrong.
// A write of the same sentence carrying `affectedPaths`, a `sourceCommit`, tags, a
// changed confidence, provenance or evidence was answered "already held verbatim, nothing
// was lost" and dropped -- and `affectedPaths` is what the whole drift system keys on, so
// the dropped write was the difference between an item that gets re-checked when its file
// changes and one that never does. The test is now over the whole payload, and
// deliberately asymmetric: a restatement that merely OMITS what the store already holds
// still adds nothing, and must not retire the richer record.
//
// An explicit `supersedes` id always wins. Otherwise a subset-title match reads as
// "same subject, new information" and supersedes, which keeps exactly one active answer
// and leaves the predecessor queryable via supersededById -- supersession is not
// deletion. When the titles are unrelated the engine cannot know whether this is a
// correction or a genuinely distinct record, so it keeps both and tells the caller,
// which is recoverable in a way that dropping the write is not.
//
// `held` carries what the stored item holds outside its own columns -- evidence and skill
// steps. Omit it and those two are simply not compared; every other field still is. Callers
// on the write path pass it via `heldPayloadFor`.
export function resolveDuplicate(
  // `evidence` is widened because a caller supplies inputs while a stored payload holds keys.
  input: { category: KnowledgeCategory; title: string; content: string; supersedes?: string }
    & Omit<KnowledgePayload, 'evidence'>
    & { evidence?: EvidenceInput[] | string[] },
  duplicate: KnowledgeItem,
  held?: KnowledgePayload,
): DuplicateResolution {
  if (input.supersedes && input.supersedes === duplicate.id) return 'supersede';
  if (normalizedIdentity(input) === normalizedIdentity(duplicate)) {
    const incoming: KnowledgePayload = {
      ...input,
      evidence: held?.evidence === undefined ? undefined : (input.evidence || []).map(entry =>
        typeof entry === 'string' ? entry : evidenceKey(entry.type, entry.locator)),
      steps: held?.steps === undefined ? undefined : input.steps,
    };
    if (carriesNothingNew(incoming, held ?? duplicate)) return 'no-op';
  }
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
  const resolution = duplicate
    ? resolveDuplicate(input, duplicate, await heldPayloadFor(input, duplicate))
    : null;
  if (duplicate && resolution === 'no-op' && !input.supersedes) {
    return { action: 'duplicate', item: duplicate };
  }

  // The item, the predecessor it retires and the commit record naming both land together or
  // not at all -- the same invariant the batch path holds. Rows with no commit record are
  // invisible to blast-radius, which is the mechanism that decides what to re-check when one
  // of them turns out to be wrong.
  const { item, superseded } = await withClientTransaction(async (conn) => {
    const written = await repo.createKnowledgeItem(
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
        provenance: input.provenance,
        conflictKey: input.conflictKey,
        conflictScope: input.conflictScope,
        conflictExclusive: input.conflictExclusive,
      },
      input.steps,
      conn,
      validationOptions,
    );
    await attachEvidenceToKnowledge(written.id, input.evidence, input);

    const changes: CommitChange[] = [];
    const retired = await resolveSupersedeTarget(input, duplicate, resolution === 'supersede');
    if (retired && retired.id !== written.id) {
      await repo.updateKnowledgeItem(retired.id, { status: 'superseded', supersededById: written.id }, undefined, conn);
      changes.push({ itemId: retired.id, action: 'supersede', before: retired });
    }
    changes.push({ itemId: written.id, action: 'insert', after: written });
    await repo.createKnowledgeCommit(projectId, commitMessage || `Store ${input.category}: ${input.title}`, changes, conn);
    return { item: written, superseded: retired };
  });
  await indexKnowledgeItemsBestEffort(projectId, [item]);

  return {
    action: 'inserted',
    item,
    superseded: superseded || undefined,
    nearDuplicate: resolution === 'coexist' && duplicate ? duplicate : undefined,
    crossRepo: await overlapFor(await activeWorkspaceForWrite(), input),
  };
}

/**
 * Write a batch of atoms, or write none of it.
 *
 * The atoms used to be written one transaction at a time with the commit record appended once
 * at the end, so an atom refused halfway through -- an oversized field, a secret, an exclusive
 * conflict -- threw out of the loop and skipped the commit entirely. The caller was told the
 * call failed while the earlier atoms sat in the store, and with no commit naming them
 * blast-radius could never implicate them if one later turned out to be wrong. A retired
 * predecessor stayed retired too, so a failed batch could leave a subject with no active
 * answer at all.
 *
 * One transaction over the whole batch makes the report and the state agree, and makes a retry
 * of the same batch trivially idempotent. The duplicate search runs inside it and therefore
 * still sees the atoms written earlier in the same batch. What stays outside is everything
 * that is not this database: peer overlap reports and embedding, both advisory and both
 * reasons to hold a write lock longer than the write needs it.
 */
export async function storeKnowledgeAtomsDeduped(
  projectId: string,
  atoms: StoreKnowledgeInput[],
  commitMessage?: string,
  validationOptions?: KnowledgeWriteValidationOptions,
): Promise<StoreKnowledgeBatchResult> {
  // Resolved once for the whole batch, not once per atom. Ten atoms against three peers is
  // thirty workspace resolutions inside the loop, for something that cannot change mid-batch.
  const workspace = await activeWorkspaceForWrite();

  const written = await withClientTransaction(async (conn) => {
    const changes: CommitChange[] = [];
    const itemIds: string[] = [];
    const inserted: KnowledgeItem[] = [];
    const supersededIds: string[] = [];
    const outcomes: StoreKnowledgeAtomOutcome[] = [];
    // Which atom produced which outcome, so the peer lookups can be resolved after the
    // transaction commits rather than inside it.
    const overlapSubjects: Array<{ outcome: StoreKnowledgeAtomOutcome; atom: StoreKnowledgeInput }> = [];
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

      const resolution = duplicate
        ? resolveDuplicate(atom, duplicate, await heldPayloadFor(atom, duplicate))
        : null;
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
          provenance: atom.provenance,
          // Dropped here until now, while the comment on StoreKnowledgeInput claimed both
          // store paths forwarded them. Exclusivity is enforced inside createKnowledgeItem's
          // own transaction, so an atom that never carried the key was never checked against
          // it -- the guard was simply off for anything ingested as a batch.
          conflictKey: atom.conflictKey,
          conflictScope: atom.conflictScope,
          conflictExclusive: atom.conflictExclusive,
        },
        atom.steps,
        conn,
        validationOptions,
      );
      await attachEvidenceToKnowledge(item.id, atom.evidence, atom);

      const superseded = await resolveSupersedeTarget(atom, duplicate, resolution === 'supersede');
      if (superseded && superseded.id !== item.id) {
        await repo.updateKnowledgeItem(superseded.id, { status: 'superseded', supersededById: item.id }, undefined, conn);
        changes.push({ itemId: superseded.id, action: 'supersede', before: superseded });
        supersededIds.push(superseded.id);
      }

      itemIds.push(item.id);
      insertedCount++;
      inserted.push(item);
      changes.push({ itemId: item.id, action: 'insert', after: item });
      const outcome: StoreKnowledgeAtomOutcome = {
        action: 'inserted',
        itemId: item.id,
        title: atom.title,
        ...(superseded && superseded.id !== item.id ? { supersededId: superseded.id } : {}),
        ...(resolution === 'coexist' && duplicate
          ? { nearDuplicateId: duplicate.id, nearDuplicateTitle: duplicate.title }
          : {}),
      };
      outcomes.push(outcome);
      overlapSubjects.push({ outcome, atom });
    }

    if (changes.length > 0) {
      await repo.createKnowledgeCommit(
        projectId,
        commitMessage || `Store ${atoms.length} structured knowledge atom(s)`,
        changes,
        conn,
      );
    }

    return { itemIds, insertedCount, duplicateCount, supersededIds, outcomes, inserted, overlapSubjects };
  });

  // Per atom, so an agent can tell which of five findings overlapped rather than being told
  // only that something in the batch did. Advisory, so it reads peers after the local write
  // is durable instead of holding the write open across them.
  for (const { outcome, atom } of written.overlapSubjects) {
    outcome.crossRepo = await overlapFor(workspace, atom);
  }
  await indexKnowledgeItemsBestEffort(projectId, written.inserted);

  return {
    itemIds: written.itemIds,
    insertedCount: written.insertedCount,
    duplicateCount: written.duplicateCount,
    supersededIds: written.supersededIds,
    outcomes: written.outcomes,
  };
}
