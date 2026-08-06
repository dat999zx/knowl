import { z } from 'zod';
import type {
  AdapterMetadata,
  BenchmarkAdapter,
  CapturedMemory,
} from './protocol.js';
import type { NativeHistory } from './schema.js';

const CapturedMemoryOutputSchema = z.object({
  memoryId: z.string().min(1),
  text: z.string(),
  sourceIds: z.array(z.string().min(1)).optional(),
}).strict();

const CapturedMemoryListSchema = z.array(CapturedMemoryOutputSchema);

export type NativeCollectionOptions = {
  runs: number;
  seed: number;
};

export type NativeCapturePrediction = {
  historyId: string;
  memories?: CapturedMemory[];
  error?: string;
};

export type NativeCollectedRun = {
  runIndex: number;
  seed: number;
  predictions: NativeCapturePrediction[];
  failures: string[];
};

export type NativeCollectionResult = {
  status: 'complete' | 'failed' | 'not_applicable';
  adapter: AdapterMetadata;
  mode: 'native';
  reason?: string;
  runs: NativeCollectedRun[];
};

function validateOptions(options: NativeCollectionOptions): void {
  if (!Number.isInteger(options.runs) || options.runs < 1) {
    throw new Error('runs must be a positive integer');
  }
  if (!Number.isInteger(options.seed)) throw new Error('seed must be an integer');
}

export async function collectNative(
  input: { histories: NativeHistory[] },
  adapter: BenchmarkAdapter,
  options: NativeCollectionOptions,
): Promise<NativeCollectionResult> {
  validateOptions(options);
  const capability = adapter.metadata.capabilities.native;
  if (!capability.supported) {
    return {
      status: 'not_applicable',
      adapter: adapter.metadata,
      mode: 'native',
      reason: capability.reason ?? 'native mode is unsupported',
      runs: [],
    };
  }
  if (!capability.memoryInventory) {
    return {
      status: 'not_applicable',
      adapter: adapter.metadata,
      mode: 'native',
      reason: 'adapter does not expose a memory inventory',
      runs: [],
    };
  }
  if (!capability.sourceProvenance) {
    return {
      status: 'not_applicable',
      adapter: adapter.metadata,
      mode: 'native',
      reason: 'adapter does not expose source provenance',
      runs: [],
    };
  }
  if (!adapter.ingestNative) {
    throw new Error(`Adapter ${adapter.metadata.name} declares native support without ingestNative.`);
  }
  if (!adapter.listMemories) {
    throw new Error(`Adapter ${adapter.metadata.name} declares a memory inventory without listMemories.`);
  }

  const runs: NativeCollectedRun[] = [];
  for (let runIndex = 0; runIndex < options.runs; runIndex += 1) {
    const runSeed = options.seed + runIndex;
    const predictions: NativeCapturePrediction[] = [];
    const failures: string[] = [];

    for (const history of input.histories) {
      try {
        await adapter.reset({
          runId: `${adapter.metadata.name}-native-${runIndex + 1}-${history.historyId}`,
          mode: 'native',
          seed: runSeed,
        });
        for (const session of history.sessions) {
          for (const event of session.events) {
            await adapter.ingestNative({
              ...event,
              projectId: history.projectId,
              historyId: history.historyId,
              sessionId: session.sessionId,
            });
          }
        }
        await adapter.finalize();
        const memories = CapturedMemoryListSchema.parse(await adapter.listMemories());
        predictions.push({ historyId: history.historyId, memories });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        predictions.push({ historyId: history.historyId, error: message });
        failures.push(`${history.historyId}: ${message}`);
      } finally {
        // Unconditional: `reset` is the first thing the try does, so every path through it --
        // including a throw partway -- may have left the adapter holding something. A close that
        // fails is recorded, never rethrown, so one adapter cannot end the run.
        try {
          await adapter.close();
        } catch (error) {
          failures.push(`${history.historyId}: close: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }

    runs.push({ runIndex, seed: runSeed, predictions, failures });
  }

  return {
    status: runs.some(run => run.failures.length > 0) ? 'failed' : 'complete',
    adapter: adapter.metadata,
    mode: 'native',
    runs,
  };
}
