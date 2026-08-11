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

/**
 * `label`, `sizeMb`, `languages` and `contextTokens` are DOCUMENTATION, not runtime profile.
 * `presetProfile` strips all four before anything reaches `fingerprintProfile` -- folding one
 * in would change every stored embedding's fingerprint on upgrade and silently invalidate the
 * whole index.
 */
export type PresetDefinition = VectorProfile & {
  label: string;
  sizeMb: number;
  languages: string;
  contextTokens: number;
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
    contextTokens: 8192,
  },
  'granite-small-en-r2': {
    provider: 'local',
    model: 'onnx-community/granite-embedding-small-english-r2-ONNX',
    dtype: 'q8',
    pooling: 'cls',
    label: 'Granite Small English R2 — default, 8k context',
    sizeMb: 52,
    languages: 'English',
    contextTokens: 8192,
  },
  'granite-97m-multilingual': {
    provider: 'local',
    model: 'onnx-community/granite-embedding-97m-multilingual-r2-ONNX',
    dtype: 'q8',
    pooling: 'cls',
    label: 'Granite 97M Multilingual R2 — 200+ languages, 32k context',
    sizeMb: 98,
    languages: '200+ languages',
    contextTokens: 32768,
  },
  'bge-small-en': {
    provider: 'local',
    model: 'Xenova/bge-small-en-v1.5',
    dtype: 'q8',
    pooling: 'cls',
    label: 'BGE Small English v1.5 — smallest modern English option',
    sizeMb: 34,
    languages: 'English',
    contextTokens: 512,
  },
  'minilm-l6-en': {
    provider: 'local',
    model: 'Xenova/all-MiniLM-L6-v2',
    dtype: 'q8',
    pooling: 'mean',
    label: 'MiniLM L6 v2 — the historical default',
    sizeMb: 23,
    languages: 'English',
    contextTokens: 512,
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

/**
 * What `knowl init` writes. Deliberately not the most accurate entry in the table.
 *
 * The audit branch moved this to `arctic-embed-m-v2` on a measured retrieval win (MRR 0.734
 * against 0.493 on a 42-query half-remembered-phrasing set), and that measurement stands --
 * it is why arctic is in the table at all, and any repo that wants it is one `preset` key
 * away. What a default has to weigh besides accuracy is what it costs someone who never
 * chose it: 305 MB against 52 MB on first run, 768 dimensions against 384 in every stored
 * row, and roughly 6x the parameters to build the pipeline before the first query answers.
 *
 * A default is the choice made for people who have not made one, so it takes the cheaper
 * side and leaves the better retrieval to be opted into. Existing repos were never affected
 * either way: `preset` lives in `NEW_PROJECT_CONFIG` and not `DEFAULT_CONFIG`, precisely so
 * that changing this line cannot move a repository that already has an answer.
 */
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
  // Every documentation field is stripped here. One left in would reach `fingerprintProfile`,
  // change the fingerprint of every stored embedding, and invalidate the whole index on
  // upgrade -- for a number that only ever appears in a table. A test pins arctic's real
  // fingerprint against a value read out of a live store, so a future addition fails loudly.
  const {
    label: _label, sizeMb: _sizeMb, languages: _languages, contextTokens: _contextTokens,
...profile
  } = VECTOR_PRESETS[id];
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
 * Below this raw cosine, this model's best match is noise rather than a weak answer.
 *
 * **One number per model, because a cosine scale is a property of the model.** There used to be
 * one shared constant, `MIN_VECTOR_RELEVANCE = 0.30`, and it could not be right twice: measured
 * over the same 110 on-topic queries and 15 off-topic probes on the same 50-fixture corpus, it
 * mislabelled 24 of 110 real answers on arctic while firing not once on granite, whose entire
 * scale sits above it. Granite's floor is 4.75x arctic's for the same reason a Fahrenheit
 * reading is not a Celsius one.
 *
 * Each value is the observed on-topic minimum rounded down to two decimals -- the highest cut
 * that mislabels nothing on the on-topic set. Measured 2026-08-04; see
 * `docs/evals/per-model-floor.md` for the method and `tests/core/model-relevance-floor.test.ts`
 * for the bands, which fail if a number here moves without a re-measurement.
 *
 * | model | floor | mislabelled | junk caught |
 * | --- | --- | --- | --- |
 * | arctic-embed-m-v2 | 0.16 | 0/110 | 12/15 |
 * | granite-small-en-r2 | 0.76 | 0/110 | 14/15 |
 * | granite-97m-multilingual | 0.74 | 0/110 | 12/15 |
 * | bge-small-en | 0.53 | 0/110 | 11/15 |
 * | minilm-l6-en | 0.20 | 0/110 | 12/15 |
 *
 * The conservative cut is taken over the Youden-optimal one, which reaches 15/15 everywhere at
 * the cost of 1-5 mislabelled real answers per 110. Two reasons: `agent-query.ts` already holds
 * that silencing a real answer is worse than admitting a weak one, and agent traffic is
 * overwhelmingly on-topic; and the Youden cut is fit to the 15-probe junk set while this one is
 * fit to the 110-query on-topic set, so with these sample sizes the conservative estimate is
 * the more robust one rather than merely the safer one.
 *
 * Keyed on the model id and not the preset name, so a config that names a known model by hand
 * without naming a preset still gets the right floor.
 */
export const MODEL_RELEVANCE_FLOORS: Record<string, number> = {
  'Snowflake/snowflake-arctic-embed-m-v2.0': 0.16,
  'onnx-community/granite-embedding-small-english-r2-ONNX': 0.76,
  'onnx-community/granite-embedding-97m-multilingual-r2-ONNX': 0.74,
  'Xenova/bge-small-en-v1.5': 0.53,
  'Xenova/all-MiniLM-L6-v2': 0.20,
};

/**
 * This model's floor, or `null` when nobody has measured it.
 *
 * `null` means **no abstention**, and that is the deliberate answer rather than a gap left by
 * accident. Falling back to another model's constant is precisely the defect this table
 * replaces, one model along: it would take a number measured on arctic and use it to tell a
 * user of some custom model that their store has no answer. Knowl declines to claim a store
 * cannot answer when it has no calibration to say so with -- a withheld claim, not a wrong one.
 */
export function relevanceFloorFor(model: string): number | null {
  return MODEL_RELEVANCE_FLOORS[model] ?? null;
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
