import crypto from 'node:crypto';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import Parser from 'tree-sitter';
import { CodeSymbol, CodeSymbolEdge, CodeSymbolKind } from '../core/types.js';
import { CODE_EXTENSIONS, languageForExtension } from './languages.js';
import { getClient } from '../store/database.js';

type SyntaxNode = Parser.SyntaxNode;
type IndexedSymbol = CodeSymbol & { signatureHash: string | null };

const hash = (value: string) => crypto.createHash('sha256').update(value).digest('hex');
const locator = (filePath: string, qualifiedName: string) => `symbol://${filePath}#${qualifiedName}`;
const lineRange = (node: SyntaxNode) => ({
  startLine: node.startPosition.row + 1,
  endLine: node.endPosition.row + (node.endPosition.column === 0 ? 0 : 1),
});
const signature = (node: SyntaxNode) => node.text.split('{', 1)[0].replace(/\s+/g, ' ').trim().slice(0, 240) || null;
const nameOf = (node: SyntaxNode) => node.childForFieldName('name')?.text ?? node.namedChildren.find(child => ['identifier', 'type_identifier', 'property_identifier'].includes(child.type))?.text;

function ignored(root: string, file: string): boolean {
  if (!existsSync(path.join(root, '.git'))) return false;
  const relative = path.relative(root, file).replace(/\\/g, '/');
  const result = spawnSync('git', ['check-ignore', '-q', '--no-index', relative], { cwd: root, stdio: 'ignore' });
  return result.status === 0;
}

async function walkCodeFiles(root: string, directory = root): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    if (['.git', '.knowl', 'dist', 'node_modules'].includes(entry.name)) continue;
    const file = path.join(directory, entry.name);
    if (ignored(root, file)) continue;
    if (entry.isDirectory()) files.push(...await walkCodeFiles(root, file));
    else if (CODE_EXTENSIONS.has(path.extname(entry.name))) files.push(file);
  }
  return files;
}

function addSymbol(symbols: IndexedSymbol[], filePath: string, qualifiedName: string, kind: CodeSymbolKind, node: SyntaxNode) {
  const summary = signature(node);
  symbols.push({ locator: locator(filePath, qualifiedName), filePath, qualifiedName, kind, ...lineRange(node), signature: summary, signatureHash: summary ? hash(summary) : null });
}

function collectClassMembers(symbols: IndexedSymbol[], filePath: string, className: string, declaration: SyntaxNode) {
  const body = declaration.namedChildren.find(child => child.type === 'class_body');
  for (const member of body?.namedChildren ?? []) {
    if (!['method_definition', 'public_field_definition'].includes(member.type)) continue;
    const memberName = nameOf(member);
    if (memberName) addSymbol(symbols, filePath, `${className}.${memberName}`, 'method', member);
  }
}

function collectDeclaration(symbols: IndexedSymbol[], filePath: string, node: SyntaxNode): string | null {
  if (node.type === 'class_declaration') {
    const name = nameOf(node);
    if (!name) return null;
    addSymbol(symbols, filePath, name, 'class', node);
    collectClassMembers(symbols, filePath, name, node);
    return name;
  }
  if (node.type === 'function_declaration') {
    const name = nameOf(node);
    if (!name) return null;
    addSymbol(symbols, filePath, name, 'function', node);
    return name;
  }
  if (node.type === 'lexical_declaration' || node.type === 'variable_declaration') {
    for (const declarator of node.namedChildren.filter(child => child.type === 'variable_declarator')) {
      const name = nameOf(declarator);
      const value = declarator.childForFieldName('value');
      if (name && value?.type === 'arrow_function') {
        addSymbol(symbols, filePath, name, 'variable', declarator);
        return name;
      }
    }
  }
  return null;
}

function collectExportSpecifiers(symbols: IndexedSymbol[], edges: CodeSymbolEdge[], filePath: string, clause: SyntaxNode) {
  for (const specifier of clause.namedChildren.filter(child => child.type === 'export_specifier')) {
    const names = specifier.namedChildren.filter(child => ['identifier', 'type_identifier'].includes(child.type));
    const source = names[0]?.text;
    const exported = names.at(-1)?.text;
    if (!source || !exported) continue;
    addSymbol(symbols, filePath, `export:${exported}`, 'export', specifier);
    edges.push({ fromLocator: locator(filePath, `export:${exported}`), toLocator: locator(filePath, source), kind: 'exports' });
  }
}

