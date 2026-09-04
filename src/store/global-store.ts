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
