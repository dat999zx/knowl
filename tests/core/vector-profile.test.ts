import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PRESET_ID, VECTOR_PRESETS, fingerprintProfile, resolveVectorProfile,
} from '../../src/core/vector-profile.js';
import type { ProjectConfig } from '../../src/core/types.js';

function config(vector: Record<string, unknown>): ProjectConfig {
  return { version: 1, search: { vector: { enabled: true, ...vector } } } as unknown as ProjectConfig;
}

describe('resolveVectorProfile', () => {
  it('defaults new projects to the English Granite preset', () => {
    expect(DEFAULT_PRESET_ID).toBe('granite-small-en-r2');
  });

  it('returns the bundle for a named preset, ignoring stray flat keys', () => {
    const profile = resolveVectorProfile(config({
      preset: 'granite-97m-multilingual',
      model: 'Xenova/all-MiniLM-L6-v2',
      dtype: 'fp32',
    }));
    expect(profile).toEqual({
      provider: 'local',
      model: 'onnx-community/granite-embedding-97m-multilingual-r2-ONNX',
      dtype: 'q8',
      pooling: 'cls',
    });
  });

  it('uses flat keys when the preset is custom', () => {
    const profile = resolveVectorProfile(config({
      preset: 'custom',
      model: 'someone/their-model-ONNX',
      dtype: 'q4',
      pooling: 'cls',
    }));
    expect(profile).toEqual({
      provider: 'local',
      model: 'someone/their-model-ONNX',
      dtype: 'q4',
      pooling: 'cls',
    });
  });

  it('matches a pre-change config by model string so existing repos keep mean pooling', () => {
    const profile = resolveVectorProfile(config({
      model: 'Xenova/all-MiniLM-L6-v2',
      dtype: 'q8',
    }));
    expect(profile).toEqual({
      provider: 'local',
      model: 'Xenova/all-MiniLM-L6-v2',
      dtype: 'q8',
      pooling: 'mean',
    });
  });

  it('treats an unrecognised model with no preset as custom with mean pooling', () => {
    const profile = resolveVectorProfile(config({ model: 'someone/unknown', dtype: 'q8' }));
    expect(profile.model).toBe('someone/unknown');
    expect(profile.pooling).toBe('mean');
  });

  it('gives every built-in preset 384 dimensions worth of shared shape', () => {
    for (const preset of Object.values(VECTOR_PRESETS)) {
      expect(preset.provider).toBe('local');
      expect(preset.dtype).toBe('q8');
      expect(['mean', 'cls']).toContain(preset.pooling);
    }
  });
});

describe('fingerprintProfile', () => {
  it('is stable for the same profile', () => {
    const profile = { provider: 'local', model: 'a/b', dtype: 'q8', pooling: 'cls' } as const;
    expect(fingerprintProfile(profile)).toBe(fingerprintProfile({ ...profile }));
  });

  it('changes when dtype alone changes', () => {
    const base = { provider: 'local', model: 'a/b', dtype: 'q8', pooling: 'cls' } as const;
    expect(fingerprintProfile(base)).not.toBe(fingerprintProfile({ ...base, dtype: 'fp32' }));
  });

  it('changes when pooling alone changes', () => {
    const base = { provider: 'local', model: 'a/b', dtype: 'q8', pooling: 'cls' } as const;
    expect(fingerprintProfile(base)).not.toBe(fingerprintProfile({ ...base, pooling: 'mean' }));
  });
});
