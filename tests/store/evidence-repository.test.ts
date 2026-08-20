import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { closeDb, getDb, initDb } from '../../src/store/database.js';
import { indexCode, listCodeSymbols } from '../../src/code/symbol-index.js';
import { checkKnowledgeDrift } from '../../src/store/drift.js';
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
import * as evidenceRepository from '../../src/store/evidence-repository.js';

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

  it('stores a locator that escapes the project root instead of failing the write', async () => {
    const observedAt = '2026-07-11T00:00:00.000Z';

    // `..` segments and a drive letter are the two ways out of the root, and only the first is
    // caught by segment inspection alone -- `C:/Windows/win.ini` contains no empty, `.` or `..`
    // segment, yet `path.resolve` abandons the root for it on any platform that has drives.
    //
    // Neither is refused here. `attachEvidenceToKnowledge` turns every `affectedPaths` entry into
    // a `file` locator inside the write transaction, so throwing would lose the whole atom over
    // one path naming a sibling checkout -- a shape this project's own store already holds. The
    // row is inert instead: `isEvidenceStale` refuses to resolve it, which is the assertion below
    // and the one that actually closes the traversal.
    for (const locator of ['../../../Windows/win.ini', 'C:/Windows/win.ini', '/etc/passwd']) {
      const stored = await createEvidence({ type: 'file', locator, contentHash: 'a'.repeat(64), observedAt });
      expect(stored.locator).toBe(locator);
      expect(await isEvidenceStale(stored, TEST_ROOT)).toBe(true);
    }
  });

  it('recovers a locator that names a file inside the repository by another spelling', async () => {
    const observedAt = '2026-07-11T00:00:00.000Z';

    // An absolute path under the root and `src/a.ts` name one file. Storing both spellings means
    // the staleness check never matches on either -- a miss that is silent by construction, since
    // comparing two unequal strings does not throw, it just never fires.
    const absolute = await createEvidence({
      type: 'file', locator: path.join(TEST_ROOT, 'src/auth/token.ts'), contentHash: 'e'.repeat(64), observedAt,
    });
    expect(absolute.locator).toBe('src/auth/token.ts');

    // A trailing slash is not an escape, and a directory is a legitimate citation.
    const directory = await createEvidence({
      type: 'file', locator: 'src/transcripts/', contentHash: 'f'.repeat(64), observedAt,
    });
    expect(directory.locator).toBe('src/transcripts');
  });

  it('canonicalizes a file:// locator to the bare path rather than containing it by accident', async () => {
    // Prefixed locators resolve to `<root>/file:/...` today, which cannot exist, so they are
    // "safe" only in the sense that they never match anything. Pinning that as the intended
    // behaviour would be wrong: the prefix is a legitimate spelling of the same file and is
    // canonicalized, which is what stops two formats sharing one column.
    const evidence = await createEvidence({
      type: 'file', locator: 'file://src/auth/token.ts', contentHash: 'b'.repeat(64),
      observedAt: '2026-07-11T00:00:00.000Z',
    });

    expect(evidence.locator).toBe('src/auth/token.ts');
  });

  it('accepts evidence for extensionless files, which the read-set heuristic would refuse', async () => {
    // `normalizeFilePath` requires an extension to reject directories, an acceptable loss for a
    // tier allowed to be incomplete. Evidence is a deliberate citation, so it takes the
    // containment rule without that bias.
    const evidence = await createEvidence({
      type: 'file', locator: 'Makefile', contentHash: 'c'.repeat(64),
      observedAt: '2026-07-11T00:00:00.000Z',
    });

    expect(evidence.locator).toBe('Makefile');
  });

  it('leaves non-path locators opaque and keeps the symbol scheme', async () => {
    const observedAt = '2026-07-11T00:00:00.000Z';

    // A commit SHA is an identifier, not a path; `isEvidenceStale` never takes it to the
    // filesystem, and validating it as a path would reject the 168 commit rows already stored.
    const commit = await createEvidence({ type: 'commit', locator: 'a'.repeat(40), observedAt });
    expect(commit.locator).toBe('a'.repeat(40));

    // `symbol://path#name` is `code_symbols.locator`, the key `resolveSymbolEvidence` looks up.
    // Stripped to a bare path it would match no row.
    const symbol = await createEvidence({
      type: 'symbol', locator: 'symbol://src/auth/token.ts#verify', observedAt,
    });
    expect(symbol.locator).toBe('symbol://src/auth/token.ts#verify');
  });

  it('refuses to read an escaping locator that reached the table without createEvidence', async () => {
    // `cloud/sync-apply.ts` upserts locator and content_hash straight from a peer's payload and
    // `store/portability.ts` inserts on import, so the write-side guard is not sufficient on its
    // own. Inserted directly here to reproduce that shape.
    const db = getDb() as any;
    await db.run(sql`
      INSERT INTO evidence (id, type, locator, content_hash, excerpt, observed_at, metadata)
      VALUES ('escapes0000000001', 'file', '../../../Windows/win.ini', ${'d'.repeat(64)}, NULL, '2026-07-11T00:00:00.000Z', NULL)
    `);

    const rows = await listEvidenceForItem('nonexistent');
    expect(rows).toEqual([]);

    // The answer must not depend on whether that file exists on the machine running the test,
    // so it is a constant rather than the result of a read that happens to fail.
    const escaping = {
      id: 'escapes0000000001', type: 'file' as const, locator: '../../../Windows/win.ini',
      contentHash: 'd'.repeat(64), excerpt: null, observedAt: '2026-07-11T00:00:00.000Z', metadata: null,
    };
    expect(await isEvidenceStale(escaping, TEST_ROOT)).toBe(true);
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

  it('detects symbol evidence that no longer resolves after an incremental reindex', async () => {
    const filePath = path.join(TEST_ROOT, 'src', 'auth.ts');
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, 'export function createToken() { return "token"; }\n');
    await indexCode(TEST_ROOT);
    const original = (await listCodeSymbols('src/auth.ts')).find(symbol => symbol.locator === 'symbol://src/auth.ts#createToken')!;
    const evidence = await createEvidence({
      type: 'symbol', locator: original.locator, contentHash: original.signatureHash,
      observedAt: '2026-07-11T00:00:00.000Z',
    });

    await fs.writeFile(filePath, 'export function createAccessToken() { return "token"; }\n');
    await indexCode(TEST_ROOT);

    expect(await isEvidenceStale(evidence, TEST_ROOT)).toBe(true);
  });

  it('suggests one same-file same-kind replacement for renamed symbol evidence', async () => {
    const filePath = path.join(TEST_ROOT, 'src', 'auth.ts');
    await fs.writeFile(filePath, 'export function createToken() { return "token"; }\n');
    await indexCode(TEST_ROOT);
    const original = (await listCodeSymbols('src/auth.ts')).find(symbol => symbol.locator === 'symbol://src/auth.ts#createToken')!;
    const evidence = await createEvidence({
      type: 'symbol', locator: original.locator, contentHash: original.signatureHash,
      metadata: { symbolKind: 'function' }, observedAt: '2026-07-11T00:00:00.000Z',
    });
    await fs.writeFile(filePath, 'export function createAccessToken() { return "token"; }\n');
    await indexCode(TEST_ROOT);

    const resolve = (evidenceRepository as any).resolveSymbolEvidence;
    expect(resolve).toBeTypeOf('function');
    expect(await resolve(evidence)).toEqual({ stale: true, suggestedLocator: 'symbol://src/auth.ts#createAccessToken' });
  });

  it('includes stale linked symbol evidence in drift candidates without changing knowledge content', async () => {
    const filePath = path.join(TEST_ROOT, 'src', 'auth.ts');
    await fs.writeFile(filePath, 'export function createToken() { return "token"; }\n');
    await indexCode(TEST_ROOT);
    const original = (await listCodeSymbols('src/auth.ts')).find(symbol => symbol.locator === 'symbol://src/auth.ts#createToken')!;
    const item = await repo.createKnowledgeItem(projectId, {
      category: 'architecture', title: 'Token creation', content: 'Auth creates a token through the documented symbol.',
    });
    const evidence = await createEvidence({
      type: 'symbol', locator: original.locator, contentHash: original.signatureHash,
      metadata: { symbolKind: 'function' }, observedAt: '2026-07-11T00:00:00.000Z',
    });
    await linkKnowledgeEvidence({ knowledgeItemId: item.id, evidenceId: evidence.id, relationship: 'supports' });
    await fs.writeFile(filePath, 'export function createAccessToken() { return "token"; }\n');
    await indexCode(TEST_ROOT);

    const drift = await checkKnowledgeDrift(projectId, { sinceCommit: 'base', changedFiles: ['src/auth.ts'], apply: false });

    expect(drift.candidates).toEqual([expect.objectContaining({
      itemId: item.id,
      matchedPaths: ['src/auth.ts'],
      symbolEvidence: [expect.objectContaining({ locator: original.locator, suggestedLocator: 'symbol://src/auth.ts#createAccessToken' })],
    })]);
    expect((await repo.getKnowledgeItem(item.id))!.freshness).toBe('fresh');
  });

  it('attaches explicit and compatibility evidence during direct and batch writes', async () => {
    const decision = await recordDecisionDirect(projectId, {
      title: 'Evidence-backed decision', content: 'Use evidence for trust.',
      evidence: [{
        type: 'test', locator: 'tests/evidence.test.ts', observedAt: '2026-07-11T00:00:00.000Z', relationship: 'supports',
      }],
    } as any);
    expect(decision.action).toBe('inserted');
    expect(await listEvidenceForItem(decision.item.id)).toEqual([
      expect.objectContaining({ type: 'test', relationship: 'supports' }),
    ]);
    await repo.updateKnowledgeItem(decision.item.id, { content: 'Use evidence for durable trust.' });
    expect(await listEvidenceForItem(decision.item.id)).toHaveLength(1);

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

  it('sees evidence when deciding whether a re-decide adds anything', async () => {
    // `resolveDuplicate` compares evidence and skill steps only when the caller hands it the
    // stored item's held payload; without one those two fields are simply not compared. Every
    // other write path passes `heldPayloadFor`. `recordDecisionDirect` did not, so `knowl
    // decide` and `knowl_decide` answered "already held verbatim, nothing was lost" to a
    // decision whose only new content was the evidence backing it -- and dropped it.
    const first = await recordDecisionDirect(projectId, {
      title: 'Ship the importer behind a flag',
      content: 'The importer ships dark until the backfill has run once in production.',
    });
    expect(first.action).toBe('inserted');

    const again = await recordDecisionDirect(projectId, {
      title: 'Ship the importer behind a flag',
      content: 'The importer ships dark until the backfill has run once in production.',
      evidence: [{
        type: 'commit', locator: 'deadbeef', observedAt: '2026-08-04T00:00:00.000Z', relationship: 'supports',
      }],
    } as any);

    expect(again.action).toBe('inserted');
    expect(await listEvidenceForItem(again.item.id)).toEqual([
      expect.objectContaining({ type: 'commit', locator: 'deadbeef', relationship: 'supports' }),
    ]);
    expect((await repo.getKnowledgeItem(first.item.id))!.status).toBe('superseded');
  });

  it('still deduplicates a re-decide that carries no evidence either side', async () => {
    // The comparison is asymmetric on purpose: comparing evidence must not turn an ordinary
    // identical re-decide into churn.
    const first = await recordDecisionDirect(projectId, {
      title: 'Keep the queue single-writer', content: 'One writer, no locking protocol to get wrong.',
    });
    const again = await recordDecisionDirect(projectId, {
      title: 'Keep the queue single-writer', content: 'One writer, no locking protocol to get wrong.',
    });
    expect(again.action).toBe('duplicate');
    expect(again.item.id).toBe(first.item.id);
  });
});
