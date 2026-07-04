import { Client } from '@libsql/client';

/**
 * Directly bootstraps the schema using SQL commands.
 * This keeps the binary self-contained and free from file migration dependencies.
 */
export async function bootstrapSchema(client: Client): Promise<void> {
  const statements = [
    'PRAGMA foreign_keys = ON;',
    'PRAGMA journal_mode = WAL;',

    `CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      root_path TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );`,

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

    `CREATE TABLE IF NOT EXISTS knowledge_commits (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      message TEXT NOT NULL,
      changes TEXT NOT NULL,
      created_at TEXT NOT NULL
    );`,

    `CREATE TABLE IF NOT EXISTS skill_steps (
      id TEXT PRIMARY KEY,
      knowledge_item_id TEXT NOT NULL REFERENCES knowledge_items(id) ON DELETE CASCADE,
      step_order INTEGER NOT NULL,
      instruction TEXT NOT NULL,
      created_at TEXT NOT NULL
    );`,

    `CREATE TABLE IF NOT EXISTS skill_metadata (
      knowledge_item_id TEXT PRIMARY KEY REFERENCES knowledge_items(id) ON DELETE CASCADE,
      usage_count INTEGER NOT NULL DEFAULT 0,
      success_count INTEGER NOT NULL DEFAULT 0,
      last_used TEXT
    );`,

    `CREATE TABLE IF NOT EXISTS knowledge_embeddings (
      knowledge_item_id TEXT PRIMARY KEY REFERENCES knowledge_items(id) ON DELETE CASCADE,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      dimensions INTEGER NOT NULL,
      vector TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );`,

    `CREATE INDEX IF NOT EXISTS idx_ki_project_cat_status ON knowledge_items(project_id, category, status);`,
    `CREATE INDEX IF NOT EXISTS idx_ki_project_status ON knowledge_items(project_id, status);`,
    `CREATE INDEX IF NOT EXISTS idx_ki_project_updated ON knowledge_items(project_id, updated_at);`,
    `CREATE INDEX IF NOT EXISTS idx_ke_project_model ON knowledge_embeddings(project_id, provider, model);`,

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

    `INSERT INTO knowledge_items_fts(item_id, project_id, category, status, title, content, reasoning, tags)
      SELECT id, project_id, category, status, title, content, coalesce(reasoning, ''), coalesce(tags, '')
      FROM knowledge_items
      WHERE NOT EXISTS (SELECT 1 FROM knowledge_items_fts LIMIT 1)
        AND EXISTS (SELECT 1 FROM knowledge_items LIMIT 1);`,
  ];

  for (const statement of statements) {
    await client.execute(statement);
  }
}
