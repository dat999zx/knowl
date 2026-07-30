import type {
  AdapterMetadata,
  BenchmarkAdapter,
  RetrieveRequest,
  RetrievalResponse,
} from './protocol.js';
import type { NormalizedRecord } from './schema.js';

const normalizedCapabilities = {
  normalized: {
    supported: true,
    sourceProvenance: true,
    temporalAsOf: true,
    retrievalAbstention: true,
    memoryInventory: false,
    nativeContextComposition: false,
  },
  native: {
    supported: false,
    sourceProvenance: false,
    temporalAsOf: false,
    retrievalAbstention: false,
    memoryInventory: false,
    nativeContextComposition: false,
    reason: 'baseline supports normalized records only',
  },
} satisfies AdapterMetadata['capabilities'];

function tokenize(value: string): string[] {
  return value
    .normalize('NFKC')
    .replace(/([a-z\d])([A-Z])/gu, '$1 $2')
    .toLowerCase()
    .match(/[\p{L}\p{N}_./-]+/gu) ?? [];
}

function recordText(record: NormalizedRecord): string {
  return [
    record.title,
    record.content,
    record.locators?.path,
    record.locators?.symbol,
    record.locators?.command,
  ].filter(Boolean).join(' ');
}

function eligible(records: NormalizedRecord[], request: RetrieveRequest): NormalizedRecord[] {
  return records.filter(record => record.projectId === request.projectId
    && (!request.asOf || Date.parse(record.occurredAt) <= Date.parse(request.asOf)));
}

abstract class NormalizedBaseline implements BenchmarkAdapter {
  abstract readonly metadata: AdapterMetadata;
  protected records: NormalizedRecord[] = [];

  async reset(): Promise<void> {
    this.records = [];
  }

  async ingestNormalized(record: NormalizedRecord): Promise<void> {
    this.records.push(record);
  }

  async finalize(): Promise<void> {}

  abstract retrieve(request: RetrieveRequest): Promise<RetrievalResponse>;

  async close(): Promise<void> {
    this.records = [];
  }

  protected response(scored: Array<{ record: NormalizedRecord; score: number }>, topK: number): RetrievalResponse {
    const hits = scored
      .filter(item => item.score > 0)
      .sort((a, b) => b.score - a.score || b.record.occurredAt.localeCompare(a.record.occurredAt) || a.record.sourceId.localeCompare(b.record.sourceId))
      .slice(0, topK)
      .map(item => ({ memoryId: item.record.sourceId, text: item.record.content, sourceIds: [item.record.sourceId] }));
    return hits.length ? { decision: 'results', hits } : { decision: 'abstain', hits: [] };
  }
}

export class Bm25Adapter extends NormalizedBaseline {
  readonly metadata: AdapterMetadata = {
    name: 'bm25-baseline',
    version: '1',
    configurationHash: 'k1=1.2;b=0.75;tokenizer=unicode-v1',
    capabilities: normalizedCapabilities,
  };

  async retrieve(request: RetrieveRequest): Promise<RetrievalResponse> {
    const records = eligible(this.records, request);
    const queryTokens = [...new Set(tokenize(request.text))];
    if (!records.length || !queryTokens.length) return { decision: 'abstain', hits: [] };
    const documents = records.map(record => ({ record, tokens: tokenize(recordText(record)) }));
    const averageLength = documents.reduce((sum, document) => sum + document.tokens.length, 0) / documents.length || 1;
    const k1 = 1.2;
    const b = 0.75;
    const scored = documents.map(document => {
      const counts = new Map<string, number>();
      for (const token of document.tokens) counts.set(token, (counts.get(token) ?? 0) + 1);
      const score = queryTokens.reduce((sum, token) => {
        const termFrequency = counts.get(token) ?? 0;
        if (!termFrequency) return sum;
        const documentFrequency = documents.filter(candidate => candidate.tokens.includes(token)).length;
        const inverseDocumentFrequency = Math.log(1 + ((documents.length - documentFrequency + 0.5) / (documentFrequency + 0.5)));
        const normalizedFrequency = (termFrequency * (k1 + 1))
          / (termFrequency + k1 * (1 - b + b * (document.tokens.length / averageLength)));
        return sum + inverseDocumentFrequency * normalizedFrequency;
      }, 0);
      return { record: document.record, score };
    });
    return this.response(scored, request.topK);
  }
}

