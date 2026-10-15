import { describe, it, expect, vi, beforeAll, beforeEach, afterEach, afterAll } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { initDb, closeDb, getDb } from '../../src/store/database.js';
import * as repo from '../../src/store/repository.js';
import { runPipeline } from '../../src/pipeline/pipeline.js';
import { ProjectConfig } from '../../src/core/types.js';

vi.mock('ai', async importOriginal => {
  const original = await importOriginal<typeof import('ai')>();
  return { ...original, generateObject: vi.fn(), generateText: vi.fn() };
});

import { generateObject } from 'ai';
import { initAI } from '../../src/ai/provider.js';
import { FILTER_SYSTEM_PROMPT } from '../../src/ai/prompts.js';
import { FilterResultSchema } from '../../src/ai/schemas.js';
import { generalProfile } from '../../src/ai/profiles/general.js';
import { academicProfile } from '../../src/ai/profiles/academic.js';
import { domainProfile } from '../../src/ai/profiles/index.js';

const TEST_ROOT = path.resolve('./.knowl-profile-pipeline-test');
const TEXT = 'My thesis advisor is Dr. Lan Nguyen.';

const base = (profile?: string): ProjectConfig => ({
  version: 1,
  ai: { provider: 'openai', model: 'gpt-test', apiKey: 'mock-key', ...(profile ? { profile } : {}) },
  security: { rejectSecrets: true, secretPatterns: [] },
});

const queueFilterAndExtract = () => {
  vi.mocked(generateObject)
    .mockResolvedValueOnce({ object: { pass: true, reason: 'personal fact' } } as any)
    .mockResolvedValueOnce({
      object: { atoms: [{ category: 'fact', title: 'Thesis advisor', content: TEXT, confidence: 1 }] },
    } as any);
};

const call = (n: number) => vi.mocked(generateObject).mock.calls[n][0] as any;

describe('runPipeline selects the domain profile', () => {
  let projectId: string;
  let savedHome: string | undefined;
  let home: string;

  beforeAll(async () => {
    await fs.rm(TEST_ROOT, { recursive: true, force: true }).catch(() => {});
    await fs.mkdir(path.join(TEST_ROOT, '.knowl'), { recursive: true });
    await initDb(TEST_ROOT);
  });

  afterAll(async () => {
    await closeDb();
    await fs.rm(TEST_ROOT, { recursive: true, force: true }).catch(() => {});
  });

  beforeEach(async () => {
    vi.resetAllMocks();
    savedHome = process.env.KNOWL_HOME;
    home = await fs.mkdtemp(path.join(os.tmpdir(), 'knowl-profile-pipeline-'));
    process.env.KNOWL_HOME = home;
    const db = getDb();
    await db.run(sql`DELETE FROM knowledge_commits`);
    await db.run(sql`DELETE FROM knowledge_items`);
    projectId = (await repo.createProject(TEST_ROOT, 'Profile Pipeline')).id;
    initAI(base('general').ai!);
  });

  afterEach(async () => {
    if (savedHome === undefined) delete process.env.KNOWL_HOME;
    else process.env.KNOWL_HOME = savedHome;
    await fs.rm(home, { recursive: true, force: true }).catch(() => {});
  });

  it('runs the general profile named by ai.profile, without derive', async () => {
    queueFilterAndExtract();
    const result = await runPipeline(projectId, TEXT, base('general'));

    expect(result.passedFilter).toBe(true);
    expect(result.extractedCount).toBe(1);
    expect(result.mergeResult!.insertedIds.length).toBe(1);

    expect(call(0).system).toBe(generalProfile.filter);
    expect(call(0).schema).not.toBe(FilterResultSchema);
    expect(call(1).system).toBe(generalProfile.extract);
    expect(generateObject).toHaveBeenCalledTimes(2);

    const items = await repo.listKnowledgeItems();
    const item = items.find(i => i.title === 'Thesis advisor')!;
    expect(item.category).toBe('fact');
    expect(item.affectedPaths ?? []).toEqual([]);
  });

  it('keeps the code prompts when ai.profile is absent', async () => {
    queueFilterAndExtract();
    vi.mocked(generateObject).mockResolvedValueOnce({ object: { truths: [] } } as any);
    await runPipeline(projectId, TEXT, base());

    expect(call(0).system).toBe(FILTER_SYSTEM_PROMPT);
    expect(call(0).schema).toBe(FilterResultSchema);
  });

  it('takes an explicit profile parameter over the config', async () => {
    queueFilterAndExtract();
    await runPipeline(projectId, TEXT, base(), {}, domainProfile('academic'));

    expect(call(0).system).toBe(academicProfile.filter);
  });
});
