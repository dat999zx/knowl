import path from 'node:path';
import { and, desc, eq, inArray, isNull, sql as drizzleSql } from 'drizzle-orm';
import { getDb, withClientTransaction } from './database.js';
import type { DbConnection } from './database.js';
import * as schema from './schema.js';
import { recordTombstone } from './tombstones.js';
import { FORGET_LOG_POLICY_MANUAL, recordForgetLogEntry } from './forget-log.js';
import { normalizeConflictKey, normalizeConflictScope } from './conflicts.js';
import {
  Project,
  KnowledgeItem,
  KnowledgeCommit,
  SkillStep,
  SkillMetadata,
  CommitChange,
  KnowledgeCategory,
  KnowledgeFreshness,
  KnowledgeTier,
  KnowledgeProvenance,
  KnowledgeStatus,
  KnowledgeWriteValidationOptions,
} from '../core/types.js';
import { DatabaseError, KnowledgeConflictError } from '../core/errors.js';
import { DEFAULT_FRESHNESS, hashKnowledgeContent, hashKnowledgeLifecycle, normalizeAffectedPaths } from './freshness.js';
import { resolveWriteDefaults } from './write-ownership.js';
import { assertConfidenceInRange, KnowledgeValidationError, validateKnowledgeWrite } from '../core/knowledge-validation.js';

export const LOCAL_PROJECT_ID = 'local';

// Helper to generate IDs without external packages
function generateId(): string {
  return crypto.randomUUID().replace(/-/g, '').substring(0, 16);
}

function localProject(rootPath: string): Project {
  const now = new Date().toISOString();
  return {
    id: LOCAL_PROJECT_ID,
    name: path.basename(rootPath),
    description: null,
    rootPath,
    createdAt: now,
    updatedAt: now,
  };
}

function unwrapJson(value: unknown): unknown {
  let current = value;
  while (typeof current === 'string') {
    try {
      current = JSON.parse(current);
    } catch {
      break;
    }
  }
  return current;
}

function stripProjectFields(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stripProjectFields);
  }

  if (!value || typeof value !== 'object') {
    return value;
  }

  const normalized: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key === 'projectId' || key === 'project_id') continue;
    normalized[key] = stripProjectFields(entry);
  }
  return normalized;
}

function compactCommitChanges(changes: CommitChange[]): CommitChange[] {
  return stripProjectFields(changes) as CommitChange[];
}

function parseCommitChanges(value: unknown): CommitChange[] {
  const parsed = unwrapJson(value);
  return Array.isArray(parsed) ? parsed as CommitChange[] : [];
}

export function mapRowToKnowledgeItem(row: typeof schema.knowledgeItems.$inferSelect): KnowledgeItem {
  return {
    ...row,
    category: row.category as KnowledgeCategory,
    status: row.status as KnowledgeStatus,
    freshness: (row.freshness || DEFAULT_FRESHNESS) as KnowledgeFreshness,
    tier: (row.tier || 'asserted') as KnowledgeTier,
    tierSince: (row.tierSince ?? null) as string | null,
    provenance: (row.provenance ?? null) as KnowledgeProvenance | null,
    // alternatives, tags, affectedPaths and conflictScope used to be restated as casts here.
    // The columns carry `$type` now, so `...row` already has them right -- and a fifth JSON
    // column added later arrives typed instead of silently `unknown`, which is how
    // conflictScope was missed.
  };
}

export async function createProject(rootPath: string, name: string, description?: string, dbConnection?: DbConnection): Promise<Project> {
  return localProject(rootPath);
}

export async function getProjectByRootPath(rootPath: string, dbConnection?: DbConnection): Promise<Project | null> {
  return localProject(rootPath);
}

