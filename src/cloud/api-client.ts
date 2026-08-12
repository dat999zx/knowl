import { hostname } from 'node:os';
import { normalizeApiHost } from './credentials.js';
import type { CloudCredential } from './credentials.js';
import {
  parseSyncPage, type PublishItem, type PublishOutcome, type SyncPage, type UpdateItemBody,
} from './sync-contract.js';

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * Mirrors the server's `DeviceAuthorizationResponse` exactly. It did not, once.
 *
 * This type was written against a hand-built fake rather than against the server, and got two
 * fields wrong in ways nothing could catch: `expiresInSeconds` where the server sends an absolute
 * `expiresAt`, so the login deadline computed as `now() + NaN` and never elapsed; and a
 * `verificationUri` the server does not send at all, so the prompt read "Open undefined". The
 * whole suite was green, because the fake supplied both.
 */
export type DeviceAuthorization = {
  deviceCode: string;
  userCode: string;
  /** The server derives its own rate limit from this, so the client must honour it. */
  intervalSeconds: number;
  /** ISO-8601 instant, not a duration. The server sends when it expires, not how long it lasts. */
  expiresAt: string;
  /**
   * Where the user approves the code. **Not currently sent by the server**, which is the open
   * half of this mismatch: only the deployment knows its own web origin, so the client cannot
   * derive it and should not guess. Optional until the server sends it; the prompt falls back to
   * naming the API host rather than printing `undefined`.
   */
  verificationUri?: string;
};

/**
 * The wire shape of a minted session, which is NOT `CloudCredential`.
 *
 * The server calls the expiry `accessExpiresAt` and sends a `sessionId`; the stored credential
 * calls it `expiresAt` and has no use for the session id. Returning the body unmapped left every
 * stored credential with `expiresAt: undefined` -- `Date.parse` gives NaN, `usable()` is false
 * forever, and the client refreshes on every single request. With rotation on, that is not just
 * waste: it is a refresh storm against a server that revokes a session on a replayed token.
 *
 * Mapped in one place so the two names cannot drift apart again silently.
 */
type TokenResponseBody = {
  sessionId: string;
  accessToken: string;
  refreshToken: string;
  accessExpiresAt: string;
};

function toCredential(body: TokenResponseBody): CloudCredential {
  return {
    accessToken: body.accessToken,
    refreshToken: body.refreshToken,
    expiresAt: body.accessExpiresAt,
    sessionId: body.sessionId,
  };
}

export type CloudRole = 'owner' | 'admin' | 'editor' | 'reader';

/**
 * The profile a workspace's vectors are built with, as the server reports it.
 *
 * Five values, never a preset name: a name is only meaningful to whoever owns the table that
 * expands it, and after 5.0 the server no longer owns one. `recipeVersion` is the field a
 * model-only comparison cannot express -- it says what TEXT went into the model.
 */
export type WorkspaceProfile = {
  provider: string;
  model: string;
  dtype: string;
  pooling: string;
  dimensions: number;
  recipeVersion: number;
};
export type CloudWorkspace = { id: string; name: string; role: CloudRole };

/** Carries the status so callers can branch: 401 means log in, 403 means not a member. */
export class CloudApiError extends Error {
  readonly name = 'CloudApiError';
  constructor(readonly status: number, message: string, readonly code?: string) {
    super(message);
  }
}

/** What `knowl cloud status` prints for "signed in as". */
export type CloudIdentity = { email: string; displayName: string };

export type CloudApi = {
  startDeviceAuthorization(): Promise<DeviceAuthorization>;
  pollForToken(deviceCode: string): Promise<CloudCredential | 'pending'>;
  refresh(refreshToken: string): Promise<CloudCredential>;
  listWorkspaces(accessToken: string): Promise<CloudWorkspace[]>;
  me(accessToken: string): Promise<CloudIdentity>;
  fetchSyncPage(input: {
    workspaceId: string;
    accessToken: string;
    since: string | null;
    cursor: string | null;
    limit?: number;
  }): Promise<SyncPage>;
  publishItems(input: {
    workspaceId: string;
    accessToken: string;
    originRepo: string;
    items: PublishItem[];
  }): Promise<{ outcomes: PublishOutcome[]; commitId: string | null }>;
  updateItem(input: {
    workspaceId: string;
    accessToken: string;
    itemId: string;
    body: UpdateItemBody;
  }): Promise<{ outcome: PublishOutcome | null }>;
  /** The profile this repo must match to publish. `reader` is enough to read it. */
  workspaceProfile(input: {
    workspaceId: string;
    accessToken: string;
  }): Promise<WorkspaceProfile>;
};

