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

export type LoginResult = { status: 'authorized'; userId: string } | { status: 'expired' };

export async function runLogin(input: LoginInput): Promise<LoginResult> {
  const api = input.api ?? createCloudApi({ apiHost: input.apiHost });
  const sleep = input.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const now = input.now ?? Date.now;

  const authorization = await api.startDeviceAuthorization();
  input.onPrompt(authorization);

  const deadline = now() + authorization.expiresInSeconds * 1000;
  for (;;) {
    const result = await api.pollForToken(authorization.deviceCode);
    if (result !== 'pending') {
      await writeCredential(input.apiHost, result);
      return { status: 'authorized', userId: result.userId };
    }
    // The server's interval, never ours. It derives its own per-address rate limit from this
    // number, so polling faster is throttled partway through a login the user is completing.
    await sleep(authorization.intervalSeconds * 1000);
    if (now() >= deadline) return { status: 'expired' };
  }
}

export async function runLogout(apiHost: string): Promise<{ wasLoggedIn: boolean }> {
  const existing = await readCredential(apiHost);
  await clearCredential(apiHost);
  return { wasLoggedIn: existing !== null };
}
