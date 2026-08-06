import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The dependency graph, enforced.
 *
 * `src/` was layered by accident rather than by rule, and the rule drifted: `store/` reached
 * up into `cli/` for a renderer, `core/` reached up into `transcripts/` for a feature flag,
 * and `store/` and `ai/` imported each other. None of it was caught, because nothing was
 * looking. This is what looks.
 *
 * A module may import from any layer strictly below its own, and from itself. Importing
 * sideways or upward fails here rather than in review.
 */
const LAYERS: string[][] = [
  // Types, primitives, and predicates over them. Depends on nothing.
  ['core'],
  // Persistence and the knowledge lifecycle.
  ['store'],
  // Direct consumers of the store that no other feature layer sits beneath.
  ['ai', 'workspace', 'skills', 'code'],
  // Feature layers built on the above.
  ['session', 'pipeline', 'transcripts', 'viewer'],
  // Entry points. Everything is allowed to be reached from here.
  ['cli', 'mcp'],
];

const LAYER_OF = new Map<string, number>(
  LAYERS.flatMap((modules, index) => modules.map(module => [module, index] as const)),
);

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../src');

/**
 * Value imports only — `import type` is erased by the compiler, so a type-only edge is not a
 * runtime dependency and cannot cause an initialization-order bug or a bundling cycle.
 *
 * The distinction is load-bearing rather than a loophole: `store -> cli` for `renderChangeCard`
 * was a real edge and was removed, while the four `store -> workspace` imports are plain data
 * shapes that vanish at compile time. Widening this to type imports would force those shapes
 * into `core/` and drag `WorkspaceManifest` and `EmbeddingIdentity` down with them, which
 * moves declarations away from the code that gives them meaning to satisfy a rule that runtime
 * does not care about.
 */
const VALUE_IMPORT = /^\s*import\s+(?!type\s)(?:[^'"]*?\s+from\s+)?['"](\.\.?\/[^'"]+)['"]/gm;

/** Static imports only. A dynamic `import()` is a deliberate deferral, not a static edge. */
async function valueImportsOf(file: string): Promise<string[]> {
  const source = await fs.readFile(file, 'utf-8');
  return [...source.matchAll(VALUE_IMPORT)].map(match => match[1]!);
}

async function sourceFiles(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const found = await Promise.all(entries.map(async entry => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return entry.name.endsWith('.ts') ? [full] : [];
  }));
  return found.flat();
}

/** The top-level `src/` directory a path belongs to, or null for a loose file like index.ts. */
function moduleOf(absolute: string): string | null {
  const relative = path.relative(SRC, absolute).replaceAll('\\', '/');
  const [head, ...rest] = relative.split('/');
  return rest.length > 0 ? head! : null;
}

type Edge = { from: string; to: string; file: string; specifier: string };

async function edges(): Promise<Edge[]> {
  const files = await sourceFiles(SRC);
  const collected: Edge[] = [];

  for (const file of files) {
    const from = moduleOf(file);
    if (!from) continue;

    for (const specifier of await valueImportsOf(file)) {
      const resolved = path.resolve(path.dirname(file), specifier);
      const to = moduleOf(resolved);
      if (!to || to === from) continue;
      collected.push({
        from, to, specifier,
        file: path.relative(SRC, file).replaceAll('\\', '/'),
      });
    }
  }
  return collected;
}

describe('module boundaries', () => {
  it('places every src/ directory in exactly one layer', async () => {
    // Otherwise a new directory is silently unchecked, which is the failure this file exists
    // to prevent: nothing was looking, so the rule drifted.
    const entries = await fs.readdir(SRC, { withFileTypes: true });
    const directories = entries.filter(entry => entry.isDirectory()).map(entry => entry.name);

    const unplaced = directories.filter(name => !LAYER_OF.has(name));
    expect(unplaced, `add these to LAYERS in this file: ${unplaced.join(', ')}`).toEqual([]);
  });

  it('never imports upward or sideways at runtime', async () => {
    const violations = (await edges())
      .filter(edge => {
        const from = LAYER_OF.get(edge.from);
        const to = LAYER_OF.get(edge.to);
        return from !== undefined && to !== undefined && to >= from;
      })
      .map(edge => `${edge.file} imports '${edge.specifier}' (${edge.from} -> ${edge.to})`);

    expect(violations, [
      'A module may only import from a layer strictly below its own.',
      'Either move the shared declaration down to where both sides can reach it,',
      'defer the import if it is genuinely optional, or move the module to its real layer.',
    ].join('\n')).toEqual([]);
  });

  it('leaves core depending on nothing', async () => {
    // The strongest single guarantee here, and the cheapest to state: if core is clean, no
    // cycle can pass through the bottom of the graph.
    const escaping = (await edges())
      .filter(edge => edge.from === 'core')
      .map(edge => `core/${edge.file} imports '${edge.specifier}'`);

    expect(escaping).toEqual([]);
  });

  it('detects a violation when one is introduced', async () => {
    // A guard that cannot fail is not a guard. This pins the detection itself, so a future
    // change to the regex or the resolver cannot quietly turn the checks above into no-ops.
    const probe = path.join(SRC, 'core', '__boundary-probe__.ts');
    await fs.writeFile(probe, "import { appendKnowledgeCommit } from '../store/repository.js';\n");

    try {
      const found = (await edges()).filter(edge => edge.file.includes('__boundary-probe__'));
      expect(found).toHaveLength(1);
      expect(found[0]).toMatchObject({ from: 'core', to: 'store' });
    } finally {
      await fs.rm(probe, { force: true });
    }
  });
});
