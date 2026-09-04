import fsSync from 'node:fs';
import path from 'node:path';
import type { KnowledgeCategory, KnowledgeItem, KnowledgeStatus, ProjectConfig } from '../core/types.js';
import { globalStorePath, knowlHome } from '../core/paths.js';
import { withDbPath } from './database.js';
import { queryKnowledgeForAgentExplained } from './agent-query.js';
import { resolveStorage } from './storage-roles.js';

export type MemoryNamespace = 'session' | 'project' | 'organization' | 'global';
export type NamespaceDescriptor = { namespace: MemoryNamespace; databasePath: string; precedence: number; optional?: boolean };
export type NamespacedKnowledgeItem = KnowledgeItem & { namespace: MemoryNamespace; explanation?: unknown };

const RANK: Record<MemoryNamespace, number> = { session: 1, project: 2, organization: 3, global: 4 };

export function projectNamespace(root: string): NamespaceDescriptor { return { namespace: 'project', databasePath: resolveStorage(root).knowledge, precedence: RANK.project }; }
export function sessionNamespace(root: string): NamespaceDescriptor { return { namespace: 'session', databasePath: resolveStorage(root).session, precedence: RANK.session }; }

/** The global store as a namespace, addressed by its known path rather than a project's config. */
export function globalNamespaceDescriptor(): NamespaceDescriptor {
  return { namespace: 'global', databasePath: globalStorePath(), precedence: RANK.global };
}

/**
 * The namespaces available when there is no project at all -- `knowl` outside a repository, or a
 * host session with no folder open.
 *
 * Global alone, and only when it exists: a machine that never created one has no memory here, and
 * saying so is better than an empty answer from a store that was never made.
 *
 * Deliberately NOT a fallback. Nothing calls this when a project was found and failed to open --
 * a broken project is an error, and answering it from the personal-defaults layer would be the
 * cross-project contamination this layer exists to avoid.
 */
export function globalOnlyNamespaces(): NamespaceDescriptor[] {
  const descriptor = globalNamespaceDescriptor();
  // `optional` is what lets the layered reader swallow a namespace's failure. Here it is the only
  // store, so a failure has to surface.
  return fsSync.existsSync(descriptor.databasePath) ? [{ ...descriptor, optional: false }] : [];
}
export function namespacePrecedence<T extends { namespace: MemoryNamespace }>(items: T[]): T[] { return [...items].sort((a, b) => RANK[a.namespace] - RANK[b.namespace]); }

export function defaultNamespaces(root: string): NamespaceDescriptor[] {
  return [sessionNamespace(root), projectNamespace(root)];
}

function externalNamespace(root: string, namespace: 'organization' | 'global', config: { enabled?: boolean; path?: string } | undefined): NamespaceDescriptor | null {
  if (!config?.enabled || !config.path) return null;
  const projectRoot = path.resolve(root);
  const databasePath = path.resolve(config.path);
  if (databasePath === projectRoot || databasePath.startsWith(`${projectRoot}${path.sep}`)) {
    throw new Error(`${namespace} namespace path must be outside the project directory.`);
  }
  return { namespace, databasePath, precedence: RANK[namespace], optional: true };
}

export function configuredNamespaces(root: string, config?: ProjectConfig): NamespaceDescriptor[] {
  const organization = externalNamespace(root, 'organization', config?.memory?.organization);
  const global = externalNamespace(root, 'global', config?.memory?.global);
  return [...defaultNamespaces(root), ...(organization ? [organization] : []), ...(global ? [global] : [])];
}

export function namespaceDescriptor(root: string, namespace: MemoryNamespace, config?: ProjectConfig): NamespaceDescriptor {
  const descriptor = configuredNamespaces(root, config).find(entry => entry.namespace === namespace);
  if (!descriptor) throw new Error(`Namespace "${namespace}" is not enabled.`);
  return descriptor;
}

export async function withNamespaceDatabase<T>(descriptor: NamespaceDescriptor, run: () => Promise<T>): Promise<T> {
  return withDbPath(descriptor.databasePath, run);
}

/**
 * Filters every namespace query must honour.
 *
 * These were previously dropped: only `{ query, limit, surface }` reached each namespace,
 * so an agent asking for a category or for archived items got neither. It is invisible
 * today because vector search is on by default and bypasses the layered branch, but that
 * bypass is what a cross-store read path has to remove -- and removing it first would
 * activate a path that silently ignores its own filters.
 */
export type LayeredFilters = {
  category?: KnowledgeCategory;
  status?: KnowledgeStatus;
  tags?: string[];
};

/**
 * The config root a namespace's embeddings were written under.
 *
 * `session` and `project` live inside a checkout and read that project's config. `global` and
 * `organization` are standalone files, so their profile comes from the Knowl home -- which is what
 * makes a global store internally consistent: every read and every write resolves the same
 * profile, whatever the project that happened to open it uses.
 */
