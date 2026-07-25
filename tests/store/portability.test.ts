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
import { createHash } from 'node:crypto';
import {
  createKnowledgeItem,
  deleteKnowledgeItem,
  getKnowledgeItem,
  listKnowledgeItems,
  updateKnowledgeItem,
} from '../../src/store/repository.js';
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
    // A dry run writes nothing, so every count is zero and the projection lives in
    // `wouldApply` rather than being reported as though it happened.
    expect(await importer(EXPORT_PATH, { dryRun: true })).toMatchObject({
      inserted: 0, identical: 0, applied: false, wouldApply: { identical: 1 },
    });
    await closeDb();
    await fs.mkdir(path.join(TARGET, '.knowl'), { recursive: true });
    await initDb(TARGET);
    expect(await importer(EXPORT_PATH)).toMatchObject({ inserted: 1, conflicts: 0, applied: true });
    const imported = (await listKnowledgeItems('local')).find(entry => entry.title === 'Portable decision')!;
    const links = await getClient().execute('SELECT * FROM knowledge_evidence');
    expect(links.rows).toEqual(expect.arrayContaining([expect.objectContaining({ knowledge_item_id: imported.id })]));
    expect(await listEvidenceForItem(imported.id)).toEqual([expect.objectContaining({ locator: 'tests/portability.test.ts', relationship: 'supports' })]);
  });

  it('exports tombstones so deletes can travel', async () => {
    const doomed = await createKnowledgeItem('local', {
      category: 'fact', title: 'Temporary fact', content: 'Removed before export.',
    });
    await deleteKnowledgeItem(doomed.id);

    const target = path.join(TARGET, 'with-tombstone.jsonl');
    const result = await portability.exportKnowledge('local', target, TARGET);

    expect(result.tombstones).toBeGreaterThanOrEqual(1);
    const records = (await fs.readFile(target, 'utf8'))
      .split('\n').filter(Boolean).map(line => JSON.parse(line));
    const tombstones = records.filter(record => record.type === 'tombstone');
    expect(tombstones.map(record => record.tombstone.id)).toContain(doomed.id);
  });

  it('applies new items even when another item diverged', async () => {
    // The defect this replaces: one divergent item discarded the whole import, so
    // unrelated new knowledge could never land on a machine that had done any work.
    const shared = await createKnowledgeItem('local', {
      category: 'fact', title: 'Shared fact', content: 'Original content.',
    });
    const target = path.join(TARGET, 'round-trip.jsonl');
    await portability.exportKnowledge('local', target, TARGET);

    await updateKnowledgeItem(shared.id, { content: 'Edited locally.' });

    const result = await portability.importKnowledge(target, { projectRoot: TARGET, onDivergence: 'skip' });

    expect(result.applied).toBe(true);
    expect(result.conflicts).toBe(0);
    expect(result.keptLocal).toBe(1);
    expect(result.divergent[0]).toMatchObject({ id: shared.id, taken: 'local' });
    expect((await getKnowledgeItem(shared.id))!.content).toBe('Edited locally.');
  });

  it('adopts a newer incoming item verbatim so both sides converge', async () => {
    const item = await createKnowledgeItem('local', {
      category: 'fact', title: 'Convergent fact', content: 'Peer wrote this.',
    });
    const target = path.join(TARGET, 'converge.jsonl');
    await portability.exportKnowledge('local', target, TARGET);
    const exported = (await fs.readFile(target, 'utf8'))
      .split('\n').filter(Boolean).map(line => JSON.parse(line))
      .find(record => record.type === 'item' && record.item.id === item.id)!.item;

    await updateKnowledgeItem(item.id, { content: 'Stale local copy.' });
    await getClient().execute({
      sql: 'UPDATE knowledge_items SET updated_at = ? WHERE id = ?',
      args: ['2020-01-01T00:00:00.000Z', item.id],
    });

    const result = await portability.importKnowledge(target, { projectRoot: TARGET, onDivergence: 'newer' });

    expect(result.applied).toBe(true);
    expect(result.updated).toBe(1);
    // Verbatim adoption is what makes a second round classify this as identical instead
    // of manufacturing a new winner and ping-ponging forever.
    const local = await getKnowledgeItem(item.id);
    expect(local!.contentHash).toBe(exported.contentHash);
    expect(local!.updatedAt).toBe(exported.updatedAt);
    expect(local!.version).toBe(exported.version);

    const second = await portability.importKnowledge(target, { projectRoot: TARGET, onDivergence: 'newer' });
    expect(second.updated).toBe(0);
    expect(second.identical).toBeGreaterThan(0);
  });

  it('fails the whole import only under the fail policy', async () => {
    const item = await createKnowledgeItem('local', {
      category: 'fact', title: 'Fail policy fact', content: 'Original.',
    });
    const target = path.join(TARGET, 'fail-policy.jsonl');
    await portability.exportKnowledge('local', target, TARGET);
    await updateKnowledgeItem(item.id, { content: 'Diverged.' });

    const result = await portability.importKnowledge(target, { projectRoot: TARGET, onDivergence: 'fail' });

    expect(result.applied).toBe(false);
    expect(result.conflicts).toBe(1);
    // Nothing was written, so every count must say so.
    expect(result.inserted).toBe(0);
    expect(result.updated).toBe(0);
  });

  it('replays a tombstone only when the local copy is older than the delete', async () => {
    const removed = await createKnowledgeItem('local', {
      category: 'fact', title: 'Deleted on peer', content: 'Gone over there.',
    });
    const target = path.join(TARGET, 'tombstone-replay.jsonl');
    await portability.exportKnowledge('local', target, TARGET);
    const stream = (await fs.readFile(target, 'utf8')).split('\n').filter(Boolean);
    const body = stream.slice(0, -1)
      .concat(JSON.stringify({
        type: 'tombstone',
        tombstone: { id: removed.id, deletedAt: new Date().toISOString(), reason: 'purged' },
      }));
    const joined = `${body.join('\n')}\n`;
    const sha = createHash('sha256').update(joined).digest('hex');
    const rebuilt = path.join(TARGET, 'tombstone-replay-2.jsonl');
    await fs.writeFile(rebuilt, `${joined}${JSON.stringify({ type: 'manifest', sha256: sha })}\n`, 'utf8');

    const result = await portability.importKnowledge(rebuilt, { projectRoot: TARGET, onDivergence: 'newer' });

    expect(result.deleted).toBe(1);
    expect(await getKnowledgeItem(removed.id)).toBeNull();
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
