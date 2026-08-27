import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { formatStatusReport } from '../../src/cli/status-report.js';
import { DEFAULT_CONFIG } from '../../src/core/config.js';
import type { UnrestatedReport } from '../../src/store/unrestated.js';

const ROOT = path.resolve('./.knowl-unrestated-status-test');
const base = {
  project: { id: 'local', name: 'unrestated', rootPath: ROOT } as never,
  config: DEFAULT_CONFIG,
  activeItems: [], supersededItems: [], deprecatedItems: [], commits: [],
};

const report = (overrides: Partial<UnrestatedReport> = {}): UnrestatedReport => ({
  rows: [
    { category: 'constraint', count: 41, medianDays: 36.3 },
    { category: 'fact', count: 281, medianDays: 21.7 },
  ],
  outliers: [
    { title: 'Secrets never leave the machine', category: 'constraint', days: 53.4, ratio: 3.4 },
    { title: 'Ranking beats flagging on a young store', category: 'decision', days: 51.2, ratio: 1.5 },
  ],
  proseCount: 520, codeCount: 442, prosePathOnly: 34, storeHistoryDays: 53.4,
  ...overrides,
});

describe('un-restated claims in knowl status', () => {
  it('renders nothing when no active item carries an open assertion', () => {
    expect(formatStatusReport({ ...base, unrestated: undefined })).not.toMatch(/UN-RESTATED/);
    expect(formatStatusReport({ ...base, unrestated: report({ rows: [] }) })).not.toMatch(/UN-RESTATED/);
  });

  it("names the claims furthest past their own category's cadence, worst first", () => {
    const out = formatStatusReport({ ...base, unrestated: report() });
    expect(out).toMatch(/Furthest past its own category's cadence:/);
    expect(out).toMatch(/3\.4x p50\s+53\.4d\s+constraint\s+Secrets never leave the machine/);
    expect(out.indexOf('Secrets never leave')).toBeLessThan(out.indexOf('Ranking beats flagging'));
  });

  it('ranks on the cadence ratio, not on age, so a seed cohort does not fill the list', () => {
    // The defect the ratio exists for: every claim in a seeded store shares one age. Ranked on
    // age these tie and the list is an arbitrary slice of the seed; ranked on the ratio the
    // architecture note at three times its category's median sorts above the ordinary goal.
    const out = formatStatusReport({ ...base, unrestated: report({ outliers: [
      { title: 'three cadences past due', category: 'architecture', days: 54.5, ratio: 3 },
      { title: 'ordinary for a goal', category: 'goal', days: 54.5, ratio: 1.2 },
    ] }) });
    expect(out.indexOf('three cadences past due')).toBeLessThan(out.indexOf('ordinary for a goal'));
  });

  it('prints no per-category oldest column, which was the store age repeated', () => {
    // The reshape this file guards. `oldest` per category is `storeHistoryDays` in whichever
    // category happens to hold the corpus's oldest item, and a duplicate of the p50 row's own
    // ceiling in the rest -- seven copies of one number reading as seven findings. A category
    // row carries exactly one day figure now.
    const line = formatStatusReport({ ...base, unrestated: report() })
      .split('\n').find(row => row.includes('constraint  n='));
    expect(line).toBeDefined();
    expect(line!.match(/\d+\.\d+d/g)).toHaveLength(1);
  });

  it('truncates a title rather than letting a 200-char claim wrap the block', () => {
    const long = 'x'.repeat(200);
    const out = formatStatusReport({
      ...base,
      unrestated: report({ outliers: [{ title: long, category: 'decision', days: 53.4, ratio: 1.5 }] }),
    });
    expect(out).not.toMatch(new RegExp(long));
    expect(out).toMatch(/x{40,}\.\.\./);
  });

  it('prints the store history beside the list, because it bounds every age in it', () => {
    // 53.4d is the store's age. Without the bound printed, a reader takes an age for a measured
    // tail rather than the ceiling it is pinned to.
    expect(formatStatusReport({ ...base, unrestated: report() })).toMatch(/Store history is 53\.4d/);
  });
});
