#!/usr/bin/env node
// Every file that carries the version has to agree with package.json, because each one is a
// separate promise to a different consumer:
//
//   package-lock.json          resolves the published tarball. When the two disagreed, 3.0.1
//                              shipped advertising one number and installing another, unnoticed,
//                              because nothing looked.
//   .claude-plugin/plugin.json is what the Claude Code plugin directory reads. It was added at
//                              5.6.0 with the version written by hand and nothing keeping it in
//                              step, which is the same shape as the demo Dockerfile that sat
//                              pinned to 3.2.2 while users installed 5.5.0.
//
// A number that must be hand-maintained to stay honest eventually is not, so this checks instead
// of asking.
import { readFileSync } from 'node:fs';

const read = (rel) => JSON.parse(readFileSync(new URL(rel, import.meta.url), 'utf8'));
const pkg = read('../package.json');
const lock = read('../package-lock.json');
const plugin = read('../.claude-plugin/plugin.json');

const problems = [];
if (lock.version !== pkg.version) problems.push(`package-lock.json version is ${lock.version}, expected ${pkg.version}`);
if (lock.packages?.['']?.version !== pkg.version) {
  problems.push(`package-lock.json packages[""].version is ${lock.packages?.['']?.version}, expected ${pkg.version}`);
}
if (plugin.version !== pkg.version) {
  problems.push(`.claude-plugin/plugin.json version is ${plugin.version}, expected ${pkg.version}`);
}

if (problems.length > 0) {
  console.error(`Version drift:\n  ${problems.join('\n  ')}\nRun: npm install --package-lock-only, and update .claude-plugin/plugin.json`);
  process.exit(1);
}
console.log(`package-lock.json and .claude-plugin/plugin.json both match package.json (${pkg.version}).`);
