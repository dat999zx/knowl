import path from 'node:path';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { afterAll, describe, expect, it } from 'vitest';
import { Scalar, YAMLSeq } from 'yaml';
import { mergeYamlDocument, packageRootDir, readYamlDocument } from '../../src/cli/agents/files.js';

const dirs: string[] = [];
const workspace = async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'knowl-yaml-'));
  dirs.push(dir);
  return dir;
};
afterAll(async () => { for (const dir of dirs) await rm(dir, { recursive: true, force: true }); });

describe('mergeYamlDocument', () => {
  it('creates the file when absent and reports configured', async () => {
    const file = path.join(await workspace(), 'config.yaml');
    const status = await mergeYamlDocument(file, doc => { doc.setIn(['mcp_servers', 'knowl', 'command'], 'knowl'); return true; });
    expect(status).toBe('configured');
    expect(await readFile(file, 'utf8')).toContain('knowl:\n    command: knowl');
  });

  it('keeps unrelated keys and comments, and reports updated', async () => {
    const file = path.join(await workspace(), 'config.yaml');
    await writeFile(file, '# my config\nmodel: gpt\nmcp_servers:\n  other:\n    command: other\n', 'utf8');
    const status = await mergeYamlDocument(file, doc => { doc.setIn(['mcp_servers', 'knowl', 'command'], 'knowl'); return true; });
    expect(status).toBe('updated');
    const text = await readFile(file, 'utf8');
    expect(text).toContain('# my config');
    expect(text).toContain('model: gpt');
    expect(text).toContain('other:\n    command: other');
    expect(text).toContain('knowl:\n    command: knowl');
  });

  it('keeps CRLF throughout when the file used CRLF', async () => {
    const file = path.join(await workspace(), 'config.yaml');
    await writeFile(file, '# top\r\nmodel: gpt\r\nmcp_servers:\r\n  other:\r\n    command: other\r\n', 'utf8');
    await mergeYamlDocument(file, doc => { doc.setIn(['mcp_servers', 'knowl', 'command'], 'knowl'); return true; });
    const text = await readFile(file, 'utf8');
    expect(text.split('\r\n').length - 1).toBe(text.split('\n').length - 1);
    expect(text).toContain('knowl:\r\n    command: knowl');
  });

  it('does not touch the file when mutate reports no change', async () => {
    const file = path.join(await workspace(), 'config.yaml');
    await writeFile(file, 'a: 1\n', 'utf8');
    expect(await mergeYamlDocument(file, () => false)).toBe('unchanged');
    expect(await readFile(file, 'utf8')).toBe('a: 1\n');
  });

  it('round-trips a !!js tagged scalar', async () => {
    const file = path.join(await workspace(), 'patch.yml');
    await writeFile(file, '- insert:\n    - id: x\n      config:\n        cwd: !!js process.cwd()\n', 'utf8');
    await mergeYamlDocument(file, doc => {
      const seq = doc.getIn([0, 'insert']) as YAMLSeq;
      const row = doc.createNode({ id: 'y', config: { cwd: 'process.cwd()' } });
      (row.getIn(['config', 'cwd'], true) as Scalar).tag = 'tag:yaml.org,2002:js';
      seq.add(row);
      return true;
    });
    const text = await readFile(file, 'utf8');
    expect(text.match(/cwd: !!js process\.cwd\(\)/g)).toHaveLength(2);
  });

  it('leaves a malformed file alone and throws', async () => {
    const file = path.join(await workspace(), 'bad.yaml');
    await writeFile(file, 'a: [unclosed\n', 'utf8');
    await expect(mergeYamlDocument(file, () => true)).rejects.toThrow();
    expect(await readFile(file, 'utf8')).toBe('a: [unclosed\n');
    await expect(readYamlDocument(file)).rejects.toThrow();
  });

  it('returns undefined for an absent document', async () => {
    expect(await readYamlDocument(path.join(await workspace(), 'nope.yaml'))).toBeUndefined();
  });
});

describe('packageRootDir', () => {
  it('names the directory that holds this package.json', async () => {
    const pkg = JSON.parse(await readFile(path.join(packageRootDir(), 'package.json'), 'utf8'));
    expect(pkg.name).toBe('@dat999zx/knowl');
  });
});
