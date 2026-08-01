export interface CommitSubject {
  /** Conventional-commit type (`fix`, `feat`, …) when the subject carries one. */
  type: string | null;
  subject: string;
  /** First paragraph after the subject, heredoc form only. */
  body: string | null;
}

/** `git commit … -m "subject"`. Requires the -m to belong to a git commit, so a
 *  subject printed by `git log --format=` is not mistaken for a new commit. */
const DASH_M = /\bgit\s+commit\b[^\n]*?\s-m\s+"((?:[^"\\]|\\.)+)"/g;

/** `git commit … -F - <<'EOF'` with the subject on the following line. */
const HEREDOC = /\bgit\s+commit\b[^\n]*?-F\s+-\s*<<\s*'?(\w+)'?\n([\s\S]*?)(?:\n\1\b|$)/g;

const CONVENTIONAL = /^(\w+)(?:\([^)]*\))?!?:/;

function typeOf(subject: string): string | null {
  return CONVENTIONAL.exec(subject)?.[1]?.toLowerCase() ?? null;
}

export function parseCommitSubjects(command: string): CommitSubject[] {
  const found: CommitSubject[] = [];

  for (const match of command.matchAll(DASH_M)) {
    const subject = match[1].replace(/\\"/g, '"').trim();
    if (subject) found.push({ type: typeOf(subject), subject, body: null });
  }

  for (const match of command.matchAll(HEREDOC)) {
    const lines = match[2].split('\n');
    const subject = (lines[0] ?? '').trim();
    if (!subject) continue;
    const body = lines.slice(1).join('\n').trim();
    found.push({ type: typeOf(subject), subject, body: body.length > 0 ? body : null });
  }

  return found;
}
