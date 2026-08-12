import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * `--vector` has to actually rank with vectors, and for a fixture-backed dataset it silently
 * did not.
 *
 * The eval command builds a throwaway store when a dataset carries `fixtures`, inserts them,
 * and ranks against it. A change that stopped the command reindexing before measuring was
 * correct for a dataset evaluated against the live store -- an "evaluate" that rewrites the
 * embedding table describes a state the store was not in -- but it left fixture runs with no
 * embeddings at all. A query vector then had nothing to match, every case fell through to
 * BM25, and the metrics came back byte-identical to a plain run with nothing said about it.
 *
 * The measured cost: `--vector` and BM25 both reported MRR 0.890152 on the governance suite
 * and 0.731818 on the semantic suite -- the one built to need embeddings. Five of the six
 * checked-in datasets carry fixtures, so every published vector figure had become
 * unreproducible by the command the docs print next to it.
 *
 * Recall@3 rather than MRR, because it is binary here: the expected item is either retrieved
 * or it is not, so the assertion cannot drift with a model's ranking by a few hundredths.
 */

const CLI_PATH = path.resolve('./dist/index.js');
const ROOT = path.join(os.tmpdir(), 'knowl-eval-vector-fixtures');
const DATASET = path.join(ROOT, 'dataset.json');

/**
 * One case the two rankers must disagree about.
 *
 * `decoy` is stuffed with the query's literal token and is about something else entirely;
 * `auth` is what the question means and never says "sign in". BM25 ranks the decoy and misses
 * the answer outright; vectors find it. A dataset both rankers agree on would pass whether or
 * not the fixtures were ever embedded, which is the whole failure being pinned.
 */
const DATASET_JSON = {
  fixtures: [
    {
      id: 'auth',
      category: 'decision',
      title: 'How users log in',
      content: 'Authentication uses server-side session cookies. A user\'s login is revoked immediately on logout, and credentials are never stored in the browser.',
    },
    {
      id: 'decoy',
      category: 'fact',
      title: 'Signing release binaries',
      content: 'Release binaries are signed with cosign. Signing keys rotate quarterly. Every signed artifact is verified on download, and unsigned builds are rejected. Sign, signing, signed.',
    },
  ],
  cases: [
    {
      id: 'login',
      query: 'how do people sign in to the product',
      expectedItemIds: ['auth'],
      mustNotReturn: [],
      limit: 3,
    },
  ],
};

type Run = { metrics: { recallAt3: number }; stderr: string };

function evaluate(vector: boolean): Run {
  const args = [CLI_PATH, 'eval', '--dataset', DATASET, '--json'];
  if (vector) args.push('--vector');
  // cwd is the initialised fixture repository, not the process's own. The command resolves a
  // project root to read vector config from, and a developer checkout happens to be one --
  // `.knowl/` is gitignored, so CI's is not, and running from the default cwd passed locally
  // and failed on all four legs with "No Knowl project found".
  //
  // spawnSync rather than execFileSync: stderr carries the fixture-embedding notice, which is
  // the direct evidence the reindex ran, and execFileSync does not hand it back on success.
  const result = spawnSync(process.execPath, args, { cwd: ROOT, encoding: 'utf8' });
  expect(result.status, result.stderr).toBe(0);
  return { metrics: JSON.parse(result.stdout).metrics, stderr: result.stderr };
}

describe('knowl eval --vector against a fixture-backed dataset', () => {
  beforeAll(async () => {
    await fs.rm(ROOT, { recursive: true, force: true }).catch(() => {});
    await fs.mkdir(ROOT, { recursive: true });
    await fs.writeFile(DATASET, JSON.stringify(DATASET_JSON), 'utf8');
    // The fixtures are evaluated in a throwaway store the command builds, but it still resolves
    // a project root to read the vector configuration from, so one has to exist.
    const init = spawnSync(process.execPath, [CLI_PATH, 'init', '--yes'], { cwd: ROOT, encoding: 'utf8' });
    expect(init.status, init.stderr).toBe(0);
    // `init` warms the local embedding model, so this hook is exposed to the same contention as
    // the test body and needs the same headroom as the suite's 30s default.
  }, 120_000);

  afterAll(async () => {
    await fs.rm(ROOT, { recursive: true, force: true }).catch(() => {});
  });

  it('embeds the fixtures it created, so the vector path outranks BM25 instead of silently becoming it', () => {
    const bm25 = evaluate(false);
    const vector = evaluate(true);

    // The decoy owns the query's literal token, so keyword ranking never surfaces the answer.
    expect(bm25.metrics.recallAt3, 'BM25 should miss a purely semantic case').toBe(0);
    // With the fixtures embedded, it does. Before the fix both of these read 0.
    expect(vector.metrics.recallAt3, '--vector should retrieve what BM25 cannot').toBe(1);

    // The outcome above is what matters, but assert the mechanism too: a future change could
    // make this dataset pass on keywords alone and the regression would go unnoticed again.
    expect(vector.stderr).toMatch(/Embedded 2 fixture\(s\)/);
    expect(bm25.stderr).not.toMatch(/Embedded/);
    // Three spawned CLI runs, one of which loads the local embedding model: ~19s alone, and the
    // suite's 30s default is not enough headroom once four workers are competing for the CPU.
    // Observed failing once in a full run and passing alone and in two full runs after.
  }, 120_000);
});
