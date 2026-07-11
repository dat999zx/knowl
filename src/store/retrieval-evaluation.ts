export type RetrievalEvaluationCase = {
  id: string;
  query: string;
  expectedItemIds: string[];
  mustNotReturn: string[];
  limit: number;
};

export type RetrievalExecution = {
  itemIds: string[];
  staleItemIds: string[];
  latencyMs: number;
  contextChars: number;
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
  failedCaseIds: string[];
};

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
  const recall3: number[] = [];
  const recall10: number[] = [];
  const reciprocalRanks: number[] = [];
  const ndcgs: number[] = [];
  const latencies: number[] = [];
  const contexts: number[] = [];
  const failedCaseIds: string[] = [];
  let staleHitCount = 0;
  let forbiddenHitCount = 0;

  for (const testCase of cases) {
    const execution = await execute(testCase);
    const expected = new Set(testCase.expectedItemIds);
    const matching = (ids: string[]) => ids.filter(id => expected.has(id)).length / Math.max(1, expected.size);
    recall3.push(matching(execution.itemIds.slice(0, 3)));
    recall10.push(matching(execution.itemIds.slice(0, 10)));
    const first = execution.itemIds.findIndex(id => expected.has(id));
    reciprocalRanks.push(first < 0 ? 0 : 1 / (first + 1));
    const ideal = dcg(testCase.expectedItemIds, expected);
    ndcgs.push(ideal ? dcg(execution.itemIds, expected) / ideal : 1);
    staleHitCount += execution.itemIds.filter(id => execution.staleItemIds.includes(id)).length;
    const forbidden = execution.itemIds.filter(id => testCase.mustNotReturn.includes(id)).length;
    forbiddenHitCount += forbidden;
    if (forbidden > 0 || first < 0) failedCaseIds.push(testCase.id);
    latencies.push(execution.latencyMs);
    contexts.push(execution.contextChars);
  }

  return {
    metrics: {
      recallAt3: mean(recall3), recallAt10: mean(recall10), mrr: mean(reciprocalRanks), ndcg: mean(ndcgs),
      staleHitCount, forbiddenHitCount, p50LatencyMs: percentile(latencies, 0.5), p95LatencyMs: percentile(latencies, 0.95), averageContextChars: mean(contexts),
    },
    failedCaseIds,
  };
}
