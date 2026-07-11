import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, initDb } from '../../src/store/database.js';
import { findAssertionAsOf, listAssertions, replaceCurrentAssertion } from '../../src/store/assertions.js';
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

  it('replaces assertions with content updates but not status-only updates', async () => {
    const item = await repo.getKnowledgeItem(itemId);
    const before = await listAssertions(itemId);
    await repo.updateKnowledgeItem(itemId, { content: 'SQLite remains the current store.' });
    const afterContent = await listAssertions(itemId);
    await repo.updateKnowledgeItem(itemId, { status: 'archived' });

    expect(afterContent).toHaveLength(before.length + 1);
    expect(afterContent[0]).toMatchObject({ content: 'SQLite remains the current store.', validTo: null });
    expect(await findAssertionAsOf(itemId, item!.createdAt)).toMatchObject({ content: 'SQLite is active.' });
    expect(await listAssertions(itemId)).toHaveLength(afterContent.length);
  });
});
