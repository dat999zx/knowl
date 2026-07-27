import type { ProjectConfig } from '../core/types.js';

export type WarmResult =
  | { status: 'ready'; model: string }
  | { status: 'disabled' }
  | { status: 'skipped'; reason: string }
  | { status: 'failed'; model: string; reason: string };

/**
 * Download the local embedding model during `knowl init`.
 *
 * Write-time embedding deliberately never downloads (`write-embedding.ts`: an ordinary
 * write must not stall on a 20MB fetch), and nothing else fetched it until the first
 * query. So every item written before that first query was permanently invisible to
 * semantic search, with no error and nothing to notice -- verified on a fresh repo where
 * an item written before a query stayed unembedded while one written after did not.
 *
 * Init is the right place: it is the one explicit setup step where waiting is expected,
 * and it means writes are embedded from the first one onward.
 *
 * Never fatal. Init runs offline, in CI, and behind proxies, and a failed download leaves
 * a project that still works on BM25 -- `knowl doctor` then reports the gap and
 * `knowl reindex --vectors` closes it. Set KNOWL_SKIP_MODEL_DOWNLOAD=1 to opt out.
 */
export async function warmEmbeddingModel(
  root: string,
  config: ProjectConfig,
  options: { log?: (message: string) => void } = {},
): Promise<WarmResult> {
  const log = options.log ?? (() => {});

  if (process.env.KNOWL_SKIP_MODEL_DOWNLOAD === '1') {
    return { status: 'skipped', reason: 'KNOWL_SKIP_MODEL_DOWNLOAD=1' };
  }
  // Warming exists solely so write-time embedding has a model to use. With that switched
  // off there is nothing to warm for, and paying a model load anyway would slow every init
  // -- including every CI run -- for no benefit.
  if (process.env.KNOWL_DISABLE_WRITE_EMBEDDING === '1') {
    return { status: 'skipped', reason: 'KNOWL_DISABLE_WRITE_EMBEDDING=1' };
  }

  const { createLocalEmbeddingProvider, isVectorSearchEnabled, getVectorSearchConfig } =
    await import('../ai/embeddings.js');

  if (!isVectorSearchEnabled(config)) return { status: 'disabled' };

  const model = getVectorSearchConfig(config).model;

  try {
    const embedder = await createLocalEmbeddingProvider(config, root, {
      // Report what is actually happening: re-running init on a machine that already has
      // the weights should not claim to be downloading them again.
      onFirstLoad: ({ cached }) => log(cached
        ? `🧠 Local embedding model (${model}) already present.`
        : `⬇️  Downloading local embedding model (${model}) — this happens once...`),
    });
    // Embed a token string: the provider is lazy, so only an actual call proves the model
    // is on disk and usable rather than merely configured.
    await embedder.embed(['knowl']);
    return { status: 'ready', model };
  } catch (error: any) {
    return { status: 'failed', model, reason: error?.message ?? String(error) };
  }
}

export function formatWarmResult(result: WarmResult): string | null {
  switch (result.status) {
    case 'ready':
      return '🧠 Embedding model ready; new knowledge is indexed for semantic search as it is written.';
    case 'disabled':
      return null;
    case 'skipped':
      return `⏭️  Skipped embedding model download (${result.reason}). Run \`knowl reindex --vectors\` when you want semantic search.`;
    case 'failed':
      return `⚠️  Could not prepare the embedding model (${result.reason}). Knowl works on keyword search; run \`knowl reindex --vectors\` once you are online to enable semantic search.`;
  }
}
