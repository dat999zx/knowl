import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, initDb } from '../../src/store/database.js';
import { getClient } from '../../src/store/database.js';
import { createKnowledgeItem, listKnowledgeItems } from '../../src/store/repository.js';
import * as portability from '../../src/store/portability.js';
import { createEvidence, linkKnowledgeEvidence, listEvidenceForItem } from '../../src/store/evidence-repository.js';

const ROOT = path.resolve('.knowl-portability-test');
const EXPORT_PATH = path.join(ROOT, 'memory.jsonl');
const TARGET = path.resolve('.knowl-portability-target');

describe('portability', () => {
  beforeAll(async () => { await fs.rm(ROOT, { recursive: true, force: true }); await fs.rm(TARGET, { recursive: true, force: true }); await fs.mkdir(path.join(ROOT, '.knowl'), { recursive: true }); await initDb(ROOT); });
  afterAll(async () => { await closeDb(); await fs.rm(ROOT, { recursive: true, force: true }).catch(() => {}); await fs.rm(TARGET, { recursive: true, force: true }).catch(() => {}); });

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
});
