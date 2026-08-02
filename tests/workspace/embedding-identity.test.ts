import { describe, expect, it } from 'vitest';
import { embeddingIdentityFromConfig, sameEmbeddingIdentity } from '../../src/store/embedding-identity.js';
import { migrateLegacyManifestPooling } from '../../src/workspace/membership.js';
import type { ProjectConfig } from '../../src/core/types.js';

const cfg = (vector: Record<string, unknown>) =>
  ({ version: 1, search: { vector: { enabled: true, ...vector } } }) as unknown as ProjectConfig;

describe('embeddingIdentityFromConfig', () => {
  it('resolves a preset-only config to its real model, not an empty string', () => {
    const identity = embeddingIdentityFromConfig(cfg({ preset: 'bge-small-en' }));
    expect(identity?.model).toBe('Xenova/bge-small-en-v1.5');
    expect(identity?.pooling).toBe('cls');
  });

  it('treats a preset and the same model spelled out as compatible', () => {
    const viaPreset = embeddingIdentityFromConfig(cfg({ preset: 'minilm-l6-en' }));
    const viaModel = embeddingIdentityFromConfig(cfg({ model: 'Xenova/all-MiniLM-L6-v2', dtype: 'q8' }));
    expect(sameEmbeddingIdentity(viaPreset, viaModel)).toBe(true);
  });
});

describe('migrateLegacyManifestPooling', () => {
  it('derives pooling for a manifest pinned to a built-in model', () => {
    const migrated = migrateLegacyManifestPooling({
      embedding: { provider: 'local', model: 'Xenova/all-MiniLM-L6-v2', dtype: 'q8' },
    } as any);
    expect(migrated.embedding!.pooling).toBe('mean');
  });

  it('records unknown for an unrecognised model rather than guessing', () => {
    const migrated = migrateLegacyManifestPooling({
      embedding: { provider: 'local', model: 'someone/mystery', dtype: 'q8' },
    } as any);
    expect(migrated.embedding!.pooling).toBe('unknown');
  });

  it('leaves a manifest with no embedding alone', () => {
    const manifest = { embedding: null } as any;
    expect(migrateLegacyManifestPooling(manifest)).toBe(manifest);
  });

  it('never reports an unknown-pooling manifest as compatible', () => {
    const unknown = { provider: 'local', model: 'someone/mystery', dtype: 'q8', pooling: 'unknown' } as const;
    const known = { provider: 'local', model: 'someone/mystery', dtype: 'q8', pooling: 'cls' } as const;
    expect(sameEmbeddingIdentity(unknown, known)).toBe(false);
  });
});
