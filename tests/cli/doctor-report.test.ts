import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, getClient, initDb } from '../../src/store/database.js';
import * as repo from '../../src/store/repository.js';
import { runDoctor } from '../../src/cli/doctor-report.js';
import { installKnowlProjectGuidance } from '../../src/core/agents-guidance.js';
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
  // Anchored on the opening words, which only the vector coverage check uses. Matching
  // "active item(s)" loosely used to be unambiguous; the lexical coverage check now reports a
  // count in the same words and sits earlier in the list, so a loose match selected that one.
  return checks.find(check => /^Vector search/i.test(check.message))!;
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

describe('doctor retrieval self-test', () => {
  afterEach(async () => {
    await closeDb();
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  });

  /** A repository with a registered project and nothing in it. */
  async function bareRepo(): Promise<string> {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'knowl-probe-'));
    await fs.mkdir(path.join(root, '.knowl'), { recursive: true });
    await fs.writeFile(path.join(root, '.knowl', 'config.json'), JSON.stringify(DEFAULT_CONFIG), 'utf-8');
    // Guidance too, because `knowl init` writes it and this fixture is standing in for an
    // initialised repository. Building `.knowl` by hand without it produced a state no real
    // install reaches -- and once stale guidance became a FAIL, that artificial gap was what
    // these tests were measuring instead of the probe they are named for.
    await installKnowlProjectGuidance(root);
    await initDb(root);
    return (await repo.createProject(root, 'doctor-probe')).id;
  }

  /** Make this item unambiguously the newest, so the probe is known to target it. */
  async function makeNewest(itemId: string): Promise<void> {
    await getClient().execute({
      sql: 'UPDATE knowledge_items SET updated_at = ? WHERE id = ?',
      args: ['2999-01-01T00:00:00.000Z', itemId],
    });
  }

  function probeCheck(checks: Array<{ status: string; message: string; fix?: string }>) {
    return checks.find(check => /retrieval self-test|no knowledge stored yet/i.test(check.message))!;
  }

  function coverageLine(checks: Array<{ status: string; message: string; fix?: string }>) {
    return checks.find(check => /lexical index|FTS index/i.test(check.message))!;
  }

  it('catches the items the probe never looked at', async () => {
    // The hole a single-item probe leaves, found by attacking a real store: deleting the FTS
    // rows of 624 of its 625 items left the probe passing at "rank 1 of 1". Coverage is counted
    // for every item precisely so one green query cannot stand in for the whole store.
    const projectId = await bareRepo();
    const stale = await repo.createKnowledgeItem(projectId, {
      category: 'fact',
      title: 'An older item that keyword search is about to lose',
      content: 'Reachable until its index row goes.',
    });
    const newest = await repo.createKnowledgeItem(projectId, {
      category: 'fact',
      title: 'Postgres connection pool exhausts during concurrent migrations',
      content: 'Migrations open their own connections.',
    });
    await makeNewest(newest.id);
    await getClient().execute({
      sql: 'DELETE FROM knowledge_items_fts WHERE item_id = ?',
      args: [stale.id],
    });
    await closeDb();

    const result = await runDoctor(root);

    // The probe is happy: it queried the item that still works.
    expect(probeCheck(result.checks).status).toBe('OK');
    // Coverage is not. This suite runs with embedding writes disabled, so the item it lost is
    // in no index at all -- reachable by nothing, which is a failure rather than degradation.
    expect(coverageLine(result.checks).status).toBe('FAIL');
    expect(coverageLine(result.checks).message).toContain('1 of 2');
    expect(result.ready).toBe(false);
  });

  it('reports READY on a repository with nothing stored yet', async () => {
    // The bug this whole change came from: `knowl init` on a fresh repo printed "ready", then
    // `knowl doctor` printed NOT READY on the same install, because the only non-OK line was
    // an advisory "nothing stored yet" and the verdict gated on every check being OK.
    await bareRepo();
    await closeDb();

    const result = await runDoctor(root);

    expect(probeCheck(result.checks).status).toBe('WARN');
    expect(result.ready).toBe(true);
    expect(result.checks.some(check => check.status === 'FAIL')).toBe(false);
  });

  it('is NOT READY when the guidance on disk is stale', async () => {
    // The gap this closes: guidance staleness was a WARN and the verdict gates on FAIL, so
    // `doctor` said READY while the lifecycle hook injected a card rendered from the running
    // build and the host read a contradicting KNOWL.md from disk. Measured 2026-08-08 -- a knowl
    // command run against a stale dist/ reverted guidance that had just landed and nothing said so.
    await bareRepo();
    const knowlMd = path.join(root, 'KNOWL.md');
    const current = await fs.readFile(knowlMd, 'utf-8');
    await fs.writeFile(knowlMd, current.replace('### Linked repositories', '### Linked repos (from an older build)'), 'utf-8');
    await closeDb();

    const result = await runDoctor(root);
    const guidance = result.checks.find(check => check.message.includes('KNOWL.md'));

    expect(guidance?.status).toBe('FAIL');
    expect(result.ready).toBe(false);
    // The remedy stays wired, so `doctor --fix` can still repair what the verdict now blocks on.
    expect(guidance?.remedy).toEqual({ kind: 'guidance' });
  });

  it('is READY once that guidance matches the running build', async () => {
    // The control. Without it the assertion above would pass on any repository at all, and the
    // fixture change that installs guidance would be untested.
    await bareRepo();
    await closeDb();

    const result = await runDoctor(root);
    const guidance = result.checks.find(check => check.message.includes('KNOWL.md'));

    expect(guidance?.status).toBe('OK');
    expect(result.ready).toBe(true);
  });

  it('re-finds a stored item by its own title words', async () => {
    const projectId = await bareRepo();
    await repo.createKnowledgeItem(projectId, {
      category: 'fact',
      title: 'Postgres connection pool exhausts during concurrent migrations',
      content: 'Migrations open their own connections.',
    });
    await closeDb();

    const result = await runDoctor(root);

    expect(probeCheck(result.checks).status).toBe('OK');
    expect(probeCheck(result.checks).message).toMatch(/came back at rank \d+ of \d+/);
    expect(result.ready).toBe(true);
  });

  it('FAILS, and gates the verdict, when the index has lost the item', async () => {
    // The failure the old check could not see: the item row is present and countable, so
    // `COUNT(active) > 0` reports a healthy store, while search cannot reach it. Only the
    // probed item's FTS row is deleted -- bootstrap backfills the index when it is entirely
    // empty, so a total wipe would heal itself on the next `initDb` and prove nothing. A
    // partial gap is also the real-world shape: `integrity.ts` looks for exactly it.
    const projectId = await bareRepo();
    await repo.createKnowledgeItem(projectId, {
      category: 'fact',
      title: 'An unrelated item keeping the index table populated',
      content: 'Present so the backfill does not run.',
    });
    const target = await repo.createKnowledgeItem(projectId, {
      category: 'fact',
      title: 'Postgres connection pool exhausts during concurrent migrations',
      content: 'Migrations open their own connections.',
    });
    await makeNewest(target.id);
    await getClient().execute({
      sql: 'DELETE FROM knowledge_items_fts WHERE item_id = ?',
      args: [target.id],
    });
    await closeDb();

    const result = await runDoctor(root);

    expect(probeCheck(result.checks).status).toBe('FAIL');
    expect(probeCheck(result.checks).fix).toContain('knowl audit');
    expect(result.ready).toBe(false);
  });

  it('records no knowledge_access rows: a diagnostic must not feed the ranking signal', async () => {
    // The old check called `queryKnowledgeForAgent`, which writes a `knowledge_access` row per
    // returned item tagged as a real agent query. Those rows are counted as tier confirmations
    // (`tier.ts`) and as GC liveness (`getAccessSummary`), and `knowl-sync` runs doctor in every
    // repository on the machine -- so merely diagnosing a store promoted whichever items
    // happened to sort first.
    const projectId = await bareRepo();
    await repo.createKnowledgeItem(projectId, {
      category: 'fact',
      title: 'Postgres connection pool exhausts during concurrent migrations',
      content: 'Migrations open their own connections.',
    });
    await closeDb();

    await runDoctor(root);

    await initDb(root);
    const rows = await getClient().execute('SELECT COUNT(*) AS total FROM knowledge_access');
    expect(Number((rows.rows[0] as any).total)).toBe(0);
  });
});
