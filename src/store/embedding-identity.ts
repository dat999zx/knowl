import type { ProjectConfig } from '../core/types.js';

/**
 * The triple that decides whether two sets of stored vectors are comparable.
 *
 * `searchKnowledgeEmbeddings` filters on provider and model because cosine similarity
 * between vectors of different dimensions is meaningless, and dtype belongs here for the
 * same reason: quantization changes the vector, so a q8 corpus and an fp32 corpus are not
 * one searchable space even under the same model name.
 */
export type EmbeddingIdentity = { provider: string; model: string; dtype: string };

/** Null means vector search is off, which is a valid state, not an error. */
export function embeddingIdentityFromConfig(config: ProjectConfig): EmbeddingIdentity | null {
  const vector = config?.search?.vector;
  if (!vector?.enabled) return null;
  return {
    provider: vector.provider ?? 'local',
    model: vector.model ?? '',
    dtype: vector.dtype ?? 'q8',
  };
}

export function sameEmbeddingIdentity(a: EmbeddingIdentity | null, b: EmbeddingIdentity | null): boolean {
  if (a === null && b === null) return true;
  if (a === null || b === null) return false;
  return a.provider === b.provider && a.model === b.model && a.dtype === b.dtype;
}

export function formatEmbeddingIdentity(identity: EmbeddingIdentity | null): string {
  return identity ? `${identity.provider}/${identity.model} (${identity.dtype})` : 'vector search disabled';
}
