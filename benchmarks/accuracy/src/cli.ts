#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Command } from 'commander';
import {
  Bm25Adapter,
  GrepAdapter,
  HashVectorAdapter,
  NoMemoryAdapter,
  SemanticVectorUnavailableAdapter,
} from './baselines.js';
import { collectNormalized } from './collect.js';
import { collectNative } from './native-collect.js';
import { scoreNativeCapture } from './native-score.js';
import { readBenchmarkBundle, writeBenchmarkBundle } from './dataset.js';
import { generateCodingMemoryBundle } from './generator.js';
import { KnowlBenchmarkAdapter } from './knowl-adapter.js';
import type { BenchmarkAdapter } from './protocol.js';
import { loadUnavailableAdapters } from './registry.js';
import { writeBenchmarkReport, type ScoredSystemRun } from './report.js';
import { scoreRetrieval } from './score.js';
import { validateBenchmarkBundle } from './validate.js';

const DEFAULT_SEED = '20260713';
const DEFAULT_RUNS = 3;
const DEFAULT_TOP_K = 10;
const DEFAULT_CONTEXT_BUDGET = 2_000;
const DEFAULT_DATASET = path.join('benchmarks', 'accuracy', 'datasets', 'coding-memory-v1');
const DEFAULT_LOCK = path.join('benchmarks', 'accuracy', 'systems.lock.json');

type RunOptions = {
  dataset: string;
  output?: string;
  lock: string;
};

function benchmarkCommit(): string {
  const commit = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf-8' });
  if (commit.status !== 0) return 'unknown';
  const status = spawnSync('git', ['status', '--porcelain'], { encoding: 'utf-8' });
  return `${commit.stdout.trim()}${status.stdout.trim() ? '+dirty' : ''}`;
}

function defaultOutput(commit: string): string {
  const dirty = commit.endsWith('+dirty') ? '-dirty' : '';
  const safeCommit = `${commit.replace(/\+dirty$/u, '').slice(0, 12)}${dirty}`;
  return path.join('benchmarks', 'accuracy', 'results', safeCommit);
}

async function generateDataset(output: string, seed: string): Promise<void> {
  await writeBenchmarkBundle(generateCodingMemoryBundle(seed), path.resolve(output));
  process.stdout.write(`Generated coding-memory-v1 at ${path.resolve(output)}\n`);
}

async function validateDataset(directory: string): Promise<void> {
  const bundle = await readBenchmarkBundle(path.resolve(directory));
  validateBenchmarkBundle(bundle, { release: true });
  process.stdout.write(
    `Validated ${bundle.manifest.datasetId}: ${bundle.manifest.counts.histories} histories, `
      + `${bundle.manifest.counts.sessions} sessions, ${bundle.manifest.counts.questions} questions\n`,
  );
}

async function runAccuracy(options: RunOptions): Promise<void> {
  const bundle = await readBenchmarkBundle(path.resolve(options.dataset));
  validateBenchmarkBundle(bundle, { release: true });
  if (bundle.manifest.seed !== DEFAULT_SEED) {
    throw new Error(`Release runs require dataset seed ${DEFAULT_SEED}; found ${bundle.manifest.seed}.`);
  }
  const commit = benchmarkCommit();
  const packageMetadata = JSON.parse(await fs.readFile(path.resolve('package.json'), 'utf-8')) as { version: string };
  const outputDirectory = path.resolve(options.output ?? defaultOutput(commit));
  const unavailable = await loadUnavailableAdapters(path.resolve(options.lock));
  const adapters: BenchmarkAdapter[] = [
    new KnowlBenchmarkAdapter(commit.replace(/\+dirty$/u, ''), packageMetadata.version),
    ...unavailable,
    new Bm25Adapter(),
    new GrepAdapter(),
    new SemanticVectorUnavailableAdapter(),
    new HashVectorAdapter(),
    new NoMemoryAdapter(),
  ];
  const systems: ScoredSystemRun[] = [];

  for (const adapter of adapters) {
    process.stdout.write(`Collecting ${adapter.metadata.name}...\n`);
    const collection = await collectNormalized(
      { records: bundle.normalizedRecords, queries: bundle.queries },
      adapter,
      { runs: DEFAULT_RUNS, seed: Number(DEFAULT_SEED), topK: DEFAULT_TOP_K, contextBudget: DEFAULT_CONTEXT_BUDGET },
    );
    const scores = collection.runs.map(run => scoreRetrieval(
      bundle.normalizedRecords,
      bundle.queries,
      bundle.questionGold,
      run.predictions,
      adapter.metadata.capabilities.normalized,
      DEFAULT_TOP_K,
    ));
    const nativeCollection = await collectNative(
      { histories: bundle.nativeHistories },
      adapter,
      { runs: DEFAULT_RUNS, seed: Number(DEFAULT_SEED) },
    );
    const nativeScores = nativeCollection.runs.map(run => scoreNativeCapture(
      bundle.nativeHistories,
      bundle.captureGold,
      run.predictions,
      adapter.metadata.capabilities.native,
    ));
    systems.push({
      adapter: adapter.metadata,
      collection,
      scores,
      nativeCollection,
      nativeScores,
    });
  }

  await writeBenchmarkReport({
    outputDirectory,
    bundle,
    benchmarkCommit: commit,
    controls: {
      runs: DEFAULT_RUNS,
      seed: Number(DEFAULT_SEED),
      topK: DEFAULT_TOP_K,
      contextBudget: DEFAULT_CONTEXT_BUDGET,
    },
    systems,
  });
  process.stdout.write(`Wrote accuracy artifacts to ${outputDirectory}\n`);
}

const program = new Command()
  .name('knowl-accuracy-benchmark')
  .description('Generate, validate, and run the reproducible Knowl accuracy benchmark.');

program.command('generate')
  .option('--output <directory>', 'dataset output directory', DEFAULT_DATASET)
  .option('--seed <seed>', 'deterministic dataset seed', DEFAULT_SEED)
  .action(async ({ output, seed }: { output: string; seed: string }) => generateDataset(output, seed));

program.command('validate')
  .option('--dataset <directory>', 'dataset directory', DEFAULT_DATASET)
  .action(async ({ dataset }: { dataset: string }) => validateDataset(dataset));

program.command('run')
  .option('--dataset <directory>', 'dataset directory', DEFAULT_DATASET)
  .option('--output <directory>', 'artifact output directory')
  .option('--lock <file>', 'pinned external-system lock file', DEFAULT_LOCK)
  .action(runAccuracy);

program.command('all')
  .option('--dataset <directory>', 'dataset directory', DEFAULT_DATASET)
  .option('--output <directory>', 'artifact output directory')
  .option('--lock <file>', 'pinned external-system lock file', DEFAULT_LOCK)
  .action(async (options: RunOptions) => {
    await generateDataset(options.dataset, DEFAULT_SEED);
    await runAccuracy(options);
  });

await program.parseAsync();
