/**
 * Files a shell command read, for the sessions whose agents read with `cat` rather than `Read`.
 *
 * WHY THIS EXISTS. `IMPACT_READ_TOOLS` is `Read` and `NotebookRead`, and a file opened through
 * the shell reaches the same subsystem as `type: 'command'` with a `command` string and no
 * paths at all. So change impact, the recall gap and everything else built on `work_read_sets`
 * were blind to it. That is not an edge case in every deployment: a host running with shell
 * access granted will instruct its agent to prefer `cat`, `head`, `sed -n` and `git show` over
 * the file tools, and a session working that way records no reads whatsoever.
 *
 * WHAT IT REFUSES TO DO, and this is most of the design. A read-set row asserts "this session
 * saw this text and holds a belief about it", and the certain tier spends that assertion by
 * interrupting the agent and refusing its write. The doctrine this module inherits from
 * `host-lifecycle.ts` is therefore explicit -- recall on a tier allowed to be incomplete, never
 * precision on the one tier allowed to interrupt -- so every ambiguous construct is dropped
 * rather than guessed at:
 *
 * - **Anything that is not a literal path.** A glob, a variable, a subshell or a brace
 *   expansion names a file only after the shell has run, and this parser is not a shell.
 * - **`grep`, `rg`, `find`, `ls`.** They name a file and return matching lines or names, not
 *   contents. Excluded for the identical reason `Grep` and `Glob` are excluded upstream: a row
 *   for one claims the agent saw signatures it never received.
 * - **`git show <ref>:<path>`.** This is the sharpest of them. The agent saw the file as of
 *   that ref; the hash recorded here would be the WORKING TREE's. Recording it says the session
 *   holds a belief about text it never read, and the belief would be falsified by the very next
 *   comparison -- a fabricated staleness on the tier held to >=95% precision. A worktree-aware
 *   version of this could be right, and it is not this one.
 * - **Any segment carrying a redirect.** `cat > file` and `cat >> file` write.
 *
 * SEGMENTS, NOT THE FIRST TOKEN. The command is split on `&&`, `||`, `;` and `|` and every
 * segment is classified on its own. Testing only the leading verb is a defect with a receipt:
 * a sibling hook in another repo exempted the whole string on its first token, so every
 * `ls && rm -rf ...` passed its guard unseen. Read-then-act is the common shape, not the exotic
 * one.
 *
 * FILE GRANULARITY, DELIBERATELY. The caller records these at `file://` granularity rather than
 * per symbol. The shell tells us WHICH file was opened and not HOW MUCH of it: `sed -n 40,60p`
 * and `head -5` are slices, and expanding a slice into one row per symbol would assert beliefs
 * about signatures that never reached the agent. The file row is the granularity the evidence
 * actually supports, and it is a degradation the subsystem already understands -- it is the
 * same row a file with no parseable symbols produces.
 */

/** Verbs that emit a file's own contents. Slicing readers included; see the granularity note. */
const CONTENT_READERS = new Set([
  'cat', 'bat', 'nl', 'less', 'more', 'head', 'tail', 'od', 'xxd', 'strings',
]);

/**
 * `sed` is a reader only when it is printing, and it is never one when it is editing in place.
 *
 * It earns a special case rather than a place in the set above because it is the one verb here
 * that reads and writes under the same name: `sed -n 40,60p file` prints a slice and
 * `sed -i 's/a/b/' file` rewrites the file. Recording the second as a read would file a write
 * as an observation -- the exact inversion this subsystem cannot afford, since the write gate
 * and the read set would then hold opposite beliefs about the same event.
 *
 * Both conditions are required, not either: `-n` alone with `-i` present is still an in-place
 * edit that happens to suppress output.
 */
function sedIsPrinting(tokens: string[]): boolean {
  const options = tokens.filter(token => token.startsWith('-'));
  if (options.some(option => option === '-i' || option.startsWith('--in-place') || (/^-[a-zA-Z]*i/.test(option)))) return false;
  return options.some(option => option === '-n' || /^-[a-zA-Z]*n/.test(option) || option === '--quiet' || option === '--silent');
}

/**
 * Shell metacharacters that mean "this token is not yet a filename".
 *
 * Kept as a character test rather than a list of constructs: the question is only ever whether
 * the literal token can be trusted as written, and any of these means the shell would have
 * produced something else.
 */
const UNRESOLVED = /[*?[\]{}$`~!\\]|\)/;

/** A redirect anywhere in a segment makes it a write, whatever its verb reads. */
const REDIRECT = /[<>]/;

const SEGMENT_SPLIT = /\|\||&&|[;|&\n]/;

/**
 * Whether a token is an option rather than a path.
 *
 * `head -20 file` and `sed -n 5p file` put a bare number or a short flag where a path would
 * otherwise sit, and treating either as a filename produces a path that resolves to nothing --
 * harmless, but it also lets `-n` shadow a real target in the same segment.
 */
function isOption(token: string): boolean {
  return token.startsWith('-') || /^\+?\d+(?:[,.]\d+)?[a-zA-Z]?$/.test(token);
}

/**
 * Splits a segment into tokens, honouring single and double quotes.
 *
 * A quoted path is the ordinary way to name a file with a space in it, and dropping quoted
 * tokens would make this parser silently blind to exactly those files. Nothing is unescaped
 * beyond the quoting itself: a token needing more than that has already been refused by
 * `UNRESOLVED`.
 */
function tokenize(segment: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let quoted = false;
  for (const char of segment) {
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") { quote = char; quoted = true; continue; }
    if (/\s/.test(char)) {
      if (current || quoted) tokens.push(current);
      current = '';
      quoted = false;
      continue;
    }
    current += char;
  }
  if (current || quoted) tokens.push(current);
  return tokens;
}

/**
 * The literal paths a shell command read, in the order the command names them.
 *
 * Order is the command's own so a caller rendering these produces the same list twice for the
 * same input. Duplicates are collapsed, keeping the first mention.
 */
export function shellReadPaths(command: string): string[] {
  if (!command || command.length > 4_000) return [];
  const found: string[] = [];
  const seen = new Set<string>();

  for (const segment of command.split(SEGMENT_SPLIT)) {
    const trimmed = segment.trim();
    if (!trimmed || REDIRECT.test(trimmed)) continue;

    const tokens = tokenize(trimmed);
    if (tokens.length < 2) continue;

    // The verb is the last path component, so `/usr/bin/cat` and `cat` classify alike.
    const verb = tokens[0].split('/').pop() ?? '';
    const isSed = verb === 'sed';
    if (!CONTENT_READERS.has(verb) && !(isSed && sedIsPrinting(tokens))) continue;

    // `sed`'s first non-option argument is its SCRIPT (`40,60p`), not a path. Dropping only
    // the leading one is deliberate: `sed -n 1p a.ts b.ts` really does read both files, and a
    // rule that dropped every non-option after the script would lose the second.
    let sedScriptPending = isSed;
    for (const token of tokens.slice(1)) {
      // The script is consumed BEFORE the option test, because a script like `1,50p` matches
      // the numeric-option shape exactly. Testing options first let the script pass as a flag
      // and the real path be eaten in its place, which read as "sed reads nothing, ever".
      if (sedScriptPending && !token.startsWith('-')) { sedScriptPending = false; continue; }
      if (isOption(token) || UNRESOLVED.test(token)) continue;
      // A bare `--` ends options; it is not a path either.
      if (token === '--' || token === '') continue;
      if (seen.has(token)) continue;
      seen.add(token);
      found.push(token);
    }
  }
  return found;
}
