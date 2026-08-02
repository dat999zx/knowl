import { describe, expect, it } from 'vitest';
import { describeProfileChange, formatProfileChangeWarning, shadowedByPresetNotice } from '../../src/cli/config/profile-change.js';
import type { ProjectConfig } from '../../src/core/types.js';

const cfg = (vector: Record<string, unknown>) =>
  ({ version: 1, search: { vector: { enabled: true, ...vector } } }) as unknown as ProjectConfig;

describe('shadowedByPresetNotice', () => {
  // Every repo created by `knowl init` carries a preset, so `config set search.vector.model`
  // -- the only way to change models before presets existed -- now reports success and
  // changes nothing. describeProfileChange stays silent because nothing did change.
  it('warns that setting the model has no effect while a named preset is active', () => {
    const notice = shadowedByPresetNotice(cfg({ preset: 'granite-small-en-r2' }), 'search.vector.model').join('\n');
    expect(notice).toContain('no effect');
    expect(notice).toContain('granite-small-en-r2');
    expect(notice).toContain('set-model');
  });

  it('warns for dtype and pooling too, which the preset also decides', () => {
    expect(shadowedByPresetNotice(cfg({ preset: 'bge-small-en' }), 'search.vector.dtype')).not.toEqual([]);
    expect(shadowedByPresetNotice(cfg({ preset: 'bge-small-en' }), 'search.vector.pooling')).not.toEqual([]);
  });

  it('stays silent for a custom preset, where the flat keys are exactly what is used', () => {
    expect(shadowedByPresetNotice(
      cfg({ preset: 'custom', model: 'a/b', pooling: 'cls' }), 'search.vector.model',
    )).toEqual([]);
  });

  it('stays silent for a config written before presets existed', () => {
    expect(shadowedByPresetNotice(
      cfg({ model: 'Xenova/all-MiniLM-L6-v2', dtype: 'q8' }), 'search.vector.model',
    )).toEqual([]);
  });

  it('stays silent for a key the preset does not decide', () => {
    expect(shadowedByPresetNotice(cfg({ preset: 'granite-small-en-r2' }), 'search.vector.cacheDir')).toEqual([]);
  });
});

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

describe('formatProfileChangeWarning', () => {
  it('names both models and the command that fixes it', () => {
    const change = describeProfileChange(cfg({ preset: 'minilm-l6-en' }), cfg({ preset: 'bge-small-en' }));
    const warning = formatProfileChangeWarning(change, 42);

    expect(warning).toContain('Xenova/all-MiniLM-L6-v2');
    expect(warning).toContain('Xenova/bge-small-en-v1.5');
    expect(warning).toContain('42 stored embedding(s)');
    expect(warning).toContain('knowl reindex --vectors');
  });
});
