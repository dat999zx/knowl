import type { ProjectConfig } from './types.js';

/**
 * What is on disk, narrowed to the case where it points somewhere.
 *
 * Deliberately not `CloudPointer` from `connect.ts`: that type describes what `connect` writes,
 * and the stored block also carries `autoStage`, which a caller reads from the same object.
 */
export type ConnectedCloud =
  NonNullable<ProjectConfig['cloud']> & { apiHost: string; workspaceId: string };

/**
 * The cloud pointer, or null when this repository is not connected to one.
 *
 * `config.cloud` holds two different kinds of thing. `apiHost`, `workspaceId`, `workspaceName`,
 * `repo` and `remote` are the pointer `knowl cloud connect` writes after it authenticates. But
 * `autoStage` is a preference, and 5.0.1 made it settable -- so `knowl config set cloud.autoStage
 * false` in a repository that was never connected leaves `cloud: { autoStage: false }` on disk:
 * a `cloud` block that is not a connection.
 *
 * Every caller here used to read the block's mere presence as "connected", which turned that
 * into `readCredential(undefined)` and a `Cannot read properties of undefined (reading 'trim')`
 * out of `normalizeApiHost` -- reported by `doctor` as a FAIL with a JavaScript error where a
 * diagnosis should be.
 *
 * Lives in `core/` rather than `cloud/` because `workspace/resolve.ts` needs it too, and `workspace`
 * sits below `cloud` in the layering `tests/architecture/module-boundaries.test.ts` enforces -- so
 * the predicate cannot live in the layer that happens to have named the concept.
 *
 * `apiHost` and `workspaceId` are the test because they are the two fields nothing works without:
 * one names the deployment credentials are keyed by, the other names what to read and write.
 * `workspaceName` is a label, and `repo`/`remote` describe identity rather than reachability.
 */
export function cloudPointer(config: ProjectConfig): ConnectedCloud | null {
  const cloud = config.cloud;
  if (!cloud?.apiHost || !cloud.workspaceId) return null;
  return cloud as ConnectedCloud;
}

/**
 * Whether a `cloud` block holds settings but no connection.
 *
 * Distinguished from "no block at all" so a repository in this state can be told what is wrong
 * with it. Silence would be worse here than for a plainly disconnected repo: someone who ran
 * `config set cloud.autoStage` has said out loud that they expect staging to happen.
 */
export function hasCloudSettingsWithoutPointer(config: ProjectConfig): boolean {
  return config.cloud !== undefined && cloudPointer(config) === null;
}
