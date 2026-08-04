import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { resolveStorage } from '../store/storage-roles.js';

/**
 * A missing database file is a missing file, not an empty memory.
 *
 * Opening a libSQL `file:` URL creates it, and bootstrap then writes a current, empty schema
 * into it. From the inside that is indistinguishable from the first run in a new repository,
 * so it succeeds, says nothing, and exits 0. From the outside -- a file that moved, a
 * restore half-finished, a sync tool mid-copy, a backup script that renamed it -- the next
 * `knowl status` reports `Active: 0` and the store has apparently forgotten everything. The
 * empty schema then *is* the store, and the next write is written into it.
 *
 * The distinction that makes this detectable is the one K-51 introduced: an initialized
 * repository is marked by `.knowl/config.json`, which `knowl init` writes *before* it opens
 * the database. So config.json present and the database file absent is not a state any
 * healthy sequence produces -- it means the file went away after the repository existed.
 *
 * Deliberately synchronous. It runs from a commander `preAction` hook, and making that async
 * would mean moving the whole CLI onto `parseAsync` for one `stat`.
 */

export class MissingKnowledgeDatabaseError extends Error {
  constructor(public readonly projectRoot: string, public readonly databasePath: string) {
    super(
      `Knowl's database is missing: ${databasePath}\n` +
      `${projectRoot} is an initialized Knowl repository, but its database file is not there.\n` +
      `Nothing has been recreated -- an empty store written over a missing one is how a moved ` +
      `file reads as lost memory.\n` +
      `  - a restore or a copy still in flight: wait for it, or put the file back\n` +
      `  - a snapshot to restore from: knowl snapshot restore <path> --confirm\n` +
      `  - genuinely starting this repository's memory over: knowl upgrade`,
    );
    this.name = 'MissingKnowledgeDatabaseError';
  }
}

/** Same marker as `isProjectRoot`, synchronously, for the preAction guard. */
function isProjectRootSync(candidate: string): boolean {
  try {
    return statSync(path.join(candidate, '.knowl', 'config.json')).isFile();
  } catch {
    return false;
  }
}

/** The enclosing initialized repository, or null when there is none. */
export function findProjectRootSync(startPath: string): string | null {
  let current = path.resolve(startPath);
  for (;;) {
    if (isProjectRootSync(current)) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/**
 * Throws when `root` is an initialized repository whose database file has gone missing.
 *
 * Silent when the file is there, and silent when `root` is not a repository at all -- that
 * is the caller's own question, and answering it here would turn every hook fired outside a
 * repository into an error (K-52).
 */
export function assertKnowledgeDatabasePresent(root: string): void {
  if (!isProjectRootSync(root)) return;
  const databasePath = resolveStorage(root).knowledge;
  if (existsSync(databasePath)) return;
  throw new MissingKnowledgeDatabaseError(root, databasePath);
}

/**
 * The same check for a command that has not resolved its own root yet.
 *
 * Commands that create or repair a store are exempt by name rather than by inspection:
 * `init` writes the database, and `upgrade` is the documented way to accept an empty one.
 * `doctor` has to be able to run precisely when something is wrong.
 */
const EXEMPT_COMMANDS = new Set(['init', 'upgrade', 'doctor', 'config', 'diagnose-startup']);

export function assertDatabasePresentForCommand(commandName: string, cwd = process.cwd()): void {
  if (EXEMPT_COMMANDS.has(commandName)) return;
  const root = findProjectRootSync(cwd);
  if (!root) return;
  assertKnowledgeDatabasePresent(root);
}
