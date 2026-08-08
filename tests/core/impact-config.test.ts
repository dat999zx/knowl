import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, NEW_PROJECT_CONFIG, mergeConfigDefaults } from '../../src/core/config.js';
import { CONFIG_FIELDS, getConfigField } from '../../src/cli/config/schema.js';
import { impactGateMode, isImpactEnabled } from '../../src/store/impact-config.js';
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

/**
 * The write gate's own switch, separate from detection's.
 *
 * They are separated because the risks differ in kind rather than degree. Detection spends
 * context and can be wrong in a card; the gate refuses a tool call, and being wrong there costs
 * somebody their working session. So arming it is a second, deliberate act, and it starts in
 * `shadow` -- computing the verdict and withholding the refusal -- until plan §9's
 * ≥95%-over-≥40-findings bar has actually been measured.
 */
const withGate = (impact: Record<string, unknown>): ProjectConfig =>
  ({ ...baseConfig(), impact: impact as ProjectConfig['impact'] });

describe('write gate mode', () => {
  it('is off when nothing is configured', () => {
    expect(impactGateMode(undefined)).toBe('off');
    expect(impactGateMode(baseConfig())).toBe('off');
    expect(impactGateMode(withGate({}))).toBe('off');
  });

  it('reads shadow and enforce when detection is on', () => {
    expect(impactGateMode(withGate({ enabled: true, gate: 'shadow' }))).toBe('shadow');
    expect(impactGateMode(withGate({ enabled: true, gate: 'enforce' }))).toBe('enforce');
    expect(impactGateMode(withGate({ enabled: true, gate: 'off' }))).toBe('off');
  });

  /**
   * Detection off is gate off, whatever the gate key says.
   *
   * The gate's entire input is the open findings the detector writes, so an armed gate over a
   * disabled detector is not a stricter configuration -- it is one that can never fire while
   * reporting that it can. Deciding it here means one place answers the question instead of
   * every call site re-deriving it and one of them getting it wrong.
   */
  it('is off when the gate is armed but detection is not', () => {
    expect(impactGateMode(withGate({ enabled: false, gate: 'enforce' }))).toBe('off');
    expect(impactGateMode(withGate({ gate: 'enforce' }))).toBe('off');
    expect(impactGateMode(withGate({ enabled: 'yes', gate: 'enforce' }))).toBe('off');
  });

  it('treats anything unrecognised as off', () => {
    // Same rule `isImpactEnabled` follows, and for a sharper reason: a malformed value here does
    // not merely switch on machinery nobody asked for, it can take away somebody's ability to
    // write a file. A config.json is a file people edit by hand.
    expect(impactGateMode(withGate({ enabled: true, gate: 'yes' }))).toBe('off');
    expect(impactGateMode(withGate({ enabled: true, gate: 'ENFORCE' }))).toBe('off');
    expect(impactGateMode(withGate({ enabled: true, gate: true }))).toBe('off');
    expect(impactGateMode(withGate({ enabled: true, gate: 1 }))).toBe('off');
    expect(impactGateMode(withGate({ enabled: true, gate: null }))).toBe('off');
    expect(impactGateMode(withGate({ enabled: true }))).toBe('off');
  });

  it('leaves isImpactEnabled alone', () => {
    // The two switches answer different questions, so arming the gate must not imply detection
    // and enabling detection must not imply a gate.
    expect(isImpactEnabled(withGate({ enabled: true, gate: 'enforce' }))).toBe(true);
    expect(isImpactEnabled(withGate({ gate: 'enforce' }))).toBe(false);
    expect(impactGateMode(withGate({ enabled: true }))).toBe('off');
  });

  it('stays out of DEFAULT_CONFIG, like every other key in this block', () => {
    // The same mass-write hazard as `impact.enabled`, one step worse: a default written there
    // would arm a write gate in every repository on the machine at the next upgrade.
    expect(DEFAULT_CONFIG.impact).toBeUndefined();
    expect(NEW_PROJECT_CONFIG.impact).toBeUndefined();
  });

  it('is settable from the CLI as an enum, defaulting to off', () => {
    const field = getConfigField('impact.gate');
    expect(field.type).toBe('enum');
    expect(field.values).toEqual(['off', 'shadow', 'enforce']);
    expect(field.defaultValue).toBe('off');
    expect(field.parse('shadow')).toBe('shadow');
    expect(field.parse('enforce')).toBe('enforce');
    expect(() => field.parse('true')).toThrow();
    expect(() => field.parse('ENFORCE')).toThrow();
    expect(CONFIG_FIELDS.filter(candidate => candidate.key === 'impact.gate')).toHaveLength(1);
  });
});
