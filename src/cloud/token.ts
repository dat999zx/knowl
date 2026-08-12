import path from 'node:path';
import { knowlHome } from '../core/paths.js';
import { acquireLock } from './file-lock.js';
import { readCredential, writeCredential, type CloudCredential } from './credentials.js';

/** Refresh this long before expiry, so a request in flight does not 401 on arrival. */
const DEFAULT_SKEW_MS = 60_000;
/** How long a loser waits for the winner's write before giving up and reporting no token. */
const DEFAULT_WAIT_MS = 5_000;
const POLL_MS = 50;

export type EnsureTokenInput = {
  apiHost: string;
  refresh: (refreshToken: string) => Promise<CloudCredential>;
  now?: () => number;
  skewMs?: number;
  waitMs?: number;
  /**
   * Test seam, and the only way to reach the re-read below.
   *
   * That re-read guards one interleaving: another process wins the lock, refreshes, writes and
   * releases, all between OUR first read and OUR acquisition -- so we hold the lock with a
   * `current` that has already been rotated. A caller that LOSES the lock cannot stand in for
   * this, because the poll loop tests the same `usable` predicate the re-read does and
   * therefore always returns first. Without a seam here the line is unreachable in-process and
   * deleting it changes no test, which is exactly how it was found missing.
   */
  onBeforeLock?: () => Promise<void>;
};

export function credentialLockPath(): string {
  return path.join(knowlHome(), 'credentials.lock');
}

function usable(credential: CloudCredential | null, now: number, skewMs: number): boolean {
  if (!credential) return false;
  const expiresAt = Date.parse(credential.expiresAt);
  // An unparseable expiry is treated as expired. Guessing "probably fine" here would send a
  // dead token on every request and surface as an unexplained 401 instead of a refresh.
  if (Number.isNaN(expiresAt)) return false;
  return expiresAt - skewMs > now;
}

/**
 * The same predicate, for callers outside the refresh path.
 *
 * Exported rather than reimplemented because the skew window and the unparseable-expiry rule are
 * both easy to get subtly wrong, and a second copy would drift from this one silently. `runLogin`
 * asks exactly this question before deciding whether a device-code flow is needed at all.
 */
export function isCredentialUsable(
  credential: CloudCredential | null,
  now: number = Date.now(),
  skewMs: number = DEFAULT_SKEW_MS,
): boolean {
  return usable(credential, now, skewMs);
}

/**
 * One refresh per rotation, however many processes want one.
 *
 * The server revokes the entire session when it sees a refresh token replayed, so two
 * concurrent refreshes are not a wasted request -- the loser replays a rotated token and the
 * user is logged out mid-session with nothing to explain it.
 *
 * The re-read AFTER taking the lock is the whole mechanism. Without it the winner refreshes
 * whatever it read before waiting, which is exactly the token the previous holder just
 * rotated away.
 */
export async function ensureAccessToken(input: EnsureTokenInput): Promise<CloudCredential | null> {
  const now = input.now ?? Date.now;
  const skewMs = input.skewMs ?? DEFAULT_SKEW_MS;
  const waitMs = input.waitMs ?? DEFAULT_WAIT_MS;

  const current = await readCredential(input.apiHost);
  if (!current) return null;
  if (usable(current, now(), skewMs)) return current;

  if (input.onBeforeLock) await input.onBeforeLock();

  const release = await acquireLock(credentialLockPath());
  if (!release) {
    // Someone else is refreshing. Poll their write rather than queueing behind them; if they
    // die, the lock goes stale and the next caller breaks it.
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, POLL_MS));
      const landed = await readCredential(input.apiHost);
      if (usable(landed, now(), skewMs)) return landed;
    }
    return null;
  }

  try {
    const held = await readCredential(input.apiHost);
    if (usable(held, now(), skewMs)) return held;
    if (!held) return null;

    const refreshed = await input.refresh(held.refreshToken);
    await writeCredential(input.apiHost, refreshed);
    return refreshed;
  } finally {
    await release();
  }
}
