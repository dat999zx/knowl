import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { closeDb, getDb, initDb } from '../../src/store/database.js';
import * as repo from '../../src/store/repository.js';
import { recordDecisionDirect } from '../../src/store/knowledge-actions.js';
import { storeKnowledgeAtomsDeduped } from '../../src/store/knowledge-writer.js';
import {
  createEvidence,
  isEvidenceStale,
  linkKnowledgeEvidence,
  listEvidenceForItem,
  listItemsForEvidence,
  unlinkKnowledgeEvidence,
} from '../../src/store/evidence-repository.js';

const TEST_ROOT = path.resolve('./.knowl-evidence-test');

describe('evidence repository', () => {
  let projectId: string;

  beforeAll(async () => {
    await fs.rm(TEST_ROOT, { recursive: true, force: true });
    await fs.mkdir(path.join(TEST_ROOT, '.knowl'), { recursive: true });
    await initDb(TEST_ROOT);
    projectId = (await repo.createProject(TEST_ROOT, 'Evidence test')).id;
  });

  beforeEach(async () => {
    const db = getDb() as any;
    await db.run(sql`DELETE FROM knowledge_evidence`);
    await db.run(sql`DELETE FROM evidence`);
    await db.run(sql`DELETE FROM knowledge_items`);
  });

  afterAll(async () => {
    await closeDb();
    await fs.rm(TEST_ROOT, { recursive: true, force: true }).catch(() => {});
  });

  it('creates or reuses normalized evidence and caps safe excerpts', async () => {
    const first = await createEvidence({
      type: 'file', locator: 'src\\auth\\token.ts', contentHash: 'a'.repeat(64),
      excerpt: 'x'.repeat(5_000), observedAt: '2026-07-11T00:00:00.000Z',
    });
    const second = await createEvidence({
      type: 'file', locator: 'src/auth/token.ts', contentHash: 'a'.repeat(64),
      excerpt: 'other', observedAt: '2026-07-11T00:00:00.000Z',
    });

    expect(second.id).toBe(first.id);
    expect(first.locator).toBe('src/auth/token.ts');
    expect(first.excerpt!.length).toBeLessThanOrEqual(2_000);
  });

  it('links, lists, unlinks, and finds items by evidence', async () => {
    const item = await repo.createKnowledgeItem(projectId, {
      category: 'fact', title: 'Evidence target', content: 'Evidence-backed fact.',
    });
    const evidence = await createEvidence({
      type: 'test', locator: 'tests/auth.test.ts', observedAt: '2026-07-11T00:00:00.000Z',
    });
    await linkKnowledgeEvidence({ knowledgeItemId: item.id, evidenceId: evidence.id, relationship: 'supports' });

    expect(await listEvidenceForItem(item.id)).toEqual([expect.objectContaining({ id: evidence.id, relationship: 'supports' })]);
    expect(await listItemsForEvidence(evidence.id)).toEqual([expect.objectContaining({ id: item.id, relationship: 'supports' })]);
    await unlinkKnowledgeEvidence(item.id, evidence.id);
    expect(await listEvidenceForItem(item.id)).toEqual([]);
  });

  it('detects file evidence whose hash no longer matches disk', async () => {
    const filePath = path.join(TEST_ROOT, 'src', 'auth.ts');
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, 'export const auth = true;\n');
    const oldHash = crypto.createHash('sha256').update('old content').digest('hex');
    const evidence = await createEvidence({
      type: 'file', locator: 'src/auth.ts', contentHash: oldHash, observedAt: '2026-07-11T00:00:00.000Z',
    });

    expect(await isEvidenceStale(evidence, TEST_ROOT)).toBe(true);
  });

  it('attaches explicit and compatibility evidence during direct and batch writes', async () => {
    const decision = await recordDecisionDirect(projectId, {
      title: 'Evidence-backed decision', content: 'Use evidence for trust.',
      evidence: [{
        type: 'test', locator: 'tests/evidence.test.ts', observedAt: '2026-07-11T00:00:00.000Z', relationship: 'supports',
      }],
    } as any);
    expect(await listEvidenceForItem(decision.id)).toEqual([
      expect.objectContaining({ type: 'test', relationship: 'supports' }),
    ]);
    await repo.updateKnowledgeItem(decision.id, { content: 'Use evidence for durable trust.' });
    expect(await listEvidenceForItem(decision.id)).toHaveLength(1);

    const result = await storeKnowledgeAtomsDeduped(projectId, [{
      category: 'fact', title: 'Batch evidence', content: 'Batch atom has provenance.',
      sourceCommit: 'abc123', affectedPaths: ['src/evidence.ts'],
      evidence: [{
        type: 'commit', locator: 'abc123', observedAt: '2026-07-11T00:00:00.000Z', relationship: 'derived_from',
      }],
    }] as any);
    const evidence = await listEvidenceForItem(result.itemIds[0]);
    expect(evidence).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'commit', locator: 'abc123', relationship: 'derived_from' }),
    ]));
    expect(evidence.filter(item => item.type === 'commit')).toHaveLength(1);
  });
});
