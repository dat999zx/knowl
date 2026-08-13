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

/**
 * The paths an item carries in `source`, which in practice is a list of them.
 *
 * Most items that cite code never fill `affectedPaths`; they write
 * `"src/store/database.ts; src/store/bootstrap.ts; package.json"` into `source` instead. Measured
 * on this repo's store, 58 of the 71 drift-flagged items with no `affectedPaths` were flagged
 * through exactly this, and legitimately -- so `source` has to keep being read.
 *
 * It was read with `source.includes(changedPath)`, a raw substring test, which is the part that
 * was wrong: `vendor/src/index.ts` contains `src/index.ts` while being a different file, and free
 * prose matches whatever words it happens to contain. Tokenising first makes the same intent
 * precise, and every token then goes through `pathMatches` like any other path.
 *
 * A token has to look like a path to count: no spaces, and at least one `/` or `.`. That drops
 * `"verified in this workspace"` and `"commit 53a8f9e"` while keeping `package.json`.
 */
export function sourcePaths(source?: string | null): string[] {
  if (!source) return [];
  return source
    .split(/[;,]/)
    .map(token => token.trim())
    .filter(token => token.length > 0 && !/\s/.test(token) && /[/.]/.test(token))
    .map(normalizePathForKnowledge);
}

/**
 * Whether a change to these files touches anything the item claims to be about.
 *
 * **Tags are deliberately not consulted.** A tag is a topic label, not a location, and matching it
 * with `pathMatches` meant a tag that happened to be a top-level directory (`tests`, `docs`)
 * claimed every change beneath it. It fired on 8 items in the measured store -- small, and wrong
 * in principle rather than in degree.
 *
 * A true answer means "a file this item cites was touched", which is weaker than "this item is now
 * false". `classifyDriftPaths` in `drift.ts` is what tells those apart; this only narrows the field.
 */
export function knowledgeMentionsChangedPath(item: {
  source?: string | null;
  affectedPaths?: string[] | null;
  tags?: string[] | null;
}, changedFiles: string[]): boolean {
  const normalizedChanged = changedFiles.map(normalizePathForKnowledge);
  const cited = [...(item.affectedPaths || []), ...sourcePaths(item.source)];

  return cited.some(citedPath =>
    normalizedChanged.some(changedPath => pathMatches(citedPath, changedPath)));
}
