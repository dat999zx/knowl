import { AsyncLocalStorage } from 'node:async_hooks';
import { getConfigRoot } from './database.js';

/**
 * The repo whose session is running the current call, while it acts as a different repo.
 *
 * `resolveWriteDefaults` answers "who owns what I am writing", and once a call has been rebound
 * to a linked repo that answer is the TARGET -- correctly, since the atom really is the
 * target's. What it can no longer answer is who did the work, because the ambient context it
 * reads has already been replaced. So the caller's name rides beside the swap rather than being
 * derived from it.
 *
 * `AsyncLocalStorage` for the same reason the database swap uses it: a module-level variable
 * would leak the caller's identity into every concurrent operation in the process, and an MCP
 * server serves calls from one repo while another is mid-hop.
 */
const authorScope = new AsyncLocalStorage<string>();

/** Run `run` recording `callerRepo` as the author of anything it writes. */
export function runAsAuthor<T>(callerRepo: string, run: () => Promise<T>): Promise<T> {
  return authorScope.run(callerRepo, run);
}

/** The acting repo, or null when a call is simply running where it stands. */
export function currentAuthorRepo(): string | null {
  return authorScope.getStore() ?? null;
}

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
/** Everything `createKnowledgeItem` needs from the workspace, resolved together and cached once. */
export type WriteDefaults = { repo: string | null; visibility: 'repo' | 'workspace' };

const UNLINKED: WriteDefaults = { repo: null, visibility: 'repo' };

let cache: { root: string; defaults: WriteDefaults } | null = null;

/** Tests only: the cache is process-lifetime and would otherwise leak between fixtures. */
export function resetWriteOwnershipCache(): void {
  cache = null;
}

/**
 * Owner and default visibility for knowledge written right now.
 *
 * Both come from the same manifest entry, so they are resolved in one pass and cached
 * together. Resolving visibility separately would mean a second `loadConfig` read and JSON
 * parse per write -- which is exactly the 2.7.0 regression that killed the process at around
 * 2000 writes and that 2.7.1 fixed by caching this lookup per root.
 *
 * The cache is process-lifetime, so `workspace set --default-visibility` -- a separate CLI
 * process -- does not reach a long-lived MCP server until its next start. That is stated in
 * the command's output rather than fixed here: the stale window ends at the next session, and
 * it fails toward whichever value was already in effect.
 */
export async function resolveWriteDefaults(): Promise<WriteDefaults> {
  let root: string;
  try {
    root = getConfigRoot();
  } catch {
    return UNLINKED; // no open store: nothing to attribute
  }

  if (cache?.root === root) return cache.defaults;

  let defaults = UNLINKED;
  try {
    // Imported lazily so the store layer keeps no static dependency on the workspace layer,
    // and so an unlinked project never loads it at all.
    const { resolveWorkspace } = await import('../workspace/resolve.js');
    const { defaultVisibilityOf } = await import('../workspace/repo-settings.js');
    const active = await resolveWorkspace(root);
    if (active) {
      defaults = { repo: active.repo, visibility: defaultVisibilityOf(active.manifest, active.repo) };
    }
  } catch {
    defaults = UNLINKED; // a broken workspace must not block an ordinary write
  }

  cache = { root, defaults };
  return defaults;
}

export async function resolveWritingRepo(): Promise<string | null> {
  return (await resolveWriteDefaults()).repo;
}
