import { z } from 'zod';

export const BENCHMARK_SCHEMA_VERSION = 1 as const;
export const BENCHMARK_GENERATOR_VERSION = 'coding-memory-v1' as const;

export const MemoryKindSchema = z.enum([
  'architecture',
  'state',
  'constraint',
  'command',
  'symbol',
  'failure',
  'decision',
  'observation',
  'correction',
  'gotcha',
]);

export const QuestionCategorySchema = z.enum([
  'architecture_decision',
  'current_state',
  'historical_state',
  'constraint',
  'command_workflow',
  'code_symbol',
  'failed_approach',
  'superseded_decision',
  'contradiction',
  'stale_evidence',
  'multi_session',
  'abstention',
]);

const RelationsSchema = z.object({
  supersedes: z.array(z.string()).optional(),
  contradicts: z.array(z.string()).optional(),
  resolves: z.array(z.string()).optional(),
}).strict();

const LocatorsSchema = z.object({
  path: z.string().optional(),
  symbol: z.string().optional(),
  command: z.string().optional(),
}).strict();

export const NormalizedRecordSchema = z.object({
  sourceId: z.string().min(1),
  projectId: z.string().min(1),
  historyId: z.string().min(1),
  sessionId: z.string().min(1),
  occurredAt: z.string().datetime(),
  availableAt: z.string().datetime(),
  kind: MemoryKindSchema,
  title: z.string().min(1),
  content: z.string().min(1),
  relations: RelationsSchema.optional(),
  locators: LocatorsSchema.optional(),
}).strict();

export const NativeEventSchema = z.object({
  sourceId: z.string().min(1),
  occurredAt: z.string().datetime(),
  type: z.enum(['user', 'assistant', 'tool_call', 'tool_result', 'file_change', 'lifecycle']),
  content: z.string(),
  command: z.string().optional(),
  exitCode: z.number().int().optional(),
  path: z.string().optional(),
  symbol: z.string().optional(),
  replayOf: z.string().optional(),
}).strict();

export const NativeSessionSchema = z.object({
  sessionId: z.string().min(1),
  startedAt: z.string().datetime(),
  endedAt: z.string().datetime().nullable(),
  termination: z.enum(['normal', 'interrupted']),
  events: z.array(NativeEventSchema).min(1),
}).strict();

export const NativeHistorySchema = z.object({
  historyId: z.string().min(1),
  projectId: z.string().min(1),
  sessions: z.array(NativeSessionSchema).length(4),
}).strict();

export const PublicQuerySchema = z.object({
  questionId: z.string().min(1),
  projectId: z.string().min(1),
  historyId: z.string().min(1),
  issuedAt: z.string().datetime(),
  asOf: z.string().datetime().optional(),
  text: z.string().min(1),
}).strict();

export const QuestionGoldSchema = z.object({
  questionId: z.string().min(1),
  category: QuestionCategorySchema,
  shouldAbstain: z.boolean(),
  answer: z.object({
    kind: z.enum(['string', 'set', 'timeline', 'warning', 'abstain']),
    canonical: z.unknown(),
    acceptedText: z.array(z.string()).optional(),
  }).strict(),
  judgments: z.array(z.object({
    sourceId: z.string().min(1),
    grade: z.union([z.literal(1), z.literal(2), z.literal(3)]),
    role: z.enum(['answer', 'support', 'background']),
  }).strict()),
  requiredEvidenceGroups: z.array(z.array(z.string().min(1)).min(1)),
  harmful: z.array(z.object({
    sourceId: z.string().min(1),
    reason: z.enum(['superseded', 'future', 'contradicted', 'refuted_temporary', 'cross_project', 'secret']),
  }).strict()),
  temporalKind: z.enum(['current', 'as_of', 'change_point', 'timeline', 'contradiction']).optional(),
  failure: z.object({
    shouldWarn: z.boolean(),
    failedApproachSourceIds: z.array(z.string()),
    requiredReasonFacts: z.array(z.string()),
  }).strict().optional(),
}).strict();

export const CaptureGoldSchema = z.object({
  historyId: z.string().min(1),
  targets: z.array(z.object({
    targetId: z.string().min(1),
    canonicalFact: z.string().min(1),
    evidenceSourceIds: z.array(z.string().min(1)).min(1),
  }).strict()),
  exclusions: z.array(z.object({
    sourceId: z.string().min(1),
    reason: z.enum(['temporary', 'refuted', 'secret', 'irrelevant', 'malformed', 'duplicate']),
  }).strict()),
}).strict();

export const BenchmarkManifestSchema = z.object({
  schemaVersion: z.literal(BENCHMARK_SCHEMA_VERSION),
  datasetId: z.string().min(1),
  generatorVersion: z.string().min(1),
  seed: z.string().min(1),
  defaultRelevanceGrade: z.literal(0),
  generatedAt: z.string().datetime(),
  counts: z.object({
    projects: z.number().int().nonnegative(),
    histories: z.number().int().nonnegative(),
    sessions: z.number().int().nonnegative(),
    questions: z.number().int().nonnegative(),
  }).strict(),
  digests: z.record(z.string()).default({}),
}).strict();

export type NormalizedRecord = z.infer<typeof NormalizedRecordSchema>;
export type NativeEvent = z.infer<typeof NativeEventSchema>;
export type NativeHistory = z.infer<typeof NativeHistorySchema>;
export type PublicQuery = z.infer<typeof PublicQuerySchema>;
export type QuestionGold = z.infer<typeof QuestionGoldSchema>;
export type CaptureGold = z.infer<typeof CaptureGoldSchema>;
export type BenchmarkManifest = z.infer<typeof BenchmarkManifestSchema>;
export type QuestionCategory = z.infer<typeof QuestionCategorySchema>;

export type BenchmarkBundle = {
  manifest: BenchmarkManifest;
  normalizedRecords: NormalizedRecord[];
  nativeHistories: NativeHistory[];
  queries: PublicQuery[];
  questionGold: QuestionGold[];
  captureGold: CaptureGold[];
};
