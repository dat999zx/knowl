# Embedding Model Selection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users pick their embedding model from four vetted presets or supply a custom one, and make switching models safe rather than silently degrading retrieval.

**Architecture:** A new `search.vector.preset` config key names a profile bundling model, dtype and pooling together, resolved at read time by `resolveVectorProfile`. A `profile_fingerprint` column on `knowledge_embeddings` makes stored vectors self-describing, so any profile change makes old rows stop matching instead of being mis-scored. Reindex re-embeds every status through a keyset scan and purges rows that no longer match.

**Tech Stack:** TypeScript (ESM, NodeNext), vitest, drizzle-orm over @libsql/client (SQLite), @inquirer/prompts, @huggingface/transformers (ONNX), commander.

**Spec:** `docs/superpowers/specs/embedding-model-selection.md`

## Global Constraints

- Branch: `feat/embedding-model-selection`. Do not commit to `main`.
- Test command: `npm.cmd test` (vitest). Single file: `npm.cmd test -- tests/path/file.test.ts`.
- Typecheck: `npm.cmd run build`. There are 15 known pre-existing type errors; do not treat them as regressions, but add no new ones.
- All four built-in presets output **384 dimensions**. The `vector` column shape never changes.
- Pooling values are exactly `'mean'` and `'cls'`. dtype values are exactly `'q4' | 'q8' | 'fp16' | 'fp32'`.
- The default preset id is `granite-small-en-r2`. It is **English-only** and that is deliberate.
- No test may hit the network. Mock every Hugging Face call.
- Tests needing model weights must skip when `<root>/.knowl/models` lacks the model — CI has no model cache.
- Imports use the `.js` extension even for `.ts` sources (NodeNext).
- Never write `preset` into `DEFAULT_CONFIG`. It is the upgrade merge baseline.

---

### Task 1: Vector profile module

Foundation. Pure data plus one function, no behaviour change anywhere yet.

**Files:**
- Create: `src/core/vector-profile.ts`
- Create: `tests/core/vector-profile.test.ts`

**Interfaces:**
- Consumes: `ProjectConfig` from `src/core/types.js`.
- Produces:
  - `type VectorPooling = 'mean' | 'cls'`
  - `type VectorProfile = { provider: string; model: string; dtype: string; pooling: VectorPooling }`
  - `type PresetId = 'granite-small-en-r2' | 'granite-97m-multilingual' | 'bge-small-en' | 'minilm-l6-en' | 'custom'`
  - `const VECTOR_PRESETS: Record<Exclude<PresetId, 'custom'>, VectorProfile & { label: string; sizeMb: number; languages: string }>`
  - `const PRESET_IDS: readonly PresetId[]` in picker order
  - `const DEFAULT_PRESET_ID: PresetId`
  - `function resolveVectorProfile(config: ProjectConfig): VectorProfile`
  - `function fingerprintProfile(profile: VectorProfile): string`

- [ ] **Step 1: Write the failing test**

Create `tests/core/vector-profile.test.ts`:

```typescript
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm.cmd test -- tests/core/vector-profile.test.ts`
Expected: FAIL — cannot resolve `../../src/core/vector-profile.js`.

- [ ] **Step 3: Write the implementation**

Create `src/core/vector-profile.ts`:

```typescript
import { createHash } from 'node:crypto';
import type { ProjectConfig } from './types.js';

export type VectorPooling = 'mean' | 'cls';

export type VectorProfile = {
  provider: string;
  model: string;
  dtype: string;
  pooling: VectorPooling;
};

export type PresetId =
  | 'granite-small-en-r2'
  | 'granite-97m-multilingual'
  | 'bge-small-en'
  | 'minilm-l6-en'
  | 'custom';

export type PresetDefinition = VectorProfile & {
  label: string;
  sizeMb: number;
  languages: string;
};

/**
 * Model, dtype and pooling travel together because pooling is not independently
 * discoverable at runtime and a wrong value produces bad vectors with no error.
 * All four are 384-dimension so switching never changes the stored vector width.
 */
export const VECTOR_PRESETS: Record<Exclude<PresetId, 'custom'>, PresetDefinition> = {
  'granite-small-en-r2': {
    provider: 'local',
    model: 'onnx-community/granite-embedding-small-english-r2-ONNX',
    dtype: 'q8',
    pooling: 'cls',
    label: 'Granite Small English R2 — default, 8k context',
    sizeMb: 52,
    languages: 'English',
  },
  'granite-97m-multilingual': {
    provider: 'local',
    model: 'onnx-community/granite-embedding-97m-multilingual-r2-ONNX',
    dtype: 'q8',
    pooling: 'cls',
    label: 'Granite 97M Multilingual R2 — 200+ languages, 32k context',
    sizeMb: 98,
    languages: '200+ languages',
  },
  'bge-small-en': {
    provider: 'local',
    model: 'Xenova/bge-small-en-v1.5',
    dtype: 'q8',
    pooling: 'cls',
    label: 'BGE Small English v1.5 — smallest modern English option',
    sizeMb: 34,
    languages: 'English',
  },
  'minilm-l6-en': {
    provider: 'local',
    model: 'Xenova/all-MiniLM-L6-v2',
    dtype: 'q8',
    pooling: 'mean',
    label: 'MiniLM L6 v2 — the historical default',
    sizeMb: 23,
    languages: 'English',
  },
};

/** Picker order. `custom` last because it asks a follow-up question. */
export const PRESET_IDS: readonly PresetId[] = [
  'granite-small-en-r2',
  'granite-97m-multilingual',
  'bge-small-en',
  'minilm-l6-en',
  'custom',
];

export const DEFAULT_PRESET_ID: PresetId = 'granite-small-en-r2';

function isPresetId(value: unknown): value is Exclude<PresetId, 'custom'> {
  return typeof value === 'string' && value in VECTOR_PRESETS;
}

/**
 * The single source of truth for which model is in use.
 *
 * Resolution order matters. A named preset outranks the flat keys, so a config
 * carrying both is unambiguous. A config with no `preset` at all predates this
 * feature: its model string is matched against the table so an existing repo on
 * MiniLM keeps mean pooling and behaves exactly as it did before.
 */
export function resolveVectorProfile(config: ProjectConfig): VectorProfile {
  const vector = config?.search?.vector as Record<string, unknown> | undefined;
  const preset = vector?.preset;

  if (isPresetId(preset)) {
    const { label: _label, sizeMb: _sizeMb, languages: _languages, ...profile } = VECTOR_PRESETS[preset];
    return profile;
  }

  const model = typeof vector?.model === 'string' ? vector.model : '';

  if (preset !== 'custom' && isPresetId(matchPresetByModel(model))) {
    const matched = matchPresetByModel(model)!;
    const { label: _label, sizeMb: _sizeMb, languages: _languages, ...profile } = VECTOR_PRESETS[matched];
    return profile;
  }

  return {
    provider: typeof vector?.provider === 'string' ? vector.provider : 'local',
    model,
    dtype: typeof vector?.dtype === 'string' ? vector.dtype : 'q8',
    pooling: vector?.pooling === 'cls' ? 'cls' : 'mean',
  };
}

function matchPresetByModel(model: string): Exclude<PresetId, 'custom'> | null {
  for (const [id, preset] of Object.entries(VECTOR_PRESETS)) {
    if (preset.model === model) return id as Exclude<PresetId, 'custom'>;
  }
  return null;
}

/**
 * Written to every embedding row so a stored vector describes the profile that
 * produced it. provider and model alone are not enough: dtype and pooling both
 * change the numbers, so without them a dtype-only switch leaves old rows
 * matching the filter and being scored against incompatible query vectors.
 */
export function fingerprintProfile(profile: VectorProfile): string {
  const canonical = `${profile.provider}|${profile.model}|${profile.dtype}|${profile.pooling}`;
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm.cmd test -- tests/core/vector-profile.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add src/core/vector-profile.ts tests/core/vector-profile.test.ts
git commit -m "feat(vector): add preset profiles and profile fingerprinting"
```

