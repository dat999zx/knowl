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
 *  docs/test/chore skip list and the merge-commit check downstream.
 *
 *  Excluding newline is also what keeps the heredoc forms out of this path: their opening
 *  `-m "$(cat <<'EOF'` has no closing quote on its own line, so nothing matches here and
 *  CAT_HEREDOC below is left to claim it. */
const DASH_M_VALUE = /\s-m\s+"((?:[^"\\\n]|\\.)+)"/g;

/** One `git commit` invocation, bounded at the next one so `git commit -m "a" && git commit
 *  -m "b"` stays two commits rather than one commit whose body is "b". */
const DASH_M_INVOCATION = /\bgit\s+commit\b((?:(?!\bgit\s+commit\b)[^\n])*)/g;

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

  for (const invocation of command.matchAll(DASH_M_INVOCATION)) {
    // `git commit -m "subject" -m "body"` is git's own documented way to write a body, and
    // reading only the first -m threw the body away. That was survivable while a bodyless
    // commit still became an atom; it stopped being survivable once the caller began
    // dropping commits that report no body, because the body was there all along.
    const values = [...invocation[1].matchAll(DASH_M_VALUE)]
      .map(match => match[1].replace(/\\"/g, '"').trim())
      .filter(Boolean);
    if (values.length === 0) continue;
    const [subject, ...rest] = values;
    // git joins repeated -m values as separate paragraphs, so this reproduces the message
    // the commit actually carries rather than inventing a shape of its own.
    const body = rest.join('\n\n');
    found.push({ type: typeOf(subject), subject, body: body.length > 0 ? body : null });
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
