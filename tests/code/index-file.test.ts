import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, getClient, initDb } from '../../src/store/database.js';
import { indexCode, indexFile, listCodeSymbolEdges, listCodeSymbols } from '../../src/code/symbol-index.js';

const ROOT = path.resolve('./.knowl-index-file-test');
const AUTH = 'import { randomUUID } from "node:crypto";\nexport function createToken() {\n  return randomUUID();\n}\n';
const SESSION = 'import { createToken } from "./auth";\nexport const startSession = () => createToken();\n';

async function write(relativePath: string, text: string) {
  const target = path.join(ROOT, relativePath);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, text);
}

/**
 * Every indexed row except `updated_at`.
 *
 * `updated_at` is a wall-clock stamp written at insert time, so it is the one column that must
 * differ between two runs that are otherwise identical -- comparing it would fail the
 * equivalence check for the only reason that does not mean the two entry points disagree.
 */
async function indexSnapshot() {
  const client = getClient();
  const files = await client.execute('SELECT path, content_hash FROM code_files ORDER BY path');
  const symbols = await client.execute('SELECT locator, file_path, qualified_name, kind, start_line, end_line, signature, signature_hash FROM code_symbols ORDER BY locator');
  const edges = await client.execute('SELECT from_locator, to_locator, kind FROM code_symbol_edges ORDER BY from_locator, to_locator, kind');
  return {
    files: files.rows.map(row => ({ path: String(row.path), contentHash: String(row.content_hash) })),
    symbols: symbols.rows.map(row => ({ ...row })),
    edges: edges.rows.map(row => ({ from: String(row.from_locator), to: String(row.to_locator), kind: String(row.kind) })),
  };
}

const indexedPaths = async () => (await indexSnapshot()).files.map(file => file.path);

