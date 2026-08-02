import { Client } from '@libsql/client';
import { DEFAULT_FRESHNESS, hashKnowledgeContent, normalizeAffectedPaths } from './freshness.js';
import { assertSchemaSupported, stampSchemaVersion } from './schema-version.js';

const BASE_STATEMENTS = [
  // Must come first: journal_mode = WAL (and everything after it) takes locks, and a
  // connection's default busy_timeout is 0. Applied last, a concurrent writer at that
  // instant fails this whole bootstrap with SQLITE_BUSY instead of waiting for it.
  'PRAGMA busy_timeout = 5000;',
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
    tier TEXT NOT NULL DEFAULT 'asserted',
    tier_since TEXT,
    provenance TEXT,
    conflict_key TEXT, conflict_scope TEXT, conflict_exclusive INTEGER NOT NULL DEFAULT 0,
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

  `CREATE TABLE IF NOT EXISTS knowledge_assertions (
    id TEXT PRIMARY KEY,
    knowledge_item_id TEXT NOT NULL REFERENCES knowledge_items(id) ON DELETE CASCADE,
    content TEXT NOT NULL,
    valid_from TEXT NOT NULL,
    valid_to TEXT,
    recorded_at TEXT NOT NULL,
    replaced_at TEXT,
    confidence REAL NOT NULL,
    source_evidence_id TEXT REFERENCES evidence(id)
    ,conflict_key TEXT, conflict_scope TEXT, conflict_exclusive INTEGER NOT NULL DEFAULT 0
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
  `CREATE TABLE IF NOT EXISTS host_session_bindings (
    host TEXT NOT NULL, project_root TEXT NOT NULL, external_session_id TEXT NOT NULL, external_turn_id TEXT NOT NULL DEFAULT '',
    memory_session_id TEXT NOT NULL REFERENCES memory_sessions(id) ON DELETE CASCADE,
    active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)), successful_tool_count INTEGER NOT NULL DEFAULT 0,
    seen_commit_rowid INTEGER NOT NULL DEFAULT 0, seen_commit_initialized INTEGER NOT NULL DEFAULT 0,
    seen_peer_commits TEXT, updated_at TEXT NOT NULL,
    PRIMARY KEY (host, project_root, external_session_id, external_turn_id)
  );`,

  `CREATE TABLE IF NOT EXISTS mcp_call_commits (
    id TEXT PRIMARY KEY, project_root TEXT NOT NULL, tool_name TEXT NOT NULL,
    from_rowid INTEGER NOT NULL, to_rowid INTEGER NOT NULL, created_at TEXT NOT NULL
  );`,

  `CREATE TABLE IF NOT EXISTS knowledge_tombstones (
    id TEXT PRIMARY KEY,
    deleted_at TEXT NOT NULL,
    reason TEXT
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

  `CREATE TABLE IF NOT EXISTS code_files (path TEXT PRIMARY KEY, content_hash TEXT NOT NULL, updated_at TEXT NOT NULL);`,
  `CREATE TABLE IF NOT EXISTS code_symbols (locator TEXT PRIMARY KEY, file_path TEXT NOT NULL REFERENCES code_files(path) ON DELETE CASCADE, qualified_name TEXT NOT NULL, kind TEXT NOT NULL, start_line INTEGER NOT NULL, end_line INTEGER NOT NULL, signature TEXT, signature_hash TEXT);`,
  `CREATE TABLE IF NOT EXISTS code_symbol_edges (from_locator TEXT NOT NULL, to_locator TEXT NOT NULL, kind TEXT NOT NULL, PRIMARY KEY (from_locator, to_locator, kind));`,

  // Last git commit the automatic drift check ran against, per project root. Git history is
  // the thing that moves here, so a knowledge-commit rowid watermark cannot track it.
  `CREATE TABLE IF NOT EXISTS drift_state (
    project_root TEXT PRIMARY KEY,
    last_checked_commit TEXT NOT NULL,
    checked_at TEXT NOT NULL
  );`,

  `CREATE INDEX IF NOT EXISTS idx_ki_cat_status ON knowledge_items(category, status);`,
  `CREATE INDEX IF NOT EXISTS idx_ki_status ON knowledge_items(status);`,
  `CREATE INDEX IF NOT EXISTS idx_ki_updated ON knowledge_items(updated_at);`,
  `CREATE INDEX IF NOT EXISTS idx_code_symbols_file ON code_symbols(file_path);`,
  `CREATE INDEX IF NOT EXISTS idx_code_symbol_edges_target ON code_symbol_edges(to_locator);`,
  `CREATE INDEX IF NOT EXISTS idx_knowledge_assertions_item_validity ON knowledge_assertions(knowledge_item_id, valid_from, valid_to);`,
  `CREATE INDEX IF NOT EXISTS idx_knowledge_assertions_recorded ON knowledge_assertions(recorded_at);`,
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
  `CREATE INDEX IF NOT EXISTS idx_mcp_call_commits_lookup ON mcp_call_commits(project_root, tool_name, created_at);`,
  `CREATE INDEX IF NOT EXISTS idx_host_session_bindings_memory ON host_session_bindings(memory_session_id);`,
  `CREATE INDEX IF NOT EXISTS idx_host_session_bindings_session ON host_session_bindings(host, project_root, external_session_id, active);`,

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

  // Transcript index. Session transcripts are the lossless record underneath the
  // distilled atoms; these tables make them searchable without re-reading
  // hundreds of megabytes per query. Rows are derived data and safe to drop --
  // the source of truth is the .jsonl files on disk.
  `CREATE TABLE IF NOT EXISTS transcript_files (
    path TEXT PRIMARY KEY,
    project_dir TEXT NOT NULL,
    session_id TEXT NOT NULL,
    -- Transcripts are append-only, so a byte offset is a resume point: the next
    -- pass reads only what was added rather than the whole file again.
    bytes_indexed INTEGER NOT NULL DEFAULT 0,
    lines_indexed INTEGER NOT NULL DEFAULT 0,
    mtime_ms INTEGER NOT NULL DEFAULT 0,
    indexed_at TEXT NOT NULL,
    -- Captured while the indexer streams the file, at zero extra IO: the
    -- session's own title entries (a user rename beats a generated title), and
    -- the first real user ask as a one-line descriptor. External tools name
    -- sessions by filename or first prompt; the transcript already knows better.
    display_name TEXT,
    name_kind INTEGER NOT NULL DEFAULT 0,
    opening TEXT
  );`,
  `CREATE TABLE IF NOT EXISTS transcript_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_dir TEXT NOT NULL,
    session_id TEXT NOT NULL,
    line INTEGER NOT NULL,
    role TEXT NOT NULL,
    ts TEXT,
    weight REAL NOT NULL,
    len INTEGER NOT NULL,
    text TEXT NOT NULL
  );`,
  `CREATE INDEX IF NOT EXISTS idx_transcript_messages_project ON transcript_messages(project_dir);`,
  `CREATE INDEX IF NOT EXISTS idx_transcript_messages_session ON transcript_messages(session_id, line);`,
  // FTS5 rather than a hand-built inverted index: it ships BM25, and a posting
  // table written from JavaScript cost ~74 rows per message, which made cold
  // indexing of a large archive hours of work. External content keeps the text
  // in transcript_messages instead of storing it twice.
  `CREATE VIRTUAL TABLE IF NOT EXISTS transcript_fts USING fts5(
    text,
    content='transcript_messages',
    content_rowid='id'
  );`,
  // One int8-quantized vector per message, so a query can score the whole
  // archive rather than re-ranking what keyword search already found. Stored as
  // a BLOB: a JSON array of 384 floats is ~8x the bytes and has to be parsed
  // before it can be compared.
  `CREATE TABLE IF NOT EXISTS transcript_embeddings (
    message_id INTEGER PRIMARY KEY,
    model TEXT NOT NULL,
    vector BLOB NOT NULL
  );`,
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

/**
 * Tier (standing earned by use) and provenance (how the knowledge came to be believed).
 * Existing rows get tier 'asserted' -- nothing has confirmed them here -- and provenance
 * NULL, which is what a row written before the class existed means.
 */
async function ensureQualityColumns(client: Client): Promise<void> {
  if (!(await tableExists(client, 'knowledge_items'))) return;
  const columns = await tableColumns(client, 'knowledge_items');
  if (!columns.includes('tier')) {
    await client.execute("ALTER TABLE knowledge_items ADD COLUMN tier TEXT NOT NULL DEFAULT 'asserted';");
  }
  if (!columns.includes('tier_since')) {
    // Left NULL rather than backfilled to now: an existing row has never had its standing
    // reset, so every confirmation it already carries still belongs to its current tier.
    await client.execute('ALTER TABLE knowledge_items ADD COLUMN tier_since TEXT;');
  }
  if (!columns.includes('provenance')) {
    await client.execute('ALTER TABLE knowledge_items ADD COLUMN provenance TEXT;');
  }
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

async function ensureConflictColumns(client: Client): Promise<void> {
  for (const table of ['knowledge_items', 'knowledge_assertions']) {
    const columns = await tableColumns(client, table);
    if (!columns.includes('conflict_key')) await client.execute(`ALTER TABLE ${table} ADD COLUMN conflict_key TEXT;`);
    if (!columns.includes('conflict_scope')) await client.execute(`ALTER TABLE ${table} ADD COLUMN conflict_scope TEXT;`);
    if (!columns.includes('conflict_exclusive')) await client.execute(`ALTER TABLE ${table} ADD COLUMN conflict_exclusive INTEGER NOT NULL DEFAULT 0;`);
  }
  await client.execute('CREATE INDEX IF NOT EXISTS idx_knowledge_conflict_active ON knowledge_items(conflict_key, conflict_scope, status, conflict_exclusive);');
}

/**
 * Ownership and visibility for multi-repo workspaces.
 *
 * Created unconditionally. bootstrapSchema receives only a client -- no root, no config --
 * so it cannot know whether a workspace exists, which makes "create these only when one
 * does" inexpressible. Outside a workspace origin_repo stays NULL and visibility stays
 * 'repo', which is exactly today's behavior; the columns cost one page and keep a single
 * code path instead of a tableExists guard on every read.
 */
async function ensureOwnershipColumns(client: Client): Promise<void> {
  if (!(await tableExists(client, 'knowledge_items'))) return;
  const columns = await tableColumns(client, 'knowledge_items');
  if (!columns.includes('origin_repo')) {
    await client.execute('ALTER TABLE knowledge_items ADD COLUMN origin_repo TEXT;');
  }
  if (!columns.includes('visibility')) {
    await client.execute("ALTER TABLE knowledge_items ADD COLUMN visibility TEXT NOT NULL DEFAULT 'repo';");
  }
  // Lifecycle fingerprint, added here rather than in its own migration because it covers
  // origin_repo and visibility and would otherwise have to run after them anyway. Left NULL
  // for existing rows: a NULL local hash reads as "unknown", and `classifyIncomingItem`
  // treats an incoming hash against a NULL local one as divergent, so the first export that
  // carries one converges the row. Backfilling here would need every row's lifecycle fields
  // read and hashed in SQL, which SQLite cannot do.
  if (!columns.includes('lifecycle_hash')) {
    await client.execute('ALTER TABLE knowledge_items ADD COLUMN lifecycle_hash TEXT;');
  }
  // A NOT NULL default does not apply retroactively to rows written before the column
  // existed, and SQLite backfills an added NOT NULL column with its default only for the
  // ALTER itself -- a row inserted by an older client into an older table can still be null.
  await client.execute("UPDATE knowledge_items SET visibility = 'repo' WHERE visibility IS NULL OR visibility = '';");
  await client.execute('CREATE INDEX IF NOT EXISTS idx_knowledge_items_origin ON knowledge_items(origin_repo, visibility, status);');
}

async function ensureMemorySessionColumns(client: Client): Promise<void> {
  if (!(await tableExists(client, 'memory_sessions'))) return;
  const columns = await tableColumns(client, 'memory_sessions');
  if (!columns.includes('finalized_at')) await client.execute('ALTER TABLE memory_sessions ADD COLUMN finalized_at TEXT;');
  if (!columns.includes('promotion_status')) await client.execute("ALTER TABLE memory_sessions ADD COLUMN promotion_status TEXT NOT NULL DEFAULT 'pending';");
  if (!columns.includes('promotion_items')) await client.execute('ALTER TABLE memory_sessions ADD COLUMN promotion_items TEXT;');
  if (!columns.includes('promotion_error_code')) await client.execute('ALTER TABLE memory_sessions ADD COLUMN promotion_error_code TEXT;');
}

async function ensureTranscriptFileColumns(client: Client): Promise<void> {
  if (!(await tableExists(client, 'transcript_files'))) return;
  const columns = await tableColumns(client, 'transcript_files');
  if (!columns.includes('display_name')) {
    await client.execute('ALTER TABLE transcript_files ADD COLUMN display_name TEXT;');
  }
  if (!columns.includes('name_kind')) {
    await client.execute('ALTER TABLE transcript_files ADD COLUMN name_kind INTEGER NOT NULL DEFAULT 0;');
  }
  if (!columns.includes('opening')) {
    await client.execute('ALTER TABLE transcript_files ADD COLUMN opening TEXT;');
    // Names and openings are captured while streaming, so rows indexed before
    // these columns existed would stay nameless forever. The tables are derived
    // data; resetting the watermarks makes the next pass re-read and fill them.
    await client.execute("UPDATE transcript_files SET bytes_indexed = 0, lines_indexed = 0, indexed_at = '1970-01-01T00:00:00.000Z';");
    await client.execute('DELETE FROM transcript_embeddings;');
    await client.execute('DELETE FROM transcript_messages;');
    await client.execute("INSERT INTO transcript_fts(transcript_fts) VALUES('delete-all');");
  }
}

/**
 * Earlier builds cached vectors as JSON text in this column. They are a derived
 * cache of at most a few hundred re-ranked candidates, so they are dropped
 * rather than converted - the next embedding pass rewrites them quantized, and
 * leaving them would mean carrying a reader for a format nothing writes.
 */
async function ensureTranscriptEmbeddingFormat(client: Client): Promise<void> {
  if (!(await tableExists(client, 'transcript_embeddings'))) return;
  await client.execute("DELETE FROM transcript_embeddings WHERE typeof(vector) = 'text';");
}

async function ensureHostSessionBindingColumns(client: Client): Promise<void> {
  if (!(await tableExists(client, 'host_session_bindings'))) return;
  const columns = await tableColumns(client, 'host_session_bindings');
  if (!columns.includes('successful_tool_count')) {
    await client.execute('ALTER TABLE host_session_bindings ADD COLUMN successful_tool_count INTEGER NOT NULL DEFAULT 0;');
  }
  if (!columns.includes('seen_commit_rowid')) {
    await client.execute('ALTER TABLE host_session_bindings ADD COLUMN seen_commit_rowid INTEGER NOT NULL DEFAULT 0;');
  }
  // Carries what overloading `seen_commit_rowid = 0` used to: whether this row's watermark
  // has ever been set. Rows migrated here default to 0 and so adopt head on their first
  // tool event rather than reporting all history as new -- while a session legitimately
  // bound at zero commits is now marked initialized and does report its first commit.
  if (!columns.includes('seen_commit_initialized')) {
    await client.execute('ALTER TABLE host_session_bindings ADD COLUMN seen_commit_initialized INTEGER NOT NULL DEFAULT 0;');
  }
  // JSON map of peer repo name -> that peer's last seen commit rowid. Nullable rather
  // than defaulted to '{}': NULL means "never looked at peers", which adopts their heads
  // silently, exactly as seen_commit_rowid = 0 does for the local repo.
  if (!columns.includes('seen_peer_commits')) {
    await client.execute('ALTER TABLE host_session_bindings ADD COLUMN seen_peer_commits TEXT;');
  }
}

async function ensureCodeIndexColumns(client: Client): Promise<void> {
  if (!(await tableExists(client, 'code_symbols'))) return;
  const columns = await tableColumns(client, 'code_symbols');
  if (!columns.includes('signature_hash')) await client.execute('ALTER TABLE code_symbols ADD COLUMN signature_hash TEXT;');
  await client.execute('CREATE INDEX IF NOT EXISTS idx_code_symbol_edges_target ON code_symbol_edges(to_locator);');
}

async function backfillKnowledgeAssertions(client: Client): Promise<void> {
  await client.execute(`INSERT INTO knowledge_assertions (id, knowledge_item_id, content, valid_from, valid_to, recorded_at, replaced_at, confidence, source_evidence_id)
    SELECT lower(hex(randomblob(8))), id, content, created_at, NULL, updated_at, NULL, confidence, NULL
    FROM knowledge_items
    WHERE NOT EXISTS (SELECT 1 FROM knowledge_assertions WHERE knowledge_item_id = knowledge_items.id);`);
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
  // Before any migration touches the file. Running migrateLegacyProjectSchema against a
  // database written by a newer Knowl is the case this exists to prevent.
  await assertSchemaSupported(client, '(open database)');
  await migrateLegacyProjectSchema(client);
  await executeAll(client, SCHEMA_STATEMENTS);
  await ensureFreshnessColumns(client);
  await ensureQualityColumns(client);
  await ensureConflictColumns(client);
  await ensureOwnershipColumns(client);
  await ensureMemorySessionColumns(client);
  await ensureHostSessionBindingColumns(client);
  await ensureTranscriptFileColumns(client);
  await ensureTranscriptEmbeddingFormat(client);
  await ensureCodeIndexColumns(client);
  await backfillKnowledgeAssertions(client);
  await repairSkillForeignKeys(client);
  await stampSchemaVersion(client);
}
