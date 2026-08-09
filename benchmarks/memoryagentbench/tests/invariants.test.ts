import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { scoreCr, type CrCaseResult, type CrReport } from '../facts.js';

/**
 * Checks that must pass before any number out of this harness is trusted.
 *
 * Adapted from `memory-decay-engine`'s `sanity_check.py` (MIT), whose header states the rule
 * plainly: "Checks run BEFORE any benchmark number is trusted. If any of these fail, the
 * benchmark results downstream are not to be trusted until the failure is understood."
 *
 * Its sharpest idea is not a bounds check, and it is not visible in that project's README:
 * `check_recency_baseline_ignores_recall_count` asserts that the BASELINE behaves as claimed,
 * because a win measured against a contaminated baseline is not a win. This harness has exactly
 * that shape -- every headline comparison is a `supersede-off` run against a `supersede-on` run --
 * so the same check applies directly, and the corpus section below enforces it.
 *
 * There is a live cautionary tale in this very category: another agent-memory project had to
 * issue a public correction because its headline benchmark writeups were produced by a Python
 * simulator rather than the engine they claimed to measure. Nothing in a results file says
 * whether it was produced honestly. Invariants are what stand in for that.
 *
 * These are pure unit checks over the scoring functions plus a validation pass over the committed
 * corpus. No dataset, no database, no network -- so they run in `npm run test:bench` on any
 * machine, which is the only way a gate gets run at all.
 */

const RESULTS_DIR = path.resolve('benchmarks/memoryagentbench/results');

function kase(overrides: Partial<CrCaseResult> = {}): CrCaseResult {
  return {
    question: 'Who chairs Fatah?',
    golds: ['Moshe Kahlon'],
    topContent: 'The chairperson of Fatah is Moshe Kahlon.',
    returnedContents: ['The chairperson of Fatah is Moshe Kahlon.'],
    latencyMs: 5,
    ...overrides,
  };
}

/** Every invariant that must hold of any report, however it was produced. */
function assertReportInvariants(report: CrReport, label: string): void {
  expect(report.questions, `${label}: questions must not be negative`).toBeGreaterThanOrEqual(0);
  expect(report.answered, `${label}: answered cannot exceed questions`).toBeLessThanOrEqual(report.questions);
  expect(report.emptyResults, `${label}: emptyResults cannot exceed questions`).toBeLessThanOrEqual(report.questions);
  expect(report.staleLeaks, `${label}: staleLeaks cannot exceed questions`).toBeLessThanOrEqual(report.questions);

  for (const [name, value] of [['topOneAccuracy', report.topOneAccuracy], ['anyRankAccuracy', report.anyRankAccuracy]] as const) {
    expect(value, `${label}: ${name} below 0`).toBeGreaterThanOrEqual(0);
    expect(value, `${label}: ${name} above 1`).toBeLessThanOrEqual(1);
  }

  // The relational one, and the reason a plain range check is not enough: the gold value being in
  // the TOP result is a strict subset of it being anywhere in the returned set. top1 above anyRank
  // is arithmetically impossible and means the scorer is broken, not that the system did well.
  expect(
    report.topOneAccuracy,
    `${label}: topOneAccuracy ${report.topOneAccuracy} exceeds anyRankAccuracy ${report.anyRankAccuracy}, `
    + 'which is impossible -- top-1 hits are a subset of any-rank hits, so the scorer is wrong',
  ).toBeLessThanOrEqual(report.anyRankAccuracy + 1e-9);

  // An answered question and an empty result are complements, not independent tallies.
  expect(report.answered + report.emptyResults, `${label}: answered + emptyResults must equal questions`)
    .toBe(report.questions);

  expect(report.p95LatencyMs, `${label}: p95 cannot be below p50`).toBeGreaterThanOrEqual(report.p50LatencyMs);
}

