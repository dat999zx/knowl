import { describe, expect, it } from 'vitest';
import { existingItemsNotice, visibilityGateNotice } from '../../src/cli/workspace-visibility-notice.js';

describe('visibility gate notice', () => {
  it('says what happens, that it cannot be undone, and how to stop future writes', () => {
    const text = visibilityGateNotice('duck').join('\n');
    expect(text).toContain('"duck"');
    expect(text).toMatch(/no review step/i);
    expect(text).toMatch(/cannot be undone/i);
    expect(text).toContain('knowl workspace set --default-visibility repo');
    expect(text).toMatch(/already shared stays shared/i);
  });
});

describe('existing items notice', () => {
  it('is silent when there is nothing already private', () => {
    expect(existingItemsNotice(0)).toEqual([]);
  });

  it('names the count and prints a command that survives cmd.exe', () => {
    const text = existingItemsNotice(500).join('\n');
    expect(text).toContain('500 existing items');
    // Quoted on purpose: knowl.cmd runs through cmd.exe, which splits an unquoted comma list.
    expect(text).toContain('--category "fact,decision,goal,constraint,architecture,state,skill"');
    expect(text).toContain('--apply');
  });
});
