import { describe, expect, it } from 'vitest';
import { formatCrossRepoNotice } from '../../src/cli/cross-repo-notice.js';

describe('cross-repo notice for the terminal', () => {
  it('names the repo, the item, and that it cannot be changed from here', () => {
    const [line] = formatCrossRepoNotice([
      { repo: 'web', id: 'web-9', title: 'Wire format is JSON', kind: 'duplicate' },
    ]);
    expect(line).toContain('"web"');
    expect(line).toContain('web-9');
    expect(line).toContain('Wire format is JSON');
    expect(line).toMatch(/cannot be changed from here/i);
  });

  it('says contradicts for a conflict and overlaps for a duplicate', () => {
    const [conflict] = formatCrossRepoNotice([
      { repo: 'api', id: 'a1', title: 'T', kind: 'conflict' },
    ]);
    const [duplicate] = formatCrossRepoNotice([
      { repo: 'api', id: 'a1', title: 'T', kind: 'duplicate' },
    ]);
    expect(conflict).toContain('contradicts');
    expect(duplicate).toContain('overlaps');
  });

  it('includes the role and the lineage marker when the peer is kin', () => {
    const [line] = formatCrossRepoNotice([
      { repo: 'duck', id: 'd1', title: 'T', kind: 'conflict', kin: true, role: 'the other fork' },
    ]);
    expect(line).toContain('the other fork');
    expect(line).toMatch(/shares this repo's lineage/i);
  });

  it('omits the lineage marker for an unrelated repo', () => {
    const [line] = formatCrossRepoNotice([
      { repo: 'other', id: 'o1', title: 'T', kind: 'duplicate' },
    ]);
    expect(line).not.toMatch(/lineage/i);
  });

  it('prints nothing when there is no overlap', () => {
    expect(formatCrossRepoNotice()).toEqual([]);
    expect(formatCrossRepoNotice([])).toEqual([]);
  });
});
