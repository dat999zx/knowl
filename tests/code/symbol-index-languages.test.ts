import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, initDb } from '../../src/store/database.js';
import { indexCode, indexFile, listCodeSymbolEdges, listCodeSymbols } from '../../src/code/symbol-index.js';
import { getClient } from '../../src/store/database.js';

const ROOT = path.resolve('./.knowl-symbol-index-languages-test');

const PYTHON = [
  'import os',
  'import os.path as osp, sys',
  'from typing import List',
  'from ..pkg.mod import thing as alias',
  'from . import sibling',
  '',
  'MAX = 10',
  'a, b = 1, 2',
  'OPTIONS = {"retries": 3}',
  '',
  'def top(arg: int, *, kw: str = "x", opts={}) -> List[int]:',
  '    def inner(): pass',
  '    return []',
  '',
  '@dataclass',
  'class Service(Base):',
  '    field: int = 0',
  '    def method(self, y):',
  '        pass',
  '    @property',
  '    def prop(self): return 1',
  '    class Nested: pass',
  '',
  '@decorated',
  'async def deco_fn(): pass',
  '',
  'if True:',
  '    def conditional(): pass',
  '',
  'def commented(z):  # trailing',
  '    # a note before the first statement',
  '    return z',
].join('\n') + '\n';

const GO = [
  'package server',
  '',
  'import "fmt"',
  'import (',
  '    "context"',
  '    log "github.com/rs/zerolog/log"',
  ')',
  '',
  'const Max = 10',
  'var (',
  '    x, y int',
  '    Z = 3',
  ')',
  '',
  'type Server struct {',
  '    Addr string',
  '}',
  'type Alias = Server',
  'type Constrained[T interface{ M() }] struct{ a int }',
  'type (',
  '    Pair[T any] struct{ a, b T }',
  '    Fn func()',
  ')',
  '',
  'func New(addr string, done chan struct{}) *Server { return &Server{Addr: addr} }',
  'var Seen = map[string]struct{}{}',
  'var handler = func() { var local = 1; const inner = 2; _ = local }',
  'func (s *Server) Start(ctx context.Context) error { return nil }',
  'func (p Pair[T]) Get() T { return p.a }',
  'func (Server) Bare() {}',
  'func (/* named for symmetry */ s *Server) Commented() {}',
  'func init() {}',
].join('\n') + '\n';

