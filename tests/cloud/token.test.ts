import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readCredential, writeCredential } from '../../src/cloud/credentials.js';
import { credentialLockPath, ensureAccessToken } from '../../src/cloud/token.js';
import { acquireLock } from '../../src/cloud/file-lock.js';

const HOME = path.resolve('./.knowl-token-home');
const HOST = 'https://api.knowl.test';

const NOW = Date.parse('2026-08-09T12:00:00.000Z');
const iso = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();

const stored = (accessToken: string, expiresAt: string) => ({
  accessToken,
  refreshToken: 'refresh-1',
  expiresAt,
  sessionId: 'sess-1',
});

describe('ensureAccessToken', () => {
  beforeEach(async () => {
    process.env.KNOWL_HOME = HOME;
    await fs.rm(HOME, { recursive: true, force: true }).catch(() => {});
  });
  afterEach(async () => {
    delete process.env.KNOWL_HOME;
    await fs.rm(HOME, { recursive: true, force: true }).catch(() => {});
  });

  it('returns null when nobody is logged in', async () => {
    const result = await ensureAccessToken({
      apiHost: HOST,
      refresh: async () => { throw new Error('must not refresh'); },
      now: () => NOW,
    });
    expect(result).toBeNull();
  });

  it('does not refresh a token that is still good', async () => {
    await writeCredential(HOST, stored('a', iso(600_000)));

    const result = await ensureAccessToken({
      apiHost: HOST,
      refresh: async () => { throw new Error('must not refresh'); },
      now: () => NOW,
    });

    expect(result?.accessToken).toBe('a');
  });

  it('refreshes inside the skew window, before the token actually expires', async () => {
    // A token valid for another 10 seconds will have expired by the time a request lands.
    await writeCredential(HOST, stored('a', iso(10_000)));

    const result = await ensureAccessToken({
      apiHost: HOST,
      refresh: async () => stored('b', iso(3_600_000)),
      now: () => NOW,
    });

    expect(result?.accessToken).toBe('b');
    expect((await readCredential(HOST))?.accessToken).toBe('b');
  });

  it('refreshes exactly once under concurrent callers', async () => {
    // The load-bearing test. The server revokes the whole session on a replayed refresh
    // token, so a second refresh is not a wasted request -- it is a logout.
    await writeCredential(HOST, stored('a', iso(-1_000)));
    let refreshes = 0;

    const results = await Promise.all(
      Array.from({ length: 10 }, () => ensureAccessToken({
        apiHost: HOST,
        refresh: async () => {
          refreshes += 1;
          await new Promise(resolve => setTimeout(resolve, 20));
          return stored('b', iso(3_600_000));
        },
        now: () => NOW,
      })),
    );

    expect(refreshes).toBe(1);
    expect(results.every(entry => entry?.accessToken === 'b')).toBe(true);
  });

  it('re-reads under the lock, so the winner never refreshes an already-rotated token', async () => {
    // The replay that logs the user out. Another process won the lock, refreshed, wrote and
    // released -- all between our read and our acquisition. We now hold the lock with a
    // `current` whose refresh token the server has already retired, and sending it is read as
    // theft: the whole session is revoked mid-work.
    //
    // Staged through `onBeforeLock` because that window is the only one the re-read guards,
    // and it cannot be produced by a losing caller -- see the seam's comment in token.ts.
    await writeCredential(HOST, stored('a', iso(-1_000)));
    let refreshes = 0;

    const result = await ensureAccessToken({
      apiHost: HOST,
      refresh: async () => { refreshes += 1; return stored('c', iso(3_600_000)); },
      now: () => NOW,
      onBeforeLock: async () => { await writeCredential(HOST, stored('b', iso(3_600_000))); },
    });

    expect(refreshes).toBe(0);
    expect(result?.accessToken).toBe('b');
  });

  it('does not refresh again once an earlier call already rotated the token', async () => {
    await writeCredential(HOST, stored('a', iso(-1_000)));
    let refreshes = 0;

    await ensureAccessToken({
      apiHost: HOST,
      refresh: async () => { refreshes += 1; return stored('b', iso(3_600_000)); },
      now: () => NOW,
    });
    const second = await ensureAccessToken({
      apiHost: HOST,
      refresh: async () => { refreshes += 1; return stored('c', iso(3_600_000)); },
      now: () => NOW,
    });

    expect(refreshes).toBe(1);
    expect(second?.accessToken).toBe('b');
  });

  it('a loser that never sees a usable token gives up rather than refreshing behind the winner', async () => {
    // The poll path, which is what the previous version of the re-read test was really
    // exercising. The winner dies holding the lock; the loser must report no token, not
    // refresh a token somebody else may be mid-rotation on.
    await writeCredential(HOST, stored('a', iso(-1_000)));
    let refreshes = 0;

    const external = await acquireLock(credentialLockPath());
    const result = await ensureAccessToken({
      apiHost: HOST,
      refresh: async () => { refreshes += 1; return stored('c', iso(3_600_000)); },
      now: () => NOW,
      waitMs: 150,
    });
    await external!();

    expect(result).toBeNull();
    expect(refreshes).toBe(0);
  });

  it('leaves the stored credential alone when refresh fails', async () => {
    await writeCredential(HOST, stored('a', iso(-1_000)));

    await expect(ensureAccessToken({
      apiHost: HOST,
      refresh: async () => { throw new Error('network down'); },
      now: () => NOW,
    })).rejects.toThrow('network down');

    expect((await readCredential(HOST))?.accessToken).toBe('a');
  });
});
