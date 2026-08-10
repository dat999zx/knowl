import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { CollectionResult } from './collect.js';
import type { NativeCollectionResult } from './native-collect.js';
import type { NativeCaptureScore, NativeHistoryScore } from './native-score.js';
import type { AdapterMetadata } from './protocol.js';
import type { MetricValue, RetrievalQueryScore, RetrievalScore } from './score.js';
import type { BenchmarkBundle } from './schema.js';

export type ScoredSystemRun = {
  adapter: AdapterMetadata;
  collection: CollectionResult;
  scores: RetrievalScore[];
  nativeCollection: NativeCollectionResult;
  nativeScores: NativeCaptureScore[];
};

type MetricSummary = {
  median: number | null;
  values: Array<number | null>;
  numerators: number[];
  denominators: number[];
};

/** The columns every emitted result row carries, whatever produced it. */
type ResultIdentity = {
  datasetId: string;
  system: string;
  version: string;
  mode: string;
  run: number;
};

/**
 * A result row is either a scored one or the N/A placeholder standing in for a system that
 * produced nothing, and the two shapes share only `ResultIdentity`.
 *
 * Naming the union is what makes the branch legal rather than merely tidy. `flatMap` infers its
 * element type `U` from the callback's return, so a callback returning `Scored[] | NotApplicable[]`
 * fixes `U` from the first branch and then rejects the second for missing every metric field --
 * which is what `typecheck:bench` was failing on. Annotating `U` up front admits both.
 */
type NormalizedResultRow =
  | (ResultIdentity & RetrievalQueryScore)
  | (ResultIdentity & { questionId: string; notApplicableReason: string });

type NativeResultRow =
  | (ResultIdentity & NativeHistoryScore)
  | (ResultIdentity & { historyId: string; notApplicableReason: string });

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function summarizeMetrics<T extends object>(scores: Array<{ metrics: T }>): Record<keyof T, MetricSummary> {
  const metricNames = Object.keys(scores[0]?.metrics ?? {}) as Array<keyof T>;
  return Object.fromEntries(metricNames.map(name => {
    const runMetrics = scores.map(score => score.metrics[name] as MetricValue);
    const values = runMetrics.map(value => value.value);
    return [name, {
      median: values.every((value): value is number => value !== null) ? median(values) : null,
      values,
      numerators: runMetrics.map(value => value.numerator),
      denominators: runMetrics.map(value => value.denominator),
    }];
  })) as Record<keyof T, MetricSummary>;
}

function formatMetric(metrics: Record<string, MetricSummary> | null, name: string): string {
  const value = metrics?.[name]?.median;
  return value === null || value === undefined ? 'N/A' : value.toFixed(3);
}

// Backslashes go first, or the escape this adds gets escaped by the next pass: a value holding
// `\|` would come out `\\|`, which Markdown reads as a literal backslash followed by a live
// column separator -- one adapter name splits the row and the table stops lining up.
function tableText(value: string): string {
  return value.replace(/\\/gu, '\\\\').replace(/\|/gu, '\\|').replace(/\r?\n/gu, ' ');
}

function ndjson(rows: unknown[]): string {
  return rows.map(row => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : '');
}

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function releaseMetrics<T extends object>(input: {
  status: string;
  runCount: number;
  expectedRuns: number;
  scores: Array<{ metrics: T }>;
}): Record<keyof T, MetricSummary> | null {
  if (input.status !== 'complete' || input.runCount !== input.expectedRuns || input.scores.length !== input.expectedRuns) {
    return null;
  }
  return summarizeMetrics(input.scores);
}