export async function createKnowledgeItem(
  projectId: string,
  item: {
    category: KnowledgeCategory;
    title: string;
    content: string;
    reasoning?: string | null;
    alternatives?: string[] | null;
    tags?: string[] | null;
    source?: string | null;
    sourceCommit?: string | null;
    affectedPaths?: string[] | null;
    contentHash?: string | null;
    freshness?: KnowledgeFreshness;
    confidence?: number;
    provenance?: KnowledgeProvenance | null;
    conflictKey?: string | null;
    conflictScope?: Record<string, unknown> | null;
    conflictExclusive?: boolean;
  },
  steps?: string[],
  dbConnection?: DbConnection,
  validationOptions?: KnowledgeWriteValidationOptions,
): Promise<KnowledgeItem> {
  validateKnowledgeWrite(item, validationOptions);
  // The last door before the row, so the invariant is stated here rather than at each caller.
  // `knowledge-writer` checks it earlier as well -- deliberately, so a batch is refused before
  // a transaction the caller was never told about is opened -- but merge, synthesis,
  // session-handoff, work-loop and the CLI fixture path all arrive here directly. Import does
  // not: it writes raw SQL precisely because a dump is foreign data that may predate any guard
  // this build has, and refusing it would make someone's export unloadable.
  assertConfidenceInRange(item.confidence, item.title);
  const now = new Date().toISOString();
  const id = generateId();
  const affectedPaths = normalizeAffectedPaths(item.affectedPaths);
  // Stamped at the one point where the answer is known without guessing. Joining a
  // workspace backfills what is already there, but nothing claimed items written
  // afterwards -- which left `workspace promote` unable to touch them, and would leave a
  // shared database unable to say who may edit or collect them.
  //
  // Visibility rides the same resolution: both come from this repo's manifest entry, and a
  // second lookup per write is the 2.7.0 regression 2.7.1 fixed.
  const { repo: originRepo, visibility } = await resolveWriteDefaults();
  const freshness = item.freshness || DEFAULT_FRESHNESS;

  const newItem = {
    id,
    originRepo,
    category: item.category,
    status: 'active' as KnowledgeStatus,
    title: item.title,
    content: item.content,
    reasoning: item.reasoning || null,
    alternatives: item.alternatives || null,
    tags: item.tags || null,
    source: item.source || null,
    sourceCommit: item.sourceCommit || null,
    affectedPaths,
    contentHash: item.contentHash || hashKnowledgeContent({
      title: item.title,
      content: item.content,
      reasoning: item.reasoning,
      source: item.source,
      affectedPaths,
    }),
    // One variable, two sites. The row's `visibility` and the hash's must agree: lifecycle_hash
    // is exactly what change-watermark and import-policy compare to decide an item changed, so
    // a row saying 'workspace' beside a hash computed over 'repo' is a divergence nothing
    // reconciles and nothing reports.
    visibility,
    lifecycleHash: hashKnowledgeLifecycle({
      status: 'active', freshness, supersededById: null, originRepo, visibility,
    }),
    freshness,
    confidence: item.confidence ?? 1.0,
    tier: 'asserted' as const, // standing is earned by use, never granted at birth
    tierSince: now, // the climb to verified starts here, not at some inherited history
    provenance: item.provenance ?? null,
    conflictKey: item.conflictKey ? normalizeConflictKey(item.conflictKey) : null, conflictScope: normalizeConflictScope(item.conflictScope), conflictExclusive: item.conflictExclusive ?? false,
    supersededById: null,
    version: 1,
    createdAt: now,
    updatedAt: now,
  };

  const operation = async (exec: any) => {
    if (newItem.conflictExclusive && newItem.conflictKey) {
      const conflicts = await exec.select().from(schema.knowledgeItems).where(and(
        eq(schema.knowledgeItems.status, 'active'), eq(schema.knowledgeItems.conflictExclusive, true),
        eq(schema.knowledgeItems.conflictKey, newItem.conflictKey),
        // Second of the two sites that compare this column. `eq(column, null)` renders
        // `= NULL`, which never matches, so a scopeless exclusive key let the duplicate it
        // was declared to prevent straight through. Fixing only checkKnowledgeConflict would
        // report the conflict while still allowing the write.
        newItem.conflictScope === null
          ? isNull(schema.knowledgeItems.conflictScope)
          : eq(schema.knowledgeItems.conflictScope, newItem.conflictScope),
      ));
      if (conflicts.length) throw new KnowledgeConflictError(conflicts.map((item: any) => ({ id: item.id, title: item.title })));
    }
    await exec.insert(schema.knowledgeItems).values(newItem);
    await exec.insert(schema.knowledgeAssertions).values({
      id: generateId(), knowledgeItemId: id, content: item.content,
      validFrom: now, validTo: null, recordedAt: now, replacedAt: null,
      confidence: item.confidence ?? 1.0, sourceEvidenceId: null, conflictKey: newItem.conflictKey, conflictScope: newItem.conflictScope, conflictExclusive: newItem.conflictExclusive,
    });

    if (item.category === 'skill') {
      // Create skill metadata
      await exec.insert(schema.skillMetadata).values({
        knowledgeItemId: id,
        usageCount: 0,
        successCount: 0,
      });

      // Create steps if provided
      if (steps && steps.length > 0) {
        for (let i = 0; i < steps.length; i++) {
          await exec.insert(schema.skillSteps).values({
            id: generateId(),
            knowledgeItemId: id,
            stepOrder: i + 1,
            instruction: steps[i],
            createdAt: now,
          });
        }
      }
    }
  };

  try {
    if (dbConnection) {
      await operation(dbConnection);
    } else {
      // Client-level, not conn.transaction: see withClientTransaction for the measurement.
      // This branch only runs when no outer transaction handed us a connection, so it is
      // always the outermost.
      await withClientTransaction(operation);
    }
    return newItem as KnowledgeItem;
  } catch (error: any) {
    if (error instanceof KnowledgeConflictError) throw error;
    throw new DatabaseError(`Failed to create knowledge item: ${error.message}`);
  }
}

