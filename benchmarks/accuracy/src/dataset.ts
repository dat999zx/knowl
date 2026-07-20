import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  BenchmarkManifestSchema,
  CaptureGoldSchema,
  NativeHistorySchema,
  NormalizedRecordSchema,
  PublicQuerySchema,
  QuestionGoldSchema,
  type BenchmarkBundle,
} from './schema.js';
import { validateBenchmarkBundle } from './validate.js';

const FILES = {
  records: 'public/normalized-records.ndjson',
  histories: 'public/native-histories.ndjson',
  queries: 'public/queries.ndjson',
  questionGold: 'gold/question-labels.ndjson',
  captureGold: 'gold/capture-labels.ndjson',
} as const;

function ndjson(rows: unknown[]): string {
  return rows.map(row => JSON.stringify(row)).join('\n') + '\n';
}

function digest(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function parseNdjson<T>(content: string, parse: (value: unknown) => T, filename: string): T[] {
  return content.split(/\r?\n/u).filter(Boolean).map((line, index) => {
    try {
      return parse(JSON.parse(line));
    } catch (error) {
      throw new Error(`${filename}:${index + 1}: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
}

export function serializeBenchmarkBundle(bundle: BenchmarkBundle): Record<string, string> {
  validateBenchmarkBundle(bundle);
  const contents: Record<string, string> = {
    [FILES.records]: ndjson(bundle.normalizedRecords),
    [FILES.histories]: ndjson(bundle.nativeHistories),
    [FILES.queries]: ndjson(bundle.queries),
    [FILES.questionGold]: ndjson(bundle.questionGold),
    [FILES.captureGold]: ndjson(bundle.captureGold),
  };
  const digests = Object.fromEntries(Object.entries(contents).map(([filename, content]) => [filename, digest(content)]));
  const manifest = { ...bundle.manifest, digests };
  return { 'manifest.json': `${JSON.stringify(manifest, null, 2)}\n`, ...contents };
}

export async function writeBenchmarkBundle(bundle: BenchmarkBundle, outputDirectory: string): Promise<void> {
  const files = serializeBenchmarkBundle(bundle);
  for (const [filename, content] of Object.entries(files)) {
    const outputPath = path.join(outputDirectory, filename);
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, content, 'utf-8');
  }
}

export async function readBenchmarkBundle(directory: string): Promise<BenchmarkBundle> {
  const manifestPath = path.join(directory, 'manifest.json');
  const manifest = BenchmarkManifestSchema.parse(JSON.parse(await fs.readFile(manifestPath, 'utf-8')));
  const requiredFiles = Object.values(FILES);
  const digestFiles = Object.keys(manifest.digests).sort();
  if (JSON.stringify(digestFiles) !== JSON.stringify([...requiredFiles].sort())) {
    throw new Error(`Manifest digests must cover exactly: ${requiredFiles.join(', ')}.`);
  }
  const contents = Object.fromEntries(await Promise.all(Object.values(FILES).map(async filename => [
    filename,
    await fs.readFile(path.join(directory, filename), 'utf-8'),
  ])));
  for (const [filename, expected] of Object.entries(manifest.digests)) {
    const content = contents[filename];
    if (content === undefined) throw new Error(`Manifest references unknown dataset file ${filename}.`);
    const actual = digest(content);
    if (actual !== expected) throw new Error(`Digest mismatch for ${filename}: expected ${expected}, got ${actual}.`);
  }
  const bundle: BenchmarkBundle = {
    manifest,
    normalizedRecords: parseNdjson(contents[FILES.records], value => NormalizedRecordSchema.parse(value), FILES.records),
    nativeHistories: parseNdjson(contents[FILES.histories], value => NativeHistorySchema.parse(value), FILES.histories),
    queries: parseNdjson(contents[FILES.queries], value => PublicQuerySchema.parse(value), FILES.queries),
    questionGold: parseNdjson(contents[FILES.questionGold], value => QuestionGoldSchema.parse(value), FILES.questionGold),
    captureGold: parseNdjson(contents[FILES.captureGold], value => CaptureGoldSchema.parse(value), FILES.captureGold),
  };
  validateBenchmarkBundle(bundle);
  return bundle;
}

export const BENCHMARK_DATASET_FILES = FILES;
