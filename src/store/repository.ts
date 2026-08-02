import path from 'node:path';
import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import { getDb, withClientTransaction } from './database.js';
import type { DbConnection } from './database.js';
import * as schema from './schema.js';
import { recordTombstone } from './tombstones.js';
import { normalizeConflictFields } from './conflicts.js';
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
import { KnowledgeValidationError, validateKnowledgeWrite } from '../core/knowledge-validation.js';

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
    alternatives: row.alternatives as string[] | null,
    tags: row.tags as string[] | null,
    affectedPaths: row.affectedPaths as string[] | null,
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
  const conn = dbConnection || getDb();
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
    conflictKey: null, conflictScope: null, // replaced below; the boundary owns both columns
    ...normalizeConflictFields({ conflictKey: item.conflictKey ?? null, conflictScope: item.conflictScope ?? null }),
    conflictExclusive: item.conflictExclusive ?? false,
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
  const conn = dbConnection || getDb();
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
    const merged = {
      title: updates.title ?? current[0].title,
      content: updates.content ?? current[0].content,
      reasoning: updates.reasoning ?? current[0].reasoning,
      source: updates.source ?? current[0].source,
      affectedPaths,
    };
    validateKnowledgeWrite(merged, validationOptions);
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

    const tierIsSetExplicitly = updates.tier !== undefined;
    const tierIsReset = !tierIsSetExplicitly
      && (updates.content !== undefined || updates.title !== undefined);

    // Identity goes through the boundary here too. Spreading `updates` verbatim is exactly
    // how raw keys used to reach the column, and a raw key is unreachable forever after.
    const conflictFields = normalizeConflictFields(updates);

    const dbUpdates = {
      ...updates,
      ...conflictFields,
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
        recordedAt: now, replacedAt: null, confidence: updates.confidence ?? current[0].confidence, sourceEvidenceId: null, conflictKey: conflictFields.conflictKey ?? current[0].conflictKey, conflictScope: conflictFields.conflictScope ?? current[0].conflictScope, conflictExclusive: updates.conflictExclusive ?? current[0].conflictExclusive,
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

  try {
    await conn.insert(schema.knowledgeCommits).values({
      id,
      message,
      changes: newCommit.changes,
      createdAt: now,
    });
    return newCommit;
  } catch (error: any) {
    throw new DatabaseError(`Failed to create commit: ${error.message}`);
  }
}

export async function deleteKnowledgeItem(id: string, dbConnection?: DbConnection): Promise<void> {
  const conn = dbConnection || getDb();
  try {
    await conn
      .delete(schema.knowledgeItems)
      .where(eq(schema.knowledgeItems.id, id));
    // Written through the same connection — and therefore the same transaction when GC
    // passes one — so a purge can never lose its tombstone.
    await recordTombstone(id, new Date().toISOString(), 'purged', conn);
  } catch (error: any) {
    throw new DatabaseError(`Failed to delete knowledge item: ${error.message}`);
  }
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
