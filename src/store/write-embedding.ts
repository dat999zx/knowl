import { KnowledgeItem } from '../core/types.js';
import { getConfigRoot } from './database.js';
import { buildKnowledgeEmbeddingText, KnowledgeEmbedder } from './vector-index.js';
import { upsertKnowledgeEmbeddings } from './vector.js';

// Write-time vector indexing keeps semantic retrieval fresh without anyone having
// to remember `knowl reindex --vectors`. Two rules keep it safe:
//   1. Best-effort — a disabled provider, missing model, or any failure must never
//      fail (or slow down) the knowledge write itself.
//   2. Never download. If the embedding model is not already cached locally we skip
//      silently, so a first write (or a Stop hook) can't stall on a multi-MB fetch.
//      `knowl reindex --vectors` remains the explicit opt-in that fetches the model
//      and backfills existing atoms; writes stay fresh from then on.
//
// The cache is keyed on everything that can change the answer, not on the repository
// alone. It used to be keyed on the root, which made two things permanent for the life of
// the process:
//
//   * A model, dtype or pooling change was ignored, so every subsequent write was stamped
//     with the SUPERSEDED profile fingerprint and became invisible to a search running the
//     new one. `knowl serve` is long-lived, so "the life of the process" is measured in
//     days, and the coverage check could not see it either (see doctor-report.ts).
//   * A `null` embedder was equally permanent. A `serve` that started before the model was
//     on disk never embedded anything again, even after `reindex --vectors` fetched it --
//     restarting was the only recovery, and nothing said so.
//
// The key therefore carries the profile fingerprint (so a config change rebuilds) and
// whether the model is on disk (so it retries exactly when that changes, and only then --
// a build that failed with the weights present is a real failure and is not retried on
// every write).
let cache: { key: string; embedder: KnowledgeEmbedder | null } | null = null;

/** Drop the cache. Tests need it; the keying above means the product does not. */
export function resetWriteEmbeddingCache(): void {
  cache = null;
}

function isDisabled(): boolean {
  return process.env.KNOWL_DISABLE_WRITE_EMBEDDING === '1';
}

async function resolveEmbedder(): Promise<KnowledgeEmbedder | null> {
  // Checked before anything is loaded or read, so the opt-out stays free.
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

  // Imported lazily so the store layer keeps no static dependency on the AI layer.
  let build: (() => Promise<KnowledgeEmbedder>) | null = null;
  let key: string;
  try {
    const [{ loadConfig }, embeddings, { fingerprintProfile, resolveVectorProfile }] = await Promise.all([
      import('../core/config.js'),
      import('../ai/embeddings.js'),
      import('../core/vector-profile.js'),
    ]);
    const config = await loadConfig(root);
    if (!embeddings.isVectorSearchEnabled(config)) {
      key = `${root}|vector-search-disabled`;
    } else {
      // Only proceed when the model is already on disk — never trigger a download. Re-read
      // every time rather than remembered: "the weights arrived" is precisely the event a
      // cached `null` must not survive, and an `access` on a path is far cheaper than the
      // write it precedes. `resolveModelCache` also answers WHERE, since the weights may be
      // in the shared machine cache or in this repo's legacy one (K-42).
      const { dir, present } = await embeddings.resolveModelCache(config, root);
      key = `${root}|${fingerprintProfile(resolveVectorProfile(config))}|${dir}|${present ? 'present' : 'absent'}`;
      if (present) build = () => embeddings.createLocalEmbeddingProvider(config, root);
    }
  } catch {
    // Config unreadable or the AI layer failed to load. Not cached: this is a transient
    // state (a half-written config, a partial checkout) and caching it would make one bad
    // moment permanent, which is the shape of the bug this keying exists to end.
    return null;
  }

  if (cache?.key === key) return cache.embedder;

  let embedder: KnowledgeEmbedder | null = null;
  try {
    embedder = build ? await build() : null;
  } catch {
    embedder = null;
  }

  cache = { key, embedder };
  return embedder;
}

/** Index freshly written items so vector search stays current. Never throws. */
export async function indexKnowledgeItemsBestEffort(projectId: string, items: KnowledgeItem[]): Promise<void> {
  if (items.length === 0) return;
  try {
    const embedder = await resolveEmbedder();
    if (!embedder) return;
    // One text per forward pass. A single write already got that for free; a batch write of
    // several atoms did not, and its vectors then disagreed with the ones a reindex produced
    // for the same text. See `EmbedOptions`.
    const vectors = await embedder.embed(items.map(buildKnowledgeEmbeddingText), { maxBatch: 1 });
    // One transaction for the batch. Each row written on its own is an implicit commit, and
    // this schema fsyncs the WAL on every one -- 11.57 ms per row against 0.088 ms inside a
    // transaction. A single-item write, which is the common case here, still takes the plain
    // path (see `upsertKnowledgeEmbeddings`).
    await upsertKnowledgeEmbeddings(items.flatMap((item, index) => {
      const vector = vectors[index];
      if (!vector || vector.length === 0) return [];
      return [{
        projectId,
        knowledgeItemId: item.id,
        provider: embedder.provider,
        model: embedder.model,
        profileFingerprint: embedder.profileFingerprint,
        dimensions: vector.length,
        vector,
      }];
    }));
  } catch {
    // A write must succeed even if indexing does not.
  }
}