export async function writeBenchmarkReport(input: {
  outputDirectory: string;
  bundle: BenchmarkBundle;
  benchmarkCommit: string;
  controls: { runs: number; seed: number; topK: number; contextBudget: number };
  systems: ScoredSystemRun[];
}): Promise<void> {
  const { manifest } = input.bundle;
  const generatedAt = new Date().toISOString();
  const cpu = os.cpus()[0]?.model ?? 'unknown';
  const normalizedSummaries = input.systems.map(system => ({
    system: system.adapter.name,
    version: system.adapter.version,
    repository: system.adapter.repository,
    commit: system.adapter.commit,
    configurationHash: system.adapter.configurationHash,
    status: system.collection.status,
    reason: system.collection.reason,
    runCount: system.collection.runs.length,
    metrics: releaseMetrics({
      status: system.collection.status,
      runCount: system.collection.runs.length,
      expectedRuns: input.controls.runs,
      scores: system.scores,
    }),
  }));
  const nativeSummaries = input.systems.map(system => ({
    system: system.adapter.name,
    version: system.adapter.version,
    status: system.nativeCollection.status,
    reason: system.nativeCollection.reason,
    runCount: system.nativeCollection.runs.length,
    scoringMethod: 'source-qualified-lexical-v1',
    metrics: releaseMetrics({
      status: system.nativeCollection.status,
      runCount: system.nativeCollection.runs.length,
      expectedRuns: input.controls.runs,
      scores: system.nativeScores,
    }),
  }));

  const rawPredictions = input.systems.flatMap(system => system.collection.runs.flatMap(run => run.predictions.map(prediction => ({
    datasetId: manifest.datasetId,
    system: system.adapter.name,
    version: system.adapter.version,
    mode: 'normalized',
    run: run.runIndex,
    seed: run.seed,
    ...prediction,
  }))));
  const normalizedResults = input.systems.flatMap<NormalizedResultRow>(system => {
    if (system.scores.length) {
      return system.scores.flatMap((score, runIndex) => score.perQuery.map(result => ({
        datasetId: manifest.datasetId,
        system: system.adapter.name,
        version: system.adapter.version,
        mode: 'normalized',
        run: runIndex,
        ...result,
      })));
    }
    return Array.from({ length: input.controls.runs }, (_, run) => input.bundle.queries.map(query => ({
      datasetId: manifest.datasetId,
      system: system.adapter.name,
      version: system.adapter.version,
      mode: 'normalized',
      run,
      questionId: query.questionId,
      notApplicableReason: system.collection.reason ?? 'no normalized result was collected',
    }))).flat();
  });
  const nativeResults = input.systems.flatMap<NativeResultRow>(system => {
    if (system.nativeScores.length) {
      return system.nativeScores.flatMap((score, runIndex) => score.perHistory.map(result => ({
        datasetId: manifest.datasetId,
        system: system.adapter.name,
        version: system.adapter.version,
        mode: 'native',
        run: runIndex,
        ...result,
      })));
    }
    return Array.from({ length: input.controls.runs }, (_, run) => input.bundle.nativeHistories.map(history => ({
      datasetId: manifest.datasetId,
      system: system.adapter.name,
      version: system.adapter.version,
      mode: 'native',
      run,
      historyId: history.historyId,
      notApplicableReason: system.nativeCollection.reason ?? 'no native capture result was collected',
    }))).flat();
  });
  const rawCapturePredictions = input.systems.flatMap(system => system.nativeCollection.runs.flatMap(run => run.predictions.map(prediction => ({
    datasetId: manifest.datasetId,
    system: system.adapter.name,
    version: system.adapter.version,
    mode: 'native',
    run: run.runIndex,
    seed: run.seed,
    ...prediction,
  }))));
  const unavailableAnswerRows = input.systems.flatMap(system => ['normalized', 'native'].flatMap(mode => (
    Array.from({ length: input.controls.runs }, (_, run) => input.bundle.queries.map(query => ({
      datasetId: manifest.datasetId,
      system: system.adapter.name,
      version: system.adapter.version,
      mode,
      run,
      questionId: query.questionId,
      status: 'not_applicable',
      reason: 'fixed reader and judge model revisions are not configured',
    }))).flat()
  )));

  const failureLines: string[] = [];
  for (const system of input.systems) {
    if (system.collection.status !== 'complete') {
      failureLines.push(`${system.adapter.name} / normalized / ${system.collection.status}: ${system.collection.reason ?? 'no reason recorded'}`);
    }
    for (const run of system.collection.runs) {
      for (const reason of run.failures) failureLines.push(`${system.adapter.name} / normalized / run ${run.runIndex}: ${reason}`);
    }
    system.scores.forEach((score, runIndex) => score.failures.forEach(failure => {
      failureLines.push(`${system.adapter.name} / normalized / run ${runIndex} / ${failure.questionId}: ${failure.reason}`);
    }));
    if (system.nativeCollection.status !== 'complete') {
      failureLines.push(`${system.adapter.name} / native / ${system.nativeCollection.status}: ${system.nativeCollection.reason ?? 'no reason recorded'}`);
    }
    for (const run of system.nativeCollection.runs) {
      for (const reason of run.failures) failureLines.push(`${system.adapter.name} / native / run ${run.runIndex}: ${reason}`);
    }
    system.nativeScores.forEach((score, runIndex) => score.failures.forEach(failure => {
      failureLines.push(`${system.adapter.name} / native / run ${runIndex} / ${failure.historyId}: ${failure.reason}`);
    }));
  }

  const dirtyWarning = input.benchmarkCommit.endsWith('+dirty')
    ? ['> **Non-publishable run:** the repository had uncommitted changes. Re-run from a clean commit before copying scores to the README.', '']
    : [];
  const normalizedRows = normalizedSummaries.map(summary => {
    const status = summary.status === 'complete' && summary.metrics
      ? 'complete'
      : `${summary.status}: ${summary.reason ?? 'incomplete run set'}`;
    return `| ${tableText(summary.system)} | ${tableText(status)} | ${formatMetric(summary.metrics, 'applicableCoverage')} | ${formatMetric(summary.metrics, 'strictAccuracyAtK')} | ${formatMetric(summary.metrics, 'recallAt5')} | ${formatMetric(summary.metrics, 'mrr')} | ${formatMetric(summary.metrics, 'ndcgAt5')} | ${formatMetric(summary.metrics, 'temporalAccuracy')} | ${formatMetric(summary.metrics, 'staleResultRate')} | ${formatMetric(summary.metrics, 'abstentionAccuracy')} |`;
  });
  const nativeRows = nativeSummaries.map(summary => {
    const status = summary.status === 'complete' && summary.metrics
      ? 'complete'
      : `${summary.status}: ${summary.reason ?? 'incomplete run set'}`;
    return `| ${tableText(summary.system)} | ${tableText(status)} | ${formatMetric(summary.metrics, 'capturePrecision')} | ${formatMetric(summary.metrics, 'captureRecall')} | ${formatMetric(summary.metrics, 'captureF1')} | ${formatMetric(summary.metrics, 'secretLeakRate')} | ${formatMetric(summary.metrics, 'interruptedSessionRecovery')} | ${formatMetric(summary.metrics, 'idempotencyAccuracy')} |`;
  });
  const leaderboardLines = [
    '# Accuracy Benchmark Leaderboard',
    '',
    ...dirtyWarning,
    'This report contains only scores reproduced by this harness. `N/A` entries are not treated as zero and are excluded from ranking.',
    '',
    '## Normalized retrieval',
    '',
    '| System | Status | Applicable coverage | Strict accuracy | Recall@5 | MRR | nDCG@5 | Temporal accuracy | Stale-result rate | Abstention accuracy |',
    '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
    ...normalizedRows,
    '',
    'Coverage is shown beside accuracy so a system cannot improve its headline score by marking difficult supported queries `N/A`. Run-level numerators and denominators are in `normalized-summary.json`.',
    '',
    '## Native pipeline',
    '',
    '| System | Status | Capture precision | Capture recall | Capture F1 | Secret-retention rate | Interrupted recovery | Idempotency accuracy |',
    '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |',
    ...nativeRows,
    '',
    'Native capture matching is a conservative source-qualified lexical check. Paraphrase-sensitive semantic capture and final-answer accuracy remain `N/A` until a pinned blinded judge and fixed reader are configured.',
    '',
    '## Answer quality',
    '',
    'N/A for every system: reader and judge model revisions, prompts, and serializer hashes are not configured.',
    '',
    '## Run metadata',
    '',
    `- Benchmark commit: \`${input.benchmarkCommit}\``,
    `- Date: ${generatedAt.slice(0, 10)}`,
    `- Dataset: \`${manifest.datasetId}\` / generator \`${manifest.generatorVersion}\` / seed \`${manifest.seed}\``,
    `- Dataset files: ${Object.entries(manifest.digests).map(([filename, hash]) => `\`${filename}\` \`${hash}\``).join('; ')}`,
    `- Questions: ${manifest.counts.questions}; histories: ${manifest.counts.histories}; runs: ${input.controls.runs}`,
    `- Controls: topK ${input.controls.topK}; context budget ${input.controls.contextBudget} tokens`,
    `- Hardware: ${process.platform} ${os.release()}, ${process.arch}, ${cpu}, Node ${process.version}`,
    '- Reader model: N/A (unconfigured)',
    '- Judge model: N/A (unconfigured)',
    '- Raw outputs: [retrieval results](./raw-results.ndjson), [retrieval predictions](./raw-predictions.ndjson), [native capture](./raw-capture.ndjson), [reader N/A records](./reader-results.ndjson), [judge N/A records](./judge-results.ndjson)',
    '- Reproduce: `npm ci && npm run benchmark:accuracy`',
    '',
    '## Interpretation limits',
    '',
    '`coding-memory-v1` is a deterministic synthetic regression corpus built from 20 scenario families across five fictional projects. It is not sufficient by itself for real-world or statistical-superiority claims. No winner is declared until external adapters and at least one pinned established benchmark dataset are run.',
    '',
  ];

  const safeEnvironmentKeys = ['NODE_OPTIONS', 'HF_HOME', 'TRANSFORMERS_CACHE'];
  const files: Record<string, string> = {
    'environment.json': `${JSON.stringify({
      benchmarkCommit: input.benchmarkCommit,
      generatedAt,
      platform: process.platform,
      release: os.release(),
      architecture: process.arch,
      node: process.version,
      cpu,
      controls: input.controls,
      reader: { status: 'unconfigured' },
      judge: { status: 'unconfigured' },
      materialEnvironment: Object.fromEntries(safeEnvironmentKeys.map(key => [key, process.env[key] ?? null])),
      reproductionCommand: 'npm ci && npm run benchmark:accuracy',
    }, null, 2)}\n`,
    'systems.json': `${JSON.stringify(input.systems.map(system => ({
      ...system.adapter,
      normalizedRun: { status: system.collection.status, reason: system.collection.reason },
      nativeRun: { status: system.nativeCollection.status, reason: system.nativeCollection.reason },
    })), null, 2)}\n`,
    'capabilities.json': `${JSON.stringify(Object.fromEntries(input.systems.map(system => [system.adapter.name, system.adapter.capabilities])), null, 2)}\n`,
    'raw-predictions.ndjson': ndjson(rawPredictions),
    'raw-results.ndjson': ndjson(normalizedResults),
    'raw-capture.ndjson': ndjson([...rawCapturePredictions, ...nativeResults]),
    'reader-results.ndjson': ndjson(unavailableAnswerRows),
    'judge-results.ndjson': ndjson(unavailableAnswerRows),
    'normalized-summary.json': `${JSON.stringify({
      dataset: manifest,
      benchmarkCommit: input.benchmarkCommit,
      controls: input.controls,
      systems: normalizedSummaries,
    }, null, 2)}\n`,
    'native-summary.json': `${JSON.stringify({
      dataset: manifest,
      benchmarkCommit: input.benchmarkCommit,
      controls: input.controls,
      systems: nativeSummaries,
    }, null, 2)}\n`,
    'leaderboard.md': leaderboardLines.join('\n'),
    'knowl-ablations.md': [
      '# Knowl Ablations', '',
      '| Configuration | Status |', '| --- | --- |',
      '| BM25 only | N/A - not implemented as a preregistered adapter |',
      '| Vectors only | N/A - embedding revision unconfigured |',
      '| Hybrid | N/A - embedding revision unconfigured |',
      '| Hybrid without freshness weighting | N/A - adapter not implemented |',
      '| Hybrid without diversification | N/A - adapter not implemented |',
      '| Hybrid without identifier boosts | N/A - adapter not implemented |',
      '| Full Knowl | N/A - full pinned vector configuration unconfigured |',
      '',
      'The cross-system Knowl row uses the exact default configuration recorded in `systems.json`; it is not relabeled as the full-vector ablation.',
      '',
    ].join('\n'),
    'failures.md': ['# Benchmark Failures and N/A Entries', '', ...(failureLines.length ? failureLines.map(line => `- ${line}`) : ['No failures or N/A entries.']), ''].join('\n'),
  };

  await fs.mkdir(input.outputDirectory, { recursive: true });
  for (const [filename, content] of Object.entries(files)) {
    await fs.writeFile(path.join(input.outputDirectory, filename), content, 'utf-8');
  }
  const hashes = Object.entries(files)
    .map(([filename, content]) => `${sha256(content)}  ${filename}`)
    .join('\n') + '\n';
  await fs.writeFile(path.join(input.outputDirectory, 'artifacts.sha256'), hashes, 'utf-8');
}
