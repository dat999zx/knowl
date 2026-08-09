import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { acquireLock } from '../../src/cloud/file-lock.js';

const DIR = path.resolve('./.knowl-lock-fixture');
const LOCK = path.join(DIR, 'test.lock');

describe('acquireLock', () => {
  beforeEach(async () => {
    await fs.rm(DIR, { recursive: true, force: true }).catch(() => {});
    await fs.mkdir(DIR, { recursive: true });
  });
  afterEach(async () => {
    await fs.rm(DIR, { recursive: true, force: true }).catch(() => {});
  });

  it('grants the lock when it is free', async () => {
    const release = await acquireLock(LOCK);
    expect(release).not.toBeNull();
    await release!();
  });

  it('refuses a second holder rather than waiting', async () => {
    // Losers must do nothing, not queue. A queue turns one slow refresh into every hook
    // process blocking behind it.
    const first = await acquireLock(LOCK);
    expect(await acquireLock(LOCK)).toBeNull();
    await first!();
  });

  it('grants the lock again after release', async () => {
    const first = await acquireLock(LOCK);
    await first!();
    const second = await acquireLock(LOCK);
    expect(second).not.toBeNull();
    await second!();
  });

  it('breaks a stale lock, so a killed process cannot wedge every future run', async () => {
    // A crashed holder never releases. Without staleness the next login is impossible and
    // the only remedy is deleting a file the user does not know exists.
    await fs.writeFile(LOCK, 'stale', 'utf8');
    const old = new Date(Date.now() - 60_000);
    await fs.utimes(LOCK, old, old);

    const release = await acquireLock(LOCK, { staleMs: 1_000 });

    expect(release).not.toBeNull();
    await release!();
  });

  it('releasing twice is safe', async () => {
    const release = await acquireLock(LOCK);
    await release!();
    await expect(release!()).resolves.toBeUndefined();
  });
});
