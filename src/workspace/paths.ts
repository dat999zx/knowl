import fs from 'node:fs/promises';
import path from 'node:path';
import { knowlHome } from '../core/paths.js';

/**
 * `knowlHome` now lives in `core/paths.ts` — it is machine-local state, not a workspace idea.
 * Re-exported here because callers that want a workspace path usually want the root too, and
 * because it keeps existing imports working.
 */
export { knowlHome } from '../core/paths.js';

export function workspacesRoot(): string {
  return path.join(knowlHome(), 'workspaces');
}

export function workspaceDir(name: string): string {
  return path.join(workspacesRoot(), name);
}

export function workspaceManifestPath(name: string): string {
  return path.join(workspaceDir(name), 'workspace.json');
}

/** Registry lookup, not a filesystem scan: only workspaces this machine created. */
export async function listKnownWorkspaces(): Promise<string[]> {
  try {
    const entries = await fs.readdir(workspacesRoot(), { withFileTypes: true });
    return entries.filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
  } catch {
    return [];
  }
}
