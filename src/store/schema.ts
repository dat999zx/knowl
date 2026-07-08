import { sqliteTable, text, integer, real } from 'drizzle-orm/sqlite-core';

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
  confidence: real('confidence').notNull().default(1.0),
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

export const skillSteps = sqliteTable('skill_steps', {
  id: text('id').primaryKey(),
  knowledgeItemId: text('knowledge_item_id').notNull().references(() => knowledgeItems.id, { onDelete: 'cascade' }),
  stepOrder: integer('step_order').notNull(),
  instruction: text('instruction').notNull(),
  createdAt: text('created_at').notNull(),
});

export const skillMetadata = sqliteTable('skill_metadata', {
  knowledgeItemId: text('knowledge_item_id').primaryKey().references(() => knowledgeItems.id, { onDelete: 'cascade' }),
  usageCount: integer('usage_count').notNull().default(0),
  successCount: integer('success_count').notNull().default(0),
  lastUsed: text('last_used'),
});

export const knowledgeEmbeddings = sqliteTable('knowledge_embeddings', {
  knowledgeItemId: text('knowledge_item_id').primaryKey().references(() => knowledgeItems.id, { onDelete: 'cascade' }),
  provider: text('provider').notNull(),
  model: text('model').notNull(),
  dimensions: integer('dimensions').notNull(),
  vector: text('vector', { mode: 'json' }).notNull(),
  updatedAt: text('updated_at').notNull(),
});
