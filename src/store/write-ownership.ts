import { getConfigRoot } from './database.js';

/**
 * Which repo owns knowledge written right now, or null outside a workspace.
 *
 * Joining a workspace backfills the items already present, but nothing stamped the ones
 * written afterwards, so every new item stayed unowned. In v1 that was survivable -- a
 * repo's database holds only its own items, so null effectively meant "mine" -- and it
 * showed up only as `workspace promote` refusing to touch anything written since the join.
 *
 * It stops being survivable the moment several repos share one database, because ownership
 * is what decides who may edit, collect, export or supersede an item. Stamping at write
 * time is the only point where the answer is known without guessing.
 *
 * Resolved lazily and cached per root: a write must not pay a manifest read, and the vast
 * majority of writes happen in projects with no workspace at all.
 */
let cache: { root: string; repo: string | null } | null = null;

/** Tests only: the cache is process-lifetime and would otherwise leak between fixtures. */
export function resetWriteOwnershipCache(): void {
  cache = null;
}

export async function resolveWritingRepo(): Promise<string | null> {
  let root: string;
  try {
    root = getConfigRoot();
  } catch {
    return null; // no open store: nothing to attribute
  }

  if (cache?.root === root) return cache.repo;

  let owner: string | null = null;
  try {
    // Imported lazily so the store layer keeps no static dependency on the workspace layer,
    // and so an unlinked project never loads it at all.
    const { resolveWorkspace } = await import('../workspace/resolve.js');
    const active = await resolveWorkspace(root);
    owner = active?.repo ?? null;
  } catch {
    owner = null; // a broken workspace must not block an ordinary write
  }

  cache = { root, repo: owner };
  return owner;
}
