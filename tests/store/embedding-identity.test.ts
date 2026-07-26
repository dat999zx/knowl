import { describe, expect, it } from 'vitest';
import {
  embeddingIdentityFromConfig,
  sameEmbeddingIdentity,
  formatEmbeddingIdentity,
} from '../../src/store/embedding-identity.js';
import type { ProjectConfig } from '../../src/core/types.js';

const withVector = (overrides: Record<string, unknown> = {}): ProjectConfig => ({
  version: 1,
  search: { vector: { enabled: true, provider: 'local', model: 'Xenova/all-MiniLM-L6-v2', dtype: 'q8', ...overrides } },
} as unknown as ProjectConfig);

describe('embedding identity', () => {
  it('reads the provider, model and dtype triple from config', () => {
    expect(embeddingIdentityFromConfig(withVector())).toEqual({
      provider: 'local',
      model: 'Xenova/all-MiniLM-L6-v2',
      dtype: 'q8',
    });
  });

  it('is null when vector search is disabled', () => {
    expect(embeddingIdentityFromConfig(withVector({ enabled: false }))).toBeNull();
  });

  it('treats a different model as a different identity', () => {
    const a = embeddingIdentityFromConfig(withVector());
    const b = embeddingIdentityFromConfig(withVector({ model: 'Xenova/bge-small-en' }));
    expect(sameEmbeddingIdentity(a, b)).toBe(false);
  });

  it('treats a different dtype as a different identity, since it changes the vector', () => {
    const a = embeddingIdentityFromConfig(withVector());
    const b = embeddingIdentityFromConfig(withVector({ dtype: 'fp32' }));
    expect(sameEmbeddingIdentity(a, b)).toBe(false);
  });

  it('matches an identical triple', () => {
    expect(sameEmbeddingIdentity(embeddingIdentityFromConfig(withVector()), embeddingIdentityFromConfig(withVector()))).toBe(true);
  });

  it('treats two disabled configs as compatible, since neither writes vectors', () => {
    const off = embeddingIdentityFromConfig(withVector({ enabled: false }));
    expect(sameEmbeddingIdentity(off, off)).toBe(true);
  });

  it('treats enabled against disabled as incompatible', () => {
    expect(sameEmbeddingIdentity(embeddingIdentityFromConfig(withVector()), null)).toBe(false);
  });

  it('formats a null identity as a readable phrase rather than "null"', () => {
    expect(formatEmbeddingIdentity(null)).toBe('vector search disabled');
    expect(formatEmbeddingIdentity({ provider: 'local', model: 'm', dtype: 'q8' })).toBe('local/m (q8)');
  });
});
