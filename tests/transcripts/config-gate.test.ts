import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveStorage } from '../../src/store/storage-roles.js';
import { isTranscriptSearchEnabled, isTranscriptSharingEnabled } from '../../src/transcripts/config.js';
import type { ProjectConfig } from '../../src/core/types.js';

const baseConfig = (): ProjectConfig => ({
  version: 1,
  security: { rejectSecrets: true, secretPatterns: [] },
});

describe('transcript search config gate', () => {
  it('is disabled when the config says nothing', () => {
    expect(isTranscriptSearchEnabled(baseConfig())).toBe(false);
  });

  it('is disabled when the search block exists but transcripts does not', () => {
    const config = { ...baseConfig(), search: { vector: { enabled: true } } };
    expect(isTranscriptSearchEnabled(config)).toBe(false);
  });

  it('requires the literal true, not any truthy value', () => {
    const config = { ...baseConfig(), search: { transcripts: { enabled: 1 as unknown as boolean } } };
    expect(isTranscriptSearchEnabled(config)).toBe(false);
  });

  it('is enabled only when explicitly set', () => {
    const config = { ...baseConfig(), search: { transcripts: { enabled: true } } };
    expect(isTranscriptSearchEnabled(config)).toBe(true);
  });

  it('does not share by default, even when enabled', () => {
    const config = { ...baseConfig(), search: { transcripts: { enabled: true } } };
    expect(isTranscriptSharingEnabled(config)).toBe(false);
  });

  it('shares only when both enabled and share are true', () => {
    const shareOnly = { ...baseConfig(), search: { transcripts: { share: true } } };
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
