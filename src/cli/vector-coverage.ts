import type { DoctorRemedy } from './doctor-remedy.js';

export type VectorCoverageCheck = { status: 'OK' | 'WARN' | 'FAIL'; message: string; fix?: string; remedy?: DoctorRemedy };

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

  /*
   * Most of the store missing is a different condition from a tail of it missing, and only the
   * second one is a warning.
   *
   * The house rule elsewhere in doctor is that one index missing while the other covers the item
   * is degradation, and only an item in NEITHER index is a failure -- `lexicalCoverageCheck`
   * argues exactly that, and this deliberately does not contradict it for a small gap. An item
   * without an embedding is still reachable by keyword.
   *
   * What that reasoning does not cover is a store where embedding has never worked. Measured on
   * knowl-cloud production, 2026-08-13: 345 atoms, zero vectors, for twelve hours. Every embed
   * had failed on an `EACCES` nobody saw, and the check for it reported an advisory warning under
   * a READY verdict -- the one line most people read. Nothing about that report said the product's
   * primary retrieval path was dead.
   *
   * The line is the majority, not zero. A strict `embedded === 0` is defeated by a single stray
   * row: one item written after some query happened to download the model would score 1 of 345 as
   * merely advisory. And the majority is where the harm changes character. Below it, semantic
   * search reaches most of the store and the rest is a tail to backfill. Above it, most queries
   * are answered from a minority of the knowledge while still returning plausible-looking
   * results -- so a partial index misleads in a way an absent one cannot, because there is no
   * symptom to notice.
   */
  if (missing * 2 > input.activeItems) {
    return {
      status: 'FAIL',
      message: `Vector search is enabled with ${input.model} but only ${input.embeddedItems} of ${input.activeItems} active item(s) are embedded, so semantic search reaches a minority of this project's knowledge and its results are not representative of what is stored. Nothing embeds these retroactively.`,
      fix: 'run `knowl reindex --vectors`',
      remedy: { kind: 'reindex-vectors' },
    };
  }

  return {
    status: 'WARN',
    message: `Vector search is enabled with ${input.model} but ${missing} of ${input.activeItems} active item(s) have no embedding, so they are invisible to semantic search. Items written before the embedding model was first downloaded are not embedded retroactively.`,
    fix: 'run `knowl reindex --vectors`',
    remedy: { kind: 'reindex-vectors' },
  };
}
