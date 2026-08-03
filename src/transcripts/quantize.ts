/**
 * int8 vectors, at a quarter of float32's size and no measured loss.
 *
 * Measured at 384 dims over 350 atoms and 17 recall queries: float32 MRR 0.662 at 106 MB per
 * 69k messages; int8 0.668 at 27 MB; binary 0.310. Binary collapses at this dimensionality --
 * one sign bit per dimension cannot hold the ranking -- and recovering it needs a float32
 * rescoring pass, which means storing float32 as well. int8 needs no rescoring stage at all.
 */

/**
 * The magnitude that maps to +/-127.
 *
 * `6 / sqrt(dims)` rather than a constant: L2-normalised components have RMS `1/sqrt(dims)`, so
 * this clips at about 6 sigma and adapts to any model's dimensionality. For 384-dim Granite it
 * gives 0.306, against a measured largest component of 0.327 and a p99.9 of 0.262.
 */
export function quantizeScale(dims: number): number {
  return 6 / Math.sqrt(dims);
}

export function quantizeVector(vector: number[]): { scale: number; bytes: Uint8Array } {
  const scale = quantizeScale(vector.length);
  const signed = new Int8Array(vector.length);
  for (let i = 0; i < vector.length; i++) {
    const scaled = Math.round((vector[i] / scale) * 127);
    // Clamp rather than let the Int8Array assignment wrap: an outlier component would
    // otherwise flip sign, which is far worse than clipping it.
    signed[i] = Math.max(-127, Math.min(127, scaled));
  }
  return { scale, bytes: new Uint8Array(signed.buffer, signed.byteOffset, signed.byteLength) };
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
