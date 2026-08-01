import { describe, expect, it } from 'vitest';
import { parseCommitSubjects } from '../../../src/store/extractors/commit-subject.js';

describe('parseCommitSubjects', () => {
  it('reads a -m subject and its conventional-commit type', () => {
    const found = parseCommitSubjects('git add -A && git commit -q -m "fix(store): take writes through the client" && git log -1');

    expect(found).toHaveLength(1);
    expect(found[0].type).toBe('fix');
    expect(found[0].subject).toBe('fix(store): take writes through the client');
    expect(found[0].body).toBeNull();
  });

  it('reads a heredoc subject and keeps the body', () => {
    const command = `git commit -q -F - <<'EOF'\nfeat(workspace): record role per repo\n\nThe manifest now carries it.\nEOF`;

    const found = parseCommitSubjects(command);

    expect(found[0].subject).toBe('feat(workspace): record role per repo');
    expect(found[0].body).toBe('The manifest now carries it.');
  });

  it('finds every commit in a command that makes several', () => {
    const command = 'git commit -m "fix(a): one" && git commit -m "feat(b): two"';

    expect(parseCommitSubjects(command).map((c) => c.subject)).toEqual(['fix(a): one', 'feat(b): two']);
  });

  it('returns an empty array for a command that commits nothing', () => {
    expect(parseCommitSubjects('npm run test:bench 2>&1 | tail -5')).toEqual([]);
  });

  it('does not treat a commit-shaped string inside another command as a commit', () => {
    // `git log` printing a past subject must not be captured as a new commit.
    expect(parseCommitSubjects('git log --oneline -1 --format="fix(x): old subject"')).toEqual([]);
  });

  it('reports a null type for a subject with no conventional-commit prefix', () => {
    const found = parseCommitSubjects('git commit -m "Merge branch \\"feat/x\\" into main"');

    expect(found[0].type).toBeNull();
  });
});
