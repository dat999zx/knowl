import type { ExplainedKnowledgeItem, KnowledgeCategory, KnowledgeItem, KnowledgeStatus } from '../core/types.js';
import { scoreCandidates, selectCandidates, type Candidate, type RankOptions, type ScoredCandidate } from '../store/agent-query.js';
import { openPeerStore } from '../store/store-handle.js';
import { PeerDatabaseMissingError } from '../store/connection-pool.js';
import { SchemaTooNewError } from '../store/schema-version.js';
import type { ActiveWorkspace } from './resolve.js';

export type FederatedItem = KnowledgeItem & {
  repo: string;
  explanation?: ExplainedKnowledgeItem['explanation'];
  /**
   * This result came from a peer in the caller's own `kin` group: same lineage, diverged
   * conventions. Present only when true, like `abstained` -- the ordinary result pays nothing.
   *
   * Kin was a write-time signal only. `findCrossRepoOverlap` looks wider in a kin peer and
   * `formatCrossRepoNotice` says "shares this repo's lineage", so someone STORING knowledge was
   * told about divergence and someone READING it was not -- and reading is where a diverged
   * convention actually gets applied to the wrong repo.
   */
  kinDivergent?: true;
  /**
   * This row came from the cloud replica rather than from a store on disk.
   *
   * Attached for the same reason as `kinDivergent`: the response shape, not a field, is what
   * tells a reader where a row came from -- and "a colleague published this" is a different
   * provenance from "this is in a repo you have checked out".
   */
  remote?: true;
};
export type SkipReason = 'absent' | 'unreadable' | 'schema-too-new' | 'unknown';

export type FederatedGroup = { repo: string; items: FederatedItem[] };

export type FederatedResult = {
  /**
   * Results partitioned by owning repo, local always first and present even when empty.
   *
   * Grouping is the mechanism, not a decoration on one. A bare array reads as "this repo's
   * answer", and no notice printed beside one is loud enough to stop it being read that way
   * when the rows are foreign -- the `repo` field was already on every row and lost to a
   * standing instruction to use a relevant hit immediately. A response whose *shape* is wrong
   * for "this repo's answer" cannot be read as one.
   */
  groups: FederatedGroup[];
  /**
   * Peers whose candidates were scored but won no slot, by name and count.
   *
   * Never content: including it would reintroduce exactly the silent substitution grouping
   * exists to remove. Counts are bounded by `perRepoCap`, so a peer holding more matches than
   * the cap reports the cap rather than the truth -- an undercount, which is the safe direction
   * for a pointer whose only job is "there is more over there".
   */
  unshown: Array<{ repo: string; matches: number }>;
  /**
   * Flat iff every returned row is local.
   *
   * An explicit `scope` or `repos` fixes this instead of deriving it: a caller who named repos
   * asked for a partitioned view and gets one whether or not the partition turned out
   * interesting. A shape that changed under them based on what was found would be worse than a
   * one-key object.
   */
  shape: 'flat' | 'grouped';
  skipped: Array<{ repo: string; reason: SkipReason }>;
};

/**
 * One ranking again, local first then peers in group order.
 *
 * For callers that genuinely need a single list -- the eval suites, which score MRR over a
 * ranking -- rather than for the agent-facing surfaces, whose whole point is that the list is
 * not single.
 */
export function flattenGroups(result: FederatedResult): FederatedItem[] {
  return result.groups.flatMap(group => group.items);
}

const DEFAULT_PER_REPO_CAP = 10;

type RepoCandidate = Candidate & { repo: string; remote?: true };

/**
 * A checked-out peer with no database is `absent`, not `unreadable`.
 *
 * It is the same state `resolveWorkspace` already calls absent one level up -- nothing of that
 * repo's knowledge is here -- and it is the ordinary condition of a member repo that has been
 * cloned but not yet used. Calling it unreadable would report a fault where there is none.
 */
function skipReasonFor(error: unknown): SkipReason {
  if (error instanceof PeerDatabaseMissingError) return 'absent';
  if (error instanceof SchemaTooNewError) return 'schema-too-new';
  return 'unreadable';
}

