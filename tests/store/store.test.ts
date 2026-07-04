import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { initDb, closeDb } from '../../src/store/database.js';
import * as repo from '../../src/store/repository.js';
import * as queries from '../../src/store/queries.js';

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
});
