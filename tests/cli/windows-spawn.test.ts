import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  batchCommandLine, quoteForCmd, windowsBatchCommandPath, windowsSpawnPlan,
} from '../../src/cli/windows-spawn.js';

/**
 * `knowl task run -- <command>` on Windows.
 *
 * A batch shim cannot go to `CreateProcess` directly, so it goes through `cmd /c` -- and
 * everything after `/c` is parsed by cmd before the child sees it, then parsed AGAIN for the
 * batch context. Both parses have bitten this code, in opposite directions:
 *
 *   - Passing the pieces as separate argv entries left the escaping to Node's CRT quoting,
 *     which is not cmd quoting, so an argument holding `&` ended one command and began
 *     another.
 *   - Fixing that by quoting the whole line quoted the BARE command name too, and cmd resolves
 *     a quoted bare name differently: it finds the shim on PATH but leaves `%~dp0` pointing at
 *     the caller's cwd, so `npm.cmd` hunted for its own `npm-cli.js` under a directory with no
 *     node_modules and died with MODULE_NOT_FOUND.
 *
 * These run cmd for real rather than asserting on the generated string, because the bug both
 * times was in what cmd does with the string, not in the string looking wrong.
 */

const onWindows = process.platform === 'win32';
const comspec = process.env.ComSpec || 'cmd.exe';

let dir = '';
let showArg = '';

beforeAll(() => {
  if (!onWindows) return;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'knowl-winspawn-'));
  // Echoes its first two arguments separately, so a split argument is visible as a split.
  showArg = path.join(dir, 'showarg.cmd');
  fs.writeFileSync(showArg, '@echo off\r\necho A1=[%~1]\r\necho A2=[%~2]\r\n');
});

afterAll(() => {
  if (!dir) return;
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* Windows */ }
});

/** Run the batch shim through the real cmd the same way `spawnWorkLoopCommand` does. */
function runBatch(args: string[], cwd = dir) {
  const result = spawnSync(comspec, batchCommandLine(showArg, args), {
    cwd,
    env: process.env,
    encoding: 'utf-8',
    windowsVerbatimArguments: true,
  });
  return (result.stdout || '').trim().replace(/\r?\n/g, ' ');
}

describe.skipIf(!onWindows)('running a Windows batch shim through cmd', () => {
  it('passes an argument holding a command separator through as one argument', () => {
    // The injection this escaping exists for: unescaped, cmd runs `echo PWNED` on its own.
    expect(runBatch(['x& echo PWNED', 'second'])).toBe('A1=[x& echo PWNED] A2=[second]');
  });

  it.each([
    ['pipe', 'a|b'],
    ['redirect out', 'a>b'],
    ['redirect in', 'a<b'],
    ['parentheses', 'a(b)c'],
    ['caret', 'a^b'],
    ['space', 'a b'],
    ['flag with separator', '--flag=a&b'],
  ])('keeps %s intact', (_label, value) => {
    expect(runBatch([value, 'second'])).toBe(`A1=[${value}] A2=[second]`);
  });

  it('does not let an argument swallow the one after it', () => {
    expect(runBatch(['first', 'second'])).toBe('A1=[first] A2=[second]');
  });

  /**
   * The regression that turned the Windows CI leg red. A quoted BARE name resolves on PATH but
   * leaves `%~dp0` at the caller's cwd, so a shim that locates its payload relative to itself
   * looks in the wrong place. Asserted from a cwd with no `node_modules`, which is what made
   * the failure visible: `npm.cmd` reported it could not find `npm-cli.js` under the temp dir.
   */
  it('runs a PATH-resolved shim from a directory that has no node_modules', () => {
    const npm = windowsBatchCommandPath('npm');
    expect(npm, 'npm should resolve to a .cmd shim on Windows').toBeTruthy();

    const result = spawnSync(comspec, batchCommandLine(npm!, ['--version']), {
      cwd: dir,
      env: process.env,
      encoding: 'utf-8',
      windowsVerbatimArguments: true,
    });

    expect(result.stderr || '').not.toContain('Cannot find module');
    expect(result.status).toBe(0);
    expect((result.stdout || '').trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('resolves the shim to a full path rather than leaving the bare name', () => {
    const npm = windowsBatchCommandPath('npm');
    expect(path.isAbsolute(npm!)).toBe(true);
    expect(path.extname(npm!).toLowerCase()).toBe('.cmd');
  });

  it('reports a non-batch command as not needing cmd at all', () => {
    expect(windowsBatchCommandPath('node')).toBeNull();
  });
});

describe.skipIf(!onWindows)('the launch plan for a work-loop command', () => {
  /**
   * The regression itself, guarded at the seam where it happened: the plan must carry the
   * shim's resolved path, never the bare name the caller typed. `spawnWorkLoopCommand`
   * inherits stdio, so this is the last point the decision can still be read.
   */
  it('hands cmd the resolved shim path, not the bare name it was given', () => {
    const plan = windowsSpawnPlan('npm', ['--version']);
    const resolved = windowsBatchCommandPath('npm')!;

    expect(plan.via).toBe('cmd');
    expect(plan.verbatim).toBe(true);
    expect(plan.args.join(' ')).toContain(resolved);
    // A bare `"npm"` anywhere in the line is the exact shape that broke `%~dp0`.
    expect(plan.args.join(' ')).not.toContain('"npm"');
  });

  it('sends a real executable straight to CreateProcess, unquoted and unescaped', () => {
    const plan = windowsSpawnPlan('node', ['-p', '1&2']);

    expect(plan.via).toBe('direct');
    expect(plan.verbatim).toBe(false);
    // No shell is involved, so the argument must arrive exactly as written.
    expect(plan.args).toEqual(['-p', '1&2']);
  });

  it('escapes a command separator in the arguments it routes through cmd', () => {
    const plan = windowsSpawnPlan('npm', ['x& echo PWNED']);
    expect(plan.args.join(' ')).toContain('^&');
    expect(plan.args.join(' ')).not.toContain('x& echo');
  });
});

describe('quoteForCmd', () => {
  it('escapes every character cmd would otherwise read as syntax', () => {
    for (const meta of ['&', '|', '<', '>', '(', ')', '^']) {
      expect(quoteForCmd(`a${meta}b`), `${meta} should be caret-escaped`).toContain(`^${meta}`);
    }
  });

  it('wraps the token so a space cannot split it', () => {
    expect(quoteForCmd('a b')).toBe('"a b"');
  });

  it('leaves an ordinary token as just a quoted token', () => {
    expect(quoteForCmd('plain')).toBe('"plain"');
  });
});
