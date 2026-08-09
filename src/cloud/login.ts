import { createCloudApi, type CloudApi, type DeviceAuthorization } from './api-client.js';
import { clearCredential, readCredential, writeCredential } from './credentials.js';

export const DEFAULT_API_HOST = 'https://api.knowl.dev';

export type LoginInput = {
  apiHost: string;
  api?: CloudApi;
  /** Called once, before the first poll, so the user can read the code and act on it. */
  onPrompt: (authorization: DeviceAuthorization) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
};

export type LoginResult = { status: 'authorized'; sessionId: string } | { status: 'expired' };

export async function runLogin(input: LoginInput): Promise<LoginResult> {
  const api = input.api ?? createCloudApi({ apiHost: input.apiHost });
  const sleep = input.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const now = input.now ?? Date.now;

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
      await writeCredential(input.apiHost, result);
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