/**
 * Fetch many items in one round-trip, returned by id.
 *
 * Exists because vector search used to call `getKnowledgeItem` once per scored candidate, which
 * made a search cost roughly one query per stored atom. Callers that already hold a list of ids
 * should use this instead of looping.
 */
export async function getKnowledgeItems(
  ids: string[],
  dbConnection?: DbConnection,
): Promise<Map<string, KnowledgeItem>> {
  const found = new Map<string, KnowledgeItem>();
  if (ids.length === 0) return found;
  const conn = dbConnection || getDb();
  try {
    const rows = await conn.select().from(schema.knowledgeItems).where(inArray(schema.knowledgeItems.id, ids));
    for (const row of rows) {
      const item = mapRowToKnowledgeItem(row);
      found.set(item.id, item);
    }
    return found;
  } catch (error: any) {
    throw new DatabaseError(`Failed to get knowledge items: ${error.message}`);
  }
}

export async function getKnowledgeItem(id: string, dbConnection?: DbConnection): Promise<KnowledgeItem | null> {
  const conn = dbConnection || getDb();
  try {
    const result = await conn
      .select()
      .from(schema.knowledgeItems)
      .where(eq(schema.knowledgeItems.id, id))
      .limit(1);
    
    if (!result[0]) return null;

    return mapRowToKnowledgeItem(result[0]);
  } catch (error: any) {
    throw new DatabaseError(`Failed to get knowledge item: ${error.message}`);
  }
}

