import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  createSkillPackage,
  listSkillPackages,
  readSkillPackage,
  runSkillPackage,
} from '../../src/skills/registry.js';

const TEST_ROOT = path.resolve('./.knowl-skill-registry-test');

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
          path: 'run.cmd',
          content: '@echo off\r\necho run-app\r\n',
        },
      ],
      entrypoints: {
        default: {
          type: 'script',
          path: 'run.cmd',
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
    await expect(fs.access(path.join(TEST_ROOT, '.knowl', 'skills', 'run_app', 'run.cmd'))).resolves.toBeUndefined();
  });

  it('runs the default script entrypoint', async () => {
    const result = await runSkillPackage(TEST_ROOT, 'run_app');
    expect(result.exitCode).toBe(0);
    expect(result.usedEntrypoint).toBe('default');
    expect(result.stdout).toContain('run-app');
  });

  it('falls back to a shell command when the default script fails', async () => {
    await createSkillPackage(TEST_ROOT, {
      name: 'fallback_skill',
      purpose: 'Fallback shell test',
      markdown: '# Fallback Skill\n',
      files: [
        {
          path: 'run.cmd',
          content: '@echo off\r\nexit /b 9\r\n',
        },
      ],
      entrypoints: {
        default: {
          type: 'script',
          path: 'run.cmd',
          autoRun: true,
        },
        fallback: {
          type: 'shell',
          command: `${process.execPath} -e "console.log('fallback-ok')"`,
          autoRun: true,
        },
      },
    });

    const result = await runSkillPackage(TEST_ROOT, 'fallback_skill');
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
          path: '../escape.cmd',
          content: '@echo off\r\necho nope\r\n',
        },
      ],
      entrypoints: {
        default: {
          type: 'script',
          path: '../escape.cmd',
          autoRun: true,
        },
      },
    })).rejects.toThrow(/Invalid skill file path/);
  });
});
