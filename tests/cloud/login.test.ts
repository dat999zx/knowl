import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readCredential, writeCredential } from '../../src/cloud/credentials.js';
import { defaultApiHost, runLogin, runLogout } from '../../src/cloud/login.js';
import type { CloudApi, DeviceAuthorization } from '../../src/cloud/api-client.js';
import { CloudApiError } from '../../src/cloud/api-client.js';

const HOME = path.resolve('./.knowl-login-home');
const HOST = 'https://api.knowl.test';

/** Fifteen minutes, like the server's. */
const CODE_LIFETIME_MS = 900_000;

/** The instant the expiry test's injected clock starts from, and the only pinned date here. */
const EXPIRY_TEST_EPOCH = Date.parse('2026-08-09T12:00:00.000Z');

/**
 * The server's real shape: an absolute `expiresAt`, and no `verificationUri`.
 *
 * This fixture used to carry `expiresInSeconds: 900` and a URL, neither of which the server
 * sends. That is what made the deadline `now() + NaN` in production while every test here passed
 * -- the fake was written from what the client wanted rather than from what the server returns.
 *
 * The deadline is computed per run rather than pinned to a date. It was pinned to
 * 2026-08-09T12:15:00Z, which every test compared against the real `Date.now()`: the suite
 * passed until the wall clock reached that instant and then failed for everyone, permanently,
 * with no code change. Only the expiry test below pins an instant, and only because it supplies
 * the clock that reads it.
 */
const authorization: DeviceAuthorization = {
  deviceCode: 'dev-1',
  userCode: 'ABCD-EFGH',
  intervalSeconds: 5,
  expiresAt: new Date(Date.now() + CODE_LIFETIME_MS).toISOString(),
};

/** Reached in 180 polls of 5s from `EXPIRY_TEST_EPOCH`, on the clock that test injects. */
const expiringAuthorization: DeviceAuthorization = {
  ...authorization,
  expiresAt: new Date(EXPIRY_TEST_EPOCH + CODE_LIFETIME_MS).toISOString(),
};

const credential = {
  accessToken: 'a',
  refreshToken: 'r',
  expiresAt: '2099-01-01T00:00:00.000Z',
  sessionId: 'sess-1',
};

function fakeApi(
  polls: Array<'pending' | typeof credential | CloudApiError>,
  auth: DeviceAuthorization = authorization,
): CloudApi {
  const queue = [...polls];
  return {
    startDeviceAuthorization: async () => auth,
    pollForToken: async () => {
      const next = queue.shift();
      if (next instanceof CloudApiError) throw next;
      return next ?? 'pending';
    },
    refresh: async () => credential,
    listWorkspaces: async () => [],
    me: async () => ({ email: 'dev@example.com', displayName: 'Dev' }),
  };
}

describe('runLogin', () => {
  beforeEach(async () => {
    process.env.KNOWL_HOME = HOME;
    await fs.rm(HOME, { recursive: true, force: true }).catch(() => {});
  });
  afterEach(async () => {
    delete process.env.KNOWL_HOME;
    await fs.rm(HOME, { recursive: true, force: true }).catch(() => {});
  });

  it('shows the user the code before polling, not after', async () => {
    // The code is what the user types into the browser. Printing it after the first poll
    // means the first interval elapses before they can see what to do.
    const seen: string[] = [];

    await runLogin({
      apiHost: HOST,
      api: fakeApi([credential]),
      onPrompt: auth => seen.push(auth.userCode),
      sleep: async () => {},
    });

    expect(seen).toEqual(['ABCD-EFGH']);
  });

  it('stores the credential once approved', async () => {
    const result = await runLogin({
      apiHost: HOST,
      api: fakeApi(['pending', 'pending', credential]),
      onPrompt: () => {},
      sleep: async () => {},
    });

    expect(result).toEqual({ status: 'authorized', sessionId: 'sess-1' });
    // The tokens land verbatim; `identity` rides alongside them since login now caches it so
    // status can name you offline. Asserted as a superset rather than by equality, so adding a
    // future credential field is not a test change.
    expect(await readCredential(HOST)).toMatchObject(credential);
  });

  it('waits the interval the server advertised, not one of its own choosing', async () => {
    // The server computes its rate limit from this number. Polling faster earns a 429 on the
    // tenth of twelve polls, while the user is still reading the code.
    const waits: number[] = [];

    await runLogin({
      apiHost: HOST,
      api: fakeApi(['pending', credential]),
      onPrompt: () => {},
      sleep: async ms => { waits.push(ms); },
    });

    expect(waits).toEqual([5_000]);
  });

  it('gives up when the device code expires instead of polling forever', async () => {
    // The clock advances by the interval on every poll and the deadline is the server's own
    // `expiresAt`, so this reaches it in 180 polls. It is the one test that would run forever
    // against a deadline the client could not compute -- which is exactly what shipped.
    let elapsed = 0;
    const result = await runLogin({
      apiHost: HOST,
      api: fakeApi(Array.from({ length: 500 }, () => 'pending' as const), expiringAuthorization),
      onPrompt: () => {},
      sleep: async ms => { elapsed += ms; },
      now: () => EXPIRY_TEST_EPOCH + elapsed,
    });

    expect(result).toEqual({ status: 'expired' });
    expect(await readCredential(HOST)).toBeNull();
  });

  it('propagates a real error rather than treating it as pending', async () => {
    await expect(runLogin({
      apiHost: HOST,
      api: fakeApi([new CloudApiError(429, 'slow down', 'rate_limited')]),
      onPrompt: () => {},
      sleep: async () => {},
    })).rejects.toBeInstanceOf(CloudApiError);
  });
});

