import { describe, expect, it } from 'vitest';
import {
  MODEL_RELEVANCE_FLOORS, relevanceFloorFor, VECTOR_PRESETS,
} from '../../src/core/vector-profile.js';

/**
 * What each model actually scored, so a floor cannot be edited without re-measuring.
 *
 * Measured 2026-08-04 (docs/evals/per-model-floor.md): the best raw cosine per query, over 110
 * on-topic cases from `semantic-suite.json` and 15 off-topic probes run against that same
 * 50-fixture corpus, at each preset's own dtype.
 *
 * `offTopicMax` is the highest score junk reached and `onTopicMin` the lowest a real answer
 * reached. A floor at or below `onTopicMin` mislabels nothing; the further below `offTopicMax`
 * it sits, the more junk goes unlabelled. These are the two numbers the choice trades off, so
 * they are the two the test pins.
 */
const MEASURED: Record<string, { offTopicMax: number; onTopicMin: number }> = {
  'Snowflake/snowflake-arctic-embed-m-v2.0': { offTopicMax: 0.2275, onTopicMin: 0.1638 },
  'onnx-community/granite-embedding-small-english-r2-ONNX': { offTopicMax: 0.7644, onTopicMin: 0.7637 },
  'onnx-community/granite-embedding-97m-multilingual-r2-ONNX': { offTopicMax: 0.7552, onTopicMin: 0.7443 },
  'Xenova/bge-small-en-v1.5': { offTopicMax: 0.5754, onTopicMin: 0.5399 },
  'Xenova/all-MiniLM-L6-v2': { offTopicMax: 0.2392, onTopicMin: 0.2003 },
};

describe('per-model relevance floors', () => {
  it('ships a floor for every preset, so no shipped model abstains on a guess', () => {
    for (const preset of Object.values(VECTOR_PRESETS)) {
      expect(relevanceFloorFor(preset.model), `no floor for ${preset.model}`).toBeTypeOf('number');
    }
  });

  it.each(Object.entries(MEASURED))(
    'keeps %s at or below its weakest real answer, so nothing measured is mislabelled',
    (model, band) => {
      const floor = relevanceFloorFor(model)!;
      // At or below the weakest on-topic query: this is the whole point of the conservative
      // cut, and the property that makes 0 of 110 real answers carry a false verdict.
      expect(floor).toBeLessThanOrEqual(band.onTopicMin);
      // And still low enough to be a floor rather than a formality -- a value at or above the
      // junk ceiling would label everything, one below it labels nothing.
      expect(floor).toBeLessThan(band.offTopicMax);
    },
  );

  it('puts each floor in the same range as its own model, not a shared one', () => {
    // The defect this replaces: one constant for every model. Granite's floor is ~4.75x
    // arctic's because granite's whole cosine scale is, and a single number cannot be both.
    const arctic = relevanceFloorFor('Snowflake/snowflake-arctic-embed-m-v2.0')!;
    const granite = relevanceFloorFor('onnx-community/granite-embedding-small-english-r2-ONNX')!;
    expect(granite).toBeGreaterThan(arctic * 3);
  });

  it('returns null for a model nobody has measured', () => {
    // A withheld claim, not a guessed one. Applying another model's number here is exactly the
    // bug being fixed, one model along.
    expect(relevanceFloorFor('some-org/an-unmeasured-model')).toBeNull();
    expect(relevanceFloorFor('')).toBeNull();
  });

  it('exposes the table keyed by model id rather than by preset name', () => {
    // Keyed on the model because that is what identifies the embedding space: a custom config
    // naming a known model by hand gets the right floor without naming a preset.
    for (const model of Object.keys(MEASURED)) {
      expect(MODEL_RELEVANCE_FLOORS[model]).toBeTypeOf('number');
    }
  });
});
