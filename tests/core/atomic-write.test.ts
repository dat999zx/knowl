import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { writeFileAtomic } from '../../src/core/atomic-write.js';
import { loadConfig, saveConfig } from '../../src/core/config.js';

const TEST_ROOT = path.resolve('./.knowl-atomic-write-test');

describe('atomic writes', () => {
  beforeAll(async () => {
    await fs.rm(TEST_ROOT, { recursive: true, force: true }).catch(() => {});
    await fs.mkdir(path.join(TEST_ROOT, '.knowl'), { recursive: true });
  });

  afterAll(async () => {
    await fs.rm(TEST_ROOT, { recursive: true, force: true }).catch(() => {});
  });

  it('replaces a file in one step and leaves no temporary behind', async () => {
    const target = path.join(TEST_ROOT, 'value.json');
    await writeFileAtomic(target, '{"a":1}');
    await writeFileAtomic(target, '{"a":2}');
    expect(await fs.readFile(target, 'utf8')).toBe('{"a":2}');
    expect((await fs.readdir(TEST_ROOT)).filter(entry => entry.includes('.tmp'))).toEqual([]);
  });

  it.skipIf(process.platform === 'win32')('creates the file owner-readable only', async () => {
    const target = path.join(TEST_ROOT, 'secret.json');
    await writeFileAtomic(target, '{"apiKey":"x"}', { mode: 0o600 });
    expect((await fs.stat(target)).mode & 0o777).toBe(0o600);
  });

  it.skipIf(process.platform === 'win32')('saves project config owner-readable only', async () => {
    await saveConfig(TEST_ROOT, { ai: { provider: 'openai', model: 'gpt-4o-mini' } } as any);
    expect((await fs.stat(path.join(TEST_ROOT, '.knowl', 'config.json'))).mode & 0o777).toBe(0o600);
    expect((await loadConfig(TEST_ROOT)).ai?.model).toBe('gpt-4o-mini');
  });
});
