import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { closeDb, getDb, initDb } from '../../src/store/database.js';
import * as repo from '../../src/store/repository.js';
import { recordRead } from '../../src/store/read-set.js';
import { storeKnowledgeAtomsDeduped } from '../../src/store/knowledge-writer.js';
import { attachEvidenceToKnowledge, isEvidenceStale, listEvidenceForItem } from '../../src/store/evidence-repository.js';

/**
 * File evidence built from `affectedPaths` carries a hash only where a session observed the
 * file (#225). Before this, every such row had `contentHash` NULL, so `isEvidenceStale` could
 * never say true for file evidence this repo originated -- and the reason it was never simply
 * hashed is the property the third test pins: a declared path must not become a staleness
 * claim, or an agent's unverified assertion about a file it never opened would report as fact.
 */
const ROOT = path.resolve('.knowl-evidence-read-set-test');

const sha256 = (content: Buffer | string) => crypto.createHash('sha256').update(content).digest('hex');

describe('file evidence hashed from what the read-set observed', () => {
  let projectId = '';

  beforeAll(async () => {
    await fs.rm(ROOT, { recursive: true, force: true });
    await fs.mkdir(path.join(ROOT, '.knowl'), { recursive: true });
    await fs.mkdir(path.join(ROOT, 'src'), { recursive: true });
    await initDb(ROOT);
    projectId = (await repo.createProject(ROOT, 'Evidence read-set test')).id;
  });

  beforeEach(async () => {
    const db = getDb() as any;
    await db.run(sql`DELETE FROM knowledge_evidence`);
    await db.run(sql`DELETE FROM evidence`);
    await db.run(sql`DELETE FROM knowledge_items`);
    await db.run(sql`DELETE FROM work_read_sets`);
  });

  afterAll(async () => {
    await closeDb();
    await fs.rm(ROOT, { recursive: true, force: true }).catch(() => {});
  });

  const writeFile = async (relative: string, content: string) => {
    await fs.writeFile(path.join(ROOT, relative), content);
    return sha256(content);
  };

  const seedItem = (title: string) => repo.createKnowledgeItem(projectId, {
    category: 'fact', title, content: `${title} — content.`,
  });

  it('hashes a cited file the session read at file granularity, and the hash goes stale when it moves', async () => {
    const hash = await writeFile('src/notes.md', '# notes\n');
    await recordRead({ sessionId: 'sess-a', locator: 'file://src/notes.md', observedHash: hash, toolName: 'Read' });
    const item = await seedItem('Notes fact');

    await attachEvidenceToKnowledge(item.id, undefined, { affectedPaths: ['src/notes.md'] });

    const [evidence] = await listEvidenceForItem(item.id);
    expect(evidence).toMatchObject({ type: 'file', locator: 'src/notes.md', contentHash: hash });
    expect(await isEvidenceStale(evidence, ROOT)).toBe(false);

    await writeFile('src/notes.md', '# notes, rewritten\n');
    expect(await isEvidenceStale(evidence, ROOT)).toBe(true);
  });

  it('counts a symbol-granularity read as observation, and hashes the whole file', async () => {
    // A code file with symbols is recorded one `symbol://` row per symbol and no `file://` row
    // at all, so the file hash has to come from disk -- the read-set proves the read happened.
    const hash = await writeFile('src/auth.ts', 'export function createToken() { return "token"; }\n');
    await recordRead({
      sessionId: 'sess-b', locator: 'symbol://src/auth.ts#createToken', observedHash: 'sig-1', toolName: 'Read',
    });
    const item = await seedItem('Token fact');

    await attachEvidenceToKnowledge(item.id, undefined, { affectedPaths: ['src/auth.ts'] });

    const [evidence] = await listEvidenceForItem(item.id);
    expect(evidence.contentHash).toBe(hash);
    expect(await isEvidenceStale(evidence, ROOT)).toBe(false);
    await writeFile('src/auth.ts', 'export function createAccessToken() { return "token"; }\n');
    expect(await isEvidenceStale(evidence, ROOT)).toBe(true);
  });

  it('leaves a merely declared path unhashed, so a claim nobody verified never reports stale', async () => {
    await writeFile('src/declared.ts', 'export const declared = 1;\n');
    const item = await seedItem('Declared fact');

    await attachEvidenceToKnowledge(item.id, undefined, { affectedPaths: ['src/declared.ts'] });

    const [evidence] = await listEvidenceForItem(item.id);
    expect(evidence).toMatchObject({ type: 'file', locator: 'src/declared.ts', contentHash: null });
    await writeFile('src/declared.ts', 'export const declared = 2;\n');
    expect(await isEvidenceStale(evidence, ROOT)).toBe(false);
  });

  it('does not confuse a sibling whose name shares a prefix with an observed file', async () => {
    // `symbol://src/auth.ts#…` must not vouch for `src/auth.tsx`, and a `_` in a path is a
    // character, not a wildcard.
    await writeFile('src/auth.tsx', 'export const Auth = () => null;\n');
    await recordRead({ sessionId: 'sess-c', locator: 'symbol://src/auth.ts#createToken', observedHash: 'sig-1' });
    const item = await seedItem('Sibling fact');

    await attachEvidenceToKnowledge(item.id, undefined, { affectedPaths: ['src/auth.tsx'] });

    expect((await listEvidenceForItem(item.id))[0].contentHash).toBeNull();
  });

  it('never reads a locator that escapes the root, observed or not', async () => {
    await recordRead({ sessionId: 'sess-d', locator: 'file://src/notes.md', observedHash: 'h' });
    const item = await seedItem('Escaping fact');

    await attachEvidenceToKnowledge(item.id, undefined, { affectedPaths: ['../../../Windows/win.ini'] });

    expect((await listEvidenceForItem(item.id))[0].contentHash).toBeNull();
  });

  it('reaches the batch write path, which is what knowl_store and knowl_ingest_atoms call', async () => {
    const hash = await writeFile('src/store.ts', 'export const store = true;\n');
    await recordRead({ sessionId: 'sess-e', locator: 'file://src/store.ts', observedHash: hash, toolName: 'Read' });

    const result = await storeKnowledgeAtomsDeduped(projectId, [{
      category: 'fact', title: 'Store fact', content: 'Written with a cited path the session read.',
      affectedPaths: ['src/store.ts'],
    }] as any);

    const evidence = await listEvidenceForItem(result.itemIds[0]);
    expect(evidence.find(row => row.type === 'file')?.contentHash).toBe(hash);
  });
});