export async function updateKnowledgeItem(
  id: string,
  updates: Partial<Omit<KnowledgeItem, 'id' | 'createdAt' | 'updatedAt'>>,
  steps?: string[],
  dbConnection?: DbConnection,
  validationOptions?: KnowledgeWriteValidationOptions,
): Promise<KnowledgeItem> {
  // An update does not rewrite `knowledge_items.confidence`, but it does record a fresh
  // `knowledge_assertions` row carrying `updates.confidence` -- the same column, one table
  // over, and the one temporal queries read.
  assertConfidenceInRange(updates.confidence, updates.title ?? id);
  const now = new Date().toISOString();

  const operation = async (exec: any) => {
    const current = await exec
      .select()
      .from(schema.knowledgeItems)
      .where(eq(schema.knowledgeItems.id, id))
      .limit(1);

    if (!current[0]) {
      throw new Error(`Knowledge item not found with id ${id}`);
    }

    const nextVersion = (updates.version ?? current[0].version) + (updates.content || updates.title ? 1 : 0);
    const affectedPaths = updates.affectedPaths !== undefined
      ? normalizeAffectedPaths(updates.affectedPaths)
      : current[0].affectedPaths as string[] | null;
    // `!== undefined`, not `??`. The nullish form cannot tell "not mentioned" from "cleared":
    // an update setting `reasoning: null` wrote NULL to the row and then hashed the OLD
    // reasoning, so `content_hash` fingerprinted a row that no longer existed. Import
    // classifies an item as `identical` on that hash and skips it outright, and drift compares
    // against it, so both trust the previous value for as long as nothing else touches the row.
    // Every field the hash covers is read the same way, including the two the column types
    // happen to make non-nullable, so the rule does not have to be re-derived per field.
    const merged = {
      title: updates.title !== undefined ? updates.title : current[0].title,
      content: updates.content !== undefined ? updates.content : current[0].content,
      reasoning: updates.reasoning !== undefined ? updates.reasoning : current[0].reasoning,
      source: updates.source !== undefined ? updates.source : current[0].source,
      affectedPaths,
    };
    // Only what this update actually writes is scanned. The stored fields were validated
    // when they were written, under that project's own security settings; validating the
    // merged record re-scanned them here under default options instead, because most
    // callers of a metadata-only change have no config to pass. `supersedeKnowledgeItem`
    // writes just a status, so an item whose accepted content happened to trip a detector
    // -- a hyphenated model name reads as a high-entropy token -- could never be retired.
    const written = {
      ...(updates.title !== undefined ? { title: updates.title } : {}),
      ...(updates.content !== undefined ? { content: updates.content } : {}),
      ...(updates.reasoning !== undefined ? { reasoning: updates.reasoning } : {}),
      ...(updates.source !== undefined ? { source: updates.source } : {}),
      ...(updates.affectedPaths !== undefined ? { affectedPaths } : {}),
    };
    validateKnowledgeWrite(written, validationOptions);
    const shouldRefreshHash = updates.contentHash === undefined && (
      updates.title !== undefined ||
      updates.content !== undefined ||
      updates.reasoning !== undefined ||
      updates.source !== undefined ||
      updates.affectedPaths !== undefined
    );

    // Recomputed on every update rather than only when a lifecycle field is present, so a
    // row written before the column existed gets a hash the first time it is touched. An
    // explicitly supplied hash still wins: an import replays a peer's value verbatim.
    const lifecycle = {
      status: updates.status !== undefined ? updates.status : current[0].status,
      freshness: updates.freshness !== undefined ? updates.freshness : current[0].freshness,
      supersededById: updates.supersededById !== undefined ? updates.supersededById : current[0].supersededById,
      originRepo: updates.originRepo !== undefined ? updates.originRepo : current[0].originRepo,
      visibility: updates.visibility !== undefined ? updates.visibility : current[0].visibility,
    };

    // Normalized here as well as on create. A key written raw through update never collides
    // with the same identity written normalized through create, so exclusivity silently stops
    // holding for exactly the rows that most need it. Scope has the same failure mode: it is
    // compared as serialized JSON, so an unsorted object never matches a sorted one.
    //
    // Only touched when the update actually mentions it -- a metadata-only edit must not
    // rewrite an item's identity.
    const conflictKey = updates.conflictKey !== undefined
      ? (updates.conflictKey ? normalizeConflictKey(updates.conflictKey) : null)
      : current[0].conflictKey;
    const conflictScope = updates.conflictScope !== undefined
      ? normalizeConflictScope(updates.conflictScope)
      : current[0].conflictScope;

    const tierIsSetExplicitly = updates.tier !== undefined;
    const tierIsReset = !tierIsSetExplicitly
      && (updates.content !== undefined || updates.title !== undefined);

    // `last_drift_at` records that the automatic check saw this item's files move and that
    // nobody has looked at it since; this is the "since". Any of these five means somebody
    // did look: the claim was rewritten, the paths it cites were changed, it was re-anchored
    // to a commit, or its freshness was deliberately set -- which is what `knowl pr check`
    // and `knowl_update` do at the two ends of a review.
    //
    // Deliberately NOT every update. `updated_at` moves on visibility promotion, supersession
    // and status changes too, and clearing on those would let a workspace-promote silently
    // discharge a drift observation nobody reviewed. It is also not `tierSince`: a review that
    // only refreshes freshness leaves that alone, which would leave the item blocked forever.
    const reviewed = updates.title !== undefined
      || updates.content !== undefined
      || updates.affectedPaths !== undefined
      || updates.sourceCommit !== undefined
      || updates.freshness !== undefined;

    const dbUpdates = {
      ...updates,
      ...(updates.affectedPaths !== undefined ? { affectedPaths } : {}),
      ...(shouldRefreshHash ? { contentHash: hashKnowledgeContent(merged) } : {}),
      ...(updates.lifecycleHash === undefined ? { lifecycleHash: hashKnowledgeLifecycle(lifecycle) } : {}),
      // Verified means verified-verbatim: standing earned by use does not survive the
      // words changing. An explicit tier in `updates` (an import replaying a peer) wins.
      ...(tierIsReset ? { tier: 'asserted' as const } : {}),
      // Whenever the tier is set, stamp when it began. Confirmations are counted from this
      // moment, so a reset restarts the climb rather than inheriting the events that
      // confirmed wording this edit just replaced — or the standing a correction just voided.
      ...((tierIsSetExplicitly || tierIsReset) && updates.tierSince === undefined
        ? { tierSince: now }
        : {}),
      ...(reviewed ? { lastDriftAt: null } : {}),
      ...(updates.conflictKey !== undefined ? { conflictKey } : {}),
      ...(updates.conflictScope !== undefined ? { conflictScope } : {}),
      version: nextVersion,
      updatedAt: now,
    };

    await exec
      .update(schema.knowledgeItems)
      .set(dbUpdates)
      .where(eq(schema.knowledgeItems.id, id));

    if (updates.title !== undefined || updates.content !== undefined || updates.reasoning !== undefined || updates.confidence !== undefined) {
      const openAssertions = await exec.select().from(schema.knowledgeAssertions)
        .where(and(eq(schema.knowledgeAssertions.knowledgeItemId, id), isNull(schema.knowledgeAssertions.validTo))).limit(1);
      if (!openAssertions[0]) throw new Error(`Knowledge item has no open assertion: ${id}`);
      await exec.update(schema.knowledgeAssertions).set({ validTo: now, replacedAt: now }).where(eq(schema.knowledgeAssertions.id, openAssertions[0].id));
      await exec.insert(schema.knowledgeAssertions).values({
        id: generateId(), knowledgeItemId: id, content: merged.content, validFrom: now, validTo: null,
        // The same normalized identity the item row just took. The assertion history is what
        // `knowl_timeline` and conflict auditing read back, so a raw spelling here would
        // reintroduce the divergence one line below where it was fixed.
        recordedAt: now, replacedAt: null, confidence: updates.confidence ?? current[0].confidence, sourceEvidenceId: null, conflictKey, conflictScope, conflictExclusive: updates.conflictExclusive ?? current[0].conflictExclusive,
      });
    }

    if (current[0].category === 'skill' && steps) {
      // Delete old steps
      await exec.delete(schema.skillSteps).where(eq(schema.skillSteps.knowledgeItemId, id));
      
      // Insert new steps
      for (let i = 0; i < steps.length; i++) {
        await exec.insert(schema.skillSteps).values({
          id: generateId(),
          knowledgeItemId: id,
          stepOrder: i + 1,
          instruction: steps[i],
          createdAt: now,
        });
      }
    }

    const updated = await exec
      .select()
      .from(schema.knowledgeItems)
      .where(eq(schema.knowledgeItems.id, id))
      .limit(1);

    return mapRowToKnowledgeItem(updated[0]);
  };

  try {
    if (dbConnection) {
      return await operation(dbConnection);
    } else {
      return await withClientTransaction(operation);
    }
  } catch (error: any) {
    if (error instanceof KnowledgeValidationError) throw error;
    throw new DatabaseError(`Failed to update knowledge item: ${error.message}`);
  }
}

