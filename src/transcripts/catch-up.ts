import { loadConfig } from '../core/config.js';
import { createLocalEmbeddingProvider, isVectorSearchEnabled } from '../ai/embeddings.js';
import { resolveStorage } from '../store/storage-roles.js';
import type { KnowledgeEmbedder } from '../store/vector-index.js';
import { isTranscriptSearchEnabled } from './config.js';
import { closeTranscriptDbs } from './database.js';
import { embedPendingMessages } from './embed-pass.js';
import { runIndexPass } from './index-pass.js';

/** How long a hook-driven pass may take. A hook that delays a turn is worse than a stale index. */
const DEFAULT_BUDGET_MS = 1_500;

/**
 * Bring the index up to date at the end of an agent turn -- both halves.
 *
 * Once per turn rather than once per message: transcripts are append-only, so catching up twenty
 * messages costs the same as catching up one, and a write every few seconds is exactly what
 * produced the SQLITE_BUSY failures this design separates databases to avoid.
 *
 * Indexing and embedding share the one deadline, indexing first: a lexical row is useful on its
 * own, an orphaned vector is not. Embedding what was just indexed is not optional -- skipping it
 * lets coverage decay from 100% with every new turn, silently invalidating the whole-corpus
 * claim that justifies ranking semantically at all.
 *
 * Returns null when the feature is off, and swallows every failure. This runs inside a lifecycle
 * hook; an optional index must never be the reason a turn errors.
 */
export async function catchUpTranscripts(
  projectRoot: string,
  options: {
    budgetMs?: number;
    projectsDir?: string;
    /** Injected by tests; production resolves it from config. */
    embedder?: KnowledgeEmbedder;
    /**
     * Whether to release connections afterwards. True for the hook, which is a short-lived
     * process; false for the search-time top-up, whose caller is about to query the very
     * connections this would close.
     */
    closeWhenDone?: boolean;
    /**
     * Whether to embed what was indexed. False for the lifecycle hook, and only for it.
     *
     * The hook is a fresh process per turn, so the embedding model is never warm and loading it
     * cost more than the entire budget -- measured at ~1.8s against a 1.5s budget, in a project
     * with nothing to index. The pass then found the deadline already gone and embedded nothing,
     * every turn, for months: this repo's own store held 12,598 indexed messages and 4 vectors.
     *
     * So the hook pays for the lexical half, which is cheap and needs no model, and the semantic
     * half happens where a model stays warm -- the long-lived `knowl serve` process, via the
     * search-time top-up -- or in bulk under a budget a human chose, via
     * `knowl reindex --transcripts`.
     */
    embed?: boolean;
  } = {},
): Promise<{ indexed: number; embedded: number } | null> {
  try {
    const config = await loadConfig(projectRoot);
    if (!isTranscriptSearchEnabled(config)) return null;

    const dbPath = resolveStorage(projectRoot).transcripts;
    const deadline = Date.now() + (options.budgetMs ?? DEFAULT_BUDGET_MS);

    const pass = await runIndexPass({
      projectRoot, dbPath, projectsDir: options.projectsDir, deadline,
    });

    let embedded = 0;
    if (options.embed !== false && isVectorSearchEnabled(config)) {
      try {
        // The budget bounds *work*, not setup. Loading the model was charged to it, so a caller
        // whose model was cold spent the whole budget on the load and then had nothing left to
        // embed with -- `embedPendingMessages` enforces the deadline before the work, so it
        // returned 0 rather than overrunning. Giving the load back keeps the budget meaning what
        // its name says and lets the first call in a warm-model process do real work.
        const loadStart = Date.now();
        const embedder = options.embedder ?? await createLocalEmbeddingProvider(config, projectRoot);
        const embedDeadline = deadline + (Date.now() - loadStart);
        embedded = (await embedPendingMessages({ dbPath, embedder, deadline: embedDeadline })).embedded;
      } catch {
        // No model on disk yet, or it failed to load. The lexical index still landed; the next
        // turn or an explicit reindex fills the vectors in.
      }
    }

    return { indexed: pass.indexed, embedded };
  } catch {
    return null;
  } finally {
    if (options.closeWhenDone !== false) await closeTranscriptDbs().catch(() => {});
  }
}
