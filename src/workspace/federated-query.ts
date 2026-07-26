import type { KnowledgeItem } from '../core/types.js';
import { RRF_K } from '../store/agent-query.js';
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

async function peerCandidates(peer: PeerRepo, query: string, cap: number): Promise<KnowledgeItem[]> {
  const client = await acquireClient(peer.databasePath, { readOnly: true });
  const tokens = queryTokens(query);
  if (tokens.length === 0) return [];

  // Any token may match, and the count of matching tokens orders the result -- a title hit
  // counts double, mirroring the weighting the local ranker gives titles. This stays a
  // deliberately cheap scan: it only has to produce a sane candidate ordering, because RRF
  // fuses on position and the per-repo cap bounds how far a weak candidate can travel.
  const where = tokens.map(() => '(lower(title) LIKE ? OR lower(content) LIKE ?)').join(' OR ');
  const score = tokens
    .map(() => '(CASE WHEN lower(title) LIKE ? THEN 2 ELSE 0 END) + (CASE WHEN lower(content) LIKE ? THEN 1 ELSE 0 END)')
    .join(' + ');
  const patterns = tokens.flatMap(token => [`%${token}%`, `%${token}%`]);

  const rows = await client.execute({
    sql: `SELECT id, category, status, title, content, reasoning, tags, source, content_hash,
                 freshness, confidence, version, created_at, updated_at, origin_repo, visibility,
                 ${score} AS match_score
          FROM knowledge_items
          WHERE status = 'active' AND visibility = 'workspace' AND (${where})
          ORDER BY match_score DESC, updated_at DESC
          LIMIT ?`,
    args: [...patterns, ...patterns, cap],
  });

  return rows.rows.map(row => ({
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
  })) as unknown as KnowledgeItem[];
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
}): Promise<FederatedResult> {
  const cap = input.perRepoCap ?? DEFAULT_PER_REPO_CAP;
  const wanted = input.repos && input.repos.length > 0 ? new Set(input.repos) : null;
  const skipped: FederatedResult['skipped'] = [];
  const ranked: Array<{ item: FederatedItem; score: number; local: boolean }> = [];

  if (!wanted || wanted.has(input.workspace.repo)) {
    input.localItems.slice(0, cap).forEach((item, index) => {
      ranked.push({
        item: { ...item, repo: input.workspace.repo },
        score: 1 / (RRF_K + index + 1),
        local: true,
      });
    });
  }

  for (const peer of input.workspace.peers) {
    if (wanted && !wanted.has(peer.name)) continue;
    if (!peer.present) {
      skipped.push({ repo: peer.name, reason: 'absent' });
      continue;
    }
    try {
      const candidates = await peerCandidates(peer, input.query, cap);
      candidates.forEach((item, index) => {
        ranked.push({ item: { ...item, repo: peer.name }, score: 1 / (RRF_K + index + 1), local: false });
      });
    } catch (error) {
      skipped.push({ repo: peer.name, reason: error instanceof SchemaTooNewError ? 'schema-too-new' : 'unreadable' });
    }
  }

  const seen = new Set<string>();
  const items = ranked
    .sort((a, b) => (b.score - a.score) || (Number(b.local) - Number(a.local)))
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