describe('scoring invariants', () => {
  it('anchors at 1.0 when the top result carries the gold, not merely within bounds', () => {
    // A bounds check passes for a scorer that always returns 0.5. A known-value anchor does not.
    const report = scoreCr([kase(), kase()], new Map());
    assertReportInvariants(report, 'all-correct');
    expect(report.topOneAccuracy).toBe(1);
    expect(report.anyRankAccuracy).toBe(1);
    expect(report.staleLeaks).toBe(0);
    expect(report.emptyResults).toBe(0);
  });

  it('anchors at 0 when nothing comes back, and counts every question as empty', () => {
    const report = scoreCr([kase({ topContent: null, returnedContents: [] })], new Map());
    assertReportInvariants(report, 'all-empty');
    expect(report.topOneAccuracy).toBe(0);
    expect(report.anyRankAccuracy).toBe(0);
    expect(report.emptyResults).toBe(1);
    expect(report.answered).toBe(0);
  });

  it('never scores a top-1 hit it did not also score at any rank', () => {
    // The gold is present but ranked second — the case that separates the two metrics.
    const report = scoreCr([kase({
      topContent: 'The chairperson of Fatah is Mahmoud Abbas.',
      returnedContents: [
        'The chairperson of Fatah is Mahmoud Abbas.',
        'The chairperson of Fatah is Moshe Kahlon.',
      ],
    })], new Map());
    assertReportInvariants(report, 'gold-at-rank-2');
    expect(report.topOneAccuracy).toBe(0);
    expect(report.anyRankAccuracy).toBe(1);
  });

  /**
   * Does the detector actually detect? `staleLeaks` is the failure conflict resolution exists to
   * prevent, so a harness whose leak detector never fires would report a clean sweep for a system
   * that leaks on every question.
   */
  it('detects a superseded value returned beside the current one', () => {
    const superseded = new Map([['moshe kahlon', ['The chairperson of Fatah is Mahmoud Abbas.']]]);
    const report = scoreCr([kase({
      returnedContents: [
        'The chairperson of Fatah is Moshe Kahlon.',
        'The chairperson of Fatah is Mahmoud Abbas.',
      ],
    })], superseded);
    assertReportInvariants(report, 'stale-leak');
    expect(report.staleLeaks).toBe(1);
    // The current value was still ranked first: a leak is not the same failure as a wrong answer,
    // and conflating them would hide which one a run actually suffered.
    expect(report.topOneAccuracy).toBe(1);
  });

  it('reports no leak when only the current value comes back', () => {
    const superseded = new Map([['moshe kahlon', ['The chairperson of Fatah is Mahmoud Abbas.']]]);
    const report = scoreCr([kase()], superseded);
    expect(report.staleLeaks).toBe(0);
  });
});

/**
 * The half that keeps working after this file is written: every committed results file is
 * re-validated, so a future run cannot land a number that violates the invariants above.
 */
describe('the committed results corpus', () => {
  const files = fs.existsSync(RESULTS_DIR)
    ? fs.readdirSync(RESULTS_DIR).filter(name => name.endsWith('.json')).sort()
    : [];

  function reportIn(value: unknown): CrReport | null {
    if (Array.isArray(value)) {
      for (const entry of value) {
        const found = reportIn(entry);
        if (found) return found;
      }
      return null;
    }
    if (value && typeof value === 'object') {
      if ('topOneAccuracy' in (value as Record<string, unknown>)) return value as unknown as CrReport;
      for (const entry of Object.values(value as Record<string, unknown>)) {
        const found = reportIn(entry);
        if (found) return found;
      }
    }
    return null;
  }

  const loaded = files.map(name => ({
    name,
    report: reportIn(JSON.parse(fs.readFileSync(path.join(RESULTS_DIR, name), 'utf8'))),
  }));

  it('is not silently empty — a corpus check over no files proves nothing', () => {
    expect(files.length).toBeGreaterThan(0);
    for (const { name, report } of loaded) {
      expect(report, `${name} carries no report object`).not.toBeNull();
    }
  });

  for (const { name, report } of loaded) {
    it(`${name} satisfies the report invariants`, () => {
      assertReportInvariants(report!, name);
    });
  }

  /**
   * The baseline-contamination check, and the reason this file exists rather than a bounds test.
   * Every headline claim here is a `supersede-off` run against a `supersede-on` run. If the
   * off run stops leaking, the comparison is against a strawman and the win is not a win —
   * which is invisible in any single file and visible only across the pair.
   */
  it('pairs every supersede-on run with an off run that leaks strictly more', () => {
    const pairs = new Map<string, { on?: CrReport; off?: CrReport }>();
    for (const { name, report } of loaded) {
      if (!report) continue;
      if (name.includes('-supersede-off')) {
        const key = name.replace('-supersede-off', '');
        pairs.set(key, { ...pairs.get(key), off: report });
      }
      if (name.includes('-supersede-on')) {
        const key = name.replace('-supersede-on', '');
        pairs.set(key, { ...pairs.get(key), on: report });
      }
    }

    expect(pairs.size, 'no supersede pairs found; the contamination check would be vacuous')
      .toBeGreaterThan(0);

    for (const [key, { on, off }] of pairs) {
      expect(on, `${key}: supersede-on run missing, so the pair proves nothing`).toBeTruthy();
      expect(off, `${key}: supersede-off run missing, so there is no baseline`).toBeTruthy();
      expect(
        off!.staleLeaks,
        `${key}: the supersede-off baseline leaked ${off!.staleLeaks} and supersede-on leaked `
        + `${on!.staleLeaks}. A baseline that leaks no more than the treatment is contaminated — `
        + 'the toggle did nothing, and any improvement claimed over it is measured against nothing.',
      ).toBeGreaterThan(on!.staleLeaks);
    }
  });
});
