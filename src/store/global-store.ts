import fs from 'node:fs/promises';
import path from 'node:path';
import { globalStorePath } from '../core/paths.js';
import { initDbPath } from './database.js';

/**
 * Create the global store if it is missing, and say which happened.
 *
 * Idempotent because every entry point calls it: `knowl init`, `knowl link global`, and the
 * project-less resolution path. The caller reports "created" only on the first one, so a second
 * `knowl init` does not claim to have made something that was already there.
 *
 * The config root is the Knowl home, so the store reads and writes with one embedding profile of
 * its own -- the property the layered reader depends on (see `namespaceFingerprint`).
 */
export async function ensureGlobalStore(): Promise<{ path: string; created: boolean }> {
  const target = globalStorePath();
  const existed = await fs.access(target).then(() => true, () => false);
  await fs.mkdir(path.dirname(target), { recursive: true });
  // Opening runs schema bootstrap; closing leaves a file the namespace reader can attach to.
  await initDbPath(target, { configRoot: path.dirname(target) });
  return { path: target, created: !existed };
}

/**
 * Check the paths on a global write, and return the note the caller prints.
 *
 * Two rules, both about honesty. A relative path in a store that spans repositories names
 * nothing, so it is refused. And nothing in `src/session/` reads the namespace query -- impact
 * detection, drift and evidence staleness are all project-store only -- so a path here is
 * provenance for a reader, never an index entry, and the write says so. A path that looks wired
 * up and is not is worse than no path at all.
 */
export function assertGlobalWrite(paths: string[]): string {
  const relative = paths.filter(entry => !path.isAbsolute(entry));
  if (relative.length > 0) {
    throw new Error(
      `Paths on a global atom must be absolute; the global store spans repositories, so `
      + `"${relative[0]}" names nothing. Use the full path, or store this in the project it belongs to.`,
    );
  }
  return 'Stored in the global namespace. Any paths are recorded for reference and are not indexed: '
    + 'impact detection and drift read the project store only.';
}
