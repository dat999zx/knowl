import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, initDb } from '../../src/store/database.js';
import { listAssertions, replaceCurrentAssertion } from '../../src/store/assertions.js';
import * as repo from '../../src/store/repository.js';

const ROOT = path.resolve('./.knowl-assertions-test');

describe('knowledge assertions', () => {
  let itemId = '';

  beforeAll(async () => {
    await fs.rm(ROOT, { recursive: true, force: true });
    await fs.mkdir(path.join(ROOT, '.knowl'), { recursive: true });
    await initDb(ROOT);
    const project = await repo.createProject(ROOT, 'Assertions');
    itemId = (await repo.createKnowledgeItem(project.id, { category: 'fact', title: 'Storage', content: 'SQLite is active.' })).id;
  });

  afterAll(async () => { await closeDb(); await fs.rm(ROOT, { recursive: true, force: true }).catch(() => {}); });

  it('keeps one open immutable assertion and closes it before replacement', async () => {
    const [first] = await listAssertions(itemId);
    const second = await replaceCurrentAssertion({ knowledgeItemId: itemId, content: 'PostgreSQL is active.', confidence: 0.9 });
    const assertions = await listAssertions(itemId);

    expect(first).toMatchObject({ knowledgeItemId: itemId, validTo: null });
    expect(second).toMatchObject({ knowledgeItemId: itemId, content: 'PostgreSQL is active.', validTo: null });
    expect(assertions).toEqual([expect.objectContaining({ id: second.id, validTo: null }), expect.objectContaining({ id: first.id, validTo: expect.any(String), replacedAt: expect.any(String) })]);
  });
});
