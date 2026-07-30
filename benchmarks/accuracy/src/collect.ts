import {
  RetrievalResponseSchema,
  queryToRequest,
  type AdapterMetadata,
  type BenchmarkAdapter,
  type RetrievalPrediction,
} from './protocol.js';
import type { NormalizedRecord, PublicQuery } from './schema.js';

export type CollectionOptions = {
  runs: number;
  seed: number;
  topK: number;
  contextBudget?: number;
};

export type CollectedRun = {
  runIndex: number;
  seed: number;
  predictions: RetrievalPrediction[];
  failures: string[];
};

export type CollectionResult = {
  status: 'complete' | 'failed' | 'not_applicable';
  adapter: AdapterMetadata;
  mode: 'normalized';
  reason?: string;
  runs: CollectedRun[];
};

function validateOptions(options: CollectionOptions): void {
  if (!Number.isInteger(options.runs) || options.runs < 1) throw new Error('runs must be a positive integer');
  if (!Number.isInteger(options.topK) || options.topK < 1) throw new Error('topK must be a positive integer');
  if (!Number.isInteger(options.seed)) throw new Error('seed must be an integer');
}

export async function collectNormalized(
  input: { records: NormalizedRecord[]; queries: PublicQuery[] },
  adapter: BenchmarkAdapter,
  options: CollectionOptions,
): Promise<CollectionResult> {
  validateOptions(options);
  const capability = adapter.metadata.capabilities.normalized;
  if (!capability.supported) {
    return {
      status: 'not_applicable',
      adapter: adapter.metadata,
      mode: 'normalized',
      reason: capability.reason ?? 'normalized mode is unsupported',
      runs: [],
    };
  }
  if (!adapter.ingestNormalized) throw new Error(`Adapter ${adapter.metadata.name} declares normalized support without ingestNormalized.`);

  const records = [...input.records].sort((a, b) => Date.parse(a.availableAt) - Date.parse(b.availableAt) || a.sourceId.localeCompare(b.sourceId));
  const queries = [...input.queries].sort((a, b) => Date.parse(a.issuedAt) - Date.parse(b.issuedAt) || a.questionId.localeCompare(b.questionId));
  const runs: CollectedRun[] = [];

  for (let runIndex = 0; runIndex < options.runs; runIndex += 1) {
    const runSeed = options.seed + runIndex;
    const predictions: RetrievalPrediction[] = [];
    const failures: string[] = [];
    let recordIndex = 0;
    let started = false;
    try {
      await adapter.reset({
        runId: `${adapter.metadata.name}-normalized-${runIndex + 1}`,
        mode: 'normalized',
        seed: runSeed,
      });
      started = true;
      for (const query of queries) {
        while (recordIndex < records.length && Date.parse(records[recordIndex].availableAt) <= Date.parse(query.issuedAt)) {
          await adapter.ingestNormalized(records[recordIndex]);
          recordIndex += 1;
        }
        await adapter.finalize();
        if (query.asOf && !capability.temporalAsOf) {
          predictions.push({ questionId: query.questionId, notApplicableReason: 'adapter does not support strict as-of retrieval' });
          continue;
        }
        const request = queryToRequest(query, { topK: options.topK, contextBudget: options.contextBudget });
        try {
          const response = RetrievalResponseSchema.parse(await adapter.retrieve(request));
          predictions.push({ questionId: query.questionId, response });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          predictions.push({ questionId: query.questionId, error: message });
          failures.push(`${query.questionId}: ${message}`);
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push(`run: ${message}`);
    } finally {
      if (started) {
        try {
          await adapter.close();
        } catch (error) {
          failures.push(`close: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
    runs.push({ runIndex, seed: runSeed, predictions, failures });
  }

  return {
    status: runs.some(run => run.failures.some(failure => failure.startsWith('run:'))) ? 'failed' : 'complete',
    adapter: adapter.metadata,
    mode: 'normalized',
    runs,
  };
}
