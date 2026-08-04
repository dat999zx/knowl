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
  embedQuery: async (text: string) => conceptVector(text),
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
      embedQuery: async () => { throw new Error('model missing'); },
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

  // K-32. Coverage answered "how much of what is indexed has vectors" and never "how much of
  // the archive is indexed at all". A pass cut short by its deadline leaves whole sessions with
  // no row anywhere, and every number the search reports is computed over the rows that do
  // exist -- so an index missing half the archive reports 100%.
  it('reports that indexing itself is incomplete, not just embedding', async () => {
    await seed('a', line('user', 'first memory note'));
    await runIndexPass({ projectRoot: PROJECT_ROOT, dbPath, projectsDir });

    await seed('b', line('user', 'second memory note'));
    // Stops before reaching anything: session b never gets a row.
    await runIndexPass({ projectRoot: PROJECT_ROOT, dbPath, projectsDir, deadline: Date.now() - 1 });

    const client = await openTranscriptDb(dbPath);
    const result = await searchTranscripts({ client, query: 'memory', limit: 5, projectRoot: PROJECT_ROOT });

    expect(result.coverage.indexed).toBe(1); // the rows that exist all look complete
    expect(result.indexComplete).toBe(false);
  });

  it('reports indexing complete once the pass has caught up', async () => {
    await seed('a', line('user', 'first memory note'));
    const client = await buildIndex();

    const result = await searchTranscripts({ client, query: 'memory', limit: 5, projectRoot: PROJECT_ROOT });

    expect(result.indexComplete).toBe(true);
  });

  it('attaches the message text read back from the source file', async () => {
    await seed('a', line('user', 'the reindex ran out of memory'));
    const client = await buildIndex();

    const result = await searchTranscripts({ client, query: 'reindex', limit: 5, projectRoot: PROJECT_ROOT });

    expect(result.hits[0].text).toBe('the reindex ran out of memory');
  });

  // K-47. Rendering a hit used to stream its transcript from byte 0 -- measured at 224 ms and
  // 16.1 MB of I/O to produce a ~400-byte message. The indexer already knew the byte offset of
  // every line it wrote; it just threw it away. What matters is bytes read, not passes taken:
  // seeking to each of six hits reads six small windows, where one pass from zero reads
  // everything up to the last of them.
  it('reads a hit by seeking to its recorded offset rather than from the start of the file', async () => {
    const filler = Array.from({ length: 400 }, (_, i) => line('user', `filler note ${i}`)).join('');
    await seed('a', filler + line('user', 'the distinctive memory marker'));
    const client = await buildIndex();

    const offset = Number((await client.execute(
      "SELECT byte_offset FROM transcript_messages WHERE line = 401",
    )).rows[0].byte_offset);
    expect(offset).toBeGreaterThan(filler.length - 1);

    vi.mocked(parse.streamProseFrom).mockClear();
    const result = await searchTranscripts({
      client, query: 'distinctive marker', limit: 1, projectRoot: PROJECT_ROOT,
    });

    expect(result.hits[0].text).toBe('the distinctive memory marker');
    const starts = vi.mocked(parse.streamProseFrom).mock.calls.map(call => call[1]);
    expect(starts).toEqual([offset]);
  });

  it('reads several hits in one file by seeking to each, never past the last of them', async () => {
    await seed('a', Array.from({ length: 6 }, (_, i) => line('user', `memory note ${i}`)).join(''));
    const client = await buildIndex();

    vi.mocked(parse.streamProseFrom).mockClear();
    const result = await searchTranscripts({ client, query: 'memory note', limit: 6, projectRoot: PROJECT_ROOT });

    expect(result.hits.length).toBeGreaterThan(1);
    expect(result.hits.every(hit => typeof hit.text === 'string')).toBe(true);

    // Every read started exactly at the offset of the message it was fetching -- one window per
    // hit, not one walk over everything up to the last one.
    const offsets = (await client.execute('SELECT line, byte_offset FROM transcript_messages'));
    const byLine = new Map(offsets.rows.map(row => [Number(row.line), Number(row.byte_offset)]));
    const starts = vi.mocked(parse.streamProseFrom).mock.calls.map(call => call[1]).sort((a, b) => a - b);
    const wanted = result.hits.map(hit => byLine.get(hit.line)!).sort((a, b) => a - b);
    expect(starts).toEqual(wanted);
  });

  // An index built before offsets were recorded has null in that column, and its pointers still
  // have to resolve -- by the streaming scan that was there before.
  it('falls back to a streaming read when the row has no offset', async () => {
    await seed('a', line('user', 'first memory note') + line('user', 'second memory note'));
    const client = await buildIndex();
    await client.execute('UPDATE transcript_messages SET byte_offset = NULL');

    const result = await searchTranscripts({ client, query: 'second', limit: 1, projectRoot: PROJECT_ROOT });

    expect(result.hits[0].text).toBe('second memory note');
  });

  // A stale offset must not render the wrong message: the indexed length is checked against
  // what the offset actually produces, and a mismatch falls back to the scan.
  it('refuses a byte offset that no longer points at the message it indexed', async () => {
    await seed('a', line('user', 'first memory note') + line('user', 'second memory note here'));
    const client = await buildIndex();
    await client.execute('UPDATE transcript_messages SET byte_offset = 0 WHERE line = 2');

    const result = await searchTranscripts({ client, query: 'second', limit: 1, projectRoot: PROJECT_ROOT });

    expect(result.hits[0].text).toBe('second memory note here');
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

  // K-65. The hook budget is 1,500 ms and the deadline was only ever checked *between* batches,
  // while a batch is 32 messages of any length. One real 8,000-character message costs 7,843 ms
  // in a single forward pass on this machine, so one batch could hold minutes of work and the
  // budget could not refuse it. Enforcement has to happen before the call, on what it will cost.
  it('does not start an embedding batch it cannot afford', async () => {
    const long = 'memory '.repeat(570); // ~4,000 characters, three of them
    await seed('a', Array.from({ length: 3 }, () => line('user', long)).join(''));
    await runIndexPass({ projectRoot: PROJECT_ROOT, dbPath, projectsDir });
    await openTranscriptDb(dbPath);

    // Two milliseconds per character is a slow model, not an absurd one -- the measured local
    // model is about one. Three of these in one batch is ~24 seconds against a 300 ms budget.
    const slow: KnowledgeEmbedder = {
      ...stubEmbedder(),
      embed: async (texts: string[]) => {
        const chars = texts.reduce((total, text) => total + text.length, 0);
        await new Promise(resolve => setTimeout(resolve, chars / 2));
        return texts.map(conceptVector);
      },
    };

    const started = Date.now();
    const result = await embedPendingMessages({ dbPath, embedder: slow, deadline: Date.now() + 300 });
    const elapsed = Date.now() - started;

    expect(result.embedded).toBe(0);
    expect(result.complete).toBe(false);
    // Generous, because the point is that it declined to start rather than that it was quick.
    expect(elapsed).toBeLessThan(2_000);
  }, 60_000);

  it('still embeds what does fit in the budget', async () => {
    await seed('a', Array.from({ length: 10 }, (_, i) => line('user', `memory note ${i}`)).join(''));
    await runIndexPass({ projectRoot: PROJECT_ROOT, dbPath, projectsDir });
    await openTranscriptDb(dbPath);

    const result = await embedPendingMessages({
      dbPath, embedder: stubEmbedder(), deadline: Date.now() + 5_000,
    });

    expect(result.embedded).toBe(10);
    expect(result.complete).toBe(true);
  });

  // The backfill has minutes, not milliseconds. Nothing is refused there.
  it('embeds a long message when there is no deadline to overrun', async () => {
    await seed('a', line('user', 'memory '.repeat(570)));
    await runIndexPass({ projectRoot: PROJECT_ROOT, dbPath, projectsDir });
    await openTranscriptDb(dbPath);

    const result = await embedPendingMessages({ dbPath, embedder: stubEmbedder() });

    expect(result.embedded).toBe(1);
    expect(result.complete).toBe(true);
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
