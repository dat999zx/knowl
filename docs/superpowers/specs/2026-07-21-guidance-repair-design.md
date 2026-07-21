# Guidance Repair Design

## Goal

Make `knowl init` and `knowl doctor` reject or repair malformed Knowl guidance layouts instead of reporting success while stale guidance is still present.

## Scope

1. Normalize the Knowl-managed section in `KNOWL.md` and `AGENTS.md` to exactly one canonical marker-delimited block. Multiple complete blocks are removed in one run; an unterminated block removes the remaining tail.
2. Use the same complete-block check for currentness, so doctor warns unless each canonical file has exactly one canonical block and no extra markers.
3. Make native Claude/Gemini instruction-import detection ignore indented Markdown code blocks in addition to existing HTML-comment, fenced-code, and inline-code handling.

## Non-goals

- Do not change the generated guidance text, Claude reminder payload, MCP configuration, lifecycle hooks, or `.gitignore`.
- Do not add a Markdown dependency for this narrow parser fix.

## Design

`stripManagedKnowlGuidance` will scan the complete source and remove every Knowl-managed section. It retains non-managed content and treats an opening marker without a closing marker as managed through EOF. Installation first normalizes existing managed content, then appends exactly one canonical section. Currentness checks that each file normalizes to one exact canonical section without stray markers.

The host-import scanner will treat lines belonging to an indented code block (a tab or four leading spaces after a blank-line boundary) as non-visible. It remains conservative: if uncertain, init adds the canonical import rather than reporting an ignored example as active.

## Verification

- Red/green tests cover duplicate complete sections and duplicate migration sections.
- Red/green tests cover imports present only in indented code blocks for both Claude and Gemini.
- Run the affected guidance and init suites, the full serial test suite, production build, and `git diff --check`.
