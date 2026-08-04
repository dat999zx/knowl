import { spawnSync } from 'node:child_process';
import { normalizePathForKnowledge } from './freshness.js';

/**
 * What has changed in the working tree, right now, before anybody commits.
 *
 * `listChangedFilesSince` (`drift.ts:51`) answers a different question -- `git diff --name-only
 * a..b` over a commit range -- and it is the wrong question for change impact. "In progress"
 * means *uncommitted* by definition: the edit that invalidates another agent's read has not been
 * committed and may never be, so a commit-range tick sees nothing until the damage is already
 * merged. This is gap G-1 of `docs/change-impact-plan.md`.
 *
 * `-z` rather than the default porcelain output, and this is the whole reason the parser is
 * shaped the way it is. Default porcelain wraps any path containing a space, a quote, a
 * control character or a non-ASCII byte in double quotes and C-escapes it -- verified in a
 * throwaway repo: `src/ünïcode.ts` prints as `"src/\303\274n\303\257code.ts"`. Un-escaping that
 * correctly means reimplementing git's `quote_c_style`, and getting it subtly wrong produces a
 * path that matches no locator, which is a silent recall hole rather than a visible failure.
 * `-z` emits every path verbatim, NUL-terminated, with no quoting at all.
 *
 * `--untracked-files=all` because the default collapses a new directory to a single `?? dir/`
 * entry. A directory is not a locator: nothing can read `file://dir/`, `indexFile` refuses it,
 * and a hash of it cannot be taken -- so the collapsed form would drop every new file inside it
 * from the change set while contributing one path that can only ever be noise.
 */
export async function listWorkingTreeChanges(root: string): Promise<string[]> {
  let stdout: string;
  try {
    const result = spawnSync('git', ['status', '--porcelain', '-z', '--untracked-files=all'], {
      cwd: root,
      encoding: 'utf-8',
      stdio: 'pipe',
    });
    // Status 128 outside a repository, `null` when the spawn itself failed (no git on PATH, or a
    // `cwd` that does not exist). Both mean "this root has no working tree to report", which is
    // an ordinary answer for a caller that hands us whatever directory a tool event named -- not
    // an error to raise. `drift.ts` throws here and its callers wrap every call in try/catch;
    // returning empty puts that decision in one place instead of every call site.
    if (result.status !== 0 || typeof result.stdout !== 'string') return [];
    stdout = result.stdout;
  } catch {
    return [];
  }

  const records = stdout.split('\0');
  const paths: string[] = [];
  for (let index = 0; index < records.length; index++) {
    const record = records[index];
    // 'XY ' plus at least one path character. Also drops the trailing empty string every
    // NUL-terminated stream ends with.
    if (record.length < 4) continue;

    const status = record.slice(0, 2);
    paths.push(record.slice(3));

    // A rename or copy is the one record that carries two paths, and under `-z` the order is
    // reversed from the human format: `XY <path>NUL<origPath>NUL`, new first. Both are collected
    // on purpose. The old path is where an agent's existing read points -- `file://src/old.ts`
    // is invalidated precisely *because* the file moved -- so returning only the destination
    // would leave every reader of the source silently stale, which is the exact failure this
    // subsystem exists to catch. The index is advanced whether or not the field is usable, so a
    // truncated stream cannot make the origin path be re-read as the next status record.
    if (status.includes('R') || status.includes('C')) {
      const origin = records[++index];
      if (origin) paths.push(origin);
    }
  }

  // Not trimmed, deliberately -- and this is where this function departs from `drift.ts:58`,
  // which trims because it splits newline-delimited output and has to. Under `-z` the bytes
  // between the delimiters are the filename exactly, and a leading or trailing space is a legal
  // part of one on POSIX; trimming it would produce a path that resolves to nothing.
  return Array.from(new Set(
    paths
      .map(entry => normalizePathForKnowledge(entry))
      // A submodule reports as its bare directory path, which no locator can name.
      .filter(entry => entry.length > 0 && !entry.endsWith('/'))
  ));
}
