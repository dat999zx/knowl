import { normalizeApiHost } from './credentials.js';
import type { CloudCredential } from './credentials.js';

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
};

export function createCloudApi(options: { apiHost: string; fetchImpl?: FetchLike }): CloudApi {
  const host = normalizeApiHost(options.apiHost);
  const doFetch = options.fetchImpl ?? ((url, init) => fetch(url, init));

  async function request<T>(
    pathname: string,
    init: { method: 'GET' | 'POST'; body?: unknown; accessToken?: string },
  ): Promise<{ status: number; body: T }> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (init.body !== undefined) headers['content-type'] = 'application/json';
    if (init.accessToken) headers.authorization = `Bearer ${init.accessToken}`;

    const response = await doFetch(`${host}${pathname}`, {
      method: init.method,
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });

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
  };
}
