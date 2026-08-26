import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, getClient, initDb } from '../../src/store/database.js';
import * as repo from '../../src/store/repository.js';
import { getAccessSummary } from '../../src/store/access-feedback.js';
import { storeKnowledgeItemDeduped } from '../../src/store/knowledge-writer.js';
import { previewKnowledgeGc } from '../../src/store/gc.js';

/**
 * A no-op duplicate write means an agent concluded something the store already held, without the
 * store having handed it over. It is the only positive capture signal in the system, and it used
 * to be computed and thrown away. These pin the two halves of what it is now allowed to do:
 * protect an item from decay, and stay out of the retrieval numbers while doing it.
 */

const ROOT = path.resolve('./.knowl-rederivation-test');
const OLD = new Date(Date.now() - 90 * 86_400_000).toISOString();
const NOW = new Date().toISOString();

async function backdate(itemId: string) {
  await getClient().execute({ sql: 'UPDATE knowledge_items SET updated_at = ? WHERE id = ?', args: [OLD, itemId] });
}

const state = (title: string, content: string) => ({ category: 'state' as const, title, content });

describe('re-derivation signal', () => {
  let projectId = '';
  beforeAll(async () => {
    await fs.rm(ROOT, { recursive: true, force: true });
    await fs.mkdir(path.join(ROOT, '.knowl'), { recursive: true });
    await initDb(ROOT);
    projectId = (await repo.createProject(ROOT, 'rederivation')).id;
  });
  afterAll(async () => { await closeDb(); await fs.rm(ROOT, { recursive: true, force: true }).catch(() => {}); });

  it('counts a no-op duplicate write without calling it a retrieval', async () => {
    const atom = state('Vector index rebuild runs nightly', 'The rebuild is scheduled at 02:00 and takes about four minutes.');
    const first = await storeKnowledgeItemDeduped(projectId, atom);
    expect(first.action).not.toBe('duplicate');

    const second = await storeKnowledgeItemDeduped(projectId, atom);
    expect(second.action).toBe('duplicate');
    expect(second.item.id).toBe(first.item.id);

    const summary = (await getAccessSummary()).get(first.item.id);
    expect(summary?.rederivedCount).toBe(1);
    // The whole reason for a separate surface: the never-read lens and `isHot` both read these
    // two, and a write must not make an atom look like it was read.
    expect(summary?.retrievalCount).toBe(0);
    expect(summary?.lastRetrievedAt).toBeNull();
  });

  it('protects a stale item re-derived twice, and archives one re-derived once', async () => {
    const twice = state('Session ids are host-scoped', 'A host session id is unique per host, not globally.');
    const once = state('Snapshot files are gzip framed', 'Every snapshot payload carries a gzip frame header.');
    const repeated = (await storeKnowledgeItemDeduped(projectId, twice)).item;
    const single = (await storeKnowledgeItemDeduped(projectId, once)).item;

    await storeKnowledgeItemDeduped(projectId, twice);
    await storeKnowledgeItemDeduped(projectId, twice);
    await storeKnowledgeItemDeduped(projectId, once);

    await backdate(repeated.id);
    await backdate(single.id);

    const result = await previewKnowledgeGc(projectId, { now: NOW });
    const archived = result.candidates.filter(candidate => candidate.action === 'archive').map(candidate => candidate.itemId);
    expect(archived).not.toContain(repeated.id);
    // One re-derivation is under the bar -- a single phrasing coincidence must not pin an atom
    // in place forever, or nothing stale would ever be collected.
    expect(archived).toContain(single.id);

    // --ignore-access still overrides it, same as for a retrieved item.
    const forced = await previewKnowledgeGc(projectId, { now: NOW, ignoreAccess: true });
    expect(forced.candidates.filter(c => c.action === 'archive').map(c => c.itemId)).toContain(repeated.id);
  });
});
