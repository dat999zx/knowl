import { KnowledgeItem } from '../core/types.js';
import { queryKnowledgeForAgent, type RankOptions } from './agent-query.js';
import { queryKnowledgeBase } from './queries.js';
import { defaultNamespaces, queryLayeredKnowledge } from './namespaces.js';
import { estimateTokens } from '../core/token-budget.js';
import { truncateText } from '../core/token-budget.js';

export type ContextKnowledgeItem = Pick<KnowledgeItem, 'category' | 'title' | 'content'> & { namespace?: string };
export type ContextRequest = {
  query?: string;
  task?: string;
  changedFiles?: string[];
  tokenBudget: number;
  includeEvidence?: boolean;
  namespaceRoot?: string;
  /**
   * A query embedding, when the caller already has one. Omitted, this resolves its own from
   * the project config -- see `resolveVector`.
   */
  vector?: RankOptions['vector'];
};
export type ContextPack = { sections: Array<{ name: string; items: ContextKnowledgeItem[]; estimatedTokens: number }>; excluded: Array<{ itemId: string; reason: 'duplicate' | 'budget' | 'stale' | 'lower-rank' }>; estimatedTokens: number };

type Candidate = KnowledgeItem & { namespace?: string };

const compact = (item: Candidate): ContextKnowledgeItem => ({ category: item.category, title: item.title, content: item.content, ...(item.namespace ? { namespace: item.namespace } : {}) });
const tokens = (item: Candidate) => estimateTokens(JSON.stringify(compact(item)));

/**
 * The most of the budget pinned constraints may take before the answer gets any.
 *
 * Constraints used to be pinned ahead of the ranking, unordered and unlimited, so a store with
 * enough of them answered every question with its rulebook: at a 4000-token budget the pack
 * came back as 29 constraints and zero relevant items. Raising the budget did not help, because
 * the extra room went to more constraints first. Reserving half means the answer always has
 * room, and constraints still take the whole budget when nothing else needs it -- the remainder
 * is offered back to them once the ranked items have had their turn.
 */
const PINNED_BUDGET_SHARE = 0.5;

/**
 * A query embedding, if this store can produce one without going to the network.
 *
 * `knowl_context` was permanently lexical-only on a fully embedded store: it never built a
 * vector, so it took the layered branch and ranked by BM25 while `knowl_query` -- answering the
 * same question against the same rows -- ranked semantically. The routing rule here is the one
 * `knowl_query` already applies: when a query embedding exists, use the ranker directly;
 * otherwise fall back to the layered namespace read.
 *
 * Never downloads. This is the same rule write-time indexing applies for the same reason: a
 * context call must not stall on a multi-megabyte fetch, and `knowl reindex --vectors` remains
 * the explicit opt-in that puts the model on disk.
 *
 * The "is it on disk" question goes to `resolveModelCache`, which is the same call
 * `write-embedding.ts` makes, rather than to a local `access` on `<root>/.knowl/models`. That
 * hand-rolled copy predated K-42 and only knew the per-repo cache: once the machine's weights
 * moved to `~/.knowl/models`, it reported them absent and silently put `knowl_context` back on
 * the lexical-only path -- the exact condition K-31 was about, on what is now the default
 * layout. There is one right answer to where the weights are and only one place that knows it.
 */
async function resolveVector(root: string, query: string): Promise<RankOptions['vector'] | undefined> {
  try {
    const [{ loadConfig }, { createLocalEmbeddingProvider, isVectorSearchEnabled, resolveModelCache }] = await Promise.all([
      import('../core/config.js'),
      import('../ai/embeddings.js'),
    ]);
    const config = await loadConfig(root);
    if (!isVectorSearchEnabled(config)) return undefined;
    const { present } = await resolveModelCache(config, root);
    if (!present) return undefined;
    const embedder = await createLocalEmbeddingProvider(config, root);
    return {
      enabled: true,
      profileFingerprint: embedder.profileFingerprint,
      embedding: await embedder.embedQuery(query),
      relevanceFloor: embedder.relevanceFloor,
    };
  } catch {
    // An unavailable embedder degrades to lexical composition rather than failing the call.
    return undefined;
  }
}

