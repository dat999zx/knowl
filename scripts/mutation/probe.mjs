#!/usr/bin/env node
/**
 * Confirm ONE mutation against a wide test scope, in a fresh process.
 *
 * Stage 1 (`run.mjs`) finds survivors cheaply, against a deliberately small test set. That
 * makes every survivor a *candidate*: some other suite might kill it. This is stage 2 -- it
 * applies a single mutation, runs the whole in-process suite once, and says killed or survived.
 *
 * A fresh vitest process per mutant is the point, not an accident. Stryker keeps one vitest
 * alive and re-runs the same files hundreds of times; measured on this repo that segfaults the
 * libSQL native addon (exit 0xC0000005) roughly every 1-2 minutes. One process, one mutant, one
 * exit sidesteps it entirely -- at the cost of a full startup per mutant, which is why this is
 * for a shortlist and `run.mjs` is for the sweep.
 *
 * Mutations are specified in a JSON file so a run is reproducible and reviewable:
 *   [{ "id": "kv-1", "file": "src/core/knowledge-validation.ts",
 *      "find": "value.length > maxFieldLength", "replace": "value.length >= maxFieldLength",
 *      "note": "boundary flip on the documented 20k ceiling" }]
 *
 * Usage: node scripts/mutation/probe.mjs .tmp/probes.json [--scope=tests/core/x.test.ts]
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const args = process.argv.slice(2);
const specPath = args.find((a) => !a.startsWith('--'));
const scopeFlag = args.find((a) => a.startsWith('--scope='));
const scope = scopeFlag ? scopeFlag.slice('--scope='.length) : '';
/**
 * `--tests=a,b,c` confirms against a chosen set instead of the whole in-process suite.
 *
 * Measured: a whole-suite confirmation costs ~335s per mutant, so a 25-mutant shortlist is over
 * two hours. A named confirmation set of the files that could plausibly kill the mutant costs a
 * fraction of that. Use the whole suite for the findings you intend to report; use a set to
 * triage down to them.
 */
const testsFlag = args.find((a) => a.startsWith('--tests='));

if (!specPath) {
  console.error('usage: probe.mjs <probes.json> [--scope=<test file>]');
  process.exit(2);
}

// eslint-disable-next-line no-control-regex
const stripAnsi = (text) => text.replace(/\[[0-9;]*m/g, '');

const probes = JSON.parse(readFileSync(specPath, 'utf8'));
const results = [];
const resultsPath = `${specPath}.results.json`;

/**
 * Restore on the way out, whatever happens.
 *
 * A probe leaves the working tree mutated for as long as vitest is running. If the harness dies
 * in that window -- and it did, once, silently -- the repo is left holding a mutation that looks
 * like a source edit, and the next command reports a phantom diff. `git checkout -- src/` is the
 * manual recovery; this is the automatic one.
 */
let inFlight = null;
const restoreInFlight = () => {
  if (!inFlight) return;
  writeFileSync(inFlight.file, inFlight.original);
  inFlight = null;
};
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) {
  process.on(signal, () => { restoreInFlight(); process.exit(130); });
}
process.on('exit', restoreInFlight);
process.on('uncaughtException', (error) => { restoreInFlight(); throw error; });

for (const probe of probes) {
  const file = path.join(ROOT, probe.file);
  const original = readFileSync(file, 'utf8');
  const occurrences = original.split(probe.find).length - 1;
  if (occurrences !== 1) {
    console.log(`${probe.id}: SKIPPED -- "find" matched ${occurrences} times, must match exactly once`);
    results.push({ ...probe, verdict: 'skipped', occurrences });
    continue;
  }

  writeFileSync(file, original.replace(probe.find, probe.replace));
  inFlight = { file, original };
  const started = Date.now();
  try {
    const run = spawnSync(
      process.execPath,
      [
        path.join('node_modules', 'vitest', 'vitest.mjs'),
        'run', '--config', 'vitest.mutation.config.ts', '--reporter=basic',
        ...(scope ? [scope] : []),
      ],
      {
        encoding: 'utf8',
        cwd: ROOT,
        env: { ...process.env, KNOWL_MUTATION_TESTS: testsFlag ? testsFlag.slice('--tests='.length) : '' },
        maxBuffer: 64 * 1024 * 1024,
      },
    );
    // The VERDICT COMES FROM THE EXIT CODE, not from reading the summary line.
    //
    // The first version of this matched /Tests\s+\d+ failed/ against the output. Vitest writes
    // that line with ANSI escapes between the label and the count, so `\s+` never matched and
    // the harness reported SURVIVED for every mutant including ones the suite demonstrably
    // kills -- an assertion that could not fail, which is the exact defect class this whole
    // exercise exists to find. `run.status` cannot lie about it: vitest exits non-zero if and
    // only if something failed. A signal or a spawn error is neither verdict and says so.
    const out = stripAnsi(`${run.stdout ?? ''}${run.stderr ?? ''}`);
    if (run.error || run.status === null) {
      console.log(`${probe.id}: ERROR -- runner did not exit cleanly (${run.error?.message ?? run.signal})`);
      results.push({ ...probe, verdict: 'error', detail: run.error?.message ?? run.signal });
      writeFileSync(resultsPath, JSON.stringify(results, null, 2));
      continue;
    }
    const verdict = run.status === 0 ? 'SURVIVED' : 'KILLED';
    const failures = [...out.matchAll(/(?:×|✗|FAIL)\s+(\S+\.test\.ts)/g)].map((m) => m[1]);
    const elapsed = ((Date.now() - started) / 1000).toFixed(0);
    console.log(`${probe.id}: ${verdict} (${elapsed}s) -- ${probe.note ?? ''}`);
    if (failures.length > 0) console.log(`    killed by: ${[...new Set(failures)].slice(0, 6).join(', ')}`);
    results.push({ ...probe, verdict, seconds: Number(elapsed), killedBy: [...new Set(failures)].slice(0, 10) });
    // Written after every probe, not at the end: a batch is tens of minutes long and a run
    // that dies at probe 9 should still have banked the first eight verdicts.
    writeFileSync(resultsPath, JSON.stringify(results, null, 2));
  } finally {
    writeFileSync(file, original);
    inFlight = null;
  }
}

writeFileSync(resultsPath, JSON.stringify(results, null, 2));
console.log(`\n${results.filter((r) => r.verdict === 'SURVIVED').length} of ${results.length} survived.`);

/**
 * A batch must contain at least one CONTROL: a mutation a named existing test already kills.
 *
 * Without one, "everything survived" is indistinguishable from "the harness never noticed a
 * failure" -- and that is not hypothetical here, it is what the first version of this file did
 * for a whole batch. A control that survives means the instrument is broken, so the run exits
 * non-zero and its findings are not to be believed.
 */
const controls = results.filter((r) => r.control);
if (controls.length === 0) {
  console.error('\nNO CONTROL in this batch. Add one probe with "control": true that an existing test kills.');
  process.exit(3);
}
const brokenControls = controls.filter((r) => r.verdict !== 'KILLED');
if (brokenControls.length > 0) {
  console.error(`\nCONTROL SURVIVED (${brokenControls.map((r) => r.id).join(', ')}) -- the harness is not detecting kills. Findings from this run are void.`);
  process.exit(4);
}
console.log(`control(s) ${controls.map((r) => r.id).join(', ')} killed as expected -- kill detection is working.`);
