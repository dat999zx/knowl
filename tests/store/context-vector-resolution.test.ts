import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDb, initDb } from '../../src/store/database.js';
import { releaseAll } from '../../src/store/connection-pool.js';
import * as repo from '../../src/store/repository.js';
import { DEFAULT_CONFIG } from '../../src/core/config.js';

/**
 * `composeContext` resolving its own embedder, tested rather than assumed untestable.
 *
 * The lane that wrote it recorded "not unit-tested -- it needs a real model on disk". It does
 * not: the property that matters is *whether a provider is built at all*, and that decision is
 * made by an `access` on a path before any weight is read. A directory standing in for the
 * weights is enough to drive both sides of it, and a spy on the provider factory is enough to
 * see which side was taken. The suite sets KNOWL_DISABLE_WRITE_EMBEDDING=1 and blanks the API
 * keys; nothing here turns either back on.
 *
 * Two things are under test. **Never downloads** -- a `knowl_context` call that silently
 * fetched a multi-megabyte model would be a real defect and nothing proved it did not. And
 * **where it looks** -- K-42 moved the machine's model cache to `~/.knowl/models`, and
 * `resolveModelCache` prefers it; a hand-rolled copy of the never-download check that only
 * looks in `<root>/.knowl/models` reports "absent" for weights that are on disk, which puts
 * `knowl_context` back on the lexical-only path K-31 was about.
 */
const MODEL_ID = 'Xenova/all-MiniLM-L6-v2';
const HOME = path.resolve('./.knowl-context-vector-home');
const ROOT = path.resolve('./.knowl-context-vector-root');

const FAKE_EMBEDDER = {
  provider: 'local',
  model: MODEL_ID,
  pooling: 'mean' as const,
  profileFingerprint: 'context-vector-fp',
  embed: async (texts: string[]) => texts.map(() => [1, 0, 0]),
  embedQuery: async () => [1, 0, 0],
};

const buildProvider = vi.fn(async () => FAKE_EMBEDDER);

vi.mock('../../src/ai/embeddings.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/ai/embeddings.js')>();
  // resolveModelCache stays REAL. It is the decision under test; only the thing that would
  // reach the network is replaced, so "was it called" is exactly "would it have downloaded".
  return { ...actual, createLocalEmbeddingProvider: (...args: unknown[]) => buildProvider(...(args as [])) };
});

const { composeContext } = await import('../../src/store/context-composer.js');

const CONFIG = {
  ...DEFAULT_CONFIG,
  search: { vector: { enabled: true, provider: 'local', model: MODEL_ID, dtype: 'q8', pooling: 'mean' } },
};

/** A directory where the weights would be. `resolveModelCache` only asks whether it exists. */
async function placeWeights(cacheDir: string): Promise<void> {
  await fs.mkdir(path.join(cacheDir, ...MODEL_ID.split('/')), { recursive: true });
}

let projectId = '';
let previousHome: string | undefined;

async function freshProject(): Promise<void> {
  await closeDb();
  await releaseAll();
  await fs.rm(ROOT, { recursive: true, force: true }).catch(() => {});
  await fs.rm(HOME, { recursive: true, force: true }).catch(() => {});
  await fs.mkdir(path.join(ROOT, '.knowl'), { recursive: true });
  await fs.writeFile(path.join(ROOT, '.knowl', 'config.json'), JSON.stringify(CONFIG), 'utf-8');
  await initDb(ROOT);
  projectId = (await repo.createProject(ROOT, 'context-vector')).id;
  await repo.createKnowledgeItem(projectId, {
    category: 'fact', title: 'Retention window', content: 'Session transcripts are retained for thirty days.',
  });
  buildProvider.mockClear();
}

describe('composeContext resolves its embedder without ever fetching one', () => {
  beforeAll(() => { previousHome = process.env.KNOWL_HOME; process.env.KNOWL_HOME = HOME; });
  afterAll(async () => {
    if (previousHome === undefined) delete process.env.KNOWL_HOME; else process.env.KNOWL_HOME = previousHome;
    await closeDb();
    await releaseAll();
    for (const dir of [ROOT, HOME]) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  });
  beforeEach(freshProject);
  afterEach(async () => { await closeDb(); await releaseAll(); });

  it('builds no provider at all when the weights are nowhere on disk', async () => {
    const pack = await composeContext(projectId, { query: 'retention window', tokenBudget: 400, namespaceRoot: ROOT });

    // The whole never-download contract: the only code that can fetch is never reached.
    expect(buildProvider).not.toHaveBeenCalled();
    // And the call still answers, lexically, rather than failing on the missing model.
    expect(pack.sections.some(section => section.items.length > 0)).toBe(true);
  });

  it('uses weights already in this repo, the legacy per-repo cache', async () => {
    await placeWeights(path.join(ROOT, '.knowl', 'models'));
    await composeContext(projectId, { query: 'retention window', tokenBudget: 400, namespaceRoot: ROOT });
    expect(buildProvider).toHaveBeenCalledTimes(1);
  });

  // K-42 moved the machine's model cache here and `resolveModelCache` prefers it, so this is
  // where the weights are on any machine that has fetched one since. A never-download check
  // that only looks in `<root>/.knowl/models` calls them absent and silently drops
  // `knowl_context` back onto the lexical path -- the exact condition K-31 was about, on the
  // configuration that is now the default.
  it('uses weights in the shared machine cache, which is where K-42 puts them', async () => {
    await placeWeights(path.join(HOME, 'models'));
    await composeContext(projectId, { query: 'retention window', tokenBudget: 400, namespaceRoot: ROOT });
    expect(buildProvider).toHaveBeenCalledTimes(1);
  });

  it('builds nothing when vector search is switched off, weights or no weights', async () => {
    await placeWeights(path.join(HOME, 'models'));
    await fs.writeFile(
      path.join(ROOT, '.knowl', 'config.json'),
      JSON.stringify({ ...DEFAULT_CONFIG, search: { vector: { enabled: false } } }),
      'utf-8',
    );
    await composeContext(projectId, { query: 'retention window', tokenBudget: 400, namespaceRoot: ROOT });
    expect(buildProvider).not.toHaveBeenCalled();
  });
});
