import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeTranscriptDbs, openTranscriptDb } from '../../src/transcripts/database.js';
import { embedPendingMessages } from '../../src/transcripts/embed-pass.js';
import { runIndexPass } from '../../src/transcripts/index-pass.js';
import * as parse from '../../src/transcripts/parse.js';
import { encodeProjectDir } from '../../src/transcripts/paths.js';
import { fuseRankings, searchTranscripts } from '../../src/transcripts/search.js';
import type { KnowledgeEmbedder } from '../../src/store/vector-index.js';

// Counts streaming passes. See tests/transcripts/read.test.ts for why spying on
// node:fs.createReadStream cannot work here.
vi.mock('../../src/transcripts/parse.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/transcripts/parse.js')>();
  return { ...actual, streamProseFrom: vi.fn(actual.streamProseFrom) };
});

let dir: string;
let projectsDir: string;
let dbPath: string;
const PROJECT_ROOT = '/repo/knowl';
const ENCODED_ROOT = encodeProjectDir(path.resolve(PROJECT_ROOT));

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'knowl-sem-'));
  projectsDir = path.join(dir, 'projects');
  dbPath = path.join(dir, 'transcripts.db');
  await fs.mkdir(path.join(projectsDir, ENCODED_ROOT), { recursive: true });
});

afterEach(async () => {
  await closeTranscriptDbs();
  await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
});

const line = (role: 'user' | 'assistant', text: string) =>
  JSON.stringify({ type: role, timestamp: '2026-08-03T10:00:00Z', message: { content: text } }) + '\n';

/**
 * A deterministic stand-in for the real model: it maps a fixed vocabulary of *concepts* to
 * orthogonal directions, so "ran out of memory" and "OOM" embed identically while sharing no
 * word. That is precisely the retrieval the feature exists for.
 */
const CONCEPTS: Record<string, number> = { memory: 0, ordering: 1, network: 2 };
const CONCEPT_WORDS: Record<string, string> = {
  oom: 'memory', memory: 'memory', ram: 'memory', allocation: 'memory',
  sort: 'ordering', order: 'ordering', ordering: 'ordering', tiebreak: 'ordering',
  timeout: 'network', socket: 'network', network: 'network',
};

function conceptVector(text: string): number[] {
  const vector = new Array(8).fill(0);
  for (const word of text.toLowerCase().split(/\W+/)) {
    const concept = CONCEPT_WORDS[word];
    if (concept) vector[CONCEPTS[concept]] += 1;
  }
  const norm = Math.hypot(...vector) || 1;
  return vector.map(v => v / norm);
}

const stubEmbedder = (): KnowledgeEmbedder => ({
  provider: 'stub',
  model: 'concept',
  pooling: 'mean',
  profileFingerprint: 'stub:concept',
  embed: async (texts: string[]) => texts.map(conceptVector),
});

async function seed(session: string, lines: string) {
  await fs.writeFile(path.join(projectsDir, ENCODED_ROOT, `${session}.jsonl`), lines);
}

async function buildIndex(embedder?: KnowledgeEmbedder) {
  await runIndexPass({ projectRoot: PROJECT_ROOT, dbPath, projectsDir });
  const client = await openTranscriptDb(dbPath);
  if (embedder) await embedPendingMessages({ dbPath, embedder });
  return client;
}

describe('fuseRankings', () => {
  const hit = (id: number, score: number) => ({
    messageId: id, path: '/p', sessionId: 's', parentSessionId: null,
    line: id, role: 'user' as const, score,
  });

  it('ranks a message found by both lists above one found by either alone', () => {
    const lexical = [hit(1, 9), hit(2, 8)];
    const semantic = [hit(3, 9), hit(1, 8)];

    const fused = fuseRankings([lexical, semantic], 3);

    expect(fused[0].messageId).toBe(1);
  });

  it('keeps a message that only one ranking found', () => {
    const fused = fuseRankings([[hit(1, 9)], [hit(2, 9)]], 5);
    expect(fused.map(h => h.messageId).sort()).toEqual([1, 2]);
  });

  it('ignores an empty ranking', () => {
    const fused = fuseRankings([[hit(1, 9)], []], 5);
    expect(fused.map(h => h.messageId)).toEqual([1]);
  });

  it('respects the limit', () => {
    const many = Array.from({ length: 10 }, (_, i) => hit(i + 1, 10 - i));
    expect(fuseRankings([many], 4)).toHaveLength(4);
  });

  // Every rank-1 hit scores exactly 1/(60+1), so ties are the normal case in federation, not an
  // edge case. Without a deterministic tiebreak the merged order is insertion order and the
  // ranking that happened to be visited first always wins.
  it('breaks ties without regard to the order the rankings were supplied in', () => {
    const a = [hit(1, 9)];
    const b = [hit(2, 9)];
    const c = [hit(3, 9)];

    const forward = fuseRankings([a, b, c], 3).map(h => h.messageId);
    const reversed = fuseRankings([c, b, a], 3).map(h => h.messageId);

    expect(forward).toEqual(reversed);
  });
});

