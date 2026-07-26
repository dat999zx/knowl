import path from 'node:path';
import type { KnowledgeCategory, KnowledgeItem, KnowledgeStatus, ProjectConfig } from '../core/types.js';
import { withDbPath } from './database.js';
import { queryKnowledgeForAgent } from './agent-query.js';
import { resolveStorage } from './storage-roles.js';

export type MemoryNamespace = 'session' | 'project' | 'organization' | 'global';
export type NamespaceDescriptor = { namespace: MemoryNamespace; databasePath: string; precedence: number; optional?: boolean };
export type NamespacedKnowledgeItem = KnowledgeItem & { namespace: MemoryNamespace };

const RANK: Record<MemoryNamespace, number> = { session: 1, project: 2, organization: 3, global: 4 };

export function projectNamespace(root: string): NamespaceDescriptor { return { namespace: 'project', databasePath: resolveStorage(root).knowledge, precedence: RANK.project }; }
export function sessionNamespace(root: string): NamespaceDescriptor { return { namespace: 'session', databasePath: resolveStorage(root).session, precedence: RANK.session }; }
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

export async function queryLayeredKnowledge(
  root: string,
  query: string,
  descriptors: NamespaceDescriptor[],
  limit = 3,
  surface = 'namespace_query',
  filters: LayeredFilters = {},
): Promise<NamespacedKnowledgeItem[]> {
  const results: NamespacedKnowledgeItem[] = [];
  const seen = new Set<string>();
  for (const descriptor of namespacePrecedence(descriptors)) {
    try {
      const items = await withNamespaceDatabase(descriptor, () => queryKnowledgeForAgent('local', {
        query,
        limit,
        surface,
        category: filters.category,
        status: filters.status,
        tags: filters.tags,
      }));
      for (const item of items) {
        const key = item.contentHash ?? `${item.title}\n${item.content}`;
        if (!seen.has(key)) {
          seen.add(key);
          results.push({ ...item, namespace: descriptor.namespace });
        }
      }
    } catch (error) {
      if (!descriptor.optional) throw error;
    }
  }
  return results.slice(0, limit);
}
