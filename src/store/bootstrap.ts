import { Client } from '@libsql/client';
import { DEFAULT_FRESHNESS, hashKnowledgeContent, normalizeAffectedPaths } from './freshness.js';

const BASE_STATEMENTS = [
  'PRAGMA foreign_keys = ON;',
  'PRAGMA journal_mode = WAL;',
];

const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS knowledge_items (
    id TEXT PRIMARY KEY,
    category TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    reasoning TEXT,
    alternatives TEXT,
    tags TEXT,
    source TEXT,
    source_commit TEXT,
    affected_paths TEXT,
    content_hash TEXT,
    freshness TEXT NOT NULL DEFAULT 'fresh',
    confidence REAL NOT NULL DEFAULT 1.0,
    superseded_by_id TEXT,
    version INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );`,

  `CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_items_fts USING fts5(
    item_id UNINDEXED,
    category UNINDEXED,
    status UNINDEXED,
    title,
    content,
    reasoning,
    tags
  );`,

  `CREATE TABLE IF NOT EXISTS knowledge_commits (
    id TEXT PRIMARY KEY,
    message TEXT NOT NULL,
    changes TEXT NOT NULL,
    created_at TEXT NOT NULL
  );`,

  `CREATE TABLE IF NOT EXISTS evidence (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    locator TEXT NOT NULL,
    content_hash TEXT,
    excerpt TEXT,
    observed_at TEXT NOT NULL,
    metadata TEXT
  );`,

  `CREATE TABLE IF NOT EXISTS knowledge_evidence (
    knowledge_item_id TEXT NOT NULL REFERENCES knowledge_items(id) ON DELETE CASCADE,
    evidence_id TEXT NOT NULL REFERENCES evidence(id) ON DELETE CASCADE,
    relationship TEXT NOT NULL CHECK (relationship IN ('supports', 'contradicts', 'derived_from')),
    PRIMARY KEY (knowledge_item_id, evidence_id)
  );`,

  `CREATE TABLE IF NOT EXISTS knowledge_access (
    id TEXT PRIMARY KEY,
    knowledge_item_id TEXT NOT NULL REFERENCES knowledge_items(id) ON DELETE CASCADE,
    query_fingerprint TEXT,
    retrieved_at TEXT NOT NULL,
    surface TEXT NOT NULL,
    rank INTEGER NOT NULL,
    used INTEGER,
    useful INTEGER,
    caused_correction INTEGER
  );`,

  `CREATE TABLE IF NOT EXISTS memory_sessions (
    id TEXT PRIMARY KEY, agent TEXT, title TEXT NOT NULL, query TEXT, status TEXT NOT NULL CHECK (status IN ('active', 'finished', 'failed', 'abandoned', 'recovered')),
    started_at TEXT NOT NULL, last_heartbeat_at TEXT NOT NULL, finished_at TEXT, baseline_commit TEXT, expires_at TEXT NOT NULL,
    finalized_at TEXT, promotion_status TEXT NOT NULL DEFAULT 'pending', promotion_items TEXT, promotion_error_code TEXT
  );`,
  `CREATE TABLE IF NOT EXISTS memory_session_events (
    id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES memory_sessions(id) ON DELETE CASCADE,
    type TEXT NOT NULL CHECK (type IN ('start', 'command', 'test', 'error', 'git', 'decision', 'checkpoint', 'stop')),
    payload TEXT NOT NULL, observed_at TEXT NOT NULL, expires_at TEXT NOT NULL
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
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    dimensions INTEGER NOT NULL,
    vector TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );`,

  `CREATE INDEX IF NOT EXISTS idx_ki_cat_status ON knowledge_items(category, status);`,
  `CREATE INDEX IF NOT EXISTS idx_ki_status ON knowledge_items(status);`,
  `CREATE INDEX IF NOT EXISTS idx_ki_updated ON knowledge_items(updated_at);`,
  `CREATE INDEX IF NOT EXISTS idx_ke_model ON knowledge_embeddings(provider, model);`,
  `CREATE INDEX IF NOT EXISTS idx_evidence_locator ON evidence(locator);`,
  `CREATE INDEX IF NOT EXISTS idx_evidence_type ON evidence(type);`,
  `CREATE INDEX IF NOT EXISTS idx_evidence_observed ON evidence(observed_at);`,
  `CREATE INDEX IF NOT EXISTS idx_knowledge_evidence_relationship ON knowledge_evidence(relationship);`,
  `CREATE INDEX IF NOT EXISTS idx_knowledge_access_item_time ON knowledge_access(knowledge_item_id, retrieved_at);`,
  `CREATE INDEX IF NOT EXISTS idx_knowledge_access_fingerprint ON knowledge_access(query_fingerprint);`,
  `CREATE INDEX IF NOT EXISTS idx_memory_sessions_status_heartbeat ON memory_sessions(status, last_heartbeat_at);`,
  `CREATE INDEX IF NOT EXISTS idx_memory_sessions_expiry ON memory_sessions(expires_at);`,
  `CREATE INDEX IF NOT EXISTS idx_memory_session_events_expiry ON memory_session_events(expires_at);`,
  `CREATE INDEX IF NOT EXISTS idx_memory_session_events_session ON memory_session_events(session_id);`,

  `CREATE TRIGGER IF NOT EXISTS knowledge_items_fts_ai AFTER INSERT ON knowledge_items BEGIN
    INSERT INTO knowledge_items_fts(item_id, category, status, title, content, reasoning, tags)
    VALUES (new.id, new.category, new.status, new.title, new.content, coalesce(new.reasoning, ''), coalesce(new.tags, ''));
  END;`,

  `CREATE TRIGGER IF NOT EXISTS knowledge_items_fts_ad AFTER DELETE ON knowledge_items BEGIN
    DELETE FROM knowledge_items_fts WHERE item_id = old.id;
  END;`,

  `CREATE TRIGGER IF NOT EXISTS knowledge_items_fts_au AFTER UPDATE ON knowledge_items BEGIN
    DELETE FROM knowledge_items_fts WHERE item_id = old.id;
    INSERT INTO knowledge_items_fts(item_id, category, status, title, content, reasoning, tags)
    VALUES (new.id, new.category, new.status, new.title, new.content, coalesce(new.reasoning, ''), coalesce(new.tags, ''));
  END;`,

  `INSERT INTO knowledge_items_fts(item_id, category, status, title, content, reasoning, tags)
    SELECT id, category, status, title, content, coalesce(reasoning, ''), coalesce(tags, '')
    FROM knowledge_items
    WHERE NOT EXISTS (SELECT 1 FROM knowledge_items_fts LIMIT 1)
      AND EXISTS (SELECT 1 FROM knowledge_items LIMIT 1);`,
];

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

function normalizeCommitChanges(value: unknown): string {
  return JSON.stringify(stripProjectFields(unwrapJson(value)));
}

function parseStringArray(value: unknown): string[] | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(String(value));
    return Array.isArray(parsed) ? parsed.filter(entry => typeof entry === 'string') : null;
  } catch {
    return null;
  }
}

async function executeAll(client: Client, statements: string[]) {
  for (const statement of statements) {
    await client.execute(statement);
  }
}

async function tableExists(client: Client, name: string): Promise<boolean> {
  const result = await client.execute({
    sql: `SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`,
    args: [name],
  });
  return result.rows.length > 0;
}

async function tableColumns(client: Client, name: string): Promise<string[]> {
  const result = await client.execute(`PRAGMA table_info(${name})`);
  return result.rows.map(row => String(row.name));
}

async function dropLegacySearchArtifacts(client: Client) {
  await client.execute('DROP TRIGGER IF EXISTS knowledge_items_fts_ai;');
  await client.execute('DROP TRIGGER IF EXISTS knowledge_items_fts_ad;');
  await client.execute('DROP TRIGGER IF EXISTS knowledge_items_fts_au;');
  await client.execute('DROP TABLE IF EXISTS knowledge_items_fts;');
}

async function foreignKeyTargets(client: Client, table: string): Promise<string[]> {
  if (!(await tableExists(client, table))) {
    return [];
  }

  const rows = await client.execute(`PRAGMA foreign_key_list(${table})`);
  return rows.rows.map(row => String(row.table));
}

async function repairSkillForeignKeys(client: Client): Promise<void> {
  const staleSteps = (await foreignKeyTargets(client, 'skill_steps'))
    .some(target => target !== 'knowledge_items');
  const staleMetadata = (await foreignKeyTargets(client, 'skill_metadata'))
    .some(target => target !== 'knowledge_items');

  if (!staleSteps && !staleMetadata) {
    return;
  }

  await client.execute('PRAGMA foreign_keys = OFF;');

  if (staleSteps) {
    await client.execute('ALTER TABLE skill_steps RENAME TO skill_steps_stale_fk;');
    await client.execute(`CREATE TABLE skill_steps (
      id TEXT PRIMARY KEY,
      knowledge_item_id TEXT NOT NULL REFERENCES knowledge_items(id) ON DELETE CASCADE,
      step_order INTEGER NOT NULL,
      instruction TEXT NOT NULL,
      created_at TEXT NOT NULL
    );`);
    await client.execute(`
      INSERT INTO skill_steps (id, knowledge_item_id, step_order, instruction, created_at)
      SELECT id, knowledge_item_id, step_order, instruction, created_at
      FROM skill_steps_stale_fk;
    `);
    await client.execute('DROP TABLE skill_steps_stale_fk;');
  }

  if (staleMetadata) {
    await client.execute('ALTER TABLE skill_metadata RENAME TO skill_metadata_stale_fk;');
    await client.execute(`CREATE TABLE skill_metadata (
      knowledge_item_id TEXT PRIMARY KEY REFERENCES knowledge_items(id) ON DELETE CASCADE,
      usage_count INTEGER NOT NULL DEFAULT 0,
      success_count INTEGER NOT NULL DEFAULT 0,
      last_used TEXT
    );`);
    await client.execute(`
      INSERT INTO skill_metadata (knowledge_item_id, usage_count, success_count, last_used)
      SELECT knowledge_item_id, usage_count, success_count, last_used
      FROM skill_metadata_stale_fk;
    `);
    await client.execute('DROP TABLE skill_metadata_stale_fk;');
  }

  await client.execute('PRAGMA foreign_keys = ON;');
}

async function ensureFreshnessColumns(client: Client): Promise<void> {
  if (!(await tableExists(client, 'knowledge_items'))) {
    return;
  }

  const columns = await tableColumns(client, 'knowledge_items');
  if (!columns.includes('source_commit')) {
    await client.execute('ALTER TABLE knowledge_items ADD COLUMN source_commit TEXT;');
  }
  if (!columns.includes('affected_paths')) {
    await client.execute('ALTER TABLE knowledge_items ADD COLUMN affected_paths TEXT;');
  }
  if (!columns.includes('content_hash')) {
    await client.execute('ALTER TABLE knowledge_items ADD COLUMN content_hash TEXT;');
  }
  if (!columns.includes('freshness')) {
    await client.execute(`ALTER TABLE knowledge_items ADD COLUMN freshness TEXT NOT NULL DEFAULT '${DEFAULT_FRESHNESS}';`);
  }

  await client.execute('CREATE INDEX IF NOT EXISTS idx_ki_freshness ON knowledge_items(freshness);');

  await client.execute(`UPDATE knowledge_items SET freshness = '${DEFAULT_FRESHNESS}' WHERE freshness IS NULL OR freshness = '';`);

  const rows = await client.execute(`
    SELECT id, title, content, reasoning, source, affected_paths
    FROM knowledge_items
    WHERE content_hash IS NULL OR content_hash = '';
  `);

  for (const row of rows.rows) {
    const affectedPaths = normalizeAffectedPaths(parseStringArray(row.affected_paths));
    await client.execute({
      sql: 'UPDATE knowledge_items SET content_hash = ?, affected_paths = ? WHERE id = ?',
      args: [
        hashKnowledgeContent({
          title: String(row.title),
          content: String(row.content),
          reasoning: row.reasoning ? String(row.reasoning) : null,
          source: row.source ? String(row.source) : null,
          affectedPaths,
        }),
        affectedPaths ? JSON.stringify(affectedPaths) : null,
        String(row.id),
      ],
    });
  }
}

async function ensureMemorySessionColumns(client: Client): Promise<void> {
  if (!(await tableExists(client, 'memory_sessions'))) return;
  const columns = await tableColumns(client, 'memory_sessions');
  if (!columns.includes('finalized_at')) await client.execute('ALTER TABLE memory_sessions ADD COLUMN finalized_at TEXT;');
  if (!columns.includes('promotion_status')) await client.execute("ALTER TABLE memory_sessions ADD COLUMN promotion_status TEXT NOT NULL DEFAULT 'pending';");
  if (!columns.includes('promotion_items')) await client.execute('ALTER TABLE memory_sessions ADD COLUMN promotion_items TEXT;');
  if (!columns.includes('promotion_error_code')) await client.execute('ALTER TABLE memory_sessions ADD COLUMN promotion_error_code TEXT;');
}

async function migrateLegacyProjectSchema(client: Client): Promise<void> {
  if (!(await tableExists(client, 'knowledge_items'))) {
    return;
  }

  const columns = await tableColumns(client, 'knowledge_items');
  if (!columns.includes('project_id')) {
    return;
  }

  await client.execute('PRAGMA foreign_keys = OFF;');
  await dropLegacySearchArtifacts(client);

  await client.execute('ALTER TABLE knowledge_items RENAME TO knowledge_items_legacy;');

  const hasLegacyCommits = await tableExists(client, 'knowledge_commits');
  if (hasLegacyCommits) {
    await client.execute('ALTER TABLE knowledge_commits RENAME TO knowledge_commits_legacy;');
  }

  const hasLegacyEmbeddings = await tableExists(client, 'knowledge_embeddings');
  if (hasLegacyEmbeddings) {
    await client.execute('ALTER TABLE knowledge_embeddings RENAME TO knowledge_embeddings_legacy;');
  }

  const hasLegacySkillSteps = await tableExists(client, 'skill_steps');
  if (hasLegacySkillSteps) {
    await client.execute('ALTER TABLE skill_steps RENAME TO skill_steps_legacy;');
  }

  const hasLegacySkillMetadata = await tableExists(client, 'skill_metadata');
  if (hasLegacySkillMetadata) {
    await client.execute('ALTER TABLE skill_metadata RENAME TO skill_metadata_legacy;');
  }

  await executeAll(client, SCHEMA_STATEMENTS);

  await client.execute(`
    INSERT INTO knowledge_items (
      id, category, status, title, content, reasoning, alternatives, tags, source,
      confidence, superseded_by_id, version, created_at, updated_at
    )
    SELECT
      id, category, status, title, content, reasoning, alternatives, tags, source,
      confidence, superseded_by_id, version, created_at, updated_at
    FROM knowledge_items_legacy;
  `);

  if (hasLegacyCommits) {
    const commits = await client.execute('SELECT id, message, changes, created_at FROM knowledge_commits_legacy ORDER BY created_at ASC;');
    for (const row of commits.rows) {
      await client.execute({
        sql: 'INSERT INTO knowledge_commits (id, message, changes, created_at) VALUES (?, ?, ?, ?)',
        args: [
          String(row.id),
          String(row.message),
          normalizeCommitChanges(row.changes),
          String(row.created_at),
        ],
      });
    }
  }

  if (hasLegacyEmbeddings) {
    await client.execute(`
      INSERT INTO knowledge_embeddings (
        knowledge_item_id, provider, model, dimensions, vector, updated_at
      )
      SELECT knowledge_item_id, provider, model, dimensions, vector, updated_at
      FROM knowledge_embeddings_legacy;
    `);
  }

  if (hasLegacySkillSteps) {
    await client.execute(`
      INSERT INTO skill_steps (
        id, knowledge_item_id, step_order, instruction, created_at
      )
      SELECT id, knowledge_item_id, step_order, instruction, created_at
      FROM skill_steps_legacy;
    `);
  }

  if (hasLegacySkillMetadata) {
    await client.execute(`
      INSERT INTO skill_metadata (
        knowledge_item_id, usage_count, success_count, last_used
      )
      SELECT knowledge_item_id, usage_count, success_count, last_used
      FROM skill_metadata_legacy;
    `);
  }

  await client.execute('DROP TABLE knowledge_items_legacy;');
  if (hasLegacyCommits) {
    await client.execute('DROP TABLE knowledge_commits_legacy;');
  }
  if (hasLegacyEmbeddings) {
    await client.execute('DROP TABLE knowledge_embeddings_legacy;');
  }
  if (hasLegacySkillSteps) {
    await client.execute('DROP TABLE skill_steps_legacy;');
  }
  if (hasLegacySkillMetadata) {
    await client.execute('DROP TABLE skill_metadata_legacy;');
  }
  await client.execute('DROP TABLE IF EXISTS projects;');
  await client.execute('PRAGMA foreign_keys = ON;');
}

/**
 * Directly bootstraps the schema using SQL commands.
 * This keeps the binary self-contained and free from file migration dependencies.
 */
export async function bootstrapSchema(client: Client): Promise<void> {
  await executeAll(client, BASE_STATEMENTS);
  await migrateLegacyProjectSchema(client);
  await executeAll(client, SCHEMA_STATEMENTS);
  await ensureFreshnessColumns(client);
  await ensureMemorySessionColumns(client);
  await repairSkillForeignKeys(client);
}
