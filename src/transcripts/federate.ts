import fs from 'node:fs/promises';
import type { KnowledgeEmbedder } from '../store/vector-index.js';
import { loadConfig } from '../core/config.js';
import { resolveStorage } from '../store/storage-roles.js';
import type { ActiveWorkspace } from '../workspace/resolve.js';
import { isTranscriptSharingEnabled } from './config.js';
import { openTranscriptDb, TranscriptIndexMissingError } from './database.js';
import { fuseRankings, judgeRelevanceFloor, searchTranscripts, type TranscriptHit } from './search.js';

export type FederatedTranscriptHit = TranscriptHit & { repo: string };
export type TranscriptSkipReason = 'absent' | 'not-shared' | 'unreadable';
export type RepoCoverage = {
  repo: string;
  embedded: number;
  indexed: number;
  /** Whether that repo's last index pass caught up with its archive. */
  indexComplete: boolean;
};

/**
 * Search this repo's transcripts and, where a peer has opted in, its linked repos'.
 *
 * Each repo owns its own `transcripts.db` and a peer's is opened read-only -- nothing is copied
 * and nothing is promoted, so revoking access is one config flag with no residue to chase.
 *
 * Two things do NOT follow from "search each repo and concatenate":
 *
 * **Ranking.** A repo's RRF scores are computed within its own candidate set and are not
 * comparable across repos. Sorting the merged list by them makes ties fall in repo iteration
 * order -- a bias dressed as a ranking, and one that systematically favours whichever repo was
 * visited first. Instead the per-repo orders are re-fused by a second RRF over *positions*, so
 * one repo's rank-1 competes with another's rank-1 on equal terms whatever their corpus sizes.
 *
 * **Coverage.** Reported per repo, never summed. A peer at 12% and a local index at 100%
 * average to a number describing neither, and the whole point of the signal is to say whether a
 * near-miss can be trusted.
 */
export async function searchTranscriptsFederated(input: {
  projectRoot: string;
  workspace: ActiveWorkspace | null;
  query: string;
  limit: number;
  sessionId?: string;
  repos?: string[];
  embedder?: KnowledgeEmbedder;
  localRepoName?: string;
}): Promise<{
  hits: FederatedTranscriptHit[];
  skipped: Array<{ repo: string; reason: TranscriptSkipReason }>;
  coverage: RepoCoverage[];
  /** Per repo, the sessions a `sessionId` prefix named there when it named more than one. */
  ambiguous: Array<{ repo: string; candidates: string[] }>;
  /**
   * Which repo name means "here". Returned rather than assumed: the caller must omit it when
   * formatting a locator, or a local hit becomes `transcript://local/...` and the reader --
   * which resolves a named repo against the workspace peer list -- answers "Unknown repo".
   */
  localRepo: string;
  /**
   * The query does not read as being about any archive that answered: a semantic half ran, and
   * the best hit across every repo scored below this model's relevance floor.
   *
   * Off-subject, not unanswerable -- the narrow reading `abstained` carries on `knowl_query`.
   * `undefined` means unjudged: no embedder, no measured floor for this model, or nothing
   * returned carried a cosine.
   */
  belowRelevanceFloor?: boolean;
}> {
  const localName = input.localRepoName ?? input.workspace?.repo ?? 'local';
  const wanted = input.repos?.length ? new Set(input.repos) : null;
  const skipped: Array<{ repo: string; reason: TranscriptSkipReason }> = [];
  const coverage: RepoCoverage[] = [];
  // Per repo, because a prefix that names one session here can name three in a peer.
  const ambiguous: Array<{ repo: string; candidates: string[] }> = [];
  /** One ordered list per repo, kept separate so RRF can fuse positions rather than scores. */
  const rankings: FederatedTranscriptHit[][] = [];

  // Read-only for every repo including this one. Searching writes nothing, and a writable open
  // creates the file -- which would resurrect an index the user deleted by turning the feature
  // off, from a code path that only reads.
  const search = async (repo: string, dbPath: string) => {
    const client = await openTranscriptDb(dbPath, { readOnly: true });
    const result = await searchTranscripts({
      client,
      query: input.query,
      limit: input.limit,
      sessionId: input.sessionId,
      projectRoot: input.projectRoot,
      embedder: input.embedder,
    });
    rankings.push(result.hits.map(hit => ({ ...hit, repo })));
    coverage.push({ repo, ...result.coverage, indexComplete: result.indexComplete });
    if (result.ambiguousSession) ambiguous.push({ repo, candidates: result.ambiguousSession });
  };

  if (!wanted || wanted.has(localName)) {
    const localDb = resolveStorage(input.projectRoot).transcripts;
    try {
      await search(localName, localDb);
    } catch (error) {
      // Missing is a legitimate state -- the feature was enabled but never indexed, or the
      // index was just deleted. Anything else is a real failure worth distinguishing.
      skipped.push({
        repo: localName,
        reason: error instanceof TranscriptIndexMissingError ? 'absent' : 'unreadable',
      });
    }
  }

  for (const peer of input.workspace?.peers ?? []) {
    if (wanted && !wanted.has(peer.name)) continue;

    // `present` is resolveWorkspace's own verdict on whether the peer is checked out here.
    // Trusting it keeps this consistent with queryFederated rather than re-deciding.
    if (!peer.present) {
      skipped.push({ repo: peer.name, reason: 'absent' });
      continue;
    }

    // Not `peer.databasePath` -- that is the peer's *knowledge* database. Transcripts live in
    // their own file, which is what makes "feature off" mean a file that does not exist.
    const peerDb = resolveStorage(peer.root).transcripts;

    // Checked before reading the peer's config so a repo that simply has no index reports
    // `absent` rather than `unreadable` -- loadConfig would fail first and mislabel it. The
    // catch below still covers the gap between this check and the open.
    if (!(await fs.access(peerDb).then(() => true, () => false))) {
      skipped.push({ repo: peer.name, reason: 'absent' });
      continue;
    }

    try {
      // The peer's own config decides, not ours. Sharing is theirs to grant.
      const peerConfig = await loadConfig(peer.root);
      if (!isTranscriptSharingEnabled(peerConfig)) {
        skipped.push({ repo: peer.name, reason: 'not-shared' });
        continue;
      }
      await search(peer.name, peerDb);
    } catch (error) {
      skipped.push({
        repo: peer.name,
        reason: error instanceof TranscriptIndexMissingError ? 'absent' : 'unreadable',
      });
    }
  }

  // Repo-qualified key: message ids are unique within a database, not across them, so the
  // default key would silently merge two repos' message 5 into one hit.
  const hits = fuseRankings(rankings, input.limit, hit => `${hit.repo}:${hit.messageId}`);

  // Re-judged on the FUSED page rather than carried from any one repo: the question is whether
  // the query is about anything the workspace holds, and a repo that missed says nothing about
  // the one that hit.
  const belowRelevanceFloor = judgeRelevanceFloor(hits, input.embedder?.relevanceFloor ?? null);

  return { hits, skipped, coverage, ambiguous, localRepo: localName, belowRelevanceFloor };
}
