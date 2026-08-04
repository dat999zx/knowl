import { index, primaryKey, sqliteTable, text, integer, real } from 'drizzle-orm/sqlite-core';

export const knowledgeItems = sqliteTable('knowledge_items', {
  id: text('id').primaryKey(),
  category: text('category').notNull(), // 'fact', 'decision', 'goal', 'constraint', 'architecture', 'state', 'skill'
  status: text('status').notNull().default('active'), // 'active', 'deprecated', 'rejected', 'archived', 'superseded'
  title: text('title').notNull(),
  content: text('content').notNull(),
  reasoning: text('reasoning'),
  alternatives: text('alternatives', { mode: 'json' }), // string[]
  tags: text('tags', { mode: 'json' }), // string[]
  source: text('source'),
  sourceCommit: text('source_commit'),
  affectedPaths: text('affected_paths', { mode: 'json' }), // string[]
  contentHash: text('content_hash'),
  /**
   * Fingerprint of the fields that decide lifecycle rather than content: status, freshness,
   * supersession, owner, visibility. Separate from `content_hash` because the two diverge
   * independently, and an import classifying on content alone skipped every lifecycle change.
   */
  lifecycleHash: text('lifecycle_hash'),
  /** Owning repo in a workspace; NULL outside one. The only lifecycle key. */
  originRepo: text('origin_repo'),
  /** 'repo' | 'workspace'. Logical scope, persisted independently of which file holds the row. */
  visibility: text('visibility').notNull().default('repo'),
  freshness: text('freshness').notNull().default('fresh'), // 'fresh', 'stale', 'needs_review'
  confidence: real('confidence').notNull().default(1.0),
  /** Standing earned by confirmed use: 'asserted' | 'verified'. Not part of lifecycleHash. */
  tier: text('tier').notNull().default('asserted'),
  /**
   * When the current tier was established. Confirmations are counted from here, so a reset
   * genuinely restarts the climb instead of inheriting the history that a correction or a
   * rewording just invalidated. NULL on rows predating the column: they have never had
   * standing reset, so their whole history is still theirs to count.
   */
  tierSince: text('tier_since'),
  /** 'observed' | 'user_stated' | 'inferred'; NULL on rows written before the column existed. */
  provenance: text('provenance'),
  conflictKey: text('conflict_key'), conflictScope: text('conflict_scope', { mode: 'json' }), conflictExclusive: integer('conflict_exclusive', { mode: 'boolean' }).notNull().default(false),
  supersededById: text('superseded_by_id'),
  version: integer('version').notNull().default(1),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const knowledgeCommits = sqliteTable('knowledge_commits', {
  id: text('id').primaryKey(),
  message: text('message').notNull(),
  changes: text('changes', { mode: 'json' }).notNull(), // CommitChange[]
  createdAt: text('created_at').notNull(),
});

/**
 * Which items a commit touched. An index over `knowledgeCommits.changes` (K-48), never a
 * second source of truth -- readers use it to pick commits and still parse `changes`.
 */
export const knowledgeCommitItems = sqliteTable('knowledge_commit_items', {
  commitId: text('commit_id').notNull().references(() => knowledgeCommits.id, { onDelete: 'cascade' }),
  itemId: text('item_id').notNull(),
  action: text('action').notNull(),
}, (table) => [
  primaryKey({ columns: [table.commitId, table.itemId] }),
  index('idx_knowledge_commit_items_item').on(table.itemId, table.action, table.commitId),
]);

export const knowledgeAssertions = sqliteTable('knowledge_assertions', {
  id: text('id').primaryKey(),
  knowledgeItemId: text('knowledge_item_id').notNull().references(() => knowledgeItems.id, { onDelete: 'cascade' }),
  content: text('content').notNull(),
  validFrom: text('valid_from').notNull(),
  validTo: text('valid_to'),
  recordedAt: text('recorded_at').notNull(),
  replacedAt: text('replaced_at'),
  confidence: real('confidence').notNull(),
  sourceEvidenceId: text('source_evidence_id'),
  conflictKey: text('conflict_key'), conflictScope: text('conflict_scope', { mode: 'json' }), conflictExclusive: integer('conflict_exclusive', { mode: 'boolean' }).notNull().default(false),
}, (table) => [index('idx_knowledge_assertions_item_validity').on(table.knowledgeItemId, table.validFrom, table.validTo), index('idx_knowledge_assertions_recorded').on(table.recordedAt)]);

export const evidence = sqliteTable('evidence', {
  id: text('id').primaryKey(),
  type: text('type').notNull(),
  locator: text('locator').notNull(),
  contentHash: text('content_hash'),
  excerpt: text('excerpt'),
  observedAt: text('observed_at').notNull(),
  metadata: text('metadata', { mode: 'json' }),
}, (table) => [
  index('idx_evidence_locator').on(table.locator),
  index('idx_evidence_type').on(table.type),
  index('idx_evidence_observed').on(table.observedAt),
]);

export const knowledgeEvidence = sqliteTable('knowledge_evidence', {
  knowledgeItemId: text('knowledge_item_id').notNull().references(() => knowledgeItems.id, { onDelete: 'cascade' }),
  evidenceId: text('evidence_id').notNull().references(() => evidence.id, { onDelete: 'cascade' }),
  relationship: text('relationship').notNull(),
}, (table) => [
  primaryKey({ columns: [table.knowledgeItemId, table.evidenceId] }),
  index('idx_knowledge_evidence_relationship').on(table.relationship),
]);

export const skillSteps = sqliteTable('skill_steps', {
  id: text('id').primaryKey(),
  knowledgeItemId: text('knowledge_item_id').notNull().references(() => knowledgeItems.id, { onDelete: 'cascade' }),
  stepOrder: integer('step_order').notNull(),
  instruction: text('instruction').notNull(),
  createdAt: text('created_at').notNull(),
});

export const knowledgeAccess = sqliteTable('knowledge_access', {
  id: text('id').primaryKey(),
  knowledgeItemId: text('knowledge_item_id').notNull().references(() => knowledgeItems.id, { onDelete: 'cascade' }),
  queryFingerprint: text('query_fingerprint'),
  retrievedAt: text('retrieved_at').notNull(),
  surface: text('surface').notNull(),
  rank: integer('rank').notNull(),
  used: integer('used', { mode: 'boolean' }),
  useful: integer('useful', { mode: 'boolean' }),
  causedCorrection: integer('caused_correction', { mode: 'boolean' }),
}, (table) => [
  index('idx_knowledge_access_item_time').on(table.knowledgeItemId, table.retrievedAt),
  index('idx_knowledge_access_fingerprint').on(table.queryFingerprint),
]);

export const skillMetadata = sqliteTable('skill_metadata', {
  knowledgeItemId: text('knowledge_item_id').primaryKey().references(() => knowledgeItems.id, { onDelete: 'cascade' }),
  usageCount: integer('usage_count').notNull().default(0),
  successCount: integer('success_count').notNull().default(0),
  lastUsed: text('last_used'),
});

export const memorySessions = sqliteTable('memory_sessions', {
  id: text('id').primaryKey(), agent: text('agent'), title: text('title').notNull(), query: text('query'), status: text('status').notNull(),
  startedAt: text('started_at').notNull(), lastHeartbeatAt: text('last_heartbeat_at').notNull(), finishedAt: text('finished_at'), baselineCommit: text('baseline_commit'), expiresAt: text('expires_at').notNull(),
}, (table) => [index('idx_memory_sessions_status_heartbeat').on(table.status, table.lastHeartbeatAt), index('idx_memory_sessions_expiry').on(table.expiresAt)]);

export const memorySessionEvents = sqliteTable('memory_session_events', {
  id: text('id').primaryKey(), sessionId: text('session_id').notNull().references(() => memorySessions.id, { onDelete: 'cascade' }),
  type: text('type').notNull(), payload: text('payload', { mode: 'json' }).notNull(), observedAt: text('observed_at').notNull(), expiresAt: text('expires_at').notNull(),
}, (table) => [index('idx_memory_session_events_expiry').on(table.expiresAt), index('idx_memory_session_events_session').on(table.sessionId)]);

export const hostSessionBindings = sqliteTable('host_session_bindings', {
  host: text('host').notNull(),
  projectRoot: text('project_root').notNull(),
  externalSessionId: text('external_session_id').notNull(),
  externalTurnId: text('external_turn_id').notNull().default(''),
  memorySessionId: text('memory_session_id').notNull().references(() => memorySessions.id, { onDelete: 'cascade' }),
  active: integer('active', { mode: 'boolean' }).notNull().default(true),
  successfulToolCount: integer('successful_tool_count').notNull().default(0),
  seenCommitRowid: integer('seen_commit_rowid').notNull().default(0),
  updatedAt: text('updated_at').notNull(),
}, (table) => [
  primaryKey({ columns: [table.host, table.projectRoot, table.externalSessionId, table.externalTurnId] }),
  index('idx_host_session_bindings_memory').on(table.memorySessionId),
  index('idx_host_session_bindings_session').on(table.host, table.projectRoot, table.externalSessionId, table.active),
]);

export const knowledgeEmbeddings = sqliteTable('knowledge_embeddings', {
  knowledgeItemId: text('knowledge_item_id').primaryKey().references(() => knowledgeItems.id, { onDelete: 'cascade' }),
  provider: text('provider').notNull(),
  model: text('model').notNull(),
  /** Nullable: rows written before the column existed are backfilled at bootstrap. */
  profileFingerprint: text('profile_fingerprint'),
  dimensions: integer('dimensions').notNull(),
  vector: text('vector', { mode: 'json' }).notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const codeFiles = sqliteTable('code_files', {
  path: text('path').primaryKey(),
  contentHash: text('content_hash').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const codeSymbols = sqliteTable('code_symbols', {
  locator: text('locator').primaryKey(),
  filePath: text('file_path').notNull().references(() => codeFiles.path, { onDelete: 'cascade' }),
  qualifiedName: text('qualified_name').notNull(),
  kind: text('kind').notNull(),
  startLine: integer('start_line').notNull(),
  endLine: integer('end_line').notNull(),
  signature: text('signature'),
  signatureHash: text('signature_hash'),
}, (table) => [index('idx_code_symbols_file').on(table.filePath)]);

export const codeSymbolEdges = sqliteTable('code_symbol_edges', {
  fromLocator: text('from_locator').notNull(),
  toLocator: text('to_locator').notNull(),
  kind: text('kind').notNull(),
}, (table) => [
  primaryKey({ columns: [table.fromLocator, table.toLocator, table.kind] }),
  index('idx_code_symbol_edges_target').on(table.toLocator),
]);
