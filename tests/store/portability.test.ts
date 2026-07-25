import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// portability.ts imports the indexer as a named binding, which an ES module namespace spy
// cannot intercept. The real function is already a no-op when no embedding model is on
// disk, so replacing it with a spy changes nothing except making the call observable.
vi.mock('../../src/store/write-embedding.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/store/write-embedding.js')>();
  return { ...actual, indexKnowledgeItemsBestEffort: vi.fn(async () => {}) };
});

import { indexKnowledgeItemsBestEffort } from '../../src/store/write-embedding.js';
import { closeDb, initDb } from '../../src/store/database.js';
import { getClient } from '../../src/store/database.js';
import { createKnowledgeItem, listKnowledgeItems } from '../../src/store/repository.js';
import * as portability from '../../src/store/portability.js';
import { createEvidence, linkKnowledgeEvidence, listEvidenceForItem } from '../../src/store/evidence-repository.js';

const ROOT = path.resolve('.knowl-portability-test');
const EXPORT_PATH = path.join(ROOT, 'memory.jsonl');
const TARGET = path.resolve('.knowl-portability-target');
const INDEXING_TARGET = path.resolve('.knowl-portability-indexing');

describe('portability', () => {
  beforeAll(async () => { await fs.rm(ROOT, { recursive: true, force: true }); await fs.rm(TARGET, { recursive: true, force: true }); await fs.rm(INDEXING_TARGET, { recursive: true, force: true }); await fs.mkdir(path.join(ROOT, '.knowl'), { recursive: true }); await initDb(ROOT); });
  afterAll(async () => { await closeDb(); await fs.rm(ROOT, { recursive: true, force: true }).catch(() => {}); await fs.rm(TARGET, { recursive: true, force: true }).catch(() => {}); await fs.rm(INDEXING_TARGET, { recursive: true, force: true }).catch(() => {}); });

  it('exports a manifest-verified JSONL stream and dry-runs imports without mutation', async () => {
    const item = await createKnowledgeItem('local', { category: 'decision', title: 'Portable decision', content: 'Keep memory portable.', conflictKey: 'memory.portability', conflictExclusive: true });
    const evidence = await createEvidence({ type: 'test', locator: 'tests/portability.test.ts', observedAt: '2026-07-11T00:00:00.000Z' });
    await linkKnowledgeEvidence({ knowledgeItemId: item.id, evidenceId: evidence.id, relationship: 'supports' });
    const exported = await portability.exportKnowledge('local', EXPORT_PATH);
    expect(exported.items).toBe(1);
    const jsonl = await fs.readFile(EXPORT_PATH, 'utf8');
    expect(jsonl.split('\n')[0]).toContain('"header"');
    expect(jsonl).toContain('"evidence"');
    expect(jsonl).toContain('"knowledge_evidence"');

    const importer = (portability as any).importKnowledge;
    expect(importer).toBeTypeOf('function');
    expect(await importer(EXPORT_PATH, { dryRun: true })).toMatchObject({ inserted: 0, skipped: 1, applied: false });
    await closeDb();
    await fs.mkdir(path.join(TARGET, '.knowl'), { recursive: true });
    await initDb(TARGET);
    expect(await importer(EXPORT_PATH)).toMatchObject({ inserted: 1, conflicts: 0, applied: true });
    const imported = (await listKnowledgeItems('local')).find(entry => entry.title === 'Portable decision')!;
    const links = await getClient().execute('SELECT * FROM knowledge_evidence');
    expect(links.rows).toEqual(expect.arrayContaining([expect.objectContaining({ knowledge_item_id: imported.id })]));
    expect(await listEvidenceForItem(imported.id)).toEqual([expect.objectContaining({ locator: 'tests/portability.test.ts', relationship: 'supports' })]);
  });

  it('hands imported items to the embedding indexer', async () => {
    // Import wrote raw SQL and never called the indexer, unlike every other write path,
    // so imported knowledge was invisible to vector search -- the primary retrieval path.
    // FTS survived only because bootstrap defines insert/update/delete triggers for it.
    vi.mocked(indexKnowledgeItemsBestEffort).mockClear();

    await createKnowledgeItem('local', { category: 'fact', title: 'Indexable fact', content: 'Should reach the indexer.' });
    const exportPath = path.join(TARGET, 'indexing.jsonl');
    await portability.exportKnowledge('local', exportPath);

    await closeDb();
    await fs.mkdir(path.join(INDEXING_TARGET, '.knowl'), { recursive: true });
    await initDb(INDEXING_TARGET);
    const result = await portability.importKnowledge(exportPath, { projectRoot: INDEXING_TARGET });

    expect(result.applied).toBe(true);
    expect(indexKnowledgeItemsBestEffort).toHaveBeenCalledTimes(1);
    const [, indexedItems] = vi.mocked(indexKnowledgeItemsBestEffort).mock.calls[0];
    expect(indexedItems.map(item => item.title)).toContain('Indexable fact');
  });

  it('does not call the indexer for a dry run', async () => {
    vi.mocked(indexKnowledgeItemsBestEffort).mockClear();
    const exportPath = path.join(TARGET, 'indexing.jsonl');

    await portability.importKnowledge(exportPath, { projectRoot: INDEXING_TARGET, dryRun: true });

    expect(indexKnowledgeItemsBestEffort).not.toHaveBeenCalled();
  });
});
