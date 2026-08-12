import { createCloudApi, type CloudApi, type CloudIdentity, type DeviceAuthorization } from './api-client.js';
import { clearCredential, readCredential, writeCredential } from './credentials.js';
import { isCredentialUsable } from './token.js';

/**
 * The hosted deployment, under the project's own domain.
 *
 * It said `api.knowl.dev` for one release cycle, which is a domain the project does not own.
 * That is worse than a dead default: anyone who registered it would receive the device-code
 * request from every `knowl cloud login` run without `--api`, hand back a token the client would
 * store, and then receive everything that client published. No attack on us required -- just a
 * registration and a user who took the default.
 *
 * A default host must therefore always name a domain the project controls.
 */
const HOSTED_API_HOST = 'https://api.knowl.cloud';

/**
 * Machine-wide override, for a self-hosted or tunnelled server.
 *
 * `--api` already exists per command, and `knowl cloud connect` records the host in the repo's
 * config so `pull`, `push` and `status` remember it. Neither helps `knowl cloud login`, which is
 * per-machine rather than per-repo and so has nowhere to remember anything -- which meant
 * retyping the flag on every login against a self-hosted server.
 *
 * An environment variable rather than a new config file, matching `KNOWL_HOME`: this is
 * machine-level state that belongs to the operator, not to any repository, and the repo already
 * reads exactly one of those.
 *
 * Resolved on call rather than frozen in a constant. Commander still evaluates it once, while it
 * builds the command table, so a variable exported before `knowl` starts is honoured and one
 * changed mid-process is not -- which is the whole of what a CLI needs.
 */
export function defaultApiHost(): string {
  const override = process.env.KNOWL_API_HOST?.trim();
  return override || HOSTED_API_HOST;
}

export type LoginInput = {
  apiHost: string;
  api?: CloudApi;
  /** Called once, before the first poll, so the user can read the code and act on it. */
  onPrompt: (authorization: DeviceAuthorization) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Re-run the device flow even when this machine already holds a usable token. */
  force?: boolean;
};

export type LoginResult =
  | { status: 'authorized'; sessionId: string }
  | { status: 'already-signed-in'; identity: CloudIdentity | null }
  | { status: 'expired' };

export async function runLogin(input: LoginInput): Promise<LoginResult> {
  const api = input.api ?? createCloudApi({ apiHost: input.apiHost });
  const sleep = input.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const now = input.now ?? Date.now;

  // Read before spending a round trip and a browser trip. This used to call
  // `startDeviceAuthorization` unconditionally and only reach `readCredential` afterwards, so a
  // user holding an unexpired token was sent through the whole device-code dance again.
  //
  // `isCredentialUsable` rather than a local expiry comparison: the skew window and the
  // unparseable-expiry rule live in one place, and a second copy would drift silently.
  if (!input.force) {
    const existing = await readCredential(input.apiHost);
    if (isCredentialUsable(existing, now())) {
      return { status: 'already-signed-in', identity: existing?.identity ?? null };
    }
  }

  const authorization = await api.startDeviceAuthorization();
  input.onPrompt(authorization);

  // The server sends an absolute instant, not a duration. Reading it as a duration produced
  // `now() + NaN`, and `now() >= NaN` is false forever -- so the expiry branch below was
  // unreachable in production and the loop polled until the process was killed. Its test passed
  // because the fake supplied a number.
  const deadline = Date.parse(authorization.expiresAt);
  for (;;) {
    const result = await api.pollForToken(authorization.deviceCode);
    if (result !== 'pending') {
      // Best-effort: a login that cannot fetch a display name has still signed the user in, and
      // failing here would turn a working login into an error over a cosmetic field. Status
      // reports "identity unknown" in that case.
      const identity = await api.me(result.accessToken).catch(() => null);
      await writeCredential(input.apiHost, identity ? { ...result, identity } : result);
      return { status: 'authorized', sessionId: result.sessionId };
    }
    // The server's interval, never ours. It derives its own per-address rate limit from this
    // number, so polling faster is throttled partway through a login the user is completing.
    await sleep(authorization.intervalSeconds * 1000);
    // An unparseable expiry stops the loop rather than running it forever: "the server told me
    // something I cannot read" is a reason to give up, not a reason to keep asking.
    if (Number.isNaN(deadline) || now() >= deadline) return { status: 'expired' };
  }
}

export async function runLogout(apiHost: string): Promise<{ wasLoggedIn: boolean }> {
  const existing = await readCredential(apiHost);
  await clearCredential(apiHost);
  return { wasLoggedIn: existing !== null };
}
