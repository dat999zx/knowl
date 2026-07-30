import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, getClient, initDb } from '../../src/store/database.js';
import { releaseAll } from '../../src/store/connection-pool.js';
import * as repo from '../../src/store/repository.js';
import { storeKnowledgeItemDeduped } from '../../src/store/knowledge-writer.js';
import { exportKnowledge, importKnowledge } from '../../src/store/portability.js';
import { promoteItems } from '../../src/workspace/promote.js';
import { resetWriteOwnershipCache } from '../../src/store/write-ownership.js';
import { DEFAULT_CONFIG, saveConfig } from '../../src/core/config.js';

let counter = 0;
let SOURCE = '';
let TARGET = '';
let DUMP = '';

async function makeRepo(root: string) {
  await fs.mkdir(path.join(root, '.knowl'), { recursive: true });
  await saveConfig(root, { ...DEFAULT_CONFIG });
}

/**
 * One open/close per repo per step. `closeDb` releases the whole connection pool, so the next
 * open re-runs the full schema bootstrap -- the suite is capped at 4 workers precisely because
 * it is already close to starving vitest's worker RPC, and a test that opens the database six
 * times pushes the spawn-heavy CLI suites over their timeouts.
 */
async function session<T>(root: string, run: () => Promise<T>): Promise<T> {
  await initDb(root);
  try {
    return await run();
  } finally {
    await closeDb();
  }
}

async function write(root: string, title: string, content: string): Promise<string> {
  const projectId = (await repo.createProject(root, 'p')).id;
  const result = await storeKnowledgeItemDeduped(projectId, { category: 'decision', title, content });
  return result.item.id;
}

async function ownership(title: string) {
  const rows = await getClient().execute({
    sql: 'SELECT origin_repo, visibility, lifecycle_hash, content_hash FROM knowledge_items WHERE title = ?',
    args: [title],
  });
  const row = rows.rows[0];
  if (!row) return null;
  return {
    originRepo: row.origin_repo === null ? null : String(row.origin_repo),
    visibility: String(row.visibility),
    lifecycleHash: row.lifecycle_hash === null ? null : String(row.lifecycle_hash),
    contentHash: row.content_hash === null ? null : String(row.content_hash),
  };
}

/** Rewrites a Knowl JSONL file's records and recomputes the trailing manifest checksum. */
async function rewrite(file: string, transform: (records: any[]) => any[]) {
  const lines = (await fs.readFile(file, 'utf8')).split('\n').filter(Boolean);
  const records = transform(lines.slice(0, -1).map(line => JSON.parse(line)));
  const body = `${records.map(record => JSON.stringify(record)).join('\n')}\n`;
  const sha256 = crypto.createHash('sha256').update(body).digest('hex');
  await fs.writeFile(file, `${body}${JSON.stringify({ type: 'manifest', sha256 })}\n`, 'utf8');
}

