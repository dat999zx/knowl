import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, initDb } from '../../src/store/database.js';
import * as repo from '../../src/store/repository.js';
import { EXPORT_FORMAT_VERSION, importKnowledge } from '../../src/store/portability.js';

const TEST_ROOT = path.resolve('./.knowl-import-containment-test');

/** A minimal valid export carrying one skill package. */
async function writeStream(file: string, skill: { name: string; files: Array<{ path: string; content: string }> }) {
  const records = [
    { type: 'header', format: 'knowl-jsonl', version: EXPORT_FORMAT_VERSION, origin: null },
    { type: 'skill_package', name: skill.name, files: skill.files },
  ];
  const body = `${records.map(record => JSON.stringify(record)).join('\n')}\n`;
  const sha256 = crypto.createHash('sha256').update(body).digest('hex');
  await fs.writeFile(file, `${body}${JSON.stringify({ type: 'manifest', sha256 })}\n`, 'utf8');
}

describe('imported skill containment', () => {
  beforeAll(async () => {
    await fs.rm(TEST_ROOT, { recursive: true, force: true }).catch(() => {});
    await fs.mkdir(path.join(TEST_ROOT, '.knowl'), { recursive: true });
    await initDb(TEST_ROOT);
    await repo.createProject(TEST_ROOT, 'Containment');
  });

  afterAll(async () => {
    await closeDb();
    await fs.rm(TEST_ROOT, { recursive: true, force: true }).catch(() => {});
    await fs.rm(path.resolve('./.knowl-import-containment-outside'), { recursive: true, force: true }).catch(() => {});
  });

  // Junction on Windows, symlink on POSIX. Both are reparse points that mkdir and rename
  // follow, and `fs.lstat().isSymbolicLink()` is true for both.
  it('refuses to install through a symlinked or junctioned package directory', async () => {
    const skills = path.join(TEST_ROOT, '.knowl', 'skills');
    const outside = path.resolve('./.knowl-import-containment-outside');
    await fs.mkdir(skills, { recursive: true });
    await fs.rm(outside, { recursive: true, force: true }).catch(() => {});
    await fs.mkdir(outside, { recursive: true });
    await fs.rm(path.join(skills, 'escapee'), { recursive: true, force: true }).catch(() => {});
    await fs.symlink(outside, path.join(skills, 'escapee'), 'junction');

    const stream = path.join(TEST_ROOT, 'escape.jsonl');
    await writeStream(stream, { name: 'escapee', files: [{ path: 'payload.txt', content: 'PWNED' }] });

    await expect(importKnowledge(stream, { projectRoot: TEST_ROOT })).rejects.toThrow(/symlink|junction|reparse/i);
    await expect(fs.readdir(outside)).resolves.toEqual([]);
  });

  it('replaces a package rather than merging into it', async () => {
    const dir = path.join(TEST_ROOT, '.knowl', 'skills', 'replaceme');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'stale.sh'), 'echo old', 'utf8');
    await fs.writeFile(path.join(dir, 'SKILL.md'), '# old', 'utf8');

    const stream = path.join(TEST_ROOT, 'replace.jsonl');
    await writeStream(stream, { name: 'replaceme', files: [{ path: 'SKILL.md', content: '# new' }] });

    await importKnowledge(stream, { projectRoot: TEST_ROOT });

    expect(await fs.readdir(dir)).toEqual(['SKILL.md']);
    expect(await fs.readFile(path.join(dir, 'SKILL.md'), 'utf8')).toBe('# new');
  });

  it('leaves no staging directories behind', async () => {
    const skills = path.join(TEST_ROOT, '.knowl', 'skills');
    const leftovers = (await fs.readdir(skills)).filter(name => name.startsWith('.import-'));
    expect(leftovers).toEqual([]);
  });
});
