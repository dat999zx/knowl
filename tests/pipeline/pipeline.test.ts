import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { initDb, closeDb } from '../../src/store/database.js';
import * as repo from '../../src/store/repository.js';
import { runPipeline } from '../../src/pipeline/pipeline.js';
import { runFilter } from '../../src/pipeline/filter.js';
import { getHierarchicalKnowledge } from '../../src/store/queries.js';
import { ProjectConfig } from '../../src/core/types.js';

// Mock the AI provider functions
vi.mock('../../src/ai/provider.js', () => {
  return {
    initAI: vi.fn(),
    filterInput: vi.fn(),
    extractKnowledge: vi.fn(),
    compareKnowledge: vi.fn(),
    askQuestion: vi.fn(),
    deriveTruth: vi.fn(),
  };
});

import { filterInput, extractKnowledge, compareKnowledge, deriveTruth } from '../../src/ai/provider.js';

const TEST_ROOT = path.resolve('./.knowl-pipeline-test');
const MOCK_CONFIG: ProjectConfig = {
  version: 1,
  ai: {
    provider: 'openai',
    model: 'gpt-4o-mini',
    apiKey: 'mock-key',
  },
  security: {
    rejectSecrets: true,
    secretPatterns: [],
  },
};

describe('Pipeline Integration', () => {
  let projectId: string;

  beforeAll(async () => {
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
      // Ignore
    }
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    
    // Clear out test DB tables and create a project
    const db = (await import('../../src/store/database.js')).getDb();
    await db.run(sql`DELETE FROM knowledge_commits`);
    await db.run(sql`DELETE FROM knowledge_items`);

    const project = await repo.createProject(TEST_ROOT, 'Pipeline Test');
    projectId = project.id;
  });

  it('should block inputs that fail filter classification', async () => {
    vi.mocked(filterInput).mockResolvedValue({
      pass: false,
      reason: 'Rejected conversational noise',
    });

    const result = await runPipeline(projectId, 'hello agents', MOCK_CONFIG);
    expect(result.passedFilter).toBe(false);
    expect(result.filterReason).toBe('Rejected conversational noise');
    expect(result.extractedCount).toBe(0);
  });

  it('blocks raw secret input before asking the AI filter', async () => {
    const result = await runFilter('sk-test-123456789012345678901234567890', MOCK_CONFIG);

    expect(result).toEqual(expect.objectContaining({ pass: false }));
    expect(result.reason).toMatch(/secret/i);
    expect(filterInput).not.toHaveBeenCalled();
  });

  it('should extract and insert new knowledge items', async () => {
    vi.mocked(filterInput).mockResolvedValue({ pass: true });
    vi.mocked(extractKnowledge).mockResolvedValue([
      {
        category: 'fact',
        title: 'Main Language',
        content: 'TypeScript',
        tags: ['lang'],
      },
    ]);

    const result = await runPipeline(projectId, 'TypeScript is main language', MOCK_CONFIG);
    expect(result.passedFilter).toBe(true);
    expect(result.extractedCount).toBe(1);
    expect(result.mergeResult?.insertedIds).toHaveLength(1);
    expect(result.mergeResult?.mergedCount).toBe(1);
  });

  it('should update existing items when identified by compare', async () => {
    // 1. Insert initial
    vi.mocked(filterInput).mockResolvedValue({ pass: true });
    vi.mocked(extractKnowledge).mockResolvedValue([
      {
        category: 'fact',
        title: 'Active Database',
        content: 'PostgreSQL',
      },
    ]);
    await runPipeline(projectId, 'Use Postgres', MOCK_CONFIG);

    // Get the inserted item
    const db = (await import('../../src/store/database.js')).getDb();
    const items = await db.select().from((await import('../../src/store/schema.js')).knowledgeItems);
    expect(items).toHaveLength(1);
    const existingId = items[0].id;

    // 2. Mock update detection
    vi.mocked(extractKnowledge).mockResolvedValue([
      {
        category: 'fact',
        title: 'Active Database',
        content: 'PostgreSQL v16',
      },
    ]);
    vi.mocked(compareKnowledge).mockResolvedValue({
      relationship: 'update',
      reason: 'Version added',
      updatedContent: 'PostgreSQL v16 (relational)',
    });

    const result = await runPipeline(projectId, 'Postgres v16 is used', MOCK_CONFIG);
    expect(result.mergeResult?.updatedIds).toContain(existingId);
    
    // Verify changes
    const updatedItem = await repo.getKnowledgeItem(existingId);
    expect(updatedItem?.content).toBe('PostgreSQL v16 (relational)');
    expect(updatedItem?.version).toBe(2);
  });

  it('should return contradictions for user resolution by default', async () => {
    // 1. Insert initial
    vi.mocked(filterInput).mockResolvedValue({ pass: true });
    vi.mocked(extractKnowledge).mockResolvedValue([
      {
        category: 'fact',
        title: 'Active Database',
        content: 'PostgreSQL',
      },
    ]);
    await runPipeline(projectId, 'Use Postgres', MOCK_CONFIG);

    // 2. Mock contradiction
    vi.mocked(extractKnowledge).mockResolvedValue([
      {
        category: 'fact',
        title: 'Active Database',
        content: 'MongoDB',
      },
    ]);
    vi.mocked(compareKnowledge).mockResolvedValue({
      relationship: 'contradiction',
      reason: 'Conflicts with PostgreSQL choice',
    });

    const result = await runPipeline(projectId, 'Use MongoDB instead', MOCK_CONFIG);
    expect(result.mergeResult?.unresolvedContradictions).toHaveLength(1);
    expect(result.mergeResult?.mergedCount).toBe(0); // Nothing merged
  });

  it('should auto-supersede contradictions when autoResolve option is true', async () => {
    // 1. Insert initial
    vi.mocked(filterInput).mockResolvedValue({ pass: true });
    vi.mocked(extractKnowledge).mockResolvedValue([
      {
        category: 'fact',
        title: 'Active Database',
        content: 'PostgreSQL',
      },
    ]);
    await runPipeline(projectId, 'Use Postgres', MOCK_CONFIG);

    const db = (await import('../../src/store/database.js')).getDb();
    const initialItems = await db.select().from((await import('../../src/store/schema.js')).knowledgeItems);
    const firstItemId = initialItems[0].id;

    // 2. Run with autoResolve: true
    vi.mocked(extractKnowledge).mockResolvedValue([
      {
        category: 'fact',
        title: 'Active Database',
        content: 'MongoDB',
      },
    ]);
    vi.mocked(compareKnowledge).mockResolvedValue({
      relationship: 'contradiction',
      reason: 'Migration from PostgreSQL to MongoDB',
    });

    const result = await runPipeline(projectId, 'Use MongoDB instead', MOCK_CONFIG, {
      autoResolveContradictions: true,
      commitMessage: 'Migrate to MongoDB',
    });

    expect(result.mergeResult?.supersededIds).toContain(firstItemId);
    expect(result.mergeResult?.insertedIds).toHaveLength(1);
    
    // Check DB status
    const firstItem = await repo.getKnowledgeItem(firstItemId);
    expect(firstItem?.status).toBe('superseded');
    expect(firstItem?.supersededById).toBe(result.mergeResult?.insertedIds[0]);
  });

  it('should derive truth from decisions/facts and insert them as active state items', async () => {
    vi.mocked(filterInput).mockResolvedValue({ pass: true });
    vi.mocked(extractKnowledge).mockResolvedValue([
      {
        category: 'decision',
        title: 'Use SQLite',
        content: 'We will use SQLite for local persistence.',
      },
    ]);
    vi.mocked(deriveTruth).mockResolvedValue([
      { key: 'database', value: 'SQLite' },
    ]);

    await runPipeline(projectId, 'Use SQLite database', MOCK_CONFIG);

    // Verify derived state item was created
    const hierarchy = await getHierarchicalKnowledge(projectId);
    const dbState = hierarchy.state.find(s => s.title === 'database');
    expect(dbState).toBeDefined();
    expect(dbState?.content).toBe('SQLite');
  });

  it('should update derived state items if the truth changes', async () => {
    // 1. Setup initial state item
    const initialItem = await repo.createKnowledgeItem(projectId, {
      category: 'state',
      title: 'database',
      content: 'SQLite',
      tags: ['derived'],
    });

    vi.mocked(filterInput).mockResolvedValue({ pass: true });
    vi.mocked(extractKnowledge).mockResolvedValue([
      {
        category: 'decision',
        title: 'Use PostgreSQL',
        content: 'We will use PostgreSQL for production.',
      },
    ]);
    vi.mocked(deriveTruth).mockResolvedValue([
      { key: 'database', value: 'PostgreSQL' },
    ]);

    await runPipeline(projectId, 'Use PostgreSQL database', MOCK_CONFIG);

    // Verify derived state item was updated
    const hierarchy = await getHierarchicalKnowledge(projectId);
    const dbState = hierarchy.state.find(s => s.title === 'database');
    expect(dbState).toBeDefined();
    expect(dbState?.content).toBe('PostgreSQL');
    // Ensure the ID remained the same (updated in place)
    expect(dbState?.id).toBe(initialItem.id);
  });
});

// Import helper sql utility for clearing test tables
import { sql } from 'drizzle-orm';
