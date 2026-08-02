import type { ProjectConfig } from '../core/types.js';
import { resolveVectorProfile } from '../core/vector-profile.js';

/**
 * What decides whether two sets of stored vectors are comparable.
 *
 * `searchKnowledgeEmbeddings` filters on the profile fingerprint, which is exactly these
 * four fields: quantization changes the vector, so a q8 corpus and an fp32 corpus are not
 * one searchable space even under the same model name, and pooling changes it just as much.
 */
export type EmbeddingIdentity = {
  provider: string;
  model: string;
  dtype: string;
  /** `unknown` comes from a pre-pooling manifest and never compares equal to anything. */
  pooling: 'mean' | 'cls' | 'unknown';
};

/** Null means vector search is off, which is a valid state, not an error. */
export function embeddingIdentityFromConfig(config: ProjectConfig): EmbeddingIdentity | null {
  if (!config?.search?.vector?.enabled) return null;
  // Resolved, not raw: a preset-only config has no `model` key, and reading it
  // directly yielded '' -- which made two different models compare as equal.
  const profile = resolveVectorProfile(config);
  return {
    provider: profile.provider,
    model: profile.model,
    dtype: profile.dtype,
    pooling: profile.pooling,
  };
}

export function sameEmbeddingIdentity(a: EmbeddingIdentity | null, b: EmbeddingIdentity | null): boolean {
  if (a === null && b === null) return true;
  if (a === null || b === null) return false;
  // `unknown` is not a wildcard. Letting it match anything would allow two repos
  // with genuinely incompatible pooling to federate and mis-rank each other.
  if (a.pooling === 'unknown' || b.pooling === 'unknown') return false;
  return a.provider === b.provider && a.model === b.model
    && a.dtype === b.dtype && a.pooling === b.pooling;
}

export function formatEmbeddingIdentity(identity: EmbeddingIdentity | null): string {
  return identity
    ? `${identity.provider}/${identity.model} (${identity.dtype}, ${identity.pooling} pooling)`
    : 'vector search disabled';
}
