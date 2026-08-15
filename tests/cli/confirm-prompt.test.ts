import { afterEach, describe, expect, it, vi } from 'vitest';

describe('askConfirm', () => {
  afterEach(() => { vi.resetModules(); vi.restoreAllMocks(); });

  it('reports no-tty without prompting, so silence is never read as consent', async () => {
    vi.doMock('@clack/prompts', () => ({
      select: async () => { throw new Error('must not prompt without a TTY'); },
      isCancel: () => false,
    }));

    const { askConfirm } = await import('../../src/cli/confirm-prompt.js');
    expect(await askConfirm('Collect it?', { isTTY: false })).toBe('no-tty');
  });

  it('confirms when Accept is chosen', async () => {
    vi.doMock('@clack/prompts', () => ({
      select: async () => 'confirmed',
      isCancel: () => false,
    }));

    const { askConfirm } = await import('../../src/cli/confirm-prompt.js');
    expect(await askConfirm('Collect it?', { isTTY: true })).toBe('confirmed');
  });

  it('declines when Decline is chosen', async () => {
    vi.doMock('@clack/prompts', () => ({
      select: async () => 'declined',
      isCancel: () => false,
    }));

    const { askConfirm } = await import('../../src/cli/confirm-prompt.js');
    expect(await askConfirm('Collect it?', { isTTY: true })).toBe('declined');
  });

  it('treats a cancel as declined, not as an accept', async () => {
    // Ctrl-C at the menu is the reflex answer of somebody who did not mean to be here. clack
    // returns a symbol rather than one of the option values, and anything that is not an explicit
    // Accept has to land on the safe side.
    const CANCEL = Symbol('cancel');
    vi.doMock('@clack/prompts', () => ({
      select: async () => CANCEL,
      isCancel: (value: unknown) => value === CANCEL,
    }));

    const { askConfirm } = await import('../../src/cli/confirm-prompt.js');
    expect(await askConfirm('Collect it?', { isTTY: true })).toBe('declined');
  });

  it('offers Accept and Decline, with Decline preselected so a bare Enter spends nothing', async () => {
    let input: { message?: string; options?: unknown[]; initialValue?: string } = {};
    vi.doMock('@clack/prompts', () => ({
      select: async (received: { message: string; options: unknown[]; initialValue?: string }) => {
        input = received;
        return 'declined';
      },
      isCancel: () => false,
    }));

    const { askConfirm } = await import('../../src/cli/confirm-prompt.js');
    await askConfirm('Collect it? This can only be done once.', {
      isTTY: true,
      acceptHint: 'import the atoms and spend the code',
      declineHint: 'the code still works until it expires',
    });

    expect(input.message).toBe('Collect it? This can only be done once.');
    expect(input.initialValue).toBe('declined');
    expect(input.options).toEqual([
      { value: 'declined', label: 'Decline', hint: 'the code still works until it expires' },
      { value: 'confirmed', label: 'Accept', hint: 'import the atoms and spend the code' },
    ]);
  });
});
