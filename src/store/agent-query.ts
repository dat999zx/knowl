import { ExplainedKnowledgeItem, KnowledgeCategory, KnowledgeItem, KnowledgeStatus } from '../core/types.js';
import { queryKnowledgeCandidates } from './queries.js';
import { findEmbeddedItemIds, searchKnowledgeEmbeddings } from './vector.js';
import { recordKnowledgeAccessBestEffort } from './access-feedback.js';
import { localStore, type StoreHandle } from './store-handle.js';

const DEFAULT_AGENT_QUERY_LIMIT = 3;
/** Exported so cross-store fusion uses the same constant rather than restating it. */
export const RRF_K = 60;

/**
 * How much of the fused relevance the semantic half is worth. The lexical half gets `1 - a`.
 *
 * Convex combination rather than reciprocal-rank fusion, and multiplicative priors rather than
 * additive boosts, because **additive boosts on a fused rank score are structurally broken
 * rather than mistuned**. RRF deliberately destroys magnitude -- Cormack's paper says so
 * approvingly, "without regard to the arbitrary scores" -- so an additive constant has nothing
 * to be a proportion *of*, and the same constant that breaks a tie on one query dominates the
 * ranking on another. Measured here before the change: at a fixed cosine of 0.50 the standing
 * terms alone moved a result 0.204, which is 96% of the entire 0.401-0.614 range this file's
 * own comment documents as the span of a legitimate query.
 *
 * The field moved this way after RRF: Bruch et al. (TOIS 2023) find convex combination beats
 * RRF in and out of domain and that RRF "is sensitive to its parameters"; Weaviate changed its
 * hybrid default away from RRF in 1.24; OpenSearch publishes RRF at 3.86% lower NDCG@10 than
 * score-based fusion.
 *
 * **0.8 is swept, not assumed.** The research pass proposed "0.7, and it must be swept",
 * flagging that the number had no source. Swept over 2,149 cases -- both shipped suites,
 * arctic-embed-m-v2 q8, one embedding per query, alpha the only variable:
 *
 * | alpha | 1,649-case MRR | R@3 | 500-case MRR | R@3 |
 * | --- | --- | --- | --- | --- |
 * | lexical only | 0.95257 | 0.9697 | 0.91508 | 0.9400 |
 * | 0.5 | 0.97177 | 0.9891 | 0.95337 | 0.9800 |
 * | 0.6 | 0.97391 | 0.9891 | 0.95823 | 0.9840 |
 * | 0.7 | **0.97533** | 0.9891 | 0.96257 | 0.9840 |
 * | 0.8 | 0.97489 | **0.9897** | 0.96383 | 0.9860 |
 * | 0.85 | 0.97374 | 0.9897 | -- | -- |
 * | 0.9 | 0.97022 | 0.9891 | **0.96650** | **0.9900** |
 * | 1.0 (semantic only) | 0.95039 | 0.9788 | 0.96330 | 0.9860 |
 *
 * Three things the sweep settles. **The lexical half earns its weight**: alpha 1.0 is worse
 * than every mixed value on the larger suite, so this is a fusion and not a semantic ranker
 * with a decoration. **The optimum is interior and flat**: 0.7 wins MRR on the larger suite by
 * 0.0004 over 0.8 -- well under one case -- while 0.8 wins Recall@3 on both and 0.9 wins the
 * smaller suite outright. Nothing in 0.6-0.9 is distinguishable from the noise. **0.8 is the
 * most robust of them**: best or second on every metric of both suites, where 0.7 is fourth on
 * the smaller one and 0.9 falls off on the larger.
 *
 * Being in a flat region, the tie is broken by an invariant the suite cannot express and
 * tests/store/rank-knowledge.test.ts does: lexical agreement is a tie-breaker, not a veto, so
 * an item at the noise floor must not beat a decisively better cosine on being the only
 * lexical hit. That holds from 0.8 up and fails at 0.7.
 *
 * The relevance floor is unaffected by any of this -- it judges the raw cosine -- and the sweep
 * confirms it: six off-topic queries were answered 0/6 at alpha 0, 0.7 and 1.0 alike.
 */
export const FUSION_ALPHA = 0.8;

