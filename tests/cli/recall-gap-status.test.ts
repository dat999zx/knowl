import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { formatStatusReport } from '../../src/cli/status-report.js';
import { DEFAULT_CONFIG } from '../../src/core/config.js';

const ROOT = path.resolve('./.knowl-recall-gap-status-test');
const base = {
  project: { id: 'local', name: 'recall-gap', rootPath: ROOT } as never,
  config: DEFAULT_CONFIG,
  activeItems: [], supersededItems: [], deprecatedItems: [], commits: [],
};

describe('recall gap in knowl status', () => {
  it('renders nothing on a store that has observed no tool touches', () => {
    const report = formatStatusReport({ ...base, recall: { touches: 0, held: 0, retrieved: 0, missed: 0 } });
    expect(report).not.toMatch(/RECALL/);
  });

  it('reports the gap as a share of touches where the store held something', () => {
    const report = formatStatusReport({
      ...base,
      recall: { touches: 340, held: 91, retrieved: 62, missed: 29 },
    });
    expect(report).toMatch(/RECALL GAP/);
    expect(report).toMatch(/340/);
    expect(report).toMatch(/91/);
    // 29 of 91 held touches were missed.
    expect(report).toMatch(/29 \(32%\)/);
  });

  it('does not divide by zero when touches were observed but nothing was ever held', () => {
    const report = formatStatusReport({
      ...base,
      recall: { touches: 40, held: 0, retrieved: 0, missed: 0 },
    });
    expect(report).toMatch(/RECALL GAP/);
    expect(report).not.toMatch(/NaN/);
  });
});
