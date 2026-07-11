import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, initDb } from '../../src/store/database.js';
import { composeContext } from '../../src/store/context-composer.js';
import { createKnowledgeItem } from '../../src/store/repository.js';

const ROOT = path.resolve('./.knowl-context-composer-test');

describe('context composer', () => {
  beforeAll(async () => { await fs.rm(ROOT, { recursive: true, force: true }); await fs.mkdir(path.join(ROOT, '.knowl'), { recursive: true }); await initDb(ROOT); await createKnowledgeItem('local', { category: 'constraint', title: 'No secrets', content: 'Never store secrets.' }); await createKnowledgeItem('local', { category: 'decision', title: 'Use SQLite', content: 'Durable project memory uses SQLite.' }); });
  afterAll(async () => { await closeDb(); await fs.rm(ROOT, { recursive: true, force: true }).catch(() => {}); });

  it('keeps pinned constraints inside a small token budget and reports exclusions', async () => {
    const pack = await composeContext('local', { query: 'storage', task: 'Implement storage', tokenBudget: 18 });
    expect(pack.sections[0]).toMatchObject({ name: 'Pinned constraints', items: [expect.objectContaining({ title: 'No secrets' })] });
    expect(pack.estimatedTokens).toBeLessThanOrEqual(18);
    expect(pack.excluded).toEqual(expect.any(Array));
  });
});
