#!/usr/bin/env node
// The published tarball is built from package.json and resolved from package-lock.json. When
// the two disagree about the version, a release advertises one number and installs another --
// which 3.0.1 shipped with, unnoticed, because nothing looked.
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const lock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'));

const problems = [];
if (lock.version !== pkg.version) problems.push(`package-lock.json version is ${lock.version}, expected ${pkg.version}`);
if (lock.packages?.['']?.version !== pkg.version) {
  problems.push(`package-lock.json packages[""].version is ${lock.packages?.['']?.version}, expected ${pkg.version}`);
}

if (problems.length > 0) {
  console.error(`Lockfile version drift:\n  ${problems.join('\n  ')}\nRun: npm install --package-lock-only`);
  process.exit(1);
}
console.log(`Lockfile version matches package.json (${pkg.version}).`);