/**
 * A black-holed connection must fail, not hang.
 *
 * The dropped latency budget was about live retrieval queries, and that reasoning never
 * covered auth: `knowl cloud login` and `knowl cloud connect` are foreground commands with a person
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

  /**
   * The error shape every endpoint may answer with, alongside its own.
   *
   * Carried in `request`'s RETURN type, not only in the cast inside it. Annotating the return as
   * plain `T` erased the intersection at the boundary, so every caller handed its body to `fail`
   * -- whose parameter is all-optional, and therefore a weak type -- and TypeScript refused it
   * for having no property in common. Four call sites, one missing type argument.
   */
  type ApiErrorBody = { code?: string; message?: string };

  async function request<T>(
    pathname: string,
    init: { method: 'GET' | 'POST' | 'PATCH'; body?: unknown; accessToken?: string },
  ): Promise<{ status: number; body: T & ApiErrorBody }> {
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
    const body = await response.json().catch(() => ({})) as T & ApiErrorBody;
    return { status: response.status, body };
  }

  function fail(pathname: string, status: number, body: ApiErrorBody): never {
    throw new CloudApiError(status, body.message ?? `${pathname} failed with ${status}`, body.code);
  }

  return {
    async startDeviceAuthorization() {
      const { status, body } = await request<DeviceAuthorization>('/v1/auth/device', { method: 'POST' });
      if (status !== 200) fail('/v1/auth/device', status, body);
      return body;
    },

    async pollForToken(deviceCode) {
      const { status, body } = await request<TokenResponseBody>('/v1/auth/token', {
        method: 'POST',
        // `device`, not `device_code`. The server's discriminator is its own, not OAuth's, and
        // sending the OAuth spelling was refused outright -- so this exchange could never have
        // succeeded against a real server. `name` is what the device list shows; without it the
        // row reads "CLI" for every machine a person has ever signed in from.
        body: { grantType: 'device', deviceCode, name: hostname() },
      });
      // Not yet approved is the expected steady state of a poll, not a failure. The loop has
      // to tell it apart from a real error or it would abandon a login the user is mid-way
      // through completing.
      if (status === 428) return 'pending';
      if (status !== 200) fail('/v1/auth/token', status, body);
      return toCredential(body);
    },

    async refresh(refreshToken) {
      const { status, body } = await request<TokenResponseBody>('/v1/auth/token', {
        method: 'POST',
        // `refresh`, not `refresh_token` -- same discriminator, same refusal.
        body: { grantType: 'refresh', refreshToken },
      });
      if (status !== 200) fail('/v1/auth/token', status, body);
      return toCredential(body);
    },

    async listWorkspaces(accessToken) {
      const { status, body } = await request<{ workspaces: CloudWorkspace[] }>('/v1/workspaces', {
        method: 'GET',
        accessToken,
      });
      if (status !== 200) fail('/v1/workspaces', status, body);
      return body.workspaces ?? [];
    },

    async me(accessToken) {
      // Only the two display fields are kept. `orgs` and `workspaces` come back too, but caching
      // them here would put a second, staler copy of the workspace list beside `listWorkspaces`.
      const { status, body } = await request<{ user: CloudIdentity }>('/v1/me', {
        method: 'GET',
        accessToken,
      });
      if (status !== 200) fail('/v1/me', status, body);
      return { email: body.user.email, displayName: body.user.displayName };
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

    /**
     * A version conflict comes back **200 with a conflict outcome**, not 409.
     *
     * The batch commits in one transaction but reports per atom, so one body routinely carries
     * created atoms beside conflicting ones, and there is no honest status for "two of these
     * landed and one did not". A non-200 here is therefore a refusal of the whole request --
     * a 403 for role, a 422 for a detected secret -- and every one of those is terminal.
     */
    async publishItems(input) {
      const { status, body } = await request<{ outcomes: PublishOutcome[]; commitId: string | null }>(
        `/v1/workspaces/${encodeURIComponent(input.workspaceId)}/knowledge`,
        {
          method: 'POST',
          accessToken: input.accessToken,
          body: { originRepo: input.originRepo, items: input.items },
        },
      );
      if (status !== 200) fail('/knowledge', status, body as { code?: string; message?: string });
      return { outcomes: body.outcomes ?? [], commitId: body.commitId ?? null };
    },

    async workspaceProfile(input) {
      const { status, body } = await request<{ serving: WorkspaceProfile }>(
        `/v1/workspaces/${encodeURIComponent(input.workspaceId)}/policy`,
        { method: 'GET', accessToken: input.accessToken },
      );
      if (status !== 200) fail('/policy', status, body);
      // `serving`, never `target`. Target is an in-flight admin state during a reindex, and a
      // client that embedded against it would build vectors for a generation the workspace is
      // not searching yet.
      return body.serving;
    },

    /** `needsReview` answers `{ outcome: null }` -- it records an observation, not a revision. */
    async updateItem(input) {
      const { status, body } = await request<{ outcome: PublishOutcome | null }>(
        `/v1/workspaces/${encodeURIComponent(input.workspaceId)}` +
        `/knowledge/${encodeURIComponent(input.itemId)}`,
        { method: 'PATCH', accessToken: input.accessToken, body: input.body },
      );
      if (status !== 200) fail('/knowledge/:itemId', status, body as { code?: string; message?: string });
      return { outcome: body.outcome ?? null };
    },
  };
}
