import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, initDb } from '../../src/store/database.js';
import { createKnowledgeItem } from '../../src/store/repository.js';
import { synthesizeKnowledge } from '../../src/store/synthesis.js';

const ROOT = path.resolve('./.knowl-synthesis-test');
describe('knowledge synthesis', () => {
  beforeAll(async () => { await fs.rm(ROOT, { recursive: true, force: true }); await fs.mkdir(path.join(ROOT, '.knowl'), { recursive: true }); await initDb(ROOT); await createKnowledgeItem('local', { category: 'architecture', title: 'Auth module', content: 'Auth lives in src/auth.', tags: ['auth'] }); await createKnowledgeItem('local', { category: 'decision', title: 'Auth tokens', content: 'Auth uses JWT tokens.', tags: ['auth'] }); });
  afterAll(async () => { await closeDb(); await fs.rm(ROOT, { recursive: true, force: true }).catch(() => {}); });
  it('creates one bounded synthesized architecture item from two durable sources', async () => {
    const item = await synthesizeKnowledge('local', 'auth');
    expect(item).toMatchObject({ category: 'architecture', tags: expect.arrayContaining(['synthesized', 'auth']) });
    expect(item.content).toContain('Auth module');
    expect(item.content).toContain('Auth tokens');
  });
});
