import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { closeDb, initDb } from '../../src/store/database.js';
import { releaseAll } from '../../src/store/connection-pool.js';
import * as repo from '../../src/store/repository.js';
import type { ProjectConfig } from '../../src/core/types.js';

/**
 * K-35's second half: the ranker's calibrated score has to reach the agent.
 *
 * The consumer of `knowl_query` is deciding whether to trust memory or go read the files, and a
 * rank cannot tell "this is the answer" apart from "this is the best of a bad lot". The ranker
 * knows the difference -- it is the number the relevance floor abstains on -- and it reached
 * `explain` only, which nothing calls by default.
 *
 * A fake embedder rather than the real one. `tests/workspace/cross-repo-semantic.test.ts`
 * exercises the genuine model at 180s timeouts; what is under test here is the response shape
 * and the calibration property, both of which need cosines that are *known*, not cosines that
 * are good. Bag-of-words over a fixed vocabulary gives an exactly predictable cosine and needs
 * no weights on disk.
 */
const VOCAB = [
  'vector', 'index', 'rebuild', 'schedule', 'nightly',
  'invoice', 'currency', 'rounding', 'tax', 'ledger',
  'deploy', 'staging', 'cluster', 'rollback', 'canary',
];

function bagOfWords(text: string): number[] {
  const tokens = text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const raw = VOCAB.map(term => tokens.filter(token => token === term).length);
  const magnitude = Math.sqrt(raw.reduce((sum, value) => sum + value * value, 0));
  // A text sharing no vocabulary at all would be the zero vector, which has no direction;
  // one constant dimension keeps it finite and its cosine with everything near zero.
  return magnitude === 0 ? VOCAB.map((_, i) => (i === 0 ? 1e-6 : 0)) : raw.map(value => value / magnitude);
}

const FAKE_EMBEDDER = {
  provider: 'local',
  model: 'test/bag-of-words',
  pooling: 'mean' as const,
  profileFingerprint: 'test-bag-of-words-fp',
  // The floor is per model now, and a model with no measured floor does not abstain at all --
  // which would make the abstention cases below assert nothing. This stub declares its own,
  // chosen for the bag-of-words scale these fixtures produce: the borrowed-word queries land
  // near 0.17 and a real match well above 0.3.
  relevanceFloor: 0.30,
  embed: async (texts: string[]) => texts.map(bagOfWords),
  embedQuery: async (text: string) => bagOfWords(text),
};

vi.mock('../../src/ai/embeddings.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/ai/embeddings.js')>();
  return {
    ...actual,
    // The real, config-sensitive isVectorSearchEnabled is kept on purpose: the withheld-score
    // tests below reach the layered and lexical paths by passing a config with vector off.
    createLocalEmbeddingProvider: async () => FAKE_EMBEDDER,
  };
});

const { createMcpServer } = await import('../../src/mcp/server.js');
const { reindexKnowledgeEmbeddings } = await import('../../src/store/vector-index.js');

const TEST_ROOT = path.resolve('./.knowl-mcp-query-score');
const CONFIG: ProjectConfig = {
  version: 1,
  security: { rejectSecrets: true, secretPatterns: [] },
  search: { vector: { enabled: true } },
} as ProjectConfig;
// The same store with the semantic half off: what most archived calls actually ran as.
const NO_VECTOR_CONFIG: ProjectConfig = {
  version: 1,
  security: { rejectSecrets: true, secretPatterns: [] },
} as ProjectConfig;

class InMemoryTransport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: any) => void;
  onSend?: (message: any) => void;
  async start(): Promise<void> {}
  async send(message: any): Promise<void> { this.onSend?.(message); }
  async close(): Promise<void> { this.onclose?.(); }
}

let projectId = '';

