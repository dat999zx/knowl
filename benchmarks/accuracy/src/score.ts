import type { ModeCapabilities, RetrievalHit, RetrievalPrediction } from './protocol.js';
import type { NormalizedRecord, PublicQuery, QuestionGold } from './schema.js';

export type MetricValue = {
  value: number | null;
  numerator: number;
  denominator: number;
};

export type RetrievalMetrics = {
  applicableCoverage: MetricValue;
  temporalCoverage: MetricValue;
  abstentionCoverage: MetricValue;
  provenanceCoverage: MetricValue;
  strictAccuracyAtK: MetricValue;
  temporalAccuracy: MetricValue;
  currentStateAccuracy: MetricValue;
  historicalAsOfAccuracy: MetricValue;
  timelineOrderAccuracy: MetricValue;
  contradictionResolutionAccuracy: MetricValue;
  failureScenarioAccuracy: MetricValue;
  failedApproachRetrievalRecall: MetricValue;
  recallAt1: MetricValue;
  recallAt3: MetricValue;
  recallAt5: MetricValue;
  recallAt10: MetricValue;
  mrr: MetricValue;
  ndcgAt5: MetricValue;
  ndcgAt10: MetricValue;
  staleResultRate: MetricValue;
  forbiddenResultRate: MetricValue;
  duplicateResultRate: MetricValue;
  abstentionAccuracy: MetricValue;
};

export type RetrievalFailure = {
  questionId: string;
  reason: string;
};

export type RetrievalQueryScore = {
  questionId: string;
  category: string;
  strictCorrect: boolean | null;
  relevantRetrieved: Record<'1' | '3' | '5' | '10', number>;
  relevantTotal: number;
  reciprocalRank: number;
  ndcgAt5: number;
  ndcgAt10: number;
  forbiddenHits: number;
  staleHits: number;
  retrievedHits: number;
  attributedHits: number;
  duplicateHits: number;
  failedApproachRetrieved: number;
  failedApproachTotal: number;
  abstentionCorrect: boolean | null;
  notApplicableReason?: string;
};

export type RetrievalScore = {
  metrics: RetrievalMetrics;
  perQuery: RetrievalQueryScore[];
  failures: RetrievalFailure[];
  naReason?: string;
};

type HitInfo = {
  hit: RetrievalHit;
  sources: string[];
  grade: number;
  forbidden: boolean;
  stale: boolean;
  duplicate: boolean;
};

function metric(numerator: number, denominator: number): MetricValue {
  return { value: denominator ? numerator / denominator : null, numerator, denominator };
}

function ndcg(hitGrades: number[], idealGrades: number[], k: number): number {
  const gain = (grade: number, index: number) => grade > 0
    ? ((2 ** grade) - 1) / Math.log2(index + 2)
    : 0;
  const actual = hitGrades.slice(0, k).reduce((sum, grade, index) => sum + gain(grade, index), 0);
  const ideal = [...idealGrades]
    .sort((left, right) => right - left)
    .slice(0, k)
    .reduce((sum, grade, index) => sum + gain(grade, index), 0);
  return ideal ? actual / ideal : 0;
}

function blankMetrics(): RetrievalMetrics {
  const na = (): MetricValue => ({ value: null, numerator: 0, denominator: 0 });
  return {
    applicableCoverage: na(), temporalCoverage: na(), abstentionCoverage: na(), provenanceCoverage: na(),
    strictAccuracyAtK: na(), temporalAccuracy: na(), currentStateAccuracy: na(), historicalAsOfAccuracy: na(),
    timelineOrderAccuracy: na(), contradictionResolutionAccuracy: na(), failureScenarioAccuracy: na(),
    failedApproachRetrievalRecall: na(), recallAt1: na(), recallAt3: na(), recallAt5: na(), recallAt10: na(),
    mrr: na(), ndcgAt5: na(), ndcgAt10: na(), staleResultRate: na(), forbiddenResultRate: na(),
    duplicateResultRate: na(), abstentionAccuracy: na(),
  };
}

