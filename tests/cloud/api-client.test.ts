import { describe, expect, it } from 'vitest';
import { CloudApiError, createCloudApi, type FetchLike } from '../../src/cloud/api-client.js';

const HOST = 'https://api.knowl.test';

function stubFetch(handler: (url: string, init?: RequestInit) => { status: number; body: unknown }): {
  fetchImpl: FetchLike;
  calls: Array<{ url: string; init?: RequestInit }>;
} {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, init });
    const { status, body } = handler(url, init);
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { fetchImpl, calls };
}

describe('cloud api client', () => {
  it('starts a device authorization and returns the poll interval the server chose', async () => {
    // The interval must come from the server: it derives its own rate limit from that number,
    // so a self-chosen interval earns a 429 while the user is still reading the code.
    const { fetchImpl, calls } = stubFetch(() => ({
      status: 200,
      // The server's real `DeviceAuthorizationResponse`: an absolute `expiresAt`, and no
      // `verificationUri` at all. This fixture used to carry `expiresInSeconds` and a URL,
      // because it was written from the client's wishes rather than from the server -- so the
      // login deadline computed as NaN and the prompt printed "Open undefined", with every
      // test green.
      body: {
        deviceCode: 'dev-1',
        userCode: 'ABCD-EFGH',
        intervalSeconds: 5,
        expiresAt: '2099-01-01T00:00:00.000Z',
      },
    }));

    const result = await createCloudApi({ apiHost: HOST, fetchImpl }).startDeviceAuthorization();

    expect(result.userCode).toBe('ABCD-EFGH');
    expect(result.intervalSeconds).toBe(5);
    expect(result.expiresAt).toBe('2099-01-01T00:00:00.000Z');
    expect(result.verificationUri).toBeUndefined();
    expect(calls[0].url).toBe('https://api.knowl.test/v1/auth/device');
    expect(calls[0].init?.method).toBe('POST');
  });

  it('reports a pending approval as pending, not as an error', async () => {
    // The polling loop must be able to tell "not approved yet" from "something broke".
    const { fetchImpl } = stubFetch(() => ({ status: 428, body: { code: 'authorization_pending' } }));

    const result = await createCloudApi({ apiHost: HOST, fetchImpl }).pollForToken('dev-1');

    expect(result).toBe('pending');
  });

  it('maps the wire token response onto the stored credential', async () => {
    // The server calls the expiry `accessExpiresAt` and sends a `sessionId`; the stored
    // credential calls it `expiresAt` and has no user id. Returning the body unmapped left
    // `expiresAt` undefined, `Date.parse` gave NaN, `usable()` read every credential as expired,
    // and the client refreshed before every single request -- against a server that revokes a
    // session when it sees a refresh token replayed.
    const { fetchImpl } = stubFetch(() => ({
      status: 200,
      body: {
        sessionId: 'sess-1',
        accessToken: 'a',
        refreshToken: 'r',
        accessExpiresAt: '2099-01-01T00:00:00.000Z',
      },
    }));

    const result = await createCloudApi({ apiHost: HOST, fetchImpl }).pollForToken('dev-1');

    expect(result).toEqual({
      accessToken: 'a',
      refreshToken: 'r',
      expiresAt: '2099-01-01T00:00:00.000Z',
      sessionId: 'sess-1',
    });
  });

  it('sends the grant types the server actually discriminates on', async () => {
    // Every other test here asserted what the client DOES WITH a response. None asserted what it
    // SENDS, so `grantType: 'device_code'` and `'refresh_token'` -- the OAuth spellings, not this
    // server's -- shipped against a discriminator that accepts only `device` and `refresh`. Both
    // calls were refused outright by a live server while the whole suite stayed green: no login
    // could ever complete, and no token could ever refresh.
    const { fetchImpl, calls } = stubFetch(() => ({
      status: 200,
      body: { sessionId: 's', accessToken: 'a', refreshToken: 'r', accessExpiresAt: '2099-01-01T00:00:00.000Z' },
    }));
    const api = createCloudApi({ apiHost: HOST, fetchImpl });

    await api.pollForToken('dev-1');
    await api.refresh('rt-1');

    const first = JSON.parse(String(calls[0].init?.body));
    expect(first.grantType).toBe('device');
    expect(first.deviceCode).toBe('dev-1');
    // The device list shows this. Absent, every machine a person signs in from reads "CLI".
    expect(typeof first.name).toBe('string');
    expect(first.name.length).toBeGreaterThan(0);

    expect(JSON.parse(String(calls[1].init?.body))).toMatchObject({
      grantType: 'refresh',
      refreshToken: 'rt-1',
    });
  });

  it('raises a typed error carrying the status, so callers can branch on 401 and 403', async () => {
    const { fetchImpl } = stubFetch(() => ({ status: 403, body: { code: 'not_a_member' } }));

    const api = createCloudApi({ apiHost: HOST, fetchImpl });

    await expect(api.listWorkspaces('token')).rejects.toMatchObject({
      name: 'CloudApiError',
      status: 403,
      code: 'not_a_member',
    });
    await expect(api.listWorkspaces('token')).rejects.toBeInstanceOf(CloudApiError);
  });

  it('sends the bearer token on authenticated calls and never on the device call', async () => {
    const { fetchImpl, calls } = stubFetch(url =>
      url.endsWith('/workspaces')
        ? { status: 200, body: { workspaces: [{ id: 'w1', name: 'Acme', role: 'editor' }] } }
        : { status: 200, body: { deviceCode: 'd', userCode: 'u', intervalSeconds: 5, expiresAt: '2099-01-01T00:00:00.000Z' } },
    );
    const api = createCloudApi({ apiHost: HOST, fetchImpl });

    await api.startDeviceAuthorization();
    const workspaces = await api.listWorkspaces('token-1');

    expect(workspaces).toEqual([{ id: 'w1', name: 'Acme', role: 'editor' }]);
    expect((calls[0].init?.headers as Record<string, string>)?.authorization).toBeUndefined();
    expect((calls[1].init?.headers as Record<string, string>)?.authorization).toBe('Bearer token-1');
  });

  it('gives up on a connection that never answers instead of hanging the command', async () => {
    // A person is waiting on `knowl login`. A socket that is accepted and then black-holed
    // produces no output and no error, forever, unless something aborts it.
    const fetchImpl: FetchLike = (_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject((init.signal as AbortSignal).reason));
    });

    const api = createCloudApi({ apiHost: HOST, fetchImpl, timeoutMs: 25 });

    await expect(api.listWorkspaces('t')).rejects.toMatchObject({
      name: 'CloudApiError',
      status: 408,
      code: 'timeout',
    });
  });

  it('passes an abort signal on every request, including the unauthenticated one', async () => {
    const { fetchImpl, calls } = stubFetch(() => ({
      status: 200,
      body: { deviceCode: 'd', userCode: 'u', intervalSeconds: 5, expiresAt: '2099-01-01T00:00:00.000Z' },
    }));

    await createCloudApi({ apiHost: HOST, fetchImpl }).startDeviceAuthorization();

    expect(calls[0].init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('trims a trailing slash off the host rather than producing a double slash', async () => {
    const { fetchImpl, calls } = stubFetch(() => ({ status: 200, body: { workspaces: [] } }));

    await createCloudApi({ apiHost: 'https://api.knowl.test/', fetchImpl }).listWorkspaces('t');

    expect(calls[0].url).toBe('https://api.knowl.test/v1/workspaces');
  });
});
