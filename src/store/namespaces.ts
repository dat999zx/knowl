import path from 'node:path';

export type MemoryNamespace = 'session' | 'project' | 'organization' | 'global';
export type NamespaceDescriptor = { namespace: MemoryNamespace; databasePath: string; precedence: number };

export function projectNamespace(root: string): NamespaceDescriptor { return { namespace: 'project', databasePath: path.join(root, '.knowl', 'knowl.db'), precedence: 2 }; }
export function sessionNamespace(root: string): NamespaceDescriptor { return { namespace: 'session', databasePath: path.join(root, '.knowl', 'session.db'), precedence: 1 }; }
export function namespacePrecedence(items: Array<{ namespace: MemoryNamespace }>) { const rank: Record<MemoryNamespace, number> = { session: 1, project: 2, organization: 3, global: 4 }; return [...items].sort((a, b) => rank[a.namespace] - rank[b.namespace]); }
