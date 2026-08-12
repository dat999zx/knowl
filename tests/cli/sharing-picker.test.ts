import { afterEach, describe, expect, it, vi } from 'vitest';
import type { KnowledgeCategory } from '../../src/core/types.js';

const counts = {
  fact: 359, decision: 72, goal: 7, constraint: 90,
  architecture: 101, state: 194, skill: 19,
} as Record<KnowledgeCategory, number>;

describe('pickCategories', () => {
  afterEach(() => { vi.resetModules(); vi.restoreAllMocks(); });

  it('returns null without prompting when there is no TTY', async () => {
    // A prompt that cannot be answered must not hang CI.
    vi.doMock('@clack/prompts', () => ({
      multiselect: async () => { throw new Error('must not prompt without a TTY'); },
      isCancel: () => false,
    }));

    const { pickCategories } = await import('../../src/cli/sharing-picker.js');
    expect(await pickCategories({ verb: 'promote', destination: 'acme', counts, isTTY: false })).toBeNull();
  });

  it('preticks the five worth sharing and leaves fact and state unticked', async () => {
    let initial: string[] = [];
    vi.doMock('@clack/prompts', () => ({
      multiselect: async (input: { initialValues: string[] }) => {
        initial = input.initialValues;
        return ['decision'];
      },
      isCancel: () => false,
    }));

    const { pickCategories } = await import('../../src/cli/sharing-picker.js');
    await pickCategories({ verb: 'promote', destination: 'acme', counts, isTTY: true });

    expect([...initial].sort()).toEqual(['architecture', 'constraint', 'decision', 'goal', 'skill']);
  });

  it('lists every category with its count, including a zero', async () => {
    let options: Array<{ value: string; label: string; hint?: string }> = [];
    vi.doMock('@clack/prompts', () => ({
      multiselect: async (input: { options: typeof options }) => { options = input.options; return ['decision']; },
      isCancel: () => false,
    }));

    const { pickCategories } = await import('../../src/cli/sharing-picker.js');
    await pickCategories({
      verb: 'promote', destination: 'acme',
      counts: { ...counts, goal: 0 }, isTTY: true,
    });

    // "Nothing to promote here" must be visible; a silently short list reads as a bug.
    const goal = options.find(option => option.value === 'goal');
    expect(goal).toBeDefined();
    expect(goal!.label).toContain('0');
  });

  it('explains why fact and state are unticked', async () => {
    let options: Array<{ value: string; hint?: string }> = [];
    vi.doMock('@clack/prompts', () => ({
      multiselect: async (input: { options: typeof options }) => { options = input.options; return []; },
      isCancel: () => false,
    }));

    const { pickCategories } = await import('../../src/cli/sharing-picker.js');
    await pickCategories({ verb: 'promote', destination: 'acme', counts, isTTY: true });

    expect(options.find(option => option.value === 'fact')!.hint).toBeTruthy();
    expect(options.find(option => option.value === 'decision')!.hint).toBeUndefined();
  });

  it('names the command and the destination, so the prompt says what sharing means here', async () => {
    let message = '';
    vi.doMock('@clack/prompts', () => ({
      multiselect: async (input: { message: string }) => { message = input.message; return []; },
      isCancel: () => false,
    }));

    const { pickCategories } = await import('../../src/cli/sharing-picker.js');
    await pickCategories({ verb: 'stage', destination: 'Acme Core', counts, isTTY: true });

    expect(message).toContain('stage');
    expect(message).toContain('Acme Core');
  });

  it('returns null when the user cancels', async () => {
    const CANCEL = Symbol('cancel');
    vi.doMock('@clack/prompts', () => ({
      multiselect: async () => CANCEL,
      isCancel: (value: unknown) => value === CANCEL,
    }));

    const { pickCategories } = await import('../../src/cli/sharing-picker.js');
    expect(await pickCategories({ verb: 'promote', destination: 'acme', counts, isTTY: true })).toBeNull();
  });

  it('returns an empty array when the user unticks everything, which is not a cancel', async () => {
    // Deliberately distinct from null: "I chose nothing" is an answer, and the caller reports
    // "nothing selected" rather than falling back to the no-TTY refusal.
    vi.doMock('@clack/prompts', () => ({
      multiselect: async () => [],
      isCancel: () => false,
    }));

    const { pickCategories } = await import('../../src/cli/sharing-picker.js');
    expect(await pickCategories({ verb: 'promote', destination: 'acme', counts, isTTY: true })).toEqual([]);
  });
});
