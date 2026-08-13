#!/usr/bin/env node
/**
 * Deprecate every version below 5.0.0, plus the broken 5.0.1.
 *
 * Deprecation is a message npm prints on install. It does not unpublish: existing installs keep
 * working, lockfiles still resolve, and `npm deprecate <pkg>@<version> ""` clears it again.
 *
 * Why these two sets, and not others:
 *
 *   - Everything below 5.0.0 predates a command surface that CHANGED WITHOUT ALIASES. `publish`,
 *     `login` and `logout` moved under `knowl cloud`, and removed names exit 1 with a signpost.
 *     Installing 4.x today gives you a CLI the current documentation does not describe.
 *   - 5.0.1 crashes. `knowl config set cloud.autoStage false` -- the feature that release was
 *     named for -- left `doctor` reporting `Cannot read properties of undefined (reading 'trim')`
 *     in any repository not connected to a cloud workspace. Fixed in 5.0.2.
 *
 * 5.0.0 is deliberately NOT deprecated: it works, and it is the version the 5.x notes describe.
 *
 * Dry run by default. Nothing is sent to the registry without --apply, because a deprecation is a
 * public statement about someone else's dependency.
 *
 *   node scripts/deprecate-legacy-versions.mjs            # show what would be sent
 *   node scripts/deprecate-legacy-versions.mjs --apply     # send it
 *   node scripts/deprecate-legacy-versions.mjs --undo --apply   # clear every message this set
 *
 * Requires `npm login` on this machine. The token CI publishes with is not available here.
 */
import { execFileSync } from 'node:child_process';

const PACKAGE = '@dat999zx/knowl';
const apply = process.argv.includes('--apply');
const undo = process.argv.includes('--undo');

const PRE_5_MESSAGE =
  'Pre-5.0 command surface; 5.0 moved the cloud verbs and removed several commands without aliases. '
  + 'Upgrade: npm i @dat999zx/knowl@latest';
const BROKEN_5_0_1 =
  'Broken: `knowl doctor` crashes after `knowl config set cloud.autoStage` in a repository that is '
  + 'not connected to a cloud workspace. Fixed in 5.0.2 — npm i @dat999zx/knowl@latest';

/** npm on Windows is a shim, so the executable name differs from the one on PATH elsewhere. */
const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function compareVersions(left, right) {
  const a = left.split('.').map(Number);
  const b = right.split('.').map(Number);
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

async function publishedVersions() {
  const response = await fetch(`https://registry.npmjs.org/${PACKAGE.replace('/', '%2F')}`);
  if (!response.ok) throw new Error(`registry returned ${response.status}`);
  const body = await response.json();
  return Object.keys(body.versions);
}

const versions = await publishedVersions();
const targets = [
  ...versions.filter(version => compareVersions(version, '5.0.0') < 0).sort(compareVersions)
    .map(version => ({ version, message: PRE_5_MESSAGE })),
  ...(versions.includes('5.0.1') ? [{ version: '5.0.1', message: BROKEN_5_0_1 }] : []),
];

console.log(`${targets.length} version(s) to ${undo ? 'un-deprecate' : 'deprecate'}:`);
for (const target of targets) console.log(`  ${PACKAGE}@${target.version}`);

// `exitCode` and fall through, never `process.exit`: this script has an open `fetch` connection,
// and exiting on top of one aborts with `UV_HANDLE_CLOSING` on Windows -- the same failure the
// cloud commands document in `src/cli/program.ts`. It printed a libuv assertion under a clean
// dry run, which reads as a broken script.
if (!apply) {
  console.log('\nDry run. Nothing was sent. Re-run with --apply to send it.');
  console.log('Requires `npm login` first — check with `npm whoami`.');
}

let failed = 0;
for (const target of apply ? targets : []) {
  const message = undo ? '' : target.message;
  try {
    // One call per version rather than a range: a range that matches nothing succeeds silently,
    // which would report a clean run over versions it never touched.
    execFileSync(NPM, ['deprecate', `${PACKAGE}@${target.version}`, message], { stdio: 'pipe' });
    console.log(`  ok   ${target.version}`);
  } catch (error) {
    failed += 1;
    console.error(`  FAIL ${target.version}: ${String(error.stderr ?? error.message).trim().split('\n').pop()}`);
  }
}

if (apply) {
  console.log(`\n${targets.length - failed} succeeded, ${failed} failed.`);
  process.exitCode = failed === 0 ? 0 : 1;
}
