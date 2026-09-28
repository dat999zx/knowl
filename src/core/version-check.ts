import fs from 'node:fs/promises';
import path from 'node:path';

// Knowl is local-first, so the update check is deliberately unobtrusive: the network is
// touched only by `status`, `doctor`, and the MCP server at start (fire-and-forget, so no one
// waits on it). Hooks read the cache only. The answer is cached for a day, the fetch times out
// fast, and every failure is silent. The session-start card names a newer release once, and
// `notifiedVersion` in the same cache file is what makes it once.
const REGISTRY_BASE = 'https://registry.npmjs.org';
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 2_000;

export type UpdateCheckResult = { current: string; latest: string; updateAvailable: boolean };
type CacheEntry = { checkedAt: string; latest: string; notifiedVersion?: string };

export function compareVersions(left: string, right: string): number {
  const parts = (value: string) => value.replace(/^v/, '').split('-')[0].split('.').map(part => Number(part) || 0);
  const a = parts(left);
  const b = parts(right);
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const diff = (a[index] ?? 0) - (b[index] ?? 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

/** Update checks are opt-out via config or the usual environment conventions. */
export function isUpdateCheckEnabled(config?: { updateCheck?: { enabled?: boolean } } | null): boolean {
  if (process.env.KNOWL_NO_UPDATE_CHECK || process.env.NO_UPDATE_NOTIFIER) return false;
  return config?.updateCheck?.enabled !== false;
}

async function readCache(cacheFile: string, ttlMs: number): Promise<string | null> {
  // A non-positive TTL means "do not use the cache", decided before any clock is read.
  //
  // The age comparison alone does not deliver that. `age > ttlMs` at `ttlMs: 0` still serves the
  // cache when both calls land in the same millisecond, because 0 is not greater than 0 -- so
  // `knowl doctor`, which passes 0 precisely to force a fresh answer, could quietly return the
  // cached one. Caught by CI on macOS, where the runner was fast enough for the write and the
  // read to share a tick; ubuntu and windows both passed and hid it.
  if (ttlMs <= 0) return null;
  try {
    const entry = JSON.parse(await fs.readFile(cacheFile, 'utf-8')) as CacheEntry;
    const age = Date.now() - new Date(entry.checkedAt).getTime();
    if (!Number.isFinite(age) || age < 0 || age > ttlMs) return null;
    return typeof entry.latest === 'string' ? entry.latest : null;
  } catch {
    return null;
  }
}

async function readEntry(cacheFile: string): Promise<CacheEntry | null> {
  try {
    const entry = JSON.parse(await fs.readFile(cacheFile, 'utf-8')) as CacheEntry;
    return entry && typeof entry.latest === 'string' ? entry : null;
  } catch {
    return null;
  }
}

const cacheFileFor = (projectRoot: string): string => path.join(projectRoot, '.knowl', 'cache', 'update-check.json');

/**
 * What the cache says, whatever its age, and without a fetch: the hook path's only view of the
 * registry. `notified` is whether the session card already named this release.
 */
export async function readCachedUpdate(
  projectRoot: string,
  currentVersion: string,
): Promise<{ latest: string; updateAvailable: boolean; notified: boolean } | null> {
  const entry = await readEntry(cacheFileFor(projectRoot));
  if (!entry) return null;
  return {
    latest: entry.latest,
    updateAvailable: compareVersions(entry.latest, currentVersion) > 0,
    notified: entry.notifiedVersion === entry.latest,
  };
}

/** Record that the session card named `version`, so it is not named again. */
export async function markUpdateNotified(projectRoot: string, version: string): Promise<void> {
  const cacheFile = cacheFileFor(projectRoot);
  const entry = await readEntry(cacheFile);
  if (!entry) return;
  try {
    await fs.writeFile(cacheFile, JSON.stringify({ ...entry, notifiedVersion: version }), 'utf-8');
  } catch {
    // a non-writable cache must not break the hook
  }
}

async function fetchLatest(packageName: string, fetchImpl: typeof fetch): Promise<string | null> {
  // An unref'd timer plus `connection: close` keeps this check from holding the
  // event loop open — a CLI command must not linger seconds after its output.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  timer.unref?.();
  try {
    // `/g`, not a bare string: a string pattern replaces the first match only, so a name with a
    // second slash would put a live path separator in the URL and the request would land on a
    // different registry route. Scoped names carry exactly one today; the escape should not
    // depend on that staying true. `@` is left alone -- the registry expects `@scope%2Fname`.
    const response = await fetchImpl(`${REGISTRY_BASE}/${packageName.replace(/\//g, '%2F')}/latest`, {
      signal: controller.signal,
      headers: { accept: 'application/vnd.npm.install-v1+json, application/json', connection: 'close' },
    });
    if (!response.ok) return null;
    const body = await response.json() as { version?: string };
    return typeof body.version === 'string' ? body.version : null;
  } catch {
    return null; // offline, blocked, slow, or malformed — never surface an error
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Resolve the newest published version, preferring a fresh cache entry.
 * Returns null when the check is disabled or the version could not be determined.
 */
export async function checkForUpdate(options: {
  packageName: string;
  currentVersion: string;
  projectRoot: string;
  ttlMs?: number;
  fetchImpl?: typeof fetch;
  now?: Date;
}): Promise<UpdateCheckResult | null> {
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const cacheFile = cacheFileFor(options.projectRoot);

  let latest = await readCache(cacheFile, ttlMs);
  if (!latest) {
    latest = await fetchLatest(options.packageName, options.fetchImpl ?? fetch);
    if (latest) {
      const previous = await readEntry(cacheFile);
      const entry: CacheEntry = {
        checkedAt: (options.now ?? new Date()).toISOString(),
        latest,
        ...(previous?.notifiedVersion ? { notifiedVersion: previous.notifiedVersion } : {}),
      };
      try {
        await fs.mkdir(path.dirname(cacheFile), { recursive: true });
        await fs.writeFile(cacheFile, JSON.stringify(entry), 'utf-8');
      } catch {
        // a non-writable cache must not break the command
      }
    }
  }

  if (!latest) return null;
  return {
    current: options.currentVersion,
    latest,
    updateAvailable: compareVersions(latest, options.currentVersion) > 0,
  };
}

export function formatUpdateNotice(result: UpdateCheckResult, packageName: string): string {
  return [
    '',
    `📦 Update available: ${result.current} → ${result.latest}`,
    `   npm install -g ${packageName}`,
  ].join('\n');
}
