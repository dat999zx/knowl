/**
 * base64 of a little-endian Float32Array -- the encoding `knowl-cloud` reads and writes.
 *
 * Not a JSON array of numbers: 384 dimensions is ~1.5 KB binary and ~4.6 KB as JSON text, so a
 * thousand-atom publish is a 2 MB request instead of a 5 MB one for identical data.
 *
 * Duplicated rather than shared, like the embedding recipe: this repo cannot depend on the
 * proprietary contract package. The fixed expected value in the test is what keeps the two
 * honest -- a round-trip through our own decoder would pass for any self-consistent encoding,
 * including one the server cannot read.
 */
export class VectorDecodeError extends Error {
  readonly name = 'VectorDecodeError';
  constructor(readonly reason: 'not-base64' | 'not-float32' | 'wrong-dimensions', message: string) {
    super(message);
  }
}

export function encodeVector(values: Float32Array | number[]): string {
  const floats = values instanceof Float32Array ? values : Float32Array.from(values);
  return Buffer.from(floats.buffer, floats.byteOffset, floats.byteLength).toString('base64');
}

/**
 * `expectedDimensions` is required, not optional.
 *
 * The replica's `knowledge_embeddings` has no width constraint either, so a vector of the wrong
 * length would store happily and every later local cosine against it would be meaningless -- with
 * no error, ever. This is the only place that can catch it, so a caller may not skip it by
 * accident.
 */
export function decodeVector(base64: string, expectedDimensions: number): Float32Array {
  let buffer: Buffer;
  try {
    buffer = Buffer.from(base64, 'base64');
    // Node's base64 decoder is lenient and silently drops invalid characters, so re-encoding and
    // comparing is the only way to tell a real payload from a mangled one.
    if (buffer.toString('base64').replace(/=+$/, '') !== base64.replace(/=+$/, '')) {
      throw new Error('not base64');
    }
  } catch {
    throw new VectorDecodeError('not-base64', 'Vector is not valid base64.');
  }

  if (buffer.byteLength % 4 !== 0) {
    throw new VectorDecodeError(
      'not-float32',
      `Vector is ${buffer.byteLength} bytes, which is not a whole number of float32 values.`,
    );
  }

  const dimensions = buffer.byteLength / 4;
  if (dimensions !== expectedDimensions) {
    throw new VectorDecodeError(
      'wrong-dimensions',
      `Vector has ${dimensions} dimensions; this repository embeds at ${expectedDimensions}.`,
    );
  }

  // Copied rather than viewed. `Buffer.from` may return a view into a pooled ArrayBuffer at a
  // non-zero byteOffset, and a Float32Array over that reads a neighbour's bytes.
  const copy = new ArrayBuffer(buffer.byteLength);
  Buffer.from(copy).set(buffer);
  return new Float32Array(copy);
}
