import { describe, expect, it } from 'vitest';
import { importOwnershipNotice } from '../../src/cli/import-ownership-notice.js';

describe('the import ownership notice', () => {
  it('says nothing when the file was trusted, because nothing was decided', () => {
    // A file naming this repo's own workspace is the ordinary sync path. Narrating it would
    // train people to skip the one case that matters.
    expect(importOwnershipNotice('trusted')).toEqual([]);
  });

  it('warns that attributed items cannot be shared from here, and names the way out', () => {
    const lines = importOwnershipNotice('attributed').join('\n');
    // The consequence, not the mechanism: the counts already told them items landed.
    expect(lines).toMatch(/not.*(this repo|yours)|another store/i);
    expect(lines).toMatch(/promote/i);
    expect(lines).toContain('--mine');
  });

  it('confirms a claim took effect and that it did not publish anything', () => {
    const lines = importOwnershipNotice('claimed').join('\n');
    expect(lines).toMatch(/--mine/);
    // The half --mine deliberately does not assert. Someone who believes a claim republished
    // their old workspace visibility would be wrong in the direction that leaks.
    expect(lines).toMatch(/private|not published|promote/i);
  });
});
