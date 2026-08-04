import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDb, getClient, initDb } from '../../src/store/database.js';
import * as repo from '../../src/store/repository.js';
import { storeKnowledgeItemDeduped } from '../../src/store/knowledge-writer.js';
import { resetWriteEmbeddingCache } from '../../src/store/write-embedding.js';
import { fingerprintProfile, resolveVectorProfile } from '../../src/core/vector-profile.js';
import { DEFAULT_CONFIG } from '../../src/core/config.js';
import type { ProjectConfig } from '../../src/core/types.js';

/**
 * The real provider is stubbed so these tests exercise the CACHE, not onnxruntime: the
 * questions here are "which profile did this write get stamped with" and "does a write
 * ever look again", and a 305 MB model answers neither. Everything else -- config
 * loading, the profile resolution, the on-disk model check, the upsert -- is real.
 */
vi.mock('../../src/ai/embeddings.js', async importActual => {
  const actual = await importActual<typeof import('../../src/ai/embeddings.js')>();
  return {
    ...actual,
    createLocalEmbeddingProvider: async (config: ProjectConfig) => {
      const profile = resolveVectorProfile(config);
      return {
        provider: profile.provider,
        model: profile.model,
        pooling: profile.pooling,
        profileFingerprint: fingerprintProfile(profile),
        embed: async (texts: string[]) => texts.map(() => [0.6, 0.8]),
        embedQuery: async () => [0.6, 0.8],
      };
    },
  };
});

const MINILM = { provider: 'local', model: 'Xenova/all-MiniLM-L6-v2', dtype: 'q8', pooling: 'mean' as const };
const BGE = { provider: 'local', model: 'Xenova/bge-small-en-v1.5', dtype: 'q8', pooling: 'cls' as const };

let root = '';
let projectId = '';

/** Write config.json. Not a fresh root -- switching profiles mid-process is the point. */
async function writeConfig(vector: Record<string, unknown>): Promise<void> {
  await fs.writeFile(
    path.join(root, '.knowl', 'config.json'),
    JSON.stringify({ ...DEFAULT_CONFIG, search: { vector: { enabled: true, ...vector } } }),
    'utf-8',
  );
}

/** Create the directory the "is the model on disk" check looks for. No weights needed. */
async function placeModel(model: string): Promise<void> {
  await fs.mkdir(path.join(root, '.knowl', 'models', ...model.split('/')), { recursive: true });
}

async function storedFingerprints(): Promise<string[]> {
  const rows = await getClient().execute(
    'SELECT profile_fingerprint AS f FROM knowledge_embeddings ORDER BY updated_at, rowid',
  );
  return rows.rows.map(row => String((row as any).f));
}

let counter = 0;
async function write(title: string): Promise<void> {
  const result = await storeKnowledgeItemDeduped(projectId, {
    category: 'fact', title, content: `Body ${counter++} for ${title}.`,
  });
  expect(result.action).toBe('inserted');
}

const fingerprintOf = (vector: Record<string, unknown>) =>
  fingerprintProfile(resolveVectorProfile({ version: 1, search: { vector } } as unknown as ProjectConfig));

describe('write-time embedding follows the live profile', () => {
  beforeEach(async () => {
    delete process.env.KNOWL_DISABLE_WRITE_EMBEDDING;
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'knowl-writeprofile-'));
    await fs.mkdir(path.join(root, '.knowl'), { recursive: true });
    await writeConfig(MINILM);
    await initDb(root);
    projectId = (await repo.createProject(root, 'write-embedding-profile')).id;
    resetWriteEmbeddingCache();
  });

  afterEach(async () => {
    process.env.KNOWL_DISABLE_WRITE_EMBEDDING = '1';
    resetWriteEmbeddingCache();
    await closeDb();
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  });

  it('stamps a write with the profile that is configured NOW, not the one at first write', async () => {
    // K-61. The cache was keyed on the repository root alone, so the first write in a
    // process decided the profile for every later one. `knowl serve` is long-lived, so a
    // model or pooling change left every subsequent write stamped with the superseded
    // fingerprint -- invisible to a search running the new profile, and counted as embedded
    // by doctor.
    await placeModel(MINILM.model);
    await write('Before the switch');
    expect(await storedFingerprints()).toEqual([fingerprintOf(MINILM)]);

    // The operator changes model and pooling. No restart, no cache reset.
    await writeConfig(BGE);
    await placeModel(BGE.model);
    await write('After the switch');

    expect(await storedFingerprints()).toEqual([fingerprintOf(MINILM), fingerprintOf(BGE)]);
  });

  it('notices a dtype change, which changes the numbers but not the model', async () => {
    // The fingerprint exists because provider and model are not sufficient. A cache keyed
    // on anything coarser than the fingerprint misses this one entirely.
    await placeModel(MINILM.model);
    await write('At q8');

    await writeConfig({ ...MINILM, dtype: 'fp32' });
    await write('At fp32');

    const [first, second] = await storedFingerprints();
    expect(first).toBe(fingerprintOf(MINILM));
    expect(second).toBe(fingerprintOf({ ...MINILM, dtype: 'fp32' }));
    expect(second).not.toBe(first);
  });

  it('starts embedding once the model appears, without a restart', async () => {
    // K-62. A cached `null` was permanent: a `serve` that started before the weights were
    // on disk never embedded anything again, even after `reindex --vectors` fetched them.
    // `resetWriteEmbeddingCache` has no non-test caller, so restarting was the only
    // recovery and nothing in the product said so.
    await write('Written while the model was absent');
    expect(await storedFingerprints()).toEqual([]);

    await placeModel(MINILM.model);
    await write('Written after reindex fetched the model');

    expect(await storedFingerprints()).toEqual([fingerprintOf(MINILM)]);
  });

  it('still skips silently while the model is absent, however many writes arrive', async () => {
    // The other half of K-62: retrying must not mean downloading, and must not mean
    // failing. Writes succeed, nothing is embedded, nothing throws.
    for (let i = 0; i < 4; i++) await write(`No model yet ${i}`);
    expect(await storedFingerprints()).toEqual([]);
  });

  it('honours KNOWL_DISABLE_WRITE_EMBEDDING even with the model in place', async () => {
    // The suite-wide opt-out has to keep working: it is what stops every test in the
    // repository from loading a 305 MB model on every write.
    await placeModel(MINILM.model);
    process.env.KNOWL_DISABLE_WRITE_EMBEDDING = '1';

    await write('Embedding switched off');

    expect(await storedFingerprints()).toEqual([]);
  });
});
