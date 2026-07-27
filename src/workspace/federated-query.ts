import type { KnowledgeItem } from '../core/types.js';
import { RRF_K } from '../store/agent-query.js';
import { cosineSimilarity } from '../store/vector.js';
import { acquireClient } from '../store/connection-pool.js';
import { SchemaTooNewError } from '../store/schema-version.js';
import type { ActiveWorkspace, PeerRepo } from './resolve.js';

export type FederatedItem = KnowledgeItem & { repo: string };
export type SkipReason = 'absent' | 'unreadable' | 'schema-too-new';
export type FederatedResult = {
  items: FederatedItem[];
  skipped: Array<{ repo: string; reason: SkipReason }>;
};

const DEFAULT_PER_REPO_CAP = 10;

/**
 * Candidates from one peer.
 *
 * A plain LIKE scan rather than the agent ranker: the ranker needs an initialized ambient
 * database, and using it here would swap the caller's connection mid-query. Candidates are
 * capped per repo and fused by rank, so a cheap peer scan can only interleave with properly
 * scored local results, never outrank them wholesale.
 *
 * The visibility filter is in the SQL, not applied afterwards. A peer's repo-private items
 * must never enter this process at all.
 */
/**
 * Query tokens, not the raw string.
 *
 * A whole-phrase LIKE only matches when the exact phrase appears, so "wire format protobuf"
 * missed a decision titled "Wire format is protobuf" -- one filler word away and the peer
 * returned nothing. Agents query in keywords, which is precisely the shape that breaks.
 */
function queryTokens(query: string): string[] {
  return Array.from(new Set(
    query.toLowerCase().split(/[^a-z0-9]+/).filter(token => token.length > 1),
  )).slice(0, 12);
}

type Candidate = { item: KnowledgeItem; vector: number[] | null };

const ITEM_COLUMNS = `i.id, i.category, i.status, i.title, i.content, i.reasoning, i.tags, i.source,
  i.content_hash, i.freshness, i.confidence, i.version, i.created_at, i.updated_at,
  i.origin_repo, i.visibility, e.vector AS embedding`;

/**
 * Peer candidates, selected the way the local ranker selects its own.
 *
 * Locally, candidates come from BM25 *and* vector search unioned, with cosine as the
 * primary score and BM25 only a bounded fallback for items the vector search missed
 * (`agent-query.ts`, VECTOR_PRIMARY_WEIGHT / BM25_FALLBACK_WEIGHT). Selecting peers
 * lexically alone would invert that: an item that is semantically on-point but shares no
 * query token would never become a candidate, so cosine would never get to rank it -- which
 * is the exact case vector search exists for.
 *
 * So this does both. Every embedded item is scored by cosine and the best `cap` are taken;
 * the lexical scan then adds what vectors missed, which is also the whole answer for a peer
 * written without embeddings.
 */
async function peerCandidates(
  peer: PeerRepo,
  query: string,
  cap: number,
  queryEmbedding?: number[],
): Promise<Candidate[]> {
  const client = await acquireClient(peer.databasePath, { readOnly: true });
  const byId = new Map<string, Candidate>();

  // Primary: semantic. A full scan of the peer's vectors, scored in JS -- the same shape
  // searchKnowledgeEmbeddings already uses locally, so this is not a new cost profile.
  if (queryEmbedding) {
    const embedded = await client.execute({
      sql: `SELECT ${ITEM_COLUMNS}
            FROM knowledge_items i
            JOIN knowledge_embeddings e ON e.knowledge_item_id = i.id
            WHERE i.status = 'active' AND i.visibility = 'workspace'`,
      args: [],
    });
    const scored = embedded.rows
      .map(row => ({ row, vector: parseVector(row.embedding) }))
      .filter(entry => entry.vector)
      .map(entry => ({ entry, score: cosineSimilarity(queryEmbedding, entry.vector!) }))
      .filter(entry => entry.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, cap);
    for (const { entry } of scored) byId.set(String(entry.row.id), toCandidate(entry.row));
  }

  // Fallback: lexical. Catches items with no embedding, and query terms the vector missed.
  // A title hit counts double, mirroring the weight the local ranker gives titles.
  const tokens = queryTokens(query);
  if (tokens.length > 0) {
    const where = tokens.map(() => '(lower(i.title) LIKE ? OR lower(i.content) LIKE ?)').join(' OR ');
    const score = tokens
      .map(() => '(CASE WHEN lower(i.title) LIKE ? THEN 2 ELSE 0 END) + (CASE WHEN lower(i.content) LIKE ? THEN 1 ELSE 0 END)')
      .join(' + ');
    const patterns = tokens.flatMap(token => [`%${token}%`, `%${token}%`]);

    const rows = await client.execute({
      sql: `SELECT ${ITEM_COLUMNS}, ${score} AS match_score
            FROM knowledge_items i
            LEFT JOIN knowledge_embeddings e ON e.knowledge_item_id = i.id
            WHERE i.status = 'active' AND i.visibility = 'workspace' AND (${where})
            ORDER BY match_score DESC, i.updated_at DESC
            LIMIT ?`,
      args: [...patterns, ...patterns, cap],
    });
    for (const row of rows.rows) {
      if (!byId.has(String(row.id))) byId.set(String(row.id), toCandidate(row));
    }
  }

  return [...byId.values()];
}

