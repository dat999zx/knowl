import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, getClient, initDb } from '../../src/store/database.js';
import * as repo from '../../src/store/repository.js';
import { runDoctor } from '../../src/cli/doctor-report.js';
import { fingerprintProfile, resolveVectorProfile } from '../../src/core/vector-profile.js';
import { DEFAULT_CONFIG } from '../../src/core/config.js';
import type { ProjectConfig } from '../../src/core/types.js';

const ARCTIC = {
  enabled: true, provider: 'local', model: 'Snowflake/snowflake-arctic-embed-m-v2.0',
  dtype: 'q8', pooling: 'cls',
};

let root = '';

async function setup(vector: Record<string, unknown>): Promise<string> {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'knowl-doctor-'));
  await fs.mkdir(path.join(root, '.knowl'), { recursive: true });
  await fs.writeFile(
    path.join(root, '.knowl', 'config.json'),
    JSON.stringify({ ...DEFAULT_CONFIG, search: { vector } }),
    'utf-8',
  );
  await initDb(root);
  const project = await repo.createProject(root, 'doctor-report');
  await repo.createKnowledgeItem(project.id, {
    category: 'fact',
    title: 'An active item',
    content: 'Something worth remembering.',
  });
  return project.id;
}

/** Write an embedding row directly, so its fingerprint is exactly what the test says. */
async function writeEmbedding(itemId: string, fingerprint: string | null): Promise<void> {
  await getClient().execute({
    sql: `INSERT INTO knowledge_embeddings (knowledge_item_id, provider, model, profile_fingerprint, dimensions, vector, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)`,
    args: [itemId, 'local', 'Snowflake/snowflake-arctic-embed-m-v2.0', fingerprint, 2,
      new Uint8Array(Float32Array.from([0.6, 0.8]).buffer), new Date().toISOString()],
  });
}

async function onlyItemId(): Promise<string> {
  const rows = await getClient().execute('SELECT id FROM knowledge_items LIMIT 1');
  return String((rows.rows[0] as any).id);
}

function coverageCheck(checks: Array<{ status: string; message: string; fix?: string }>) {
  return checks.find(check => /active item\(s\)|invisible to semantic search/i.test(check.message))!;
}

describe('doctor vector coverage', () => {
  // The suite sets KNOWL_DISABLE_WRITE_EMBEDDING=1 globally, and the coverage check reports
  // OK unconditionally when it is set -- a chosen gap is not a problem to report. These
  // tests are about the gap nobody chose.
  beforeEach(() => { delete process.env.KNOWL_DISABLE_WRITE_EMBEDDING; });
  afterEach(async () => {
    process.env.KNOWL_DISABLE_WRITE_EMBEDDING = '1';
    await closeDb();
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  });

  it('counts an embedding written under NO profile fingerprint as missing', async () => {
    // K-60, live in the duckprep store: eight active items carried a NULL fingerprint,
    // written by `serve` processes still running a pre-migration build. Every read path --
    // `searchKnowledgeEmbeddings`, `findEmbeddedItemIds` -- filters on the fingerprint, so
    // those rows were unreachable, while doctor's join had no such predicate and reported
    // `all N active item(s) embedded`. The one check written to make this visible was the
    // one place in the system that treated the fingerprint as optional.
    await setup(ARCTIC);
    await writeEmbedding(await onlyItemId(), null);
    await closeDb();

    const check = coverageCheck((await runDoctor(root)).checks);

    expect(check.status).toBe('WARN');
    expect(check.message).toContain('1 of 1');
    expect(check.fix).toContain('knowl reindex --vectors');
  });

  it('counts an embedding written under a DIFFERENT profile as missing', async () => {
    // Same mechanism, the ordinary way to reach it: change the model (or the dtype, or the
    // pooling) and every stored vector is scored against an incompatible query vector, so
    // search filters them all out. Doctor used to call that a fully covered store.
    await setup(ARCTIC);
    await writeEmbedding(await onlyItemId(), fingerprintProfile({
      provider: 'local', model: 'Xenova/all-MiniLM-L6-v2', dtype: 'q8', pooling: 'mean',
    }));
    await closeDb();

    const check = coverageCheck((await runDoctor(root)).checks);

    expect(check.status).toBe('WARN');
    expect(check.message).toContain('1 of 1');
  });

  it('reports full coverage for a row written under the current profile', async () => {
    const config = { version: 1, search: { vector: ARCTIC } } as unknown as ProjectConfig;
    await setup(ARCTIC);
    await writeEmbedding(await onlyItemId(), fingerprintProfile(resolveVectorProfile(config)));
    await closeDb();

    const check = coverageCheck((await runDoctor(root)).checks);

    expect(check.status).toBe('OK');
    expect(check.message).toMatch(/all 1 active item\(s\) embedded/);
  });
});
