import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { writeFileAtomic } from '../../src/core/atomic-write.js';
import { loadConfig, saveConfig } from '../../src/core/config.js';

const TEST_ROOT = path.resolve('./.knowl-atomic-write-test');

/** An `fs` error as Node reports it, since the retry decides on `code` alone. */
const errno = (code: string): NodeJS.ErrnoException =>
  Object.assign(new Error(`${code}: operation not permitted, rename`), { code });

describe('atomic writes', () => {
  beforeAll(async () => {
    await fs.rm(TEST_ROOT, { recursive: true, force: true }).catch(() => {});
    await fs.mkdir(path.join(TEST_ROOT, '.knowl'), { recursive: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
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

  /**
   * The rename retry, which is why this file exists at all on Windows.
   *
   * Injected rather than provoked: the real cause is an antivirus opening the temporary file in
   * the microsecond after it is closed, which cannot be arranged on demand -- it is exactly the
   * "never reproducible in isolation" that had this answered by re-running CI for months.
   */
  describe('a destination another process holds open for a moment', () => {
    it('retries the rename and completes the write', async () => {
      const target = path.join(TEST_ROOT, 'contended.json');
      const real = fs.rename;
      let attempts = 0;
      vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
        attempts += 1;
        // Two refusals, then through -- the shape of a scanner releasing the handle.
        if (attempts <= 2) throw errno('EPERM');
        return real(from, to);
      });

      await writeFileAtomic(target, '{"survived":true}');

      expect(attempts).toBe(3);
      expect(await fs.readFile(target, 'utf8')).toBe('{"survived":true}');
      expect((await fs.readdir(TEST_ROOT)).filter(entry => entry.includes('.tmp'))).toEqual([]);
    });

    it('gives up bounded, and throws the error the caller needs rather than one about retrying', async () => {
      const target = path.join(TEST_ROOT, 'never-free.json');
      let attempts = 0;
      vi.spyOn(fs, 'rename').mockImplementation(async () => {
        attempts += 1;
        throw errno('EBUSY');
      });

      await expect(writeFileAtomic(target, '{}')).rejects.toThrow(/EBUSY/);

      expect(attempts).toBe(5);
      // The staged file is still cleaned up on the way out, so a wedged destination does not
      // accumulate a temporary per attempt.
      expect((await fs.readdir(TEST_ROOT)).filter(entry => entry.includes('.tmp'))).toEqual([]);
    });

    it('does not retry an error that will not clear', async () => {
      // ENOENT means the staged file is gone, which is a bug rather than contention. Retrying it
      // would turn an immediate, clear failure into a slow one.
      const target = path.join(TEST_ROOT, 'not-contention.json');
      let attempts = 0;
      vi.spyOn(fs, 'rename').mockImplementation(async () => {
        attempts += 1;
        throw errno('ENOENT');
      });

      await expect(writeFileAtomic(target, '{}')).rejects.toThrow(/ENOENT/);

      expect(attempts).toBe(1);
    });
  });
});
