import { findProjectRoot } from '../core/config.js';
import { ProjectNotFoundError } from '../core/errors.js';
import { globalOnlyNamespaces } from '../store/namespaces.js';
import { knowlHome } from '../core/paths.js';

export type CloudScope = 'project' | 'global';

export type CloudTarget = {
  /** What every cloud entry point already takes. The machine home addresses the global store. */
  root: string;
  scope: CloudScope;
  /** True when nothing was asked for and the machine store answered instead. */
  inferred: boolean;
};

/**
 * Which store a `knowl cloud` command acts on.
 *
 * `--global` is the same word `knowl init --global` already uses: act on the machine, not on
 * this directory. It resolves to `knowlHome()`, which both `loadConfig` and `initDb` special-case
 * onto `~/.knowl/config.json` and `~/.knowl/global.db` -- so a root is still the only thing every
 * cloud function needs to be handed.
 *
 * With no flag the scope is inferred, and the inference is deliberately narrow. Falling back to
 * the machine store is correct ONLY when there is genuinely no project above this directory. A
 * project whose config is malformed throws something else, and that must surface as the error it
 * is rather than being quietly answered from someone's personal defaults -- the same distinction
 * `shouldServeGlobalOnly` draws in the MCP server, and for the same reason: a wrong store is worse
 * than a refusal, because it looks like it worked.
 */
export async function resolveCloudTarget(
  options: { global?: boolean } = {},
  cwd: string = process.cwd(),
): Promise<CloudTarget> {
  if (options.global) {
    return { root: knowlHome(), scope: 'global', inferred: false };
  }

  try {
    return { root: await findProjectRoot(cwd), scope: 'project', inferred: false };
  } catch (error) {
    if (shouldUseGlobalStore(error, globalOnlyNamespaces().length > 0)) {
      return { root: knowlHome(), scope: 'global', inferred: true };
    }
    throw error;
  }
}

/**
 * Whether a failure to find a project should be answered from the machine store.
 *
 * A separate predicate because it is the safety property of this module and the only way to test
 * it: `findProjectRoot` raises exactly one error type, so the narrowing cannot be exercised
 * through it, and a guard nothing can fail is a guard that quietly stops holding. Mirrors
 * `shouldServeGlobalOnly` in the MCP server, which draws the same line for the same reason.
 *
 * "No project above this directory" is safe to answer globally. Anything else -- a config that
 * will not parse, a permission error mid-walk -- is an error ABOUT a project, and answering it
 * from someone's personal defaults would look like it worked.
 */
export function shouldUseGlobalStore(error: unknown, hasGlobalStore: boolean): boolean {
  return error instanceof ProjectNotFoundError && hasGlobalStore;
}

/**
 * The one-line note an inferred global scope prints, or "" when it was asked for.
 *
 * On stderr at the call site, never stdout: several of these commands are read by scripts, and a
 * courtesy line that lands in parsed output is a bug rather than a courtesy.
 */
export function scopeNotice(target: CloudTarget): string {
  return target.inferred
    ? 'No project here, so this acted on the machine-wide store. Pass --global to say so explicitly.'
    : '';
}
