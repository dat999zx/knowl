import { z } from 'zod';
import type { NativeEvent, NormalizedRecord } from './schema.js';

export type BenchmarkMode = 'normalized' | 'native';

export type ModeCapabilities = {
  supported: boolean;
  sourceProvenance: boolean;
  temporalAsOf: boolean;
  retrievalAbstention: boolean;
  memoryInventory: boolean;
  nativeContextComposition: boolean;
  reason?: string;
};

export type AdapterCapabilities = {
  normalized: ModeCapabilities;
  native: ModeCapabilities;
};

export type AdapterMetadata = {
  name: string;
  version: string;
  repository?: string;
  commit?: string;
  configurationHash?: string;
  capabilities: AdapterCapabilities;
};

export const RetrieveRequestSchema = z.object({
  projectId: z.string().min(1),
  text: z.string().min(1),
  asOf: z.string().datetime().optional(),
  topK: z.number().int().positive(),
  contextBudget: z.number().int().positive().optional(),
}).strict();

export const RetrievalHitSchema = z.object({
  memoryId: z.string().min(1),
  text: z.string(),
  sourceIds: z.array(z.string().min(1)).optional(),
}).strict();

export const RetrievalResponseSchema = z.discriminatedUnion('decision', [
  z.object({ decision: z.literal('results'), hits: z.array(RetrievalHitSchema).min(1) }).strict(),
  z.object({ decision: z.literal('abstain'), hits: z.array(RetrievalHitSchema).length(0) }).strict(),
]);

export type RetrieveRequest = z.infer<typeof RetrieveRequestSchema>;
export type RetrievalHit = z.infer<typeof RetrievalHitSchema>;
export type RetrievalResponse = z.infer<typeof RetrievalResponseSchema>;

export type RetrievalPrediction = {
  questionId: string;
  response?: RetrievalResponse;
  error?: string;
  notApplicableReason?: string;
};

export type CapturedMemory = {
  memoryId: string;
  text: string;
  sourceIds?: string[];
};

export interface BenchmarkAdapter {
  readonly metadata: AdapterMetadata;
  reset(input: { runId: string; mode: BenchmarkMode; seed: number }): Promise<void>;
  ingestNormalized?(record: NormalizedRecord): Promise<void>;
  ingestNative?(event: NativeEvent & { projectId: string; historyId: string; sessionId: string }): Promise<void>;
  finalize(): Promise<void>;
  retrieve(request: RetrieveRequest): Promise<RetrievalResponse>;
  listMemories?(): Promise<CapturedMemory[]>;
  close(): Promise<void>;
}

export function queryToRequest(
  query: { questionId: string; projectId: string; text: string; asOf?: string },
  controls: { topK: number; contextBudget?: number },
): RetrieveRequest {
  return RetrieveRequestSchema.parse({
    projectId: query.projectId,
    text: query.text,
    ...(query.asOf ? { asOf: query.asOf } : {}),
    topK: controls.topK,
    ...(controls.contextBudget ? { contextBudget: controls.contextBudget } : {}),
  });
}
