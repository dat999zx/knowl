#!/usr/bin/env node
/**
 * Which test files could possibly kill a mutant in a given source file?
 *
 * Mutation testing costs one test run per mutant, so the single biggest lever is not running
 * tests that cannot observe the mutation. Two facts about this suite decide the answer:
 *
 * 1. 182 of the 207 test files import `../../src/...` directly, so a mutation in a source
 *    module is visible to exactly the tests that transitively import that module.
 * 2. 16 test files instead spawn the built CLI (`node dist/index.js`). `dist/` is produced by
 *    tsup from `src/`, and nothing rebuilds it between mutants -- so those files are
 *    STRUCTURALLY BLIND to source mutation. Running them costs time and can never kill
 *    anything. They are excluded, and that exclusion is a finding, not a shortcut.
 *
 * The graph is built from static `import`/`export ... from` specifiers. Dynamic `import()` of a
 * computed specifier is not followed -- it cannot be, statically -- so the selection is a lower
 * bound on the true cover set. A survivor found under this selection is therefore a *candidate*
 * hole that must be confirmed against the full suite before it is reported.
 *
 * Usage:
 *   node scripts/mutation/select-tests.mjs src/store/gc.ts [more.ts...]
 *   node scripts/mutation/select-tests.mjs --json src/store/gc.ts
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1'), '..', '..');

/** Every .ts file under a directory, repo-relative and posix-separated. */
function walk(dir, out = []) {
  for (const entry of readdirSync(path.join(ROOT, dir))) {
    const rel = `${dir}/${entry}`;
    if (statSync(path.join(ROOT, rel)).isDirectory()) walk(rel, out);
    else if (rel.endsWith('.ts')) out.push(rel);
  }
  return out;
}

const IMPORT_RE = /(?:^|\n)\s*(?:import|export)\s[^;]*?from\s*['"]([^'"]+)['"]/g;
const BARE_IMPORT_RE = /(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g;

/** Resolve a TS/ESM specifier (`./x.js`) to the repo-relative source file it means. */
function resolveSpecifier(fromFile, spec) {
  if (!spec.startsWith('.')) return null;
  const base = path.posix.join(path.posix.dirname(fromFile), spec);
  const candidates = [
    base.replace(/\.js$/, '.ts'),
    `${base}.ts`,
    `${base}/index.ts`,
    base,
  ];
  for (const candidate of candidates) {
    if (candidate.endsWith('.ts') && existsSync(path.join(ROOT, candidate))) return candidate;
  }
  return null;
}

function directImports(file) {
  const text = readFileSync(path.join(ROOT, file), 'utf8');
  const specs = new Set();
  for (const re of [IMPORT_RE, BARE_IMPORT_RE]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) specs.add(m[1]);
  }
  return [...specs].map((s) => resolveSpecifier(file, s)).filter(Boolean);
}

const sourceFiles = walk('src');
const testFiles = walk('tests');

const graph = new Map();
for (const file of [...sourceFiles, ...testFiles]) graph.set(file, directImports(file));

/** Test files that spawn the built CLI cannot see a source mutation. */
const SPAWNS_DIST = new Set(
  testFiles.filter((f) => readFileSync(path.join(ROOT, f), 'utf8').includes('dist/index.js')),
);

function transitiveImports(entry) {
  const seen = new Set();
  const stack = [entry];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const dep of graph.get(current) ?? []) {
      if (!seen.has(dep)) { seen.add(dep); stack.push(dep); }
    }
  }
  return seen;
}

const targets = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const asJson = process.argv.includes('--json');
if (targets.length === 0) {
  console.error('usage: select-tests.mjs [--json] <src/file.ts> ...');
  process.exit(2);
}

const normalized = targets.map((t) => t.replace(/\\/g, '/'));
const covering = testFiles.filter((test) => {
  const deps = transitiveImports(test);
  return normalized.some((t) => deps.has(t));
});
const visible = covering.filter((t) => !SPAWNS_DIST.has(t));
const blind = covering.filter((t) => SPAWNS_DIST.has(t));

if (asJson) {
  console.log(JSON.stringify({ targets: normalized, visible, blind }, null, 2));
} else {
  console.log(`# targets: ${normalized.join(', ')}`);
  console.log(`# ${visible.length} test files can see a source mutation; ${blind.length} spawn dist and cannot`);
  for (const t of visible) console.log(t);
  if (blind.length > 0) console.log(`# blind (dist-spawning): ${blind.join(' ')}`);
}
