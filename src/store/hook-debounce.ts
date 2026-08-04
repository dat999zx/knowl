import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { canonicalProjectRoot } from '../core/project-path.js';
import { NormalizedHostHook } from '../cli/agents/host-hook.js';
import { HOOK_CAPTURE_DEBOUNCE_MS, sweepDebounceClaims } from './retention.js';

// The window and the lifetime of the file that enforces it are one decision, so they are
// made in one place. Re-exported because this is where every caller already looks for it.
export { HOOK_CAPTURE_DEBOUNCE_MS };

function cacheDir(projectRoot: string): string {
  return path.join(projectRoot, '.knowl', 'cache', 'hook-debounce');
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  const record = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort()) out[key] = stableValue(record[key]);
  return out;
}

export function captureFingerprint(
  input: Pick<NormalizedHostHook, 'event' | 'type' | 'payload' | 'status' | 'captureKey'>,
): string {
  const payload = input.payload ?? {};
  const changedPaths = Array.isArray(payload.changedPaths)
    ? [...payload.changedPaths].filter((value): value is string => typeof value === 'string').sort()
    : undefined;
  const fingerprint = {
    event: input.event,
    type: input.type ?? null,
    status: input.status ?? null,
    command: typeof payload.command === 'string' ? payload.command : null,
    summary: typeof payload.summary === 'string' ? payload.summary : null,
    message: typeof payload.message === 'string' ? payload.message : null,
    changedPaths: changedPaths ?? null,
    exitCode: typeof payload.exitCode === 'number' ? payload.exitCode : null,
    passed: typeof payload.passed === 'boolean' ? payload.passed : null,
    // Without this every non-shell tool event in a session hashes the same, because its
    // payload is only `summary: "<Tool> completed"`. Two different reads a few hundred
    // milliseconds apart then counted as one and the second was discarded unprocessed.
    captureKey: input.captureKey ?? null,
  };
  return JSON.stringify(stableValue(fingerprint));
}

function debounceKey(input: NormalizedHostHook, fingerprint: string): string {
  return [
    input.host,
    // Same canonicalisation as the binding key: an unfolded root gave one agent two
    // debounce namespaces on Windows, so duplicate captures slipped through.
    canonicalProjectRoot(input.projectRoot),
    input.externalSessionId,
    input.externalTurnId ?? '',
    fingerprint,
  ].join('|');
}

function claimPath(projectRoot: string, key: string): string {
  const digest = crypto.createHash('sha256').update(key).digest('hex');
  return path.join(cacheDir(projectRoot), `${digest}.claim`);
}

function isDebounceEligible(input: NormalizedHostHook): boolean {
  if (input.event !== 'session-event' && input.event !== 'checkpoint') return false;
  if (input.type === 'error' || input.status === 'failed') return false;
  return true;
}

function readClaimTimestamp(filePath: string): number | undefined {
  try {
    const raw = fs.readFileSync(filePath, 'utf8').trim();
    const value = Number(raw);
    return Number.isFinite(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Atomically claims a capture fingerprint for the debounce window.
 * Returns true when this caller should process the capture.
 * Returns false when a recent claim already exists (duplicate).
 * Fail-open on unexpected IO errors so host hooks never hard-fail.
 */
export function claimCapture(input: NormalizedHostHook, now = Date.now()): boolean {
  if (!isDebounceEligible(input)) return true;

  const fingerprint = captureFingerprint(input);
  const key = debounceKey(input, fingerprint);
  const filePath = claimPath(input.projectRoot, key);

  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
  } catch {
    return true;
  }

  // One claim file per tool call was written and none was ever removed: 7,134 of them in one
  // repository, essentially the entire file count of a 3.95 GB directory, every one of them
  // dead 1500 ms after it was written. Swept here rather than in a maintenance command,
  // because this is the only code that ever visits the directory. Bounded, so the first pass
  // over a grown one costs a few milliseconds of an agent's turn and the rest drains over
  // the following calls.
  sweepDebounceClaims(cacheDir(input.projectRoot), now);

  try {
    const fd = fs.openSync(filePath, 'wx');
    try {
      fs.writeFileSync(fd, `${now}\n`, 'utf8');
    } finally {
      fs.closeSync(fd);
    }
    return true;
  } catch (error: any) {
    if (error?.code !== 'EEXIST') return true;

    const previous = readClaimTimestamp(filePath);
    if (previous !== undefined && now - previous <= HOOK_CAPTURE_DEBOUNCE_MS) {
      return false;
    }

    try {
      fs.unlinkSync(filePath);
    } catch {
      return true;
    }

    try {
      const fd = fs.openSync(filePath, 'wx');
      try {
        fs.writeFileSync(fd, `${now}\n`, 'utf8');
      } finally {
        fs.closeSync(fd);
      }
      return true;
    } catch (retryError: any) {
      if (retryError?.code === 'EEXIST') {
        const raced = readClaimTimestamp(filePath);
        if (raced !== undefined && now - raced <= HOOK_CAPTURE_DEBOUNCE_MS) return false;
      }
      return true;
    }
  }
}

/** Best-effort release used when capture fails after a successful claim. */
export function releaseCapture(input: NormalizedHostHook): void {
  if (!isDebounceEligible(input)) return;
  try {
    const fingerprint = captureFingerprint(input);
    const key = debounceKey(input, fingerprint);
    fs.unlinkSync(claimPath(input.projectRoot, key));
  } catch {
    // Best-effort only.
  }
}

/** @deprecated Prefer claimCapture; kept for narrow unit tests of skip semantics. */
export function shouldSkipDuplicateCapture(input: NormalizedHostHook, now = Date.now()): boolean {
  if (!isDebounceEligible(input)) return false;
  const fingerprint = captureFingerprint(input);
  const key = debounceKey(input, fingerprint);
  const previous = readClaimTimestamp(claimPath(input.projectRoot, key));
  return previous !== undefined && now - previous <= HOOK_CAPTURE_DEBOUNCE_MS;
}

/** @deprecated Prefer claimCapture which records atomically. */
export function rememberCapture(input: NormalizedHostHook, now = Date.now()): void {
  claimCapture(input, now);
}
