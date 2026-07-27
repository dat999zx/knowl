export type VectorCoverageCheck = { status: 'OK' | 'WARN'; message: string; fix?: string };

/**
 * Whether vector search actually covers this project's knowledge.
 *
 * The old check reported configuration -- "vector search enabled with local/model" -- which
 * is true and useless. Write-time embedding deliberately refuses to download the model
 * (`write-embedding.ts`: "never trigger a download"), and nothing else fetches it until the
 * first query. So every item written before that first query is permanently unembedded and
 * invisible to vector search, while doctor reported the project healthy.
 *
 * Reporting coverage instead turns a silent permanent gap into a visible, fixable one.
 */
export function vectorCoverageCheck(input: {
  enabled: boolean;
  model: string;
  activeItems: number;
  embeddedItems: number;
  /** KNOWL_DISABLE_WRITE_EMBEDDING=1 — the gap is then chosen, not accidental. */
  writeEmbeddingDisabled?: boolean;
}): VectorCoverageCheck {
  if (!input.enabled) {
    return { status: 'OK', message: 'Vector search disabled; BM25 retrieval remains active' };
  }

  // Warn about an unintended gap, never a chosen one. Someone who switched write-time
  // embedding off already knows their index is stale, and nagging them turns a signal that
  // should mean "something is wrong" into background noise.
  if (input.writeEmbeddingDisabled) {
    return {
      status: 'OK',
      message: `Vector search enabled with ${input.model}; write-time embedding is switched off, so coverage is not checked`,
    };
  }

  const missing = Math.max(0, input.activeItems - input.embeddedItems);
  if (missing === 0) {
    return {
      status: 'OK',
      message: `Vector search enabled with ${input.model}; all ${input.activeItems} active item(s) embedded`,
    };
  }

  return {
    status: 'WARN',
    message: `Vector search is enabled with ${input.model} but ${missing} of ${input.activeItems} active item(s) have no embedding, so they are invisible to semantic search. Items written before the embedding model was first downloaded are not embedded retroactively.`,
    fix: 'run `knowl reindex --vectors`',
  };
}
