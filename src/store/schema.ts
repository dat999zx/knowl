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
  freshness: text('freshness').notNull().default('fresh'), // 'fresh', 'stale', 'needs_review'
  confidence: real('confidence').notNull().default(1.0),
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

export const knowledgeEmbeddings = sqliteTable('knowledge_embeddings', {
  knowledgeItemId: text('knowledge_item_id').primaryKey().references(() => knowledgeItems.id, { onDelete: 'cascade' }),
  provider: text('provider').notNull(),
  model: text('model').notNull(),
  dimensions: integer('dimensions').notNull(),
  vector: text('vector', { mode: 'json' }).notNull(),
  updatedAt: text('updated_at').notNull(),
});
