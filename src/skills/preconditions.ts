import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { commandExistsOnPath } from '../cli/agents/command-exists.js';

const execFileAsync = promisify(execFile);

export type PreconditionResult =
  | { ok: true }
  | { ok: false; failed: string; reason: string };

/**
 * Named checks an entrypoint must pass before it runs.
 *
 * Fail-closed in all three directions, which is the whole point: a check that fails, a check that
 * errors, and a check nobody implemented are the same answer. Treating an unknown name as a pass
 * would let a typo silently disable the gate a person added deliberately.
 */
export async function checkPreconditions(
  names: string[] = [],
  context: { cwd: string },
): Promise<PreconditionResult> {
  for (const name of names) {
    if (name === 'clean_worktree') {
      try {
        const { stdout } = await execFileAsync('git', ['status', '--porcelain'], {
          cwd: context.cwd,
          encoding: 'utf-8',
        });
        if (stdout.trim().length > 0) {
          return {
            ok: false,
            failed: name,
            reason: 'Working tree has uncommitted changes',
          };
        }
      } catch (error: any) {
        return {
          ok: false,
          failed: name,
          reason: `Failed to evaluate git worktree status: ${error?.message || String(error)}`,
        };
      }
    } else if (name.startsWith('on_branch:')) {
      const expected = name.slice('on_branch:'.length);
      try {
        const { stdout } = await execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
          cwd: context.cwd,
          encoding: 'utf-8',
        });
        const current = stdout.trim();
        if (current !== expected) {
          return {
            ok: false,
            failed: name,
            reason: `Current branch is "${current}", expected "${expected}"`,
          };
        }
      } catch (error: any) {
        return {
          ok: false,
          failed: name,
          reason: `Failed to evaluate git branch: ${error?.message || String(error)}`,
        };
      }
    } else if (name.startsWith('command_exists:')) {
      const bin = name.slice('command_exists:'.length);
      if (!commandExistsOnPath(bin)) {
        return {
          ok: false,
          failed: name,
          reason: `Command "${bin}" is not found on PATH`,
        };
      }
    } else {
      return {
        ok: false,
        failed: name,
        reason: `Unrecognized precondition check "${name}"`,
      };
    }
  }

  return { ok: true };
}
