import { normalizeApiHost } from './credentials.js';
import type { CloudCredential } from './credentials.js';
import { parseSyncPage, type SyncPage } from './sync-contract.js';

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export type DeviceAuthorization = {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  /** The server derives its own rate limit from this, so the client must honour it. */
  intervalSeconds: number;
  expiresInSeconds: number;
};

export type CloudRole = 'owner' | 'admin' | 'editor' | 'reader';
export type CloudWorkspace = { id: string; name: string; role: CloudRole };

/** Carries the status so callers can branch: 401 means log in, 403 means not a member. */
export class CloudApiError extends Error {
  readonly name = 'CloudApiError';
  constructor(readonly status: number, message: string, readonly code?: string) {
    super(message);
  }
}

export type CloudApi = {
  startDeviceAuthorization(): Promise<DeviceAuthorization>;
  pollForToken(deviceCode: string): Promise<CloudCredential | 'pending'>;
  refresh(refreshToken: string): Promise<CloudCredential>;
  listWorkspaces(accessToken: string): Promise<CloudWorkspace[]>;
  fetchSyncPage(input: {
    workspaceId: string;
    accessToken: string;
    since: string | null;
    cursor: string | null;
    limit?: number;
  }): Promise<SyncPage>;
};

/**
 * A black-holed connection must fail, not hang.
 *
 * The dropped latency budget was about live retrieval queries, and that reasoning never
 * covered auth: `knowl login` and `knowl cloud connect` are foreground commands with a person
 * waiting on them, and a TCP connection that is accepted and then never answered produces no
 * output and no error until the user gives up.
 */
const DEFAULT_TIMEOUT_MS = 30_000;

export function createCloudApi(options: {
  apiHost: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}): CloudApi {
  const host = normalizeApiHost(options.apiHost);
  const doFetch = options.fetchImpl ?? ((url, init) => fetch(url, init));
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  async function request<T>(
    pathname: string,
    init: { method: 'GET' | 'POST'; body?: unknown; accessToken?: string },
  ): Promise<{ status: number; body: T }> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (init.body !== undefined) headers['content-type'] = 'application/json';
    if (init.accessToken) headers.authorization = `Bearer ${init.accessToken}`;

    let response: Response;
    try {
      response = await doFetch(`${host}${pathname}`, {
        method: init.method,
        headers,
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error: any) {
      // Reported as a CloudApiError so every caller has one error type to handle, and as 408
      // so a timeout is distinguishable from a refusal the server actually issued.
      if (error?.name === 'TimeoutError') {
        throw new CloudApiError(408, `${pathname} timed out after ${timeoutMs}ms`, 'timeout');
      }
      throw error;
    }

    // A non-JSON body is a proxy or gateway answering, not the API. Reporting the status is
    // more useful than a parse error that names neither the endpoint nor the code.
    const body = await response.json().catch(() => ({})) as T & { code?: string; message?: string };
    return { status: response.status, body };
  }

  function fail(pathname: string, status: number, body: { code?: string; message?: string }): never {
    throw new CloudApiError(status, body.message ?? `${pathname} failed with ${status}`, body.code);
  }

  return {
    async startDeviceAuthorization() {
      const { status, body } = await request<DeviceAuthorization>('/v1/auth/device', { method: 'POST' });
      if (status !== 200) fail('/v1/auth/device', status, body);
      return body;
    },

    async pollForToken(deviceCode) {
      const { status, body } = await request<CloudCredential>('/v1/auth/token', {
        method: 'POST',
        body: { grantType: 'device_code', deviceCode },
      });
      // Not yet approved is the expected steady state of a poll, not a failure. The loop has
      // to tell it apart from a real error or it would abandon a login the user is mid-way
      // through completing.
      if (status === 428) return 'pending';
      if (status !== 200) fail('/v1/auth/token', status, body);
      return body;
    },

    async refresh(refreshToken) {
      const { status, body } = await request<CloudCredential>('/v1/auth/token', {
        method: 'POST',
        body: { grantType: 'refresh_token', refreshToken },
      });
      if (status !== 200) fail('/v1/auth/token', status, body);
      return body;
    },

    async listWorkspaces(accessToken) {
      const { status, body } = await request<{ workspaces: CloudWorkspace[] }>('/v1/workspaces', {
        method: 'GET',
        accessToken,
      });
      if (status !== 200) fail('/v1/workspaces', status, body);
      return body.workspaces ?? [];
    },

    async fetchSyncPage(input) {
      const query = new URLSearchParams();
      // Omitted entirely on a first sync -- an absent `since` is what selects snapshot mode,
      // and sending `since=0` would ask for a delta from a commit that never existed.
      if (input.since !== null) query.set('since', input.since);
      if (input.cursor !== null) query.set('cursor', input.cursor);
      query.set('limit', String(input.limit ?? 100));

      const { status, body } = await request<unknown>(
        `/v1/workspaces/${encodeURIComponent(input.workspaceId)}/sync?${query.toString()}`,
        { method: 'GET', accessToken: input.accessToken },
      );
      if (status !== 200) fail('/sync', status, body as { code?: string; message?: string });
      return parseSyncPage(body);
    },
  };
}