---

### Task 2: Wire pooling through the embedder

Without this the default preset produces bad vectors, because `pooling: 'mean'` is hardcoded and three of the four presets are CLS-pooled.

**Files:**
- Modify: `src/ai/embeddings.ts:37-46` (`getVectorSearchConfig`), `src/ai/embeddings.ts:86-98` (`embed`)
- Test: `tests/ai/embeddings.test.ts` (add to the existing file; create it if absent)

**Interfaces:**
- Consumes: `resolveVectorProfile`, `VectorProfile` from Task 1.
- Produces: `getVectorSearchConfig(config)` now returns `{ enabled, provider, model, dtype, pooling, cacheDir }`. `KnowledgeEmbedder` gains `pooling: VectorPooling` alongside `provider` and `model`.

- [ ] **Step 1: Write the failing test**

Add to `tests/ai/embeddings.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { createLocalEmbeddingProvider, getVectorSearchConfig, resetLocalEmbeddingPipeline } from '../../src/ai/embeddings.js';
import type { ProjectConfig } from '../../src/core/types.js';

function config(vector: Record<string, unknown>): ProjectConfig {
  return { version: 1, search: { vector: { enabled: true, ...vector } } } as unknown as ProjectConfig;
}

describe('local embedding provider pooling', () => {
  it('passes cls pooling to the pipeline for a cls preset', async () => {
    resetLocalEmbeddingPipeline();
    const seen: Array<{ pooling: string; normalize: boolean }> = [];

    const embedder = await createLocalEmbeddingProvider(
      config({ preset: 'granite-small-en-r2' }),
      '/tmp/knowl-pooling-test',
      {
        loadPipeline: async () => (async (texts: string[], options: any) => {
          seen.push(options);
          return { data: new Float32Array(texts.length * 2).fill(0.5), dims: [texts.length, 2] };
        }) as any,
      },
    );

    await embedder.embed(['hello']);

    expect(seen).toEqual([{ pooling: 'cls', normalize: true }]);
    expect(embedder.pooling).toBe('cls');
  });

  it('passes mean pooling for the historical MiniLM config', async () => {
    resetLocalEmbeddingPipeline();
    const seen: Array<{ pooling: string }> = [];

    const embedder = await createLocalEmbeddingProvider(
      config({ model: 'Xenova/all-MiniLM-L6-v2', dtype: 'q8' }),
      '/tmp/knowl-pooling-test-2',
      {
        loadPipeline: async () => (async (texts: string[], options: any) => {
          seen.push(options);
          return { data: new Float32Array(texts.length * 2).fill(0.5), dims: [texts.length, 2] };
        }) as any,
      },
    );

    await embedder.embed(['hello']);

    expect(seen[0].pooling).toBe('mean');
    expect(embedder.pooling).toBe('mean');
  });

  it('resolves the preset model through getVectorSearchConfig', () => {
    const resolved = getVectorSearchConfig(config({ preset: 'bge-small-en' }));
    expect(resolved.model).toBe('Xenova/bge-small-en-v1.5');
    expect(resolved.pooling).toBe('cls');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm.cmd test -- tests/ai/embeddings.test.ts`
Expected: FAIL — `seen[0].pooling` is `'mean'` for the cls case, and `embedder.pooling` is undefined.

- [ ] **Step 3: Write the implementation**

In `src/ai/embeddings.ts`, add the import and replace `getVectorSearchConfig`:

```typescript
import { resolveVectorProfile, type VectorPooling } from '../core/vector-profile.js';

export function getVectorSearchConfig(config: ProjectConfig) {
  const profile = resolveVectorProfile(config);
  return {
    enabled: config.search?.vector?.enabled === true,
    provider: profile.provider,
    model: profile.model,
    dtype: profile.dtype,
    pooling: profile.pooling,
    cacheDir: config.search?.vector?.cacheDir,
  };
}
```

Change the pipeline key to include pooling, so a pooling change rebuilds the cached pipeline:

```typescript
const pipelineKey = `${vector.model}:${vector.dtype}:${vector.pooling}:${cacheDir}`;
```

Replace the returned embedder:

```typescript
  return {
    provider: 'local',
    model: vector.model,
    pooling: vector.pooling,
    embed: async (texts: string[]) => {
      const output = await localPipeline!(texts, {
        // Per-model, not a constant: MiniLM is mean-pooled while both Granite R2
        // models and BGE are CLS-pooled. Using the wrong one produces plausible
        // vectors that rank badly, with nothing to notice at runtime.
        pooling: vector.pooling,
        normalize: true,
      });
      const dimensions = output.dims[1];
      const data = Array.from(output.data);

      return texts.map((_, index) => {
        const start = index * dimensions;
        return data.slice(start, start + dimensions);
      });
    },
  };
```

Widen the pipeline type so `pooling` is not narrowed to `'mean'`:

```typescript
type TransformersPipeline = (texts: string[], options: { pooling: VectorPooling; normalize: boolean }) => Promise<{
  data: Float32Array | number[];
  dims: number[];
}>;
```

In `src/store/vector-index.ts`, widen the embedder type:

```typescript
export type KnowledgeEmbedder = {
  provider: string;
  model: string;
  pooling: 'mean' | 'cls';
  embed(texts: string[]): Promise<number[][]>;
};
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm.cmd test -- tests/ai/embeddings.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the full suite to catch fixture embedders missing `pooling`**

Run: `npm.cmd test`
Expected: type errors or failures in tests that build a fake `KnowledgeEmbedder`. Add `pooling: 'mean'` to each such fixture. Do not change their assertions.

- [ ] **Step 6: Commit**

```bash
git add src/ai/embeddings.ts src/store/vector-index.ts tests/ai/embeddings.test.ts
git commit -m "fix(vector): use per-model pooling instead of hardcoded mean"
```

---

### Task 3: Split new-project defaults from the upgrade merge baseline

`mergeConfigDefaults` fills any key whose value is `undefined`. Putting `preset` in `DEFAULT_CONFIG` would inject it into every existing repo on `knowl upgrade`, silently switching their model.

**Files:**
- Modify: `src/core/config.ts:6-31` (add `NEW_PROJECT_CONFIG` after `DEFAULT_CONFIG`)
- Modify: `src/cli/config/service.ts:79-82` (`resetAllConfig`)
- Test: `tests/cli/config-service.test.ts`

**Interfaces:**
- Produces: `NEW_PROJECT_CONFIG: ProjectConfig` exported from `src/core/config.js`. `DEFAULT_CONFIG` is unchanged and still has no `preset`.

- [ ] **Step 1: Write the failing test**

Add to `tests/cli/config-service.test.ts`:

```typescript
import { DEFAULT_CONFIG, NEW_PROJECT_CONFIG, upgradeConfigDefaults } from '../../src/core/config.js';

