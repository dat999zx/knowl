import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * One file that cannot be read must cost one file, not the rest of the pass.
 *
 * The failure is injected rather than staged on disk because the real one is a race -- the walk
 * yields a path, the file goes, the read gets ENOENT -- and a test that waits for that race is a
 * test that passes for the wrong reason. Everything else here is genuine: a real repository, a
 * real database, the real walk.
 */
const UNREADABLE = 'src/vanishes.ts';

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const readFile: typeof actual.readFile = (async (file: any, ...rest: any[]) => {
    if (typeof file === 'string' && file.replace(/\\/g, '/').endsWith(UNREADABLE)) {
      const error: NodeJS.ErrnoException = new Error(`ENOENT: no such file or directory, open '${file}'`);
      error.code = 'ENOENT';
      throw error;
    }
    return (actual.readFile as any)(file, ...rest);
  }) as any;
  return { ...actual, default: { ...actual, readFile }, readFile };
});

const fs = (await import('node:fs/promises')).default;
const { closeDb, initDb } = await import('../../src/store/database.js');
const { indexCode, listCodeSymbols } = await import('../../src/code/symbol-index.js');

const ROOT = path.resolve('./.knowl-index-resilience-test');
const src = (name: string) => path.join(ROOT, 'src', name);

describe('a code file the index cannot read', () => {
  beforeAll(async () => {
    await fs.rm(ROOT, { recursive: true, force: true });
    await fs.mkdir(path.join(ROOT, 'src'), { recursive: true });
    await fs.mkdir(path.join(ROOT, '.knowl'), { recursive: true });
    // Alphabetical, so the unreadable one sits between two the walk must still index. `before`
    // proves the pass got that far; `zebra` proves it did not stop there.
    await fs.writeFile(src('before.ts'), 'export function before() { return 1; }\n');
    await fs.writeFile(src('vanishes.ts'), 'export function gone() { return 2; }\n');
    await fs.writeFile(src('zebra.ts'), 'export function zebra() { return 3; }\n');
    await initDb(ROOT);
  });
  afterAll(async () => { await closeDb(); await fs.rm(ROOT, { recursive: true, force: true }).catch(() => {}); });

  it('is skipped and named, and the pass finishes the files on either side of it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(indexCode(ROOT)).resolves.toBeUndefined();

    expect((await listCodeSymbols('src/before.ts')).map(s => s.locator)).toContain('symbol://src/before.ts#before');
    expect((await listCodeSymbols('src/zebra.ts')).map(s => s.locator)).toContain('symbol://src/zebra.ts#zebra');
    expect(await listCodeSymbols(UNREADABLE)).toEqual([]);
    // Named rather than swallowed: an unindexed file is invisible, so silence is the one outcome
    // that reads exactly like success.
    expect(warn.mock.calls.map(call => String(call[0])).join('\n')).toContain(UNREADABLE);

    warn.mockRestore();
  });
});