describe('symbol index languages', () => {
  beforeAll(async () => {
    await fs.rm(ROOT, { recursive: true, force: true });
    await fs.mkdir(path.join(ROOT, 'src'), { recursive: true });
    await fs.mkdir(path.join(ROOT, '.knowl'), { recursive: true });
    await fs.mkdir(path.join(ROOT, '__pycache__'), { recursive: true });
    await fs.mkdir(path.join(ROOT, 'vendor', 'dep'), { recursive: true });
    await fs.writeFile(path.join(ROOT, 'src', 'service.py'), PYTHON);
    await fs.writeFile(path.join(ROOT, 'src', 'server.go'), GO);
    await fs.writeFile(path.join(ROOT, '__pycache__', 'service.py'), 'def cached(): pass\n');
    await fs.writeFile(path.join(ROOT, 'vendor', 'dep', 'dep.go'), 'package dep\nfunc Vendored() {}\n');
    await initDb(ROOT);
    await indexCode(ROOT);
  });
  afterAll(async () => { await closeDb(); await fs.rm(ROOT, { recursive: true, force: true }).catch(() => {}); });

  it('indexes Python definitions, class members, assignments and imports', async () => {
    const symbols = await listCodeSymbols('src/service.py');
    expect(symbols).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'import', locator: 'symbol://src/service.py#import:os' }),
      expect.objectContaining({ kind: 'import', locator: 'symbol://src/service.py#import:os.path' }),
      expect.objectContaining({ kind: 'import', locator: 'symbol://src/service.py#import:sys' }),
      expect.objectContaining({ kind: 'import', locator: 'symbol://src/service.py#import:typing' }),
      expect.objectContaining({ kind: 'import', locator: 'symbol://src/service.py#import:..pkg.mod' }),
      expect.objectContaining({ kind: 'import', locator: 'symbol://src/service.py#import:.' }),
      expect.objectContaining({ kind: 'variable', locator: 'symbol://src/service.py#MAX', signature: 'MAX = 10' }),
      expect.objectContaining({ kind: 'variable', locator: 'symbol://src/service.py#OPTIONS', signature: 'OPTIONS = {"retries": 3}' }),
      expect.objectContaining({ kind: 'variable', locator: 'symbol://src/service.py#a' }),
      expect.objectContaining({ kind: 'variable', locator: 'symbol://src/service.py#b' }),
      expect.objectContaining({ kind: 'function', locator: 'symbol://src/service.py#top', startLine: 11, endLine: 13, signature: 'def top(arg: int, *, kw: str = "x", opts={}) -> List[int]:' }),
      expect.objectContaining({ kind: 'class', locator: 'symbol://src/service.py#Service', startLine: 15, endLine: 22, signature: '@dataclass class Service(Base):' }),
      expect.objectContaining({ kind: 'variable', locator: 'symbol://src/service.py#Service.field' }),
      expect.objectContaining({ kind: 'method', locator: 'symbol://src/service.py#Service.method', signature: 'def method(self, y):' }),
      expect.objectContaining({ kind: 'method', locator: 'symbol://src/service.py#Service.prop', signature: '@property def prop(self):' }),
      expect.objectContaining({ kind: 'class', locator: 'symbol://src/service.py#Service.Nested' }),
      expect.objectContaining({ kind: 'function', locator: 'symbol://src/service.py#deco_fn', signature: '@decorated async def deco_fn():' }),
      expect.objectContaining({ kind: 'function', locator: 'symbol://src/service.py#commented', signature: 'def commented(z):' }),
    ]));
    const locators = symbols.map(symbol => symbol.locator);
    expect(locators).not.toContain('symbol://src/service.py#inner');
    expect(locators).not.toContain('symbol://src/service.py#conditional');
    expect(await listCodeSymbolEdges('src/service.py')).toEqual(expect.arrayContaining([
      { fromLocator: 'symbol://src/service.py#import:os.path', toLocator: 'module://os.path', kind: 'imports' },
      { fromLocator: 'symbol://src/service.py#import:..pkg.mod', toLocator: 'module://..pkg.mod', kind: 'imports' },
    ]));
  });

  it('indexes Go functions, receiver-qualified methods, types, values and imports', async () => {
    const symbols = await listCodeSymbols('src/server.go');
    expect(symbols).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'import', locator: 'symbol://src/server.go#import:fmt' }),
      expect.objectContaining({ kind: 'import', locator: 'symbol://src/server.go#import:context' }),
      expect.objectContaining({ kind: 'import', locator: 'symbol://src/server.go#import:github.com/rs/zerolog/log' }),
      expect.objectContaining({ kind: 'variable', locator: 'symbol://src/server.go#Max' }),
      expect.objectContaining({ kind: 'variable', locator: 'symbol://src/server.go#x' }),
      expect.objectContaining({ kind: 'variable', locator: 'symbol://src/server.go#y' }),
      expect.objectContaining({ kind: 'variable', locator: 'symbol://src/server.go#Z' }),
      expect.objectContaining({ kind: 'type', locator: 'symbol://src/server.go#Server', startLine: 15, endLine: 17, signature: 'Server struct' }),
      expect.objectContaining({ kind: 'type', locator: 'symbol://src/server.go#Alias', signature: 'Alias = Server' }),
      expect.objectContaining({ kind: 'type', locator: 'symbol://src/server.go#Pair', signature: 'Pair[T any] struct' }),
      expect.objectContaining({ kind: 'type', locator: 'symbol://src/server.go#Constrained', signature: 'Constrained[T interface{ M() }] struct' }),
      expect.objectContaining({ kind: 'type', locator: 'symbol://src/server.go#Fn', signature: 'Fn func()' }),
      expect.objectContaining({ kind: 'function', locator: 'symbol://src/server.go#New', signature: 'func New(addr string, done chan struct{}) *Server' }),
      expect.objectContaining({ kind: 'variable', locator: 'symbol://src/server.go#Max', signature: 'Max = 10' }),
      expect.objectContaining({ kind: 'variable', locator: 'symbol://src/server.go#Seen', signature: 'Seen = map[string]struct{}{}' }),
      expect.objectContaining({ kind: 'method', locator: 'symbol://src/server.go#Server.Start', signature: 'func (s *Server) Start(ctx context.Context) error' }),
      expect.objectContaining({ kind: 'method', locator: 'symbol://src/server.go#Pair.Get' }),
      expect.objectContaining({ kind: 'method', locator: 'symbol://src/server.go#Server.Bare', signature: 'func (Server) Bare()' }),
      expect.objectContaining({ kind: 'method', locator: 'symbol://src/server.go#Server.Commented' }),
      expect.objectContaining({ kind: 'function', locator: 'symbol://src/server.go#init' }),
    ]));
    const locators = symbols.map(symbol => symbol.locator);
    expect(locators).toContain('symbol://src/server.go#handler');
    expect(locators).not.toContain('symbol://src/server.go#local');
    expect(locators).not.toContain('symbol://src/server.go#inner');
    expect(await listCodeSymbolEdges('src/server.go')).toEqual(expect.arrayContaining([
      { fromLocator: 'symbol://src/server.go#import:github.com/rs/zerolog/log', toLocator: 'module://github.com/rs/zerolog/log', kind: 'imports' },
    ]));
  });

  it('never descends into __pycache__ or vendor', async () => {
    expect(await listCodeSymbols('__pycache__/service.py')).toEqual([]);
    expect(await listCodeSymbols('vendor/dep/dep.go')).toEqual([]);
  });

  it('indexes a file holding only a package clause as nothing, without failing', async () => {
    await fs.writeFile(path.join(ROOT, 'src', 'doc.go'), 'package server\n');
    await expect(indexFile(ROOT, 'src/doc.go')).resolves.toBeUndefined();
    expect(await listCodeSymbols('src/doc.go')).toEqual([]);
  });

  it('forgets rows an earlier version indexed under a directory the walk now refuses', async () => {
    await getClient().execute({ sql: 'INSERT INTO code_files (path, content_hash, updated_at) VALUES (?, ?, ?)', args: ['vendor/dep/dep.go', 'stale', '2026-01-01T00:00:00.000Z'] });
    await getClient().execute({ sql: 'INSERT INTO code_symbols (locator, file_path, qualified_name, kind, start_line, end_line, signature, signature_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', args: ['symbol://vendor/dep/dep.go#Vendored', 'vendor/dep/dep.go', 'Vendored', 'function', 2, 2, 'func Vendored()', 'stale'] });

    await indexFile(ROOT, 'vendor/dep/dep.go');

    expect(await listCodeSymbols('vendor/dep/dep.go')).toEqual([]);
    const files = await getClient().execute({ sql: 'SELECT path FROM code_files WHERE path = ?', args: ['vendor/dep/dep.go'] });
    expect(files.rows).toEqual([]);
  });

  it('leaves a Go struct hash alone when a field comment changes', async () => {
    const before = (await listCodeSymbols('src/server.go')).find(symbol => symbol.locator === 'symbol://src/server.go#Server');
    await fs.writeFile(path.join(ROOT, 'src', 'server.go'), GO.replace('    Addr string', '    // Addr is where the server listens.\n    Addr string'));
    await indexCode(ROOT);
    const after = (await listCodeSymbols('src/server.go')).find(symbol => symbol.locator === 'symbol://src/server.go#Server');
    expect(after?.signatureHash).toBe(before?.signatureHash);
  });

  it('leaves a Python signature hash alone when a comment inside the body changes', async () => {
    const before = (await listCodeSymbols('src/service.py')).find(symbol => symbol.locator === 'symbol://src/service.py#commented');
    await fs.writeFile(path.join(ROOT, 'src', 'service.py'), PYTHON.replace('# a note before the first statement', '# rewritten note'));
    await indexCode(ROOT);
    const after = (await listCodeSymbols('src/service.py')).find(symbol => symbol.locator === 'symbol://src/service.py#commented');
    expect(after?.signatureHash).toBe(before?.signatureHash);
  });

  it('moves a signature hash when a Go method signature changes and not when its body does', async () => {
    const before = (await listCodeSymbols('src/server.go')).find(symbol => symbol.locator === 'symbol://src/server.go#Server.Start');
    await fs.writeFile(path.join(ROOT, 'src', 'server.go'), GO.replace('{ return nil }', '{ return ctx.Err() }'));
    await indexCode(ROOT);
    const bodyEdit = (await listCodeSymbols('src/server.go')).find(symbol => symbol.locator === 'symbol://src/server.go#Server.Start');
    expect(bodyEdit?.signatureHash).toBe(before?.signatureHash);

    await fs.writeFile(path.join(ROOT, 'src', 'server.go'), GO.replace('Start(ctx context.Context) error', 'Start(ctx context.Context, port int) error'));
    await indexCode(ROOT);
    const signatureEdit = (await listCodeSymbols('src/server.go')).find(symbol => symbol.locator === 'symbol://src/server.go#Server.Start');
    expect(signatureEdit?.signatureHash).not.toBe(before?.signatureHash);
  });
});
