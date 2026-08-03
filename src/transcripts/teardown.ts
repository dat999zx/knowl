import fs from 'node:fs/promises';
import type { ProjectConfig } from '../core/types.js';
import { resolveStorage } from '../store/storage-roles.js';
import { isTranscriptSearchEnabled } from './config.js';
import { closeTranscriptDb } from './database.js';

export type TranscriptTeardownResult = {
  removed: boolean;
  /** Total bytes reclaimed across the database and its sidecars. */
  bytes: number;
  /** Set when the files could not be removed, naming why. */
  error: string | null;
};

const SIDECARS = ['', '-wal', '-shm'];

async function sizeOf(target: string): Promise<number> {
  return fs.stat(target).then(stat => stat.size, () => 0);
}

/**
 * Remove `.knowl/transcripts.db` and its WAL sidecars.
 *
 * Called on the `search.transcripts.enabled` true -> false transition. Leaving the file behind
 * would keep a copy of the archive's terms and vectors that nothing will ever refresh, belonging
 * to the one user who explicitly declined to keep it. "Off" has to mean the file is gone.
 *
 * **Nothing here opens the database, and that is the whole design.** Measured on Windows: a
 * process that has opened a libSQL file cannot unlink it for the rest of its life -- not after
 * `close()`, not after a TRUNCATE checkpoint, not after five seconds of retries, and not even
 * when the open was read-only. A process that has never opened it deletes it instantly. So
 * counting the rows first, which is the obvious way to report what was discarded, is precisely
 * what makes the deletion fail. The size on disk answers the same question and `fs.stat` takes
 * no handle.
 */
export async function removeTranscriptIndex(projectRoot: string): Promise<TranscriptTeardownResult> {
  const dbPath = resolveStorage(projectRoot).transcripts;

  if (await sizeOf(dbPath) === 0 && !(await fs.access(dbPath).then(() => true, () => false))) {
    return { removed: false, bytes: 0, error: null };
  }

  let bytes = 0;
  for (const suffix of SIDECARS) bytes += await sizeOf(`${dbPath}${suffix}`);

  // Release anything this process is holding. It does not make the file deletable on Windows
  // if we ever opened it, but it is required on the path where a caller did open it and is
  // correct everywhere else.
  await closeTranscriptDb(dbPath).catch(() => {});

  try {
    for (const suffix of SIDECARS) await fs.rm(`${dbPath}${suffix}`, { force: true });
  } catch (error) {
    return { removed: false, bytes, error: (error as Error).message };
  }

  return { removed: true, bytes, error: null };
}

/**
 * Apply whatever a config change implies for the transcript index.
 *
 * Every mutation path routes through here -- the interactive editor, `knowl config set`, and
 * `knowl config reset`. Wiring only the editor would mean `knowl config set
 * search.transcripts.enabled false` leaves the index on disk, which is the same bug in a
 * different command.
 */
export async function applyTranscriptConfigTransition(
  projectRoot: string,
  before: ProjectConfig,
  after: ProjectConfig,
): Promise<TranscriptTeardownResult> {
  const wasOn = isTranscriptSearchEnabled(before);
  const isOn = isTranscriptSearchEnabled(after);
  if (!wasOn || isOn) return { removed: false, bytes: 0, error: null };
  return removeTranscriptIndex(projectRoot);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** One line for the CLI to print, or null when nothing happened. */
export function describeTranscriptTeardown(result: TranscriptTeardownResult): string | null {
  if (result.removed) return `Removed the transcript index (${formatBytes(result.bytes)} reclaimed).`;
  // A failed removal is worth saying: the feature is off but the data is still on disk, and the
  // user asked for it to be gone.
  if (result.error) {
    return `Could not remove the transcript index at this time (${result.error}). It is no longer used; delete .knowl/transcripts.db to reclaim the space.`;
  }
  return null;
}
