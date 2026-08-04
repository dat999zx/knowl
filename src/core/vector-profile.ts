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
  | 'arctic-embed-m-v2'
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
  /**
   * The measured pick for this fork, and the one entry here that is not 384-dimension.
   *
   * Chosen by enumerating the registry rather than by leaderboard or recall: on a 42-query
   * set phrased the way someone half-remembers a thing, it scored MRR 0.734 against 0.493
   * for granite-small-en-r2, the strongest of the 384-dim options. It costs roughly 6x the
   * parameters and ~9.6s to build the pipeline even with the weights already on disk, which
   * is first-query latency rather than startup latency -- `serve` never loads a model during
   * its handshake.
   *
   * Listed as a preset rather than left to a bare `model` string on purpose. Pooling is not
   * discoverable at runtime, and an unmatched model falls back to `mean`; arctic is a CLS
   * model, and running it mean-pooled produces plausible vectors that rank badly with
   * nothing to notice. Being in this table is what makes an existing config that names only
   * the model resolve to the right pooling.
   */
  'arctic-embed-m-v2': {
    provider: 'local',
    model: 'Snowflake/snowflake-arctic-embed-m-v2.0',
    dtype: 'q8',
    pooling: 'cls',
    label: 'Snowflake Arctic Embed M v2.0 — most accurate, 768-dim',
    sizeMb: 305,
    languages: 'English + multilingual',
  },
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
  'arctic-embed-m-v2',
  'granite-small-en-r2',
  'granite-97m-multilingual',
  'bge-small-en',
  'minilm-l6-en',
  'custom',
];

export const DEFAULT_PRESET_ID: PresetId = 'arctic-embed-m-v2';

function isPresetId(value: unknown): value is Exclude<PresetId, 'custom'> {
  return typeof value === 'string' && value in VECTOR_PRESETS;
}

function matchPresetByModel(model: string): Exclude<PresetId, 'custom'> | null {
  for (const [id, preset] of Object.entries(VECTOR_PRESETS)) {
    if (preset.model === model) return id as Exclude<PresetId, 'custom'>;
  }
  return null;
}

/**
 * Which preset a config is on, for display and for pre-selecting the picker.
 *
 * A repo initialised before presets existed carries no `preset` key at all, so the only
 * evidence of what it runs is the model string. Falling back to that is what lets the
 * editor say "MiniLM L6 v2" instead of showing nothing selected.
 */
export function currentPresetId(config: ProjectConfig): PresetId | null {
  const vector = config?.search?.vector as Record<string, unknown> | undefined;
  if (isPresetId(vector?.preset)) return vector.preset;
  if (vector?.preset === 'custom') return 'custom';
  const model = typeof vector?.model === 'string' ? vector.model : '';
  return model ? matchPresetByModel(model) ?? 'custom' : null;
}

function presetProfile(id: Exclude<PresetId, 'custom'>): VectorProfile {
  const { label: _label, sizeMb: _sizeMb, languages: _languages, ...profile } = VECTOR_PRESETS[id];
  return profile;
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

  if (isPresetId(preset)) return presetProfile(preset);

  const model = typeof vector?.model === 'string' ? vector.model : '';
  // Only pooling is taken from the matched preset, never dtype or provider. Those the
  // config states outright, and overriding a repo's explicit `dtype: fp32` because its
  // model name happens to appear in the table would be exactly the silent switch the
  // preset table exists to prevent. Pooling is the one thing an old config cannot say.
  const matched = preset === 'custom' ? null : matchPresetByModel(model);

  return {
    provider: typeof vector?.provider === 'string' ? vector.provider : 'local',
    model,
    dtype: typeof vector?.dtype === 'string' ? vector.dtype : 'q8',
    pooling: vector?.pooling === 'cls' ? 'cls'
      : vector?.pooling === 'mean' ? 'mean'
        : matched ? VECTOR_PRESETS[matched].pooling : 'mean',
  };
}

/**
 * How atom texts are grouped into forward passes, as an input to the vector's identity.
 *
 * Not part of `VectorProfile`, because it is not a thing a config states -- it is a property
 * of the code that produced the row. It is in the fingerprint because the q8 graph quantises
 * per batch, so the same text embedded alone and embedded beside neighbours yields vectors up
 * to 4.79e-2 apart in cosine. That is the same *kind* of difference as a dtype switch, and it
 * has to invalidate rows the same way.
 *
 * Without it two individually correct behaviours combine into a wrong one:
 * `reindexKnowledgeEmbeddings` now embeds one text per pass, and it also skips any item whose
 * stored row already carries this fingerprint. A row written by a build that batched carries
 * the same fingerprint and a materially different vector, so the skip would preserve exactly
 * the write-time/reindex disagreement that `maxBatch: 1` exists to remove -- permanently, and
 * only on stores that upgraded rather than started fresh.
 *
 * Bump this string if the batching policy changes again.
 */
const EMBEDDING_BATCH_POLICY = 'single';

/**
 * Written to every embedding row so a stored vector describes the profile that
 * produced it. provider and model alone are not enough: dtype and pooling both
 * change the numbers, so without them a dtype-only switch leaves old rows
 * matching the filter and being scored against incompatible query vectors.
 */
export function fingerprintProfile(profile: VectorProfile): string {
  const canonical =
    `${profile.provider}|${profile.model}|${profile.dtype}|${profile.pooling}|${EMBEDDING_BATCH_POLICY}`;
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}
