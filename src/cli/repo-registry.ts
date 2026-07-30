import fs from 'node:fs/promises';
import path from 'node:path';
import { knowlHome } from '../workspace/paths.js';

/**
 * Every Knowl repository this machine has initialized or upgraded.
 *
 * A workspace manifest names its member repos, but a repo linked to no workspace is known to
 * nothing outside its own directory -- so a command that wants to act on every repo on the
 * machine could only find it by walking the filesystem. This is the cheap alternative: the
 * commands that already visit a repo write its path down, and one visit is enough forever.
 *
 * Convenience state, deliberately not a source of truth. It is filtered against the
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

/** Remember a repository. Never throws: this must not be able to fail an upgrade. */
export async function recordKnownRepo(projectRoot: string): Promise<void> {
  try {
    const root = path.resolve(projectRoot);
    const registry = await readRegistry();
    if (registry.repos.some(entry => path.resolve(entry) === root)) return;

    const repos = [...registry.repos, root].sort();
    await fs.mkdir(path.dirname(repoRegistryPath()), { recursive: true });
    await fs.writeFile(repoRegistryPath(), `${JSON.stringify({ repos }, null, 2)}\n`, 'utf-8');
  } catch {
    // A machine-local convenience index is not worth failing the caller over.
  }
}

/**
 * Recorded repositories that are still Knowl repositories.
 *
 * Filtered rather than pruned: a checkout can be absent because it was deleted or because
 * the drive holding it is not mounted right now, and only one of those should forget it.
 */
export async function listKnownRepos(): Promise<string[]> {
  const registry = await readRegistry();
  const live: string[] = [];

  for (const entry of registry.repos) {
    const root = path.resolve(entry);
    try {
      await fs.access(path.join(root, '.knowl'));
      if (!live.includes(root)) live.push(root);
    } catch {
      // Not a Knowl repository (any more).
    }
  }

  return live.sort();
}
