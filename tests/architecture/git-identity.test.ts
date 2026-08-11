import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * No test or script may write a git identity into a config file.
 *
 * **`git config user.email X` aimed at a fixture can land on this repository.** `git config` with
 * no `--file` searches upward for the repository the directory belongs to, so when the fixture has
 * no `.git` at that instant -- the window between `git init` and the next line, or a run
 * interrupted before it -- the write goes to the nearest enclosing repository. Fixtures here are
 * routinely built at `path.resolve('./.knowl-...')`, which is inside knowl, so the nearest
 * enclosing repository is knowl.
 *
 * It happened. On 2026-08-11 this repository's own `.git/config` carried
 * `user.email = test@example.com`, matching `tests/store/drift-auto.test.ts` exactly. The next
 * commit went out authored by it, GitHub resolved the address to an unrelated person's account,
 * and the CLA check failed against a stranger who had never signed it. The commit had to be
 * re-authored and force-pushed.
 *
 * Nothing caught it, because nothing was looking, and it is invisible once it lands: a local
 * `user.email` silently overrides the developer's global one for every later commit. This is what
 * looks. The alternative -- `git -c user.name=... -c user.email=...` on the invocation -- sets the
 * value for one process and writes no file, so there is nowhere for it to land wrongly.
 *
 * Scoped to `tests/` and `scripts/` because those are what run against fixtures under this repo.
 * `src/` never sets an identity at all; `docs/` holds design plans, which are a record of what was
 * written at the time rather than code that runs.
 */
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');

const SCANNED = ['tests', 'scripts'];

/** `git config user.name`, `['config', 'user.email', ...]`, and the string-command forms. */
const WRITES_IDENTITY = /config[^\n]{0,40}?user\.(?:name|email)/;

/** This file quotes the forbidden pattern in order to describe it. */
const SELF = path.join('tests', 'architecture', 'git-identity.test.ts');

/**
 * Comments are prose, not calls.
 *
 * Every place this rule is explained has to name the thing it forbids -- `tests/git-identity.ts`
 * does, and so does the helper comment at each converted call site -- so a scan that could not
 * tell a sentence from a statement would forbid documenting itself.
 */
const IS_COMMENT = /^\s*(?:\/\/|\/\*|\*)/;

async function sourceFiles(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  const found = await Promise.all(entries.map(async entry => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.(ts|mts|mjs|js)$/.test(entry.name) ? [full] : [];
  }));
  return found.flat();
}

describe('git identity in fixtures', () => {
  it('is never written with `git config`, in any test or script', async () => {
    const offenders: string[] = [];

    for (const dir of SCANNED) {
      for (const file of await sourceFiles(path.join(ROOT, dir))) {
        const relative = path.relative(ROOT, file);
        if (relative.split(path.sep).join(path.sep) === SELF) continue;

        const source = await fs.readFile(file, 'utf-8');
        source.split(/\r?\n/).forEach((line, index) => {
          if (!IS_COMMENT.test(line) && WRITES_IDENTITY.test(line)) {
            offenders.push(`${relative.replaceAll('\\', '/')}:${index + 1}: ${line.trim()}`);
          }
        });
      }
    }

    // Named rather than counted: the fix is per line, and a bare number sends the next reader
    // hunting for which one.
    expect(offenders, [
      'Use `git -c user.name=... -c user.email=...` on the invocation instead.',
      'See tests/git-identity.ts for GIT_IDENTITY / gitArgs / GIT_IDENTITY_FLAGS.',
      '',
      ...offenders,
    ].join('\n')).toEqual([]);
  });

  /**
   * The environment carries an identity, so a call site that forgets one still commits.
   *
   * This is the half that a per-call-site convention cannot give you, and the gap cost a CI run:
   * converting the suites that called `git config` left the git commands those same files ran
   * *elsewhere* with no identity, and it passed locally because a developer's global
   * `~/.gitconfig` supplies one. A CI runner has none, so `git commit` failed there with
   * "Author identity unknown" on both ubuntu legs while every local run was green.
   *
   * Asserted in a worker rather than trusted from `setup`, because inheritance across the
   * worker boundary is the property being relied on -- the same one `os.tmpdir()` depends on.
   */
  it('reaches the workers, so a call site that forgets one still commits', () => {
    expect(process.env.GIT_AUTHOR_NAME).toBeTruthy();
    expect(process.env.GIT_AUTHOR_EMAIL).toBeTruthy();
    // Both halves: git requires AUTHOR and COMMITTER separately and refuses on either alone.
    expect(process.env.GIT_COMMITTER_NAME).toBeTruthy();
    expect(process.env.GIT_COMMITTER_EMAIL).toBeTruthy();
  });
});
