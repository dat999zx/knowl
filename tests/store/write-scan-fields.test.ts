import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { closeDb, getDb, initDb } from '../../src/store/database.js';
import * as repo from '../../src/store/repository.js';
import { auditKnowledgeStore } from '../../src/store/integrity.js';
import * as portability from '../../src/store/portability.js';

/**
 * Every write path scans every field it writes.
 *
 * `validateKnowledgeWrite` reads `tags` and `alternatives`, but three callers assembled the
 * object they handed it as a literal of exactly five fields -- title, content, reasoning,
 * source, affectedPaths. An absent field is not a clean field: the scan silently covered
 * nothing. So the store-wide audit answered "no integrity findings" over a row whose `tags`
 * held a live credential, an update could put in `tags` what create had refused, and import
 * accepted the same row from a peer.
 *
 * The literals below are fixtures, not real credentials: `ghp_` is the GitHub token shape and
 * `AKIA` the AWS access-key-id shape, both of which `KNOWN_TOKEN` matches by prefix alone.
 */
const GITHUB_SHAPED = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
const AWS_SHAPED = 'AKIAIOSFODNN7EXAMPLE';

const ROOT = path.resolve('./.knowl-write-scan-test');
const TARGET = path.resolve('./.knowl-write-scan-target');

describe('the write-scan projection', () => {
  beforeAll(async () => {
    await fs.rm(ROOT, { recursive: true, force: true });
    await fs.rm(TARGET, { recursive: true, force: true });
    await fs.mkdir(path.join(ROOT, '.knowl'), { recursive: true });
    await initDb(ROOT);
  });

  afterAll(async () => {
    await closeDb();
    await fs.rm(ROOT, { recursive: true, force: true }).catch(() => {});
    await fs.rm(TARGET, { recursive: true, force: true }).catch(() => {});
  });

  it('audits the tags column, not just the prose columns', async () => {
    const project = await repo.createProject(ROOT, 'Write scan');
    const poisoned = await repo.createKnowledgeItem(project.id, {
      category: 'fact', title: 'Tagged item', content: 'Safe durable knowledge.',
    });
    const clean = await repo.createKnowledgeItem(project.id, {
      category: 'fact', title: 'Untagged item', content: 'Safe durable knowledge.',
    });
    // Raw SQL on purpose: the create path already refuses this, which is exactly the
    // asymmetry -- the row can only exist because an older writer let it in.
    const db = getDb() as any;
    await db.run(sql`UPDATE knowledge_items SET tags = ${JSON.stringify(['ops', GITHUB_SHAPED])} WHERE id = ${poisoned.id}`);

    const findings = (await auditKnowledgeStore()).findings;
    expect(findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'secret', itemId: poisoned.id }),
    ]));
    expect(findings.filter(finding => finding.itemId === clean.id)).toEqual([]);
    expect(JSON.stringify(findings)).not.toContain(GITHUB_SHAPED);
  });

  it('audits the alternatives column, not just the prose columns', async () => {
    const project = await repo.createProject(ROOT, 'Write scan');
    const poisoned = await repo.createKnowledgeItem(project.id, {
      category: 'decision', title: 'Item with alternatives', content: 'Safe durable knowledge.',
    });
    const db = getDb() as any;
    await db.run(sql`UPDATE knowledge_items SET alternatives = ${JSON.stringify(['keep it', AWS_SHAPED])} WHERE id = ${poisoned.id}`);

    expect((await auditKnowledgeStore()).findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'secret', itemId: poisoned.id }),
    ]));
  });

  it('refuses an update that puts in tags what create would have refused', async () => {
    const project = await repo.createProject(ROOT, 'Write scan');
    const item = await repo.createKnowledgeItem(project.id, {
      category: 'fact', title: 'Clean on create', content: 'Safe durable knowledge.', tags: ['ops'],
    });

    await expect(repo.createKnowledgeItem(project.id, {
      category: 'fact', title: 'Rejected on create', content: 'Safe.', tags: ['ops', GITHUB_SHAPED],
    })).rejects.toThrow(/secret/i);
    await expect(repo.updateKnowledgeItem(item.id, { tags: ['ops', GITHUB_SHAPED] }))
      .rejects.toThrow(/secret/i);
    await expect(repo.updateKnowledgeItem(item.id, { alternatives: ['keep it', AWS_SHAPED] }))
      .rejects.toThrow(/secret/i);

    // Refused means nothing landed: `dbUpdates` spreads the whole argument, so a validator
    // that passed would have written the credential into the row.
    expect((await repo.getKnowledgeItem(item.id))!.tags).toEqual(['ops']);
  });

  it('scans skill steps on create and on update', async () => {
    const project = await repo.createProject(ROOT, 'Write scan');
    await expect(repo.createKnowledgeItem(project.id, {
      category: 'skill', title: 'Poisoned skill', content: 'Safe.',
    }, ['run it', `export TOKEN=${GITHUB_SHAPED}`])).rejects.toThrow(/secret/i);

    const skill = await repo.createKnowledgeItem(project.id, {
      category: 'skill', title: 'Clean skill', content: 'Safe.',
    }, ['run it']);
    await expect(repo.updateKnowledgeItem(skill.id, {}, [`export TOKEN=${GITHUB_SHAPED}`]))
      .rejects.toThrow(/secret/i);
  });

  it('still allows a metadata-only update of an item whose stored prose trips a detector', async () => {
    const project = await repo.createProject(ROOT, 'Write scan');
    const item = await repo.createKnowledgeItem(project.id, {
      category: 'fact', title: 'Ordinary item', content: 'Safe durable knowledge.',
    });
    const db = getDb() as any;
    await db.run(sql`UPDATE knowledge_items SET content = ${'sk-test-123456789012345678901234567890'} WHERE id = ${item.id}`);

    const superseded = await repo.updateKnowledgeItem(item.id, { status: 'superseded' });
    expect(superseded.status).toBe('superseded');
  });

  it('refuses an import whose incoming tags carry a credential', async () => {
    const project = await repo.createProject(ROOT, 'Write scan');
    const item = await repo.createKnowledgeItem(project.id, {
      category: 'fact', title: 'Exported with a poisoned tag', content: 'Safe durable knowledge.',
    });
    const db = getDb() as any;
    await db.run(sql`UPDATE knowledge_items SET tags = ${JSON.stringify(['ops', GITHUB_SHAPED])} WHERE id = ${item.id}`);

    const exportPath = path.join(ROOT, 'peer.jsonl');
    // Just this item: earlier cases in this file rewrite other rows' content behind the
    // write path, which leaves their `content_hash` deliberately misdescribing them and
    // would trip the import's own hash guard before the scan is ever reached.
    await portability.exportKnowledge(project.id, exportPath, ROOT, [item.id]);

    await closeDb();
    await fs.mkdir(path.join(TARGET, '.knowl'), { recursive: true });
    await initDb(TARGET);

    await expect((portability as any).importKnowledge(exportPath)).rejects.toThrow(/secret/i);
    expect((await repo.listKnowledgeItems()).map(entry => entry.id)).not.toContain(item.id);
  });
});
