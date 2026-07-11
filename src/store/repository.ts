import path from 'node:path';
import { eq, desc } from 'drizzle-orm';
import { getDb } from './database.js';
import type { DbConnection } from './database.js';
import * as schema from './schema.js';
import {
  Project,
  KnowledgeItem,
  KnowledgeCommit,
  SkillStep,
  SkillMetadata,
  CommitChange,
  KnowledgeCategory,
  KnowledgeFreshness,
  KnowledgeStatus,
  KnowledgeWriteValidationOptions,
} from '../core/types.js';
import { DatabaseError } from '../core/errors.js';
import { DEFAULT_FRESHNESS, hashKnowledgeContent, normalizeAffectedPaths } from './freshness.js';
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

  const newItem = {
    id,
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
    freshness: item.freshness || DEFAULT_FRESHNESS,
    confidence: item.confidence ?? 1.0,
    supersededById: null,
    version: 1,
    createdAt: now,
    updatedAt: now,
  };

  const operation = async (exec: any) => {
    await exec.insert(schema.knowledgeItems).values(newItem);

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
      await conn.transaction(async (tx) => {
        await operation(tx);
      });
    }
    return newItem as KnowledgeItem;
  } catch (error: any) {
    throw new DatabaseError(`Failed to create knowledge item: ${error.message}`);
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

    const dbUpdates = {
      ...updates,
      ...(updates.affectedPaths !== undefined ? { affectedPaths } : {}),
      ...(shouldRefreshHash ? { contentHash: hashKnowledgeContent(merged) } : {}),
      version: nextVersion,
      updatedAt: now,
    };

    await exec
      .update(schema.knowledgeItems)
      .set(dbUpdates)
      .where(eq(schema.knowledgeItems.id, id));

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
      return await conn.transaction(async (tx) => {
        return await operation(tx);
      });
    }
  } catch (error: any) {
    if (error instanceof KnowledgeValidationError) throw error;
    throw new DatabaseError(`Failed to update knowledge item: ${error.message}`);
  }
}

export async function listKnowledgeItems(projectId: string, dbConnection?: DbConnection): Promise<KnowledgeItem[]> {
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
