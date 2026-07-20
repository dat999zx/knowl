import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { NoMemoryAdapter } from '../../benchmarks/accuracy/src/baselines.js';
import { collectNormalized } from '../../benchmarks/accuracy/src/collect.js';
import { generateCodingMemoryBundle } from '../../benchmarks/accuracy/src/generator.js';
import { collectNative } from '../../benchmarks/accuracy/src/native-collect.js';
import { writeBenchmarkReport } from '../../benchmarks/accuracy/src/report.js';
import { scoreRetrieval } from '../../benchmarks/accuracy/src/score.js';

const OUTPUT = path.resolve('.tmp/accuracy-report-test');

afterEach(async () => {
  await fs.rm(OUTPUT, { recursive: true, force: true });
});

describe('benchmark report', () => {
  it('publishes denominators, coverage, explicit native N/A rows, and reproducibility metadata', async () => {
    const bundle = generateCodingMemoryBundle('20260713');
    const adapter = new NoMemoryAdapter();
    const collection = await collectNormalized(
      { records: bundle.normalizedRecords, queries: bundle.queries },
      adapter,
      { runs: 1, seed: 20260713, topK: 10, contextBudget: 2_000 },
    );
    const scores = collection.runs.map(run => scoreRetrieval(
      bundle.normalizedRecords,
      bundle.queries,
      bundle.questionGold,
      run.predictions,
      adapter.metadata.capabilities.normalized,
      10,
    ));
    const nativeCollection = await collectNative(
      { histories: bundle.nativeHistories },
      adapter,
      { runs: 1, seed: 20260713 },
    );

    await writeBenchmarkReport({
      outputDirectory: OUTPUT,
      bundle,
      benchmarkCommit: `${'a'.repeat(40)}+dirty`,
      controls: { runs: 1, seed: 20260713, topK: 10, contextBudget: 2_000 },
      systems: [{ adapter: adapter.metadata, collection, scores, nativeCollection, nativeScores: [] }],
    });

    const leaderboard = await fs.readFile(path.join(OUTPUT, 'leaderboard.md'), 'utf-8');
    expect(leaderboard).toContain('Applicable coverage');
    expect(leaderboard).toContain('Non-publishable run');
    expect(leaderboard).toContain('## Native pipeline');
    expect(leaderboard).toContain('npm ci && npm run benchmark:accuracy');

    const summary = JSON.parse(await fs.readFile(path.join(OUTPUT, 'normalized-summary.json'), 'utf-8'));
    expect(summary.systems[0].metrics.strictAccuracyAtK).toMatchObject({
      values: [expect.any(Number)],
      numerators: [expect.any(Number)],
      denominators: [200],
    });
    const nativeRows = (await fs.readFile(path.join(OUTPUT, 'raw-capture.ndjson'), 'utf-8')).trim().split('\n');
    expect(nativeRows).toHaveLength(100);
    expect(JSON.parse(nativeRows[0]).notApplicableReason).toContain('normalized records only');
    expect(await fs.readFile(path.join(OUTPUT, 'artifacts.sha256'), 'utf-8')).toContain('leaderboard.md');
  });
});
