import fs from 'node:fs/promises';
import path from 'node:path';
import { KnowledgeItem } from '../core/types.js';
import { getConfigRoot } from './database.js';
import { buildKnowledgeEmbeddingText, KnowledgeEmbedder } from './vector-index.js';
import { upsertKnowledgeEmbedding } from './vector.js';

// Write-time vector indexing keeps semantic retrieval fresh without anyone having
// to remember `knowl reindex --vectors`. Two rules keep it safe:
//   1. Best-effort — a disabled provider, missing model, or any failure must never
//      fail (or slow down) the knowledge write itself.
//   2. Never download. If the embedding model is not already cached locally we skip
//      silently, so a first write (or a Stop hook) can't stall on a multi-MB fetch.
//      `knowl reindex --vectors` remains the explicit opt-in that fetches the model
//      and backfills existing atoms; writes stay fresh from then on.
let cache: { root: string; embedder: KnowledgeEmbedder | null } | null = null;

export function resetWriteEmbeddingCache(): void {
  cache = null;
}

function isDisabled(): boolean {
  return process.env.KNOWL_DISABLE_WRITE_EMBEDDING === '1';
}

async function resolveEmbedder(): Promise<KnowledgeEmbedder | null> {
  if (isDisabled()) return null;

  let root: string;
  try {
    // Config root, not the database's location: a namespace or shared store lives outside
    // the `<root>/.knowl/` layout, and reading config from a path derived from the database
    // file made loadConfig throw -- which the catch below turned into "no embeddings", with
    // no error and no way to notice.
    root = getConfigRoot();
  } catch {
    return null; // no active project store
  }
  if (cache?.root === root) return cache.embedder;

  let embedder: KnowledgeEmbedder | null = null;
  try {
    // Imported lazily so the store layer keeps no static dependency on the AI layer.
    const [{ loadConfig }, { createLocalEmbeddingProvider, isVectorSearchEnabled, getVectorSearchConfig }] = await Promise.all([
      import('../core/config.js'),
      import('../ai/embeddings.js'),
    ]);
    const config = await loadConfig(root);
    if (isVectorSearchEnabled(config)) {
      const vector = getVectorSearchConfig(config);
      const cacheDir = vector.cacheDir || path.join(root, '.knowl', 'models');
      // Only proceed when the model is already on disk — never trigger a download.
      await fs.access(path.join(cacheDir, ...vector.model.split('/')));
      embedder = await createLocalEmbeddingProvider(config, root);
    }
  } catch {
    embedder = null;
  }

  cache = { root, embedder };
  return embedder;
}

/** Index freshly written items so vector search stays current. Never throws. */
export async function indexKnowledgeItemsBestEffort(projectId: string, items: KnowledgeItem[]): Promise<void> {
  if (items.length === 0) return;
  try {
    const embedder = await resolveEmbedder();
    if (!embedder) return;
    const vectors = await embedder.embed(items.map(buildKnowledgeEmbeddingText));
    for (let index = 0; index < items.length; index++) {
      const vector = vectors[index];
      if (!vector || vector.length === 0) continue;
      await upsertKnowledgeEmbedding({
        projectId,
        knowledgeItemId: items[index].id,
        provider: embedder.provider,
        model: embedder.model,
        profileFingerprint: embedder.profileFingerprint,
        dimensions: vector.length,
        vector,
      });
    }
  } catch {
    // A write must succeed even if indexing does not.
  }
}
