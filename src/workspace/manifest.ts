import fs from 'node:fs/promises';
import path from 'node:path';
import type { EmbeddingIdentity } from '../store/embedding-identity.js';
import { PACKAGE_VERSION } from '../version.js';

export type WorkspaceMode = 'linked' | 'shared';

export type WorkspaceRepo = {
  /** Canonical identity. Immutable: it is the ownership key on every item this repo wrote. */
  name: string;
  /** Machine-local and optional. A manifest copied to another machine resolves paths there. */
  path?: string;
  /** Evidence for matching a repo on another machine, never authoritative. */
  git?: { remote?: string };
  addedAt?: string;
};

export type WorkspaceManifest = {
  version: 1;
  name: string;
  /** Guards the manifest format, separately from the database's PRAGMA user_version. */
  minKnowlVersion: string;
  /**
   * Where knowledge lives. Stored only here, never in a repo's config, so activation is a
   * single atomic file write and no mixed-mode state can exist. `shared` arrives in v2.
   */
  mode: WorkspaceMode;
  /** One embedding identity for the whole workspace; null when vector search is off. */
  embedding: EmbeddingIdentity | null;
  repos: WorkspaceRepo[];
  /** Names that were removed. Never reusable -- see assertNameAvailable. */
  retiredNames: string[];
};

const REPO_NAME = /^[a-z0-9][a-z0-9-]*$/;

export function isValidRepoName(name: string): boolean {
  return REPO_NAME.test(name);
}

export function createManifest(name: string, embedding: EmbeddingIdentity | null): WorkspaceManifest {
  return {
    version: 1,
    name,
    minKnowlVersion: PACKAGE_VERSION,
    mode: 'linked',
    embedding,
    repos: [],
    retiredNames: [],
  };
}

export async function readManifest(manifestPath: string): Promise<WorkspaceManifest> {
  const raw = JSON.parse(await fs.readFile(manifestPath, 'utf8')) as Partial<WorkspaceManifest>;
  return {
    version: 1,
    name: String(raw.name ?? ''),
    minKnowlVersion: String(raw.minKnowlVersion ?? PACKAGE_VERSION),
    mode: raw.mode === 'shared' ? 'shared' : 'linked',
    embedding: raw.embedding ?? null,
    repos: raw.repos ?? [],
    retiredNames: raw.retiredNames ?? [],
  };
}

export async function writeManifest(manifestPath: string, manifest: WorkspaceManifest): Promise<void> {
  await fs.mkdir(path.dirname(manifestPath), { recursive: true });
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

/**
 * A name is the ownership key on every item its repo wrote, so handing one to a different
 * repo silently transfers knowledge. Retired names are therefore never reusable, even after
 * the repo that held them is gone.
 */
export function assertNameAvailable(manifest: WorkspaceManifest, name: string): void {
  if (!isValidRepoName(name)) {
    throw new Error(`Repo name "${name}" must be lowercase letters, digits and hyphens, starting with a letter or digit.`);
  }
  if (manifest.repos.some(repo => repo.name === name)) {
    throw new Error(`Repo name "${name}" is already used in workspace "${manifest.name}".`);
  }
  if (manifest.retiredNames.includes(name)) {
    throw new Error(`Repo name "${name}" was retired from workspace "${manifest.name}" and cannot be reused; choose another.`);
  }
}