async function call(name: string, args: Record<string, unknown>, config: ProjectConfig = CONFIG): Promise<any> {
  const server = createMcpServer(projectId, TEST_ROOT, config);
  const transport = new InMemoryTransport();
  await server.connect(transport as never);
  const waitFor = (id: string) => new Promise<any>(resolve => {
    transport.onSend = message => { if (message.id === id) resolve(message); };
  });
  const initialized = waitFor('init');
  transport.onmessage!({
    jsonrpc: '2.0', id: 'init', method: 'initialize',
    params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'score-test', version: '1.0' } },
  });
  await initialized;
  transport.onmessage!({ jsonrpc: '2.0', method: 'notifications/initialized' });
  const answered = waitFor('call');
  transport.onmessage!({ jsonrpc: '2.0', id: 'call', method: 'tools/call', params: { name, arguments: args } });
  const response = await answered;
  await server.close();
  return response.result;
}

const jsonOf = (result: any): any => JSON.parse(String(result?.content?.[0]?.text ?? ''));

// File-scope rather than suite-scope, so the withheld-score suite below runs against the
// same indexed store after this suite finishes.
beforeAll(async () => {
  await closeDb();
  await releaseAll();
  await fs.rm(TEST_ROOT, { recursive: true, force: true }).catch(() => {});
  await fs.mkdir(path.join(TEST_ROOT, '.knowl'), { recursive: true });
  await initDb(TEST_ROOT);
  projectId = (await repo.createProject(TEST_ROOT, 'query-score')).id;

  await repo.createKnowledgeItem(projectId, {
    category: 'fact', title: 'Vector index rebuild',
    content: 'The vector index rebuild runs on a nightly schedule.',
  });
  await repo.createKnowledgeItem(projectId, {
    category: 'fact', title: 'Invoice rounding',
    content: 'Invoice currency rounding follows the ledger tax rule.',
  });
  await repo.createKnowledgeItem(projectId, {
    category: 'fact', title: 'Deploy rollback',
    content: 'A deploy to the staging cluster can rollback via canary.',
  });
  await reindexKnowledgeEmbeddings(projectId, FAKE_EMBEDDER as never);
});

afterAll(async () => {
  await closeDb();
  await releaseAll();
  await fs.rm(TEST_ROOT, { recursive: true, force: true }).catch(() => {});
});

describe('knowl_query surfaces the calibrated score without being asked', () => {
  it('puts a bounded score on every result of an ordinary, non-explain query', async () => {
    const items = jsonOf(await call('knowl_query', { query: 'vector index rebuild schedule', limit: 3 }));
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      expect(typeof item.score).toBe('number');
      expect(item.score).toBeGreaterThanOrEqual(0);
      expect(item.score).toBeLessThanOrEqual(1);
    }
    // The score is the order, not a decoration beside it.
    expect([...items].sort((a: any, b: any) => b.score - a.score).map((i: any) => i.id))
      .toEqual(items.map((i: any) => i.id));
  });

  it('reports the same number the ranker ranked by', async () => {
    const plain = jsonOf(await call('knowl_query', { query: 'vector index rebuild schedule', limit: 3 }));
    const explained = jsonOf(await call('knowl_query', { query: 'vector index rebuild schedule', limit: 3, explain: true }));
    expect(plain.map((item: any) => item.id)).toEqual(explained.map((item: any) => item.id));
    for (const [index, item] of plain.entries()) {
      expect(item.score).toBeCloseTo(explained[index].explanation.finalScore, 3);
    }
  });

  // The property the number exists for. A rank of 1 is a rank of 1 whether the store answered
  // the question or merely returned the least-bad row it had.
  it('separates a real answer from the best of a bad lot', async () => {
    const answered = jsonOf(await call('knowl_query', { query: 'vector index rebuild schedule', limit: 1 }));
    const scraped = jsonOf(await call('knowl_query', { query: 'nightly tax canary', limit: 1 }));
    expect(answered[0].score).toBeGreaterThan(0.7);
    // Both are rank 1. Only the score says one of them is worth reading.
    if (scraped.length > 0) expect(scraped[0].score).toBeLessThan(0.5);
  });

  it('still carries the full explanation when explicitly asked, and not otherwise', async () => {
    const plain = jsonOf(await call('knowl_query', { query: 'vector index rebuild schedule', limit: 1 }));
    expect(plain[0]).not.toHaveProperty('explanation');
    const explained = jsonOf(await call('knowl_query', { query: 'vector index rebuild schedule', limit: 1, explain: true }));
    expect(explained[0].explanation).toHaveProperty('contributions');
  });

  // Three decimals, because the difference between 0.573 and 0.5730000000000001 is 13 bytes on
  // every result of every query and no information at all.
  it('costs three decimals, not seventeen', async () => {
    const text = String((await call('knowl_query', { query: 'vector index rebuild schedule', limit: 3 })).content[0].text);
    expect(text).not.toMatch(/"score":\d\.\d{5,}/);
  });

  // The floor's verdict has to arrive as words, not as an empty array. Returning nothing was
  // indistinguishable from an empty store or a missing index, and it deleted the answer on
  // every query where the verdict was wrong -- 23 of 110 on semantic-suite.json, measured in
  // docs/evals/floor-sweep.md.
  it('states an abstention in words and still returns the rows', async () => {
    // One word borrowed from each of the three fixtures, so every cosine is about 0.17 -- well
    // under the 0.30 floor, and deterministic under the bag-of-words embedder rather than a
    // conditional that could quietly assert nothing.
    const result = await call('knowl_query', { query: 'canary tax nightly', limit: 3 });
    const blocks = (result.content as Array<{ text: string }>).map(block => block.text);
    const items = JSON.parse(blocks[0]);

    expect(items.length).toBeGreaterThan(0);
    expect(items[0].score).toBeLessThan(0.3);
    expect(blocks.some(text => text.startsWith('NO CONFIDENT MATCH'))).toBe(true);
  });

  it('says nothing about abstention when the query is answered', async () => {
    const result = await call('knowl_query', { query: 'vector index rebuild schedule', limit: 3 });
    const blocks = (result.content as Array<{ text: string }>).map(block => block.text);
    expect(blocks.some(text => text.startsWith('NO CONFIDENT MATCH'))).toBe(false);
  });
});

