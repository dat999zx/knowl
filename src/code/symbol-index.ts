import crypto from 'node:crypto';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import Parser from 'tree-sitter';
import { CodeSymbol, CodeSymbolEdge, CodeSymbolKind } from '../core/types.js';
import { CODE_EXTENSIONS, languageForExtension } from './languages.js';
import { getClient, withClientTransaction } from '../store/database.js';

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

/**
 * Directory names the index never descends into, at any depth.
 *
 * Named rather than inlined because there are now two entry points -- the full walk and
 * `indexFile` -- and the incremental one has to refuse exactly what the walk refuses. Two copies
 * of this list drift, and the drift is invisible: the walk would keep skipping `dist/`, a
 * write-triggered `indexFile('dist/bundle.js')` would happily index it, and the store would hold
 * symbols the full pass then deletes on its next run. One list, one answer.
 */
const EXCLUDED_DIRECTORIES = new Set(['.git', '.knowl', 'dist', 'node_modules']);

function ignored(root: string, file: string): boolean {
  if (!existsSync(path.join(root, '.git'))) return false;
  const relative = path.relative(root, file).replace(/\\/g, '/');
  const result = spawnSync('git', ['check-ignore', '-q', '--no-index', relative], { cwd: root, stdio: 'ignore' });
  return result.status === 0;
}

/** Repo-relative and forward-slashed: the one form `code_files.path` and every locator use. */
function relativeCodePath(root: string, file: string): string {
  return path.relative(root, path.resolve(root, file)).replace(/\\/g, '/');
}

async function walkCodeFiles(root: string, directory = root): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    if (EXCLUDED_DIRECTORIES.has(entry.name)) continue;
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

/** The rows for one file, with no transaction of its own: every caller is already inside one. */
async function deleteIndexedFileRows(filePath: string) {
  const client = getClient();
  const rows = await client.execute({ sql: 'SELECT locator FROM code_symbols WHERE file_path = ?', args: [filePath] });
  for (const row of rows.rows) {
    await client.execute({ sql: 'DELETE FROM code_symbol_edges WHERE from_locator = ? OR to_locator = ?', args: [String(row.locator), String(row.locator)] });
  }
  await client.execute({ sql: 'DELETE FROM code_symbols WHERE file_path = ?', args: [filePath] });
  await client.execute({ sql: 'DELETE FROM code_files WHERE path = ?', args: [filePath] });
}

async function replaceIndexedFileRows(filePath: string, contentHash: string, extracted: ReturnType<typeof extractSymbols>) {
  const client = getClient();
  await deleteIndexedFileRows(filePath);
  await client.execute({ sql: 'INSERT INTO code_files (path, content_hash, updated_at) VALUES (?, ?, ?)', args: [filePath, contentHash, new Date().toISOString()] });
  for (const symbol of extracted.symbols) {
    await client.execute({ sql: 'INSERT INTO code_symbols (locator, file_path, qualified_name, kind, start_line, end_line, signature, signature_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', args: [symbol.locator, symbol.filePath, symbol.qualifiedName, symbol.kind, symbol.startLine, symbol.endLine, symbol.signature, symbol.signatureHash] });
  }
  for (const edge of extracted.edges) {
    await client.execute({ sql: 'INSERT OR IGNORE INTO code_symbol_edges (from_locator, to_locator, kind) VALUES (?, ?, ?)', args: [edge.fromLocator, edge.toLocator, edge.kind] });
  }
}

/**
 * Both writes above rewrite one file's rows in one transaction -- and the unit is the file, not
 * the pass.
 *
 * Every statement above used to be its own implicit transaction. Indexing a file with 30 symbols
 * and 10 edges is 41 writes the first time and 73 on a re-index (the delete pass issues one
 * statement per symbol already stored), so recording one edit cost that many commits. At the
 * `synchronous = NORMAL` this schema runs, the measurement at `bootstrap.ts:33-37` puts un-batched
 * writes at 0.832 ms/row against 0.241 batched -- so a re-index sheds roughly 61 ms of commit
 * overhead for 18 ms, ~3.5x. The larger 132x figure recorded in `vector.ts:148` was measured at
 * `synchronous = FULL`, where every commit also fsynced the WAL; quoting it for this path would
 * overstate the win, and the win does not need overstating.
 *
 * Atomicity is the part that actually matters for a write-triggered re-index. `replaceIndexedFile`
 * is a delete followed by inserts, so un-transacted it has a window in which the file's symbols
 * are gone and the new ones are not yet there -- and the reader that would land in that window is
 * exactly the staleness check this index exists to serve, which would read "symbol deleted" and
 * report a false change.
 *
 * NOT one transaction around the whole repo pass, for two reasons. A transaction holds the single
 * write lock for its whole life, and a full pass interleaves tree-sitter parses and file reads
 * between its statements -- so a repo-wide transaction would lock out `serve`, the hooks and the
 * CLI for the length of the walk, against a 10 s `busy_timeout` (`bootstrap.ts:24`). And
 * `withClientTransaction` serialises on one process-wide queue, so holding it for a pass stalls
 * every unrelated write behind it. The obvious objection -- that many small transactions hit the
 * driver ceiling -- does not apply here: that ceiling is on the *count of `db.transaction()`
 * calls* (800-1000), and this helper issues raw `BEGIN`/`COMMIT`, the shape measured clean at
 * 1200 in the table at `database.ts:143`.
 */
async function deleteIndexedFile(filePath: string) {
  await withClientTransaction(() => deleteIndexedFileRows(filePath));
}

async function replaceIndexedFile(filePath: string, contentHash: string, extracted: ReturnType<typeof extractSymbols>) {
  await withClientTransaction(() => replaceIndexedFileRows(filePath, contentHash, extracted));
}