export class GrepAdapter extends NormalizedBaseline {
  readonly metadata: AdapterMetadata = {
    name: 'grep-baseline',
    version: '1',
    configurationHash: 'case-insensitive-token-overlap-v1',
    capabilities: normalizedCapabilities,
  };

  async retrieve(request: RetrieveRequest): Promise<RetrievalResponse> {
    const query = request.text.normalize('NFKC').toLowerCase();
    const queryTokens = [...new Set(tokenize(query))];
    const scored = eligible(this.records, request).map(record => {
      const text = recordText(record).normalize('NFKC').toLowerCase();
      const tokenHits = queryTokens.filter(token => text.includes(token)).length;
      const exactBoost = text.includes(query) ? queryTokens.length + 1 : 0;
      return { record, score: tokenHits + exactBoost };
    });
    return this.response(scored, request.topK);
  }
}

const VECTOR_DIMENSIONS = 512;

function hashToken(token: string): { index: number; sign: number } {
  let hash = 2_166_136_261;
  for (let index = 0; index < token.length; index += 1) {
    hash ^= token.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return { index: (hash >>> 0) % VECTOR_DIMENSIONS, sign: (hash & 1) === 0 ? 1 : -1 };
}

function vectorize(text: string): Float64Array {
  const vector = new Float64Array(VECTOR_DIMENSIONS);
  for (const token of tokenize(text)) {
    const hashed = hashToken(token);
    vector[hashed.index] += hashed.sign;
  }
  const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (magnitude) for (let index = 0; index < vector.length; index += 1) vector[index] /= magnitude;
  return vector;
}

function cosine(left: Float64Array, right: Float64Array): number {
  let score = 0;
  for (let index = 0; index < left.length; index += 1) score += left[index] * right[index];
  return score;
}

export class HashVectorAdapter extends NormalizedBaseline {
  readonly metadata: AdapterMetadata = {
    name: 'hash-vector-control',
    version: '1',
    configurationHash: `signed-fnv1a-${VECTOR_DIMENSIONS}d-token-vector-v1`,
    capabilities: normalizedCapabilities,
  };

  async retrieve(request: RetrieveRequest): Promise<RetrievalResponse> {
    const queryVector = vectorize(request.text);
    const scored = eligible(this.records, request).map(record => ({
      record,
      score: cosine(queryVector, vectorize(recordText(record))),
    }));
    return this.response(scored, request.topK);
  }
}

export class SemanticVectorUnavailableAdapter implements BenchmarkAdapter {
  readonly metadata: AdapterMetadata = {
    name: 'semantic-vector-only-baseline',
    version: 'unconfigured',
    capabilities: {
      normalized: {
        supported: false,
        sourceProvenance: false,
        temporalAsOf: false,
        retrievalAbstention: false,
        memoryInventory: false,
        nativeContextComposition: false,
        reason: 'exact embedding model revision and configuration are not pinned',
      },
      native: {
        supported: false,
        sourceProvenance: false,
        temporalAsOf: false,
        retrievalAbstention: false,
        memoryInventory: false,
        nativeContextComposition: false,
        reason: 'semantic vector baseline is normalized-only and unconfigured',
      },
    },
  };

  async reset(): Promise<void> {}
  async finalize(): Promise<void> {}
  async close(): Promise<void> {}

  async retrieve(): Promise<RetrievalResponse> {
    throw new Error('Semantic vector baseline is unconfigured.');
  }
}

export class NoMemoryAdapter extends NormalizedBaseline {
  readonly metadata: AdapterMetadata = {
    name: 'no-memory-baseline',
    version: '1',
    configurationHash: 'always-abstain',
    capabilities: normalizedCapabilities,
  };

  async retrieve(): Promise<RetrievalResponse> {
    return { decision: 'abstain', hits: [] };
  }
}
