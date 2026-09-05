import { findProjectRoot } from './core/config.js';
import { ProjectNotFoundError } from './core/errors.js';
import { assertKnowledgeDatabasePresent } from './cli/database-presence.js';
import { openProjectScope } from './store/database.js';
import { getProjectByRootPath } from './store/repository.js';
import { handleHostLifecycleEvent, HostLifecycleResult } from './session/host-lifecycle.js';
import { queryKnowledgeForAgent } from './store/agent-query.js';
import { storeKnowledgeItemDeduped, StoreKnowledgeInput, StoreKnowledgeResult } from './store/knowledge-writer.js';
import { KnowledgeItem } from './core/types.js';
import { NormalizedHostHook } from './core/host-hook-types.js';

export interface ProjectHandle {
  readonly projectRoot: string;
  readonly databasePath: string;
  lifecycle(event: NormalizedHostHook): Promise<HostLifecycleResult>;
  query(text: string, opts?: { limit?: number }): Promise<KnowledgeItem[]>;
  store(atom: StoreKnowledgeInput): Promise<StoreKnowledgeResult>;
  release(): Promise<void>;
}

export type LifecycleResult = HostLifecycleResult;
export type StoreInput = StoreKnowledgeInput;
export type StoreResult = StoreKnowledgeResult;
export type QueryResult = KnowledgeItem;

/**
 * Open a scoped handle to a Knowl project.
 *
 * Returns `null` when `cwd` does not resolve to a Knowl repository (`ProjectNotFoundError`).
 * Throws `MissingKnowledgeDatabaseError` when the repository is initialized and registered
 * but its database file is missing.
 *
 * Every operation on the returned `ProjectHandle` runs inside `withProjectScope` / `scope.run`,
 * guaranteeing that concurrent operations across different projects in the same process do not
 * overwrite each other's connection or write to the wrong database.
 *
 * `handle.release()` decrements the scope refcount and releases the client connection via
 * `releaseClient`. Never calls `closeDb` or `initDb`.
 */
export async function openProject(cwd: string): Promise<ProjectHandle | null> {
  let root: string;
  try {
    root = await findProjectRoot(cwd);
  } catch (error) {
    if (error instanceof ProjectNotFoundError) {
      return null;
    }
    throw error;
  }

  // Before opening the scope, verify the database file exists if this repo is registered.
  // Throws MissingKnowledgeDatabaseError if the file vanished.
  assertKnowledgeDatabasePresent(root);

  const scope = await openProjectScope(root);

  let project;
  try {
    project = await scope.run(async () => {
      return await getProjectByRootPath(root);
    });
  } catch (error) {
    await scope.release();
    throw error;
  }

  if (!project) {
    await scope.release();
    return null;
  }

  const projectId = project.id;

  return {
    projectRoot: root,
    databasePath: scope.databasePath,
    async lifecycle(event: NormalizedHostHook): Promise<HostLifecycleResult> {
      return await scope.run(async () => {
        return await handleHostLifecycleEvent(projectId, event);
      });
    },
    async query(text: string, opts?: { limit?: number }): Promise<KnowledgeItem[]> {
      return await scope.run(async () => {
        return await queryKnowledgeForAgent(projectId, {
          query: text,
          limit: opts?.limit ?? 10,
          surface: 'plugin',
        });
      });
    },
    async store(atom: StoreKnowledgeInput): Promise<StoreKnowledgeResult> {
      return await scope.run(async () => {
        return await storeKnowledgeItemDeduped(projectId, atom);
      });
    },
    async release(): Promise<void> {
      await scope.release();
    },
  };
}

export { normalizeHostHook } from './cli/agents/host-hook.js';
export { readLifecyclePayloadObject } from './cli/agents/lifecycle.js';
export { KNOWL_MIGRATION_LEVEL } from './store/schema-version.js';
export { ProjectNotFoundError } from './core/errors.js';
export { MissingKnowledgeDatabaseError } from './cli/database-presence.js';
export type { NormalizedHostHook, NormalizedHookEventName, HookHost } from './core/host-hook-types.js';
export type { LifecyclePayload } from './cli/agents/lifecycle.js';
