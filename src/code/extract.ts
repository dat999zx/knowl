import crypto from 'node:crypto';
import path from 'node:path';
import Parser from 'tree-sitter';
import Go from 'tree-sitter-go';
import JavaScript from 'tree-sitter-javascript';
import Python from 'tree-sitter-python';
import TypeScript from 'tree-sitter-typescript';
import { CodeSymbol, CodeSymbolEdge, CodeSymbolKind } from '../core/types.js';

type SyntaxNode = Parser.SyntaxNode;
export type IndexedSymbol = CodeSymbol & { signatureHash: string | null };
export type Extracted = { symbols: IndexedSymbol[]; edges: CodeSymbolEdge[] };

export const hash = (value: string) => crypto.createHash('sha256').update(value).digest('hex');
const locator = (filePath: string, qualifiedName: string) => `symbol://${filePath}#${qualifiedName}`;
const lineRange = (node: SyntaxNode) => ({
  startLine: node.startPosition.row + 1,
  endLine: node.endPosition.row + (node.endPosition.column === 0 ? 0 : 1),
});
const summarize = (text: string) => text.replace(/\s+/g, ' ').trim().slice(0, 240) || null;
const signature = (node: SyntaxNode) => summarize(node.text.split('{', 1)[0]);
/**
 * Everything before the body: a brace inside a parameter type does not end a signature.
 *
 * Ends at the last token before the body rather than at the body itself, because a comment is an
 * extra and sits between the two. Python puts a block's start at its first *statement*, so
 * `def f():` followed by a `#` line has that comment outside the body and inside the header --
 * and a signature that moves when a body comment is edited is the exact false positive this
 * index exists to avoid. Go reaches the same `)` either way, the whitespace being trimmed.
 */
const headerSignature = (node: SyntaxNode, definition = node) => {
  const body = definition.childForFieldName('body');
  if (!body) return summarize(node.text);
  let last = body.previousSibling;
  while (last?.type === 'comment') last = last.previousSibling;
  return summarize(node.text.slice(0, (last?.endIndex ?? body.startIndex) - node.startIndex));
};

/**
 * How much source to hand tree-sitter per read.
 *
 * `Parser.parse` accepts a string, and handed one it copies the whole thing into a single
 * fixed buffer whose default is 32 KB -- past that the native binding throws a bare
 * `Error: Invalid argument` with no mention of size. `src/cli/program.ts` (110 KB),
 * `src/mcp/tools.ts` (93 KB), `src/store/{agent-query,portability,bootstrap}.ts` and
 * `src/transcripts/index-pass.ts` are all over it, so the six largest files in this repo were
 * the six the index could not see, and `knowl index-code` failed on the first one it reached.
 *
 * The callback form has no such ceiling: tree-sitter asks for the next slice and we answer one
 * chunk at a time, so the buffer never has to hold more than this. A size rather than a guess
 * at the file's own -- `{ bufferSize: text.length }` also works, but it makes the largest file
 * in the repo decide the allocation.
 */
const PARSE_CHUNK_BYTES = 16 * 1024;

function addSymbol(symbols: IndexedSymbol[], filePath: string, qualifiedName: string, kind: CodeSymbolKind, node: SyntaxNode, summary = signature(node)) {
  symbols.push({ locator: locator(filePath, qualifiedName), filePath, qualifiedName, kind, ...lineRange(node), signature: summary, signatureHash: summary ? hash(summary) : null });
}

function addImport(symbols: IndexedSymbol[], edges: CodeSymbolEdge[], filePath: string, source: string, node: SyntaxNode) {
  const name = `import:${source}`;
  addSymbol(symbols, filePath, name, 'import', node);
  edges.push({ fromLocator: locator(filePath, name), toLocator: `module://${source}`, kind: 'imports' });
}

const nameOf = (node: SyntaxNode) => node.childForFieldName('name')?.text ?? node.namedChildren.find(child => ['identifier', 'type_identifier', 'property_identifier'].includes(child.type))?.text;

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

