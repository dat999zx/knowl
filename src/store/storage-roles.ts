import path from 'node:path';
import type { ProjectConfig } from '../core/types.js';

/**
 * Which database file serves which purpose for a given project root.
 *
 * `local` holds the code index, host session bindings, drift watermarks and caches. It is
 * anchored to the project and is never redirected, whatever else changes.
 * `session` is the short-lived session namespace.
 * `knowledge` is `knowledge_items` and everything keyed to it, including access telemetry --
 * telemetry has a same-database foreign key, so it cannot be separated from the items it
 * references.
 *
 * All three currently resolve inside the project, so this changes no behavior. The value is
 * that the path is decided once: it was previously derived independently in `database.ts`,
 * `namespaces.ts` and `snapshots.ts`, which agree only by coincidence. The first time one of
 * them can point elsewhere, the others follow silently, and a query and a snapshot reading
 * different files is not a failure anything reports.
 */
export type StorageRole = 'local' | 'session' | 'knowledge';

export type ResolvedStorage = {
  local: string;
  session: string;
  knowledge: string;
};

export function resolveStorage(root: string, _config?: ProjectConfig): ResolvedStorage {
  const knowlDir = path.join(root, '.knowl');
  return {
    local: path.join(knowlDir, 'knowl.db'),
    session: path.join(knowlDir, 'session.db'),
    knowledge: path.join(knowlDir, 'knowl.db'),
  };
}
