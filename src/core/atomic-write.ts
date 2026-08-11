import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Errors that mean "someone else has the destination open right now", not "this cannot work".
 *
 * Windows refuses a rename onto a path any other handle still holds, and the usual holder is an
 * antivirus or the search indexer reading the temporary file this function just finished writing
 * -- so the very act of creating the file is what provokes the block. It clears on its own in
 * tens of milliseconds.
 *
 * Deliberately narrow. `ENOENT` means the staged file is gone, which is a bug rather than
 * contention, and `ENOSPC` will not improve by asking again; retrying either would turn a clear
 * failure into a slow one.
 */
const CONTENDED = new Set(['EPERM', 'EACCES', 'EBUSY']);

/** Attempts, and the backoff before each retry. ~150 ms in the worst case, imperceptible. */
const RENAME_ATTEMPTS = 5;
const RENAME_BACKOFF_MS = 10;

/**
 * `fs.rename`, surviving a destination another process has open for a moment.
 *
 * Not platform-gated, though Windows is where it fires: a network or virtualised filesystem can
 * report the same contention anywhere, and a retry that never triggers costs nothing.
 *
 * The original error is what escapes when the attempts run out. A wrapper naming the retry would
 * put this function in front of the fact the caller needs -- which file, and why.
 */
async function renameWithRetry(staged: string, target: string): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await fs.rename(staged, target);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? '';
      if (attempt >= RENAME_ATTEMPTS || !CONTENDED.has(code)) throw error;
      // Linear, not exponential: this waits out a virus scanner reading one small file, and the
      // whole budget is smaller than a single exponential step would grow to.
      await new Promise(resolve => setTimeout(resolve, RENAME_BACKOFF_MS * attempt));
    }
  }
}

/**
 * Replace a file's contents in one observable step.
 *
 * A direct `writeFile` truncates first, so an interrupted write leaves a half file that
 * `loadConfig` cannot parse, and two concurrent writers can interleave. The temporary lives in
 * the same directory so the rename stays on one filesystem, and the contents are flushed before
 * the rename makes them visible.
 *
 * `mode` is applied at create time and again after, because a permissive umask can widen the
 * mode passed to `open`.
 *
 * **The rename retries, and that is load-bearing rather than defensive.** It was the single most
 * frequent cause of a red Windows run in this repository -- `EPERM: operation not permitted,
 * rename '<file>.tmp' -> '<file>'`, always a different file, never reproducible in isolation, and
 * for months answered by re-running the leg. It is not only a test problem: every caller here
 * writes a file a user cares about, so the same moment makes `knowl init` fail on a Windows
 * machine with an antivirus, which is most of them.
 */
export async function writeFileAtomic(
  target: string,
  contents: string,
  options: { mode?: number } = {},
): Promise<void> {
  const directory = path.dirname(target);
  const staged = path.join(directory, `.${path.basename(target)}.${crypto.randomUUID().slice(0, 8)}.tmp`);
  await fs.mkdir(directory, { recursive: true });
  try {
    const handle = await fs.open(staged, 'w', options.mode);
    try {
      await handle.writeFile(contents, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (options.mode !== undefined) await fs.chmod(staged, options.mode).catch(() => {});
    await renameWithRetry(staged, target);
  } catch (error) {
    await fs.rm(staged, { force: true }).catch(() => {});
    throw error;
  }
}
