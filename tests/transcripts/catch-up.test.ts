import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { catchUpTranscripts } from '../../src/transcripts/catch-up.js';
import { closeTranscriptDbs, openTranscriptDb } from '../../src/transcripts/database.js';
import { encodeProjectDir } from '../../src/transcripts/paths.js';
import type { KnowledgeEmbedder } from '../../src/store/vector-index.js';

/** Deterministic 8-dim stand-in; the real model is not needed to prove vectors were written. */
const stubEmbedder = (): KnowledgeEmbedder => ({
  provider: 'stub',
  model: 'stub',
  pooling: 'mean',
  profileFingerprint: 'stub:catchup',
  embed: async (texts: string[]) => texts.map(() => [1, 0, 0, 0, 0, 0, 0, 0]),
  embedQuery: async () => [1, 0, 0, 0, 0, 0, 0, 0],
});

let dir: string;
let projectsDir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'knowl-catchup-'));
  projectsDir = path.join(dir, 'projects');
  await fs.mkdir(path.join(dir, '.knowl'), { recursive: true });
});

afterEach(async () => {
  await closeTranscriptDbs();
  // Swallowed: Windows keeps the database locked for the life of the process.
  await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
});

async function writeConfig(enabled: boolean, options: { vector?: boolean } = {}) {
  await fs.writeFile(
    path.join(dir, '.knowl', 'config.json'),
    JSON.stringify({
      version: 1,
      security: { rejectSecrets: true, secretPatterns: [] },
      search: { transcripts: { enabled }, vector: { enabled: options.vector === true } },
    }),
  );
}

async function seed(turns = 1) {
  const encoded = encodeProjectDir(path.resolve(dir));
  await fs.mkdir(path.join(projectsDir, encoded), { recursive: true });
  await fs.writeFile(
    path.join(projectsDir, encoded, 'a.jsonl'),
    Array.from({ length: turns }, (_, i) =>
      JSON.stringify({ type: 'user', message: { content: `a turn happened ${i}` } })).join('\n') + '\n',
  );
}

async function appendTurn(text: string) {
  const encoded = encodeProjectDir(path.resolve(dir));
  await fs.appendFile(
    path.join(projectsDir, encoded, 'a.jsonl'),
    JSON.stringify({ type: 'user', message: { content: text } }) + '\n',
  );
}

describe('catchUpTranscripts', () => {
  it('returns null and creates nothing when disabled', async () => {
    await writeConfig(false);
    await seed();

    expect(await catchUpTranscripts(dir, { projectsDir })).toBeNull();
    await expect(fs.access(path.join(dir, '.knowl', 'transcripts.db'))).rejects.toThrow();
  });

  it('indexes new turns when enabled', async () => {
    await writeConfig(true);
    await seed();

    const result = await catchUpTranscripts(dir, { projectsDir });
    expect(result?.indexed).toBe(1);
  });

  // What the two tests below could not catch, because they inject a stub embedder that costs
  // nothing to construct. Production resolves a local ONNX model in a process that is fresh
  // every turn, the load ran inside the budget, and `embedPendingMessages` enforces the deadline
  // before doing any work -- so the real hook path embedded nothing at all. Measured on this
  // repo's own store: 12,598 indexed messages, 4 vectors.
  it('indexes without embedding when the caller says not to, and still indexes', async () => {
    await writeConfig(true, { vector: true });
    await seed();

    const embedder = stubEmbedder();
    const result = await catchUpTranscripts(dir, { projectsDir, embedder, embed: false, closeWhenDone: false });

    const client = await openTranscriptDb(path.join(dir, '.knowl', 'transcripts.db'));
    const indexed = Number((await client.execute('SELECT COUNT(*) AS n FROM transcript_messages')).rows[0].n);
    const embedded = Number((await client.execute('SELECT COUNT(*) AS n FROM transcript_vectors')).rows[0].n);

    expect(indexed).toBe(1);
    expect(embedded).toBe(0);
    expect(result?.embedded).toBe(0);
  });

  // The regression test for the blocker: catching up lexically but never embedding meant
  // coverage decayed from 100% with every new turn, with no signal that it had.
  it('embeds what it indexes, so coverage stays complete', async () => {
    await writeConfig(true, { vector: true });
    await seed();

    await catchUpTranscripts(dir, { projectsDir, embedder: stubEmbedder(), closeWhenDone: false });

    const client = await openTranscriptDb(path.join(dir, '.knowl', 'transcripts.db'));
    const indexed = Number((await client.execute('SELECT COUNT(*) AS n FROM transcript_messages')).rows[0].n);
    const embedded = Number((await client.execute('SELECT COUNT(*) AS n FROM transcript_vectors')).rows[0].n);

    expect(indexed).toBe(1);
    expect(embedded).toBe(indexed);
  });

  // Coverage must stay at 100% turn after turn, not just on the first pass.
  it('keeps coverage complete as turns accumulate', async () => {
    await writeConfig(true, { vector: true });
    await seed(2);

    for (const text of ['second turn', 'third turn']) {
      await catchUpTranscripts(dir, { projectsDir, embedder: stubEmbedder(), closeWhenDone: false });
      await appendTurn(text);
    }
    await catchUpTranscripts(dir, { projectsDir, embedder: stubEmbedder(), closeWhenDone: false });

    const client = await openTranscriptDb(path.join(dir, '.knowl', 'transcripts.db'));
    const indexed = Number((await client.execute('SELECT COUNT(*) AS n FROM transcript_messages')).rows[0].n);
    const embedded = Number((await client.execute('SELECT COUNT(*) AS n FROM transcript_vectors')).rows[0].n);

    expect(indexed).toBe(4);
    expect(embedded).toBe(indexed);
  });

  it('still indexes when vector search is off, and embeds nothing', async () => {
    await writeConfig(true, { vector: false });
    await seed();

    const result = await catchUpTranscripts(dir, { projectsDir });

    expect(result?.indexed).toBe(1);
    expect(result?.embedded).toBe(0);
  });

  it('returns null rather than throwing when the config is unreadable', async () => {
    await seed();
    expect(await catchUpTranscripts(dir, { projectsDir })).toBeNull();
  });

  it('never throws, whatever indexing does', async () => {
    await writeConfig(true);
    // No projects directory at all.
    await expect(catchUpTranscripts(dir, { projectsDir: path.join(dir, 'absent') })).resolves.not.toThrow();
  });

  // The hook budget is what keeps a turn from stalling behind an optional index.
  it('honours a tight budget instead of indexing the whole backlog', async () => {
    await writeConfig(true);
    await seed(4_000);

    const started = Date.now();
    const result = await catchUpTranscripts(dir, { projectsDir, budgetMs: 50 });
    const elapsed = Date.now() - started;

    expect(result).not.toBeNull();
    expect(result!.indexed).toBeLessThan(4_000);
    // Generous ceiling: the point is that it stopped rather than running to completion.
    expect(elapsed).toBeLessThan(5_000);
  }, 30_000);
});
