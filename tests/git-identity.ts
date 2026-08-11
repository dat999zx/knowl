/**
 * The identity fixture repositories commit under, carried on the invocation rather than written
 * into a config file.
 *
 * **`git config user.email X` in a fixture directory can escape into this repository.** `git
 * config` with no `--file` searches upward for the repository it belongs to, so when the fixture
 * has no `.git` at that moment -- the window between `git init` and the next line, or a run
 * interrupted before it -- the write lands on the nearest enclosing repository, which for a
 * fixture under the repo root is knowl itself. It then persists: a local `user.email` overrides
 * the developer's global one for every later commit, silently.
 *
 * That is not hypothetical. On 2026-08-11 this repository's `.git/config` held
 * `user.email = test@example.com`; the next commit went out authored by it, GitHub resolved the
 * address to an unrelated person's account, and the CLA check failed against a stranger who had
 * of course never signed. The commit had to be re-authored and force-pushed.
 *
 * `-c` cannot do that. It sets the value for one process and writes no file, so there is no file
 * to land in the wrong place -- which makes this a fix for the mechanism rather than for the
 * thirteen call sites that happened to have it. `tests/architecture/git-identity.test.ts` keeps
 * `git config user.*` from coming back.
 *
 * One identity for every fixture, because no assertion anywhere reads one: each suite had
 * invented its own address and every occurrence was the two lines setting it.
 */
export const GIT_IDENTITY = [
  // No space in the name, deliberately: `GIT_IDENTITY_FLAGS` below interpolates these into a
  // command string, where a space would need quoting that differs between cmd.exe and sh.
  '-c', 'user.name=Knowl-Test',
  '-c', 'user.email=knowl-test@example.test',
] as const;

/** `args`, with the identity flags in front. Git requires `-c` before the subcommand. */
export function gitArgs(args: readonly string[]): string[] {
  return [...GIT_IDENTITY, ...args];
}

/** The same, for the call sites that build a command string rather than an argument array. */
export const GIT_IDENTITY_FLAGS = GIT_IDENTITY.join(' ');
