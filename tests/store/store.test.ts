import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { initDb, closeDb } from '../../src/store/database.js';
import * as repo from '../../src/store/repository.js';
import * as queries from '../../src/store/queries.js';
import { queryKnowledgeForAgent } from '../../src/store/agent-query.js';
import { searchKnowledgeEmbeddings, upsertKnowledgeEmbedding } from '../../src/store/vector.js';
import { reindexKnowledgeEmbeddings } from '../../src/store/vector-index.js';

const TEST_ROOT = path.resolve('./.knowl-test');

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
      limit: 10,
    });

    expect(matches.some(match => match.item.id === item.id)).toBe(true);
  });
});
