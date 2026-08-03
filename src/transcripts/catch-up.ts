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
    if (isVectorSearchEnabled(config)) {
      try {
        const embedder = options.embedder ?? await createLocalEmbeddingProvider(config, projectRoot);
        embedded = (await embedPendingMessages({ dbPath, embedder, deadline })).embedded;
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
