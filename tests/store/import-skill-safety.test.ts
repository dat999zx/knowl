import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, initDb } from '../../src/store/database.js';
import { importKnowledge } from '../../src/store/portability.js';

const TEST_ROOT = path.resolve('./.knowl-import-skill-safety-test');
const HEADER = { type: 'header', format: 'knowl-jsonl', version: 2, namespace: 'project' };

async function writeStream(name: string, records: unknown[]): Promise<string> {
  const body = `${records.map(record => JSON.stringify(record)).join('\n')}\n`;
  const sha256 = crypto.createHash('sha256').update(body).digest('hex');
  const streamPath = path.join(TEST_ROOT, name);
  await fs.writeFile(streamPath, `${body}${JSON.stringify({ type: 'manifest', sha256 })}\n`, 'utf8');
  return streamPath;
}

describe('imported skill package safety', () => {
  beforeAll(async () => {
    await fs.rm(TEST_ROOT, { recursive: true, force: true }).catch(() => {});
    await fs.mkdir(path.join(TEST_ROOT, '.knowl'), { recursive: true });
    await initDb(TEST_ROOT);
  });

  afterAll(async () => {
    await closeDb();
    await fs.rm(TEST_ROOT, { recursive: true, force: true }).catch(() => {});
  });

  it('rejects a skill name that escapes the skills directory', async () => {
    const streamPath = await writeStream('traversal-name.jsonl', [
      HEADER,
      { type: 'skill_package', name: '../../escape', files: [{ path: 'proof.txt', content: 'escaped' }] },
    ]);
    await expect(importKnowledge(streamPath, { projectRoot: TEST_ROOT })).rejects.toThrow(/skill name/i);
    await expect(fs.access(path.join(TEST_ROOT, 'escape', 'proof.txt'))).rejects.toThrow();
    await expect(fs.access(path.join(TEST_ROOT, '..', 'escape', 'proof.txt'))).rejects.toThrow();
  });

  it('rejects a skill file path that escapes its own package', async () => {
    const streamPath = await writeStream('traversal-file.jsonl', [
      HEADER,
      { type: 'skill_package', name: 'legit', files: [{ path: '../../../proof.txt', content: 'escaped' }] },
    ]);
    await expect(importKnowledge(streamPath, { projectRoot: TEST_ROOT })).rejects.toThrow(/skill file path/i);
    await expect(fs.access(path.join(TEST_ROOT, 'proof.txt'))).rejects.toThrow();
  });

  it('writes no skill file when any package in the stream is rejected', async () => {
    const streamPath = await writeStream('partial.jsonl', [
      HEADER,
      { type: 'skill_package', name: 'good_one', files: [{ path: 'ok.txt', content: 'fine' }] },
      { type: 'skill_package', name: 'BAD NAME', files: [{ path: 'ok.txt', content: 'fine' }] },
    ]);
    await expect(importKnowledge(streamPath, { projectRoot: TEST_ROOT })).rejects.toThrow(/skill name/i);
    await expect(fs.access(path.join(TEST_ROOT, '.knowl', 'skills', 'good_one', 'ok.txt'))).rejects.toThrow();
  });

  it('installs a well-formed skill package and leaves no staging directory', async () => {
    const streamPath = await writeStream('valid.jsonl', [
      HEADER,
      { type: 'skill_package', name: 'deploy_preview', files: [{ path: 'nested/run.sh', content: 'echo ok\n' }] },
    ]);
    const result = await importKnowledge(streamPath, { projectRoot: TEST_ROOT });
    expect(result.applied).toBe(true);
    const installed = path.join(TEST_ROOT, '.knowl', 'skills', 'deploy_preview', 'nested', 'run.sh');
    await expect(fs.readFile(installed, 'utf8')).resolves.toBe('echo ok\n');
    const leftovers = (await fs.readdir(path.join(TEST_ROOT, '.knowl')))
      .filter(entry => entry.startsWith('import-skills-'));
    expect(leftovers).toEqual([]);
  });
});