describe('defaultApiHost', () => {
  afterEach(() => { delete process.env.KNOWL_API_HOST; });

  it('names a domain the project owns', () => {
    // The constant said `api.knowl.dev` once, which the project does not own. A default host is
    // where an unconfigured `knowl login` sends its device request and, moments later, whatever
    // that host answers with -- so pointing it at a registrable domain belonging to nobody is a
    // credential hand-off waiting for someone to buy it.
    delete process.env.KNOWL_API_HOST;
    expect(defaultApiHost()).toBe('https://api.knowl.cloud');
  });

  it('is overridden by KNOWL_API_HOST, for a self-hosted or tunnelled server', () => {
    // `--api` covers one command and `knowl cloud connect` records the host per repo, but
    // `knowl login` is per-machine and remembers nothing -- so without this, every login against
    // a self-hosted server retypes the flag.
    process.env.KNOWL_API_HOST = 'https://knowl.internal.example';
    expect(defaultApiHost()).toBe('https://knowl.internal.example');
  });

  it('ignores an empty or whitespace-only override rather than producing a hostless URL', () => {
    // An exported-but-empty variable is the ordinary state of a shell profile someone edited and
    // half-reverted. Treating it as a host sends every request to `/v1/...` with no origin.
    process.env.KNOWL_API_HOST = '   ';
    expect(defaultApiHost()).toBe('https://api.knowl.cloud');
  });
});

describe('runLogout', () => {
  beforeEach(async () => {
    process.env.KNOWL_HOME = HOME;
    await fs.rm(HOME, { recursive: true, force: true }).catch(() => {});
  });
  afterEach(async () => {
    delete process.env.KNOWL_HOME;
    await fs.rm(HOME, { recursive: true, force: true }).catch(() => {});
  });

  it('reports that there was nothing to clear', async () => {
    expect(await runLogout(HOST)).toEqual({ wasLoggedIn: false });
  });

  it('clears the stored credential', async () => {
    await writeCredential(HOST, credential);

    expect(await runLogout(HOST)).toEqual({ wasLoggedIn: true });
    expect(await readCredential(HOST)).toBeNull();
  });

  it('does not start device auth when a usable credential is already stored', async () => {
    await writeCredential(HOST, { ...credential, identity: { email: 'dev@example.com', displayName: 'Dev' } });

    let started = 0;
    const api: CloudApi = {
      ...fakeApi([credential]),
      startDeviceAuthorization: async () => { started += 1; throw new Error('must not be called'); },
    };

    const result = await runLogin({ apiHost: HOST, api, onPrompt: () => {}, sleep: async () => {} });

    expect(result.status).toBe('already-signed-in');
    expect(result.status === 'already-signed-in' && result.identity?.email).toBe('dev@example.com');
    expect(started).toBe(0);
  });

  it('reports an already-signed-in credential written before identity was cached', async () => {
    // A 4.x credential has no identity. Saying so beats inventing one.
    await writeCredential(HOST, credential);

    const result = await runLogin({
      apiHost: HOST, api: fakeApi([credential]), onPrompt: () => {}, sleep: async () => {},
    });

    expect(result.status).toBe('already-signed-in');
    expect(result.status === 'already-signed-in' && result.identity).toBeNull();
  });

  it('re-authenticates anyway when force is set', async () => {
    await writeCredential(HOST, credential);

    let started = 0;
    const base = fakeApi([credential]);
    const api: CloudApi = {
      ...base,
      startDeviceAuthorization: async () => { started += 1; return authorization; },
    };

    const result = await runLogin({
      apiHost: HOST, api, onPrompt: () => {}, sleep: async () => {}, force: true,
    });

    expect(result.status).toBe('authorized');
    expect(started).toBe(1);
  });

  it('an expired stored credential does not short-circuit', async () => {
    await writeCredential(HOST, { ...credential, expiresAt: new Date(Date.now() - 1_000).toISOString() });

    let started = 0;
    const base = fakeApi([credential]);
    const api: CloudApi = {
      ...base,
      startDeviceAuthorization: async () => { started += 1; return authorization; },
    };

    const result = await runLogin({ apiHost: HOST, api, onPrompt: () => {}, sleep: async () => {} });

    expect(result.status).toBe('authorized');
    expect(started).toBe(1);
  });

  it('caches the identity it fetched, so status can answer offline', async () => {
    await runLogin({
      apiHost: HOST, api: fakeApi([credential]), onPrompt: () => {}, sleep: async () => {},
    });

    expect((await readCredential(HOST))?.identity).toEqual({ email: 'dev@example.com', displayName: 'Dev' });
  });

  it('signs in even when the identity fetch fails', async () => {
    // A login that worked must not be reported as failed over a cosmetic field.
    const base = fakeApi([credential]);
    const api: CloudApi = { ...base, me: async () => { throw new CloudApiError(500, 'boom'); } };

    const result = await runLogin({ apiHost: HOST, api, onPrompt: () => {}, sleep: async () => {} });

    expect(result.status).toBe('authorized');
    expect((await readCredential(HOST))?.identity).toBeUndefined();
  });
});
