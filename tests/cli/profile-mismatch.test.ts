import { describe, expect, it } from 'vitest';
import { formatProfileMismatch, type MismatchProfile } from '../../src/cli/profile-mismatch.js';

const granite = (over: Partial<MismatchProfile> = {}): MismatchProfile => ({
  provider: 'local',
  model: 'onnx-community/granite-embedding-small-english-r2-ONNX',
  dtype: 'q8',
  pooling: 'cls',
  recipeVersion: 1,
  ...over,
});

describe('the profile-mismatch refusal', () => {
  it('does not tell you to switch models when only the recipe differs', () => {
    // The failure this exists to prevent: both sides print an identical model, and the old
    // message still said "switch this repository to that model" — an instruction with no
    // referent. `EMBED_RECIPE_VERSION` is a compiled constant, so there is nothing to switch to.
    const text = formatProfileMismatch({
      workspace: granite({ recipeVersion: 0 }),
      repo: granite({ recipeVersion: 1 }),
      differing: ['recipeVersion'],
      itemCount: 0,
    });

    expect(text).not.toMatch(/switch this repository/i);
    expect(text).not.toMatch(/knowl config set-model/);
    expect(text).toMatch(/model is the same on both sides/i);
    expect(text).toMatch(/compiled constant|not a setting/i);
  });

  it('says who has to act when the workspace predates the recipe', () => {
    const text = formatProfileMismatch({
      workspace: granite({ recipeVersion: 0 }),
      repo: granite({ recipeVersion: 1 }),
      differing: ['recipeVersion'],
      itemCount: 0,
    });

    expect(text).toMatch(/workspace owner/i);
    expect(text).toMatch(/created before the recipe was recorded/i);
  });

  it('tells an older client to upgrade rather than blaming the workspace', () => {
    const text = formatProfileMismatch({
      workspace: granite({ recipeVersion: 2 }),
      repo: granite({ recipeVersion: 1 }),
      differing: ['recipeVersion'],
      itemCount: 0,
    });

    expect(text).toMatch(/older than the workspace/i);
    expect(text).toMatch(/upgrade knowl/i);
  });

  it('gives the runnable remedy when the model really does differ', () => {
    const text = formatProfileMismatch({
      workspace: granite(),
      repo: granite({ model: 'Xenova/all-MiniLM-L6-v2', pooling: 'mean' }),
      differing: ['model', 'pooling'],
      itemCount: 412,
    });

    expect(text).toMatch(/knowl config set-model/);
    expect(text).toMatch(/knowl reindex --vectors --force/);
    expect(text).toContain('412 item(s)');
  });

  it('never says "re-embed 0 item(s)", which reads as the tool losing track', () => {
    const text = formatProfileMismatch({
      workspace: granite(),
      repo: granite({ model: 'Xenova/all-MiniLM-L6-v2' }),
      differing: ['model'],
      itemCount: 0,
    });

    expect(text).not.toMatch(/0 item\(s\)/);
    expect(text).toMatch(/costs no re-indexing/i);
  });

  it('always names what differs, whichever branch it takes', () => {
    for (const differing of [['recipeVersion'], ['model'], ['model', 'dtype', 'recipeVersion']]) {
      const text = formatProfileMismatch({
        workspace: granite({ recipeVersion: 0 }),
        repo: granite(),
        differing,
        itemCount: 3,
      });
      expect(text).toContain(`Differing: ${differing.join(', ')}.`);
    }
  });
});
