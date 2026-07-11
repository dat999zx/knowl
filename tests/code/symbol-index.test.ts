import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, initDb } from '../../src/store/database.js';
import { indexCode, listCodeSymbols } from '../../src/code/symbol-index.js';

const ROOT = path.resolve('./.knowl-symbol-index-test');

describe('symbol index', () => {
  beforeAll(async () => { await fs.rm(ROOT, { recursive: true, force: true }); await fs.mkdir(path.join(ROOT, 'src'), { recursive: true }); await fs.mkdir(path.join(ROOT, '.knowl'), { recursive: true }); await fs.writeFile(path.join(ROOT, 'src', 'auth.ts'), 'import { randomUUID } from "node:crypto";\nexport class Auth {\n  createToken() { return randomUUID(); }\n}\nexport function login() { return new Auth().createToken(); }\n'); await initDb(ROOT); });
  afterAll(async () => { await closeDb(); await fs.rm(ROOT, { recursive: true, force: true }).catch(() => {}); });
  it('indexes TypeScript functions, classes, methods, imports, and stable locators', async () => {
    await indexCode(ROOT);
    const symbols = await listCodeSymbols('src/auth.ts');
    expect(symbols).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'class', locator: 'symbol://src/auth.ts#Auth' }),
      expect.objectContaining({ kind: 'method', locator: 'symbol://src/auth.ts#Auth.createToken' }),
      expect.objectContaining({ kind: 'function', locator: 'symbol://src/auth.ts#login' }),
      expect.objectContaining({ kind: 'import', locator: 'symbol://src/auth.ts#import:node:crypto' }),
    ]));
  });
});
