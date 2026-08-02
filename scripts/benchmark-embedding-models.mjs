#!/usr/bin/env node
/**
 * Compares every embedding preset on `docs/evals/semantic-suite.json`.
 *
 * Deliberately not in CI: a first run downloads roughly 207MB of model weights.
 *
 * Usage:
 *   npm run bench:embeddings                      # every preset, plus the BM25 floor
 *   node scripts/benchmark-embedding-models.mjs bge-small-en minilm-l6-en
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SUITE = path.join(ROOT, 'docs', 'evals', 'semantic-suite.json');
const CLI = path.join(ROOT, 'dist', 'index.js');

// Kept in step with PRESET_IDS in src/core/vector-profile.ts. A stale entry here fails
// loudly rather than silently skipping: `config set` rejects an unknown preset id.
const ALL_PRESETS = ['granite-small-en-r2', 'granite-97m-multilingual', 'bge-small-en', 'minilm-l6-en'];

/**
 * One model cache for every run, outside the throwaway roots.
 *
 * Each preset needs its own project root so it can hold its own config, and those roots are
 * deleted afterwards. Left at the default `<root>/.knowl/models` that would re-download all
 * 207MB on every invocation.
 */
const MODEL_CACHE = path.join(ROOT, '.knowl', 'models');

const requested = process.argv.slice(2);
const presets = requested.length > 0 ? requested : ALL_PRESETS;

/**
 * A fresh store per preset. Sharing one would mean each run inherits the previous model's
 * rows, and the fingerprint filter would silently hide them -- producing a plausible table
 * built on an empty corpus.
 */
function runPreset(preset) {
  const root = mkdtempSync(path.join(tmpdir(), `knowl-bench-${preset ?? 'bm25'}-`));
  try {
    // Init warms the *default* model, which is not necessarily the one under test.
    execFileSync('node', [CLI, 'init'], {
      cwd: root, stdio: 'inherit', env: { ...process.env, KNOWL_SKIP_MODEL_DOWNLOAD: '1' },
    });
    execFileSync('node', [CLI, 'config', 'set', 'search.vector.cacheDir', MODEL_CACHE], { cwd: root, stdio: 'inherit' });
    if (preset) {
      execFileSync('node', [CLI, 'config', 'set', 'search.vector.preset', preset], { cwd: root, stdio: 'inherit' });
    }

    const args = [CLI, 'eval', 'retrieval', '--dataset', SUITE, '--json'];
    if (preset) args.push('--vector');
    // maxBuffer raised: the JSON carries every failed case id.
    return JSON.parse(execFileSync('node', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const rows = [];
for (const preset of [...presets, null]) {
  const label = preset ?? 'bm25 only (floor)';
  console.error(`\n=== ${label} ===`);
  try {
    rows.push({ label, result: runPreset(preset) });
  } catch (error) {
    // One model failing to download must not throw away the runs that succeeded.
    console.error(`${label} failed: ${error.message}`);
    rows.push({ label, error: error.message });
  }
}

const TIERS = ['basic', 'moderate', 'extreme'];
const cell = value => String(value).padEnd(9);

console.log(`\n${['model'.padEnd(26), ...TIERS.map(tier => cell(tier)), cell('overall'), 'p50 ms'].join(' ')}`);
console.log('-'.repeat(26 + 4 * 10 + 7));

for (const row of rows) {
  if (row.error) {
    console.log(`${row.label.padEnd(26)} ${'FAILED'.padEnd(9)}`);
    continue;
  }
  const cells = TIERS.map(tier => {
    const metrics = row.result.byTier?.[tier];
    return cell(metrics ? metrics.recallAt10.toFixed(4) : '-');
  });
  console.log([
    row.label.padEnd(26),
    ...cells,
    cell(row.result.metrics?.recallAt10?.toFixed(4) ?? '-'),
    String(row.result.metrics?.p50LatencyMs ?? '-'),
  ].join(' '));
}

console.log('\nRecall@10 per tier. Basic is the deciding column: it predicts day-to-day quality.');
console.log('Extreme is a stress signal. A model that wins there while losing on basic is the wrong pick.');
console.log('If bm25-only matches the models across every tier, the suite is not discriminating.');
