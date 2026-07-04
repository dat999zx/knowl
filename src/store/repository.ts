import { eq, and, desc, sql } from 'drizzle-orm';
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
  KnowledgeStatus
} from '../core/types.js';
import { DatabaseError } from '../core/errors.js';

// Helper to generate IDs without external packages
function generateId(): string {
  return crypto.randomUUID().replace(/-/g, '').substring(0, 16);
}

export async function createProject(rootPath: string, name: string, description?: string, dbConnection?: DbConnection): Promise<Project> {
  const conn = dbConnection || getDb();
  const now = new Date().toISOString();
  const id = generateId();

  const newProject = {
    id,
    name,
    description: description || null,
    rootPath,
    createdAt: now,
    updatedAt: now,
  };

  try {
    await conn.insert(schema.projects).values(newProject);
    return newProject;
  } catch (error: any) {
    throw new DatabaseError(`Failed to create project: ${error.message}`);
  }
}

export async function getProjectByRootPath(rootPath: string, dbConnection?: DbConnection): Promise<Project | null> {
  const conn = dbConnection || getDb();
  try {
    const result = await conn
      .select()
      .from(schema.projects)
      .where(eq(schema.projects.rootPath, rootPath))
      .limit(1);
    
    return result[0] || null;
  } catch (error: any) {
    throw new DatabaseError(`Failed to find project by root path: ${error.message}`);
  }
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
    confidence?: number;
  },
  steps?: string[],
  dbConnection?: DbConnection
): Promise<KnowledgeItem> {
  const conn = dbConnection || getDb();
  const now = new Date().toISOString();
  const id = generateId();

  const newItem = {
    id,
    projectId,
    category: item.category,
    status: 'active' as KnowledgeStatus,
    title: item.title,
    content: item.content,
    reasoning: item.reasoning || null,
    alternatives: item.alternatives || null,
    tags: item.tags || null,
    source: item.source || null,
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

    return {
      ...result[0],
      category: result[0].category as KnowledgeCategory,
      status: result[0].status as KnowledgeStatus,
      alternatives: result[0].alternatives as string[] | null,
      tags: result[0].tags as string[] | null,
    };
  } catch (error: any) {
    throw new DatabaseError(`Failed to get knowledge item: ${error.message}`);
  }
}

export async function updateKnowledgeItem(
  id: string,
  updates: Partial<Omit<KnowledgeItem, 'id' | 'projectId' | 'createdAt' | 'updatedAt'>>,
  steps?: string[],
  dbConnection?: DbConnection
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

    const dbUpdates = {
      ...updates,
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

    return {
      ...updated[0],
      category: updated[0].category as KnowledgeCategory,
      status: updated[0].status as KnowledgeStatus,
      alternatives: updated[0].alternatives as string[] | null,
      tags: updated[0].tags as string[] | null,
    };
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
    throw new DatabaseError(`Failed to update knowledge item: ${error.message}`);
  }
}

export async function listKnowledgeItems(projectId: string, dbConnection?: DbConnection): Promise<KnowledgeItem[]> {
  const conn = dbConnection || getDb();
  try {
    const result = await conn
      .select()
      .from(schema.knowledgeItems)
      .where(eq(schema.knowledgeItems.projectId, projectId));

    return result.map((row) => ({
      ...row,
      category: row.category as KnowledgeCategory,
      status: row.status as KnowledgeStatus,
      alternatives: row.alternatives as string[] | null,
      tags: row.tags as string[] | null,
    }));
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
    projectId,
    message,
    changes,
    createdAt: now,
  };

  try {
    await conn.insert(schema.knowledgeCommits).values({
      id,
      projectId,
      message,
      changes: JSON.stringify(changes),
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
      .where(eq(schema.knowledgeCommits.projectId, projectId))
      .orderBy(desc(schema.knowledgeCommits.createdAt))
      .limit(limit);

    return result.map((row) => ({
      id: row.id,
      projectId: row.projectId,
      message: row.message,
      changes: typeof row.changes === 'string' ? JSON.parse(row.changes) : row.changes,
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
