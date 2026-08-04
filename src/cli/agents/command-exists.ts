import fs from 'node:fs';
import path from 'node:path';

/**
 * Whether a command is on PATH, answered by looking rather than by running it.
 *
 * This used to be `spawnSync(command, ['--version'], { shell: platform === 'win32' })`, which
 * had three problems and solved none of them by spawning:
 *
 *   - It is an args array with `shell: true`, which is the BatBadBut shape (CVE-2024-24576):
 *     the command line is re-parsed by cmd.exe after Node has quoted it. Every caller passes an
 *     internal literal today, so nothing was reachable — but it fired DEP0190 on every `knowl
 *     doctor`, and the audit that removed exactly this shape from the skills runner had
 *     recorded "DEP0190 cannot fire" as an explicit non-issue. It could; it was just somewhere
 *     nobody had looked.
 *   - It executes a third-party binary to answer a question about the filesystem. `--version`
 *     is conventional, not guaranteed, so a tool that spells it `-v` reads as not installed.
 *   - It costs a process launch per agent, five per detection pass. Measured on this machine:
 *     1,483 ms across six lookups versus 38 ms for the same six answered from PATH — and both
 *     methods returned identical results for every one, present and absent alike.
 *
 * Windows needs PATHEXT because the agent CLIs ship as `.CMD` shims (`claude.CMD`,
 * `cursor.CMD`), which is what made spawning them require a shell in the first place.
 */
export function findOnPath(command: string, env: NodeJS.ProcessEnv = process.env): string | null {
  if (!command) return null;

  // An explicit path is not a PATH search: honour it as given.
  if (path.isAbsolute(command) || command.includes('/') || command.includes('\\')) {
    return fs.existsSync(command) ? command : null;
  }

  const directories = (env.PATH || env.Path || '').split(path.delimiter).filter(Boolean);
  const extensions = process.platform === 'win32'
    ? (env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
    : [''];

  for (const directory of directories) {
    for (const extension of extensions) {
      const candidate = path.join(directory, `${command}${extension}`);
      if (fs.existsSync(candidate)) return candidate;
    }
  }

  // A command that already carries its extension is not found by appending another.
  if (process.platform === 'win32' && path.extname(command)) {
    for (const directory of directories) {
      const candidate = path.join(directory, command);
      if (fs.existsSync(candidate)) return candidate;
    }
  }

  return null;
}

export function commandExistsOnPath(command: string, env?: NodeJS.ProcessEnv): boolean {
  return findOnPath(command, env) !== null;
}