export async function composeContext(projectId: string, request: ContextRequest): Promise<ContextPack> {
  if (!Number.isFinite(request.tokenBudget) || request.tokenBudget < 1) throw new Error('tokenBudget must be positive.');
  const query = request.query ?? request.task;
  const vector = request.vector
    ?? (request.namespaceRoot && query ? await resolveVector(request.namespaceRoot, query) : undefined);

  const candidates: Candidate[] = request.namespaceRoot && !vector?.enabled
    // Descriptors are passed explicitly. They used to be omitted, taking queryLayeredKnowledge's
    // config-free default, which meant context composition and MCP query could read different
    // namespace sets with nothing reporting the divergence.
    ? await queryLayeredKnowledge(request.namespaceRoot, query ?? '', defaultNamespaces(request.namespaceRoot), 30, 'context_composer')
    : await queryKnowledgeForAgent(projectId, { query, limit: 30, surface: 'context_composer', vector });

  // Pinned, but no longer unranked: a constraint the query actually reached keeps the position
  // the ranker gave it, and the rest follow newest first rather than in whatever order the
  // table returned them.
  const rank = new Map(candidates.map((item, index) => [item.id, index]));
  const pinned = (await queryKnowledgeBase(projectId, { category: 'constraint', status: 'active' }))
    .sort((left, right) => (rank.get(left.id) ?? Number.MAX_SAFE_INTEGER) - (rank.get(right.id) ?? Number.MAX_SAFE_INTEGER)
      || new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime());
  const rest = candidates.filter(item => item.category !== 'constraint' && !pinned.some(constraint => constraint.id === item.id));

  const selected: Candidate[] = [];
  const excluded: ContextPack['excluded'] = [];
  let used = 0;

  const take = (original: Candidate, cap: number, allowTruncation: boolean): boolean => {
    let item = original;
    let cost = tokens(item);
    if (allowTruncation && selected.length === 0 && cost > cap) {
      const overflowChars = (cost - cap) * 4;
      item = { ...item, content: truncateText(item.content, Math.max(0, item.content.length - overflowChars), '…') };
      cost = tokens(item);
    }
    if (used + cost > cap) return false;
    selected.push(item);
    used += cost;
    return true;
  };

  // Constraints first, but only up to their share. Then the answer. Then whatever the answer
  // left over goes back to the constraints that did not fit.
  const deferred: Candidate[] = [];
  for (const item of pinned) {
    if (!take(item, Math.max(1, Math.floor(request.tokenBudget * PINNED_BUDGET_SHARE)), true)) deferred.push(item);
  }
  const overflowed: Candidate[] = [];
  for (const item of rest) {
    if (!take(item, request.tokenBudget, false)) overflowed.push(item);
  }
  // Truncation is still offered here: a single constraint larger than the whole budget has to
  // be clipped or the pack comes back empty, and half a rule is better than none.
  for (const item of deferred) {
    if (!take(item, request.tokenBudget, true)) excluded.push({ itemId: item.id, reason: 'budget' });
  }
  for (const item of overflowed) excluded.push({ itemId: item.id, reason: 'budget' });

  const constraints = selected.filter(item => item.category === 'constraint').map(compact);
  const relevant = selected.filter(item => item.category !== 'constraint').map(compact);
  const compactTokens = (items: ContextKnowledgeItem[]) => items.reduce((sum, item) => sum + estimateTokens(JSON.stringify(item)), 0);
  return { sections: [{ name: 'Pinned constraints', items: constraints, estimatedTokens: compactTokens(constraints) }, { name: 'Relevant knowledge', items: relevant, estimatedTokens: compactTokens(relevant) }], excluded, estimatedTokens: used };
}