function namespaceConfigRoot(descriptor: NamespaceDescriptor, projectRoot: string): string {
  if (descriptor.namespace === 'session' || descriptor.namespace === 'project') {
    if (projectRoot && path.resolve(projectRoot) !== path.resolve(knowlHome())) {
      return projectRoot;
    }
    return path.dirname(path.dirname(descriptor.databasePath));
  }
  return knowlHome();
}

/**
 * The embedding identity to search a namespace with.
 *
 * Required rather than convenient: `searchKnowledgeEmbeddings` filters on it, and that predicate
 * is load-bearing because cosine similarity between vectors of different dimensions is
 * meaningless. A namespace whose profile cannot be resolved returns null, and the caller skips it
 * and says so rather than scoring it with someone else's identity.
 */
export async function namespaceFingerprint(
  descriptor: NamespaceDescriptor,
  projectRoot: string = knowlHome(),
): Promise<string | null> {
  try {
    const [{ loadConfig }, { fingerprintProfile, resolveVectorProfile }] = await Promise.all([
      import('../core/config.js'),
      import('../core/vector-profile.js'),
    ]);
    const root = namespaceConfigRoot(descriptor, projectRoot);
    return fingerprintProfile(resolveVectorProfile(await loadConfig(root)));
  } catch {
    return null;
  }
}

export async function queryLayeredKnowledge(
  root: string,
  query: string,
  descriptors: NamespaceDescriptor[],
  limit = 3,
  surface = 'namespace_query',
  filters: LayeredFilters = {},
  // Absent keeps the old lexical behaviour, so every existing caller is unchanged.
  vector?: { enabled: boolean; embedding?: number[]; relevanceFloor?: number | null },
): Promise<{ items: NamespacedKnowledgeItem[]; skipped: MemoryNamespace[] }> {
  const ranked: NamespacedKnowledgeItem[][] = [];
  const skipped: MemoryNamespace[] = [];
  const seen = new Set<string>();
  for (const descriptor of namespacePrecedence(descriptors)) {
    try {
      if (descriptor.optional && !fsSync.existsSync(descriptor.databasePath)) {
        throw new Error(`Optional database at "${descriptor.databasePath}" does not exist.`);
      }
      // Each namespace is searched with ITS identity. A namespace whose profile cannot be
      // resolved is skipped and named -- never scored against the caller's vectors.
      const fingerprint = vector?.enabled
        ? ((descriptor.namespace === 'project' || descriptor.namespace === 'session') && (vector as any).profileFingerprint
            ? (vector as any).profileFingerprint
            : await namespaceFingerprint(descriptor, root))
        : null;
      if (vector?.enabled && !fingerprint) {
        skipped.push(descriptor.namespace);
        continue;
      }
      const items = await withNamespaceDatabase(descriptor, () => queryKnowledgeForAgentExplained('local', {
        query,
        limit,
        surface,
        category: filters.category,
        status: filters.status,
        tags: filters.tags,
        ...(fingerprint ? { vector: { ...vector, enabled: true, profileFingerprint: fingerprint } } : {}),
      }));
      const kept: NamespacedKnowledgeItem[] = [];
      for (const item of items) {
        const key = item.contentHash ?? `${item.title}\n${item.content}`;
        if (!seen.has(key)) {
          seen.add(key);
          kept.push({ ...item, namespace: descriptor.namespace });
        }
      }
      ranked.push(kept);
    } catch (error) {
      if (!descriptor.optional) throw error;
      skipped.push(descriptor.namespace);
    }
  }
  return { items: interleaveByPrecedence(ranked, limit), skipped };
}

/**
 * One page assembled from several namespaces, taking each namespace's best answer in turn.
 *
 * Precedence decides *order*, never whether a namespace is represented at all. This used to
 * ask every namespace for the whole `limit`, concatenate in precedence order and slice: a
 * session store holding `limit` loosely-matching notes consumed the entire budget and the
 * project store -- where durable knowledge lives -- returned nothing at all. At the default
 * limit of 3 that takes three session notes to reach, which is one ordinary session.
 *
 * Round-robin rather than merging by score, because these scores are not comparable. Each
 * namespace is a separate database and the layered path is lexical-only, so `scoreCandidates`
 * normalises every store's lexical evidence against that store's own best hit -- every
 * namespace's top answer is 1.0 by construction, exactly the corpus-relativity the cross-repo
 * note in agent-query.ts documents. Interleaving is what remains true when the numbers cannot
 * be compared: the highest-precedence namespace still leads, and each one keeps its own order.
 *
 * A namespace that runs out is skipped rather than reserving an empty slot, so a page is
 * short only when there is genuinely nothing more to put in it.
 */
function interleaveByPrecedence(
  ranked: NamespacedKnowledgeItem[][],
  limit: number,
): NamespacedKnowledgeItem[] {
  const results: NamespacedKnowledgeItem[] = [];
  const depth = Math.max(0, ...ranked.map(items => items.length));
  for (let round = 0; round < depth && results.length < limit; round += 1) {
    for (const items of ranked) {
      if (round >= items.length) continue;
      results.push(items[round]);
      if (results.length >= limit) break;
    }
  }
  return results;
}