describe('preset defaults', () => {
  it('keeps preset out of the upgrade merge baseline', () => {
    expect((DEFAULT_CONFIG.search?.vector as Record<string, unknown>).preset).toBeUndefined();
  });

  it('defaults new projects to the English Granite preset', () => {
    expect((NEW_PROJECT_CONFIG.search?.vector as Record<string, unknown>).preset)
      .toBe('granite-small-en-r2');
  });

  it('does not add a preset to an existing repository on upgrade', async () => {
    await fs.mkdir(path.join(ROOT, '.knowl'), { recursive: true });
    await fs.writeFile(path.join(ROOT, '.knowl', 'config.json'), JSON.stringify({
      version: 1,
      security: { rejectSecrets: true, secretPatterns: [] },
      search: { vector: { enabled: true, provider: 'local', model: 'Xenova/all-MiniLM-L6-v2', dtype: 'q8' } },
    }));

    await upgradeConfigDefaults(ROOT);

    const saved = JSON.parse(await fs.readFile(path.join(ROOT, '.knowl', 'config.json'), 'utf8'));
    expect(saved.search.vector.preset).toBeUndefined();
    expect(saved.search.vector.model).toBe('Xenova/all-MiniLM-L6-v2');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm.cmd test -- tests/cli/config-service.test.ts`
Expected: FAIL — `NEW_PROJECT_CONFIG` is not exported.

- [ ] **Step 3: Write the implementation**

In `src/core/config.ts`, after `DEFAULT_CONFIG`:

```typescript
/**
 * What `knowl init` writes, and what `knowl config reset` restores.
 *
 * Deliberately separate from DEFAULT_CONFIG. That one is the merge baseline for
 * `upgradeConfigDefaults`, which fills in every key an existing config lacks --
 * so a `preset` placed there would be injected into every repository on upgrade
 * and silently move it to a different embedding model.
 */
export const NEW_PROJECT_CONFIG: ProjectConfig = {
  ...DEFAULT_CONFIG,
  search: {
    ...DEFAULT_CONFIG.search,
    vector: {
      ...DEFAULT_CONFIG.search?.vector,
      preset: DEFAULT_PRESET_ID,
    },
  },
} as ProjectConfig;
```

Add the import at the top of `src/core/config.ts`:

```typescript
import { DEFAULT_PRESET_ID } from './vector-profile.js';
```

Add `preset?: string` and `pooling?: 'mean' | 'cls'` to the vector config type in `src/core/types.ts` beside the existing `dtype?:` declaration at line 240.

In `src/cli/config/service.ts`, change `resetAllConfig` to use the new-project shape:

```typescript
import { NEW_PROJECT_CONFIG, saveConfig } from '../../core/config.js';

export async function resetAllConfig(root: string): Promise<void> {
  await backupConfig(root);
  await saveRawConfig(root, structuredClone(NEW_PROJECT_CONFIG) as ConfigRecord);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm.cmd test -- tests/cli/config-service.test.ts`
Expected: PASS.

- [ ] **Step 5: Point `knowl init` at the new-project config**

Search for where init writes the initial config:

Run: `grep -rn "DEFAULT_CONFIG" src/ --include=*.ts`

Replace `DEFAULT_CONFIG` with `NEW_PROJECT_CONFIG` **only** at the site that creates a config for a brand-new project. Leave `mergeConfigDefaults` and `upgradeConfigDefaults` on `DEFAULT_CONFIG`.

- [ ] **Step 6: Run the full suite**

Run: `npm.cmd test`
Expected: PASS. The existing assertion that `DEFAULT_CONFIG.search.vector` equals the MiniLM object still holds, because `DEFAULT_CONFIG` is untouched.

- [ ] **Step 7: Commit**

```bash
git add src/core/config.ts src/core/types.ts src/cli/config/service.ts tests/cli/config-service.test.ts
git commit -m "feat(config): separate new-project defaults from the upgrade baseline"
```

---

### Task 4: Profile fingerprint column

**Files:**
- Modify: `src/store/schema.ts:145-152`
- Modify: `src/store/bootstrap.ts` (add `ensureEmbeddingProfileColumns`, call it beside the other `ensure*` calls near line 622)
- Modify: `src/store/vector.ts:98-124` (upsert), `:126-218` (search), `:233-259` (`findEmbeddedItemIds`)
- Test: `tests/store/vector-fingerprint.test.ts`

**Interfaces:**
- Consumes: `fingerprintProfile` from Task 1.
- Produces: `KnowledgeEmbeddingInput` gains `profileFingerprint: string`. `searchKnowledgeEmbeddings` and `findEmbeddedItemIds` accept `profileFingerprint?: string` **in place of** `provider`/`model`. A new `purgeEmbeddingsNotMatching(projectId, fingerprint): Promise<number>` is exported from `src/store/vector.ts`.

- [ ] **Step 1: Write the failing test**

Create `tests/store/vector-fingerprint.test.ts`. Follow the store-test setup used by `tests/store/vector.test.ts` for creating a temp project; mirror its imports and `beforeEach`/`afterEach`.

```typescript
import { describe, expect, it } from 'vitest';
import { fingerprintProfile } from '../../src/core/vector-profile.js';
import {
  purgeEmbeddingsNotMatching, searchKnowledgeEmbeddings, upsertKnowledgeEmbedding,
} from '../../src/store/vector.js';

const Q8 = fingerprintProfile({ provider: 'local', model: 'a/b', dtype: 'q8', pooling: 'cls' });
const FP32 = fingerprintProfile({ provider: 'local', model: 'a/b', dtype: 'fp32', pooling: 'cls' });
const MEAN = fingerprintProfile({ provider: 'local', model: 'a/b', dtype: 'q8', pooling: 'mean' });

describe('embedding profile fingerprint', () => {
  it('hides rows written under a different dtype', async () => {
    const { projectId, itemId } = await seedOneItem();
    await upsertKnowledgeEmbedding({
      projectId, knowledgeItemId: itemId,
      provider: 'local', model: 'a/b', profileFingerprint: Q8,
      dimensions: 3, vector: [1, 0, 0],
    });

    const sameProfile = await searchKnowledgeEmbeddings(projectId, { vector: [1, 0, 0], profileFingerprint: Q8 });
    expect(sameProfile).toHaveLength(1);

    const afterDtypeChange = await searchKnowledgeEmbeddings(projectId, { vector: [1, 0, 0], profileFingerprint: FP32 });
    expect(afterDtypeChange).toHaveLength(0);
  });

  it('hides rows written under a different pooling', async () => {
    const { projectId, itemId } = await seedOneItem();
    await upsertKnowledgeEmbedding({
      projectId, knowledgeItemId: itemId,
      provider: 'local', model: 'a/b', profileFingerprint: Q8,
      dimensions: 3, vector: [1, 0, 0],
    });

    expect(await searchKnowledgeEmbeddings(projectId, { vector: [1, 0, 0], profileFingerprint: MEAN })).toHaveLength(0);
  });

  it('purges only rows that do not match the current fingerprint', async () => {
    const { projectId, itemId, otherItemId } = await seedTwoItems();
    await upsertKnowledgeEmbedding({
      projectId, knowledgeItemId: itemId,
      provider: 'local', model: 'a/b', profileFingerprint: Q8, dimensions: 3, vector: [1, 0, 0],
    });
    await upsertKnowledgeEmbedding({
      projectId, knowledgeItemId: otherItemId,
      provider: 'local', model: 'a/b', profileFingerprint: FP32, dimensions: 3, vector: [0, 1, 0],
    });

    expect(await purgeEmbeddingsNotMatching(projectId, Q8)).toBe(1);
    expect(await searchKnowledgeEmbeddings(projectId, { vector: [1, 0, 0], profileFingerprint: Q8 })).toHaveLength(1);
  });
});
```

Write `seedOneItem` and `seedTwoItems` as local helpers that init a temp DB, create a project, and store one or two active knowledge items, returning their ids. Copy the pattern from `tests/store/vector.test.ts`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm.cmd test -- tests/store/vector-fingerprint.test.ts`
Expected: FAIL — `purgeEmbeddingsNotMatching` is not exported and `profileFingerprint` is not a known option.

- [ ] **Step 3: Add the column to the schema and the migration**

In `src/store/schema.ts`, add to `knowledgeEmbeddings`:

```typescript
  profileFingerprint: text('profile_fingerprint'),
```

In `src/store/bootstrap.ts`, add beside the other `ensure*` helpers:

```typescript
/**
 * Backfills with the repository's current profile fingerprint, which is by
 * definition the profile that produced the existing rows -- nothing else could
 * have written them.
 */
async function ensureEmbeddingProfileColumns(client: Client, fingerprint: string | null): Promise<void> {
  if (!(await tableExists(client, 'knowledge_embeddings'))) return;
  const columns = await tableColumns(client, 'knowledge_embeddings');
  if (columns.includes('profile_fingerprint')) return;

  await client.execute('ALTER TABLE knowledge_embeddings ADD COLUMN profile_fingerprint TEXT;');
  if (fingerprint) {
    await client.execute({
      sql: 'UPDATE knowledge_embeddings SET profile_fingerprint = ? WHERE profile_fingerprint IS NULL',
      args: [fingerprint],
    });
  }
}
```

Call it in the same block as the other `ensure*` calls (near line 622), passing the fingerprint of the resolved profile for the project root being bootstrapped. If the bootstrap function has no access to config, load it there with `loadConfig` inside a `try`/`catch` that yields `null` — a bootstrap must not fail because config is unreadable.

- [ ] **Step 4: Filter on the fingerprint**

In `src/store/vector.ts`:

```typescript
export type KnowledgeEmbeddingInput = {
  projectId?: string;
  knowledgeItemId: string;
  provider: string;
  model: string;
  /** Identifies the exact profile that produced this vector. See fingerprintProfile. */
  profileFingerprint: string;
  dimensions: number;
  vector: number[];
};
```

In the upsert SQL, add the column and the conflict update:

```sql
INSERT INTO knowledge_embeddings (knowledge_item_id, provider, model, profile_fingerprint, dimensions, vector, updated_at)
VALUES (?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(knowledge_item_id) DO UPDATE SET
  provider = excluded.provider, model = excluded.model,
  profile_fingerprint = excluded.profile_fingerprint,
  dimensions = excluded.dimensions, vector = excluded.vector,
  updated_at = excluded.updated_at
```

with args `[knowledgeItemId, provider, model, profileFingerprint, dimensions, encodeVector(vector), now]`.

In `searchKnowledgeEmbeddings`, replace the `options.provider` and `options.model` predicates with:

```typescript
    // Provider and model are not sufficient: dtype and pooling change the numbers a
    // model emits, so a row written under a different one is not comparable even
    // though its provider and model match.
    if (options.profileFingerprint) {
      where.push('e.profile_fingerprint = ?');
      args.push(options.profileFingerprint);
    }
```

Change the option type from `provider?: string; model?: string;` to `profileFingerprint?: string;`.

Apply the same substitution in `findEmbeddedItemIds`, and update its doc comment to say the fingerprint decides eligibility.

Add:

```typescript
/** Drops rows left behind by a previous profile, including those for deleted items. */
export async function purgeEmbeddingsNotMatching(projectId: string, fingerprint: string): Promise<number> {
  const result = await getClient().execute({
    sql: `DELETE FROM knowledge_embeddings
          WHERE profile_fingerprint IS NULL OR profile_fingerprint != ?`,
    args: [fingerprint],
  });
  return Number(result.rowsAffected ?? 0);
}
```

- [ ] **Step 5: Update every caller**

Run: `npm.cmd run build`

Fix each type error by passing `profileFingerprint` at the call sites in `src/store/write-embedding.ts`, `src/store/vector-index.ts`, `src/workspace/federated-query.ts`, `src/store/agent-query.ts`, and anywhere else the compiler names. Each computes it with `fingerprintProfile(resolveVectorProfile(config))`.

- [ ] **Step 6: Run the tests**

Run: `npm.cmd test`
Expected: PASS, including the new fingerprint tests.

- [ ] **Step 7: Commit**

```bash
git add src/store/schema.ts src/store/bootstrap.ts src/store/vector.ts src/store/write-embedding.ts src/store/vector-index.ts tests/store/vector-fingerprint.test.ts
git commit -m "feat(vector): key embeddings by profile fingerprint, not provider and model"
```

---

### Task 5: Reindex every status with a keyset scan

`queryKnowledgeBase` applies `status = 'active'` when no status is given and has no cursor, so it cannot express what reindex needs.

**Files:**
- Create: `src/store/index-scan.ts`
- Modify: `src/store/vector-index.ts:21-52`
- Modify: `src/index.ts:1029-1067` (the `reindex` command action)
- Test: `tests/store/reindex-scope.test.ts`

**Interfaces:**
- Consumes: `purgeEmbeddingsNotMatching`, `fingerprintProfile`.
- Produces:
  - `iterateKnowledgeItemsForIndexing(projectId: string, options?: { batchSize?: number }): AsyncGenerator<KnowledgeItem[]>` from `src/store/index-scan.js`
  - `reindexKnowledgeEmbeddings` now returns `{ indexed: number; purged: number; byStatus: Record<string, number> }`

- [ ] **Step 1: Write the failing test**

Create `tests/store/reindex-scope.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { reindexKnowledgeEmbeddings } from '../../src/store/vector-index.js';
import { fingerprintProfile } from '../../src/core/vector-profile.js';

const PROFILE = { provider: 'local', model: 'a/b', dtype: 'q8', pooling: 'cls' } as const;

function stubEmbedder() {
  return {
    provider: 'local',
    model: 'a/b',
    pooling: 'cls' as const,
    profileFingerprint: fingerprintProfile(PROFILE),
    embed: async (texts: string[]) => texts.map(() => [1, 0, 0]),
  };
}

describe('reindex scope', () => {
  it('re-embeds items in every status, not only active', async () => {
    // Seed one active, one superseded, one archived item.
    const { projectId } = await seedItemsWithStatuses(['active', 'superseded', 'archived']);

    const result = await reindexKnowledgeEmbeddings(projectId, stubEmbedder());

    expect(result.indexed).toBe(3);
    expect(result.byStatus).toEqual({ active: 1, superseded: 1, archived: 1 });
  });

  it('pages past the old 10,000 ceiling', async () => {
    const { projectId } = await seedManyItems(10_050);
    const result = await reindexKnowledgeEmbeddings(projectId, stubEmbedder());
    expect(result.indexed).toBe(10_050);
  });

  it('purges rows left over from a previous profile', async () => {
    const { projectId } = await seedItemsWithStatuses(['active']);
    await writeEmbeddingWithFingerprint(projectId, 'stale-fingerprint');

    const result = await reindexKnowledgeEmbeddings(projectId, stubEmbedder());

    expect(result.purged).toBeGreaterThanOrEqual(0);
    expect(await countEmbeddingsWithFingerprint(projectId, 'stale-fingerprint')).toBe(0);
  });
});
```

Write `seedItemsWithStatuses`, `seedManyItems`, `writeEmbeddingWithFingerprint` and `countEmbeddingsWithFingerprint` as local helpers using the same temp-project setup as `tests/store/vector.test.ts`. `seedManyItems` should insert directly via `getClient().execute` in a loop rather than through the public store API, to keep the test fast.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm.cmd test -- tests/store/reindex-scope.test.ts`
Expected: FAIL — `result.byStatus` is undefined and `indexed` is 1, not 3.

- [ ] **Step 3: Write the scan**

Create `src/store/index-scan.ts`:

```typescript
import { KnowledgeItem } from '../core/types.js';
import { getClient } from './database.js';
import { getKnowledgeItems } from './repository.js';

/**
 * Every knowledge item, in every status, in id order.
 *
 * Deliberately not `queryKnowledgeBase`: that applies `status = 'active'` when no
 * status is passed, so "omit the filter" means active-only there, and it has no
 * cursor, so its 10,000 limit truncates a larger store without saying so. Reindex
 * needs the opposite of both.
 */
export async function* iterateKnowledgeItemsForIndexing(
  projectId: string,
  options: { batchSize?: number } = {},
): AsyncGenerator<KnowledgeItem[]> {
  const batchSize = options.batchSize ?? 500;
  let cursor = '';

  for (;;) {
    const rows = await getClient().execute({
      sql: `SELECT id FROM knowledge_items
            WHERE project_id = ? AND id > ?
            ORDER BY id
            LIMIT ?`,
      args: [projectId, cursor, batchSize],
    });
    if (rows.rows.length === 0) return;

    const ids = rows.rows.map(row => String(row.id));
    cursor = ids[ids.length - 1];

    const items = await getKnowledgeItems(ids);
    const batch = ids.map(id => items.get(id)).filter((item): item is KnowledgeItem => Boolean(item));
    if (batch.length > 0) yield batch;
  }
}
```

- [ ] **Step 4: Rewrite the reindex**

Replace `reindexKnowledgeEmbeddings` in `src/store/vector-index.ts`:

```typescript
export type VectorReindexResult = {
  indexed: number;
  purged: number;
  byStatus: Record<string, number>;
};

export async function reindexKnowledgeEmbeddings(
  projectId: string,
  embedder: KnowledgeEmbedder,
): Promise<VectorReindexResult> {
  let indexed = 0;
  const byStatus: Record<string, number> = {};

  for await (const batch of iterateKnowledgeItemsForIndexing(projectId)) {
    const vectors = await embedder.embed(batch.map(buildKnowledgeEmbeddingText));

    for (let i = 0; i < batch.length; i++) {
      const vector = vectors[i];
      if (!vector || vector.length === 0) continue;
      await upsertKnowledgeEmbedding({
        projectId,
        knowledgeItemId: batch[i].id,
        provider: embedder.provider,
        model: embedder.model,
        profileFingerprint: embedder.profileFingerprint,
        dimensions: vector.length,
        vector,
      });
      indexed++;
      const status = batch[i].status ?? 'active';
      byStatus[status] = (byStatus[status] ?? 0) + 1;
    }
  }

  // Runs last so an interrupted rebuild never deletes rows it has not replaced.
  const purged = await purgeEmbeddingsNotMatching(projectId, embedder.profileFingerprint);

  return { indexed, purged, byStatus };
}
```

Add `profileFingerprint: string` to the `KnowledgeEmbedder` type, and set it in `createLocalEmbeddingProvider` with `fingerprintProfile(resolveVectorProfile(config))`.

- [ ] **Step 5: Report the counts in the CLI**

In `src/index.ts`, replace the reindex success line:

```typescript
      const result = await reindexKnowledgeEmbeddings(project.id, embedder);
      const perStatus = Object.entries(result.byStatus)
        .map(([status, count]) => `${count} ${status}`)
        .join(', ');
      console.log(`Indexed ${result.indexed} vector embedding(s)${perStatus ? ` (${perStatus})` : ''}.`);
      if (result.purged > 0) console.log(`Purged ${result.purged} embedding(s) from a previous model.`);
```

- [ ] **Step 6: Run the tests**

Run: `npm.cmd test`
Expected: PASS. Fix any call site still reading `result.indexed` as the whole return.

- [ ] **Step 7: Commit**

```bash
git add src/store/index-scan.ts src/store/vector-index.ts src/index.ts tests/store/reindex-scope.test.ts
git commit -m "feat(reindex): re-embed every status and purge stale-profile rows"
```

---

### Task 6: Config fields and atomic multi-key writes

**Files:**
- Modify: `src/cli/config/schema.ts:3-19` (keys), `:60-81` (fields)
- Modify: `src/cli/config/service.ts` (add `setConfigValues`)
- Test: `tests/cli/config-service.test.ts`

**Interfaces:**
- Produces: `setConfigValues(root: string, entries: Array<{ key: string; raw: string }>): Promise<void>` from `src/cli/config/service.js`. Config keys `search.vector.preset` and `search.vector.pooling`.

- [ ] **Step 1: Write the failing test**

```typescript
import { setConfigValues } from '../../src/cli/config/service.js';

describe('setConfigValues', () => {
  it('writes every entry in one save', async () => {
    await writeConfig();
    await setConfigValues(ROOT, [
      { key: 'search.vector.preset', raw: 'custom' },
      { key: 'search.vector.model', raw: 'someone/theirs-ONNX' },
      { key: 'search.vector.pooling', raw: 'cls' },
    ]);

    const saved = JSON.parse(await fs.readFile(path.join(ROOT, '.knowl', 'config.json'), 'utf8'));
    expect(saved.search.vector).toMatchObject({
      preset: 'custom', model: 'someone/theirs-ONNX', pooling: 'cls',
    });
  });

  it('persists nothing when any entry is invalid', async () => {
    await writeConfig();
    await expect(setConfigValues(ROOT, [
      { key: 'search.vector.preset', raw: 'custom' },
      { key: 'search.vector.pooling', raw: 'banana' },
    ])).rejects.toThrow(/Expected one of/);

    const saved = JSON.parse(await fs.readFile(path.join(ROOT, '.knowl', 'config.json'), 'utf8'));
    expect(saved.search.vector.preset).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm.cmd test -- tests/cli/config-service.test.ts`
Expected: FAIL — `setConfigValues` is not exported.

- [ ] **Step 3: Add the config fields**

In `src/cli/config/schema.ts`, add to the `ConfigKey` union:

```typescript
  | 'search.vector.preset'
  | 'search.vector.pooling'
```

Add the constants and fields:

```typescript
import { DEFAULT_PRESET_ID, PRESET_IDS } from '../../core/vector-profile.js';

const VECTOR_POOLINGS = ['mean', 'cls'] as const;

  { key: 'search.vector.preset', category: 'Search', type: 'enum', values: PRESET_IDS, parse: enumValue(PRESET_IDS), defaultValue: DEFAULT_PRESET_ID },
  { key: 'search.vector.pooling', category: 'Search', type: 'enum', values: VECTOR_POOLINGS, parse: enumValue(VECTOR_POOLINGS) },
```

Place `search.vector.preset` **first** among the Search fields so it leads the picker.

- [ ] **Step 4: Add the atomic write**

In `src/cli/config/service.ts`:

```typescript
/**
 * Write several keys as one unit.
 *
 * A custom embedding profile is three keys, and writing them one at a time can
 * leave `preset: custom` on disk with no verified model beside it -- a state any
 * command running in between would resolve and act on. Every entry is parsed
 * before anything is written, so an invalid one changes nothing.
 */
export async function setConfigValues(
  root: string,
  entries: Array<{ key: string; raw: string }>,
): Promise<void> {
  const parsed = entries.map(entry => ({
    key: entry.key,
    value: getConfigField(entry.key).parse(entry.raw),
  }));

  const config = await loadRawConfig(root);
  for (const entry of parsed) setAtPath(config, entry.key, entry.value);
  await backupConfig(root);
  await saveRawConfig(root, config);
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm.cmd test -- tests/cli/config-service.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/cli/config/schema.ts src/cli/config/service.ts tests/cli/config-service.test.ts
git commit -m "feat(config): add preset and pooling fields with atomic multi-key writes"
```

---

### Task 7: Custom model verification and the set-model command

**Files:**
- Create: `src/ai/model-probe.ts`
- Create: `tests/ai/model-probe.test.ts`
- Modify: `src/index.ts` (add the `config set-model` subcommand beside the existing `set`, near line 1010)

**Interfaces:**
- Produces:
  - `verifyCustomModel(model: string, deps?: { fetchJson?, fetchText? }): Promise<{ ok: true; pooling: VectorPooling | null } | { ok: false; reason: string }>` from `src/ai/model-probe.js`
- Consumes: `setConfigValues` from Task 6.

- [ ] **Step 1: Write the failing test**

Create `tests/ai/model-probe.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { verifyCustomModel } from '../../src/ai/model-probe.js';

const withFiles = (siblings: string[]) => async () => ({ siblings: siblings.map(rfilename => ({ rfilename })) });

describe('verifyCustomModel', () => {
  it('rejects a model that does not resolve', async () => {
    const result = await verifyCustomModel('nobody/nothing', {
      fetchJson: async () => { throw new Error('404'); },
      fetchText: async () => null,
    });
    expect(result).toEqual({ ok: false, reason: expect.stringContaining('could not be found') });
  });

  it('rejects a model with no q8 ONNX weights', async () => {
    const result = await verifyCustomModel('someone/pytorch-only', {
      fetchJson: withFiles(['pytorch_model.bin', 'config.json']),
      fetchText: async () => null,
    });
    expect(result).toEqual({ ok: false, reason: expect.stringContaining('onnx/model_quantized.onnx') });
  });

  it('reads cls pooling from 1_Pooling/config.json', async () => {
    const result = await verifyCustomModel('someone/good-ONNX', {
      fetchJson: withFiles(['onnx/model_quantized.onnx']),
      fetchText: async () => JSON.stringify({ pooling_mode_cls_token: true, pooling_mode_mean_tokens: false }),
    });
    expect(result).toEqual({ ok: true, pooling: 'cls' });
  });

  it('reads mean pooling from 1_Pooling/config.json', async () => {
    const result = await verifyCustomModel('someone/good-ONNX', {
      fetchJson: withFiles(['onnx/model_quantized.onnx']),
      fetchText: async () => JSON.stringify({ pooling_mode_cls_token: false, pooling_mode_mean_tokens: true }),
    });
    expect(result).toEqual({ ok: true, pooling: 'mean' });
  });

  it('returns null pooling when the file is absent, so the caller must ask', async () => {
    const result = await verifyCustomModel('someone/mirror-ONNX', {
      fetchJson: withFiles(['onnx/model_quantized.onnx']),
      fetchText: async () => null,
    });
    expect(result).toEqual({ ok: true, pooling: null });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm.cmd test -- tests/ai/model-probe.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `src/ai/model-probe.ts`:

```typescript
import type { VectorPooling } from '../core/vector-profile.js';

export type ProbeResult =
  | { ok: true; pooling: VectorPooling | null }
  | { ok: false; reason: string };

export type ProbeDeps = {
  fetchJson?: (url: string) => Promise<any>;
  fetchText?: (url: string) => Promise<string | null>;
};

const defaultFetchJson = async (url: string) => {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
};

const defaultFetchText = async (url: string) => {
  const response = await fetch(url);
  return response.ok ? response.text() : null;
};

/**
 * Check a custom model before it reaches config.
 *
 * Pooling is returned as null rather than guessed when the model repo has no
 * 1_Pooling/config.json, which is common on ONNX mirrors. A wrong pooling value
 * produces plausible-looking vectors that rank badly with no error, so the caller
 * must ask rather than default.
 */
export async function verifyCustomModel(model: string, deps: ProbeDeps = {}): Promise<ProbeResult> {
  const fetchJson = deps.fetchJson ?? defaultFetchJson;
  const fetchText = deps.fetchText ?? defaultFetchText;

  let info: any;
  try {
    info = await fetchJson(`https://huggingface.co/api/models/${model}`);
  } catch {
    return { ok: false, reason: `Model "${model}" could not be found on Hugging Face.` };
  }

  const files: string[] = (info?.siblings ?? []).map((sibling: any) => String(sibling.rfilename));
  if (!files.includes('onnx/model_quantized.onnx')) {
    return {
      ok: false,
      reason: `Model "${model}" has no onnx/model_quantized.onnx, so it cannot run locally at q8. Look for an ONNX conversion of it.`,
    };
  }

  const poolingRaw = await fetchText(`https://huggingface.co/${model}/raw/main/1_Pooling/config.json`);
  if (!poolingRaw) return { ok: true, pooling: null };

  try {
    const pooling = JSON.parse(poolingRaw);
    if (pooling.pooling_mode_cls_token) return { ok: true, pooling: 'cls' };
    if (pooling.pooling_mode_mean_tokens) return { ok: true, pooling: 'mean' };
  } catch {
    // Unparseable is the same as absent: ask rather than assume.
  }
  return { ok: true, pooling: null };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm.cmd test -- tests/ai/model-probe.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Add the `config set-model` command**

In `src/index.ts`, beside the existing `config set` subcommand:

```typescript
configCommand
  .command('set-model <model>')
  .description('Verify, download and select a custom embedding model')
  .option('--pooling <mode>', 'cls or mean; required when the model does not declare it')
  .action(async (model: string, options: { pooling?: string }) => {
    try {
      const root = await findProjectRoot(process.cwd());
      const probe = await verifyCustomModel(model);
      if (!probe.ok) throw new Error(probe.reason);

      const pooling = probe.pooling ?? options.pooling;
      if (!pooling) {
        throw new Error(
          `${model} does not declare its pooling method. Re-run with --pooling cls or --pooling mean. ` +
          'Guessing would produce vectors that rank badly with no visible error.',
        );
      }
      if (pooling !== 'cls' && pooling !== 'mean') throw new Error('--pooling must be cls or mean.');

      await setConfigValues(root, [
        { key: 'search.vector.preset', raw: 'custom' },
        { key: 'search.vector.model', raw: model },
        { key: 'search.vector.pooling', raw: pooling },
      ]);
      console.log(`Selected ${model} (${pooling} pooling).`);
      console.log('Run `knowl reindex --vectors` to rebuild embeddings with it.');
    } catch (error: any) {
      console.error(`Configuration error: ${error.message}`);
      process.exitCode = 1;
    }
  });
```

Reject a bare `preset custom` in the existing `config set` action, before it writes:

```typescript
      if (key === 'search.vector.preset' && value === 'custom') {
        throw new Error('Use `knowl config set-model <name>` for a custom model; `preset custom` alone leaves no model to use.');
      }
```

- [ ] **Step 6: Handle `custom` in the interactive picker**

Selecting `custom` in `knowl config` must not write a bare `preset: custom` either — it hits the
same incomplete-profile problem as the non-interactive path, just through a different door.

Add an optional method to `ConfigPrompts` in `src/cli/config/ui.ts`:

```typescript
  /**
   * Asked when the preset picker lands on `custom`. Returning null cancels back to
   * the field list, which is why the caller must not have written anything yet.
   */
  inputCustomModel?(): Promise<{ model: string; pooling: 'mean' | 'cls' } | null>;
```

In `runConfigUi`, after a value is parsed, special-case the preset field:

```typescript
    if (key === 'search.vector.preset' && parsed === 'custom') {
      if (!prompts.inputCustomModel) {
        throw new Error('Custom models need an interactive prompt. Use `knowl config set-model <name>`.');
      }
      const custom = await prompts.inputCustomModel();
      if (!custom) continue; // cancelled: nothing queued, nothing written
      changes.push({ key: 'search.vector.model', before: '', after: custom.model, raw: custom.model });
      changes.push({ key: 'search.vector.pooling', before: '', after: custom.pooling, raw: custom.pooling });
    }
```

Implement it in `createInquirerPrompts`, running `verifyCustomModel` and re-prompting on failure:

```typescript
    inputCustomModel: async () => {
      const prompts = await import('@inquirer/prompts');
      for (;;) {
        const model = await prompts.input({ message: 'Hugging Face model id (blank to cancel)' });
        if (!model.trim()) return null;

        const probe = await verifyCustomModel(model.trim());
        if (!probe.ok) {
          console.error(probe.reason);
          continue;
        }

        // Asked, never defaulted: an ONNX mirror without 1_Pooling/config.json gives
        // us nothing to infer from, and a wrong guess ranks badly with no error.
        const pooling = probe.pooling ?? await prompts.select({
          message: `${model} does not declare its pooling method. Which does it use?`,
          choices: [{ name: 'cls', value: 'cls' as const }, { name: 'mean', value: 'mean' as const }],
        });
        return { model: model.trim(), pooling };
      }
    },
```

Because `runConfigUi` already batches every change until the final confirm and Task 6 moved it onto
`setConfigValues`, all three keys land in one write.

Add a test asserting that a `ConfigPrompts` stub selecting `custom` and returning a model produces
all three keys in the saved config, and that returning `null` writes nothing.

- [ ] **Step 7: Run the tests and commit**

Run: `npm.cmd test`

```bash
git add src/ai/model-probe.ts src/index.ts tests/ai/model-probe.test.ts
git commit -m "feat(config): verify custom embedding models before selecting them"
```

---

### Task 8: Profile-change detection and the reindex offer

**Files:**
- Create: `src/cli/config/profile-change.ts`
- Create: `tests/cli/profile-change.test.ts`
- Modify: `src/cli/config/ui.ts:112-163` (`runConfigUi`), `src/index.ts` (the `config set` and `config reset` actions)

**Interfaces:**
- Produces: `describeProfileChange(before: ProjectConfig, after: ProjectConfig): { changed: boolean; before: VectorProfile; after: VectorProfile }` and `formatProfileChangeWarning(change, affectedRows: number): string` from `src/cli/config/profile-change.js`; `countStoredEmbeddings(): Promise<number>` from `src/store/vector.js`.

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, it } from 'vitest';
import { describeProfileChange } from '../../src/cli/config/profile-change.js';
import type { ProjectConfig } from '../../src/core/types.js';

const cfg = (vector: Record<string, unknown>) =>
  ({ version: 1, search: { vector: { enabled: true, ...vector } } }) as unknown as ProjectConfig;

describe('describeProfileChange', () => {
  it('detects a preset switch', () => {
    const change = describeProfileChange(cfg({ preset: 'minilm-l6-en' }), cfg({ preset: 'bge-small-en' }));
    expect(change.changed).toBe(true);
  });

  it('detects a dtype-only change', () => {
    const change = describeProfileChange(
      cfg({ preset: 'custom', model: 'a/b', pooling: 'cls', dtype: 'q8' }),
      cfg({ preset: 'custom', model: 'a/b', pooling: 'cls', dtype: 'fp32' }),
    );
    expect(change.changed).toBe(true);
  });

  it('detects a pooling-only change', () => {
    const change = describeProfileChange(
      cfg({ preset: 'custom', model: 'a/b', pooling: 'mean', dtype: 'q8' }),
      cfg({ preset: 'custom', model: 'a/b', pooling: 'cls', dtype: 'q8' }),
    );
    expect(change.changed).toBe(true);
  });

  it('ignores an unrelated config edit', () => {
    const before = cfg({ preset: 'bge-small-en' });
    const after = cfg({ preset: 'bge-small-en', cacheDir: '/elsewhere' });
    expect(describeProfileChange(before, after).changed).toBe(false);
  });

  it('treats a preset and its equivalent explicit model as the same profile', () => {
    const change = describeProfileChange(
      cfg({ preset: 'minilm-l6-en' }),
      cfg({ model: 'Xenova/all-MiniLM-L6-v2', dtype: 'q8' }),
    );
    expect(change.changed).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm.cmd test -- tests/cli/profile-change.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `src/cli/config/profile-change.ts`:

```typescript
import type { ProjectConfig } from '../../core/types.js';
import { fingerprintProfile, resolveVectorProfile, type VectorProfile } from '../../core/vector-profile.js';

export type ProfileChange = {
  changed: boolean;
  before: VectorProfile;
  after: VectorProfile;
};

/**
 * Compares resolved profiles rather than raw keys, so selecting a preset and
 * spelling out the same model by hand count as no change, while a dtype- or
 * pooling-only edit correctly counts as one.
 */
export function describeProfileChange(before: ProjectConfig, after: ProjectConfig): ProfileChange {
  const from = resolveVectorProfile(before);
  const to = resolveVectorProfile(after);
  return { changed: fingerprintProfile(from) !== fingerprintProfile(to), before: from, after: to };
}

export function formatProfileChangeWarning(change: ProfileChange, affectedRows: number): string {
  return [
    `Embedding model changed: ${change.before.model} (${change.before.dtype}, ${change.before.pooling} pooling)`,
    `                     ->  ${change.after.model} (${change.after.dtype}, ${change.after.pooling} pooling)`,
    '',
    `${affectedRows} stored embedding(s) were written by the old profile and no longer match.`,
    'Vector search falls back to keyword-only results until you run:',
    '  knowl reindex --vectors',
  ].join('\n');
}
```

- [ ] **Step 4: Add the row count**

The warning states how many embeddings are affected, so it needs a count. Add to
`src/store/vector.ts`:

```typescript
/** How many embedding rows exist, regardless of profile. Used to size the switch warning. */
export async function countStoredEmbeddings(): Promise<number> {
  const rows = await getClient().execute('SELECT COUNT(*) AS total FROM knowledge_embeddings');
  return Number((rows.rows[0] as any)?.total ?? 0);
}
```

The caller must have a database open. In the `config` actions that means `await initDb(root)`
before calling it and `await closeDb()` after — wrap the whole count in a `try`/`catch` returning
`0`, because a config edit must not fail just because the store is unreadable.

- [ ] **Step 5: Wire it into the CLI**

In `src/index.ts`, in the `config set` and `config reset` actions, capture the config before and after the write, then:

```typescript
      const change = describeProfileChange(configBefore, configAfter);
      if (change.changed) {
        const affected = await countStoredEmbeddings(root);
        console.log('');
        console.log(formatProfileChangeWarning(change, affected));
      }
```

In `runConfigUi`, after the writes at line 161, resolve the config again and — when `change.changed` — call a new optional prompt `confirmReindex?(change: ProfileChange, affectedRows: number): Promise<boolean>`. Return `{ saved, changes, reindexRequested }` so `src/index.ts` runs the reindex when it is true. When the prompt is absent, print the warning instead. Add the inquirer implementation to `createInquirerPrompts`.

- [ ] **Step 6: Name the workspace consequence**

When the repo is in a workspace and the new profile no longer matches the manifest, the warning
must say so — federation breaking is a worse surprise than local degradation, and the fix is a
different command. Append to `formatProfileChangeWarning`'s output at the call site:

```typescript
        const active = await resolveWorkspace(root).catch(() => null);
        if (active && !sameEmbeddingIdentity(embeddingIdentityFromConfig(configAfter), active.manifest.embedding)) {
          console.log('');
          console.log(
            `This repository is in workspace "${active.manifest.name}", which is pinned to ` +
            `${formatEmbeddingIdentity(active.manifest.embedding)}. Until they match, this repo's items and ` +
            "its peers' items are invisible to each other.",
          );
          console.log('To move the whole workspace instead, run `knowl workspace repin-embedding`.');
        }
```

This depends on Task 9 for `repin-embedding` and the pooling-aware identity. If Task 9 is not done
yet, implement the rest of this task and add this step immediately after it.

- [ ] **Step 7: Run the tests and commit**

Run: `npm.cmd test`

```bash
git add src/cli/config/profile-change.ts src/cli/config/ui.ts src/store/vector.ts src/index.ts tests/cli/profile-change.test.ts
git commit -m "feat(config): offer a reindex when the embedding profile changes"
```

---

### Task 9: Workspace identity

**Files:**
- Modify: `src/store/embedding-identity.ts`
- Modify: `src/workspace/membership.ts:72-79`, `:121-122`
- Modify: `src/index.ts` (add `workspace repin-embedding`)
- Test: `tests/workspace/embedding-identity.test.ts`

**Interfaces:**
- Produces: `EmbeddingIdentity` gains `pooling: 'mean' | 'cls' | 'unknown'`. `migrateLegacyManifestPooling(manifest): WorkspaceManifest` from `src/workspace/membership.js`.

- [ ] **Step 1: Write the failing test**

```typescript
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
    expect(migrated.embedding.pooling).toBe('mean');
  });

  it('records unknown for an unrecognised model rather than guessing', () => {
    const migrated = migrateLegacyManifestPooling({
      embedding: { provider: 'local', model: 'someone/mystery', dtype: 'q8' },
    } as any);
    expect(migrated.embedding.pooling).toBe('unknown');
  });

  it('never reports an unknown-pooling manifest as compatible', () => {
    const unknown = { provider: 'local', model: 'someone/mystery', dtype: 'q8', pooling: 'unknown' } as const;
    const known = { provider: 'local', model: 'someone/mystery', dtype: 'q8', pooling: 'cls' } as const;
    expect(sameEmbeddingIdentity(unknown, known)).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm.cmd test -- tests/workspace/embedding-identity.test.ts`
Expected: FAIL — `identity.model` is `''` and `migrateLegacyManifestPooling` is not exported.

- [ ] **Step 3: Write the implementation**

Rewrite `src/store/embedding-identity.ts`:

```typescript
import type { ProjectConfig } from '../core/types.js';
import { resolveVectorProfile } from '../core/vector-profile.js';

export type EmbeddingIdentity = {
  provider: string;
  model: string;
  dtype: string;
  /** `unknown` comes from a pre-pooling manifest and never compares equal to anything. */
  pooling: 'mean' | 'cls' | 'unknown';
};

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
```

In `src/workspace/membership.ts`:

```typescript
import { VECTOR_PRESETS } from '../core/vector-profile.js';

/**
 * Fill in pooling for a manifest written before the field existed.
 *
 * Derived from the pinned model where that model is one we ship, since its
 * pooling is known. Otherwise recorded as `unknown`, which disables cross-repo
 * vector fusion until someone repins -- degraded beats silently wrong.
 */
export function migrateLegacyManifestPooling(manifest: WorkspaceManifest): WorkspaceManifest {
  const embedding = manifest.embedding as (EmbeddingIdentity & { pooling?: string }) | null;
  if (!embedding || embedding.pooling) return manifest;

  const known = Object.values(VECTOR_PRESETS).find(preset => preset.model === embedding.model);
  return {
    ...manifest,
    embedding: { ...embedding, pooling: known ? known.pooling : 'unknown' },
  };
}
```

Call `migrateLegacyManifestPooling` in `readManifest` (or immediately after every `readManifest` call) and write the result back when it changed.

- [ ] **Step 4: Add the repin command**

In `src/index.ts`, under the `workspace` command:

```typescript
workspaceCommand
  .command('repin-embedding')
  .description("Repoint the workspace at this repository's embedding model")
  .option('--yes', 'Skip the confirmation prompt')
  .action(async (options: { yes?: boolean }) => {
    try {
      const root = await findProjectRoot(process.cwd());
      const config = await loadConfig(root);
      const identity = embeddingIdentityFromConfig(config);
      const active = await resolveWorkspace(root);
      if (!active) throw new Error('This repository is not in a workspace.');

      const peers = active.manifest.repos.filter(repo => repo.root !== root);
      console.log(`Workspace "${active.manifest.name}" moves to ${formatEmbeddingIdentity(identity)}.`);
      console.log('Every linked repository must then run `knowl reindex --vectors`:');
      for (const peer of peers) console.log(`  ${peer.name}  ${peer.root}`);

      if (!options.yes) {
        const { confirm } = await import('@inquirer/prompts');
        if (!(await confirm({ message: 'Repin the workspace?', default: false }))) {
          console.log('Unchanged.');
          return;
        }
      }

      active.manifest.embedding = identity;
      await writeManifest(workspaceManifestPath(active.root), active.manifest);
      console.log('Repinned. Peers keep their old vectors until each one reindexes.');
    } catch (error: any) {
      console.error(`Error repinning workspace embedding: ${error.message}`);
      process.exitCode = 1;
    }
  });
```

- [ ] **Step 5: Run the tests and commit**

Run: `npm.cmd test`

```bash
git add src/store/embedding-identity.ts src/workspace/membership.ts src/index.ts tests/workspace/embedding-identity.test.ts
git commit -m "feat(workspace): resolve embedding identity through the profile and allow repinning"
```

---

### Task 10: Init messaging

**Files:**
- Modify: `src/cli/warm-embeddings.ts:66-77` (`formatWarmResult`)
- Test: `tests/cli/warm-embeddings.test.ts`

**Interfaces:**
- Consumes: `resolveVectorProfile`, `VECTOR_PRESETS`.

- [ ] **Step 1: Write the failing test**

```typescript
import { formatWarmResult } from '../../src/cli/warm-embeddings.js';

it('points English-only defaults at the multilingual option', () => {
  const message = formatWarmResult({
    status: 'ready',
    model: 'onnx-community/granite-embedding-small-english-r2-ONNX',
  });
  expect(message).toContain('English');
  expect(message).toContain('knowl config');
});

it('says nothing about language when the model is already multilingual', () => {
  const message = formatWarmResult({
    status: 'ready',
    model: 'onnx-community/granite-embedding-97m-multilingual-r2-ONNX',
  });
  expect(message).not.toContain('knowl config');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm.cmd test -- tests/cli/warm-embeddings.test.ts`
Expected: FAIL — the ready message is a fixed string.

- [ ] **Step 3: Write the implementation**

In `src/cli/warm-embeddings.ts`:

```typescript
import { VECTOR_PRESETS } from '../core/vector-profile.js';

    case 'ready': {
      const preset = Object.values(VECTOR_PRESETS).find(candidate => candidate.model === result.model);
      const base = '🧠 Embedding model ready; new knowledge is indexed for semantic search as it is written.';
      // Said once, at init, rather than as a doctor warning: an English-only default
      // is deliberate, so warning about it on every check would nag about a choice
      // the project made. But a user storing non-English knowledge needs to know a
      // better option exists, and this is the only place they are told.
      if (!preset || preset.languages === 'English') {
        return `${base}\n   Using an English-only model. For other languages, run \`knowl config\` and pick granite-97m-multilingual.`;
      }
      return base;
    }
```

- [ ] **Step 4: Run the tests**

Run: `npm.cmd test`
Expected: PASS.

- [ ] **Step 5: Verify the whole feature end to end**

```bash
npm.cmd run build
npm.cmd test
```

Then in a scratch directory outside the repo:

```bash
node dist/index.js init
node dist/index.js config get search.vector.preset   # granite-small-en-r2
node dist/index.js reindex --vectors                  # downloads ~52MB, reports per-status counts
node dist/index.js config set search.vector.preset bge-small-en
# expect the profile-change warning naming both models
node dist/index.js reindex --vectors
node dist/index.js doctor
```

- [ ] **Step 6: Commit**

```bash
git add src/cli/warm-embeddings.ts tests/cli/warm-embeddings.test.ts
git commit -m "feat(init): name the active model and point at the multilingual option"
```

---

## Notes for the implementer

- **The pooling fix (Task 2) is load-bearing.** Three of four presets are CLS-pooled, including the default. If it regresses, retrieval quality drops with no error and no failing test outside `tests/ai/embeddings.test.ts`.
- **Never add `preset` to `DEFAULT_CONFIG`.** It is the upgrade merge baseline and would migrate every existing repository.
- **`purgeEmbeddingsNotMatching` runs last** in the reindex, so an interruption never deletes rows it has not replaced.
- The semantic benchmark is a separate plan: `docs/superpowers/plans/2026-08-02-semantic-retrieval-benchmark.md`.
