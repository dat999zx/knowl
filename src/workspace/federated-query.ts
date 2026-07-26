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
async function peerCandidates(peer: PeerRepo, query: string, cap: number): Promise<KnowledgeItem[]> {
  const client = await acquireClient(peer.databasePath, { readOnly: true });
  const like = `%${query.toLowerCase()}%`;
  const rows = await client.execute({
    sql: `SELECT id, category, status, title, content, reasoning, tags, source, content_hash,
                 freshness, confidence, version, created_at, updated_at, origin_repo, visibility
          FROM knowledge_items
          WHERE status = 'active' AND visibility = 'workspace'
            AND (lower(title) LIKE ? OR lower(content) LIKE ?)
          ORDER BY updated_at DESC
          LIMIT ?`,
    args: [like, like, cap],
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
