import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { commandExistsOnPath, findOnPath } from '../../src/cli/agents/command-exists.js';

const WINDOWS = process.platform === 'win32';

describe('commandExistsOnPath', () => {
  it('finds a command that exists on PATH and rejects one that does not', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'knowl-cmd-'));
    const name = WINDOWS ? 'faketool.CMD' : 'faketool';
    await fs.writeFile(path.join(dir, name), '');
    const env = { PATH: dir, PATHEXT: '.COM;.EXE;.BAT;.CMD' };

    expect(commandExistsOnPath('faketool', env)).toBe(true);
    expect(commandExistsOnPath('definitely-not-a-real-tool', env)).toBe(false);

    await fs.rm(dir, { recursive: true, force: true });
  });

  // K-72. `commandExists` was `spawnSync(command, ['--version'], { shell: true })` — an args
  // array with a shell, which is the BatBadBut shape and fired DEP0190 on every `knowl doctor`.
  // Nothing caller-controlled reached it, but the reason it needed a shell at all was that the
  // agent CLIs ship as `.CMD` shims on Windows. Resolving through PATHEXT answers the same
  // question without launching anything, so the shape is gone rather than made safe.
  it.runIf(WINDOWS)('resolves a .CMD shim, which is why the old check needed a shell', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'knowl-cmd-'));
    await fs.writeFile(path.join(dir, 'shimtool.CMD'), '@echo off\r\n');
    const env = { PATH: dir, PATHEXT: '.COM;.EXE;.BAT;.CMD' };

    expect(findOnPath('shimtool', env)).toBe(path.join(dir, 'shimtool.CMD'));

    await fs.rm(dir, { recursive: true, force: true });
  });

  it('does not execute the command it is asked about', async () => {
    // A tool that has no --version, or whose --version is non-zero, still exists. The old
    // check conflated "runs and exits 0" with "is installed".
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'knowl-cmd-'));
    const name = WINDOWS ? 'angrytool.CMD' : 'angrytool';
    await fs.writeFile(path.join(dir, name), WINDOWS ? '@echo off\r\nexit /b 3\r\n' : '#!/bin/sh\nexit 3\n');
    const env = { PATH: dir, PATHEXT: '.COM;.EXE;.BAT;.CMD' };

    expect(commandExistsOnPath('angrytool', env)).toBe(true);

    await fs.rm(dir, { recursive: true, force: true });
  });

  it('honours an explicit path instead of searching PATH', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'knowl-cmd-'));
    const target = path.join(dir, 'direct.txt');
    await fs.writeFile(target, '');

    expect(findOnPath(target, { PATH: '' })).toBe(target);
    expect(findOnPath(path.join(dir, 'missing.txt'), { PATH: '' })).toBe(null);

    await fs.rm(dir, { recursive: true, force: true });
  });

  it('returns null for an empty command rather than matching a directory', () => {
    expect(findOnPath('', { PATH: process.cwd() })).toBe(null);
  });
});
