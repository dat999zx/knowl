import { describe, expect, it } from 'vitest';
import {
  areSkillNudgesEnabled, DEFAULT_DRIFT_REMINDER_EVERY, driftReminderEvery,
} from '../../src/core/config.js';
import type { ProjectConfig } from '../../src/core/types.js';

/**
 * Both keys default ON, which is the opposite of every other switch in the config surface, so
 * the property worth pinning is that ABSENCE reads as on. A `=== true` predicate would have
 * silently disabled two shipped features for every repository that never set the key.
 *
 * The hook path is the caller, so a malformed value must degrade to today's behaviour rather
 * than throw: a bad config should not fail a tool call.
 */

const config = (reminders: unknown): ProjectConfig => ({ reminders } as unknown as ProjectConfig);

describe('reminders.driftEvery', () => {
  it('defaults to the shipped cadence when unset, empty, or absent entirely', () => {
    expect(driftReminderEvery(undefined)).toBe(DEFAULT_DRIFT_REMINDER_EVERY);
    expect(driftReminderEvery(null)).toBe(DEFAULT_DRIFT_REMINDER_EVERY);
    expect(driftReminderEvery({} as ProjectConfig)).toBe(DEFAULT_DRIFT_REMINDER_EVERY);
    expect(driftReminderEvery(config({}))).toBe(DEFAULT_DRIFT_REMINDER_EVERY);
  });

  it('takes a whole number, and 0 as the off switch', () => {
    expect(driftReminderEvery(config({ driftEvery: 24 }))).toBe(24);
    expect(driftReminderEvery(config({ driftEvery: 1 }))).toBe(1);
    expect(driftReminderEvery(config({ driftEvery: 0 }))).toBe(0);
  });

  it('falls back rather than throwing on a value the hook path must not choke on', () => {
    for (const bad of [-1, 2.5, NaN, Infinity, '12', true, null]) {
      expect(driftReminderEvery(config({ driftEvery: bad })), `driftEvery: ${String(bad)}`)
        .toBe(DEFAULT_DRIFT_REMINDER_EVERY);
    }
  });
});

describe('reminders.skills', () => {
  it('is on unless explicitly false', () => {
    expect(areSkillNudgesEnabled(undefined)).toBe(true);
    expect(areSkillNudgesEnabled(null)).toBe(true);
    expect(areSkillNudgesEnabled({} as ProjectConfig)).toBe(true);
    expect(areSkillNudgesEnabled(config({}))).toBe(true);
    expect(areSkillNudgesEnabled(config({ skills: true }))).toBe(true);
    expect(areSkillNudgesEnabled(config({ skills: false }))).toBe(false);
  });
});