export async function supersedeKnowledgeItem(id: string, supersededById: string): Promise<KnowledgeItem> {
  return updateKnowledgeItem(id, { status: 'superseded', supersededById });
}

/**
 * Every knowledge item in the currently open database.
 *
 * Deliberately takes no scope argument. It used to accept a projectId and ignore it, which
 * read as scoping at every call site -- GC, synthesis, integrity, drift, export and the
 * viewer all looked bounded while scanning the whole table. getProjectByRootPath returns a
 * synthetic {id: 'local'}, so the argument never carried information in the first place.
 *
 * Real filtering belongs here once the schema can express it. Until then the honest
 * signature is the one that cannot be mistaken for filtering.
 */
export async function listKnowledgeItems(dbConnection?: DbConnection): Promise<KnowledgeItem[]> {
  const conn = dbConnection || getDb();
  try {
    const result = await conn
      .select()
      .from(schema.knowledgeItems);

    return result.map(mapRowToKnowledgeItem);
  } catch (error: any) {
    throw new DatabaseError(`Failed to list knowledge items: ${error.message}`);
  }
}

/**
 * The active skill items only, resolved by index rather than by scanning the table.
 *
 * The mid-turn skill lookup runs on every command tool event. `listKnowledgeItems` reads
 * every row in the store to find at most one match; `idx_ki_cat_status` already covers
 * this predicate, so the same answer costs a handful of rows instead of the whole table.
 */
