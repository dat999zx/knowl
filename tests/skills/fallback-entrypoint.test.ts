import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSkillPackage, runSkillPackage } from '../../src/skills/registry.js';
import { approveSkill } from '../../src/skills/trust.js';

const TEST_ROOT = path.resolve('./.knowl-fallback-test');

describe('fallback entrypoints', () => {
  beforeAll(async () => {
    await fs.rm(TEST_ROOT, { recursive: true, force: true }).catch(() => {});
    await fs.mkdir(TEST_ROOT, { recursive: true });
    await createSkillPackage(TEST_ROOT, {
      name: 'two-doors',
      purpose: 'probe',
      files: [
        { path: 'fail.js', content: 'process.exit(3);' },
        { path: 'mark.js', content: "import { writeFileSync } from 'node:fs';\nwriteFileSync(process.env.KNOWL_SKILL_DIR + '/ran', 'yes');" },
      ],
      entrypoints: {
        default: { type: 'script', path: 'fail.js', autoRun: true },
        fallback: { type: 'script', path: 'mark.js', autoRun: true },
      },
    });
    // Both tests remove the `ran` marker before running, so the package is always back to its
    // approved bytes at the moment of the check. `mark.js` writes inside KNOWL_SKILL_DIR, which
    // does change the hash -- a skill that edits its own package invalidates its own approval.
    await approveSkill(TEST_ROOT, 'two-doors', { approvedBy: 'test' });
  });

  afterAll(async () => {
    await fs.rm(TEST_ROOT, { recursive: true, force: true }).catch(() => {});
  });

  it('does not run the fallback unless the caller asked for it', async () => {
    const marker = path.join(TEST_ROOT, '.knowl', 'skills', 'two-doors', 'ran');
    await fs.rm(marker, { force: true }).catch(() => {});

    const result = await runSkillPackage(TEST_ROOT, 'two-doors');

    expect(result.usedEntrypoint).toBe('default');
    expect(result.attempts).toHaveLength(1);
    await expect(fs.stat(marker)).rejects.toThrow();
  });

  it('runs the fallback when the caller opts in', async () => {
    const marker = path.join(TEST_ROOT, '.knowl', 'skills', 'two-doors', 'ran');
    await fs.rm(marker, { force: true }).catch(() => {});

    const result = await runSkillPackage(TEST_ROOT, 'two-doors', 'default', [], { allowFallback: true });

    expect(result.usedEntrypoint).toBe('fallback');
    expect(result.attempts).toHaveLength(2);
    await expect(fs.stat(marker)).resolves.toBeTruthy();
  });
});
