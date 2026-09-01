import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { formatStatusReport } from '../../src/cli/status-report.js';
import { DEFAULT_CONFIG } from '../../src/core/config.js';

const ROOT = path.resolve('./.knowl-shadow-gate-status-test');
const base = {
  project: { id: 'local', name: 'shadow-gate', rootPath: ROOT } as never,
  config: DEFAULT_CONFIG,
  activeItems: [], supersededItems: [], deprecatedItems: [], commits: [],
};

/**
 * The shadow gate's verdict, in the one place a developer would look for it.
 *
 * `shadowGatePrecision` computed exactly the number plan §9's bar is written against, and
 * nothing imported it -- so shadow mode recorded withheld refusals into a table whose verdict no
 * command could print. A measurement nobody can read cannot promote or retire the thing it
 * measures, which makes an unsurfaced precision figure equivalent to not measuring at all.
 */
describe('shadow write gate in knowl status', () => {
  it('renders nothing on a store whose gate has never withheld a refusal', () => {
    const report = formatStatusReport({
      ...base,
      shadowGate: { withheld: 0, adjudicated: 0, falsePositives: 0, precision: null },
    });
    // Not a row of zeros: such a repo has not measured 0%, it has measured nothing.
    expect(report).not.toMatch(/WRITE GATE/);
  });

  it('never renders a percentage before anything has been adjudicated', () => {
    const report = formatStatusReport({
      ...base,
      shadowGate: { withheld: 12, adjudicated: 0, falsePositives: 0, precision: null },
    });

    expect(report).toMatch(/WRITE GATE \(shadow\)/);
    expect(report).toMatch(/Refusals withheld:\s+12/);
    expect(report).toMatch(/not yet measured/);
    // Null is not zero. Rendering it as 0.0% or 100% would both be inventions, and the second
    // would let an untouched install look like it had cleared a bar it never measured against.
    expect(report).not.toMatch(/%/);
    expect(report).not.toMatch(/NaN/);
    // It names the one command that moves the number.
    expect(report).toMatch(/knowl_impact/);
  });

  it('prints the bar beside the number, and says it is not cleared', () => {
    const report = formatStatusReport({
      ...base,
      shadowGate: { withheld: 60, adjudicated: 48, falsePositives: 6, precision: 1 - 6 / 48 },
    });

    expect(report).toMatch(/Precision:\s+87\.5% \(6 false positive\(s\)\)/);
    // A precision figure alone invites "87% sounds fine"; against the bar it reads as what it is.
    expect(report).toMatch(/≥95% over ≥40 adjudicated — not cleared/);
  });

  it('says cleared only when both halves of the bar are met', () => {
    const report = formatStatusReport({
      ...base,
      shadowGate: { withheld: 70, adjudicated: 50, falsePositives: 1, precision: 1 - 1 / 50 },
    });

    expect(report).toMatch(/98\.0%/);
    expect(report).toMatch(/— cleared/);
  });

  it('does not call a small perfect sample cleared, and says what would decide it', () => {
    // 100% over three findings is not evidence, and this block has to say so rather than look
    // like a pass. The two halves of the bar fail differently and are reported separately.
    const report = formatStatusReport({
      ...base,
      shadowGate: { withheld: 5, adjudicated: 3, falsePositives: 0, precision: 1 },
    });

    expect(report).toMatch(/100\.0%/);
    expect(report).toMatch(/— not cleared/);
    expect(report).toMatch(/37 more adjudicated finding\(s\) would decide it/);
  });

  it('does not ask for a bigger sample when precision itself is what is failing', () => {
    // Telling someone below the precision bar to adjudicate more is advice to gather more
    // evidence for a verdict already reached.
    const report = formatStatusReport({
      ...base,
      shadowGate: { withheld: 20, adjudicated: 10, falsePositives: 5, precision: 0.5 },
    });

    expect(report).toMatch(/— not cleared/);
    expect(report).not.toMatch(/would decide it/);
  });
});