function notApplicableRow(query: PublicQuery, gold: QuestionGold, reason: string): RetrievalQueryScore {
  return {
    questionId: query.questionId,
    category: gold.category,
    strictCorrect: null,
    relevantRetrieved: { '1': 0, '3': 0, '5': 0, '10': 0 },
    relevantTotal: 0,
    reciprocalRank: 0,
    ndcgAt5: 0,
    ndcgAt10: 0,
    forbiddenHits: 0,
    staleHits: 0,
    retrievedHits: 0,
    attributedHits: 0,
    duplicateHits: 0,
    failedApproachRetrieved: 0,
    failedApproachTotal: 0,
    abstentionCorrect: null,
    notApplicableReason: reason,
  };
}

function inspectHits(input: {
  hits: RetrievalHit[];
  query: PublicQuery;
  gold: QuestionGold;
  recordProjects: Map<string, string>;
}): HitInfo[] {
  const relevance = new Map(input.gold.judgments.map(judgment => [judgment.sourceId, judgment.grade]));
  const harmful = new Set(input.gold.harmful.map(item => item.sourceId));
  const stale = new Set(input.gold.harmful
    .filter(item => ['superseded', 'future', 'contradicted', 'refuted_temporary'].includes(item.reason))
    .map(item => item.sourceId));
  const seenMemoryIds = new Set<string>();
  const seenSources = new Set<string>();

  return input.hits.map(hit => {
    const sources = [...new Set(hit.sourceIds ?? [])];
    const newSources = sources.filter(sourceId => !seenSources.has(sourceId));
    const hasInvalidSource = sources.length === 0 || sources.some(sourceId => {
      const projectId = input.recordProjects.get(sourceId);
      return projectId === undefined || projectId !== input.query.projectId;
    });
    const duplicate = seenMemoryIds.has(hit.memoryId) || sources.some(sourceId => seenSources.has(sourceId));
    seenMemoryIds.add(hit.memoryId);
    for (const sourceId of sources) seenSources.add(sourceId);
    return {
      hit,
      sources,
      grade: Math.max(0, ...newSources.map(sourceId => relevance.get(sourceId) ?? 0)),
      forbidden: hasInvalidSource || sources.some(sourceId => harmful.has(sourceId)),
      stale: sources.some(sourceId => stale.has(sourceId)),
      duplicate,
    };
  });
}

