import { loadConfig } from '../core/config.js';
import { createLocalEmbeddingProvider, isVectorSearchEnabled } from '../ai/embeddings.js';
import { resolveStorage } from '../store/storage-roles.js';
import { isTranscriptSearchEnabled } from './config.js';
import { embedPendingMessages } from './embed-pass.js';
import { runIndexPass } from './index-pass.js';

export type BackfillResult = {
  indexed: number;
  embedded: number;
  removed: number;
  complete: boolean;
  /** Human-readable reason the semantic half did not run, or null when it did. */
  skippedEmbedding: string | null;
};

/**
 * Index every transcript, then embed everything still lacking a vector.
 *
 * Both halves are resumable, so `--budget` is a real stopping point rather than a rollback: what
 * finished stays, and the next run picks up from the watermark.
 */
export async function rebuildTranscriptIndex(
  projectRoot: string,
  options: { budgetMinutes?: number; projectsDir?: string } = {},
): Promise<BackfillResult> {
  const config = await loadConfig(projectRoot);
  if (!isTranscriptSearchEnabled(config)) {
    throw new Error(
      'Transcript search is not enabled for this repository. Set search.transcripts.enabled to true first (knowl config).',
    );
  }

  const deadline = options.budgetMinutes !== undefined
    ? Date.now() + options.budgetMinutes * 60_000
    : undefined;

  const dbPath = resolveStorage(projectRoot).transcripts;
  const pass = await runIndexPass({ projectRoot, dbPath, projectsDir: options.projectsDir, deadline });

  // Semantic ranking follows search.vector.enabled rather than inheriting from the transcript
  // flag. The model, dtype and pooling all come from search.vector.preset, so embedding here
  // while that says vector search is off would be one flag denying what another is doing.
  if (!isVectorSearchEnabled(config)) {
    return {
      indexed: pass.indexed,
      embedded: 0,
      removed: pass.removed,
      complete: pass.complete,
      skippedEmbedding: 'Vector search is off, so results will be keyword-only. Enable search.vector.enabled for semantic search.',
    };
  }

  let embedded = 0;
  let complete = pass.complete;
  let skippedEmbedding: string | null = null;
  try {
    const embedder = await createLocalEmbeddingProvider(config, projectRoot);
    const result = await embedPendingMessages({ dbPath, embedder, deadline });
    embedded = result.embedded;
    complete = complete && result.complete;
  } catch (error) {
    // A missing model must not throw away a completed lexical index.
    skippedEmbedding = `Embedding skipped: ${(error as Error).message}`;
    complete = false;
  }

  return { indexed: pass.indexed, embedded, removed: pass.removed, complete, skippedEmbedding };
}
