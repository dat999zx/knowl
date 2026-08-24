import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { DEFAULT_CONFIG, loadConfig } from '../../src/core/config.js';
import { CONFIG_FIELDS } from '../../src/cli/config/schema.js';
import { getEffectiveConfigValue, resetConfigValue, setConfigValue, setConfigValues } from '../../src/cli/config/service.js';
import { captureEventsMode, captureScope } from '../../src/store/capture-config.js';
import { isTranscriptFallbackEnabled } from '../../src/transcripts/config.js';

/**
 * The posture keys through the config service -- the same calls the `knowl posture` command
 * makes. The command itself is a thin loop over these; what has to hold is that every key
 * parses, round-trips, resets, and lands where its runtime reader looks.
 */

const ROOT = path.resolve('.knowl-posture-test');

afterEach(async () => {
  await fs.rm(ROOT, { recursive: true, force: true });
});

async function writeConfig() {
  await fs.mkdir(path.join(ROOT, '.knowl'), { recursive: true });
  await fs.writeFile(path.join(ROOT, '.knowl', 'config.json'), JSON.stringify(DEFAULT_CONFIG, null, 2), 'utf8');
}

const MAXIMAL: Array<{ key: string; raw: string }> = [
  { key: 'search.transcripts.enabled', raw: 'true' },
  { key: 'search.transcripts.fallback', raw: 'true' },
  { key: 'capture.nudge', raw: 'enforce' },
  { key: 'capture.events', raw: 'enforce' },
  { key: 'capture.scope', raw: 'turn' },
  { key: 'impact.enabled', raw: 'true' },
  { key: 'impact.gate', raw: 'shadow' },
];

describe('the posture keys', () => {
  it('declares every new key in the schema with a default the editor can restore', () => {
    for (const key of ['search.transcripts.fallback', 'capture.events', 'capture.scope']) {
      const field = CONFIG_FIELDS.find(entry => entry.key === key);
      expect(field, key).toBeDefined();
      expect(field!.defaultValue, key).toBeDefined();
    }
  });

  it('sets the maximal posture in one batch and the runtime readers see it', async () => {
    await writeConfig();
    await setConfigValues(ROOT, MAXIMAL);

    const config = await loadConfig(ROOT);
    expect(isTranscriptFallbackEnabled(config)).toBe(true);
    expect(captureEventsMode(config)).toBe('enforce');
    expect(captureScope(config)).toBe('turn');
    expect(config.capture?.nudge).toBe('enforce');
    expect(config.impact?.gate).toBe('shadow');
  });

  it('resets back to frugal: every key reads as its shipped default again', async () => {
    await writeConfig();
    await setConfigValues(ROOT, MAXIMAL);
    for (const { key } of MAXIMAL) await resetConfigValue(ROOT, key);

    const config = await loadConfig(ROOT);
    expect(isTranscriptFallbackEnabled(config)).toBe(false);
    expect(captureEventsMode(config)).toBe('off');
    expect(captureScope(config)).toBe('conversation');
    expect(await getEffectiveConfigValue(ROOT, 'capture.events')).toBe('off');
    expect(await getEffectiveConfigValue(ROOT, 'capture.scope')).toBe('conversation');
  });

  it('refuses a value outside the enum instead of storing it', async () => {
    await writeConfig();
    await expect(setConfigValue(ROOT, 'capture.events', 'always')).rejects.toThrow();
    await expect(setConfigValue(ROOT, 'capture.scope', 'session')).rejects.toThrow();
  });

  it('fallback stays inert without transcripts enabled -- the AND is the contract', async () => {
    await writeConfig();
    await setConfigValue(ROOT, 'search.transcripts.fallback', 'true');
    expect(isTranscriptFallbackEnabled(await loadConfig(ROOT))).toBe(false);
  });
});
