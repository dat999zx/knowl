import { createHash } from 'node:crypto';
import type { KnowledgeFreshness } from '../core/types.js';

export const DEFAULT_FRESHNESS: KnowledgeFreshness = 'fresh';

export function normalizePathForKnowledge(filePath: string): string {
  return filePath.replace(/\\/g, '/').replace(/^\.\//, '');
}

export function normalizeAffectedPaths(paths?: string[] | null): string[] | null {
  if (!paths || paths.length === 0) return null;
  const normalized = Array.from(new Set(
    paths
      .map(path => normalizePathForKnowledge(path.trim()))
      .filter(Boolean)
  ));
  return normalized.length > 0 ? normalized : null;
}

export function hashKnowledgeContent(input: {
  title: string;
  content: string;
  reasoning?: string | null;
  source?: string | null;
  affectedPaths?: string[] | null;
}): string {
  const fingerprint = {
    title: input.title,
    content: input.content,
    reasoning: input.reasoning || null,
    source: input.source || null,
    affectedPaths: normalizeAffectedPaths(input.affectedPaths) || [],
  };

  return createHash('sha256')
    .update(JSON.stringify(fingerprint))
    .digest('hex');
}

function pathMatches(knownPath: string, changedPath: string): boolean {
  const known = normalizePathForKnowledge(knownPath);
  const changed = normalizePathForKnowledge(changedPath);
  return known === changed || changed.startsWith(`${known}/`) || known.startsWith(`${changed}/`);
}

export function knowledgeMentionsChangedPath(item: {
  source?: string | null;
  affectedPaths?: string[] | null;
  tags?: string[] | null;
}, changedFiles: string[]): boolean {
  const normalizedChanged = changedFiles.map(normalizePathForKnowledge);

  for (const affectedPath of item.affectedPaths || []) {
    if (normalizedChanged.some(changedPath => pathMatches(affectedPath, changedPath))) {
      return true;
    }
  }

  const source = item.source || '';
  if (source && normalizedChanged.some(changedPath => source.includes(changedPath))) {
    return true;
  }

  for (const tag of item.tags || []) {
    if (normalizedChanged.some(changedPath => pathMatches(tag, changedPath))) {
      return true;
    }
  }

  return false;
}
