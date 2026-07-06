import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { initDb, closeDb, getDb } from '../../src/store/database.js';
import * as repo from '../../src/store/repository.js';
import { applyKnowledgeGc, previewKnowledgeGc } from '../../src/store/gc.js';
import * as queries from '../../src/store/queries.js';
import { formatRecentContextToMarkdown } from '../../src/core/format.js';
import { queryKnowledgeForAgent } from '../../src/store/agent-query.js';
import { getRecentContext } from '../../src/store/recent-context.js';
import { searchKnowledgeEmbeddings, upsertKnowledgeEmbedding } from '../../src/store/vector.js';
import { reindexKnowledgeEmbeddings } from '../../src/store/vector-index.js';

const TEST_ROOT = path.resolve('./.knowl-test');

async function setKnowledgeItemUpdatedAt(itemId: string, updatedAt: string): Promise<void> {
  await getDb().run(sql`UPDATE knowledge_items SET updated_at = ${updatedAt} WHERE id = ${itemId}`);
}

describe('Storage Layer', () => {
  beforeAll(async () => {
    // Ensure fresh test directory on startup
    try {
      await fs.rm(TEST_ROOT, { recursive: true, force: true });
    } catch {
      // Ignore
    }
    await fs.mkdir(path.join(TEST_ROOT, '.knowl'), { recursive: true });
    await initDb(TEST_ROOT);
  });

  afterAll(async () => {
    await closeDb();
    try {
      await fs.rm(TEST_ROOT, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  it('should create and retrieve a project', async () => {
    const project = await repo.createProject(TEST_ROOT, 'Test Project', 'A test description');
    expect(project).toBeDefined();
    expect(project.name).toBe('Test Project');
    expect(project.rootPath).toBe(TEST_ROOT);

    const retrieved = await repo.getProjectByRootPath(TEST_ROOT);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.id).toBe(project.id);
  });

  it('should create and retrieve knowledge items', async () => {
    const project = await repo.getProjectByRootPath(TEST_ROOT);
    expect(project).not.toBeNull();
    const projectId = project!.id;

    const item = await repo.createKnowledgeItem(projectId, {
      category: 'decision',
      title: 'Use PostgreSQL',
      content: 'We decide to use PostgreSQL for relational integrity.',
      reasoning: 'Need joins',
      alternatives: ['MongoDB', 'MySQL'],
      tags: ['database', 'backend'],
    });

    expect(item.id).toBeDefined();
    expect(item.category).toBe('decision');
    expect(item.title).toBe('Use PostgreSQL');
    expect(item.alternatives).toEqual(['MongoDB', 'MySQL']);

    const retrieved = await repo.getKnowledgeItem(item.id);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.title).toBe('Use PostgreSQL');
    expect(retrieved!.alternatives).toEqual(['MongoDB', 'MySQL']);
  });

  it('should support updating knowledge items', async () => {
    const project = await repo.getProjectByRootPath(TEST_ROOT);
    const projectId = project!.id;

    const item = await repo.createKnowledgeItem(projectId, {
      category: 'state',
      title: 'Implementing login',
      content: 'Current work on auth flow.',
    });

    const updated = await repo.updateKnowledgeItem(item.id, {
      content: 'Auth flow completed with JWT.',
      status: 'active',
    });

    expect(updated.version).toBe(2);
    expect(updated.content).toBe('Auth flow completed with JWT.');
  });

  it('should retrieve items hierarchically', async () => {
    const project = await repo.getProjectByRootPath(TEST_ROOT);
    const projectId = project!.id;

    const hierarchy = await queries.getHierarchicalKnowledge(projectId);
    expect(hierarchy.state.length).toBeGreaterThan(0);
    expect(hierarchy.knowledge.length).toBeGreaterThan(0);
  });

  it('should query knowledge base with filters', async () => {
    const project = await repo.getProjectByRootPath(TEST_ROOT);
    const projectId = project!.id;

    // Search by query string
    const results = await queries.queryKnowledgeBase(projectId, {
      query: 'PostgreSQL',
    });
    expect(results.length).toBe(1);
    expect(results[0].title).toBe('Use PostgreSQL');

    // Search by tag
    const tagResults = await queries.queryKnowledgeBase(projectId, {
      tags: ['backend'],
    });
    expect(tagResults.length).toBe(1);
  });

  it('should use full-text search to find relevant knowledge when query wording differs', async () => {
    const project = await repo.getProjectByRootPath(TEST_ROOT);
    const projectId = project!.id;

    await repo.createKnowledgeItem(projectId, {
      category: 'fact',
      title: 'Project database uses SQLite',
      content: 'The server persists durable data with SQLite through the sqlite-jdbc driver.',
      tags: ['database', 'sqlite', 'persistence'],
    });

    const results = await queries.queryKnowledgeBase(projectId, {
      query: 'what db does this project use',
      category: 'fact',
    });

    expect(results.length).toBeGreaterThan(0);
    expect(results[0].title).toBe('Project database uses SQLite');
  });

  it('should treat category as a ranking hint for agent text queries', async () => {
    const project = await repo.getProjectByRootPath(TEST_ROOT);
    const projectId = project!.id;

    await repo.createKnowledgeItem(projectId, {
      category: 'fact',
      title: 'Database persistence fact',
      content: 'The project database persistence uses SQLite with a local data.db file.',
      tags: ['database', 'persistence'],
    });

    await repo.createKnowledgeItem(projectId, {
      category: 'architecture',
      title: 'Database persistence architecture',
      content: 'The database persistence layer is wrapped by server DAO classes.',
      tags: ['database', 'persistence'],
    });

    const architectureHintResults = await queryKnowledgeForAgent(projectId, {
      query: 'database persistence',
      category: 'architecture',
    });

    expect(architectureHintResults.length).toBeGreaterThanOrEqual(2);
    expect(architectureHintResults[0].category).toBe('architecture');
    expect(architectureHintResults.some(item => item.category === 'fact')).toBe(true);

    const constraintHintResults = await queryKnowledgeForAgent(projectId, {
      query: 'database persistence',
      category: 'constraint',
    });

    expect(constraintHintResults.length).toBeGreaterThanOrEqual(2);
    expect(constraintHintResults.some(item => item.category === 'fact')).toBe(true);
    expect(constraintHintResults.some(item => item.category === 'architecture')).toBe(true);
  });

  it('should prefer newer active knowledge when agent query relevance is similar', async () => {
    const project = await repo.getProjectByRootPath(TEST_ROOT);
    const projectId = project!.id;

    const older = await repo.createKnowledgeItem(projectId, {
      category: 'state',
      title: 'Recency ranking alpha beta older',
      content: 'recency-ranking-alpha-beta equivalent retrieval text',
      tags: ['recency-ranking-alpha-beta'],
    });
    await setKnowledgeItemUpdatedAt(older.id, '2026-01-01T00:00:00.000Z');

    const newer = await repo.createKnowledgeItem(projectId, {
      category: 'state',
      title: 'Recency ranking alpha beta newer',
      content: 'recency-ranking-alpha-beta equivalent retrieval text',
      tags: ['recency-ranking-alpha-beta'],
    });
    await setKnowledgeItemUpdatedAt(newer.id, '2026-07-01T00:00:00.000Z');

    const results = await queryKnowledgeForAgent(projectId, {
      query: 'recency-ranking-alpha-beta',
      status: 'active',
      limit: 2,
    });

    expect(results.map(item => item.id)).toEqual([newer.id, older.id]);
  });

  it('should keep stronger relevance ahead of weak newer matches', async () => {
    const project = await repo.getProjectByRootPath(TEST_ROOT);
    const projectId = project!.id;

    const strongOlder = await repo.createKnowledgeItem(projectId, {
      category: 'fact',
      title: 'Strong relevance gamma delta exact',
      content: 'strong-relevance-gamma-delta strong-relevance-gamma-delta strong-relevance-gamma-delta exact agent answer.',
      tags: ['strong-relevance-gamma-delta'],
    });
    await setKnowledgeItemUpdatedAt(strongOlder.id, '2026-01-01T00:00:00.000Z');

    const weakNewer = await repo.createKnowledgeItem(projectId, {
      category: 'fact',
      title: 'Weak newer gamma note',
      content: 'strong-relevance-gamma-delta appears once in a broader unrelated note.',
      tags: ['weak-newer-gamma-note'],
    });
    await setKnowledgeItemUpdatedAt(weakNewer.id, '2026-07-01T00:00:00.000Z');

    const results = await queryKnowledgeForAgent(projectId, {
      query: 'strong-relevance-gamma-delta',
      status: 'active',
      limit: 2,
    });

    expect(results[0].id).toBe(strongOlder.id);
    expect(results.some(item => item.id === weakNewer.id)).toBe(true);
  });

  it('should return recent active knowledge and commits for session continuity', async () => {
    const project = await repo.getProjectByRootPath(TEST_ROOT) ?? await repo.createProject(TEST_ROOT, 'Test Project');
    const projectId = project!.id;

    const older = await repo.createKnowledgeItem(projectId, {
      category: 'state',
      title: 'Older active work',
      content: 'Older active work should appear after newer work.',
      tags: ['session'],
    });
    await setKnowledgeItemUpdatedAt(older.id, '2099-01-01T00:00:00.000Z');

    const newer = await repo.createKnowledgeItem(projectId, {
      category: 'state',
      title: 'Newest active work',
      content: 'Newest active work should appear first.',
      tags: ['session'],
    });
    await setKnowledgeItemUpdatedAt(newer.id, '2099-01-02T00:00:00.000Z');

    const archived = await repo.createKnowledgeItem(projectId, {
      category: 'state',
      title: 'Archived old work',
      content: 'Archived work should not appear in recent active context.',
      tags: ['session'],
    });
    await repo.updateKnowledgeItem(archived.id, {
      status: 'archived',
    } as any);

    const olderCommit = await repo.createKnowledgeCommit(projectId, 'Older session commit', []);
    const newerCommit = await repo.createKnowledgeCommit(projectId, 'Newest session commit', []);
    const db = getDb();
    await db.run(sql`UPDATE knowledge_commits SET created_at = '2099-01-01T00:00:00.000Z' WHERE id = ${olderCommit.id}`);
    await db.run(sql`UPDATE knowledge_commits SET created_at = '2099-01-02T00:00:00.000Z' WHERE id = ${newerCommit.id}`);

    const context = await getRecentContext(projectId, {
      itemLimit: 2,
      commitLimit: 2,
    });

    expect(context.items.map(item => item.id)).toEqual([newer.id, older.id]);
    expect(context.items.some(item => item.id === archived.id)).toBe(false);
    expect(context.commits).toHaveLength(2);
    expect(context.commits[0].message).toBe('Newest session commit');
  });

  it('should format recent context for quick session resume', async () => {
    const markdown = formatRecentContextToMarkdown({
      items: [
        {
          id: 'item1',
          projectId: 'project1',
          category: 'state',
          status: 'active',
          title: 'Current plan',
          content: 'Implement recent context before query ranking.',
          reasoning: null,
          alternatives: null,
          tags: ['session'],
          source: null,
          confidence: 1,
          supersededById: null,
          version: 1,
          createdAt: '2026-07-01T00:00:00.000Z',
          updatedAt: '2026-07-02T00:00:00.000Z',
        },
      ],
      commits: [
        {
          id: 'commit1',
          projectId: 'project1',
          message: 'Store recent context plan',
          changes: [],
          createdAt: '2026-07-02T01:00:00.000Z',
        },
      ],
    });

    expect(markdown).toContain('KNOWL - RECENT SESSION CONTEXT');
    expect(markdown).toContain('Current plan');
    expect(markdown).toContain('Implement recent context before query ranking.');
    expect(markdown).toContain('Store recent context plan');
  });

  it('should store and search knowledge embeddings in SQLite', async () => {
    const project = await repo.getProjectByRootPath(TEST_ROOT);
    const projectId = project!.id;

    const authItem = await repo.createKnowledgeItem(projectId, {
      category: 'architecture',
      title: 'Authentication flow',
      content: 'Login validates credentials and issues a session token.',
      tags: ['auth'],
    });
    const storageItem = await repo.createKnowledgeItem(projectId, {
      category: 'architecture',
      title: 'Storage layer',
      content: 'SQLite stores project memory and search indexes.',
      tags: ['storage'],
    });

    await upsertKnowledgeEmbedding({
      projectId,
      knowledgeItemId: authItem.id,
      provider: 'test',
      model: 'unit-vector',
      dimensions: 3,
      vector: [1, 0, 0],
    });
    await upsertKnowledgeEmbedding({
      projectId,
      knowledgeItemId: storageItem.id,
      provider: 'test',
      model: 'unit-vector',
      dimensions: 3,
      vector: [0, 1, 0],
    });

    const results = await searchKnowledgeEmbeddings(projectId, {
      vector: [0.9, 0.1, 0],
      status: 'active',
      limit: 1,
    });

    expect(results).toHaveLength(1);
    expect(results[0].item.title).toBe('Authentication flow');
    expect(results[0].score).toBeGreaterThan(0.9);
  });

  it('should merge BM25 and optional vector hits for agent queries', async () => {
    const project = await repo.getProjectByRootPath(TEST_ROOT);
    const projectId = project!.id;

    const keywordItem = await repo.createKnowledgeItem(projectId, {
      category: 'fact',
      title: 'BM25 payment fact',
      content: 'Payment settlement uses wallet transactions and searchable keyword text.',
      tags: ['payment'],
    });
    const semanticItem = await repo.createKnowledgeItem(projectId, {
      category: 'architecture',
      title: 'Semantic runtime architecture',
      content: 'Live session state is coordinated outside persistent storage.',
      tags: ['runtime'],
    });

    await upsertKnowledgeEmbedding({
      projectId,
      knowledgeItemId: semanticItem.id,
      provider: 'test',
      model: 'unit-vector',
      dimensions: 3,
      vector: [0, 1, 0],
    });

    const results = await queryKnowledgeForAgent(projectId, {
      query: 'payment settlement',
      status: 'active',
      limit: 3,
      vector: {
        enabled: true,
        provider: 'test',
        model: 'unit-vector',
        embedding: [0, 0.95, 0.05],
      },
    });

    expect(results.some(item => item.id === keywordItem.id)).toBe(true);
    expect(results.some(item => item.id === semanticItem.id)).toBe(true);
  });

  it('should reindex active knowledge embeddings with an injected embedder', async () => {
    const project = await repo.getProjectByRootPath(TEST_ROOT);
    const projectId = project!.id;

    const item = await repo.createKnowledgeItem(projectId, {
      category: 'fact',
      title: 'Vector reindex target',
      content: 'This item should receive an embedding.',
      tags: ['vector'],
    });

    const result = await reindexKnowledgeEmbeddings(projectId, {
      provider: 'test',
      model: 'fake-embedder',
      embed: async (texts) => texts.map(() => [0.25, 0.75]),
    });

    expect(result.indexed).toBeGreaterThan(0);

    const matches = await searchKnowledgeEmbeddings(projectId, {
      vector: [0.25, 0.75],
      provider: 'test',
      model: 'fake-embedder',
      limit: 100,
    });

    expect(matches.some(match => match.item.id === item.id)).toBe(true);
  });

  it('should preview duplicate purge, stale state archive, and stale archive compression', async () => {
    const project = await repo.getProjectByRootPath(TEST_ROOT);
    const projectId = project!.id;

    const olderDuplicate = await repo.createKnowledgeItem(projectId, {
      category: 'fact',
      title: 'SQLite storage',
      content: 'Knowl stores durable memory in SQLite.',
      confidence: 0.6,
      tags: ['database'],
    });
    await setKnowledgeItemUpdatedAt(olderDuplicate.id, '2026-01-01T00:00:00.000Z');

    await repo.createKnowledgeItem(projectId, {
      category: 'fact',
      title: 'SQLite storage',
      content: 'Knowl stores durable memory in SQLite.',
      confidence: 0.9,
      tags: ['database'],
    });

    const staleState = await repo.createKnowledgeItem(projectId, {
      category: 'state',
      title: 'Old migration task',
      content: 'Working on schema migration sequencing.',
    });
    await setKnowledgeItemUpdatedAt(staleState.id, '2026-01-15T00:00:00.000Z');

    const archived = await repo.createKnowledgeItem(projectId, {
      category: 'state',
      title: 'Archived debug log',
      content: 'This is a long debug note that should be compressed after it becomes archival context only. '.repeat(4).trim(),
      reasoning: 'Detailed state snapshot',
    });
    await repo.updateKnowledgeItem(archived.id, {
      status: 'archived',
    } as any);
    await setKnowledgeItemUpdatedAt(archived.id, '2026-01-10T00:00:00.000Z');

    const preview = await previewKnowledgeGc(projectId, {
      now: '2026-07-05T00:00:00.000Z',
      staleStateDays: 0,
      compressArchivedDays: 0,
    });

    expect(preview.summary.purge).toBeGreaterThanOrEqual(1);
    expect(preview.summary.archive).toBeGreaterThanOrEqual(1);
    expect(preview.summary.compress).toBeGreaterThanOrEqual(1);
    expect(preview.candidates.some(candidate => candidate.itemId === olderDuplicate.id && candidate.action === 'purge')).toBe(true);
    expect(preview.candidates.some(candidate => candidate.itemId === staleState.id && candidate.action === 'archive')).toBe(true);
    expect(preview.candidates.some(candidate => candidate.itemId === archived.id && candidate.action === 'compress')).toBe(true);
  });

  it('should apply gc changes transactionally and keep archived items out of default retrieval', async () => {
    const project = await repo.getProjectByRootPath(TEST_ROOT);
    const projectId = project!.id;

    const olderDuplicate = await repo.createKnowledgeItem(projectId, {
      category: 'fact',
      title: 'Duplicate auth fact',
      content: 'Session tokens are persisted for authentication.',
      confidence: 0.4,
    });
    await setKnowledgeItemUpdatedAt(olderDuplicate.id, '2026-01-01T00:00:00.000Z');

    const newerDuplicate = await repo.createKnowledgeItem(projectId, {
      category: 'fact',
      title: 'Duplicate auth fact',
      content: 'Session tokens are persisted for authentication.',
      confidence: 0.9,
    });

    const staleState = await repo.createKnowledgeItem(projectId, {
      category: 'state',
      title: 'Old rollout state',
      content: 'Rollout paused pending validation.',
    });
    await setKnowledgeItemUpdatedAt(staleState.id, '2026-01-02T00:00:00.000Z');

    const archived = await repo.createKnowledgeItem(projectId, {
      category: 'state',
      title: 'Verbose archived state',
      content: 'Archived operational note with a lot of detail that should be shrunk for cold storage. '.repeat(4).trim(),
      reasoning: 'Long-form archive',
    });
    await repo.updateKnowledgeItem(archived.id, {
      status: 'archived',
    } as any);
    await setKnowledgeItemUpdatedAt(archived.id, '2026-01-03T00:00:00.000Z');

    const result = await applyKnowledgeGc(projectId, {
      now: '2026-07-05T00:00:00.000Z',
      staleStateDays: 0,
      compressArchivedDays: 0,
    });

    expect(result.summary.purge).toBeGreaterThanOrEqual(1);
    expect(result.summary.archive).toBeGreaterThanOrEqual(1);
    expect(result.summary.compress).toBeGreaterThanOrEqual(1);

    const deleted = await repo.getKnowledgeItem(olderDuplicate.id);
    expect(deleted).toBeNull();

    const stillThere = await repo.getKnowledgeItem(newerDuplicate.id);
    expect(stillThere).not.toBeNull();

    const archivedState = await repo.getKnowledgeItem(staleState.id);
    expect(archivedState!.status).toBe('archived');

    const compressed = await repo.getKnowledgeItem(archived.id);
    expect(compressed!.content.length).toBeLessThan(archived.content.length);
    expect(compressed!.content).toContain('Compressed summary:');

    const defaultResults = await queries.queryKnowledgeBase(projectId, {
      query: 'rollout paused',
    });
    expect(defaultResults.some(item => item.id === staleState.id)).toBe(false);

    const archivedResults = await queries.queryKnowledgeBase(projectId, {
      query: 'rollout paused',
      status: 'archived',
    });
    expect(archivedResults.some(item => item.id === staleState.id)).toBe(true);

    const commits = await repo.getKnowledgeCommits(projectId, 10);
    expect(commits.some(commit => commit.message === 'Apply knowledge GC')).toBe(true);
  });
});