export async function listActiveSkillItems(dbConnection?: DbConnection): Promise<KnowledgeItem[]> {
  const conn = dbConnection || getDb();
  try {
    const result = await conn
      .select()
      .from(schema.knowledgeItems)
      .where(and(
        eq(schema.knowledgeItems.category, 'skill'),
        eq(schema.knowledgeItems.status, 'active'),
      ));

    return result.map(mapRowToKnowledgeItem);
  } catch (error: any) {
    throw new DatabaseError(`Failed to list skill items: ${error.message}`);
  }
}

export async function createKnowledgeCommit(
  projectId: string,
  message: string,
  changes: CommitChange[],
  dbConnection?: DbConnection
): Promise<KnowledgeCommit> {
  const conn = dbConnection || getDb();
  const now = new Date().toISOString();
  const id = generateId();

  const newCommit = {
    id,
    message,
    changes: compactCommitChanges(changes),
    createdAt: now,
  };

  // Which items this commit touched, written down while it is still known rather than
  // recovered later by substring match over the JSON that encodes it (K-48). One row per
  // item, deduplicated: a commit legitimately carries several changes to the same item.
  const touched = new Map<string, string>();
  for (const change of changes) {
    if (typeof change?.itemId === 'string' && !touched.has(change.itemId)) {
      touched.set(change.itemId, change.action ?? 'unknown');
    }
  }

  try {
    await conn.insert(schema.knowledgeCommits).values({
      id,
      message,
      changes: newCommit.changes,
      createdAt: now,
    });
    if (touched.size > 0) {
      await conn.insert(schema.knowledgeCommitItems).values(
        [...touched].map(([itemId, action]) => ({ commitId: id, itemId, action })),
      );
    }
    return newCommit;
  } catch (error: any) {
    throw new DatabaseError(`Failed to create commit: ${error.message}`);
  }
}

/**
 * `forget` carries what the caller knew and this function cannot: which policy fired, the
 * sentence explaining it, and the retrieval evidence that policy decided against. Optional so
 * an ordinary delete still works, defaulted so a caller that supplies nothing still leaves a
 * usable record rather than none.
 */
export type ForgetContext = {
  policy?: string;
  reason?: string;
  retrievalCount?: number;
  lastRetrievedAt?: string | null;
  bytes?: number | null;
};

export async function deleteKnowledgeItem(
  id: string,
  dbConnection?: DbConnection,
  forget?: ForgetContext,
): Promise<void> {
  const conn = dbConnection || getDb();
  try {
    // Read before the delete: the forget log records what was true at the instant of
    // destruction, and after the delete there is nothing left to read it from —
    // `knowledge_access` cascades away with the item.
    const doomed = await getKnowledgeItem(id, conn);
    const observed = forget?.retrievalCount === undefined ? await readAccessEvidence(id, conn) : null;
    const deletedAt = new Date().toISOString();

    await conn
      .delete(schema.knowledgeItems)
      .where(eq(schema.knowledgeItems.id, id));
    // Written through the same connection — and therefore the same transaction when GC
    // passes one — so a purge can never lose its tombstone.
    //
    // The literal `'purged'` stays. This string is written into every portable export and
    // merged by upsert on import, so widening it would change what leaves the machine and what
    // a peer can overwrite. The real reason goes to the local-only forget log instead.
    await recordTombstone(id, deletedAt, 'purged', conn);

    if (doomed) {
      await recordForgetLogEntry({
        itemId: id,
        title: doomed.title,
        category: doomed.category,
        tier: doomed.tier ?? null,
        status: doomed.status ?? null,
        deletedAt,
        policy: forget?.policy ?? FORGET_LOG_POLICY_MANUAL,
        reason: forget?.reason ?? 'Deleted without a recorded reason',
        retrievalCount: forget?.retrievalCount ?? observed?.retrievalCount ?? 0,
        lastRetrievedAt: forget?.lastRetrievedAt ?? observed?.lastRetrievedAt ?? null,
        ageDays: daysBetween(doomed.updatedAt, deletedAt),
        bytes: forget?.bytes ?? Buffer.byteLength(doomed.content ?? '', 'utf8'),
      }, conn);
    }
  } catch (error: any) {
    throw new DatabaseError(`Failed to delete knowledge item: ${error.message}`);
  }
}

