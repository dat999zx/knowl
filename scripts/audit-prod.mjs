#!/usr/bin/env node
/**
 * `npm audit --omit=dev --audit-level=critical`, retried when the registry is unreachable.
 *
 * npm exits 1 for two unrelated reasons: it found vulnerabilities at or above the audit level,
 * and it could not reach the audit endpoint at all. The first is the gate doing its job. The
 * second is npm being down, and on 2026-09-04 it failed four CI runs in a row with
 * `503 Service Unavailable` from `/-/npm/v1/security/audits/quick` while flapping — one run in
 * the middle succeeded — burning seven minutes each time on npm's own internal retries.
 *
 * This retries ONLY the second case. A real finding fails on the first attempt with no retry,
 * and an outage that never clears still fails the build: the gate is not weakened, it just
 * stops going red when the service is merely flaky. Each attempt fails fast, because
 * `--fetch-retries=0` hands the backoff to this script where it can be seen in the log.
 */
import { spawnSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const ARGS = [
  'audit', '--omit=dev', '--audit-level=critical',
  '--fetch-retries=0', '--fetch-timeout=60000',
];
const BACKOFF_MS = [0, 5_000, 15_000, 30_000];

/**
 * Does this output mean "npm could not ask", rather than "npm answered and found something"?
 * Matched against the exact strings npm prints; anything else is treated as a real result, so
 * an unfamiliar failure fails the build rather than being retried into a pass.
 */
const UNREACHABLE = /audit endpoint returned an error|Service Unavailable|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|socket hang up|network|Gateway Time-?out/i;

let last = { status: 1, output: '' };

for (const [attempt, wait] of BACKOFF_MS.entries()) {
  if (wait) {
    console.log(`npm audit: registry unreachable, retrying in ${wait / 1000}s (attempt ${attempt + 1}/${BACKOFF_MS.length})`);
    await sleep(wait);
  }

  // `shell` on Windows only, and it is not optional there: node refuses to spawn a `.cmd`
  // without one (EINVAL), which is what `npm` resolves to. ARGS is a frozen literal, so the
  // unescaped-argument warning that flag carries has nothing to act on. CI is ubuntu, where
  // this is false and the warning never appears.
  const run = spawnSync('npm', ARGS, {
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });

  if (run.error) {
    console.error(`npm audit: could not run npm itself (${run.error.message}).`);
    process.exit(1);
  }

  const output = `${run.stdout ?? ''}${run.stderr ?? ''}`;
  process.stdout.write(output);

  if (run.status === 0) process.exit(0);

  last = { status: run.status ?? 1, output };
  if (!UNREACHABLE.test(output)) {
    // A real finding, or a failure this script does not understand. Either way it stands.
    process.exit(last.status);
  }
}

console.error(
  `\nnpm audit: the registry audit endpoint was unreachable on all ${BACKOFF_MS.length} attempts. ` +
  'This is npm, not this repository -- but the audit genuinely did not run, so the build fails. ' +
  'Re-run the job once https://status.npmjs.org reports the registry healthy.',
);
process.exit(last.status);
