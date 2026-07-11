import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, initDb } from '../../src/store/database.js';
import { indexCode, listCodeSymbols } from '../../src/code/symbol-index.js';
import { getClient } from '../../src/store/database.js';

const ROOT = path.resolve('./.knowl-symbol-index-test');

describe('symbol index', () => {
  beforeAll(async () => { await fs.rm(ROOT, { recursive: true, force: true }); await fs.mkdir(path.join(ROOT, 'src'), { recursive: true }); await fs.mkdir(path.join(ROOT, '.knowl'), { recursive: true }); await fs.writeFile(path.join(ROOT, 'src', 'auth.ts'), 'import { randomUUID } from "node:crypto";\nexport class Auth {\n  createToken() {\n    return randomUUID();\n  }\n}\nexport function login() {\n  return new Auth().createToken();\n}\nexport { Auth as TokenAuth };\n'); await initDb(ROOT); });
  afterAll(async () => { await closeDb(); await fs.rm(ROOT, { recursive: true, force: true }).catch(() => {}); });
  it('indexes TypeScript declarations, imports, exports, ranges, hashes, and edges', async () => {
    await indexCode(ROOT);
    const symbols = await listCodeSymbols('src/auth.ts');
    expect(symbols).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'class', locator: 'symbol://src/auth.ts#Auth', startLine: 2, endLine: 6 }),
      expect.objectContaining({ kind: 'method', locator: 'symbol://src/auth.ts#Auth.createToken', startLine: 3, endLine: 5 }),
      expect.objectContaining({ kind: 'function', locator: 'symbol://src/auth.ts#login', startLine: 7, endLine: 9 }),
      expect.objectContaining({ kind: 'import', locator: 'symbol://src/auth.ts#import:node:crypto' }),
      expect.objectContaining({ kind: 'export', locator: 'symbol://src/auth.ts#export:TokenAuth' }),
    ]));
    const client = getClient();
    const file = await client.execute({ sql: 'SELECT content_hash FROM code_files WHERE path = ?', args: ['src/auth.ts'] });
    const edges = await client.execute({ sql: 'SELECT kind FROM code_symbol_edges WHERE from_locator = ? ORDER BY kind', args: ['symbol://src/auth.ts#export:TokenAuth'] });
    expect(file.rows[0]?.content_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(edges.rows.map(row => row.kind)).toEqual(['exports']);
  });

  it('incrementally replaces changed symbols and removes deleted-file symbols and edges', async () => {
    await fs.writeFile(path.join(ROOT, 'src', 'auth.ts'), 'export function refreshToken() { return "ok"; }\n');
    await indexCode(ROOT);
    const changed = await listCodeSymbols('src/auth.ts');
    expect(changed).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'function', locator: 'symbol://src/auth.ts#refreshToken', startLine: 1, endLine: 1 }),
    ]));
    expect(changed).not.toEqual(expect.arrayContaining([expect.objectContaining({ locator: 'symbol://src/auth.ts#Auth' })]));
    await fs.rm(path.join(ROOT, 'src', 'auth.ts'));
    await indexCode(ROOT);
    expect(await listCodeSymbols('src/auth.ts')).toEqual([]);
    const edges = await getClient().execute({ sql: 'SELECT * FROM code_symbol_edges WHERE from_locator LIKE ?', args: ['symbol://src/auth.ts#%'] });
    expect(edges.rows).toEqual([]);
  });
});
