import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { generateCodingMemoryBundle } from '../../benchmarks/accuracy/src/generator.js';
import {
  BENCHMARK_DATASET_FILES,
  readBenchmarkBundle,
  serializeBenchmarkBundle,
  writeBenchmarkBundle,
} from '../../benchmarks/accuracy/src/dataset.js';

const OUTPUT = path.resolve('.tmp/accuracy-artifact-test');

afterEach(async () => {
  await fs.rm(OUTPUT, { recursive: true, force: true });
});

describe('benchmark artifacts', () => {
  it('round-trips generated data and reproduces byte-identical artifacts', async () => {
    const generated = generateCodingMemoryBundle('artifact-replay');
    await writeBenchmarkBundle(generated, OUTPUT);
    const loaded = await readBenchmarkBundle(OUTPUT);

    expect(loaded.normalizedRecords).toEqual(generated.normalizedRecords);
    expect(loaded.nativeHistories).toEqual(generated.nativeHistories);
    expect(loaded.queries).toEqual(generated.queries);
    expect(loaded.questionGold).toEqual(generated.questionGold);
    expect(loaded.captureGold).toEqual(generated.captureGold);
    expect(serializeBenchmarkBundle(loaded)).toEqual(serializeBenchmarkBundle(generated));
  });

  it('rejects a public dataset file whose bytes no longer match the manifest', async () => {
    await writeBenchmarkBundle(generateCodingMemoryBundle('tamper-check'), OUTPUT);
    const recordsPath = path.join(OUTPUT, BENCHMARK_DATASET_FILES.records);
    await fs.appendFile(recordsPath, '{}\n', 'utf-8');

    await expect(readBenchmarkBundle(OUTPUT)).rejects.toThrow('Digest mismatch');
  });
});
