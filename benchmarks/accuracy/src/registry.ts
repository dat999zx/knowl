import fs from 'node:fs/promises';
import { z } from 'zod';
import type {
  AdapterMetadata,
  BenchmarkAdapter,
  RetrieveRequest,
  RetrievalResponse,
} from './protocol.js';

const LockedSystemSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  version: z.string().min(1),
  repository: z.string().url(),
  commit: z.string().regex(/^[a-f0-9]{40}$/u),
  status: z.literal('unavailable'),
  reason: z.string().min(1),
  normalized: z.record(z.unknown()).optional(),
  native: z.record(z.unknown()).optional(),
}).strict();

const SystemsLockSchema = z.object({
  schemaVersion: z.literal(1),
  verifiedOn: z.string().date(),
  systems: z.array(LockedSystemSchema),
}).strict();

export type LockedSystem = z.infer<typeof LockedSystemSchema>;

class UnavailableAdapter implements BenchmarkAdapter {
  readonly metadata: AdapterMetadata;

  constructor(system: LockedSystem) {
    const unavailable = {
      supported: false,
      sourceProvenance: false,
      temporalAsOf: false,
      retrievalAbstention: false,
      memoryInventory: false,
      nativeContextComposition: false,
      reason: system.reason,
    } as const;
    this.metadata = {
      name: system.name,
      version: system.version,
      repository: system.repository,
      commit: system.commit,
      capabilities: { normalized: unavailable, native: unavailable },
    };
  }

  async reset(): Promise<void> {}
  async finalize(): Promise<void> {}
  async close(): Promise<void> {}

  async retrieve(_request: RetrieveRequest): Promise<RetrievalResponse> {
    throw new Error(`${this.metadata.name} is unavailable in this checkout.`);
  }
}

export async function loadUnavailableAdapters(lockPath: string): Promise<BenchmarkAdapter[]> {
  const parsed = SystemsLockSchema.parse(JSON.parse(await fs.readFile(lockPath, 'utf-8')));
  const ids = new Set<string>();
  for (const system of parsed.systems) {
    if (ids.has(system.id)) throw new Error(`Duplicate system id in lock file: ${system.id}`);
    ids.add(system.id);
  }
  return parsed.systems.map(system => new UnavailableAdapter(system));
}

export { SystemsLockSchema };
