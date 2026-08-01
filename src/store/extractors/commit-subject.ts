export interface CommitSubject {
  /** Conventional-commit type (`fix`, `feat`, …) when the subject carries one. */
  type: string | null;
  subject: string;
  /** Everything after the subject line, heredoc form only. Multi-paragraph bodies are
   *  kept whole; a message with no body yields null rather than an empty string. */
  body: string | null;
}

/** `git commit … -m "subject"`. Requires the -m to belong to a git commit, so a
 *  subject printed by `git log --format=` is not mistaken for a new commit.
 *
 *  The capture excludes newline deliberately. A class of `[^"\\]` also matches
 *  newlines, so the multi-line `-m "$(cat <<'EOF'` form below was captured whole
 *  — shell syntax and body and delimiter — as one "subject". That subject then
 *  carries no conventional-commit type, which silently bypasses both the
 *  docs/test/chore skip list and the merge-commit check downstream. */
const DASH_M = /\bgit\s+commit\b[^\n]*?\s-m\s+"((?:[^"\\\n]|\\.)+)"/g;

/** `git commit … -F - <<'EOF'` with the subject on the following line. */
const HEREDOC = /\bgit\s+commit\b[^\n]*?-F\s+-\s*<<\s*'?(\w+)'?\n([\s\S]*?)(?:\n\1\b|$)/g;

/** `git commit … -m "$(cat <<'EOF'` — how agents routinely write a multi-line
 *  message. Same shape as HEREDOC: subject on the next line, body up to the
 *  delimiter. Bounding DASH_M alone would drop these captures entirely. */
const CAT_HEREDOC = /\bgit\s+commit\b[^\n]*?\s-m\s+"\$\(\s*cat\s+<<-?\s*'?(\w+)'?[^\n]*\n([\s\S]*?)(?:\n\1\b|$)/g;

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

  for (const pattern of [HEREDOC, CAT_HEREDOC]) {
    for (const match of command.matchAll(pattern)) {
      const lines = match[2].split('\n');
      const subject = (lines[0] ?? '').trim();
      if (!subject) continue;
      const body = lines.slice(1).join('\n').trim();
      found.push({ type: typeOf(subject), subject, body: body.length > 0 ? body : null });
    }
  }

  return found;
}
