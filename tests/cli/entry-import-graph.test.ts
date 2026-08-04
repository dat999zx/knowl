import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * K-41(b)(c): the hook path must not construct the whole CLI first.
 *
 * `agent-hook` is a fresh process per agent tool call -- hundreds a session -- and it is the
 * only Knowl command with that property. ESM static imports are evaluated before the
 * importing module's own body runs, so every top-level import in the process entry is paid
 * on every invocation regardless of what was asked for. With the command surface in the
 * entry that meant the MCP server, the viewer, the tree-sitter indexer, the config UI and
 * the AI pipeline were all loaded before commander looked at argv.
 *
 * This is a structural test, not a timing one: a wall-clock assertion on a machine running
 * seven agents in parallel measures the machine. What it guards is the property that made
 * the measurement move -- one static import of `./cli/program.js` put back into the entry
 * would restore the whole cost and no unit test elsewhere would notice.
 *
 * Measured on this machine, interleaved A/B of the two real bundles, 21 calls each, twice:
 * 410ms -> 269ms and 478ms -> 317ms per hook call, 34% both times. (Absolute values are
 * inflated by parallel load; the ratio is what held.)
 */

const ENTRY = path.resolve('src/index.ts');

/** Bare module specifiers the entry may load eagerly. Everything else must be dynamic. */
const ALLOWED_STATIC_IMPORTS = new Set(['dotenv']);

function staticImportSpecifiers(source: string): string[] {
  // Static `import ... from '<spec>'` and bare `import '<spec>'`, at the start of a line.
  const specifiers: string[] = [];
  for (const match of source.matchAll(/^import\s+(?:[^'"]*?\sfrom\s+)?['"]([^'"]+)['"]/gm)) {
    specifiers.push(match[1]);
  }
  return specifiers;
}

describe('the process entry', () => {
  it('statically imports nothing that the command surface drags in', async () => {
    const source = await fs.readFile(ENTRY, 'utf8');
    const eager = staticImportSpecifiers(source).filter(
      spec => !spec.startsWith('node:') && !ALLOWED_STATIC_IMPORTS.has(spec),
    );
    expect(eager).toEqual([]);
  });

  it('reaches the agent hook without loading the command surface', async () => {
    const source = await fs.readFile(ENTRY, 'utf8');
    expect(source).toMatch(/await import\(['"]\.\/cli\/agent-hook\.js['"]\)/);
    expect(source).toMatch(/await import\(['"]\.\/cli\/program\.js['"]\)/);
  });

  it('keeps the hook module off the command surface it is meant to skip', async () => {
    const source = await fs.readFile(path.resolve('src/cli/agent-hook.ts'), 'utf8');
    const eager = staticImportSpecifiers(source);
    expect(eager).not.toContain('./program.js');
    // The transcript catch-up reaches the embedding provider and only two of eight
    // normalized events can get there, so it stays behind its own branch.
    expect(eager).not.toContain('../transcripts/catch-up.js');
    expect(source).toMatch(/await import\(['"]\.\.\/transcripts\/catch-up\.js['"]\)/);
  });
});