function extractSymbols(filePath: string, text: string): { symbols: IndexedSymbol[]; edges: CodeSymbolEdge[] } {
  const parser = new Parser();
  const language = languageForExtension(path.extname(filePath));
  if (!language) return { symbols: [], edges: [] };
  parser.setLanguage(language);
  const symbols: IndexedSymbol[] = [];
  const edges: CodeSymbolEdge[] = [];
  const root = parser.parse(text).rootNode;

  for (const node of root.namedChildren) {
    if (node.type === 'import_statement') {
      const source = node.namedChildren.find(child => child.type === 'string')?.text.replace(/^['"]|['"]$/g, '');
      if (!source) continue;
      const name = `import:${source}`;
      addSymbol(symbols, filePath, name, 'import', node);
      edges.push({ fromLocator: locator(filePath, name), toLocator: `module://${source}`, kind: 'imports' });
      continue;
    }

    if (node.type === 'export_statement') {
      const declaration = node.namedChildren.find(child => ['class_declaration', 'function_declaration', 'lexical_declaration', 'variable_declaration'].includes(child.type));
      const exportedName = declaration ? collectDeclaration(symbols, filePath, declaration) : null;
      if (exportedName) {
        addSymbol(symbols, filePath, `export:${exportedName}`, 'export', node);
        edges.push({ fromLocator: locator(filePath, `export:${exportedName}`), toLocator: locator(filePath, exportedName), kind: 'exports' });
      }
      const clause = node.namedChildren.find(child => child.type === 'export_clause');
      if (clause) collectExportSpecifiers(symbols, edges, filePath, clause);
      continue;
    }

    collectDeclaration(symbols, filePath, node);
  }
  return { symbols, edges };
}

async function deleteIndexedFile(filePath: string) {
  const client = getClient();
  const rows = await client.execute({ sql: 'SELECT locator FROM code_symbols WHERE file_path = ?', args: [filePath] });
  for (const row of rows.rows) {
    await client.execute({ sql: 'DELETE FROM code_symbol_edges WHERE from_locator = ? OR to_locator = ?', args: [String(row.locator), String(row.locator)] });
  }
  await client.execute({ sql: 'DELETE FROM code_symbols WHERE file_path = ?', args: [filePath] });
  await client.execute({ sql: 'DELETE FROM code_files WHERE path = ?', args: [filePath] });
}

async function replaceIndexedFile(filePath: string, contentHash: string, extracted: ReturnType<typeof extractSymbols>) {
  const client = getClient();
  await deleteIndexedFile(filePath);
  await client.execute({ sql: 'INSERT INTO code_files (path, content_hash, updated_at) VALUES (?, ?, ?)', args: [filePath, contentHash, new Date().toISOString()] });
  for (const symbol of extracted.symbols) {
    await client.execute({ sql: 'INSERT INTO code_symbols (locator, file_path, qualified_name, kind, start_line, end_line, signature, signature_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', args: [symbol.locator, symbol.filePath, symbol.qualifiedName, symbol.kind, symbol.startLine, symbol.endLine, symbol.signature, symbol.signatureHash] });
  }
  for (const edge of extracted.edges) {
    await client.execute({ sql: 'INSERT OR IGNORE INTO code_symbol_edges (from_locator, to_locator, kind) VALUES (?, ?, ?)', args: [edge.fromLocator, edge.toLocator, edge.kind] });
  }
}

export async function indexCode(root: string): Promise<void> {
  const files = await walkCodeFiles(root);
  const paths = new Set(files.map(file => path.relative(root, file).replace(/\\/g, '/')));
  const client = getClient();
  const known = await client.execute('SELECT path FROM code_files');
  for (const row of known.rows) if (!paths.has(String(row.path))) await deleteIndexedFile(String(row.path));

  for (const fullPath of files) {
    const filePath = path.relative(root, fullPath).replace(/\\/g, '/');
    const text = await fs.readFile(fullPath, 'utf8');
    const contentHash = hash(text);
    const existing = await client.execute({ sql: 'SELECT content_hash FROM code_files WHERE path = ?', args: [filePath] });
    if (String(existing.rows[0]?.content_hash ?? '') === contentHash) continue;
    await replaceIndexedFile(filePath, contentHash, extractSymbols(filePath, text));
  }
}

export async function listCodeSymbols(filePath: string): Promise<CodeSymbol[]> {
  const rows = await getClient().execute({ sql: 'SELECT locator, file_path, qualified_name, kind, start_line, end_line, signature, signature_hash FROM code_symbols WHERE file_path = ? ORDER BY start_line, locator', args: [filePath] });
  return rows.rows.map(row => ({ locator: String(row.locator), filePath: String(row.file_path), qualifiedName: String(row.qualified_name), kind: String(row.kind) as CodeSymbolKind, startLine: Number(row.start_line), endLine: Number(row.end_line), signature: row.signature ? String(row.signature) : null, signatureHash: row.signature_hash ? String(row.signature_hash) : null }));
}

export async function listCodeSymbolEdges(filePath: string): Promise<CodeSymbolEdge[]> {
  const rows = await getClient().execute({ sql: 'SELECT from_locator, to_locator, kind FROM code_symbol_edges WHERE from_locator LIKE ? ORDER BY from_locator, to_locator', args: [`symbol://${filePath}#%`] });
  return rows.rows.map(row => ({ fromLocator: String(row.from_locator), toLocator: String(row.to_locator), kind: String(row.kind) as CodeSymbolEdge['kind'] }));
}
