import path from 'node:path';
import { createClient, Client } from '@libsql/client';
import { drizzle, LibSQLDatabase } from 'drizzle-orm/libsql';
import * as schema from './schema.js';
import { DatabaseError } from '../core/errors.js';

/** Shared type for database connection or transaction context. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type DbConnection = LibSQLDatabase<typeof schema> | Parameters<Parameters<LibSQLDatabase<typeof schema>['transaction']>[0]>[0];

let dbInstance: LibSQLDatabase<typeof schema> | null = null;
let clientInstance: Client | null = null;

/**
 * Initializes the database connection and runs schema bootstrap.
 */
export async function initDb(projectRoot: string): Promise<LibSQLDatabase<typeof schema>> {
  const dbPath = path.join(projectRoot, '.knowl', 'knowl.db');
  const fileUrl = `file:${dbPath}`;

  try {
    const client = createClient({ url: fileUrl });
    clientInstance = client;

    // Run schema bootstrap SQL directly on the raw client
    await bootstrapSchema(client);

    dbInstance = drizzle(client, { schema });
    return dbInstance;
  } catch (error: any) {
    throw new DatabaseError(`Failed to initialize database at "${dbPath}": ${error.message}`);
  }
}

/**
 * Gets the current database instance. Throws if not initialized.
 */
export function getDb(): LibSQLDatabase<typeof schema> {
  if (!dbInstance) {
    throw new DatabaseError('Database has not been initialized. Run initDb() first.');
  }
  return dbInstance;
}

/**
 * Closes the database connection.
 */
export async function closeDb(): Promise<void> {
  if (clientInstance) {
    clientInstance.close();
    clientInstance = null;
    dbInstance = null;
  }
}

/**
 * Directly bootstraps the schema using SQL commands.
 * This makes the binary fully self-contained and free from file migration dependencies.
 */
async function bootstrapSchema(client: Client): Promise<void> {
  const statements = [
    // Enable foreign keys
    'PRAGMA foreign_keys = ON;',
    
    // Enable WAL mode for performance
    'PRAGMA journal_mode = WAL;',

    // Projects table
    `CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      root_path TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );`,

    // Knowledge Items table
    `CREATE TABLE IF NOT EXISTS knowledge_items (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      category TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      reasoning TEXT,
      alternatives TEXT,
      tags TEXT,
      source TEXT,
      confidence REAL NOT NULL DEFAULT 1.0,
      superseded_by_id TEXT,
      version INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );`,

    // Full-text search table for BM25-ranked retrieval over knowledge items.
    `CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_items_fts USING fts5(
      item_id UNINDEXED,
      project_id UNINDEXED,
      category UNINDEXED,
      status UNINDEXED,
      title,
      content,
      reasoning,
      tags
    );`,

    // Knowledge Commits table
    `CREATE TABLE IF NOT EXISTS knowledge_commits (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      message TEXT NOT NULL,
      changes TEXT NOT NULL,
      created_at TEXT NOT NULL
    );`,

    // Skill Steps table
    `CREATE TABLE IF NOT EXISTS skill_steps (
      id TEXT PRIMARY KEY,
      knowledge_item_id TEXT NOT NULL REFERENCES knowledge_items(id) ON DELETE CASCADE,
      step_order INTEGER NOT NULL,
      instruction TEXT NOT NULL,
      created_at TEXT NOT NULL
    );`,

    // Skill Metadata table
    `CREATE TABLE IF NOT EXISTS skill_metadata (
      knowledge_item_id TEXT PRIMARY KEY REFERENCES knowledge_items(id) ON DELETE CASCADE,
      usage_count INTEGER NOT NULL DEFAULT 0,
      success_count INTEGER NOT NULL DEFAULT 0,
      last_used TEXT
    );`,

    // Indexes
    `CREATE INDEX IF NOT EXISTS idx_ki_project_cat_status ON knowledge_items(project_id, category, status);`,
    `CREATE INDEX IF NOT EXISTS idx_ki_project_status ON knowledge_items(project_id, status);`,
    `CREATE INDEX IF NOT EXISTS idx_ki_project_updated ON knowledge_items(project_id, updated_at);`,

    // Keep the FTS table synchronized with knowledge_items.
    `CREATE TRIGGER IF NOT EXISTS knowledge_items_fts_ai AFTER INSERT ON knowledge_items BEGIN
      INSERT INTO knowledge_items_fts(item_id, project_id, category, status, title, content, reasoning, tags)
      VALUES (new.id, new.project_id, new.category, new.status, new.title, new.content, coalesce(new.reasoning, ''), coalesce(new.tags, ''));
    END;`,

    `CREATE TRIGGER IF NOT EXISTS knowledge_items_fts_ad AFTER DELETE ON knowledge_items BEGIN
      DELETE FROM knowledge_items_fts WHERE item_id = old.id;
    END;`,

    `CREATE TRIGGER IF NOT EXISTS knowledge_items_fts_au AFTER UPDATE ON knowledge_items BEGIN
      DELETE FROM knowledge_items_fts WHERE item_id = old.id;
      INSERT INTO knowledge_items_fts(item_id, project_id, category, status, title, content, reasoning, tags)
      VALUES (new.id, new.project_id, new.category, new.status, new.title, new.content, coalesce(new.reasoning, ''), coalesce(new.tags, ''));
    END;`,

    // Backfill/repair for databases created before FTS existed.
    `DELETE FROM knowledge_items_fts;`,
    `INSERT INTO knowledge_items_fts(item_id, project_id, category, status, title, content, reasoning, tags)
      SELECT id, project_id, category, status, title, content, coalesce(reasoning, ''), coalesce(tags, '')
      FROM knowledge_items;`
  ];

  for (const statement of statements) {
    await client.execute(statement);
  }
}
