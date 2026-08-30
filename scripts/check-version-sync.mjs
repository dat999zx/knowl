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
//   server.json                is what the official MCP registry reads, and it fails CLOSED in a
//                              way the others do not: the registry fetches the npm metadata for
//                              exactly the version named here and rejects the publish unless that
//                              tarball carries a matching `mcpName`. A stale number here is not a
//                              cosmetic drift, it is a publish that cannot succeed.
//
// A number that must be hand-maintained to stay honest eventually is not, so this checks instead
// of asking.
import { readFileSync } from 'node:fs';

const read = (rel) => JSON.parse(readFileSync(new URL(rel, import.meta.url), 'utf8'));
const pkg = read('../package.json');
const lock = read('../package-lock.json');
const plugin = read('../.claude-plugin/plugin.json');
const server = read('../server.json');

const problems = [];
if (lock.version !== pkg.version) problems.push(`package-lock.json version is ${lock.version}, expected ${pkg.version}`);
if (lock.packages?.['']?.version !== pkg.version) {
  problems.push(`package-lock.json packages[""].version is ${lock.packages?.['']?.version}, expected ${pkg.version}`);
}
if (plugin.version !== pkg.version) {
  problems.push(`.claude-plugin/plugin.json version is ${plugin.version}, expected ${pkg.version}`);
}

if (server.version !== pkg.version) {
  problems.push(`server.json version is ${server.version}, expected ${pkg.version}`);
}
const npmPackage = server.packages?.find((entry) => entry.registryType === 'npm');
if (npmPackage?.version !== pkg.version) {
  problems.push(`server.json npm package version is ${npmPackage?.version}, expected ${pkg.version}`);
}
// Two halves of one proof: the registry only accepts the publish when the name asserted here is
// the same string the published package carries. They are in different files, so nothing but this
// keeps them equal.
if (pkg.mcpName !== server.name) {
  problems.push(`package.json mcpName is ${pkg.mcpName}, expected ${server.name} (the name in server.json)`);
}

if (problems.length > 0) {
  console.error(`Version drift:\n  ${problems.join('\n  ')}\nRun: npm install --package-lock-only, and update .claude-plugin/plugin.json and server.json`);
  process.exit(1);
}
console.log(`package-lock.json, .claude-plugin/plugin.json and server.json all match package.json (${pkg.version}).`);