/**
 * The retrieval evidence for one item, read on the delete path when the caller did not supply
 * it. GC already holds a whole-store summary and passes it, so this only runs for deletes that
 * arrive without one.
 *
 * It exists because defaulting to zero was worse than recording nothing: verified against a copy
 * of a real store, deleting the three MOST-retrieved items produced three log rows all reading
 * `retrievals=0`. An audit trail that states a false number is not a weaker audit trail, it is a
 * misleading one, and it would have been read as evidence those items were dead.
 */
async function readAccessEvidence(
  id: string,
  conn: any,
): Promise<{ retrievalCount: number; lastRetrievedAt: string | null }> {
  try {
    const rows = await conn.all(drizzleSql`
      SELECT COUNT(*) AS retrieval_count, MAX(retrieved_at) AS last_retrieved_at
      FROM knowledge_access
      WHERE knowledge_item_id = ${id} AND surface != 'feedback'
    `);
    const row = rows?.[0];
    return {
      retrievalCount: Number(row?.retrieval_count ?? 0),
      lastRetrievedAt: row?.last_retrieved_at ? String(row.last_retrieved_at) : null,
    };
  } catch {
    // Never fail a delete because its audit row could not be enriched.
    return { retrievalCount: 0, lastRetrievedAt: null };
  }
}

function daysBetween(from: string, to: string): number | null {
  const start = Date.parse(from);
  const end = Date.parse(to);
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  return Math.max(0, Math.floor((end - start) / 86_400_000));
}

export async function getKnowledgeCommits(projectId: string, limit = 50, dbConnection?: DbConnection): Promise<KnowledgeCommit[]> {
  const conn = dbConnection || getDb();
  try {
    const result = await conn
      .select()
      .from(schema.knowledgeCommits)
      .orderBy(desc(schema.knowledgeCommits.createdAt))
      .limit(limit);

    return result.map((row) => ({
      id: row.id,
      message: row.message,
      changes: parseCommitChanges(row.changes),
      createdAt: row.createdAt,
    })) as KnowledgeCommit[];
  } catch (error: any) {
    throw new DatabaseError(`Failed to fetch commits: ${error.message}`);
  }
}

export async function getSkillSteps(itemId: string, dbConnection?: DbConnection): Promise<SkillStep[]> {
  const conn = dbConnection || getDb();
  try {
    return await conn
      .select()
      .from(schema.skillSteps)
      .where(eq(schema.skillSteps.knowledgeItemId, itemId))
      .orderBy(schema.skillSteps.stepOrder);
  } catch (error: any) {
    throw new DatabaseError(`Failed to fetch skill steps: ${error.message}`);
  }
}

export async function getSkillMetadata(itemId: string, dbConnection?: DbConnection): Promise<SkillMetadata | null> {
  const conn = dbConnection || getDb();
  try {
    const result = await conn
      .select()
      .from(schema.skillMetadata)
      .where(eq(schema.skillMetadata.knowledgeItemId, itemId))
      .limit(1);
    
    return result[0] || null;
  } catch (error: any) {
    throw new DatabaseError(`Failed to fetch skill metadata: ${error.message}`);
  }
}

export async function updateSkillMetadata(itemId: string, updates: Partial<SkillMetadata>, dbConnection?: DbConnection): Promise<SkillMetadata> {
  const conn = dbConnection || getDb();
  try {
    await conn
      .update(schema.skillMetadata)
      .set(updates)
      .where(eq(schema.skillMetadata.knowledgeItemId, itemId));

    const result = await conn
      .select()
      .from(schema.skillMetadata)
      .where(eq(schema.skillMetadata.knowledgeItemId, itemId))
      .limit(1);

    if (!result[0]) {
      throw new Error(`Skill metadata not found for item ${itemId}`);
    }

    return result[0];
  } catch (error: any) {
    throw new DatabaseError(`Failed to update skill metadata: ${error.message}`);
  }
}
