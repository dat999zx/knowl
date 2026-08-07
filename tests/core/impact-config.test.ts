import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, NEW_PROJECT_CONFIG, mergeConfigDefaults } from '../../src/core/config.js';
import { CONFIG_FIELDS, getConfigField } from '../../src/cli/config/schema.js';
import { isImpactEnabled } from '../../src/store/impact-config.js';
import type { ProjectConfig } from '../../src/core/types.js';

/**
 * Change-impact detection is additive, advisory and off until someone says otherwise.
 *
 * The gate matters more than a normal feature flag because of what the subsystem does when
 * it is on: it captures read sets on every tool call and declines to record a clean task
 * finish while a certain-tier finding is unresolved. Turning that on by accident does not
 * degrade quietly -- it holds up work in a repository whose owner never heard of it.
 */

const baseConfig = (): ProjectConfig => ({
  version: 1,
  security: { rejectSecrets: true, secretPatterns: [] },
});

const withImpact = (enabled: unknown): ProjectConfig =>
  ({ ...baseConfig(), impact: { enabled: enabled as boolean } });

describe('change impact config gate', () => {
  it('is off when the config says nothing', () => {
    expect(isImpactEnabled(baseConfig())).toBe(false);
  });

  it('is off when the impact block exists but is empty', () => {
    expect(isImpactEnabled({ ...baseConfig(), impact: {} })).toBe(false);
  });

  it('is on only when explicitly set to true', () => {
    expect(isImpactEnabled(withImpact(true))).toBe(true);
  });

  it('is off when explicitly set to false', () => {
    expect(isImpactEnabled(withImpact(false))).toBe(false);
  });

  it('is off with no config at all, rather than throwing on the hook path', () => {
    expect(isImpactEnabled(undefined)).toBe(false);
    expect(isImpactEnabled({ version: 1 } as ProjectConfig)).toBe(false);
  });

  it('requires the literal true, so a hand-edited config cannot half-enable it', () => {
    // A config.json is a file people edit. Each of these is a plausible way to write "on"
    // by hand, and each one has to read as off: an ambiguous config must never switch on a
    // subsystem that gates task finishes.
    expect(isImpactEnabled(withImpact('yes'))).toBe(false);
    expect(isImpactEnabled(withImpact('true'))).toBe(false);
    expect(isImpactEnabled(withImpact(1))).toBe(false);
    expect(isImpactEnabled(withImpact(null))).toBe(false);
    expect(isImpactEnabled(withImpact({}))).toBe(false);
  });
});

describe('where the default is allowed to live', () => {
  /**
   * The regression guard for this whole lane.
   *
   * `upgradeConfigDefaults` merges DEFAULT_CONFIG into the config of every repository on
   * the machine, filling in each key the file lacks. A default written there would not be
   * a default at all -- it would be a mass write that enables the subsystem everywhere on
   * the next upgrade, with no record in any repo of who asked for it. That is why
   * `search.transcripts.enabled` is absent from DEFAULT_CONFIG too and carries its
   * `defaultValue: false` only in CONFIG_FIELDS, which nothing merges.
   */
  it('keeps impact out of DEFAULT_CONFIG, which is merged into every existing repo', () => {
    expect(DEFAULT_CONFIG.impact).toBeUndefined();
    expect(Object.keys(DEFAULT_CONFIG)).not.toContain('impact');
    // The precedent this copies, asserted so the two cannot drift apart silently.
    expect(DEFAULT_CONFIG.search?.transcripts).toBeUndefined();
  });

  it('leaves an existing repo untouched when the defaults are merged in', () => {
    const existing = baseConfig();
    const upgraded = mergeConfigDefaults(existing as Record<string, any>) as ProjectConfig;
    expect(isImpactEnabled(upgraded)).toBe(false);
    expect(upgraded.impact).toBeUndefined();
  });

  it('does not write the key into a freshly initialized repo either', () => {
    expect(NEW_PROJECT_CONFIG.impact).toBeUndefined();
    expect(isImpactEnabled(NEW_PROJECT_CONFIG)).toBe(false);
  });

  it('is settable from the CLI, defaulting to false in the editor', () => {
    // `knowl config set impact.enabled true` resolves the key through this table; an
    // unregistered key throws instead, so this is the whole opt-in path.
    const field = getConfigField('impact.enabled');
    expect(field.type).toBe('boolean');
    expect(field.defaultValue).toBe(false);
    expect(field.parse('true')).toBe(true);
    expect(field.parse('false')).toBe(false);
    expect(() => field.parse('yes')).toThrow();
    expect(CONFIG_FIELDS.filter(candidate => candidate.key === 'impact.enabled')).toHaveLength(1);
  });
});