/**
 * MMR's relevance weight, on the lexical path.
 *
 * Was 0.2, which weights novelty four times relevance and is off the map Carbonell and
 * Goldstein drew: their lambda multiplies *relevance*, and they suggest 0.3 for exploring an
 * unfamiliar space and 0.7 once focused. LangChain defaults to 0.5. At 0.2 a 30% token overlap
 * cost more than the whole relevance term could award, and a legitimate second answer was
 * reproducibly dropped for an unrelated note.
 *
 * 0.5 rather than 0.7: our consumer is not exploring, which argues for the focused end, but
 * the suite deliberately asserts that two byte-identical atoms do not both occupy a two-result
 * page. 0.7 stops de-duplicating those and 0.5 still does, while comfortably clearing the
 * legitimate-second-answer case. It is the value that satisfies both, and it is a published
 * default rather than a number invented here.
 *
 * Diversity is no longer folded into the reported score. MMR is a property of the result set,
 * not of an item, and mixing it in is why scores went negative and non-monotonic.
 */
const MMR_LAMBDA = 0.5;

/**
 * Priors: bounded multipliers applied after the floor, never additive terms.
 *
 * The invariant is one sentence -- **a prior may change where an item sits, never whether it
 * is returned** -- and it is structural rather than a matter of sizing: the floor judges the
 * raw cosine before any of this runs. Each factor is at most 1, so a prior only ever discounts
 * and the fused relevance is also the ceiling.
 *
 * Two kinds, sized against each other rather than each on its own:
 *
 * - **Standing** -- what we know about the item regardless of the question. Freshness is the
 *   largest at 12 points, which is what the previous comment here said it intended and what
 *   additive sizing could not actually deliver. The five together bottom out at 0.83.
 * - **Query fit** -- what the caller told us about the answer they expect. An explicit category
 *   hint is evidence about the *question*, not about the item, so it is sized above every
 *   standing prior: 10 points, just above stale. It is still a hint and not a filter -- it
 *   flips near-ties and does not overturn a lexical gap of a quarter, which is the line the
 *   old additive constant could not draw, being 91% of the entire lexical score range.
 */
const FRESHNESS_PRIOR: Record<string, number> = { fresh: 1, needs_review: 0.94 };
const FRESHNESS_PRIOR_STALE = 0.88;
const CONFIDENCE_PRIOR_FLOOR = 0.98;
const RECENCY_PRIOR_FLOOR = 0.99;
const TIER_UNVERIFIED_PRIOR = 0.99;
const PROVENANCE_INFERRED_PRIOR = 0.98;
const CATEGORY_MISS_PRIOR = 0.90;
const IDENTIFIER_MISS_PRIOR = 0.98;

/**
 * Below this **raw cosine**, a vector-backed result is noise rather than a weak answer.
 *
 * Measured 2026-08-01 over 20 queries against a 424-item store: on-topic and near-miss
 * queries score 0.401-0.614, off-topic queries 0.170-0.223, and nothing falls between.
 * 0.30 leaves roughly 0.08 above the worst junk and 0.10 below the weakest legitimate
 * query -- the larger margin deliberately protects real answers, because silencing one is
 * worse than admitting a weak one.
 *
 * It is judged on the cosine itself, before fusion and before any prior. That is the rule
 * Azure ships verbatim -- "filtering occurs before fusing results from different recall sets"
 * -- and it is what makes the 0.30 above still mean what it was measured to mean, since the
 * measurement was taken on raw cosines. It judged the *post-penalty* score until now, which
 * put freshness and provenance in charge of whether the store answers at all: a 36% spread in
 * required cosine, and at 0.34 a fresh item was returned while an identical stale one yielded
 * empty. A stale note can be the only true answer in the store; its age is a reason to rank it
 * lower, never a reason to claim the store knows nothing.
 */
export const MIN_VECTOR_RELEVANCE = 0.30;

function queryTokens(query?: string): string[] {
  return [...new Set((query ?? '').toLowerCase().split(/[^a-z0-9]+/).filter(token => token.length > 1))];
}

