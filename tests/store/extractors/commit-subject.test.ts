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

  it("reads git's own subject-and-body form, where the body is a second -m", () => {
    const found = parseCommitSubjects('git commit -m "fix(x): the subject" -m "The real body explaining why."');
    expect(found).toEqual([
      { type: 'fix', subject: 'fix(x): the subject', body: 'The real body explaining why.' },
    ]);
  });

  it('joins three -m values the way git does, as separate paragraphs', () => {
    const found = parseCommitSubjects('git commit -m "feat: a" -m "First para." -m "Second para."');
    expect(found[0].body).toBe(['First para.', '', 'Second para.'].join('\n'));
  });

  it('still reports no body when there is only one -m', () => {
    expect(parseCommitSubjects('git commit -m "fix: alone"')[0].body).toBeNull();
  });

  it('ignores a -m message flag that does not belong to a git commit', () => {
    // A naive /-m\s+"([^"]+)"/ would capture this. Only anchoring on `git commit`
    // rejects it, so this is the test that pins the anchor.
    expect(parseCommitSubjects('npm run release -- -m "fix(x): not a commit at all"')).toEqual([]);
  });

  it("reads the $(cat <<'EOF') form and takes the real subject, not the shell wrapper", () => {
    // How agents routinely write a multi-line commit message. A -m pattern whose
    // capture class allows newlines swallows the whole wrapper as the "subject".
    const command = `git add -A && git commit -m "$(cat <<'EOF'\nfeat(store): widen the write path\n\nThe orchestrator now assembles candidates.\nEOF\n)"`;

    const found = parseCommitSubjects(command);

    expect(found).toHaveLength(1);
    expect(found[0].subject).toBe('feat(store): widen the write path');
    expect(found[0].type).toBe('feat');
    expect(found[0].body).toBe('The orchestrator now assembles candidates.');
  });

  it('never returns a subject that spans a newline or carries shell syntax', () => {
    const command = `git commit -m "$(cat <<'EOF'\ndocs: tidy the readme\nEOF\n)"`;

    for (const commit of parseCommitSubjects(command)) {
      expect(commit.subject).not.toContain('\n');
      expect(commit.subject).not.toContain('$(');
    }
  });

  it('returns a null body for a heredoc message with only a subject', () => {
    const command = `git commit -q -F - <<'EOF'\nfix(store): one-line message\nEOF`;

    expect(parseCommitSubjects(command)[0].body).toBeNull();
  });
});
