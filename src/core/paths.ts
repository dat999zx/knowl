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
