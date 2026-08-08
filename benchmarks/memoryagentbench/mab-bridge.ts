// Bridge letting MemoryAgentBench's Python harness drive Knowl as a memory method.
//
// Not wired into src/index.ts, for the same reason as cli.ts: research tooling must not ship in
// the published package or be able to break the product build.
//
// Protocol: newline-delimited JSON on stdin, newline-delimited JSON on stdout. Every response
// line is prefixed with a sentinel because the embedding provider and SQLite bindings are free to
// write to stdout whenever they like -- an unframed protocol would eventually eat a stray log
// line and desynchronise mid-run, which is the kind of failure that shows up as a plausible score
// rather than an error.
//
// Ingestion is deferred until `flush` rather than done per chunk. The titling rule derives each
// fact's subject+relation by shared-prefix discovery across the WHOLE fact list, so it cannot run
// until the stream is complete. This also keeps MAB's `memory_construction_time` honest: without
// an explicit flush the harness reports ~0.01s and buries the real ingest cost inside the latency
// of question 1.

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { loadConfig, findProjectRoot } from '../../src/core/config.js';
import { resolveVectorProfile } from '../../src/core/vector-profile.js';
import { createLocalEmbeddingProvider, isVectorSearchEnabled } from '../../src/ai/embeddings.js';
import { closeDb, initDb } from '../../src/store/database.js';
import * as repo from '../../src/store/repository.js';
import { storeKnowledgeItemDeduped } from '../../src/store/knowledge-writer.js';
import { queryKnowledgeForAgent } from '../../src/store/agent-query.js';
import { queryKnowledgeBase } from '../../src/store/queries.js';
import { reindexKnowledgeEmbeddings } from '../../src/store/vector-index.js';
import { factsFromChunks } from './facts.js';

const SENTINEL = '@@KNOWL@@';

// Same reasoning as runner.ts: benchmark facts are public trivia, the secret detector fires on
// ordinary proper nouns, and a rejected write would silently remove a candidate from the index.
const BENCHMARK_VALIDATION = { rejectSecrets: false, maxFieldLength: 100_000 };

type Session = {
  storeRoot: string;
  projectId: string;
  embedder: Awaited<ReturnType<typeof createLocalEmbeddingProvider>> | null;
  supersede: boolean;
  chunks: string[];
  flushed: boolean;
  facts: number;
  supersededAtWrite: number;
  activeAfterIngest: number;
};

let session: Session | null = null;

function respond(payload: unknown): void {
  process.stdout.write(`${SENTINEL} ${JSON.stringify(payload)}\n`);
}

function log(message: string): void {
  process.stderr.write(`[knowl-bridge] ${message}\n`);
}

async function init(options: { supersede?: boolean; vector?: boolean }): Promise<void> {
  await close();

  const vector = options.vector !== false;
  let embedder: Session['embedder'] = null;
  if (vector) {
    const projectRoot = await findProjectRoot(process.cwd());
    const config = await loadConfig(projectRoot);
    if (!isVectorSearchEnabled(config)) {
      throw new Error('Vector search is not enabled. Set search.vector.enabled true, or pass vector:false.');
    }
    log(`embedding profile ${JSON.stringify(resolveVectorProfile(config))}`);
    embedder = await createLocalEmbeddingProvider(config, projectRoot);
  }

  const storeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'knowl-mab-'));
  await fs.mkdir(path.join(storeRoot, '.knowl'), { recursive: true });
  await initDb(storeRoot);
  const project = await repo.createProject(storeRoot, 'MemoryAgentBench');

  session = {
    storeRoot,
    projectId: project.id,
    embedder,
    supersede: options.supersede !== false,
    chunks: [],
    flushed: false,
    facts: 0,
    supersededAtWrite: 0,
    activeAfterIngest: 0,
  };
  log(`init supersede=${session.supersede} vector=${vector}`);
}

function requireSession(): Session {
  if (!session) throw new Error('No session. Send {"op":"init"} first.');
  return session;
}