describe('searchTranscripts', () => {
  it('finds a message that shares no word with the query', async () => {
    await seed('a', line('user', 'the process ran out of memory during allocation'));
    await seed('b', line('user', 'a socket timeout on the network call'));
    const client = await buildIndex(stubEmbedder());

    const result = await searchTranscripts({
      client, query: 'OOM', limit: 5,
      embedder: stubEmbedder(), projectRoot: PROJECT_ROOT,
    });

    // "OOM" appears nowhere in the corpus, so BM25 alone returns nothing.
    expect(result.hits.length).toBeGreaterThan(0);
    expect(result.hits[0].sessionId).toBe('a');
  });

  it('still works lexically when no embedder is supplied', async () => {
    await seed('a', line('user', 'the reindex ran out of memory'));
    const client = await buildIndex();

    const result = await searchTranscripts({ client, query: 'reindex', limit: 5, projectRoot: PROJECT_ROOT });

    expect(result.hits).toHaveLength(1);
    expect(result.coverage.embedded).toBe(0);
  });

  it('degrades to lexical when the embedder throws', async () => {
    await seed('a', line('user', 'the reindex ran out of memory'));
    const client = await buildIndex(stubEmbedder());
    const broken: KnowledgeEmbedder = {
      ...stubEmbedder(),
      embed: async () => { throw new Error('model missing'); },
    };

    const result = await searchTranscripts({
      client, query: 'reindex', limit: 5, embedder: broken, projectRoot: PROJECT_ROOT,
    });

    expect(result.hits).toHaveLength(1);
  });

  it('reports coverage as embedded over indexed', async () => {
    await seed('a', line('user', 'first memory note') + line('user', 'second memory note'));
    const client = await buildIndex(stubEmbedder());

    const result = await searchTranscripts({
      client, query: 'memory', limit: 5, embedder: stubEmbedder(), projectRoot: PROJECT_ROOT,
    });

    expect(result.coverage).toEqual({ embedded: 2, indexed: 2 });
  });

  it('attaches the message text read back from the source file', async () => {
    await seed('a', line('user', 'the reindex ran out of memory'));
    const client = await buildIndex();

    const result = await searchTranscripts({ client, query: 'reindex', limit: 5, projectRoot: PROJECT_ROOT });

    expect(result.hits[0].text).toBe('the reindex ran out of memory');
  });

  // Rendering hits must group by file for the same reason the embedder does.
  it('reads each source file once when several hits share it', async () => {
    await seed('a', Array.from({ length: 6 }, (_, i) => line('user', `memory note ${i}`)).join(''));
    const client = await buildIndex();

    vi.mocked(parse.streamProseFrom).mockClear();
    const result = await searchTranscripts({ client, query: 'memory note', limit: 6, projectRoot: PROJECT_ROOT });

    expect(result.hits.length).toBeGreaterThan(1);
    expect(parse.streamProseFrom).toHaveBeenCalledTimes(1);
  });
});

describe('embedPendingMessages', () => {
  it('embeds only messages that have no vector yet', async () => {
    await seed('a', line('user', 'memory note'));
    await buildIndex(stubEmbedder());

    const second = await embedPendingMessages({ dbPath, embedder: stubEmbedder() });

    expect(second.embedded).toBe(0);
    expect(second.complete).toBe(true);
  });

  it('drops vectors belonging to a superseded model', async () => {
    await seed('a', line('user', 'memory note'));
    const client = await buildIndex(stubEmbedder());

    const other: KnowledgeEmbedder = { ...stubEmbedder(), profileFingerprint: 'stub:different' };
    await embedPendingMessages({ dbPath, embedder: other });

    const rows = (await client.execute('SELECT DISTINCT fingerprint FROM transcript_vectors')).rows;
    expect(rows.map(r => String(r.fingerprint))).toEqual(['stub:different']);
  });

  it('stops at a deadline and reports itself incomplete', async () => {
    await seed('a', Array.from({ length: 5 }, (_, i) => line('user', `memory note ${i}`)).join(''));
    await runIndexPass({ projectRoot: PROJECT_ROOT, dbPath, projectsDir });
    await openTranscriptDb(dbPath);

    const result = await embedPendingMessages({ dbPath, embedder: stubEmbedder(), deadline: Date.now() - 1 });

    expect(result.complete).toBe(false);
    expect(result.embedded).toBe(0);
  });

  // The regression test for the I/O blocker. Reading per message re-read the whole transcript
  // each time: ~11 GB for a real backfill, and a deadline that could not be honoured.
  it('reads each transcript once, not once per message', async () => {
    await seed('a', Array.from({ length: 120 }, (_, i) => line('user', `memory note ${i}`)).join(''));
    await seed('b', Array.from({ length: 120 }, (_, i) => line('user', `network note ${i}`)).join(''));
    await runIndexPass({ projectRoot: PROJECT_ROOT, dbPath, projectsDir });
    await openTranscriptDb(dbPath);

    vi.mocked(parse.streamProseFrom).mockClear();
    await embedPendingMessages({ dbPath, embedder: stubEmbedder() });

    // Two files, so two passes -- not 240.
    expect(vi.mocked(parse.streamProseFrom).mock.calls.length).toBeLessThanOrEqual(2);
  });

  it('embeds every message across several batches of the same file', async () => {
    await seed('a', Array.from({ length: 100 }, (_, i) => line('user', `memory note ${i}`)).join(''));
    await runIndexPass({ projectRoot: PROJECT_ROOT, dbPath, projectsDir });
    const client = await openTranscriptDb(dbPath);

    const result = await embedPendingMessages({ dbPath, embedder: stubEmbedder() });

    expect(result.embedded).toBe(100);
    expect(result.complete).toBe(true);
    const n = Number((await client.execute('SELECT COUNT(*) AS n FROM transcript_vectors')).rows[0].n);
    expect(n).toBe(100);
  });
});
