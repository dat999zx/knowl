import os from 'node:os';
import { describe, expect, it } from 'vitest';
import { checkPreconditions } from '../../src/skills/preconditions.js';

describe('preconditions fail closed', () => {
  it('passes a check that holds', async () => {
    const node = process.platform === 'win32' ? 'node.exe' : 'node';
    expect(await checkPreconditions([`command_exists:${node}`], { cwd: process.cwd() })).toEqual({ ok: true });
  });

  it('refuses a check that does not hold, naming it', async () => {
    const result = await checkPreconditions(['command_exists:definitely-not-a-real-binary'], { cwd: process.cwd() });
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ failed: 'command_exists:definitely-not-a-real-binary' });
  });

  it('refuses a check it does not recognise, rather than ignoring it', async () => {
    // An unknown precondition is one that did not pass. Skipping it would let a typo disable a gate.
    const result = await checkPreconditions(['no_such_check'], { cwd: process.cwd() });
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ failed: 'no_such_check' });
  });

  it('refuses when a check cannot be evaluated at all', async () => {
    // Outside a git worktree there is no answer to "is it clean", and no answer is not a pass.
    const result = await checkPreconditions(['clean_worktree'], { cwd: os.tmpdir() });
    expect(result.ok).toBe(false);
  });
});
