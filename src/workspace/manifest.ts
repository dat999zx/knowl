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
  /**
   * What this repo is, for an agent that has only the manifest. Free text: never parsed, and
   * no behavior is inferred from it. A repo is never published because of a word someone typed.
   */
  role?: string;
  /**
   * Visibility stamped on new writes here. Only ever `'workspace'` -- absent means `'repo'`,
   * which is both today's behavior and what every existing manifest already says by omission.
   */
  defaultVisibility?: 'workspace';
  /**
   * Repos sharing this group name are kin: same lineage, diverged conventions. Widens the
   * cross-repo write advisory for them; changes nothing about retrieval.
   */
  kin?: string;
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

/** Role renders into every session-start block in every linked repo, so it is a budget item. */
export const ROLE_MAX_LENGTH = 200;

function normalizeRole(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const collapsed = value.replace(/\s+/g, ' ').trim();
  if (!collapsed) return undefined;
  return collapsed.slice(0, ROLE_MAX_LENGTH);
}

/**
 * Normalize one repo entry without rebuilding it.
 *
 * Spread first and override known fields after, so a field written by a *newer* build survives
 * a pass through this one. Older builds already give these fields that property for free, by
 * passing `raw.repos` through untouched; rebuilding the entry here would break it in the one
 * direction that still worked.
 *
 * Never throws. `discoverRepos` reads every manifest on this machine to decide what
 * `upgrade --all` visits, so an entry rejected here would take down a machine-wide command
 * rather than one repo. Every unparseable value resolves toward private instead: the failure
 * mode must be "shared less than intended", never "published without being asked".
 */
export function normalizeRepoEntry(raw: unknown): WorkspaceRepo {
  const entry = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    ...entry,
    name: typeof entry.name === 'string' ? entry.name : '',
    role: normalizeRole(entry.role),
    defaultVisibility: entry.defaultVisibility === 'workspace' ? 'workspace' : undefined,
    kin: typeof entry.kin === 'string' && isValidRepoName(entry.kin) ? entry.kin : undefined,
  };
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
    repos: (Array.isArray(raw.repos) ? raw.repos : []).map(normalizeRepoEntry),
    retiredNames: raw.retiredNames ?? [],
  };
}

export async function writeManifest(manifestPath: string, manifest: WorkspaceManifest): Promise<void> {
  await fs.mkdir(path.dirname(manifestPath), { recursive: true });
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

/**
 * A name is the ownership key on every item its repo wrote, so handing one to a *different*
 * repo silently transfers knowledge. Retired names are therefore refused by default.
 *
 * `allowRetired` is for the one case where nothing is transferred: the same repo re-linking
 * under the name it already owns items under. Only membership can establish that, since it
 * takes reading the repo's own database, so the decision is passed in rather than made here.
 */
export function assertNameAvailable(
  manifest: WorkspaceManifest,
  name: string,
  options: { allowRetired?: boolean } = {},
): void {
  if (!isValidRepoName(name)) {
    throw new Error(`Repo name "${name}" must be lowercase letters, digits and hyphens, starting with a letter or digit.`);
  }
  if (manifest.repos.some(repo => repo.name === name)) {
    throw new Error(`Repo name "${name}" is already used in workspace "${manifest.name}".`);
  }
  if (!options.allowRetired && manifest.retiredNames.includes(name)) {
    throw new Error(
      `Repo name "${name}" was retired from workspace "${manifest.name}" and cannot be reused; choose another. ` +
      'Only the repo whose database still owns items under that name can reclaim it.',
    );
  }
}
