import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, initDb } from '../../src/store/database.js';
import { IMPORT_LIMITS, importKnowledge } from '../../src/store/portability.js';

const TEST_ROOT = path.resolve('./.knowl-import-limits-test');
const HEADER = { type: 'header', format: 'knowl-jsonl', version: 2, namespace: 'project' };

async function writeStream(name: string, records: unknown[]): Promise<string> {
  const body = `${records.map(record => JSON.stringify(record)).join('\n')}\n`;
  const sha256 = crypto.createHash('sha256').update(body).digest('hex');
  const streamPath = path.join(TEST_ROOT, name);
  await fs.writeFile(streamPath, `${body}${JSON.stringify({ type: 'manifest', sha256 })}\n`, 'utf8');
  return streamPath;
}

describe('import limits', () => {
  beforeAll(async () => {
    await fs.rm(TEST_ROOT, { recursive: true, force: true }).catch(() => {});
    await fs.mkdir(path.join(TEST_ROOT, '.knowl'), { recursive: true });
    await initDb(TEST_ROOT);
  });

  afterAll(async () => {
    await closeDb();
    await fs.rm(TEST_ROOT, { recursive: true, force: true }).catch(() => {});
  });

  it('rejects a stream larger than the byte ceiling without reading it', async () => {
    const streamPath = path.join(TEST_ROOT, 'huge-stream.jsonl');
    const handle = await fs.open(streamPath, 'w');
    await handle.truncate(IMPORT_LIMITS.maxBytes + 1);
    await handle.close();
    await expect(importKnowledge(streamPath, { projectRoot: TEST_ROOT })).rejects.toThrow(/import limit/i);
  });

  it('rejects a single record larger than the record ceiling', async () => {
    const streamPath = await writeStream('huge-record.jsonl', [
      HEADER,
      { type: 'skill_package', name: 'big', files: [{ path: 'big.txt', content: 'x'.repeat(IMPORT_LIMITS.maxRecordBytes + 10) }] },
    ]);
    await expect(importKnowledge(streamPath, { projectRoot: TEST_ROOT })).rejects.toThrow(/record limit/i);
  });

  it('rejects a skill package with too many files', async () => {
    const files = Array.from({ length: IMPORT_LIMITS.maxSkillFiles + 1 }, (_, index) => ({
      path: `file-${index}.txt`,
      content: 'x',
    }));
    const streamPath = await writeStream('too-many-files.jsonl', [
      HEADER,
      { type: 'skill_package', name: 'wide', files },
    ]);
    await expect(importKnowledge(streamPath, { projectRoot: TEST_ROOT })).rejects.toThrow(/more than the limit/i);
  });

  it('still imports a well-formed stream', async () => {
    const streamPath = await writeStream('fine.jsonl', [
      HEADER,
      { type: 'skill_package', name: 'small', files: [{ path: 'run.sh', content: 'echo ok\n' }] },
    ]);
    expect((await importKnowledge(streamPath, { projectRoot: TEST_ROOT })).applied).toBe(true);
  });

  it('still rejects a tampered checksum', async () => {
    const streamPath = await writeStream('tampered.jsonl', [HEADER]);
    const contents = await fs.readFile(streamPath, 'utf8');
    await fs.writeFile(streamPath, contents.replace('"namespace":"project"', '"namespace":"global"'), 'utf8');
    await expect(importKnowledge(streamPath, { projectRoot: TEST_ROOT })).rejects.toThrow(/checksum/i);
  });
});