function extractJavaScript(root: SyntaxNode, filePath: string, symbols: IndexedSymbol[], edges: CodeSymbolEdge[]) {
  for (const node of root.namedChildren) {
    if (node.type === 'import_statement') {
      const source = node.namedChildren.find(child => child.type === 'string')?.text.replace(/^['"]|['"]$/g, '');
      if (source) addImport(symbols, edges, filePath, source, node);
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
}

const unwrapDecorated = (node: SyntaxNode) => node.type === 'decorated_definition' ? node.childForFieldName('definition') ?? node : node;

const assignedNames = (left: SyntaxNode) =>
  left.type === 'identifier' ? [left.text] : left.type === 'pattern_list' ? left.namedChildren.filter(child => child.type === 'identifier').map(child => child.text) : [];

function collectPythonDefinition(symbols: IndexedSymbol[], filePath: string, node: SyntaxNode, prefix: string, memberKind: CodeSymbolKind) {
  // Decorators are part of the contract, so the header and range run from the first `@`.
  const definition = unwrapDecorated(node);
  const name = definition.childForFieldName('name')?.text;
  if (!name) return;
  const qualifiedName = prefix ? `${prefix}.${name}` : name;
  if (definition.type === 'function_definition') addSymbol(symbols, filePath, qualifiedName, memberKind, node, headerSignature(node, definition));
  if (definition.type !== 'class_definition') return;
  addSymbol(symbols, filePath, qualifiedName, 'class', node, headerSignature(node, definition));
  for (const member of definition.childForFieldName('body')?.namedChildren ?? []) {
    if (member.type === 'expression_statement') collectPythonAssignment(symbols, filePath, member, qualifiedName);
    else collectPythonDefinition(symbols, filePath, member, qualifiedName, 'method');
  }
}

function collectPythonAssignment(symbols: IndexedSymbol[], filePath: string, statement: SyntaxNode, prefix: string) {
  const assignment = statement.namedChildren.find(child => child.type === 'assignment');
  const left = assignment?.childForFieldName('left');
  if (!assignment || !left) return;
  for (const name of assignedNames(left)) addSymbol(symbols, filePath, prefix ? `${prefix}.${name}` : name, 'variable', assignment, summarize(assignment.text));
}

function extractPython(root: SyntaxNode, filePath: string, symbols: IndexedSymbol[], edges: CodeSymbolEdge[]) {
  for (const node of root.namedChildren) {
    if (node.type === 'import_statement') {
      for (const name of node.childrenForFieldName('name')) {
        const module = name.type === 'aliased_import' ? name.childForFieldName('name')?.text : name.text;
        if (module) addImport(symbols, edges, filePath, module, node);
      }
    } else if (node.type === 'import_from_statement') {
      const module = node.childForFieldName('module_name')?.text;
      if (module) addImport(symbols, edges, filePath, module, node);
    } else if (node.type === 'expression_statement') {
      collectPythonAssignment(symbols, filePath, node, '');
    } else {
      collectPythonDefinition(symbols, filePath, node, '', 'function');
    }
  }
}

/** The first type identifier is the base name: `*Pair[T]` yields `Pair` before `T`. */
const receiverType = (method: SyntaxNode) =>
  method.childForFieldName('receiver')?.namedChildren.find(child => child.type === 'parameter_declaration')?.childForFieldName('type')?.descendantsOfType('type_identifier')[0]?.text;

/** A grouped declaration's specs sit one list deeper; a function literal's locals are never reached. */
const specsOf = (declaration: SyntaxNode) =>
  declaration.namedChildren.flatMap(child => ['const_spec_list', 'var_spec_list'].includes(child.type) ? child.namedChildren : [child]).filter(child => ['const_spec', 'var_spec'].includes(child.type));

/** A struct or interface ends at its keyword, like a class at its brace; any other type is its whole spec. */
const typeSignature = (spec: SyntaxNode) => {
  const type = spec.childForFieldName('type');
  const keyword = type && ['struct_type', 'interface_type'].includes(type.type) ? type.children[0] : null;
  return summarize(keyword ? spec.text.slice(0, keyword.endIndex - spec.startIndex) : spec.text);
};

function extractGo(root: SyntaxNode, filePath: string, symbols: IndexedSymbol[], edges: CodeSymbolEdge[]) {
  for (const node of root.namedChildren) {
    if (node.type === 'import_declaration') {
      for (const spec of node.descendantsOfType('import_spec')) {
        const source = spec.childForFieldName('path')?.text.replace(/^["`]|["`]$/g, '');
        if (source) addImport(symbols, edges, filePath, source, spec);
      }
    } else if (node.type === 'function_declaration') {
      const name = node.childForFieldName('name')?.text;
      if (name) addSymbol(symbols, filePath, name, 'function', node, headerSignature(node));
    } else if (node.type === 'method_declaration') {
      const name = node.childForFieldName('name')?.text;
      const receiver = receiverType(node);
      if (name && receiver) addSymbol(symbols, filePath, `${receiver}.${name}`, 'method', node, headerSignature(node));
    } else if (node.type === 'type_declaration') {
      for (const spec of node.namedChildren.filter(child => ['type_spec', 'type_alias'].includes(child.type))) {
        const name = spec.childForFieldName('name')?.text;
        if (name) addSymbol(symbols, filePath, name, 'type', spec, typeSignature(spec));
      }
    } else if (node.type === 'const_declaration' || node.type === 'var_declaration') {
      for (const spec of specsOf(node)) {
        for (const name of spec.childrenForFieldName('name')) addSymbol(symbols, filePath, name.text, 'variable', spec, summarize(spec.text));
      }
    }
  }
}

/** One row per extension: the grammar that parses it, and the walk that reads the tree. */
const GRAMMARS: Record<string, { grammar: unknown; extract: (root: SyntaxNode, filePath: string, symbols: IndexedSymbol[], edges: CodeSymbolEdge[]) => void }> = {
  '.ts': { grammar: TypeScript.typescript, extract: extractJavaScript },
  '.tsx': { grammar: TypeScript.tsx, extract: extractJavaScript },
  '.js': { grammar: JavaScript, extract: extractJavaScript },
  '.jsx': { grammar: JavaScript, extract: extractJavaScript },
  '.py': { grammar: Python, extract: extractPython },
  '.go': { grammar: Go, extract: extractGo },
};

export const CODE_EXTENSIONS = new Set(Object.keys(GRAMMARS));

export function extractSymbols(filePath: string, text: string): Extracted {
  const language = GRAMMARS[path.extname(filePath)];
  if (!language) return { symbols: [], edges: [] };
  const parser = new Parser();
  parser.setLanguage(language.grammar);
  const symbols: IndexedSymbol[] = [];
  const edges: CodeSymbolEdge[] = [];
  const root = parser.parse(offset => text.slice(offset, offset + PARSE_CHUNK_BYTES)).rootNode;
  language.extract(root, filePath, symbols, edges);
  return { symbols: firstPerLocator(symbols), edges };
}

/**
 * One symbol per locator, keeping the first.
 *
 * `code_symbols.locator` is the primary key and the insert is a plain `INSERT`, so a file that
 * yields the same locator twice aborted the whole index with
 * `SQLITE_CONSTRAINT_PRIMARYKEY: UNIQUE constraint failed`. It is not a rare shape: an import
 * symbol is named after its module specifier, so `import type { A } from './x.js'` beside
 * `import { b } from './x.js'` is a collision, and ten files in this repo's own `src/` had one.
 * TypeScript overload sets collide the same way -- every signature declares the same name.
 *
 * Dropped here rather than with `INSERT OR IGNORE` because the duplicate is not a database
 * concern: two `import` statements for one module *are* one dependency, and the extractor is
 * where that is known. Doing it in SQL would also silently keep whichever row happened to be
 * inserted first, which is the same answer arrived at by accident.
 *
 * Edges need no matching pass: they address symbols by locator, so an edge that referred to a
 * dropped duplicate refers to the survivor by construction, and the edge insert is already
 * `INSERT OR IGNORE`.
 */
function firstPerLocator(symbols: IndexedSymbol[]): IndexedSymbol[] {
  const seen = new Set<string>();
  return symbols.filter(symbol => {
    if (seen.has(symbol.locator)) return false;
    seen.add(symbol.locator);
    return true;
  });
}
