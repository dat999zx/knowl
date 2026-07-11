import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { CODE_EXTENSIONS } from './languages.js';
import { getClient } from '../store/database.js';

export type CodeSymbol = { locator: string; filePath: string; qualifiedName: string; kind: string; startLine: number; endLine: number; signature: string | null };
const hash = (text: string) => crypto.createHash('sha256').update(text).digest('hex');
const line = (text: string, index: number) => text.slice(0, index).split('\n').length;

export async function indexCode(root: string): Promise<void> {
  const client = getClient();
  const files: string[] = [];
  async function walk(dir: string) { for (const entry of await fs.readdir(dir, { withFileTypes: true })) { if (['node_modules', '.git', '.knowl', 'dist'].includes(entry.name)) continue; const full = path.join(dir, entry.name); if (entry.isDirectory()) await walk(full); else if (CODE_EXTENSIONS.has(path.extname(entry.name))) files.push(full); } }
  await walk(root);
  for (const full of files) {
    const filePath = path.relative(root, full).replace(/\\/g, '/'); const text = await fs.readFile(full, 'utf8'); const contentHash = hash(text); const existing = await client.execute({ sql: 'SELECT content_hash FROM code_files WHERE path = ?', args: [filePath] });
    if (String(existing.rows[0]?.content_hash ?? '') === contentHash) continue;
    await client.execute({ sql: 'DELETE FROM code_symbols WHERE file_path = ?', args: [filePath] });
    await client.execute({ sql: 'INSERT OR REPLACE INTO code_files (path, content_hash, updated_at) VALUES (?, ?, ?)', args: [filePath, contentHash, new Date().toISOString()] });
    const classes = [...text.matchAll(/(?:export\s+)?class\s+(\w+)/g)];
    const symbols: CodeSymbol[] = [];
    for (const match of classes) symbols.push({ locator: `symbol://${filePath}#${match[1]}`, filePath, qualifiedName: match[1], kind: 'class', startLine: line(text, match.index!), endLine: line(text, match.index!) + 1, signature: match[0] });
    for (const match of text.matchAll(/(?:export\s+)?function\s+(\w+)\s*\(/g)) symbols.push({ locator: `symbol://${filePath}#${match[1]}`, filePath, qualifiedName: match[1], kind: 'function', startLine: line(text, match.index!), endLine: line(text, match.index!) + 1, signature: match[0] });
    for (const cls of classes) { const tail = text.slice(cls.index! + cls[0].length); for (const method of tail.matchAll(/^\s*(\w+)\s*\([^)]*\)\s*\{/gm)) { const pos = (cls.index! + cls[0].length) + method.index!; symbols.push({ locator: `symbol://${filePath}#${cls[1]}.${method[1]}`, filePath, qualifiedName: `${cls[1]}.${method[1]}`, kind: 'method', startLine: line(text, pos), endLine: line(text, pos) + 1, signature: method[0] }); } }
    for (const symbol of symbols) await client.execute({ sql: 'INSERT INTO code_symbols (locator, file_path, qualified_name, kind, start_line, end_line, signature) VALUES (?, ?, ?, ?, ?, ?, ?)', args: [symbol.locator, symbol.filePath, symbol.qualifiedName, symbol.kind, symbol.startLine, symbol.endLine, symbol.signature] });
  }
}

export async function listCodeSymbols(filePath: string): Promise<CodeSymbol[]> { const rows = await getClient().execute({ sql: 'SELECT locator, file_path, qualified_name, kind, start_line, end_line, signature FROM code_symbols WHERE file_path = ? ORDER BY start_line', args: [filePath] }); return rows.rows.map((row: any) => ({ locator: String(row.locator), filePath: String(row.file_path), qualifiedName: String(row.qualified_name), kind: String(row.kind), startLine: Number(row.start_line), endLine: Number(row.end_line), signature: row.signature ? String(row.signature) : null })); }