/**
 * The other half of the same contract: when the score is withheld, the response says so, and
 * says why. Measured on the archive (docs/evals/agent-surface.md §10), 907 of 924 real
 * `knowl_query` results carried no score because the semantic half was off -- and that absence
 * was indistinguishable from the field having been forgotten. The gate itself is right (a
 * lexical-only ranking's top result scores ~1.0 whatever it is; the layered path normalises
 * per namespace, so two 1.0s invite a false comparison), so what ships is not a number but the
 * verdict, in the score field the reader is already told to judge by: the string
 * `uncalibrated (<reason>)`, one idiom with NO CONFIDENT MATCH rather than a second one.
 */
describe('a withheld score says so, and says why', () => {
  beforeAll(async () => {
    // Written AFTER the reindex above and never embedded: vector has never seen it. It shares
    // the query's vocabulary, so its lexical half puts it on the page beside judged rows.
    await repo.createKnowledgeItem(projectId, {
      category: 'fact', title: 'Vector index rebuild follow-up',
      content: 'The vector index rebuild schedule follow-up note.',
    });
  });

  it('labels the layered default path, which normalises per namespace', async () => {
    const items = jsonOf(await call('knowl_query', { query: 'invoice currency rounding', limit: 3 }, NO_VECTOR_CONFIG));
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      expect(item.score).toBe('uncalibrated (layered namespaces)');
    }
  });

  it('labels the lexical-only ranking under explain', async () => {
    const items = jsonOf(await call('knowl_query', { query: 'invoice currency rounding', limit: 3, explain: true }, NO_VECTOR_CONFIG));
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      expect(item.score).toBe('uncalibrated (lexical-only)');
    }
  });

  it('labels the one row vector never saw, and leaves its judged neighbours numeric', async () => {
    const items = jsonOf(await call('knowl_query', { query: 'vector index rebuild schedule', limit: 3 }));
    const unseen = items.find((entry: any) => entry.title === 'Vector index rebuild follow-up');
    expect(unseen).toBeDefined();
    // Its fused number's semantic half is 0 by absence, not by verdict. Published unmarked it
    // reads "very weak"; the truth is "unjudged".
    expect(unseen.score).toBe('uncalibrated (not embedded)');
    const judged = items.filter((entry: any) => entry.title !== 'Vector index rebuild follow-up');
    expect(judged.length).toBeGreaterThan(0);
    for (const item of judged) {
      expect(typeof item.score).toBe('number');
    }
  });
});