/**
 * Parse the buffered stream and write every fact.
 *
 * Idempotent: MAB's construction-time stamp and the first query both reach for it, and ingesting
 * an 18k-fact corpus twice would double the corpus and quietly destroy the measurement.
 */
async function flush(): Promise<Record<string, number>> {
  const current = requireSession();
  if (current.flushed) {
    return {
      facts: current.facts,
      supersededAtWrite: current.supersededAtWrite,
      activeAfterIngest: current.activeAfterIngest,
    };
  }

  const facts = factsFromChunks(current.chunks);
  log(`flush: ${current.chunks.length} chunks -> ${facts.length} facts`);

  // Context order is the only recency signal. Nothing tells the store which fact is an update --
  // that is the whole point of the track.
  for (const fact of facts) {
    if (!current.supersede) {
      await repo.createKnowledgeItem(
        current.projectId,
        { category: 'fact', title: fact.key, content: fact.text },
        undefined,
        undefined,
        BENCHMARK_VALIDATION,
      );
      continue;
    }
    const result = await storeKnowledgeItemDeduped(
      current.projectId,
      { category: 'fact', title: fact.key, content: fact.text },
      undefined,
      BENCHMARK_VALIDATION,
    );
    if (result.superseded) current.supersededAtWrite++;
  }

  if (current.embedder) await reindexKnowledgeEmbeddings(current.projectId, current.embedder);

  current.facts = facts.length;
  current.activeAfterIngest = (
    await queryKnowledgeBase(current.projectId, { status: 'active', limit: 1_000_000 })
  ).length;
  current.flushed = true;

  log(
    `flush done: ${current.facts} facts, ${current.supersededAtWrite} superseded at write, ` +
      `${current.activeAfterIngest} active`,
  );
  return {
    facts: current.facts,
    supersededAtWrite: current.supersededAtWrite,
    activeAfterIngest: current.activeAfterIngest,
  };
}

async function query(text: string, k: number): Promise<string[]> {
  const current = requireSession();
  await flush();

  const vector = current.embedder
    ? {
        enabled: true,
        profileFingerprint: current.embedder.profileFingerprint,
        embedding: (await current.embedder.embed([text]))[0],
      }
    : undefined;

  const items = await queryKnowledgeForAgent(current.projectId, {
    query: text,
    status: 'active',
    surface: 'bench_mab_bridge',
    limit: k,
    vector,
  });
  return items.map(item => item.content);
}

async function close(): Promise<void> {
  if (!session) return;
  const { storeRoot } = session;
  session = null;
  await closeDb();
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      await fs.rm(storeRoot, { recursive: true, force: true });
      return;
    } catch {
      await new Promise(resolve => setTimeout(resolve, 50 * (attempt + 1)));
    }
  }
}

async function handle(command: any): Promise<unknown> {
  switch (command.op) {
    case 'init':
      await init(command);
      return { ok: true };
    case 'add':
      requireSession().chunks.push(String(command.text ?? ''));
      return { ok: true };
    case 'flush':
      return { ok: true, ...(await flush()) };
    case 'query':
      return { ok: true, contents: await query(String(command.text ?? ''), Number(command.k ?? 10)) };
    case 'stats': {
      const current = requireSession();
      return {
        ok: true,
        facts: current.facts,
        supersededAtWrite: current.supersededAtWrite,
        activeAfterIngest: current.activeAfterIngest,
      };
    }
    case 'close':
      await close();
      return { ok: true };
    default:
      throw new Error(`Unknown op: ${command.op}`);
  }
}

const rl = readline.createInterface({ input: process.stdin });

// Commands are processed strictly in order. Overlapping an `add` with a `flush` would reorder the
// corpus, and recency is the only thing under test here.
let pending: Promise<void> = Promise.resolve();

rl.on('line', line => {
  const trimmed = line.trim();
  if (!trimmed) return;
  pending = pending.then(async () => {
    try {
      respond(await handle(JSON.parse(trimmed)));
    } catch (error: any) {
      log(`error: ${error?.stack ?? error?.message ?? error}`);
      respond({ ok: false, error: String(error?.message ?? error) });
    }
  });
});

rl.on('close', () => {
  pending = pending.then(close);
});
