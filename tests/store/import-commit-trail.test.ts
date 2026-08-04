import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, getClient, initDb } from '../../src/store/database.js';
import { releaseAll } from '../../src/store/connection-pool.js';
import * as repo from '../../src/store/repository.js';
import { storeKnowledgeItemDeduped } from '../../src/store/knowledge-writer.js';
import { exportKnowledge, importKnowledge } from '../../src/store/portability.js';
import { readCommitHead, loadForeignChanges } from '../../src/store/change-watermark.js';
import { resetWriteOwnershipCache } from '../../src/store/write-ownership.js';
import { DEFAULT_CONFIG, saveConfig } from '../../src/core/config.js';

/**
 * Does an import tell anyone it happened?
 *
 * Every other write path calls `createKnowledgeCommit`, and the session-start change card is
 * driven by `knowledge_commits` -- `readCommitHead` is `MAX(rowid)` of that table. Import
 * writes raw SQL and no commit, so the question is whether a repo that just received a
 * hundred facts reports zero changes to the next agent that opens it.
 */

let index = 0;
let SOURCE = '';
let TARGET = '';
let DUMP = '';

async function makeRepo(root: string) {
  await fs.mkdir(path.join(root, '.knowl'), { recursive: true });
  await saveConfig(root, { ...DEFAULT_CONFIG });
}

async function session<T>(root: string, run: () => Promise<T>): Promise<T> {
  await initDb(root);
  try {
    return await run();
  } finally {
    await closeDb();
  }
}

describe('an import is a change the next session should hear about', () => {
  beforeEach(async () => {
    await closeDb();
    await releaseAll();
    resetWriteOwnershipCache();
    index += 1;
    SOURCE = path.resolve(`./.knowl-commit-trail-src${index}`);
    TARGET = path.resolve(`./.knowl-commit-trail-dst${index}`);
    DUMP = path.resolve(`./.knowl-commit-trail${index}.jsonl`);
    await makeRepo(SOURCE);
    await makeRepo(TARGET);
  });

  afterEach(async () => {
    await closeDb();
    await releaseAll();
    resetWriteOwnershipCache();
    for (const dir of [SOURCE, TARGET]) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    await fs.rm(DUMP, { force: true }).catch(() => {});
  });

  it('moves the commit head and names the items it brought in', async () => {
    await session(SOURCE, async () => {
      const projectId = (await repo.createProject(SOURCE, 'p')).id;
      for (const title of ['Deploys are blue-green', 'Retries cap at three']) {
        await storeKnowledgeItemDeduped(projectId, { category: 'decision', title, content: `${title}, in detail.` });
      }
      await exportKnowledge('local', DUMP, SOURCE);
    });

    const { before, after, changes } = await session(TARGET, async () => {
      const head = await readCommitHead();
      await importKnowledge(DUMP, { projectRoot: TARGET });
      return {
        before: head,
        after: await readCommitHead(),
        changes: await loadForeignChanges(head),
      };
    });

    // Without a commit the head never moves, and the card that tells the next agent what
    // arrived is driven entirely by that head.
    expect(after).toBeGreaterThan(before);
    expect(changes.items.map(item => item.title).sort())
      .toEqual(['Deploys are blue-green', 'Retries cap at three']);
  });

  it('records nothing for an import that changed nothing', async () => {
    // A re-import of the same file is `identical` all the way down. A commit per invocation
    // would report a change that did not happen, which is worse than reporting none.
    await session(SOURCE, async () => {
      const projectId = (await repo.createProject(SOURCE, 'p')).id;
      await storeKnowledgeItemDeduped(projectId, {
        category: 'decision', title: 'Deploys are blue-green', content: 'Two fleets swap.',
      });
      await exportKnowledge('local', DUMP, SOURCE);
    });

    const { first, second } = await session(TARGET, async () => {
      await importKnowledge(DUMP, { projectRoot: TARGET });
      const head = await readCommitHead();
      await importKnowledge(DUMP, { projectRoot: TARGET });
      return { first: head, second: await readCommitHead() };
    });

    expect(second).toBe(first);
  });

  it('writes no commit for a dry run', async () => {
    await session(SOURCE, async () => {
      const projectId = (await repo.createProject(SOURCE, 'p')).id;
      await storeKnowledgeItemDeduped(projectId, {
        category: 'decision', title: 'Deploys are blue-green', content: 'Two fleets swap.',
      });
      await exportKnowledge('local', DUMP, SOURCE);
    });

    const { before, after } = await session(TARGET, async () => {
      const head = await readCommitHead();
      await importKnowledge(DUMP, { projectRoot: TARGET, dryRun: true });
      return { before: head, after: await readCommitHead() };
    });

    expect(after).toBe(before);
  });

  it('leaves no commit behind when the import rolls back', async () => {
    // The commit must be part of the same transaction as the rows, or a failed import
    // announces knowledge that is not there.
    await session(SOURCE, async () => {
      const projectId = (await repo.createProject(SOURCE, 'p')).id;
      await storeKnowledgeItemDeduped(projectId, {
        category: 'decision', title: 'Deploys are blue-green', content: 'Two fleets swap.',
      });
      await exportKnowledge('local', DUMP, SOURCE);
    });

    const { before, after, items } = await session(TARGET, async () => {
      const head = await readCommitHead();
      // A trigger that aborts the item insert, so the import fails mid-transaction.
      await getClient().execute(`
        CREATE TRIGGER refuse_import BEFORE INSERT ON knowledge_items
        BEGIN SELECT RAISE(ABORT, 'refused'); END;
      `);
      await importKnowledge(DUMP, { projectRoot: TARGET }).catch(() => {});
      await getClient().execute('DROP TRIGGER refuse_import;');
      const rows = await getClient().execute('SELECT COUNT(*) AS n FROM knowledge_items');
      return { before: head, after: await readCommitHead(), items: Number(rows.rows[0].n) };
    });

    expect(items).toBe(0);
    expect(after).toBe(before);
  });
});
