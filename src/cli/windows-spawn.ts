import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

/**
 * Running one child command the way the host shell would, without handing it a shell.
 *
 * Its own module because `program.ts` calls `program.parse(process.argv)` at import time, so
 * nothing in there can be imported by a test without running the CLI. That is not a stylistic
 * point: the Windows branch below is the part of this file that is easy to get subtly wrong,
 * and it stayed wrong through a green local suite precisely because no test could reach it.
 */

function hasPathSeparator(command: string) {
  return command.includes('/') || command.includes('\\');
}

/** Resolve a bare command to a full path the way `CreateProcess` plus PATHEXT would. */
export function resolveWindowsCommand(command: string) {
  const ext = path.extname(command);
  if (ext) return command;

  const pathEntries = (process.env.Path || process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const pathExts = (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
  const searchDirs = hasPathSeparator(command) ? [''] : [process.cwd(), ...pathEntries];

  for (const dir of searchDirs) {
    for (const pathExt of pathExts) {
      const candidate = dir ? path.join(dir, `${command}${pathExt}`) : `${command}${pathExt}`;
      if (existsSync(candidate)) return candidate;
    }
  }

  return command;
}

/**
 * The full path of `command` when it is a batch shim, or null when it is not one.
 *
 * Returns the path rather than a boolean because the caller needs it. Handing cmd a *bare*
 * name that is also quoted makes `%~dp0` inside the shim expand to the current directory
 * instead of the shim's own -- `npm.cmd` then looks for its `npm-cli.js` under the caller's
 * cwd and dies with MODULE_NOT_FOUND. The resolution already happened here to read the
 * extension, so the answer is kept rather than recomputed.
 */
export function windowsBatchCommandPath(command: string): string | null {
  const resolved = resolveWindowsCommand(command);
  const ext = path.extname(resolved).toLowerCase();
  return ext === '.cmd' || ext === '.bat' ? resolved : null;
}

/**
 * Quote one token so `cmd.exe` passes it through as a single argument instead of as syntax.
 *
 * Quoting alone is NOT enough here, which is the trap: when the target is a batch file, cmd
 * parses the line a second time for the batch context, and an operator inside a quoted region
 * survives the first parse only to split on the second. Measured against a `.cmd` that echoes
 * `%~1`, the argument `x& echo PWNED` ran `echo PWNED` as its own command. So the carets do
 * the security work and the quotes only hold the token together.
 *
 * `^` is escaped alongside the operators, so an argument that legitimately contains one still
 * arrives with one rather than losing it to the same pass.
 *
 * Two things this deliberately does not solve:
 *
 *   - `%VAR%`. cmd expands it inside quotes too and there is no escape for it outside a batch
 *     file. Unchanged from routing through `cmd /c` at all, and the variables in reach are the
 *     caller's own, in a command the caller typed.
 *   - A trailing backslash. The doubling below is CRT quoting, which is what a shim forwarding
 *     `%*` to a real executable needs -- `npm`, `npx`, `yarn` and friends are all that shape --
 *     but a batch file reading `%~1` directly does its own quote stripping and has no CRT to
 *     undo it, so `a\` reaches that reader as `a\\`. The two consumers want opposite things
 *     and the forwarding one is overwhelmingly the common case.
 */
export function quoteForCmd(value: string): string {
  const crtQuoted = `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1')}"`;
  return crtQuoted.replace(/[&|<>()^]/g, '^$&');
}

/** The `cmd.exe` argv for running a batch shim with these arguments, arguments neutralised. */
export function batchCommandLine(batchPath: string, args: string[]): string[] {
  const line = [batchPath, ...args].map(quoteForCmd).join(' ');
  // `/s` means "strip the outer quote pair and take the rest as the command", which is the
  // same shape Node's own `shell: true` path uses.
  return ['/d', '/s', '/c', `"${line}"`];
}

export type WindowsSpawnPlan = {
  /** `direct` goes to CreateProcess; `cmd` has to be re-parsed by a shell first. */
  via: 'direct' | 'cmd';
  file: string;
  args: string[];
  verbatim: boolean;
};

/**
 * Decide how to launch `command`, without launching it.
 *
 * Separate from the spawn so it can be asserted on. `spawnWorkLoopCommand` inherits stdio --
 * it has to, the child's output is the user's output -- so a test cannot read what a spawn
 * produced, and the regression that broke Windows CI lived in exactly this decision: passing
 * the caller's bare `command` to cmd where the resolved path belonged.
 */
export function windowsSpawnPlan(command: string, args: string[]): WindowsSpawnPlan {
  const batchPath = windowsBatchCommandPath(command);
  if (!batchPath) return { via: 'direct', file: command, args, verbatim: false };

  // A batch shim cannot be handed to CreateProcess directly, so it has to go through cmd --
  // and everything after `/c` is re-parsed by cmd before the child ever sees it. Passing the
  // pieces as separate argv entries left that parse to Node's CRT quoting, which is not cmd
  // quoting, so an argument holding `&` ended one command and started another.
  //
  // `batchPath`, not `command`: the escaping is what makes the arguments safe, and a quoted
  // BARE name is the one thing cmd will not resolve the same way. Given `"npm"` it finds the
  // shim on PATH but leaves `%~dp0` pointing at the caller's cwd, so the shim looks for its
  // own payload under a directory that does not have it. A quoted full path is unambiguous to
  // both cmd and the shim.
  return {
    via: 'cmd',
    file: process.env.ComSpec || 'cmd.exe',
    args: batchCommandLine(batchPath, args),
    verbatim: true,
  };
}

export function spawnWorkLoopCommand(command: string, args: string[]): SpawnSyncReturns<Buffer> {
  const spawnOptions = {
    cwd: process.cwd(),
    env: process.env,
    stdio: 'inherit' as const,
  };

  if (process.platform !== 'win32') {
    return spawnSync(command, args, spawnOptions);
  }

  const plan = windowsSpawnPlan(command, args);
  return spawnSync(plan.file, plan.args, {
    ...spawnOptions,
    windowsVerbatimArguments: plan.verbatim,
  });
}
