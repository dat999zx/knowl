// Standalone entry point for the MemoryAgentBench Conflict Resolution benchmark.
//
// Not wired into src/index.ts: research tooling must not ship in the published package, appear in
// `knowl --help`, or be able to break the product build or test suite.
//
// Run with:  npm run bench:cr -- <fetch|run> [options]

import { Command } from 'commander';
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { findProjectRoot } from '../../src/core/config.js';
import { normalizeAnswers } from './facts.js';
import { runConflictResolution } from './runner.js';

const SPLIT_URL =
  'https://datasets-server.huggingface.co/rows?dataset=ai-hyz%2FMemoryAgentBench&config=default&split=Conflict_Resolution';

// The response is a third-party dataset server, so nothing from it reaches disk unchecked --
// `fetch` writes a file the `run` subcommand later parses as trusted input. Shape first, then
// the derived id: it names the instance and is one edit away from naming a path, so it is
// constrained to a charset that cannot traverse or hide a separator.
const RowSchema = z.object({
  context: z.string(),
  questions: z.array(z.string()),
  answers: z.array(z.union([z.string(), z.array(z.string())])),
  metadata: z.object({ qa_pair_ids: z.array(z.string()).optional() }).partial().optional(),
});

const SplitResponseSchema = z.object({
  rows: z.array(z.object({ row: RowSchema })),
});

const SAFE_ID = /^[A-Za-z0-9._-]+$/;

const program = new Command()
  .name('bench:cr')
  .description('MemoryAgentBench Conflict Resolution harness (research tooling, not part of the Knowl CLI)');

program
  .command('fetch')
  .description('Download one Conflict Resolution instance as JSON')
  .option('--row <n>', 'Row index: 0-3 are multi-hop 6k/32k/64k/262k, 4-7 the single-hop equivalents', '4')
  .option('--out <path>', 'Where to write the instance', 'benchmarks/memoryagentbench/data/cr-sh-6k.json')
  .action(async (options) => {
    const response = await fetch(`${SPLIT_URL}&offset=${Number(options.row)}&length=1`);
    if (!response.ok) throw new Error(`Download failed: ${response.status} ${response.statusText}`);
    const payload = SplitResponseSchema.parse(await response.json());
    const row = payload.rows[0]?.row;
    if (!row) throw new Error('No row returned.');

    const candidate = row.metadata?.qa_pair_ids?.[0]?.replace(/_no\d+$/, '');
    const id = candidate && SAFE_ID.test(candidate) ? candidate : `row-${Number(options.row)}`;
    const instance = {
      id,
      context: row.context,
      questions: row.questions,
      answers: normalizeAnswers(row.answers),
    };

    const outPath = path.resolve(options.out);
    await fs.mkdir(path.dirname(outPath), { recursive: true });
    await fs.writeFile(outPath, JSON.stringify(instance, null, 2), 'utf-8');

    console.log(`Wrote ${id} to ${options.out}`);
    console.log(`  context ${row.context.length} chars · ${row.questions.length} questions`);
  });

program
  .command('run')
  .description('Ingest one instance into an isolated store and score conflict resolution')
  .requiredOption('--instance <path>', 'Instance JSON written by `fetch`')
  .option('--top-k <n>', 'Results retrieved per question', '5')
  .option('--questions <n>', 'Score only the first N questions')
  .option('--no-vector', 'Use the BM25-only lower bound')
  .option('--no-supersede', 'Ablation: insert every fact without retiring anything')
  .option('--out <path>', 'Write the full JSON result to this path')
  .option('--json', 'Print machine-readable JSON')
  .action(async (options) => {
    const topK = Number(options.topK);
    if (!Number.isInteger(topK) || topK < 1) throw new Error('--top-k must be a positive integer.');

    const result = await runConflictResolution({
      instancePath: path.resolve(options.instance),
      projectRoot: await findProjectRoot(process.cwd()),
      topK,
      vector: options.vector !== false,
      supersede: options.supersede !== false,
      questionLimit: options.questions === undefined ? undefined : Number(options.questions),
      onProgress: ({ completed, total }) => {
        if (completed === 1 || completed % 10 === 0) {
          process.stderr.write(`\r  answered ${completed}/${total}   `);
        }
      },
    });
    process.stderr.write('\r');

    if (options.out) {
      const outPath = path.resolve(options.out);
      await fs.mkdir(path.dirname(outPath), { recursive: true });
      await fs.writeFile(outPath, JSON.stringify(result, null, 2), 'utf-8');
    }
    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    const { report } = result;
    console.log(`MemoryAgentBench Conflict Resolution — ${path.basename(result.instance)}`);
    console.log(`  retrieval: ${result.retrieval} · top-k ${result.topK} · supersession: ${result.supersede ? 'ON' : 'OFF (ablation)'}`);
    console.log(`  ingested ${result.facts} facts · ${result.conflictGroups} conflict groups`);
    console.log(`  superseded at write: ${result.supersededAtWrite} · active after ingest: ${result.activeAfterIngest}`);
    console.log('');
    console.log(`  top-1 accuracy:      ${(report.topOneAccuracy * 100).toFixed(1)}%   <- headline`);
    console.log(`  any-rank accuracy:   ${(report.anyRankAccuracy * 100).toFixed(1)}%   (diagnostic, weaker)`);
    console.log(`  stale leaks:         ${report.staleLeaks} / ${report.questions}`);
    console.log(`  empty results:       ${report.emptyResults}`);
    console.log(`  p50 ${report.p50LatencyMs}ms · p95 ${report.p95LatencyMs}ms`);
  });

program.parseAsync(process.argv).catch((error: any) => {
  console.error(`Error: ${error.message}`);
  process.exit(1);
});
