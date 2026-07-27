import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/**
 * Root for machine-local Knowl state that is not tied to one project.
 *
 * A workspace lives here rather than inside any member repo: putting it in one would make
 * that repo special, break when it is deleted, and risk it being committed.
 */
export function knowlHome(): string {
  const override = process.env.KNOWL_HOME;
  return override ? path.resolve(override) : path.join(os.homedir(), '.knowl');
}

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