/**
 * Index one file that is already known to be eligible, at the path it is already known to sit at.
 *
 * The single body both entry points run, so the incremental and full passes cannot disagree about
 * what "indexed" means -- the content-hash skip, the extraction and the replace exist once. What
 * `indexFile` adds on top is only the eligibility test that the walk performs for the full pass.
 */
async function indexEligibleFile(filePath: string, fullPath: string): Promise<void> {
  const text = await fs.readFile(fullPath, 'utf8');
  const contentHash = hash(text);
  const existing = await getClient().execute({ sql: 'SELECT content_hash FROM code_files WHERE path = ?', args: [filePath] });
  if (String(existing.rows[0]?.content_hash ?? '') === contentHash) return;
  await replaceIndexedFile(filePath, contentHash, extractSymbols(filePath, text));
}

/** Drop a path from the index, without opening a write transaction for one it never held. */
async function forgetIndexedFile(filePath: string): Promise<void> {
  // A write-tool trigger fires on every deleted path, and almost none of them are indexed:
  // build output, scratch files, a `.md` note. Skipping the transaction on a miss keeps those
  // off the write lock and out of the transaction queue entirely.
  const known = await getClient().execute({ sql: 'SELECT 1 FROM code_files WHERE path = ? LIMIT 1', args: [filePath] });
  if (known.rows.length === 0) return;
  await deleteIndexedFile(filePath);
}

/**
 * Index exactly one file -- the entry point a "re-index what just changed" trigger can call.
 *
 * `indexCode` walks and re-hashes the entire repo on every call, which is the right shape for a
 * session boundary and the wrong one for a tool event: its content-hash check skips the re-parse
 * and the write, never the walk or the reads, so a one-file change still costs a full traversal
 * plus a `git check-ignore` spawn per entry.
 *
 * `filePath` may be repo-relative or absolute, because the callers this exists for -- host hooks
 * -- report absolute paths and normalising in each of them is how the two forms end up in
 * `code_files` under different keys.
 *
 * Everything ineligible returns quietly rather than throwing: a trigger hands this whatever path a
 * tool touched, so a `.md` file, a directory, `node_modules/`, a gitignored artifact and a path
 * outside the repo are all ordinary traffic, not caller errors. A throw here would surface as a
 * failed hook on an event that was never ours to act on. The one non-quiet case is a path that
 * has gone from disk: that is a real index update, so its rows are removed.
 *
 * A gitignored path is a no-op even if the index somehow holds it -- the full pass's
 * reconciliation already deletes anything the walk no longer yields, so the cleanup exists and
 * does not need a second, contradictory implementation on the hot path.
 *
 * Opens its own transaction, so it must not be called from inside one (`withClientTransaction`
 * refuses to nest).
 */
export async function indexFile(root: string, filePath: string): Promise<void> {
  const relativePath = relativeCodePath(root, filePath);
  // `path.relative` answers `..`-prefixed for a path above the root, and on Windows an absolute
  // path for one on another drive. Either way it is not in this repo and has no locator here.
  if (!relativePath || relativePath === '..' || relativePath.startsWith('../') || path.isAbsolute(relativePath)) return;
  if (relativePath.split('/').some(segment => EXCLUDED_DIRECTORIES.has(segment))) return;
  if (!CODE_EXTENSIONS.has(path.extname(relativePath))) return;

  // Deletion is decided before the ignore test on purpose: `ignored` spawns a `git` process, and
  // a path that is gone needs no rule to tell us it should not be in the index.
  const fullPath = path.join(root, relativePath);
  const stats = await fs.stat(fullPath).catch(() => null);
  if (!stats?.isFile()) return forgetIndexedFile(relativePath);
  if (ignored(root, fullPath)) return;

  await indexEligibleFile(relativePath, fullPath);
}

export async function indexCode(root: string): Promise<void> {
  const files = await walkCodeFiles(root);
  const paths = new Set(files.map(file => relativeCodePath(root, file)));
  const known = await getClient().execute('SELECT path FROM code_files');
  for (const row of known.rows) if (!paths.has(String(row.path))) await deleteIndexedFile(String(row.path));

  // Straight to the shared body rather than through `indexFile`: the walk has already applied the
  // exclusions, the ignore rules and the extension filter to every entry it returned, and routing
  // back through the public entry point would re-run `git check-ignore` -- one process spawn per
  // file, over the whole repo -- to re-derive an answer this loop already has.
  for (const fullPath of files) await indexEligibleFile(relativeCodePath(root, fullPath), fullPath);
}

export async function listCodeSymbols(filePath: string): Promise<CodeSymbol[]> {
  const rows = await getClient().execute({ sql: 'SELECT locator, file_path, qualified_name, kind, start_line, end_line, signature, signature_hash FROM code_symbols WHERE file_path = ? ORDER BY start_line, locator', args: [filePath] });
  return rows.rows.map(row => ({ locator: String(row.locator), filePath: String(row.file_path), qualifiedName: String(row.qualified_name), kind: String(row.kind) as CodeSymbolKind, startLine: Number(row.start_line), endLine: Number(row.end_line), signature: row.signature ? String(row.signature) : null, signatureHash: row.signature_hash ? String(row.signature_hash) : null }));
}

export async function listCodeSymbolEdges(filePath: string): Promise<CodeSymbolEdge[]> {
  const rows = await getClient().execute({ sql: 'SELECT from_locator, to_locator, kind FROM code_symbol_edges WHERE from_locator LIKE ? ORDER BY from_locator, to_locator', args: [`symbol://${filePath}#%`] });
  return rows.rows.map(row => ({ fromLocator: String(row.from_locator), toLocator: String(row.to_locator), kind: String(row.kind) as CodeSymbolEdge['kind'] }));
}