export function scoreRetrieval(
  records: NormalizedRecord[],
  queries: PublicQuery[],
  goldRows: QuestionGold[],
  predictions: RetrievalPrediction[],
  capabilities: ModeCapabilities,
  topK: number,
): RetrievalScore {
  if (!capabilities.supported) {
    return { metrics: blankMetrics(), perQuery: [], failures: [], naReason: capabilities.reason ?? 'adapter mode is unsupported' };
  }
  const recordProjects = new Map(records.map(record => [record.sourceId, record.projectId]));
  const gold = new Map(goldRows.map(row => [row.questionId, row]));
  const predictionMap = new Map<string, RetrievalPrediction>();
  for (const prediction of predictions) {
    if (predictionMap.has(prediction.questionId)) throw new Error(`Duplicate prediction for ${prediction.questionId}.`);
    predictionMap.set(prediction.questionId, prediction);
  }
  const queryIds = new Set(queries.map(query => query.questionId));
  for (const prediction of predictions) {
    if (!queryIds.has(prediction.questionId)) throw new Error(`Prediction references unknown question ${prediction.questionId}.`);
  }

  const perQuery: RetrievalQueryScore[] = [];
  const failures: RetrievalFailure[] = [];

  for (const query of queries) {
    const queryGold = gold.get(query.questionId);
    if (!queryGold) throw new Error(`Missing evaluator gold for ${query.questionId}.`);
    const prediction = predictionMap.get(query.questionId);
    const capabilityReason = queryGold.shouldAbstain && !capabilities.retrievalAbstention
      ? 'adapter does not support retrieval abstention'
      : !queryGold.shouldAbstain && !capabilities.sourceProvenance
        ? 'adapter does not expose source provenance'
        : undefined;
    const notApplicableReason = prediction?.notApplicableReason ?? capabilityReason;
    if (notApplicableReason) {
      perQuery.push(notApplicableRow(query, queryGold, notApplicableReason));
      continue;
    }

    const response = prediction?.response;
    const hits = response?.hits.slice(0, topK) ?? [];
    const inspected = inspectHits({ hits, query, gold: queryGold, recordProjects });
    const relevant = new Set(queryGold.judgments
      .filter(judgment => judgment.grade >= 2)
      .map(judgment => judgment.sourceId));
    const uniqueSourcesAt = (k: number) => new Set(inspected.slice(0, k).flatMap(info => info.sources));
    const relevantRetrieved = (k: number) => [...uniqueSourcesAt(k)].filter(sourceId => relevant.has(sourceId)).length;
    const firstRelevant = inspected.findIndex(info => info.sources.some(sourceId => relevant.has(sourceId)));
    const allSources = new Set(inspected.flatMap(info => info.sources));
    const failedApproachSources = queryGold.failure?.shouldWarn
      ? queryGold.failure.failedApproachSourceIds
      : [];
    const failedApproachRetrieved = failedApproachSources
      .filter(sourceId => allSources.has(sourceId)).length;
    const requiredGroupsSatisfied = queryGold.requiredEvidenceGroups
      .every(group => group.some(sourceId => allSources.has(sourceId)));
    const forbiddenHits = inspected.filter(info => info.forbidden).length;
    const staleHits = inspected.filter(info => info.stale).length;
    const duplicateHits = inspected.filter(info => info.duplicate).length;
    const attributedHits = inspected.filter(info => info.sources.length > 0).length;
    const hasResponse = Boolean(response);
    const adapterError = prediction?.error ?? (!hasResponse ? 'missing prediction' : undefined);
    const abstentionCorrect = queryGold.shouldAbstain
      ? hasResponse && response!.decision === 'abstain' && response!.hits.length === 0
      : null;
    const strictCorrect = queryGold.shouldAbstain
      ? abstentionCorrect
      : hasResponse && response!.decision === 'results' && requiredGroupsSatisfied && forbiddenHits === 0;

    if (adapterError) {
      failures.push({ questionId: query.questionId, reason: adapterError });
    } else if (!strictCorrect) {
      const reason = queryGold.shouldAbstain
        ? 'incorrect abstention'
        : forbiddenHits > 0
          ? 'forbidden, cross-project, unknown, or unattributed result returned'
          : 'missing required evidence';
      failures.push({ questionId: query.questionId, reason });
    }

    const idealGrades = queryGold.judgments.map(judgment => judgment.grade);
    perQuery.push({
      questionId: query.questionId,
      category: queryGold.category,
      strictCorrect,
      relevantRetrieved: {
        '1': relevantRetrieved(1),
        '3': relevantRetrieved(3),
        '5': relevantRetrieved(5),
        '10': relevantRetrieved(10),
      },
      relevantTotal: relevant.size,
      reciprocalRank: queryGold.shouldAbstain || firstRelevant < 0 ? 0 : 1 / (firstRelevant + 1),
      ndcgAt5: queryGold.shouldAbstain ? 0 : ndcg(inspected.map(info => info.grade), idealGrades, 5),
      ndcgAt10: queryGold.shouldAbstain ? 0 : ndcg(inspected.map(info => info.grade), idealGrades, 10),
      forbiddenHits,
      staleHits,
      retrievedHits: inspected.length,
      attributedHits,
      duplicateHits,
      failedApproachRetrieved,
      failedApproachTotal: failedApproachSources.length,
      abstentionCorrect,
    });
  }

  const applicable = perQuery.filter(row => row.strictCorrect !== null);
  const answerable = applicable.filter(row => !gold.get(row.questionId)!.shouldAbstain);
  const abstentions = applicable.filter(row => gold.get(row.questionId)!.shouldAbstain);
  const temporalRows = perQuery.filter(row => gold.get(row.questionId)!.temporalKind !== undefined);
  const allAbstentions = perQuery.filter(row => gold.get(row.questionId)!.shouldAbstain);
  const applicableFor = (predicate: (row: QuestionGold) => boolean) => applicable
    .filter(row => predicate(gold.get(row.questionId)!));
  const accuracy = (rows: RetrievalQueryScore[]) => metric(rows.filter(row => row.strictCorrect).length, rows.length);
  const currentRows = applicableFor(row => row.temporalKind === 'current');
  const asOfRows = applicableFor(row => row.temporalKind === 'as_of');
  const timelineRows = applicableFor(row => row.temporalKind === 'change_point' || row.temporalKind === 'timeline');
  const contradictionRows = applicableFor(row => row.temporalKind === 'contradiction');
  const failureRows = applicableFor(row => row.failure !== undefined);
  const totalRelevant = answerable.reduce((sum, row) => sum + row.relevantTotal, 0);
  const retrievedHits = applicable.reduce((sum, row) => sum + row.retrievedHits, 0);
  const metrics: RetrievalMetrics = {
    applicableCoverage: metric(applicable.length, queries.length),
    temporalCoverage: metric(temporalRows.filter(row => row.strictCorrect !== null).length, temporalRows.length),
    abstentionCoverage: metric(abstentions.length, allAbstentions.length),
    provenanceCoverage: metric(applicable.reduce((sum, row) => sum + row.attributedHits, 0), retrievedHits),
    strictAccuracyAtK: metric(applicable.filter(row => row.strictCorrect).length, applicable.length),
    temporalAccuracy: accuracy(temporalRows.filter(row => row.strictCorrect !== null)),
    currentStateAccuracy: accuracy(currentRows),
    historicalAsOfAccuracy: accuracy(asOfRows),
    timelineOrderAccuracy: accuracy(timelineRows),
    contradictionResolutionAccuracy: accuracy(contradictionRows),
    failureScenarioAccuracy: accuracy(failureRows),
    failedApproachRetrievalRecall: metric(
      failureRows.reduce((sum, row) => sum + row.failedApproachRetrieved, 0),
      failureRows.reduce((sum, row) => sum + row.failedApproachTotal, 0),
    ),
    recallAt1: metric(answerable.reduce((sum, row) => sum + row.relevantRetrieved['1'], 0), totalRelevant),
    recallAt3: metric(answerable.reduce((sum, row) => sum + row.relevantRetrieved['3'], 0), totalRelevant),
    recallAt5: metric(answerable.reduce((sum, row) => sum + row.relevantRetrieved['5'], 0), totalRelevant),
    recallAt10: metric(answerable.reduce((sum, row) => sum + row.relevantRetrieved['10'], 0), totalRelevant),
    mrr: metric(answerable.reduce((sum, row) => sum + row.reciprocalRank, 0), answerable.length),
    ndcgAt5: metric(answerable.reduce((sum, row) => sum + row.ndcgAt5, 0), answerable.length),
    ndcgAt10: metric(answerable.reduce((sum, row) => sum + row.ndcgAt10, 0), answerable.length),
    staleResultRate: metric(applicable.reduce((sum, row) => sum + row.staleHits, 0), retrievedHits),
    forbiddenResultRate: metric(applicable.reduce((sum, row) => sum + row.forbiddenHits, 0), retrievedHits),
    duplicateResultRate: metric(applicable.reduce((sum, row) => sum + row.duplicateHits, 0), retrievedHits),
    abstentionAccuracy: metric(abstentions.filter(row => row.abstentionCorrect).length, abstentions.length),
  };

  return { metrics, perQuery, failures };
}
