export type RetrievalEvaluationCase = {
  id: string;
  query: string;
  expectedItemIds: string[];
  mustNotReturn: string[];
  limit: number;
  /**
   * Difficulty band, e.g. basic/moderate/extreme in `semantic-suite.json`. Optional:
   * the older suites declare none, and those report an empty `byTier`.
   */
  tier?: string;
};

export type RetrievalExecution = {
  itemIds: string[];
  staleItemIds: string[];
  latencyMs: number;
  contextChars: number;
};

export type RetrievalTierMetrics = {
  cases: number;
  recallAt3: number;
  recallAt10: number;
  mrr: number;
  ndcg: number;
};

export type RetrievalEvaluation = {
  metrics: {
    recallAt3: number;
    recallAt10: number;
    mrr: number;
    ndcg: number;
    staleHitCount: number;
    forbiddenHitCount: number;
    p50LatencyMs: number;
    p95LatencyMs: number;
    averageContextChars: number;
  };
  /**
   * Ranking metrics per declared tier. Empty when no case declares one.
   *
   * Grouped as well as pooled: a model that wins on the hardest tier while losing on
   * the ordinary one is the wrong choice, and a single overall number hides exactly that.
   */
  byTier: Record<string, RetrievalTierMetrics>;
  failedCaseIds: string[];
};

/** One case's ranking outcome, kept so pooled and per-tier numbers come from the same data. */
type ScoredCase = {
  tier?: string;
  recall3: number;
  recall10: number;
  reciprocalRank: number;
  ndcg: number;
};

function aggregate(entries: ScoredCase[]): RetrievalTierMetrics {
  return {
    cases: entries.length,
    recallAt3: mean(entries.map(entry => entry.recall3)),
    recallAt10: mean(entries.map(entry => entry.recall10)),
    mrr: mean(entries.map(entry => entry.reciprocalRank)),
    ndcg: mean(entries.map(entry => entry.ndcg)),
  };
}

function mean(values: number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function percentile(values: number[], percentile: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  if (percentile === 0.5 && sorted.length % 2 === 0) {
    const upper = sorted.length / 2;
    return (sorted[upper - 1] + sorted[upper]) / 2;
  }
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(percentile * sorted.length) - 1))];
}

function dcg(ids: string[], expected: Set<string>): number {
  return ids.reduce((score, id, index) => score + (expected.has(id) ? 1 / Math.log2(index + 2) : 0), 0);
}

export async function evaluateRetrieval(
  cases: RetrievalEvaluationCase[],
  execute: (testCase: RetrievalEvaluationCase) => Promise<RetrievalExecution>,
): Promise<RetrievalEvaluation> {
  const scored: ScoredCase[] = [];
  const latencies: number[] = [];
  const contexts: number[] = [];
  const failedCaseIds: string[] = [];
  let staleHitCount = 0;
  let forbiddenHitCount = 0;

  for (const testCase of cases) {
    const execution = await execute(testCase);
    const expected = new Set(testCase.expectedItemIds);
    const matching = (ids: string[]) => ids.filter(id => expected.has(id)).length / Math.max(1, expected.size);
    const first = execution.itemIds.findIndex(id => expected.has(id));
    const ideal = dcg(testCase.expectedItemIds, expected);
    scored.push({
      tier: testCase.tier,
      recall3: matching(execution.itemIds.slice(0, 3)),
      recall10: matching(execution.itemIds.slice(0, 10)),
      reciprocalRank: first < 0 ? 0 : 1 / (first + 1),
      ndcg: ideal ? dcg(execution.itemIds, expected) / ideal : 1,
    });
    staleHitCount += execution.itemIds.filter(id => execution.staleItemIds.includes(id)).length;
    const forbidden = execution.itemIds.filter(id => testCase.mustNotReturn.includes(id)).length;
    forbiddenHitCount += forbidden;
    if (forbidden > 0 || first < 0) failedCaseIds.push(testCase.id);
    latencies.push(execution.latencyMs);
    contexts.push(execution.contextChars);
  }

  const overall = aggregate(scored);
  const byTier: Record<string, RetrievalTierMetrics> = {};
  for (const tier of [...new Set(scored.map(entry => entry.tier).filter(Boolean) as string[])]) {
    byTier[tier] = aggregate(scored.filter(entry => entry.tier === tier));
  }

  return {
    metrics: {
      recallAt3: overall.recallAt3, recallAt10: overall.recallAt10, mrr: overall.mrr, ndcg: overall.ndcg,
      staleHitCount, forbiddenHitCount, p50LatencyMs: percentile(latencies, 0.5), p95LatencyMs: percentile(latencies, 0.95), averageContextChars: mean(contexts),
    },
    byTier,
    failedCaseIds,
  };
}