describe('ownership and lifecycle survive export and import', () => {
  beforeEach(async () => {
    await closeDb();
    await releaseAll();
    resetWriteOwnershipCache();
    counter += 1;
    SOURCE = path.resolve(`./.knowl-export-src${counter}`);
    TARGET = path.resolve(`./.knowl-export-dst${counter}`);
    DUMP = path.resolve(`./.knowl-export-dump${counter}.jsonl`);
    for (const dir of [SOURCE, TARGET]) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    await fs.rm(DUMP, { force: true }).catch(() => {});
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

  it('carries the owning repo and visibility through a round trip', async () => {
    // The bug: ITEM_COLUMNS listed 21 columns and included neither origin_repo nor
    // visibility, while export emitted both. So a workspace-visible item owned by "server"
    // came back owned by nobody, private, with nothing reporting it.
    await session(SOURCE, async () => {
      const id = await write(SOURCE, 'Wire format is protobuf', 'Server and client exchange protobuf.');
      await getClient().execute({
        sql: "UPDATE knowledge_items SET origin_repo = 'server', visibility = 'workspace' WHERE id = ?",
        args: [id],
      });
      await exportKnowledge('local', DUMP, SOURCE);
    });

    const landed = await session(TARGET, async () => {
      await importKnowledge(DUMP, { projectRoot: TARGET });
      return ownership('Wire format is protobuf');
    });

    expect(landed).toMatchObject({ originRepo: 'server', visibility: 'workspace' });
  });

  it('converges a promotion that reaches a machine holding the old copy', async () => {
    // content_hash is unchanged by a promotion, so the receiving side classified this as
    // identical and skipped it. The item stayed private on the second machine forever.
    const id = await session(SOURCE, async () => {
      const written = await write(SOURCE, 'Retries cap at three', 'Outbound calls retry three times.');
      await exportKnowledge('local', DUMP, SOURCE);
      return written;
    });

    const before = await session(TARGET, async () => {
      await importKnowledge(DUMP, { projectRoot: TARGET });
      return ownership('Retries cap at three');
    });
    expect(before?.visibility).toBe('repo');

    // Promoted through the production path, not raw SQL: the point is that a real promotion
    // produces an export the other side acts on.
    await promoteItems({ projectRoot: SOURCE, repoName: 'server', ids: [id], apply: true });
    await session(SOURCE, () => exportKnowledge('local', DUMP, SOURCE));

    const { result, after } = await session(TARGET, async () => ({
      result: await importKnowledge(DUMP, { projectRoot: TARGET }),
      after: await ownership('Retries cap at three'),
    }));

    expect(result.updated).toBe(1);
    expect(after).toMatchObject({ visibility: 'workspace', originRepo: 'server' });
  });

  it('stops trading updates once a metadata change has landed', async () => {
    // The metadata update must write content_hash verbatim, or the next round classifies it
    // as divergent again and the two sides ping-pong a fresh winner forever.
    const id = await session(SOURCE, async () => {
      const written = await write(SOURCE, 'Queue is at-least-once', 'Consumers must be idempotent.');
      await exportKnowledge('local', DUMP, SOURCE);
      return written;
    });
    await session(TARGET, () => importKnowledge(DUMP, { projectRoot: TARGET }));

    await promoteItems({ projectRoot: SOURCE, repoName: 'server', ids: [id], apply: true });
    const sourceHash = await session(SOURCE, async () => {
      await exportKnowledge('local', DUMP, SOURCE);
      return (await ownership('Queue is at-least-once'))?.contentHash;
    });

    const { first, second, landed } = await session(TARGET, async () => ({
      first: await importKnowledge(DUMP, { projectRoot: TARGET }),
      second: await importKnowledge(DUMP, { projectRoot: TARGET }),
      landed: await ownership('Queue is at-least-once'),
    }));

    expect(first.updated).toBe(1);
    expect(second.identical).toBe(1);
    expect(second.updated).toBe(0);
    expect(landed?.contentHash).toBe(sourceHash);
  });

  it('stamps a lifecycle hash on an ordinary write', async () => {
    const stamped = await session(SOURCE, async () => {
      await write(SOURCE, 'Cache TTL is 60s', 'Entries expire after sixty seconds.');
      return ownership('Cache TTL is 60s');
    });
    expect(stamped?.lifecycleHash).toBeTruthy();
  });

  it('changes the lifecycle hash when status changes, and leaves the content hash alone', async () => {
    const { before, after } = await session(SOURCE, async () => {
      const id = await write(SOURCE, 'Tracing is opt-in', 'Spans are emitted only when enabled.');
      const first = await ownership('Tracing is opt-in');
      await repo.updateKnowledgeItem(id, { status: 'archived' });
      return { before: first, after: await ownership('Tracing is opt-in') };
    });

    expect(after?.lifecycleHash).not.toBe(before?.lifecycleHash);
    expect(after?.contentHash).toBe(before?.contentHash);
  });

  it('accepts a version-1 file with ownership defaulted rather than refusing it', async () => {
    await session(SOURCE, async () => {
      await write(SOURCE, 'Auth uses mTLS', 'Services authenticate with client certificates.');
      await exportKnowledge('local', DUMP, SOURCE);
    });

    // Downgrade the file to exactly what 2.6.0 produced: header version 1, and no ownership
    // or lifecycle fields on the item at all.
    await rewrite(DUMP, records => records.map(record => {
      if (record.type === 'header') return { ...record, version: 1 };
      if (record.type !== 'item') return record;
      const { originRepo, visibility, lifecycleHash, ...rest } = record.item;
      return { ...record, item: rest };
    }));

    const { result, landed } = await session(TARGET, async () => ({
      result: await importKnowledge(DUMP, { projectRoot: TARGET }),
      landed: await ownership('Auth uses mTLS'),
    }));

    expect(result.inserted).toBe(1);
    expect(landed).toMatchObject({ originRepo: null, visibility: 'repo' });
  });

  it('converges a promotion carried by a version-1 file, which has no lifecycle hash', async () => {
    // A version-1 export predates lifecycle_hash but still serialises visibility and
    // origin_repo, so the promotion is in the file. Treating the missing hash as agreement
    // discarded it, and the receiving side stayed private forever with nothing reporting it.
    const id = await session(SOURCE, async () => {
      const written = await write(SOURCE, 'Rate limit is per tenant', 'Quotas are counted per tenant, not per key.');
      await exportKnowledge('local', DUMP, SOURCE);
      return written;
    });
    await session(TARGET, () => importKnowledge(DUMP, { projectRoot: TARGET }));

    await promoteItems({ projectRoot: SOURCE, repoName: 'server', ids: [id], apply: true });
    await session(SOURCE, () => exportKnowledge('local', DUMP, SOURCE));
    // Strip the file back to version 1: header version, and no lifecycleHash on the item.
    await rewrite(DUMP, records => records.map(record => {
      if (record.type === 'header') return { ...record, version: 1 };
      if (record.type !== 'item') return record;
      const { lifecycleHash, ...rest } = record.item;
      return { ...record, item: rest };
    }));

    const { result, landed } = await session(TARGET, async () => ({
      result: await importKnowledge(DUMP, { projectRoot: TARGET }),
      landed: await ownership('Rate limit is per tenant'),
    }));

    expect(result.updated).toBe(1);
    expect(landed).toMatchObject({ visibility: 'workspace', originRepo: 'server' });
    // And the row is left fingerprinted, so the next round can compare it at all.
    expect(landed?.lifecycleHash).toBeTruthy();
  });

  it('exports at format version 2, since ownership is now a portable field', async () => {
    await session(SOURCE, async () => {
      await write(SOURCE, 'Region is eu-west-1', 'All services run in eu-west-1.');
      await exportKnowledge('local', DUMP, SOURCE);
    });

    const header = JSON.parse((await fs.readFile(DUMP, 'utf8')).split('\n')[0]);
    expect(header).toMatchObject({ type: 'header', format: 'knowl-jsonl', version: 2 });
  });

  it('refuses a format version it does not understand, naming the version', async () => {
    // The reason the bump matters: a reader that silently accepted an unknown version would
    // drop whatever fields it did not know about, which is the bug this change fixes.
    await session(SOURCE, async () => {
      await write(SOURCE, 'Deploys are blue-green', 'Two identical fleets swap on release.');
      await exportKnowledge('local', DUMP, SOURCE);
    });
    await rewrite(DUMP, records => records.map(record =>
      record.type === 'header' ? { ...record, version: 3 } : record));

    await session(TARGET, async () => {
      await expect(importKnowledge(DUMP, { projectRoot: TARGET })).rejects.toThrow(/version 3/i);
    });
  });
});