/**
 * Peers that matched and reached the page with **nothing at all**, by name and count.
 *
 * Deliberately not "peers with candidates below the fold". `perRepoCap` admits ten candidates per
 * repo whatever their quality and the MCP default `limit` is three, so counting every unshown
 * candidate fires this on very nearly every federated query -- and each firing points at rows the
 * ranker had already placed below everything shown. A notice that always fires is one a reader
 * stops seeing, and this one asks for a second query, so the noise is not free.
 *
 * A peer with even one row on the page is already visible and needs no pointer. A peer with none
 * is invisible: the reader cannot tell it from a repo that holds nothing, and that is the only
 * case where "there is more over there" is news.
 *
 * Counted from the candidate set rather than the page, because the page is what did reach the
 * reader. Bounded by `perRepoCap`, so a peer holding more than the cap undercounts -- the safe
 * direction for a pointer that only claims something exists.
 */
function countUnshown(
  candidates: Array<{ item: { id: string }; repo: string }>,
  page: ScoredCandidate[],
  localRepo: string,
): Array<{ repo: string; matches: number }> {
  const onPage = new Set(page.map(entry => entry.repo ?? localRepo));
  const counts = new Map<string, number>();
  for (const candidate of candidates) {
    if (candidate.repo === localRepo || onPage.has(candidate.repo)) continue;
    counts.set(candidate.repo, (counts.get(candidate.repo) ?? 0) + 1);
  }
  return [...counts].map(([repo, matches]) => ({ repo, matches }));
}

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
  /**
   * A named scope, for callers that do not know their own repo's name.
   *
   * `repos: ['<self>']` already means local-only, and an agent cannot reliably write it -- it
   * would have to know what this repo is called in the manifest, which is a fact about the
   * workspace file rather than about the query. That is the whole reason this exists beside
   * `repos` rather than instead of it.
   *
   * `repos` wins when both arrive: it is the more specific of the two, and refusing a benign
   * combination would cost a caller their answer over a preference.
   */
  scope?: 'local' | 'workspace';
  perRepoCap?: number;
  /**
   * Candidate budget for the replica, separately from `perRepoCap`.
   *
   * One local peer is one repo; the replica is every repo in the workspace at once. Giving it
   * the same budget as a single peer under-samples a corpus that is an order of magnitude
   * larger, and the ranker cannot promote a candidate it never saw.
   */
  cloudCap?: number;
  /**
   * The local vector config, including the query embedding when one was produced.
   *
   * Applies to THIS repo's store and to the cloud replica, which is embedded under this
   * project's own profile. Peers get `peerVector` instead -- see below for why they must.
   */
  vector?: RankOptions['vector'];
  /**
   * The vector option for one peer, embedded under THAT repo's profile.
   *
   * This file used to hand `vector` to every peer, on the stated grounds that a workspace pins
   * one embedding identity at link time. It does not hold (#187). `assertEmbeddingCompatible`
   * compares four fields -- provider, model, dtype, pooling -- while the filter applied to a
   * peer store compares `profile_fingerprint`, a hash of those four PLUS
   * `EMBEDDING_BATCH_POLICY` and `EMBED_RECIPE_VERSION`. So two repos with identical vector
   * config mismatch whenever they sit on different knowl versions, and nothing re-checks after
   * linking. A cloud-connected repo cannot align even in principle: its atoms must stay on the
   * cloud's serving model while the manifest pins another.
   *
   * The failure was silent. A mismatched peer contributed zero vector candidates and the search
   * degraded to BM25-only while still returning rows, so it read as healthy.
   *
   * Fusing per-repo native models is what this file already assumes elsewhere: ranking merges
   * positions rather than raw scores precisely because scores are not comparable across repos,
   * so arctic at 0.16 and granite at 0.76 never have to meet on one scale.
   *
   * Injected rather than imported: `workspace` and `ai` are the same layer, so `workspace -> ai`
   * is a sideways edge the architecture test forbids. Returning `undefined` degrades that one
   * peer to lexical, which is the honest answer when its model cannot be loaded here.
   */
  peerVector?: (peer: { name: string; root: string }, query: string) => Promise<RankOptions['vector'] | undefined>;
}): Promise<FederatedResult> {
  const cap = input.perRepoCap ?? DEFAULT_PER_REPO_CAP;
  const named = input.repos && input.repos.length > 0 ? input.repos : null;
  // `repos` first, then `scope`. Only `local` narrows -- `workspace` is the default reach and
  // says so explicitly, which is what makes it a shape declaration rather than a filter.
  const scoped = named ?? (input.scope === 'local' ? [input.workspace.repo] : null);
  const wanted = scoped ? new Set(scoped) : null;
  const skipped: FederatedResult['skipped'] = [];
  const candidates: RepoCandidate[] = [];

  // A name that matches no repo used to filter every real one out and return nothing, which
  // reads as "the workspace does not know this" -- the one conclusion a misspelling must not
  // produce. Reported rather than raised: a request naming three repos and one typo should
  // still search the three, and the notice is what makes the fourth's absence visible.
  if (wanted) {
    // The cloud workspace id belongs in here because it is a name `repos` accepts: the replica
    // below is searched when it is named. Left out, naming it produced a response that both
    // returned its rows and reported it unknown -- and `unknown` is the one notice that tells a
    // caller their name matched nothing, so a response contradicting itself on that point is
    // worse than either verdict alone.
    const known = new Set([input.workspace.repo, ...input.workspace.peers.map(peer => peer.name)]);
    if (input.workspace.cloud) known.add(input.workspace.cloud.workspaceId);
    for (const name of wanted) {
      if (!known.has(name)) skipped.push({ repo: name, reason: 'unknown' });
    }
  }

  // Per-corpus embedding facts, filled in as each peer is searched. Empty when every peer used
  // this repo's profile, which is what keeps a single-profile workspace scoring exactly as it
  // did: `scoreCandidates` falls back to one shared range and one floor.
  //
  // Every corpus gets an entry, including this repo's and the replica's, so that a peer sharing
  // this repo's profile lands in the SAME bucket rather than a differently-named one. Keying
  // local implicitly and peers explicitly would split a range that is genuinely shared, which is
  // the regression the archetype baseline catches.
  const semanticScaleByCorpus = new Map<string, string>();
  const minRelevanceByCorpus = new Map<string, number | null>();
  if (input.vector?.enabled && input.vector.embedding) {
    const localScale = input.vector.profileFingerprint ?? '';
    const localFloor = input.vector.relevanceFloor ?? null;
    semanticScaleByCorpus.set(input.workspace.repo, localScale);
    minRelevanceByCorpus.set(input.workspace.repo, localFloor);
    // The replica is embedded under this project's own profile, so it shares both.
    if (input.workspace.cloud) {
      semanticScaleByCorpus.set(input.workspace.cloud.workspaceId, localScale);
      minRelevanceByCorpus.set(input.workspace.cloud.workspaceId, localFloor);
    }
  }

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
      // The peer's own profile, not this repo's. Absent resolver keeps the old behaviour for
      // callers that have not been wired up; `undefined` from the resolver means this peer
      // searches lexically, which is right when its model is unavailable here.
      const peerVector = input.peerVector
        ? await input.peerVector({ name: peer.name, root: peer.root }, input.query)
        : input.vector;
      // What scale this peer's cosines are on, and what floor may judge them. Recorded only
      // when it actually searched with vectors -- a lexical-only peer has no cosines to place.
      if (peerVector?.enabled && peerVector.embedding) {
        semanticScaleByCorpus.set(peer.name, peerVector.profileFingerprint ?? '');
        minRelevanceByCorpus.set(peer.name, peerVector.relevanceFloor ?? null);
      }
      const found = await selectCandidates('local', {
        ...selection,
        vector: peerVector,
        // Not a post-filter: the predicate is in the SQL, so a peer's repo-private row is
        // never read into this process at all.
        visibility: 'workspace',
      }, store);
      for (const candidate of found) candidates.push({ ...candidate, repo: peer.name });
    } catch (error) {
      skipped.push({ repo: peer.name, reason: skipReasonFor(error) });
    }
  }

  // The replica is read exactly like a peer -- same `openPeerStore`, same `selectCandidates`,
  // same scoring -- because it is embedded under this project's own profile. What differs is
  // attribution: a peer's rows are all that peer's, while every replica row carries its own
  // `originRepo`, so the repo label is read per row rather than per store.
  //
  // Deliberately not filtered on `visibility`. The replica holds only what the server chose to
  // publish, so a repo-private row appearing here is a server bug, and filtering it silently
  // would hide the one symptom. Task 4 asserts the invariant instead.
  if (input.workspace.cloud && (!wanted || wanted.has(input.workspace.cloud.workspaceId))) {
    const replica = input.workspace.cloud;
    if (!replica.present) {
      skipped.push({ repo: replica.workspaceId, reason: 'absent' });
    } else {
      try {
        const store = await openPeerStore(replica.databasePath);
        const found = await selectCandidates('local', {
          ...selection,
          limit: input.cloudCap ?? cap * 3,
        }, store);
        for (const candidate of found) {
          candidates.push({
            ...candidate,
            // Falls back to the workspace id only when the server sent no owner, which it
            // should never do. Labelling those with this repo's own name would be worse than
            // an odd-looking group: it would claim authorship.
            repo: candidate.item.originRepo ?? replica.workspaceId,
            remote: true,
          });
        }
      } catch (error) {
        skipped.push({ repo: replica.workspaceId, reason: skipReasonFor(error) });
      }
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

  // Scored over the union, and relevance alone decides which rows reach the page.
  //
  // An earlier version of this file allocated slots by ownership -- every local candidate before
  // any peer one -- so that a peer answer could never be mistaken for this repo's own. It was
  // measured against `docs/evals/cross-repo-archetypes.json` and it does not work: `perRepoCap`
  // admits ten candidates per repo whatever their quality, so a local repo nearly always holds
  // `limit` weak FTS matches, and peers were shut out of the page entirely. Recall@3 fell on
  // every one of the five archetypes -- asymmetric-trio 1.0 -> 0.361, monorepo-split 1.0 -> 0.528
  // -- which is not the answer ranking lower but the answer leaving the page.
  //
  // The mistake was over-reading the abstention measurements. They say no ABSOLUTE threshold can
  // separate "weak local answer" from "no local answer"; they say nothing against ranking a local
  // row against a peer row inside one scored union, which is the comparison `corpusBest` and
  // `lexicalCoverage` exist to make valid. Attribution belongs in the response shape, where it
  // costs no recall, and not in slot allocation, where it costs a great deal.
  //
  // The union itself is not negotiable, and recency is only one of four reasons. `alpha`
  // renormalises globally because "two repos scored under different alphas would not be
  // comparable, which is the whole reason scoring runs over the union"; `rescaleSemantic`
  // min-maxes across the candidate page; and the abstention verdict deliberately labels rows from
  // a corpus that judged nothing, which is how an off-topic peer item once became the answer to a
  // question the indexed store had just said it could not answer (K-36).
  const scored = scoreCandidates([...byContent.values()], {
    query: input.query,
    category: input.category,
    limit: input.limit,
    usingVector: Boolean(input.vector?.enabled && input.vector.embedding),
    // Without this the floor is `null` here and `answerable` is unconditionally true, so no
    // federated result could ever carry `abstained` -- and the caller's NO CONFIDENT MATCH
    // notice was unreachable code from the moment a workspace was linked. The abstention
    // verdict is not a local-only property: the union is exactly the corpus being judged, and a
    // workspace is where "the store does not hold this" is most expensive to get wrong, because
    // the alternative on offer is the peer's near-miss. Same expression as `rankKnowledge`.
    minRelevance: input.vector?.relevanceFloor ?? null,
    // Both empty unless a peer searched under a different profile, so the single-profile path
    // is untouched. See #187.
    semanticScaleByCorpus,
    minRelevanceByCorpus,
  });

  // Which peers are the same lineage as the caller. Read from the manifest rather than from the
  // peer list, because `kin` is a group name and sameness is what matters, not its presence:
  // an unrelated pair of repos each carrying a different `kin` are not kin to each other.
  const selfKin = input.workspace.manifest.repos.find(entry => entry.name === input.workspace.repo)?.kin;
  const kinRepos = new Set(
    selfKin
      ? input.workspace.peers.filter(peer => peer.kin === selfKin).map(peer => peer.name)
      : [],
  );

  // Which group names came from the replica. Read from the candidates rather than re-derived,
  // because the same repo name can only ever arrive from one side: a checked-out peer is
  // named by the manifest and a replica row by its `originRepo`.
  const remoteRepos = new Set(
    [...byContent.values()].filter(candidate => candidate.remote).map(candidate => candidate.repo),
  );

  const unshown = countUnshown([...byContent.values()], scored, input.workspace.repo);

  // Local first and always present, including when it holds nothing. An empty group under this
  // repo's own name is the response saying "your repo had nothing on this" -- the sentence a
  // bare array could not form, and the one an agent needs before it applies a foreign fact here.
  //
  // Ordering WITHIN a group is the ranker's, and the groups themselves are ordered by their best
  // row, so nothing here overturns relevance. What grouping changes is only whether a reader can
  // see who owns each row without reading a field.
  //
  const localSearched = !wanted || wanted.has(input.workspace.repo);

  // Group order is first-appearance order in `scored`, which IS the ranker's order.
  //
  // Not a sort on each group's best score, which an earlier version did and which quietly
  // undoes near-duplicate demotion: `scoreCandidates` returns `[...kept, ...deferred]`, so a row
  // the ranker deliberately pushed to the back keeps the high score it was demoted *despite*.
  // Read that score and a repo whose only row is a demoted duplicate sorts above a repo the
  // ranker placed ahead of it -- most reachable between kin forks, where paraphrases survive the
  // `byContent` dedup above. Walking the list preserves the verdict without re-deriving it.
  const withRows: FederatedGroup[] = [];
  const byRepo = new Map<string, FederatedGroup>();
  for (const entry of scored) {
    const repo = entry.repo ?? input.workspace.repo;
    let group = byRepo.get(repo);
    if (!group) {
      group = { repo, items: [] };
      byRepo.set(repo, group);
      withRows.push(group);
    }
    group.items.push({
      ...entry.item,
      repo,
      explanation: entry.explanation,
      ...(kinRepos.has(repo) ? { kinDivergent: true as const } : {}),
      ...(remoteRepos.has(repo) ? { remote: true as const } : {}),
    });
  }

  // A searched repo that found nothing still gets a key, because an empty array under a repo's
  // name is the response saying that repo holds nothing -- the whole miss signal.
  //
  // This repo whenever it was searched, and any repo the caller named: asking about `b` by name
  // and getting `{}` back cannot be told apart from asking and getting no response at all. NOT
  // every linked peer on the default path -- that would key every query by every repo in the
  // workspace and drown the signal in repos nobody asked about. A name that matches no repo is
  // reported in `skipped` instead; it was never searched, and an empty group would claim it was.
  const emptied: FederatedGroup[] = [];
  const ensureKey = (repo: string) => {
    if (byRepo.has(repo)) return;
    const group: FederatedGroup = { repo, items: [] };
    byRepo.set(repo, group);
    emptied.push(group);
  };
  if (localSearched) ensureKey(input.workspace.repo);
  for (const name of named ?? []) {
    if (name !== input.workspace.repo && input.workspace.peers.some(peer => peer.name === name)) {
      ensureKey(name);
    }
  }

  // Empty groups first, this repo's ahead of any other -- `ensureKey` adds it first. They rank
  // nowhere, so the position costs nothing, and a reader asking "did MY repo answer" finds the
  // answer without scanning.
  const groups = [...emptied, ...withRows];

  // An explicit scope FIXES the shape; only the default path derives it from what was found.
  //
  // A caller who named repos, or asked for the workspace, requested a repo-partitioned view and
  // gets one whether or not the partition turned out interesting -- `{ "a": [...] }` rather than
  // a bare array. A shape that changed under them based on results would be worse than a one-key
  // object, because a caller cannot write a parser against it.
  const explicit = named || input.scope;
  const shape: FederatedResult['shape'] = explicit
    ? (input.scope === 'local' && !named ? 'flat' : 'grouped')
    // A flat array reads as "this repo's answer". Any remote row makes that false however few
    // groups there are, so the replica forces the grouped shape on its own.
    : (groups.length > 1 || remoteRepos.size > 0 ? 'grouped' : 'flat');

  return { groups, unshown, shape, skipped };
}
