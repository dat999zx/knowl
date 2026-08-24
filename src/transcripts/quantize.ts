/**
 * int8 vectors, at a quarter of float32's size and no measured loss.
 *
 * Measured at 384 dims over 350 atoms and 17 recall queries: float32 MRR 0.662 at 106 MB per
 * 69k messages; int8 0.668 at 27 MB; binary 0.310. Binary collapses at this dimensionality --
 * one sign bit per dimension cannot hold the ranking -- and recovering it needs a float32
 * rescoring pass, which means storing float32 as well. int8 needs no rescoring stage at all.
 */

/**
 * The magnitude that maps to +/-127, under the fixed-scale scheme.
 *
 * `6 / sqrt(dims)` rather than a constant: L2-normalised components have RMS `1/sqrt(dims)`, so
 * this clips at about 6 sigma and adapts to any model's dimensionality. For 384-dim Granite it
 * gives 0.306, against a measured largest component of 0.327 and a p99.9 of 0.262.
 *
 * RETAINED FOR READING OLD ROWS, NOT FOR WRITING NEW ONES. The 0.327 above was not measured on
 * `granite-small-en-r2`, which is the shipped default: its vectors carry a rogue component near
 * **0.70**, more than twice this threshold. See `quantizeVector`.
 */
export function quantizeScale(dims: number): number {
  return 6 / Math.sqrt(dims);
}

/**
 * Per-vector scale, because one clipped component is not a rounding error.
 *
 * Measured on 12 real messages through `granite-small-en-r2`, the shipped default preset:
 *
 * | scheme | mean \|\|v\|\| | mean cos | worst cos |
 * |---|---|---|---|
 * | fixed `6/sqrt(dims)` | 0.7525 | 0.9236 | 0.9128 |
 * | per-vector max | **1.0003** | **0.99947** | 0.99940 |
 *
 * Exactly ONE component of 384 exceeded the fixed threshold -- and clipping that one cost 25% of
 * the norm and rotated the vector by ~22 degrees. Transformer embeddings routinely carry such a
 * "rogue dimension"; the 6-sigma argument assumes a spread this model does not have, and no
 * amount of dimensionality-adaptation reaches an outlier that is 14 sigma out.
 *
 * Consequences of the old scheme, all of them silent: `dotQuantized` documents itself as cosine
 * on the grounds that both sides are unit-length, and the stored side was not -- so every score
 * was `cos(q,d) * ||d||` with `||d||` ranging 0.69-0.81, a content-independent +/-8% reweighting
 * of the ranking. It also depressed the whole cosine scale, which is why transcript scores
 * topped out near 0.59 while `MODEL_RELEVANCE_FLOORS` puts this model's floor at 0.76.
 *
 * Scaling to the max spends int8 range on the rogue component and leaves the bulk coarser; the
 * table above is that trade, measured rather than argued. A p99.9 scale was tried alongside and
 * is identical to six decimals, so the simpler rule wins.
 *
 * NO SCHEMA CHANGE AND NO READER CHANGE: `scale` is already a per-row column and
 * `dequantizeVector` already multiplies by whatever that row carries, so existing rows keep
 * decoding exactly as before. They stay clipped, though -- hence the `EMBED_RECIPE_VERSION` bump
 * that makes an ordinary reindex replace them.
 */
export function quantizeVector(vector: number[]): { scale: number; bytes: Uint8Array } {
  let max = 0;
  for (let i = 0; i < vector.length; i++) {
    const magnitude = Math.abs(vector[i]);
    if (magnitude > max) max = magnitude;
  }
  // A zero vector has no scale to speak of. Fall back rather than divide by zero and store NaN.
  const scale = max > 0 ? max : quantizeScale(vector.length);

  const signed = new Int8Array(vector.length);
  for (let i = 0; i < vector.length; i++) {
    const scaled = Math.round((vector[i] / scale) * 127);
    // Still clamped. Nothing can exceed the max by construction, but rounding at exactly +/-127
    // and any future scale rule both land here, and a wrapped Int8Array assignment flips sign.
    signed[i] = Math.max(-127, Math.min(127, scaled));
  }
  return { scale, bytes: new Uint8Array(signed.buffer, signed.byteOffset, signed.byteLength) };
}

/**
 * The version of the quantization decision, stamped into the transcript vector fingerprint.
 *
 * Deliberately NOT `EMBED_RECIPE_VERSION`. That constant is about the text an ATOM becomes, and
 * its doc calls it a cross-repo contract that `knowl-cloud` holds a byte-identical copy of --
 * bumping it here would force a sync and a full knowledge reindex for a change that touches
 * neither. Quantization is transcript-local, so its version is too.
 *
 * Version 2 is the per-vector scale. Version 1 rows are not comparable to it: they decode to
 * norm ~0.75 and would rank systematically below faithfully-stored rows whatever they say, so
 * the two must not share a corpus.
 *
 * Bumping this is the whole repair. `embedPendingMessages` already deletes rows whose
 * fingerprint does not match and treats "no vector for this fingerprint" as its resume point, so
 * an ordinary `knowl reindex --transcripts` purges version 1 and rebuilds it. No migration.
 */
export const QUANTIZE_VERSION = 2;

/**
 * What a transcript vector is stored under: the embedder's profile plus the quantization
 * version, because the profile alone cannot see a change in how the numbers are encoded.
 */
export function transcriptVectorFingerprint(profileFingerprint: string): string {
  return `${profileFingerprint}:q${QUANTIZE_VERSION}`;
}

export function dequantizeVector(bytes: Uint8Array, scale: number): number[] {
  const signed = new Int8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const vector = new Array<number>(signed.length);
  for (let i = 0; i < signed.length; i++) vector[i] = (signed[i] * scale) / 127;
  return vector;
}

/**
 * Dot product of a float query against a stored int8 vector.
 *
 * Both sides are unit-length, so this is cosine similarity. Dequantizing inline avoids
 * allocating an array per candidate during a full scan.
 */
export function dotQuantized(query: number[], bytes: Uint8Array, scale: number): number {
  const signed = new Int8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (signed.length !== query.length) return 0;

  let total = 0;
  for (let i = 0; i < signed.length; i++) total += query[i] * signed[i];
  return (total * scale) / 127;
}
