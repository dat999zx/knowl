import type { KnowledgeItem } from '../core/types.js';
import { loadConfig } from '../core/config.js';
import { createLocalEmbeddingProvider, isVectorSearchEnabled } from '../ai/embeddings.js';
import { rankKnowledge, type RankOptions } from '../store/agent-query.js';
import { queryKnowledgeBase } from '../store/queries.js';
import { queryFederated, type FederatedResult } from '../workspace/federated-query.js';
import { resolveWorkspace } from '../workspace/resolve.js';

/**
 * How many results `knowl query` returns when no `--limit` is given.
 *
 * Matches what the command already returned: `searchKnowledgeItems` caps its FTS read at 20,
 * so 20 was the effective ceiling for a bare `knowl query` on the lexical path. The workspace
 * branch separately defaulted to 3, which meant the same query printed a different number of
 * results depending on whether the repo happened to be linked. Both use this now.
 */
export const CLI_QUERY_LIMIT = 20;

export type CliQueryResult = {
  items: Array<KnowledgeItem & { repo?: string; score?: number; abstained?: boolean }>;
  skipped: FederatedResult['skipped'];
};

/**
 * The ranker's own numbers, put on the item the way `knowl_query` puts them on its response.
 *
 * `knowl query` printed a bare ordering, so a human reading it could not tell a confident
 * answer from the least-bad row in the store -- the same gap the MCP surface had. Three
 * decimals for the same reason: the digits past that are noise.
 *
 * The full `explanation` is deliberately not printed. It is a dozen contribution terms per
 * item, and the two numbers a reader acts on are these. `--as-of` carries neither, because
 * historical reconstruction does not run through the ranker at all.
 */
function withRankerVerdict<T extends { explanation?: { finalScore?: number; abstained?: boolean } }>(
  entry: T,
): Omit<T, 'explanation'> & { score?: number; abstained?: boolean } {
  const { explanation, ...item } = entry;
  return {
    ...item,
    ...(typeof explanation?.finalScore === 'number' ? { score: Number(explanation.finalScore.toFixed(3)) } : {}),
    ...(explanation?.abstained ? { abstained: true } : {}),
  };
}

/**
 * What `knowl query` returns.
 *
 * Extracted from the command action so the CLI's search behaviour is testable without
 * spawning a process -- it previously had no test at all, which is how it came to rank by
 * different rules than the MCP tool answering the same question.
 *
 * One engine, three inputs: the shared ranker, the same vector config the MCP tool builds, and
 * federation when the repo is linked. `--as-of` is the single exception and stays on
 * `queryKnowledgeBase`, because historical reconstruction is a different question and the
 * ranker does not implement it.
 */
export async function runCliQuery(input: {
  projectRoot: string;
  projectId: string;
  query?: string;
  limit?: number;
  asOf?: string;
}): Promise<CliQueryResult> {
  const limit = input.limit ?? CLI_QUERY_LIMIT;

  // Historical reconstruction: local only, and not through the ranker. Fanning out an `asOf`
  // query across repos has no defined semantics, and the ranker has no notion of a point in
  // time -- so this path is deliberately the old one.
  if (input.asOf) {
    const items = await queryKnowledgeBase(input.projectId, {
      query: input.query, limit: input.limit, asOf: input.asOf,
    });
    return { items, skipped: [] };
  }

  const config = await loadConfig(input.projectRoot).catch(() => null);
  let vector: RankOptions['vector'];
  if (input.query && config && isVectorSearchEnabled(config)) {
    try {
      const embedder = await createLocalEmbeddingProvider(config, input.projectRoot);
      const embedding = await embedder.embedQuery(input.query);
      vector = {
        enabled: true,
        profileFingerprint: embedder.profileFingerprint,
        embedding,
        relevanceFloor: embedder.relevanceFloor,
      };
    } catch {
      // An unavailable embedder degrades to lexical ranking rather than failing the query.
      // The MCP tool behaves the same way, which is the point of computing it here at all.
    }
  }

  const active = await resolveWorkspace(input.projectRoot, config ?? undefined);
  if (active) {
    const federated = await queryFederated({
      workspace: active, query: input.query ?? '', limit, vector,
    });
    return { items: federated.items.map(withRankerVerdict), skipped: federated.skipped };
  }

  const ranked = await rankKnowledge(input.projectId, { query: input.query, limit, vector });
  return { items: ranked.map(withRankerVerdict), skipped: [] };
}
