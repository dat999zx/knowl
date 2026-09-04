import os from 'node:os';
import path from 'node:path';

/**
 * Root for machine-local Knowl state that is not tied to one project.
 *
 * A workspace lives here rather than inside any member repo: putting it in one would make
 * that repo special, break when it is deleted, and risk it being committed.
 *
 * This lives in `core/` rather than in `workspace/` because it is not a workspace idea. The
 * model cache, the repo registry, the resume store and the startup trace all resolve against
 * it and have nothing to do with multi-repo workspaces — `core/startup-trace.ts` reaching
 * into `workspace/` for it was the clearest sign it had been filed in the wrong place.
 * `workspace/paths.ts` keeps the paths that genuinely are workspace-shaped.
 */
export function knowlHome(): string {
  const override = process.env.KNOWL_HOME;
  return override ? path.resolve(override) : path.join(os.homedir(), '.knowl');
}

/**
 * The machine-wide personal-defaults store.
 *
 * A file under the home rather than a project at it: `knowlHome()` IS `~/.knowl`, so a project
 * rooted at `~` would put its store at `~/.knowl/knowl.db`, in the directory that already holds
 * `models/`, `cache/`, `repos.json`, `fleet.db` and `credentials.json`. `scaffoldTarget` refuses
 * that case by name, and this is the shape `externalNamespace` already expects: an explicit path,
 * outside any project.
 */
export function globalStorePath(): string {
  return path.join(knowlHome(), 'global.db');
}

/**
 * One cloud replica per workspace, under `cloud/` rather than `workspaces/`.
 *
 * `workspaces/` holds OSS workspace manifests keyed by a name matching `^[a-z0-9][a-z0-9-]*$`,
 * which a cloud workspace id also matches -- so sharing the tree would let a cloud replica and
 * a local workspace occupy the same directory with no error at either end.
 *
 * These live in `core/` rather than beside the replica's code for the same reason `knowlHome`
 * does: `workspace/resolve.ts` has to name the replica's file to report whether it is present,
 * and `cloud/` sits ABOVE `workspace/` in the layer order, so reaching up for it is forbidden.
 * A path is not a cloud idea -- what `cloud/` owns is the database at the end of it.
 */
export function teamStoreDir(workspaceId: string): string {
  return path.join(knowlHome(), 'cloud', workspaceId);
}

export function teamStorePath(workspaceId: string): string {
  return path.join(teamStoreDir(workspaceId), 'knowledge.db');
}
