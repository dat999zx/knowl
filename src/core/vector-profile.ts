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
 * Written to every embedding row so a stored vector describes the profile that
 * produced it. provider and model alone are not enough: dtype and pooling both
 * change the numbers, so without them a dtype-only switch leaves old rows
 * matching the filter and being scored against incompatible query vectors.
 */
export function fingerprintProfile(profile: VectorProfile): string {
  const canonical = `${profile.provider}|${profile.model}|${profile.dtype}|${profile.pooling}`;
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}