function toCandidate(row: Record<string, unknown>): Candidate {
  return {
    vector: parseVector(row.embedding),
    item: {
      id: String(row.id),
      category: String(row.category),
      status: String(row.status),
      title: String(row.title),
      content: String(row.content),
      reasoning: row.reasoning === null ? null : String(row.reasoning),
      tags: row.tags ? JSON.parse(String(row.tags)) : null,
      source: row.source === null ? null : String(row.source),
      contentHash: row.content_hash === null ? null : String(row.content_hash),
      freshness: String(row.freshness),
      confidence: Number(row.confidence),
      version: Number(row.version),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      originRepo: row.origin_repo === null ? null : String(row.origin_repo),
      visibility: String(row.visibility),
    } as unknown as KnowledgeItem,
  };
}

/** Stored as a JSON array; a peer written without embeddings simply has none. */
function parseVector(value: unknown): number[] | null {
  if (typeof value !== 'string') return null;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) && parsed.length > 0 ? parsed as number[] : null;
  } catch {
    return null;
  }
}

/**
 * Fuse local and peer candidates by reciprocal rank.
 *
 * BM25 scores from different databases are not comparable -- they depend on each corpus's
 * term statistics -- so raw-score fusion would let one repo dominate or vanish for reasons
 * unrelated to relevance. Rank sidesteps that entirely.
 *
 * No weights and no boosts. This repo justifies retrieval changes with a checked-in
 * ablation, and tunables that arrive without one cannot be evaluated. Ties break toward the
 * local repo; that is the whole of the local preference.
 */
export async function queryFederated(input: {
  workspace: ActiveWorkspace;
  localItems: KnowledgeItem[];
  query: string;
  limit: number;
  repos?: string[];
  perRepoCap?: number;
  /**
   * The query embedding, when the caller has one.
   *
   * Supplying it is what makes cross-repo ranking compare match *strength* rather than
   * position. Without it the fusion falls back to reciprocal rank, where a weak rank-1 in
   * one repo ties a strong rank-1 in another and the local tie-break decides -- which is
   * exactly the failure recorded in docs/evals/cross-repo-baseline.json.
   */
  queryEmbedding?: number[];
  /** Local vectors by item id, so local candidates are scored the same way peers are. */
  localVectors?: Map<string, number[]>;
}): Promise<FederatedResult> {
  const cap = input.perRepoCap ?? DEFAULT_PER_REPO_CAP;
  const wanted = input.repos && input.repos.length > 0 ? new Set(input.repos) : null;
  const skipped: FederatedResult['skipped'] = [];
  const ranked: Array<{ item: FederatedItem; score: number; local: boolean; semantic: boolean }> = [];
  const embedding = input.queryEmbedding;

  /**
   * Cosine when both sides have a vector, otherwise the reciprocal-rank position score.
   *
   * The two live on different scales, so a semantically scored candidate is never compared
   * against a positionally scored one -- `semantic` partitions them and every semantic hit
   * sorts above the fallback group. Mixing them would let an unembedded item's 1/(k+1)
   * outrank a genuine 0.8 cosine for no reason but arithmetic.
   */
  const scoreFor = (vector: number[] | null | undefined, position: number) => {
    if (embedding && vector) return { score: cosineSimilarity(embedding, vector), semantic: true };
    return { score: 1 / (RRF_K + position + 1), semantic: false };
  };

  if (!wanted || wanted.has(input.workspace.repo)) {
    input.localItems.slice(0, cap).forEach((item, index) => {
      const { score, semantic } = scoreFor(input.localVectors?.get(item.id), index);
      ranked.push({ item: { ...item, repo: input.workspace.repo }, score, local: true, semantic });
    });
  }

  for (const peer of input.workspace.peers) {
    if (wanted && !wanted.has(peer.name)) continue;
    if (!peer.present) {
      skipped.push({ repo: peer.name, reason: 'absent' });
      continue;
    }
    try {
      const candidates = await peerCandidates(peer, input.query, cap, embedding);
      candidates.forEach((candidate, index) => {
        const { score, semantic } = scoreFor(candidate.vector, index);
        ranked.push({ item: { ...candidate.item, repo: peer.name }, score, local: false, semantic });
      });
    } catch (error) {
      skipped.push({ repo: peer.name, reason: error instanceof SchemaTooNewError ? 'schema-too-new' : 'unreadable' });
    }
  }

  const seen = new Set<string>();
  const items = ranked
    // Semantic hits first as a group, then by score, then local. Ties break toward the
    // local repo and nothing else -- that remains the whole of the local preference.
    .sort((a, b) =>
      (Number(b.semantic) - Number(a.semantic))
      || (b.score - a.score)
      || (Number(b.local) - Number(a.local)))
    .filter(entry => {
      const key = entry.item.contentHash ?? `${entry.item.title}\n${entry.item.content}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, input.limit)
    .map(entry => entry.item);

  return { items, skipped };
}