describe('single-file code index', () => {
  beforeAll(async () => {
    await fs.rm(ROOT, { recursive: true, force: true });
    await fs.mkdir(path.join(ROOT, '.knowl'), { recursive: true });
    // A real repository, not a `.git` placeholder: `ignored()` shells out to `git check-ignore`,
    // which refuses outside a work tree, and a refusal reads as "not ignored" -- so the gitignore
    // case below would pass without the rule ever being consulted.
    execSync('git init', { cwd: ROOT, stdio: 'ignore' });
    await write('.gitignore', 'generated/\n');
    await write('src/auth.ts', AUTH);
    await initDb(ROOT);
  });
  afterAll(async () => { await closeDb(); await fs.rm(ROOT, { recursive: true, force: true }).catch(() => {}); });

  it('indexes one file, its symbols and its edges, and touches no other path', async () => {
    await write('src/session.ts', SESSION);

    await indexFile(ROOT, 'src/auth.ts');

    expect(await listCodeSymbols('src/auth.ts')).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'function', locator: 'symbol://src/auth.ts#createToken', startLine: 2, endLine: 4 }),
      expect.objectContaining({ kind: 'import', locator: 'symbol://src/auth.ts#import:node:crypto' }),
      expect.objectContaining({ kind: 'export', locator: 'symbol://src/auth.ts#export:createToken' }),
    ]));
    expect(await listCodeSymbolEdges('src/auth.ts')).toEqual(expect.arrayContaining([
      { fromLocator: 'symbol://src/auth.ts#import:node:crypto', toLocator: 'module://node:crypto', kind: 'imports' },
      { fromLocator: 'symbol://src/auth.ts#export:createToken', toLocator: 'symbol://src/auth.ts#createToken', kind: 'exports' },
    ]));
    // The sibling exists on disk and is a code file: if this entry point still walked, it would
    // be here too. That absence is the whole point of the export.
    expect(await indexedPaths()).toEqual(['src/auth.ts']);
  });

  it('rewrites nothing when the content hash is unchanged', async () => {
    // A sentinel rather than a timestamp comparison: `replaceIndexedFile` deletes and re-inserts
    // the row, so a re-index cannot preserve a value the extractor never produces. Two calls
    // inside the same millisecond would make an `updated_at` check pass either way.
    await getClient().execute({ sql: 'UPDATE code_symbols SET signature = ? WHERE locator = ?', args: ['sentinel', 'symbol://src/auth.ts#createToken'] });

    await indexFile(ROOT, 'src/auth.ts');

    const symbol = (await listCodeSymbols('src/auth.ts')).find(row => row.locator === 'symbol://src/auth.ts#createToken');
    expect(symbol?.signature).toBe('sentinel');
  });

  it('replaces the symbols and edges of an edited file', async () => {
    await write('src/auth.ts', 'export function createAccessToken() { return "token"; }\n');

    await indexFile(ROOT, 'src/auth.ts');

    const locators = (await listCodeSymbols('src/auth.ts')).map(symbol => symbol.locator);
    expect(locators).toContain('symbol://src/auth.ts#createAccessToken');
    expect(locators).not.toContain('symbol://src/auth.ts#createToken');
    // The import went away with the edit, so its edge must have gone with it -- a stale edge is
    // how a reference walk reaches a symbol that no longer exists.
    expect(await listCodeSymbolEdges('src/auth.ts')).toEqual([
      { fromLocator: 'symbol://src/auth.ts#export:createAccessToken', toLocator: 'symbol://src/auth.ts#createAccessToken', kind: 'exports' },
    ]);
  });

  it('removes a deleted file from the index, and stays quiet on a path it never held', async () => {
    await fs.rm(path.join(ROOT, 'src', 'auth.ts'));

    await indexFile(ROOT, 'src/auth.ts');
    await expect(indexFile(ROOT, 'src/never-existed.ts')).resolves.toBeUndefined();

    expect(await listCodeSymbols('src/auth.ts')).toEqual([]);
    expect(await listCodeSymbolEdges('src/auth.ts')).toEqual([]);
    expect(await indexedPaths()).toEqual([]);
  });

  it('is a no-op for anything the full walk would not have indexed', async () => {
    // Each of these exists on disk, so a missing file cannot be why it stays out of the index.
    await write('docs/notes.md', '# notes\n');
    await write('node_modules/pkg/index.js', 'export function vendored() { return 1; }\n');
    await write('generated/api.ts', 'export function generated() { return 1; }\n');
    expect(existsSync(path.join(ROOT, '.git'))).toBe(true);

    await indexFile(ROOT, 'docs/notes.md');
    await indexFile(ROOT, 'node_modules/pkg/index.js');
    await indexFile(ROOT, 'generated/api.ts');
    await indexFile(ROOT, 'src');
    // A real `.ts` file that is simply not in this repository: it would index cleanly under a
    // `../`-prefixed locator if the root check were missing.
    await indexFile(ROOT, path.join(ROOT, '..', 'src', 'code', 'symbol-index.ts'));

    expect(await indexedPaths()).toEqual([]);
  });

  it('reaches the same rows as the full pass, one file at a time', async () => {
    await write('src/auth.ts', AUTH);
    await indexCode(ROOT);
    const fullPass = await indexSnapshot();
    // The full pass agrees with the previous test about what is eligible: the markdown file, the
    // vendored file and the gitignored file are all still on disk and still absent.
    expect(fullPass.files.map(file => file.path)).toEqual(['src/auth.ts', 'src/session.ts']);

    const client = getClient();
    for (const table of ['code_symbol_edges', 'code_symbols', 'code_files']) await client.execute(`DELETE FROM ${table}`);
    await indexFile(ROOT, 'src/auth.ts');
    // Absolute, because host hooks report absolute paths: both forms have to land on one key.
    await indexFile(ROOT, path.join(ROOT, 'src', 'session.ts'));

    expect(await indexSnapshot()).toEqual(fullPass);

    // And the full pass still reconciles a deletion it was not told about, which is the one job
    // the per-file entry point cannot do.
    await fs.rm(path.join(ROOT, 'src', 'session.ts'));
    await indexCode(ROOT);
    expect(await indexedPaths()).toEqual(['src/auth.ts']);
  });
});
