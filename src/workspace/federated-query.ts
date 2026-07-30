import type { ExplainedKnowledgeItem, KnowledgeCategory, KnowledgeItem, KnowledgeStatus } from '../core/types.js';
import { scoreCandidates, selectCandidates, type Candidate, type RankOptions } from '../store/agent-query.js';
import { openPeerStore } from '../store/store-handle.js';
import { SchemaTooNewError } from '../store/schema-version.js';
import type { ActiveWorkspace } from './resolve.js';

export type FederatedItem = KnowledgeItem & {
  repo: string;
  explanation?: ExplainedKnowledgeItem['explanation'];
};
export type SkipReason = 'absent' | 'unreadable' | 'schema-too-new';
export type FederatedResult = {
  items: FederatedItem[];
  skipped: Array<{ repo: string; reason: SkipReason }>;
};

const DEFAULT_PER_REPO_CAP = 10;

type RepoCandidate = Candidate & { repo: string };

/**
 * Search this repo and every linked one, as a single ranking.
 *
 * Federation owns selection. An earlier shape had the caller run its own local query and pass
 * the results in, which meant two call sites reproducing the selection half of the ranker and
 * a `localItems` parameter whose contents were scored by different rules than the peers'.
 *
 * Selection is per store, because it is a database read. Scoring runs **once** over every
 * repo's candidates together. That is not a tidiness preference: `normalizedRecencyScore`
 * normalizes each item's date against the candidate set it arrives with, so ranking each repo
 * separately and fusing the results gives every repo's newest item the same recency score
 * regardless of how old it actually is. Scoring the union is what makes "recent" mean recent.
 *
 * There is no separate fusion step, no reciprocal-rank blending and no semantic/positional
 * partition. All three existed only to reconcile scores computed apart from each other.
 */
export async function queryFederated(input: {
  workspace: ActiveWorkspace;
  query: string;
  limit: number;
  category?: KnowledgeCategory;
  status?: KnowledgeStatus;
  tags?: string[];
  repos?: string[];
  perRepoCap?: number;
  /**
   * The local vector config, including the query embedding when one was produced.
   *
   * A workspace pins one embedding identity (`assertSafeToLink`), so the peer's vectors live
   * in the same space and the same provider/model filter is the right one to apply there.
   */
  vector?: RankOptions['vector'];
}): Promise<FederatedResult> {
  const cap = input.perRepoCap ?? DEFAULT_PER_REPO_CAP;
  const wanted = input.repos && input.repos.length > 0 ? new Set(input.repos) : null;
  const skipped: FederatedResult['skipped'] = [];
  const candidates: RepoCandidate[] = [];

  const selection: RankOptions = {
    query: input.query,
    category: input.category,
    status: input.status ?? 'active',
    tags: input.tags,
    limit: cap,
    vector: input.vector,
  };

  if (!wanted || wanted.has(input.workspace.repo)) {
    const mine = await selectCandidates('local', selection);
    for (const candidate of mine) candidates.push({ ...candidate, repo: input.workspace.repo });
  }

  for (const peer of input.workspace.peers) {
    if (wanted && !wanted.has(peer.name)) continue;
    if (!peer.present) {
      skipped.push({ repo: peer.name, reason: 'absent' });
      continue;
    }
    try {
      const store = await openPeerStore(peer.databasePath);
      const found = await selectCandidates('local', {
        ...selection,
        // Not a post-filter: the predicate is in the SQL, so a peer's repo-private row is
        // never read into this process at all.
        visibility: 'workspace',
      }, store);
      for (const candidate of found) candidates.push({ ...candidate, repo: peer.name });
    } catch (error) {
      skipped.push({ repo: peer.name, reason: error instanceof SchemaTooNewError ? 'schema-too-new' : 'unreadable' });
    }
  }

  // Identical content in two repos is one fact, and the local copy is the one to keep: the
  // querying repo owns it, and preferring local is already this file's only tie-break rule.
  // Done before scoring so a duplicate cannot occupy a result slot and then be dropped,
  // returning a list shorter than the caller asked for with nothing to explain the gap.
  const byContent = new Map<string, RepoCandidate>();
  for (const candidate of candidates) {
    const key = candidate.item.contentHash ?? `${candidate.item.title}\n${candidate.item.content}`;
    const held = byContent.get(key);
    if (!held || (held.repo !== input.workspace.repo && candidate.repo === input.workspace.repo)) {
      byContent.set(key, candidate);
    }
  }

  const scored = scoreCandidates([...byContent.values()], {
    query: input.query,
    category: input.category,
    limit: input.limit,
    usingVector: Boolean(input.vector?.enabled && input.vector.embedding),
  });

  return {
    items: scored.map(entry => ({
      ...entry.item,
      repo: entry.repo ?? input.workspace.repo,
      explanation: entry.explanation,
    })),
    skipped,
  };
}
