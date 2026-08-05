import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  createSkillPackage,
  listSkillPackages,
  readSkillPackage,
  runSkillPackage,
} from '../../src/skills/registry.js';
import { approveSkill } from '../../src/skills/trust.js';

const TEST_ROOT = path.resolve('./.knowl-skill-registry-test');

// The canonical script example here used to be `run.cmd`. That was not a neutral choice of
// fixture: cmd.exe re-parses its argv under rules Node's quoting does not satisfy
// (BatBadBut / CVE-2024-24576), so every one of these tests was exercising the injectable
// path and calling it the supported one. `.js` runs through argv with no shell at all.
describe('Skill Registry', () => {
  beforeAll(async () => {
    await fs.rm(TEST_ROOT, { recursive: true, force: true }).catch(() => {});
    await fs.mkdir(path.join(TEST_ROOT, '.knowl'), { recursive: true });
  });

  afterAll(async () => {
    await fs.rm(TEST_ROOT, { recursive: true, force: true }).catch(() => {});
  });

  it('creates, lists, and reads a file-backed skill package', async () => {
    await createSkillPackage(TEST_ROOT, {
      name: 'run_app',
      purpose: 'Start the app locally',
      markdown: '# Run App\n\nUse this to start the app.\n',
      files: [
        {
          path: 'run.js',
          content: "console.log('run-app');\n",
        },
      ],
      entrypoints: {
        default: {
          type: 'script',
          path: 'run.js',
          autoRun: true,
        },
      },
    });

    const listed = await listSkillPackages(TEST_ROOT);
    expect(listed).toHaveLength(1);
    expect(listed[0].name).toBe('run_app');
    expect(listed[0].purpose).toBe('Start the app locally');

    const read = await readSkillPackage(TEST_ROOT, 'run_app');
    expect(read.manifest.name).toBe('run_app');
    expect(read.manifest.entrypoints.default?.type).toBe('script');
    expect(read.markdown).toContain('# Run App');
    await expect(fs.access(path.join(TEST_ROOT, '.knowl', 'skills', 'run_app', 'run.js'))).resolves.toBeUndefined();

    // Execution now requires a human-pinned approval of these exact bytes. Approved here, at
    // the end of creation, so the later run tests exercise what they mean to rather than the
    // trust refusal.
    await approveSkill(TEST_ROOT, 'run_app', { approvedBy: 'test' });
  });

  it('runs the default script entrypoint', async () => {
    const result = await runSkillPackage(TEST_ROOT, 'run_app');
    expect(result.exitCode).toBe(0);
    expect(result.usedEntrypoint).toBe('default');
    expect(result.stdout).toContain('run-app');
  });

  it('reports the command it actually ran', async () => {
    const result = await runSkillPackage(TEST_ROOT, 'run_app');
    expect(result.command).toContain('run.js');
    expect(result.attempts[0].command).toBe(result.command);
  });

  it('falls back to a shell command when the default script fails', async () => {
    await createSkillPackage(TEST_ROOT, {
      name: 'fallback_skill',
      purpose: 'Fallback shell test',
      markdown: '# Fallback Skill\n',
      files: [
        {
          path: 'run.js',
          content: 'process.exit(9);\n',
        },
      ],
      entrypoints: {
        default: {
          type: 'script',
          path: 'run.js',
          autoRun: true,
        },
        fallback: {
          type: 'shell',
          command: `${process.execPath} -e "console.log('fallback-ok')"`,
          autoRun: true,
        },
      },
    });

    await approveSkill(TEST_ROOT, 'fallback_skill', { approvedBy: 'test' });

    const result = await runSkillPackage(TEST_ROOT, 'fallback_skill', 'default', [], { allowFallback: true });
    expect(result.exitCode).toBe(0);
    expect(result.usedEntrypoint).toBe('fallback');
    expect(result.stdout).toContain('fallback-ok');
  });

  it('rejects unsafe skill names and file paths', async () => {
    await expect(createSkillPackage(TEST_ROOT, {
      name: '../escape',
      purpose: 'bad',
      markdown: '# Bad\n',
      entrypoints: {
        default: {
          type: 'shell',
          command: 'echo nope',
          autoRun: true,
        },
      },
    })).rejects.toThrow(/Invalid skill name/);

    await expect(createSkillPackage(TEST_ROOT, {
      name: 'bad_path',
      purpose: 'bad',
      markdown: '# Bad\n',
      files: [
        {
          path: '../escape.js',
          content: "console.log('nope');\n",
        },
      ],
      entrypoints: {
        default: {
          type: 'script',
          path: '../escape.js',
          autoRun: true,
        },
      },
    })).rejects.toThrow(/Invalid skill file path/);
  });

  // K-69 — BatBadBut. `cmd.exe /d /c script.cmd <args>` re-parses the command line after
  // Node has quoted it for MSVCRT, and cmd.exe does not honour `\"`.
  describe('batch entrypoints (K-69)', () => {
    it('refuses to create a .cmd or .bat entrypoint', async () => {
      await expect(createSkillPackage(TEST_ROOT, {
        name: 'batch_skill',
        purpose: 'batch',
        markdown: '# Batch\n',
        files: [{ path: 'run.cmd', content: '@echo off\r\necho hi\r\n' }],
        entrypoints: {
          default: { type: 'script', path: 'run.cmd', autoRun: true },
        },
      })).rejects.toThrow(/\.cmd/);

      await expect(createSkillPackage(TEST_ROOT, {
        name: 'batch_skill_bat',
        purpose: 'batch',
        markdown: '# Batch\n',
        entrypoints: {
          default: { type: 'script', path: 'run.bat', autoRun: true },
        },
      })).rejects.toThrow(/\.bat/);
    });

    it('refuses to run a batch entrypoint written before the guard existed', async () => {
      const skillDir = path.join(TEST_ROOT, '.knowl', 'skills', 'legacy_batch');
      await fs.mkdir(skillDir, { recursive: true });
      await fs.writeFile(path.join(skillDir, 'SKILL.md'), '# Legacy\n', 'utf-8');
      await fs.writeFile(path.join(skillDir, 'run.cmd'), '@echo off\r\necho legacy\r\n', 'utf-8');
      await fs.writeFile(
        path.join(skillDir, 'skill.json'),
        JSON.stringify({
          name: 'legacy_batch',
          purpose: 'written before the guard',
          triggers: [],
          entrypoints: { default: { type: 'script', path: 'run.cmd', autoRun: true } },
          version: 1,
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        }, null, 2),
        'utf-8'
      );

      // Approved, so the refusal under test is the .cmd guard rather than the trust check --
      // the extension is resolved inside runScript, downstream of approval.
      await approveSkill(TEST_ROOT, 'legacy_batch', { approvedBy: 'test' });

      await expect(runSkillPackage(TEST_ROOT, 'legacy_batch')).rejects.toThrow(/\.cmd/);

      // Still readable, so the author can see what needs repairing.
      const read = await readSkillPackage(TEST_ROOT, 'legacy_batch');
      expect(read.manifest.entrypoints.default?.type).toBe('script');
    });

    it('passes caller arguments literally instead of through a command line', async () => {
      await createSkillPackage(TEST_ROOT, {
        name: 'echo_args',
        purpose: 'echo args',
        markdown: '# Echo\n',
        files: [
          {
            path: 'run.js',
            content: "console.log('ARGS:' + JSON.stringify(process.argv.slice(2)));\n",
          },
        ],
        entrypoints: {
          default: { type: 'script', path: 'run.js', autoRun: true },
        },
      });

      await approveSkill(TEST_ROOT, 'echo_args', { approvedBy: 'test' });

      const payload = 'x" & echo INJECTED & echo ';
      const result = await runSkillPackage(TEST_ROOT, 'echo_args', 'default', [payload, '%CD%']);
      expect(result.exitCode).toBe(0);

      // The payload contains the word INJECTED, so its presence proves nothing. What proves
      // it is that the script produced exactly one line and received both arguments byte for
      // byte: no second command ran, and `%CD%` was not expanded.
      const lines = result.stdout.trim().split(/\r?\n/);
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0].replace(/^ARGS:/, ''))).toEqual([payload, '%CD%']);
    });
  });

  // K-06 — quoteShellArg wrapped args in `"` and escaped `"` as `\"`, which cmd.exe ignores
  // and POSIX shells honour only outside `$(…)`, backticks and `$VAR`.
  it('refuses caller arguments on a shell entrypoint', async () => {
    await createSkillPackage(TEST_ROOT, {
      name: 'shell_args',
      purpose: 'shell',
      markdown: '# Shell\n',
      entrypoints: {
        default: {
          type: 'shell',
          command: `${process.execPath} -e "console.log('shell-ok')"`,
          autoRun: true,
        },
      },
    });

    // The argument refusal is upstream of the trust check, so it holds either way; approval is
    // what lets the second call actually run.
    await approveSkill(TEST_ROOT, 'shell_args', { approvedBy: 'test' });

    await expect(runSkillPackage(TEST_ROOT, 'shell_args', 'default', ['anything'])).rejects.toThrow(/KNOWL_/);

    const result = await runSkillPackage(TEST_ROOT, 'shell_args');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('shell-ok');
  });

  // The author who never considered auto-execution used to get it anyway.
  it('does not auto-run an entrypoint that never opted in', async () => {
    await createSkillPackage(TEST_ROOT, {
      name: 'no_optin',
      purpose: 'no opt in',
      markdown: '# No opt in\n',
      files: [{ path: 'run.js', content: "console.log('ran');\n" }],
      entrypoints: {
        default: { type: 'script', path: 'run.js' },
      },
    });

    const read = await readSkillPackage(TEST_ROOT, 'no_optin');
    expect(read.manifest.entrypoints.default?.autoRun).toBe(false);
    await expect(runSkillPackage(TEST_ROOT, 'no_optin')).rejects.toThrow(/auto-run/);
  });
});
