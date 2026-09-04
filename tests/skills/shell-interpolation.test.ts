import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSkillPackage, runSkillPackage } from '../../src/skills/registry.js';
import { approveSkill } from '../../src/skills/trust.js';
import { interpolate } from '../../src/skills/bindings.js';

const TEST_ROOT = path.resolve('./.knowl-shellinterp-test');

/**
 * A bound input reaching a shell entrypoint would be syntax, not a value.
 *
 * The rule already existed for runtime arguments -- a shell entrypoint refuses them because "no
 * quoting is correct for both cmd.exe and POSIX shells". Interpolation arrived later, with global
 * playbooks, and carries the same hazard with a sharper edge: a binding comes from a PROJECT's
 * config, so without this a repository could decide what an already-approved global playbook runs,
 * and approval would stop covering everything that determines the command.
 */
describe('shell entrypoints and bound inputs', () => {
  beforeAll(async () => {
    await fs.rm(TEST_ROOT, { recursive: true, force: true }).catch(() => {});
    await fs.mkdir(TEST_ROOT, { recursive: true });
    await createSkillPackage(TEST_ROOT, {
      name: 'deployer',
      purpose: 'probe',
      files: [{ path: 'note.md', content: 'probe' }],
      entrypoints: {
        default: { type: 'shell', command: 'echo ${inputs.target}', autoRun: true },
      },
    });
    await approveSkill(TEST_ROOT, 'deployer', { approvedBy: 'test' });
  });

  afterAll(async () => {
    await fs.rm(TEST_ROOT, { recursive: true, force: true }).catch(() => {});
  });

  it('refuses to run, naming the two routes that are safe', async () => {
    await expect(runSkillPackage(TEST_ROOT, 'deployer')).rejects.toThrow(
      /cannot interpolate inputs safely/,
    );
  });

  it('names the environment and the script entrypoint, since the refusal must leave a way through', async () => {
    const failure = await runSkillPackage(TEST_ROOT, 'deployer').catch(error => String(error.message));
    expect(failure).toContain('KNOWL_SKILL_INPUT_');
    expect(failure).toContain('script entrypoint');
  });

  it('is worth refusing: interpolation itself cannot make a value safe for a shell', () => {
    // Not a flaw in `interpolate` -- there is no correct answer for it to give. `${inputs.*}` is
    // the only form it substitutes and an unbound reference throws, but a BOUND value is inserted
    // verbatim, and no escaping is right for cmd.exe and POSIX shells at once. Which is why the
    // fix is refusing the combination rather than quoting inside it.
    const bound = { target: 'staging; echo pwned' };
    expect(interpolate(['echo ${inputs.target}'], bound)[0]).toBe('echo staging; echo pwned');
  });

  it('still substitutes into a script entrypoint, where arguments are an array', () => {
    // The documented shape, and the reason the refusal above costs nothing: an args array is
    // handed to the process without a shell parsing it, so a metacharacter is a character.
    const bound = { target: 'staging; echo pwned' };
    expect(interpolate(['deploy', '${inputs.target}'], bound)).toEqual(['deploy', 'staging; echo pwned']);
  });
});
