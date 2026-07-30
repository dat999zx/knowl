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

/**
 * A fingerprint over the fields that decide an item's lifecycle rather than its content.
 *
 * Separate from `content_hash` on purpose. `content_hash` covers title, content, reasoning,
 * source and paths, and equal hashes classify an import as `identical`, which skips the item
 * outright. So promoting an item to workspace visibility, retiring it, superseding it or
 * marking it stale changed nothing an export could carry -- the receiving side kept its old
 * copy and the two never converged.
 *
 * Widening `content_hash` was the alternative. It would change every existing item's identity
 * and break the verbatim adoption that makes re-import idempotent.
 *
 * `confidence` is excluded: it moves on ordinary use, and including it would leave almost
 * every item permanently divergent.
 */
export function hashKnowledgeLifecycle(input: {
  status?: string | null;
  freshness?: string | null;
  supersededById?: string | null;
  originRepo?: string | null;
  visibility?: string | null;
}): string {
  const fingerprint = {
    status: input.status ?? 'active',
    freshness: input.freshness ?? DEFAULT_FRESHNESS,
    supersededById: input.supersededById ?? null,
    originRepo: input.originRepo ?? null,
    visibility: input.visibility ?? 'repo',
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
