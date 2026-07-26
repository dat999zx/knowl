import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, initDb } from '../../src/store/database.js';
import { createKnowledgeItem, listKnowledgeItems, updateKnowledgeItem } from '../../src/store/repository.js';
import { synthesizeKnowledge } from '../../src/store/synthesis.js';
import { listEvidenceForItem } from '../../src/store/evidence-repository.js';

const ROOT = path.resolve('./.knowl-synthesis-test');
describe('knowledge synthesis', () => {
  beforeAll(async () => { await fs.rm(ROOT, { recursive: true, force: true }); await fs.mkdir(path.join(ROOT, '.knowl'), { recursive: true }); await initDb(ROOT); await createKnowledgeItem('local', { category: 'architecture', title: 'Auth module', content: 'Auth lives in src/auth.', tags: ['auth'] }); await createKnowledgeItem('local', { category: 'decision', title: 'Auth tokens', content: 'Auth uses JWT tokens.', tags: ['auth'] }); });
  afterAll(async () => { await closeDb(); await fs.rm(ROOT, { recursive: true, force: true }).catch(() => {}); });
  it('creates one bounded synthesized architecture item from two durable sources', async () => {
    const item = await synthesizeKnowledge('local', 'auth');
    expect(item).toMatchObject({ category: 'architecture', tags: expect.arrayContaining(['synthesized', 'auth']) });
    expect(item.content).toContain('Auth module');
    expect(item.content).toContain('Auth tokens');
    expect(await listEvidenceForItem(item.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ relationship: 'derived_from', locator: expect.stringMatching(/^knowledge:\/\//) }),
    ]));
  });

  it('replaces synthesized content and provenance when a supporting source changes', async () => {
    const first = await synthesizeKnowledge('local', 'auth');
    const auth = (await listKnowledgeItems()).find(item => item.title === 'Auth tokens')!;
    await updateKnowledgeItem(auth.id, { content: 'Auth uses short-lived JWT access tokens.' });
    const replacement = await synthesizeKnowledge('local', 'auth');
    expect(replacement.id).toBe(first.id);
    expect(replacement.content).toContain('short-lived JWT access tokens');
  });
});
