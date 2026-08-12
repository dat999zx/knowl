import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CloudWorkspace } from '../../src/cloud/api-client.js';

const WORKSPACES: CloudWorkspace[] = [
  { id: 'ws-1', name: 'Acme Core', role: 'owner' },
  { id: 'ws-2', name: 'Acme Research', role: 'reader' },
];

describe('pickWorkspace', () => {
  afterEach(() => { vi.resetModules(); vi.restoreAllMocks(); });

  it('returns null without prompting when there is no TTY', async () => {
    // A picker that blocks in CI is worse than the error it replaces.
    vi.doMock('@clack/prompts', () => ({
      select: async () => { throw new Error('must not prompt without a TTY'); },
      isCancel: () => false,
    }));

    const { pickWorkspace } = await import('../../src/cli/cloud-picker.js');
    expect(await pickWorkspace(WORKSPACES, { isTTY: false })).toBeNull();
  });

  it('returns the chosen id', async () => {
    vi.doMock('@clack/prompts', () => ({
      select: async () => 'ws-2',
      isCancel: () => false,
    }));

    const { pickWorkspace } = await import('../../src/cli/cloud-picker.js');
    expect(await pickWorkspace(WORKSPACES, { isTTY: true })).toBe('ws-2');
  });

  it('returns null when the user cancels', async () => {
    const CANCEL = Symbol('cancel');
    vi.doMock('@clack/prompts', () => ({
      select: async () => CANCEL,
      isCancel: (value: unknown) => value === CANCEL,
    }));

    const { pickWorkspace } = await import('../../src/cli/cloud-picker.js');
    expect(await pickWorkspace(WORKSPACES, { isTTY: true })).toBeNull();
  });

  it('labels each option with its role, so a reader is not surprised by a refused push', async () => {
    let options: unknown[] = [];
    vi.doMock('@clack/prompts', () => ({
      select: async (input: { options: unknown[] }) => { options = input.options; return 'ws-1'; },
      isCancel: () => false,
    }));

    const { pickWorkspace } = await import('../../src/cli/cloud-picker.js');
    await pickWorkspace(WORKSPACES, { isTTY: true });

    expect(options).toEqual([
      { value: 'ws-1', label: 'Acme Core', hint: 'owner' },
      { value: 'ws-2', label: 'Acme Research', hint: 'reader' },
    ]);
  });
});
