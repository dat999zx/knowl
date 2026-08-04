import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { planEmbeddingBatches } from '../../src/ai/embeddings.js';
import { closeTranscriptDbs, openTranscriptDb } from '../../src/transcripts/database.js';
import { embedPendingMessages } from '../../src/transcripts/embed-pass.js';
import { runIndexPass } from '../../src/transcripts/index-pass.js';
import { encodeProjectDir } from '../../src/transcripts/paths.js';
import type { EmbedOptions, KnowledgeEmbedder } from '../../src/store/vector-index.js';

/**
 * A message's vector must not depend on how busy the machine was when it was embedded.
 *
 * The q8 graph quantises activations per FORWARD PASS -- `model_quantized.onnx` for
 * arctic-embed-m-v2 holds 48 `DynamicQuantizeLinear` nodes, and the ONNX operator computes one
 * scalar scale from `max(x)`/`min(x)` over the whole tensor, batch dimension included. So a
 * text's vector moves depending on which other texts share its pass. Measured on 300 real
 * transcript messages: a quiet pass and a busy one disagree by up to 3.99e-2 cosine.
 *
 * `embedPendingMessages` used to choose batch composition from the remaining deadline budget,
 * which meant a catch-up hook and a `knowl reindex --transcripts` produced different vectors for
 * the same message, and so did two catch-up hooks on differently-loaded machines.
 *
 * These tests pin the PLAN -- which texts share a forward pass -- rather than any wall clock.
 * The budget is exercised with `Date` frozen, so a slow machine cannot change what they assert.
 */

let dir: string;
let projectsDir: string;
const PROJECT_ROOT = '/repo/knowl';
const ENCODED_ROOT = encodeProjectDir(path.resolve(PROJECT_ROOT));

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'knowl-embed-det-'));
  projectsDir = path.join(dir, 'projects');
  await fs.mkdir(path.join(projectsDir, ENCODED_ROOT), { recursive: true });
});

afterEach(async () => {
  vi.useRealTimers();
  await closeTranscriptDbs();
  await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
});

/**
 * Short enough that the token budget lets 32 share a pass, so batching is live rather than
 * a formality -- transcript messages are short, which is the whole reason this path batched.
 */
const MESSAGES = 80;
const body = (n: number) => `message ${String(n).padStart(3, '0')} about indexing and vectors`;

async function seed() {
  const lines = Array.from({ length: MESSAGES }, (_, i) =>
    JSON.stringify({
      type: i % 2 === 0 ? 'user' : 'assistant',
      timestamp: '2026-08-03T10:00:00Z',
      message: { content: body(i) },
    }) + '\n').join('');
  await fs.writeFile(path.join(projectsDir, ENCODED_ROOT, 'session.jsonl'), lines);
}

/**
 * Records the forward passes the real provider would make.
 *
 * `createLocalEmbeddingProvider` runs exactly one pipeline call per `planEmbeddingBatches`
 * group, so planning with the same inputs here reproduces the real grouping -- including how it
 * responds to `maxBatch`.
 *
 * The vector is deliberately a function of the whole PASS, not of the text alone. That is what
 * the q8 graph does, and a stub that ignores it could not tell a fixed vector from a floating
 * one.
 */
function recordingEmbedder(passes: string[][]): KnowledgeEmbedder {
  return {
    provider: 'stub',
    model: 'recording',
    pooling: 'mean',
    profileFingerprint: 'stub:recording',
    embed: async (texts: string[], options?: EmbedOptions) => {
      const vectors: number[][] = [];
      for (const batch of planEmbeddingBatches(texts, options)) {
        passes.push(batch.map(entry => entry.text));
        // Stands in for the per-batch activation scale: every member of a pass is scaled by a
        // property of the pass as a whole.
        const companions = batch.length;
        for (const entry of batch) {
          const seed = entry.text.length % 7;
          vectors[entry.index] = [seed / 10, companions / 100, 1];
        }
      }
      return vectors;
    },
    embedQuery: async () => [0, 0, 1],
  };
}

/** Order-insensitive: what matters is which texts shared a pass, not which pass came first. */
function normalise(passes: string[][]): string[] {
  return passes.map(pass => [...pass].sort().join('|')).sort();
}

/** One archive, a store of its own per run, so the two runs see identical input. */
async function embedWith(store: string, deadline?: number): Promise<{ passes: string[][]; dbPath: string }> {
  const dbPath = path.join(dir, `${store}.db`);
  await runIndexPass({ projectRoot: PROJECT_ROOT, dbPath, projectsDir });
  const passes: string[][] = [];
  await embedPendingMessages({ dbPath, embedder: recordingEmbedder(passes), deadline });
  return { passes, dbPath };
}

async function storedVectors(dbPath: string): Promise<Map<number, string>> {
  const client = await openTranscriptDb(dbPath);
  const rows = (await client.execute(
    'SELECT message_id, scale, vec FROM transcript_vectors ORDER BY message_id',
  )).rows;
  return new Map(rows.map(row => [
    Number(row.message_id),
    `${row.scale}:${Buffer.from(row.vec as ArrayBuffer).toString('hex')}`,
  ]));
}

describe('transcript embedding is reproducible across passes', () => {
  it('groups the same messages into the same forward pass whatever budget is left', async () => {
    await seed();

    // The unbudgeted `knowl reindex --transcripts`: nothing is ever refused, so the slice is
    // always the full 32.
    const quiet = await embedWith('quiet');

    // A catch-up hook with very little left. `Date` is frozen so the budget neither shrinks nor
    // expires and `charsPerMs` never relearns: the pass runs to completion with a small, stable
    // slice, and nothing here depends on how fast the machine is.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(0);
    const busy = await embedWith('busy', 200);
    vi.useRealTimers();

    // Guard the fixture: if the two budgets stopped producing different SLICES the assertion
    // below would pass for the wrong reason.
    expect(quiet.passes.length).toBeGreaterThan(0);
    expect(busy.passes.length).toBeGreaterThan(0);

    expect(normalise(busy.passes)).toEqual(normalise(quiet.passes));
  });

  it('stores the same vector for a message whether the pass was busy or quiet', async () => {
    await seed();

    const quiet = await embedWith('quiet');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(0);
    const busy = await embedWith('busy', 200);
    vi.useRealTimers();

    const quietVectors = await storedVectors(quiet.dbPath);
    const busyVectors = await storedVectors(busy.dbPath);

    expect(quietVectors.size).toBe(MESSAGES);
    expect([...busyVectors.values()]).toEqual([...quietVectors.values()]);
  });

  it('still embeds every message the archive holds', async () => {
    await seed();
    const { dbPath } = await embedWith('quiet');
    const client = await openTranscriptDb(dbPath);
    const count = Number((await client.execute('SELECT COUNT(*) AS n FROM transcript_vectors')).rows[0].n);
    expect(count).toBe(MESSAGES);
  });
});
