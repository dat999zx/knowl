import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { resolveStorage } from '../store/storage-roles.js';
import { repoRegistryPath } from './repo-registry.js';

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
 * What makes it detectable is the known-repository registry: `~/.knowl/repos.json` records
 * every repository this machine has initialized or upgraded, which is precisely the event
 * that creates the database. Registered here, but no database file -- that file went away.
 *
 * config.json alone is not enough, and that is not hypothetical: `.knowl/config.json` can be
 * committed (`workspace add --force` exists for repositories that track it), so a fresh
 * clone legitimately has config and no database, and bootstrapping one there is correct. The
 * registry is machine-local, exactly like the database it vouches for.
 *
 * Fails open in every direction. A registry that was deleted, or a different `KNOWL_HOME`,
 * gives back the old silent-bootstrap behaviour rather than a false accusation -- an
 * unnecessary refusal in a working repository is worse than a missed warning.
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

/** Has this machine ever initialized or upgraded this repository? */
function isRegisteredRepo(root: string): boolean {
  try {
    const parsed = JSON.parse(readFileSync(repoRegistryPath(), 'utf8'));
    if (!Array.isArray(parsed?.repos)) return false;
    const target = path.resolve(root).toLowerCase();
    return parsed.repos.some(
      (entry: unknown) => typeof entry === 'string' && path.resolve(entry).toLowerCase() === target,
    );
  } catch {
    return false;
  }
}

/**
 * Throws when `root` is a repository this machine has opened before whose database file has
 * gone missing.
 *
 * Silent when the file is there, silent when `root` is not a repository at all -- that is
 * the caller's own question, and answering it here would turn every hook fired outside a
 * repository into an error (K-52) -- and silent for a repository this machine has never
 * initialized, which is a fresh clone rather than a loss.
 */
export function assertKnowledgeDatabasePresent(root: string): void {
  if (!isProjectRootSync(root)) return;
  const databasePath = resolveStorage(root).knowledge;
  if (existsSync(databasePath)) return;
  if (!isRegisteredRepo(root)) return;
  throw new MissingKnowledgeDatabaseError(root, databasePath);
}

/**
 * The same check for a command that has not resolved its own root yet.
 *
 * Commands that create or repair a store are exempt by name rather than by inspection:
 * `init` writes the database, and `upgrade` is the documented way to accept an empty one.
 * `doctor` has to be able to run precisely when something is wrong.
 *
 * `snapshot` is exempt because the error above names `knowl snapshot restore` as the first
 * recovery to try, and the guard was refusing it -- the one command the message prescribes was
 * the one it blocked. That left the operator with `upgrade` (which accepts the empty store the
 * guard exists to prevent) or `doctor`, and doctor used to rebuild the database and certify it.
 * Being exempt only skips this presence check; `snapshot restore` still verifies its source and
 * refuses an attachment with no `knowledge_items` of its own.
 */
const EXEMPT_COMMANDS = new Set(['init', 'upgrade', 'doctor', 'config', 'diagnose-startup', 'snapshot']);

export function assertDatabasePresentForCommand(commandName: string, cwd = process.cwd()): void {
  if (EXEMPT_COMMANDS.has(commandName)) return;
  const root = findProjectRootSync(cwd);
  if (!root) return;
  assertKnowledgeDatabasePresent(root);
}
