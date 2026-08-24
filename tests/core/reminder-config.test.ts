import { describe, expect, it } from 'vitest';
import {
  areSkillNudgesEnabled, DEFAULT_DRIFT_REMINDER_EVERY, driftReminderEvery,
  isDriftBackoffEnabled, shouldSendDriftReminder,
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

describe('the backoff schedule', () => {
  /** Every drift count that fires, up to `limit`, at the default cadence. */
  const firesUpTo = (limit: number, every = DEFAULT_DRIFT_REMINDER_EVERY, backoff = true) => {
    const at: number[] = [];
    for (let drift = 1; drift <= limit; drift += 1) if (shouldSendDriftReminder(drift, every, backoff)) at.push(drift);
    return at;
  };

  it('doubles the gap after each delivery', () => {
    expect(firesUpTo(400)).toEqual([12, 36, 84, 180, 372]);
    // Which is to say the gaps are 12, 24, 48, 96, 192 -- each twice the last.
    expect(firesUpTo(400).map((n, i, all) => n - (all[i - 1] ?? 0))).toEqual([12, 24, 48, 96, 192]);
  });

  it('never goes silent, which is the whole reason it is not a cap', () => {
    // The heaviest session in the measured archive drifted ~2,900 events. A cap of 3 would have
    // stopped speaking at event 36 and never spoken again over the remaining 2,868.
    expect(firesUpTo(2904).length).toBe(7);
    expect(firesUpTo(2904).at(-1)).toBe(1524);
  });

  it('repeats forever at the fixed cadence when backoff is off', () => {
    expect(firesUpTo(60, DEFAULT_DRIFT_REMINDER_EVERY, false)).toEqual([12, 24, 36, 48, 60]);
  });

  it('scales the whole schedule with the cadence, and 0 silences it', () => {
    expect(firesUpTo(100, 5)).toEqual([5, 15, 35, 75]);
    expect(firesUpTo(500, 0)).toEqual([]);
  });

  it('is off at drift 0 whatever else is set -- a fresh counter is not a delivery', () => {
    expect(shouldSendDriftReminder(0, 12, true)).toBe(false);
    expect(shouldSendDriftReminder(0, 12, false)).toBe(false);
  });

  it('reads on unless explicitly false', () => {
    expect(isDriftBackoffEnabled(undefined)).toBe(true);
    expect(isDriftBackoffEnabled(config({}))).toBe(true);
    expect(isDriftBackoffEnabled(config({ driftBackoff: false }))).toBe(false);
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