function itemTokens(item: KnowledgeItem): Set<string> {
  return new Set(queryTokens([item.title, item.content, ...(item.tags ?? [])].join(' ')));
}

function tokenOverlap(left: Set<string>, right: Set<string>): number {
  const union = new Set([...left, ...right]);
  if (union.size === 0) return 0;
  return [...left].filter(token => right.has(token)).length / union.size;
}

/** Whether the query looks like an identifier at all. Only then does the prior discriminate. */
function identifierQuery(query?: string): string | null {
  const identifier = query?.trim().toLowerCase();
  if (!identifier || identifier.length < 3 || !/[./#:_-]/.test(identifier)) return null;
  return identifier;
}

function containsIdentifier(item: KnowledgeItem, identifier: string): boolean {
  return [item.title, item.content, ...(item.tags ?? [])].join(' ').toLowerCase().includes(identifier);
}

function normalizedRecencyScore(item: KnowledgeItem, timestamps: number[]): number {
  const timestamp = new Date(item.updatedAt).getTime();
  const validTimestamps = timestamps.filter(value => Number.isFinite(value));
  if (!Number.isFinite(timestamp) || validTimestamps.length === 0) {
    return 0;
  }

  const oldest = Math.min(...validTimestamps);
  const newest = Math.max(...validTimestamps);
  if (newest === oldest) {
    return 0;
  }

  return (timestamp - oldest) / (newest - oldest);
}

export type RankOptions = {
  category?: KnowledgeCategory;
  status?: KnowledgeStatus;
  tags?: string[];
  query?: string;
  surface?: string;
  limit?: number;
  visibility?: 'repo' | 'workspace';
  vector?: {
    enabled?: boolean;
    /**
     * The profile the query embedding was produced under. Rows written under any other
     * one are excluded, because a different model, dtype or pooling puts them in a
     * different space -- see fingerprintProfile.
     *
     * Required whenever `vector` is supplied at all: an absent fingerprint used to drop the
     * predicate and score every stored vector, whatever produced it.
     */
    profileFingerprint: string;
    embedding?: number[];
  };
};

export type Candidate = {
  item: KnowledgeItem;
  /** This repo's own lexical rank. Corpus-relative -- see the note in scoreCandidates. */
  bm25Rank?: number;
  /**
   * This repo's own lexical *score*, higher is better: `-bm25()` from FTS5, or the
   * substring fallback's saturation score. Corpus-relative in the strongest sense -- the same
   * quality of match spans six orders of magnitude depending only on how common the query
   * term is in that corpus -- so it is normalised against its own repo's candidates and never
   * compared raw across repos. Absent when the caller assembled candidates without one, in
   * which case the rank stands in for it.
   */
  lexicalScore?: number;
  /**
   * The share of the query's distinct terms this item contains, in [0,1].
   *
   * Corpus-independent by construction, which is what makes two repos' lexical evidence
   * comparable at all -- `lexicalScore` is not. Absent means "not established", scored as 1
   * so a caller that never computed it is not silently penalised.
   */
  lexicalCoverage?: number;
  vectorRank?: number;
  vectorScore?: number;
  /**
   * Whether vector search could have returned this item -- it has an embedding under the
   * provider and model being searched. Distinct from `vectorScore !== undefined`, which says
   * vector actually did return it. Undefined means the caller did not establish eligibility,
   * and the relevance floor then leaves the candidate alone rather than guessing.
   */
  embedded?: boolean;
};

export type ScoredCandidate = {
  item: KnowledgeItem;
  repo?: string;
  score: number;
  explanation: ExplainedKnowledgeItem['explanation'];
};

/**
 * Whether the relevance floor may judge this candidate.
 *
 * Only an item vector search could have returned. Three cases arrive looking alike, and the
 * fused score cannot separate them -- an off-topic lexical hit and a legitimate one both land
 * around 0.034, measured against the live store:
 *
 * - **Embedded, vector returned it.** Its cosine is the score being floored. Judge it.
 * - **Embedded, vector did not return it.** Vector ranked it outside the top N, so it is
 *   semantically distant and its BM25 rank carries no absolute relevance. Judge it -- this is
 *   the junk the floor exists to remove.
 * - **Not embedded.** Written since the last index, or written while the embedding model was
 *   not cached. Vector never had a chance, so a low score means invisible, not distant. Exempt.
 *
 * The last case also covers the outage where nothing at all is embedded: every candidate is
 * exempt and the floor turns itself off, rather than emptying every result on a store that has
 * vector enabled but has never been reindexed.
 *
 * The exemption is scoped to the store that reached the verdict -- see `scoreCandidates`.
 */
function floorApplies(candidate: Pick<Candidate, 'embedded'>): boolean {
  return candidate.embedded === true;
}

/** Which corpus a candidate's lexical score belongs to. Local candidates carry no repo. */
function corpusOf(candidate: { repo?: string }): string {
  return candidate.repo ?? '';
}

/**
 * The lexical evidence for a candidate, higher is better, on whatever scale its corpus uses.
 *
 * A rank stands in when no score arrived: a caller that assembled candidates itself has only
 * the ordering, and `1 / (RRF_K + rank)` is that ordering expressed as a number. Undefined
 * means the lexical engine said nothing about this item at all, which is different from
 * saying it is a poor match.
 */
function rawLexical(candidate: Candidate): number | undefined {
  if (candidate.lexicalScore !== undefined) return candidate.lexicalScore;
  return candidate.bm25Rank ? 1 / (RRF_K + candidate.bm25Rank) : undefined;
}

export async function queryKnowledgeForAgent(
  projectId: string,
  options: RankOptions,
): Promise<KnowledgeItem[]> {
  return (await queryKnowledgeForAgentExplained(projectId, options)).map(({ explanation, ...item }) => item);
}

/**
 * The database half. One store, one read.
 *
 * Separate from scoring because scoring must be able to run over several repos' candidates at
 * once: recency is normalized against the set it is given, so scoring each repo alone and then
 * comparing the results makes every repo's newest item equally recent.
 */
export async function selectCandidates(
  projectId: string,
  options: RankOptions,
  store: StoreHandle = localStore(),
): Promise<Candidate[]> {
  const limit = options.limit ?? DEFAULT_AGENT_QUERY_LIMIT;
  const { vector, ...textOptions } = options;
  const candidateLimit = Math.max(limit * 3, 10);
  const bm25Results = await queryKnowledgeCandidates(projectId, {
    ...textOptions,
    category: undefined,
    limit: candidateLimit,
  }, store);

  const byId = new Map<string, Candidate>();
  bm25Results.forEach((hit, index) => {
    byId.set(hit.item.id, {
      item: hit.item,
      bm25Rank: index + 1,
      // Only when there was a query. Browsing has no lexical evidence, only an order.
      lexicalScore: options.query ? hit.lexicalScore : undefined,
      lexicalCoverage: options.query ? hit.coverage : undefined,
    });
  });

  if (vector?.enabled && vector.embedding) {
    const vectorResults = await searchKnowledgeEmbeddings(projectId, {
      vector: vector.embedding,
      category: undefined,
      status: options.status,
      tags: options.tags,
      visibility: options.visibility,
      profileFingerprint: vector.profileFingerprint,
      limit: candidateLimit,
    }, store);

    vectorResults.forEach((result, index) => {
      const existing = byId.get(result.item.id);
      byId.set(result.item.id, {
        item: result.item,
        bm25Rank: existing?.bm25Rank,
        lexicalScore: existing?.lexicalScore,
        lexicalCoverage: existing?.lexicalCoverage,
        vectorRank: index + 1,
        vectorScore: result.score,
        // Vector returned it, so it is embedded by definition -- no lookup needed.
        embedded: true,
      });
    });

    // Everything else is a lexical-only hit, and the floor needs to know whether vector
    // *could* have returned it. Asked only about candidates vector did not return, and only
    // when vector actually ran, so the common path costs one extra query over at most a few
    // dozen ids rather than a join on every search.
    const unknown = [...byId.values()].filter(candidate => candidate.embedded === undefined);
    if (unknown.length > 0) {
      const embedded = await findEmbeddedItemIds(
        unknown.map(candidate => candidate.item.id),
        { profileFingerprint: vector.profileFingerprint },
        store,
      );
      for (const candidate of unknown) {
        candidate.embedded = embedded.has(candidate.item.id);
      }
    }
  }

  return [...byId.values()];
}

/**
 * The scoring half. Pure, synchronous, no database, no notion of repos.
 *
 * `repo` rides through untouched so a cross-repo caller can attribute results without scoring
 * knowing anything about workspaces.
 *
 * Recency is normalized over whatever set is passed in, which is why a cross-repo caller passes
 * every repo's candidates at once rather than scoring each repo and fusing the results.
 *
 * The shape, in order:
 *
 *   relevance = alpha * cosine + (1 - alpha) * lexical      both in [0,1], so relevance is too
 *   score     = relevance * prior                           prior in [~0.80, 1], never above 1
 *
 * and the floor judges `cosine` before any of it.
 */
export function scoreCandidates<T extends Candidate & { repo?: string }>(
  candidates: T[],
  options: {
    query?: string;
    category?: KnowledgeCategory;
    limit: number;
    usingVector: boolean;
    /** The sweep knob. Production callers omit it and get FUSION_ALPHA. */
    alpha?: number;
  },
): ScoredCandidate[] {
  const limit = options.limit;
  const usingVector = options.usingVector;
  const identifier = identifierQuery(options.query);
  const timestamps = candidates.map(result => new Date(result.item.updatedAt).getTime());

  // Position within its own corpus, times the share of the query it actually covers.
  //
  // Both halves are needed and neither works alone -- this was measured on the three-case
  // cross-repo suite, where the local answer to "web build output directory" must beat the
  // foreign "Server build output directory":
  //
  // - **Normalised over the union.** BM25's absolute scale is set by the corpus, not by the
  //   match. The server repo holds four rows to the web repo's three, so it gives `build`,
  //   `output` and `directory` an IDF of 0.847 against the web repo's 0.51 -- and the foreign
  //   distractor wins on nothing but being in a bigger repo. Worse, SQLite clamps IDF to 1e-6
  //   once a term appears in half a corpus, so `web` -- the one term that distinguishes the
  //   right answer -- contributes exactly nothing in a three-row repo.
  // - **Normalised per corpus.** Now every repo's best hit is 1.0, which is "rank 1 of its own
  //   corpus" again -- the thing the recorded 0.833 -> 1.0 baseline was raised by removing.
  //   The two build notes tie and recency, of all things, decides.
  //
  // Coverage is the only signal here that means the same thing in both repos: the fraction of
  // distinct query terms the item contains is a property of the item and the query alone. The
  // local answer covers 4 of 4 and the foreign one 3 of 4, and that is the actual difference
  // between them. It is Lucene's `coord` and it is not what K-28 deleted: bounded to [0,1],
  // over distinct terms rather than occurrences, and independent of document length.
  //
  // Divided by the best rather than min-maxed: min-max forces the worst candidate in the set
  // to exactly 0 however good it is, which is a fact about the candidate set rather than about
  // the document.
  const corpusBest = new Map<string, number>();
  for (const candidate of candidates) {
    const raw = rawLexical(candidate);
    if (raw === undefined) continue;
    const corpus = corpusOf(candidate);
    corpusBest.set(corpus, Math.max(corpusBest.get(corpus) ?? 0, raw));
  }
  const anyLexical = corpusBest.size > 0;
  // Alpha renormalises over the signals that exist, and does so globally rather than per
  // corpus: two repos scored under different alphas would not be comparable, which is the
  // whole reason scoring runs over the union.
  const alpha = !usingVector ? 0 : (anyLexical ? (options.alpha ?? FUSION_ALPHA) : 1);

  const scored = candidates
    .map(result => {
      const raw = rawLexical(result);
      const best = corpusBest.get(corpusOf(result)) ?? 0;
      // No lexical evidence and the worst lexical evidence both score 0. That is deliberate:
      // "did lexical return this at all" used to be a step worth 0.0333 while the whole
      // lexical ordering was worth 0.0158 -- the presence of a signal outweighing what the
      // signal said. The ordering now spans the entire lexical weight and presence adds
      // nothing on top of it.
      //
      // `best === 0` is the corpus whose lexical magnitude carries no information at all, and
      // it is a third case rather than the second. Position is unknowable there -- there is no
      // best to divide by -- but coverage is measured on the item and the query alone, so it
      // is as true in that corpus as in any other, and falling back to it is what keeps the
      // whole corpus from scoring a flat zero and being ordered by a tie-break. This is the
      // recorded cross-repo residual, and it needs nothing the peer discarded: SQLite clamps
      // IDF to 1e-6 once a term appears in half a corpus, so a three-row peer where every row
      // matches scores ~3.7e-6 -- six orders of magnitude below a large repo's, and still
      // positive, so `raw / best` already recovers it in full (tests/store/small-peer-lexical).
      // Exactly zero is unreachable from either engine today; it is closed as a cliff, not as
      // a live defect.
      const coverage = Math.min(Math.max(result.lexicalCoverage ?? 1, 0), 1);
      const lexical = raw === undefined ? 0 : (best > 0 ? Math.min(raw / best, 1) * coverage : coverage);
      const semantic = Math.min(Math.max(result.vectorScore ?? 0, 0), 1);
      const relevance = usingVector ? alpha * semantic + (1 - alpha) * lexical : lexical;

      const recency = normalizedRecencyScore(result.item, timestamps);
      // Clamped, not trusted. `confidence` is unvalidated at the write boundary and a model
      // emitting a percent scale would otherwise be a permanent multiplier on every query.
      const confidence = Math.min(Math.max(result.item.confidence ?? 1, 0), 1);
      const freshness = result.item.freshness === 'stale'
        ? FRESHNESS_PRIOR_STALE
        : (FRESHNESS_PRIOR[result.item.freshness as string] ?? 1);
      const category = !options.category || result.item.category === options.category ? 1 : CATEGORY_MISS_PRIOR;
      const exactIdentifier = !identifier || containsIdentifier(result.item, identifier) ? 1 : IDENTIFIER_MISS_PRIOR;
      const standing = (result.item.tier === 'verified' ? 1 : TIER_UNVERIFIED_PRIOR)
        * (result.item.provenance === 'inferred' ? PROVENANCE_INFERRED_PRIOR : 1);

      const prior = freshness
        * (CONFIDENCE_PRIOR_FLOOR + (1 - CONFIDENCE_PRIOR_FLOOR) * confidence)
        * (RECENCY_PRIOR_FLOOR + (1 - RECENCY_PRIOR_FLOOR) * recency)
        * category * exactIdentifier * standing;

      const contributions = {
        semantic, lexical, relevance, prior,
        category, recency, confidence, freshness, exactIdentifier, standing,
      };
      return { result, score: relevance * prior, semantic, contributions };
    })
    .sort((left, right) => right.score - left.score);

  let selected: Array<typeof scored[number] & { diversity: number }>;
  if (usingVector) {
    // The floor decides whether the query is answerable at all, then leaves the ranking alone.
    //
    // It is deliberately not a per-candidate filter. The threshold was measured as the *top*
    // score per query -- on-topic 0.401-0.614 against off-topic 0.170-0.223 -- and that is the
    // only claim the measurement supports. Applied per candidate it also cuts the 3rd and 5th
    // results of perfectly good queries, which is not junk but the tail of a real answer:
    // against the 500-case suite it dropped `span export backend` -> obs-otel (0.269),
    // `which test runner` -> test-vitest (0.233) and `jwt ttl configured value` (0.262), all
    // three on queries whose top result scored 0.37-0.39. Recall@10 fell 0.994 -> 0.987.
    //
    // What changed is *what* it judges: the raw cosine, not the fused-and-dressed score. A
    // prior can no longer decide whether the store answers, only where the answer sits.
    const judged = scored.filter(candidate => floorApplies(candidate.result));
    const bestCosine = judged.reduce((best, candidate) => Math.max(best, candidate.semantic), 0);
    const answerable = judged.length === 0 || bestCosine >= MIN_VECTOR_RELEVANCE;
    // When unanswerable, candidates the floor could not judge still stand -- but only from a
    // store that took part in the verdict. On a partly indexed store a just-written item is
    // invisible to vector and must not be suppressed by a verdict reached without it. A store
    // with no embeddings at all took part in nothing, and letting its rows through here is how
    // an off-topic peer item became the only answer to a question the indexed store had just
    // said it could not answer.
    const corporaThatJudged = new Set(judged.map(candidate => corpusOf(candidate.result)));
    const floored = answerable
      ? scored
      : scored.filter(candidate => !floorApplies(candidate.result)
        && corporaThatJudged.has(corpusOf(candidate.result)));
    selected = floored.slice(0, limit).map(candidate => ({ ...candidate, diversity: 0 }));
  } else {
    // Maximal Marginal Relevance, on the path that has no semantic ranking to trust. The
    // vector path deliberately has none: de-duplication scrambles legitimately
    // distinct-but-similar atoms and was measured to hurt recall there.
    selected = [];
    const candidateTokens = new Map(scored.map(candidate => [candidate.result.item.id, itemTokens(candidate.result.item)]));
    while (selected.length < limit && selected.length < scored.length) {
      const next = scored
        .filter(candidate => !selected.some(chosen => chosen.result.item.id === candidate.result.item.id))
        .map(candidate => {
          const overlap = selected.length === 0 ? 0 : Math.max(...selected.map(chosen => tokenOverlap(
            candidateTokens.get(candidate.result.item.id)!, candidateTokens.get(chosen.result.item.id)!,
          )));
          return {
            ...candidate,
            diversity: overlap,
            // Carbonell and Goldstein's form: lambda multiplies relevance. `score` is already
            // in [0,1], so no per-query rescaling is needed to make the two terms commensurate
            // -- the previous `score / highestScore` was standing in for exactly that.
            mmr: MMR_LAMBDA * candidate.score - (1 - MMR_LAMBDA) * overlap,
          };
        })
        .sort((left, right) => right.mmr - left.mmr)[0];
      if (!next) break;
      selected.push(next);
    }
  }

  return selected.map(({ result, score, contributions, diversity }) => ({
    item: result.item,
    repo: result.repo,
    // Diversity is NOT in here. It is a property of the result set rather than of the item,
    // and folding it in is what drove reported scores negative and non-monotonic.
    score,
    explanation: {
      finalScore: score,
      bm25Rank: result.bm25Rank,
      vectorRank: result.vectorRank,
      contributions: { ...contributions, diversity },
      reason: `relevance=${contributions.relevance.toFixed(3)} `
        + `(semantic=${contributions.semantic.toFixed(3)}, lexical=${contributions.lexical.toFixed(3)}, `
        + `alpha=${alpha.toFixed(2)}), prior=${contributions.prior.toFixed(3)}, `
        + `diversity=${diversity.toFixed(3)}`,
    },
  }));
}

/**
 * Score and order candidates from one store. Reads only.
 *
 * Split from `queryKnowledgeForAgentExplained` so it can run against any database. Recording
 * that an item was used cannot: a peer handle is read-only, and `knowledge_access` has a
 * foreign key to `knowledge_items`, so a peer's item cannot be recorded in the local database
 * either. Peer access telemetry is therefore not merely unimplemented -- it has nowhere
 * correct to go, and the reads belong to the querying repo regardless.
 */
export async function rankKnowledge(
  projectId: string,
  options: RankOptions,
  store: StoreHandle = localStore(),
): Promise<ExplainedKnowledgeItem[]> {
  const candidates = await selectCandidates(projectId, options, store);
  return scoreCandidates(candidates, {
    query: options.query,
    category: options.category,
    limit: options.limit ?? DEFAULT_AGENT_QUERY_LIMIT,
    usingVector: Boolean(options.vector?.enabled && options.vector.embedding),
  }).map(({ item, explanation }) => ({ ...item, explanation }));
}

export async function queryKnowledgeForAgentExplained(
  projectId: string,
  options: RankOptions,
): Promise<ExplainedKnowledgeItem[]> {
  const items = await rankKnowledge(projectId, options);
  await Promise.all(items.map((item, index) => recordKnowledgeAccessBestEffort({
    itemId: item.id,
    query: options.query,
    surface: options.surface ?? 'agent_query',
    rank: index + 1,
  })));
  return items;
}
