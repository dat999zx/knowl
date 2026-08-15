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
  /**
   * Active items that DO carry an embedding, produced under a different profile fingerprint.
   *
   * A subset of the gap, never additional to it: these are counted as unembedded because
   * retrieval filters on the fingerprint, so they are as invisible as a row that was never
   * written. What they are not is *absent*, and the difference decides both what to tell the
   * reader and whether "nothing embeds these retroactively" is true of them.
   */
  staleItems?: number;
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
  const status = missing * 2 > input.activeItems ? 'FAIL' : 'WARN';

  /*
   * A gap an UPGRADE opened reads nothing like a gap a missing model left, and until now both
   * got the never-embedded sentence.
   *
   * `fingerprintProfile` hashes the embedding recipe and the batching policy alongside provider,
   * model, dtype and pooling -- deliberately, so that a recipe change invalidates its own rows
   * instead of leaving them "matching a space they are no longer in". Retrieval filters on that
   * same fingerprint. Both halves are right, and together they mean a release can take a fully
   * embedded store to zero reachable vectors at once, without the user doing anything.
   *
   * Measured on a real machine, 2026-08-15, upgrading across 5.0.0: 1,100 of 1,639 vectors --
   * three repositories' entire indexes -- went invisible on the version bump. Every one of them
   * was reported as an item that "are embedded" only 23 of 747 times over, and the remedy line
   * said `Nothing embeds these retroactively`, which is the single thing that is NOT true of a
   * stale row: a reindex is exactly what repairs it.
   *
   * So say which it is. The counts are separated rather than summed because two different things
   * can be wrong at once, and only one of them is something the user just did.
   */
  if ((input.staleItems ?? 0) > 0) {
    const stale = Math.min(input.staleItems ?? 0, missing);
    const never = missing - stale;
    const neverClause = never > 0
      ? ` A further ${never} were never embedded at all.`
      : '';
    return {
      status,
      message: `Vector search is enabled with ${input.model} and ${stale} of ${input.activeItems} active item(s) are embedded under an earlier embedding recipe, which retrieval cannot read -- so they are invisible to semantic search even though their vectors exist. This is what an upgrade that changes the embedding recipe does, and re-embedding them restores every one.${neverClause}`,
      fix: 'run `knowl reindex --vectors`',
      remedy: { kind: 'reindex-vectors' },
    };
  }

  if (status === 'FAIL') {
    return {
      status,
      message: `Vector search is enabled with ${input.model} but only ${input.embeddedItems} of ${input.activeItems} active item(s) are embedded, so semantic search reaches a minority of this project's knowledge and its results are not representative of what is stored. Nothing embeds these retroactively.`,
      fix: 'run `knowl reindex --vectors`',
      remedy: { kind: 'reindex-vectors' },
    };
  }

  return {
    status,
    message: `Vector search is enabled with ${input.model} but ${missing} of ${input.activeItems} active item(s) have no embedding, so they are invisible to semantic search. Items written before the embedding model was first downloaded are not embedded retroactively.`,
    fix: 'run `knowl reindex --vectors`',
    remedy: { kind: 'reindex-vectors' },
  };
}
