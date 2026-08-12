import { readFile } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_PRESET_ID, PRESET_IDS, VECTOR_PRESETS, fingerprintProfile, resolveVectorProfile,
} from '../../src/core/vector-profile.js';
import type { ProjectConfig } from '../../src/core/types.js';

function config(vector: Record<string, unknown>): ProjectConfig {
  return { version: 1, search: { vector: { enabled: true, ...vector } } } as unknown as ProjectConfig;
}

describe('resolveVectorProfile', () => {
  // The cheaper side of the trade, not the most accurate entry: 52 MB and 384 dimensions
  // against arctic's 305 MB and 768. Arctic stays in the table and is one `preset` key away.
  it('defaults new projects to the small Granite preset', () => {
    expect(DEFAULT_PRESET_ID).toBe('granite-small-en-r2');
  });

  it('resolves a bare arctic model string to CLS pooling', () => {
    // The trap this guards: arctic is a CLS model, an unmatched model falls back to mean,
    // and a mean-pooled arctic returns plausible vectors that rank badly with nothing to
    // notice. A config that names only the model has to still land on cls.
    const profile = resolveVectorProfile(config({ model: 'Snowflake/snowflake-arctic-embed-m-v2.0' }));
    expect(profile.pooling).toBe('cls');
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

  it('keeps an explicit dtype when the model happens to match a preset', () => {
    // Matching by model name supplies pooling only. Overriding a dtype the config
    // states outright would silently move an existing repo to a different profile.
    const profile = resolveVectorProfile(config({ model: 'Xenova/all-MiniLM-L6-v2', dtype: 'fp32' }));
    expect(profile.dtype).toBe('fp32');
    expect(profile.pooling).toBe('mean');
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

  // The tests above use a synthetic profile, so they cannot see a preset gaining a field. This
  // one pins the REAL fingerprint of a shipped preset. If a future field reaches
  // `presetProfile` without being stripped, every stored row silently stops matching its own
  // profile and vector search goes quiet with no error anywhere. That is what a per-profile
  // similarity constant nearly did before it was stripped -- and then removed outright, once
  // measurement showed a per-store percentile beat it.
  //
  // Two ways to move this literal, and only one of them is legitimate. `EMBED_RECIPE_VERSION`
  // is deliberately part of the fingerprint, so bumping the recipe moves every fingerprint on
  // purpose: that is the mechanism by which a recipe change invalidates its own rows. Update
  // the value then, and only then. A move with no recipe bump behind it is the accident this
  // test exists to catch -- do not paste the new hash in to make it green.
  it('does not move when a preset gains a non-profile field', () => {
    expect(fingerprintProfile(resolveVectorProfile(config({ preset: 'arctic-embed-m-v2' }))))
      .toBe('f0814d56c298a041');
  });
});

/**
 * `scripts/benchmark-embedding-models.mjs` carries its own copy of the preset list, with a
 * comment saying it is "kept in step with PRESET_IDS". It was not: `arctic-embed-m-v2` was
 * added to the table as DEFAULT_PRESET_ID and never to the script, so for as long as arctic
 * has been the default, `npm run bench:embeddings` compared four alternatives to each other
 * and left the shipped model out of its own bake-off.
 *
 * A comment asking to be kept in step is how it drifted. This makes the drift fail.
 */
describe('bench:embeddings preset list', () => {
  it('covers every real preset, so the bake-off cannot omit the one that ships', async () => {
    const source = await readFile(
      new URL('../../scripts/benchmark-embedding-models.mjs', import.meta.url), 'utf-8',
    );
    const declared = source.match(/const ALL_PRESETS = \[(.*?)\];/s);
    expect(declared, 'ALL_PRESETS not found -- the script was restructured').not.toBeNull();

    const inScript = [...declared![1].matchAll(/'([^']+)'/g)].map(match => match[1]);
    expect([...inScript].sort()).toEqual(Object.keys(VECTOR_PRESETS).sort());
    // 'custom' names no model and cannot be benchmarked, which is why the comparison is
    // against VECTOR_PRESETS rather than PRESET_IDS.
    expect(PRESET_IDS.filter(id => id !== 'custom').sort()).toEqual([...inScript].sort());
    expect(inScript).toContain(DEFAULT_PRESET_ID);
  });
});

describe('the fingerprint covers the embedding recipe', () => {
  const profile = { provider: 'local', model: 'm', dtype: 'q8', pooling: 'cls' } as const;

  afterEach(() => { vi.resetModules(); vi.doUnmock('../../src/core/embed-recipe.js'); });

  it('changes when the recipe version changes, so a recipe change invalidates stored vectors', async () => {
    const before = fingerprintProfile(profile);

    vi.resetModules();
    vi.doMock('../../src/core/embed-recipe.js', () => ({
      EMBED_RECIPE_VERSION: 2,
      buildEmbedText: () => '',
    }));
    const { fingerprintProfile: withV2 } = await import('../../src/core/vector-profile.js');

    // Without this, a recipe change produces different vectors under an UNCHANGED fingerprint,
    // so search goes on scoring new query text against old-recipe vectors -- what
    // `vector-index.ts` calls "staleness the fingerprint cannot see".
    expect(withV2(profile)).not.toBe(before);
  });

  it('is stable for one profile at one recipe version', () => {
    expect(fingerprintProfile(profile)).toBe(fingerprintProfile({ ...profile }));
  });

  it('still separates two models at the same recipe version', () => {
    expect(fingerprintProfile({ ...profile, model: 'a' }))
      .not.toBe(fingerprintProfile({ ...profile, model: 'b' }));
  });

  it('still separates two poolings, which is the difference nothing else would notice', () => {
    expect(fingerprintProfile({ ...profile, pooling: 'cls' }))
      .not.toBe(fingerprintProfile({ ...profile, pooling: 'mean' }));
  });
});
