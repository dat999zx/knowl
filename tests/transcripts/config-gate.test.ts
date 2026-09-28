import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveStorage } from '../../src/store/storage-roles.js';
import { isTranscriptFallbackEnabled, isTranscriptSearchEnabled, isTranscriptSharingEnabled } from '../../src/transcripts/config.js';
import type { ProjectConfig } from '../../src/core/types.js';

const baseConfig = (): ProjectConfig => ({
  version: 1,
  security: { rejectSecrets: true, secretPatterns: [] },
});

describe('transcript search config gate', () => {
  it('is enabled when the config says nothing', () => {
    expect(isTranscriptSearchEnabled(baseConfig())).toBe(true);
    expect(isTranscriptSearchEnabled({ ...baseConfig(), search: { vector: { enabled: true } } })).toBe(true);
  });

  it('is disabled only by an explicit false', () => {
    const config = { ...baseConfig(), search: { transcripts: { enabled: false } } };
    expect(isTranscriptSearchEnabled(config)).toBe(false);
  });

  it('falls back on query miss by default, and not when search is off', () => {
    expect(isTranscriptFallbackEnabled(baseConfig())).toBe(true);
    expect(isTranscriptFallbackEnabled({ ...baseConfig(), search: { transcripts: { fallback: false } } })).toBe(false);
    expect(isTranscriptFallbackEnabled({ ...baseConfig(), search: { transcripts: { enabled: false, fallback: true } } })).toBe(false);
  });

  it('does not share by default, even when enabled', () => {
    const config = { ...baseConfig(), search: { transcripts: { enabled: true } } };
    expect(isTranscriptSharingEnabled(config)).toBe(false);
  });

  it('shares only when both enabled and share are true', () => {
    const shareOnly = { ...baseConfig(), search: { transcripts: { enabled: false, share: true } } };
    expect(isTranscriptSharingEnabled(shareOnly)).toBe(false);

    const both = { ...baseConfig(), search: { transcripts: { enabled: true, share: true } } };
    expect(isTranscriptSharingEnabled(both)).toBe(true);
  });

  it('resolves the transcripts database beside the knowledge database', () => {
    const storage = resolveStorage('/tmp/proj');
    expect(storage.transcripts).toBe(path.join('/tmp/proj', '.knowl', 'transcripts.db'));
    expect(storage.transcripts).not.toBe(storage.knowledge);
  });
});
