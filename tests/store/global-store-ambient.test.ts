import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, getClient, initDb } from '../../src/store/database.js';
import { ensureGlobalStore } from '../../src/store/global-store.js';
import { globalStorePath } from '../../src/core/paths.js';

// A HOME per test, not per file. `closeDb` cannot always unlock `global.db` on Windows, so a
// shared directory survives `beforeEach`'s `fs.rm` and the next test sees a store that already
// exists -- which silently inverts the `created` assertion below.
let counter = 0;
let HOME = '';
let ROOT = '';

/** The file the AMBIENT handle is attached to right now, asked of the connection itself. */
const ambientDatabaseFile = async (): Promise<string> => {
  const rows = (await getClient().execute('PRAGMA database_list')).rows;
  const main = rows.find(row => String(row.name) === 'main') ?? rows[0];
  return path.resolve(String(main.file));
};

/**
 * Creating the global store must not rebind the process.
 *
 * `ensureGlobalStore` exists to bootstrap `~/.knowl/global.db` and say whether it had to create
 * it. It used to do that through `initDbPath`, which assigns the module-level `globalContext` --
 * the handle every unscoped store operation resolves through. On the CLI that is invisible,
 * because the process exits. Under `knowl serve` the process outlives the call: a single
 * `knowl_store` with `namespace: 'global'` rebound the ambient database to the global store, and
 * every later project write in that session went to the wrong file while reporting success.
 *
 * The distinction this pins is the one the module already draws for namespace hops: `withDbPath`
 * swaps the handle inside `AsyncLocalStorage` for the duration of a callback, `initDbPath` swaps
 * it for the process. Bootstrap only ever needed the first.
 */
describe('ensureGlobalStore and the ambient database handle', () => {
  beforeEach(async () => {
    counter += 1;
    HOME = path.resolve(`./.knowl-globalstore-home-${counter}`);
    ROOT = path.resolve(`./.knowl-globalstore-root-${counter}`);
    process.env.KNOWL_HOME = HOME;
    for (const dir of [HOME, ROOT]) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    await fs.mkdir(path.join(ROOT, '.knowl'), { recursive: true });
    await fs.writeFile(path.join(ROOT, '.knowl', 'config.json'), JSON.stringify({ version: 1 }), 'utf8');
  });

  afterEach(async () => {
    delete process.env.KNOWL_HOME;
    await closeDb().catch(() => {});
    for (const dir of [HOME, ROOT]) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  it('leaves the ambient handle on the project store', async () => {
    await initDb(ROOT);
    const before = await ambientDatabaseFile();

    await ensureGlobalStore();

    expect(await ambientDatabaseFile()).toBe(before);
    expect(await ambientDatabaseFile()).not.toBe(path.resolve(globalStorePath()));
  });

  it('still creates the store, and still reports whether it had to', async () => {
    await initDb(ROOT);

    const first = await ensureGlobalStore();
    expect(first.created).toBe(true);
    expect(path.resolve(first.path)).toBe(path.resolve(globalStorePath()));
    await fs.access(first.path);

    // Idempotent, and the second call must not claim to have made something that existed --
    // `knowl init` prints off this flag.
    const second = await ensureGlobalStore();
    expect(second.created).toBe(false);
  });

  it('survives being called repeatedly, the way a long-lived server calls it', async () => {
    // The failure this guards is cumulative rather than immediate: the server binds once at
    // startup, then every global write re-enters. One rebinding is enough to lose the project,
    // so the assertion is that N calls leave the ambient exactly where startup put it.
    await initDb(ROOT);
    const before = await ambientDatabaseFile();

    for (let i = 0; i < 3; i += 1) await ensureGlobalStore();

    expect(await ambientDatabaseFile()).toBe(before);
  });
});
