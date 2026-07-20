import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { KnowledgeCategory } from '../../../src/core/types.js';
import { queryKnowledgeForAgent } from '../../../src/store/agent-query.js';
import { closeDb, initDb } from '../../../src/store/database.js';
import * as repository from '../../../src/store/repository.js';
import type {
  AdapterMetadata,
  BenchmarkAdapter,
  RetrieveRequest,
  RetrievalResponse,
} from './protocol.js';
import type { NormalizedRecord } from './schema.js';

const CATEGORY_MAP: Record<NormalizedRecord['kind'], KnowledgeCategory> = {
  architecture: 'architecture',
  state: 'state',
  constraint: 'constraint',
  command: 'skill',
  symbol: 'architecture',
  failure: 'fact',
  decision: 'decision',
  observation: 'fact',
  correction: 'fact',
  gotcha: 'fact',
};

function safeDirectoryName(projectId: string): string {
  return projectId.replace(/[^a-zA-Z0-9_.-]/gu, '_');
}

export class KnowlBenchmarkAdapter implements BenchmarkAdapter {
  readonly metadata: AdapterMetadata;

  private runRoot: string | null = null;
  private activeProjectId: string | null = null;
  private itemIds = new Map<string, Map<string, string>>();
  private sourceIds = new Map<string, Map<string, string>>();

  constructor(commit?: string, version = 'workspace') {
    this.metadata = {
      name: 'knowl',
      version,
      repository: 'https://github.com/dat999zx/knowl',
      ...(commit ? { commit } : {}),
      configurationHash: 'query=hybrid-default;vectors=disabled;status=active;provenance=benchmark-source-v1',
      capabilities: {
        normalized: {
          supported: true,
          sourceProvenance: true,
          temporalAsOf: false,
          retrievalAbstention: true,
          memoryInventory: false,
          nativeContextComposition: false,
          reason: 'Knowl writes do not currently accept benchmark event timestamps for strict as-of replay',
        },
        native: {
          supported: false,
          sourceProvenance: false,
          temporalAsOf: false,
          retrievalAbstention: false,
          memoryInventory: false,
          nativeContextComposition: false,
          reason: 'native lifecycle adapter is not implemented yet',
        },
      },
    };
  }

  async reset(): Promise<void> {
    if (this.runRoot) await this.close();
    this.runRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'knowl-benchmark-'));
    this.activeProjectId = null;
    this.itemIds = new Map();
    this.sourceIds = new Map();
  }

  private async activateProject(projectId: string): Promise<void> {
    if (!this.runRoot) throw new Error('Knowl benchmark adapter has not been reset.');
    if (this.activeProjectId === projectId) return;
    if (this.activeProjectId) await closeDb();
    const projectRoot = path.join(this.runRoot, safeDirectoryName(projectId));
    await fs.mkdir(path.join(projectRoot, '.knowl'), { recursive: true });
    await initDb(projectRoot);
    await repository.createProject(projectRoot, projectId);
    this.activeProjectId = projectId;
    if (!this.itemIds.has(projectId)) this.itemIds.set(projectId, new Map());
    if (!this.sourceIds.has(projectId)) this.sourceIds.set(projectId, new Map());
  }

  async ingestNormalized(record: NormalizedRecord): Promise<void> {
    await this.activateProject(record.projectId);
    const projectItems = this.itemIds.get(record.projectId)!;
    for (const relatedSourceId of [
      ...(record.relations?.supersedes ?? []),
      ...(record.relations?.resolves ?? []),
    ]) {
      const relatedItemId = projectItems.get(relatedSourceId);
      if (!relatedItemId) throw new Error(`Record ${record.sourceId} references unavailable source ${relatedSourceId}.`);
      await repository.updateKnowledgeItem(relatedItemId, { status: 'superseded' });
    }
    const item = await repository.createKnowledgeItem('local', {
      category: CATEGORY_MAP[record.kind],
      title: record.title,
      content: record.content,
      tags: [record.kind, record.historyId, ...(record.locators?.path ? [record.locators.path] : [])],
      source: `benchmark:${record.sourceId}`,
      affectedPaths: record.locators?.path ? [record.locators.path] : undefined,
    });
    projectItems.set(record.sourceId, item.id);
    this.sourceIds.get(record.projectId)!.set(item.id, record.sourceId);
  }

  async finalize(): Promise<void> {}

  async retrieve(request: RetrieveRequest): Promise<RetrievalResponse> {
    if (request.asOf) throw new Error('Knowl benchmark adapter does not support strict as-of retrieval.');
    await this.activateProject(request.projectId);
    const sourceIds = this.sourceIds.get(request.projectId)!;
    const items = await queryKnowledgeForAgent('local', {
      query: request.text,
      status: 'active',
      surface: 'accuracy_benchmark',
      limit: request.topK,
    });
    const hits = items.flatMap(item => {
      const sourceId = sourceIds.get(item.id);
      return sourceId ? [{ memoryId: item.id, text: `${item.title}\n${item.content}`, sourceIds: [sourceId] }] : [];
    });
    return hits.length ? { decision: 'results', hits } : { decision: 'abstain', hits: [] };
  }

  async close(): Promise<void> {
    const runRoot = this.runRoot;
    this.runRoot = null;
    this.activeProjectId = null;
    try {
      await closeDb();
    } finally {
      if (runRoot) {
        await fs.rm(runRoot, { recursive: true, force: true }).catch((error: NodeJS.ErrnoException) => {
          if (!['EBUSY', 'EPERM'].includes(error.code ?? '')) throw error;
          // libSQL can retain a Windows file handle until process exit. Benchmark
          // runs use unique temporary roots, so a locked root is never reused.
        });
      }
      this.itemIds.clear();
      this.sourceIds.clear();
    }
  }
}
