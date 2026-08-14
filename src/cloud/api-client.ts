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

/** What a receiver is shown before deciding, and what the sender's label promises. */
export type SendPreview = {
  senderLabel: string;
  itemCount: number;
  createdAt: string;
  expiresAt: string;
};

/**
 * Why a send or a claim came back empty. Distinguished rather than collapsed, because the remedies
 * differ: a typo is retryable, an expiry needs a re-send, and "already collected" tells a receiver
 * whose download dropped that the bundle is gone rather than that they mistyped.
 */
export type KnownSendRefusal =
  | 'not_found'
  | 'expired'
  | 'already_claimed'
  /** The mailbox id is taken, which at 2^55 means codegen is broken, not that two people collided. */
  | 'conflict'
  /** The sender is at their in-flight quota: wait for claims or expiry rather than minting again. */
  | 'rate_limited';

/**
 * Open on purpose, and this is a fix rather than future-proofing.
 *
 * The server and this client ship separately, so its `reason` enum grows without asking. It has
 * already grown twice since 5.1.0 -- `conflict` and `rate_limited` -- and a closed union meant a
 * sender at their quota was told **"No bundle waiting on that code"**, because the CLI's message
 * map had no key for what arrived and fell through to the default.
 *
 * So an unrecognised reason is carried, not coerced, and the server's own `message` travels with
 * it. A future addition then degrades to showing the truth instead of a confident wrong answer.
 */
export type SendRefusal = KnownSendRefusal | (string & {});

/** A refusal, with whatever the server said about it. */
export type SendRefused = { refused: SendRefusal; message?: string };

/** One of the caller's own in-flight bundles, as `knowl cloud send --list` shows it. */
export type SendMailbox = {
  mailboxId: string;
  itemCount: number;
  createdAt: string;
  expiresAt: string;
  /** Non-null on a bundle that has been collected -- the tamper-evidence signal. */
  claimedAt: string | null;
};

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
  /**
   * The drop box behind `knowl send` / `knowl receive`.
   *
   * Not workspace-scoped, and that is the point: `push` reaches a workspace, `send` reaches a
   * person who may share none of yours. All three still require an access token -- decision
   * `8b24a27615914365` -- so guessing a code is rate-limited and attributable, unlike the
   * anonymous receive the server PR originally specified.
   *
   * `ciphertext` is base64 of bytes this client sealed. The server stores it and can open none of
   * it; see `src/cloud/send/seal.ts` for why that is this side's job to keep.
   */
  createSend(input: {
    accessToken: string;
    mailboxId: string;
    ciphertext: string;
    senderLabel: string;
    itemCount: number;
    expiresInHours: number;
  }): Promise<{ mailboxId: string; expiresAt: string } | SendRefused>;
  /** Reads the label without spending the single claim, so a receiver can decline knowingly. */
  peekSend(input: {
    accessToken: string;
    mailboxId: string;
  }): Promise<SendPreview | null>;
  claimSend(input: {
    accessToken: string;
    mailboxId: string;
  }): Promise<{ ciphertext: string; preview: SendPreview } | SendRefused>;
  /**
   * The caller's own in-flight bundles, and whether each has been taken.
   *
   * The claimed-yet column is the feature, not the listing: a bundle you never handed off showing
   * `claimedAt` is how a leaked or guessed code announces itself. Own sends only -- these ids are
   * claim tickets, so the server scopes the query to the principal rather than to a workspace.
   */
  listSends(accessToken: string): Promise<SendMailbox[]>;
  /** Destroys a bundle before anyone collects it. False if there was nothing there to destroy. */
  revokeSend(input: { accessToken: string; mailboxId: string }): Promise<boolean>;
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
    init: { method: 'GET' | 'POST' | 'PATCH' | 'DELETE'; body?: unknown; accessToken?: string },
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

  /**
   * A refusal, keeping whatever the server actually said.
   *
   * **The reason is not narrowed to a known member**, deliberately. The server's enum grows
   * independently of this client -- it gained `conflict` and `rate_limited` after 5.1.0 shipped --
   * and coercing an unrecognised value to `fallback` is what made a sender at their quota read
   * "No bundle waiting on that code". Carrying the string and the message lets the CLI print a
   * known reason in its own words and an unknown one in the server's.
   */
  function refusalOf(body: { reason?: string; message?: string } | undefined, fallback: SendRefusal): SendRefused {
    return { refused: body?.reason ?? fallback, message: body?.message };
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

    async createSend(input) {
      const { status, body } = await request<{ mailboxId: string; expiresAt: string }>(
        '/v1/send',
        {
          method: 'POST',
          accessToken: input.accessToken,
          body: {
            mailboxId: input.mailboxId,
            ciphertext: input.ciphertext,
            senderLabel: input.senderLabel,
            itemCount: input.itemCount,
            expiresInHours: input.expiresInHours,
          },
        },
      );
      // 409 is a mailbox-id collision and 429 is the sender's in-flight quota. Both are refusals a
      // sender can act on, not transport failures, so they come back as values rather than throws
      // -- and they carry the server's own wording, which is the half a `reason` cannot express.
      if (status === 409 || status === 429) {
        return refusalOf(body as { reason?: string; message?: string }, 'conflict');
      }
      if (status !== 200 && status !== 201) fail('/send', status, body as { code?: string; message?: string });
      return { mailboxId: body.mailboxId, expiresAt: body.expiresAt };
    },

    async peekSend(input) {
      const { status, body } = await request<SendPreview>(
        `/v1/send/${encodeURIComponent(input.mailboxId)}`,
        { method: 'GET', accessToken: input.accessToken },
      );
      // Every failure is one 404 by design on the server side, so a peeker cannot confirm a
      // guessed code for free. Null here means exactly that: nothing to show, reason withheld.
      if (status === 404 || status === 410) return null;
      if (status !== 200) fail('/send/:id', status, body as { code?: string; message?: string });
      return body;
    },

    async claimSend(input) {
      const { status, body } = await request<{
        ciphertext: string; preview: SendPreview; reason?: string; message?: string;
      }>(
        `/v1/send/${encodeURIComponent(input.mailboxId)}`,
        { method: 'POST', accessToken: input.accessToken },
      );
      // The claim discriminates where the peek does not: by now the caller has proven they hold
      // the code, so telling them *why* it failed costs nothing and is the difference between
      // "ask for a re-send" and "check what you typed".
      if (status === 404 || status === 410 || status === 429) {
        return refusalOf(body, 'not_found');
      }
      if (status !== 200) fail('/send/:id claim', status, body as { code?: string; message?: string });
      return { ciphertext: body.ciphertext, preview: body.preview };
    },

    async listSends(accessToken) {
      const { status, body } = await request<{ mailboxes?: SendMailbox[] }>(
        '/v1/send',
        { method: 'GET', accessToken },
      );
      if (status !== 200) fail('/send', status, body as { code?: string; message?: string });
      return body.mailboxes ?? [];
    },

    async revokeSend(input) {
      const { status, body } = await request<unknown>(
        `/v1/send/${encodeURIComponent(input.mailboxId)}`,
        { method: 'DELETE', accessToken: input.accessToken },
      );
      // 404 is not an error here: revoking is idempotent, and a caller walking both derivations
      // asks for an id that was never there by design.
      if (status === 404 || status === 410) return false;
      if (status !== 200) fail('/send/:id revoke', status, body as { code?: string; message?: string });
      return true;
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
