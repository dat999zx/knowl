import fs from 'node:fs/promises';
import type { KnowledgeEmbedder } from '../store/vector-index.js';
import { loadConfig } from '../core/config.js';
import { resolveStorage } from '../store/storage-roles.js';
import type { ActiveWorkspace } from '../workspace/resolve.js';
import { isTranscriptSharingEnabled } from './config.js';
import { openTranscriptDb } from './database.js';
import { fuseRankings, searchTranscripts, type TranscriptHit } from './search.js';

export type FederatedTranscriptHit = TranscriptHit & { repo: string };
export type TranscriptSkipReason = 'absent' | 'not-shared' | 'unreadable';
export type RepoCoverage = { repo: string; embedded: number; indexed: number };

async function exists(target: string): Promise<boolean> {
  return fs.access(target).then(() => true).catch(() => false);
}

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
  /**
   * Which repo name means "here". Returned rather than assumed: the caller must omit it when
   * formatting a locator, or a local hit becomes `transcript://local/...` and the reader --
   * which resolves a named repo against the workspace peer list -- answers "Unknown repo".
   */
  localRepo: string;
}> {
  const localName = input.localRepoName ?? input.workspace?.repo ?? 'local';
  const wanted = input.repos?.length ? new Set(input.repos) : null;
  const skipped: Array<{ repo: string; reason: TranscriptSkipReason }> = [];
  const coverage: RepoCoverage[] = [];
  /** One ordered list per repo, kept separate so RRF can fuse positions rather than scores. */
  const rankings: FederatedTranscriptHit[][] = [];

  const search = async (repo: string, dbPath: string, readOnly: boolean) => {
    const client = await openTranscriptDb(dbPath, { readOnly });
    const result = await searchTranscripts({
      client,
      query: input.query,
      limit: input.limit,
      sessionId: input.sessionId,
      projectRoot: input.projectRoot,
      embedder: input.embedder,
    });
    rankings.push(result.hits.map(hit => ({ ...hit, repo })));
    coverage.push({ repo, ...result.coverage });
  };

  if (!wanted || wanted.has(localName)) {
    const localDb = resolveStorage(input.projectRoot).transcripts;
    if (await exists(localDb)) await search(localName, localDb, false);
    else skipped.push({ repo: localName, reason: 'absent' });
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
    if (!(await exists(peerDb))) {
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
      await search(peer.name, peerDb, true);
    } catch {
      skipped.push({ repo: peer.name, reason: 'unreadable' });
    }
  }

  // Repo-qualified key: message ids are unique within a database, not across them, so the
  // default key would silently merge two repos' message 5 into one hit.
  const hits = fuseRankings(rankings, input.limit, hit => `${hit.repo}:${hit.messageId}`);

  return { hits, skipped, coverage, localRepo: localName };
}
