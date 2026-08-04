#!/usr/bin/env node
/**
 * Run a TARGETED mutation slice and report survivors.
 *
 * Not wired into `npm test`, and deliberately so. The tool is not in `package.json`: CI is
 * `npm ci && npm run build && npm test` on ubuntu/node 22, and a devDependency on Stryker would
 * add ~200 packages to every CI install for something CI never runs. Install it locally:
 *
 *   npm install --prefix .tmp/tools --no-save \
 *     @stryker-mutator/core@9.6.1 @stryker-mutator/vitest-runner@9.6.1
 *
 * then:
 *
 *   node scripts/mutation/run.mjs src/store/gc.ts
 *   node scripts/mutation/run.mjs --all-tests src/core/knowledge-validation.ts
 *
 * `--all-tests` widens the test set from the target's transitive importers to the whole
 * in-process suite. Use it to CONFIRM a survivor before reporting it: the narrow set is a
 * static lower bound and can call a mutant "survived" that some unrelated suite would kill.
 */
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const STRYKER = path.join(ROOT, '.tmp', 'tools', 'node_modules', '.bin', 'stryker.cmd');
const STRYKER_POSIX = path.join(ROOT, '.tmp', 'tools', 'node_modules', '.bin', 'stryker');
const bin = existsSync(STRYKER) ? STRYKER : STRYKER_POSIX;

if (!existsSync(bin)) {
  console.error(`Stryker is not installed at ${path.join(ROOT, '.tmp', 'tools')}.`);
  console.error('Install it with the command in the header of this file. It is intentionally');
  console.error('not a devDependency: CI never runs a mutation slice.');
  process.exit(2);
}

const args = process.argv.slice(2);
const allTests = args.includes('--all-tests');
/**
 * `--tests=a.test.ts,b.test.ts` overrides the computed importer set.
 *
 * This is the cost lever that makes a slice finish. MEASURED on this repo: with the full
 * importer set, tool-schema.ts ran at 68/349 mutants in 9 minutes (ETA 3h29m) and the vitest
 * child died with a native ACCESS_VIOLATION seven times, because Stryker re-runs the same
 * libSQL-backed files hundreds of times inside one long-lived process and the native handles
 * accumulate. Restricting stage 1 to the cheap, DB-light files inverts that: most mutants are
 * killed by a fast test, and only the survivors need the expensive confirmation.
 *
 * A survivor found this way is a CANDIDATE. Confirm it against the wider set before reporting.
 */
const testsFlag = args.find((a) => a.startsWith('--tests='));
const targets = args.filter((a) => !a.startsWith('--')).map((a) => a.replace(/\\/g, '/'));
if (targets.length === 0) {
  console.error('usage: run.mjs [--all-tests] <src/file.ts> ...');
  process.exit(2);
}

/**
 * Sweep the scratch the previous run left, ONCE, before anything starts.
 *
 * `vitest.mutation.config.ts` turns off the suite's own `globalSetup` teardown, because under
 * mutation testing several vitest runs share one working directory and each one's teardown
 * deletes the others' live fixtures. The price is that scratch now accumulates across runs, and
 * that is not free either: a stale transcripts fixture made
 * `tests/transcripts/mcp-handlers.test.ts` fail in Stryker's initial run ("expected undefined to
 * be defined") while the same file passed alone under the normal config. Sweeping here, in the
 * one process that is definitely alone, gets both.
 */
const { sweepScratchDirectories } = await import('../../tests/global-teardown.ts').catch(() => ({}));
if (sweepScratchDirectories) {
  const swept = await sweepScratchDirectories(ROOT);
  console.log(`swept ${swept.removed} stale scratch director(ies) before starting`);
}

const selection = JSON.parse(
  execFileSync(process.execPath, [path.join('scripts', 'mutation', 'select-tests.mjs'), '--json', ...targets], {
    encoding: 'utf8',
  }),
);

const slug = targets.map((t) => t.replace(/[^a-z0-9]+/gi, '-')).join('_');
const outDir = path.join(ROOT, '.tmp', 'mutation', slug);
mkdirSync(outDir, { recursive: true });

const config = {
  packageManager: 'npm',
  testRunner: 'vitest',
  vitest: { configFile: 'vitest.mutation.config.ts' },
  // perTest asks vitest which tests touched the mutated statement and runs only those. It is
  // the difference between "the importer set" and "the three tests that actually reach here".
  coverageAnalysis: 'perTest',
  // No sandbox copy. The repo is a throwaway worktree with everything committed, and copying
  // it per run costs more than the slice does. Stryker restores the file when it finishes; if
  // it is killed mid-run, `git checkout -- src/` is the recovery.
  inPlace: true,
  mutate: targets,
  plugins: [
    './.tmp/tools/node_modules/@stryker-mutator/vitest-runner/dist/src/index.js',
  ],
  reporters: ['json', 'clear-text', 'progress'],
  jsonReporter: { fileName: path.relative(ROOT, path.join(outDir, 'mutation.json')).replace(/\\/g, '/') },
  htmlReporter: { fileName: path.relative(ROOT, path.join(outDir, 'mutation.html')).replace(/\\/g, '/') },
  tempDirName: '.tmp/stryker-tmp',
  concurrency: Number(process.env.KNOWL_MUTATION_CONCURRENCY ?? 4),
  timeoutMS: 20_000,
  timeoutFactor: 2,
  // A slice that scores zero is a result, not a failure of the run.
  thresholds: { high: 100, low: 0, break: null },
  // MUST stay false with `inPlace`. `disableTypeChecks: true` prepends `// @ts-nocheck` to
  // every .ts/.js file Stryker can see, and with no sandbox that is the real working tree:
  // measured, 175 files rewritten in place. Stryker restores them on a clean exit, but a
  // killed run leaves the repo mangled. Vitest transpiles without type-checking anyway, so
  // there is nothing to disable.
  disableTypeChecks: false,
};

const configPath = path.join(outDir, 'stryker.config.json');
writeFileSync(configPath, JSON.stringify(config, null, 2));

const chosen = testsFlag ? testsFlag.slice('--tests='.length).split(',') : selection.visible;
const env = { ...process.env, KNOWL_MUTATION_SERIAL: '1' };
if (!allTests) env.KNOWL_MUTATION_TESTS = chosen.join(',');
else delete env.KNOWL_MUTATION_TESTS;

console.log(`targets: ${targets.join(', ')}`);
console.log(`test set: ${allTests ? 'whole in-process suite' : `${chosen.length} file(s)${testsFlag ? ' (explicit)' : ' (importers)'}`}`);
console.log(`dist-spawning files excluded (blind to source mutation): ${selection.blind.length}`);

const started = Date.now();
const result = spawnSync(bin, ['run', configPath], { stdio: 'inherit', env, cwd: ROOT, shell: process.platform === 'win32' });
const elapsed = ((Date.now() - started) / 1000).toFixed(1);
console.log(`\nslice wall time: ${elapsed}s`);

const jsonPath = path.join(outDir, 'mutation.json');
if (existsSync(jsonPath)) {
  const report = JSON.parse(readFileSync(jsonPath, 'utf8'));
  const counts = {};
  for (const file of Object.values(report.files)) {
    for (const mutant of file.mutants) counts[mutant.status] = (counts[mutant.status] ?? 0) + 1;
  }
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  console.log(`mutants: ${total} ${JSON.stringify(counts)}`);
  console.log(`report: ${jsonPath}`);
}

process.exit(result.status ?? 1);
