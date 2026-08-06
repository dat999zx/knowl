import fs from 'node:fs/promises';
import path from 'node:path';
import { isProjectRoot } from '../core/config.js';
import { knowlHome } from '../workspace/paths.js';

/**
 * Every Knowl repository this machine has initialized or upgraded.
 *
 * A workspace manifest names its member repos, but a repo linked to no workspace is known to
 * nothing outside its own directory -- so a command that wants to act on every repo on the
 * machine could only find it by walking the filesystem. This is the cheap alternative: the
 * commands that already visit a repo write its path down, and one visit is enough forever.
 *
 * Convenience state, deliberately not a source of truth. It is checked against the
 * filesystem on every read, a corrupt file is replaced rather than reported, and losing it
 * entirely costs one `knowl upgrade` per repo to rebuild.
 */
export function repoRegistryPath(): string {
  return path.join(knowlHome(), 'repos.json');
}

type Registry = { repos: string[] };

async function readRegistry(): Promise<Registry> {
  try {
    const parsed = JSON.parse(await fs.readFile(repoRegistryPath(), 'utf-8'));
    const repos = Array.isArray(parsed?.repos) ? parsed.repos.filter((entry: unknown) => typeof entry === 'string') : [];
    return { repos };
  } catch {
    return { repos: [] };
  }
}

async function writeRegistry(repos: string[]): Promise<void> {
  await fs.mkdir(path.dirname(repoRegistryPath()), { recursive: true });
  await fs.writeFile(repoRegistryPath(), `${JSON.stringify({ repos }, null, 2)}\n`, 'utf-8');
}

/** Remember a repository. Never throws: this must not be able to fail an upgrade. */
export async function recordKnownRepo(projectRoot: string): Promise<void> {
  try {
    const root = path.resolve(projectRoot);
    const registry = await readRegistry();
    if (registry.repos.some(entry => path.resolve(entry) === root)) return;

    await writeRegistry([...registry.repos, root].sort());
  } catch {
    // A machine-local convenience index is not worth failing the caller over.
  }
}

/**
 * What an entry turned out to be when the filesystem was asked.
 *
 * `live` and `forgotten` are both answers. `unverifiable` is the absence of one, and it is
 * the case that keeps this from being a one-line filter: an entry can be missing because the
 * checkout was deleted or because the volume holding it is not mounted right now, and only
 * the first of those should cost the user a registry line.
 */
type EntryVerdict = 'live' | 'forgotten' | 'unverifiable';

async function classify(root: string): Promise<EntryVerdict> {
  // Same marker as `isProjectRoot`, which is the whole point: this list feeds `upgrade --all`
  // and `doctor --fix`, and it used to be filtered on the bare existence of a `.knowl`
  // directory. `knowlHome()` is *also* called `.knowl`, so that predicate made the user's
  // home directory a repository (K-51). `discoverRepos` re-filtered correctly and hid it,
  // which made the disagreement survivable rather than harmless -- the next caller of this
  // exported function would have inherited the wrong answer instead of the re-filter.
  if (await isProjectRoot(root)) return 'live';

  // Not a repository *that we can see*. Whether that means "gone" or "not mounted" is
  // decided by the parent: if the directory that would contain it is readable, the
  // filesystem has positively told us this checkout is not there. If the parent is missing
  // too, we are looking at an unplugged drive and know nothing.
  try {
    await fs.stat(path.dirname(root));
    return 'forgotten';
  } catch {
    return 'unverifiable';
  }
}

export type KnownRepos = {
  /** Recorded paths that are Knowl repositories right now. */
  repos: string[];
  /** Paths dropped from the file because the filesystem says they are not repositories. */
  forgotten: string[];
};

/**
 * The registry, healed against the filesystem, and what healing removed.
 *
 * Pruned rather than merely filtered. Filtering on read leaves a dead entry to be re-read on
 * every sweep forever, and a dead entry is not inert: `upgrade --all` and `doctor --fix` act
 * on every path this returns, so a scratch directory that once ran `knowl init` keeps being
 * snapshotted and migrated long after anyone cared about it. That is the hazard
 * `vitest.config.ts` warns about in a comment, arriving through the registry instead.
 *
 * What is never pruned is an entry we could not check. A missing directory under a readable
 * parent is a deleted checkout; a missing directory whose parent is also missing is an
 * unmounted volume, and forgetting one of those would cost a repository per drive that
 * happened to be unplugged on the day someone ran an upgrade.
 *
 * The write is best-effort and only happens when something actually changed. A read-only or
 * absent home degrades to the old filter-on-read behaviour rather than failing the caller --
 * `assertKnowledgeDatabasePresent` reads this file to tell a moved database from a fresh
 * clone, and an empty registry silently disables that guard.
 */
export async function readKnownRepos(options: { persist?: boolean } = {}): Promise<KnownRepos> {
  // Self-healing is a *write*, and `upgrade --all --dry-run` called this before its own dry-run
  // guard -- so a command that closes with "Dry run: nothing was changed" permanently dropped
  // entries from the registry. That registry is what `upgrade --all` and `doctor --fix` act on,
  // and a repo whose checkout is momentarily absent (mid-clone, mid-restore, renamed) classifies
  // as forgotten, so an inspection could quietly narrow every future sweep. Callers that are
  // only looking pass `persist: false` and still get the same classification back to report.
  const { persist = true } = options;
  const registry = await readRegistry();

  const repos: string[] = [];
  const forgotten: string[] = [];
  const keep: string[] = [];

  for (const entry of registry.repos) {
    const root = path.resolve(entry);
    switch (await classify(root)) {
      case 'live':
        if (!repos.includes(root)) repos.push(root);
        keep.push(root);
        break;
      case 'forgotten':
        if (!forgotten.includes(root)) forgotten.push(root);
        break;
      case 'unverifiable':
        keep.push(root);
        break;
    }
  }

  if (forgotten.length > 0 && persist) {
    try {
      await writeRegistry([...new Set(keep)].sort());
    } catch {
      // Still reported as forgotten for this run; the next one will try the write again.
    }
  }

  return { repos: repos.sort(), forgotten: forgotten.sort() };
}

/** Recorded repositories that are still Knowl repositories. */
export async function listKnownRepos(): Promise<string[]> {
  return (await readKnownRepos()).repos;
}
