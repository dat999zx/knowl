# README visual redesign

**Date:** 2026-08-06
**Status:** Approved, ready for implementation planning

## Problem

The README is well written and badly shaped. It reads as documentation prose where it
should read as a landing page.

Measured against `rohitg00/agentmemory`, the README a reader compared us to:

| | agentmemory | Knowl (today) |
| --- | ---: | ---: |
| Total lines | 1,544 | 363 |
| Visual anchors | ~20 | 4 |
| Longest unbroken prose run | ~15 lines | ~45 lines |
| Collapsed `<details>` blocks | 5 | 0 |
| Two-column `<table>` layouts | 3 | 0 |
| Lines between visuals | ~80 | ~150 |

The finding that matters: **agentmemory is four times longer than ours and still feels
faster to read.** Length is not the problem and shortening is not the fix. The difference
is that their information sits in tables, grids, chips, and images, while ours sits in
paragraphs and long-sentence bullet lists. The `Features` section alone is 140 of our 363
lines and contains no visual element at all.

## Goals

1. A reader who scrolls for fifteen seconds understands what Knowl is and why supersession
   matters.
2. A reader evaluating seriously can still reach every shipped capability without leaving
   the page.
3. No loss of feature depth. That depth was deliberately restored after an earlier rewrite
   compressed roughly 1,900 words into a 169-word table; this redesign must not repeat it.
4. Anchors, the GitHub auto-ToC, and screen-reader headings keep working.

## Non-goals

Explicitly not adopted from agentmemory:

- **Image-based `<h2>` section headers.** GitHub's slugger mangles anchors when a heading
  leads with HTML, which is why agentmemory hand-writes `id=` on all twelve of theirs. The
  cost is the auto-ToC and heading semantics, and it buys rhythm we can get another way.
- **A competitor comparison table.** Contradicts the standing decision that Knowl
  documentation does not name or route readers to alternatives.
- **Translated READMEs.** Twelve locales is a maintenance surface we cannot keep honest.
- **Social-proof badges** (Trendshift, star counts, gist metrics).

## Design

### 1. The fold

Order, top to bottom:

```
hero.svg                                   (reuse, full width)
one-line promise
[npm] [CI] [license] [node] [MCP]          (reuse, 5 badges)
[stat chips x5]                            (NEW)
demo.gif                                   (NEW)
nav row                                    (expand from 6 to 8 links)
"Full reference ->" one-liner
```

The nav row is exactly: Quick start · Why supersession · What gets stored · Features ·
Agent setup · Workspaces · Viewer · **Full reference →**

Chips are `<picture>` elements — dark `srcset`, light `src` — at `height="38"`, each
wrapped in an anchor pointing at the section that substantiates it. Candidate set:

| Chip | Substantiated by |
| --- | --- |
| `96% vs 40%` | MemoryAgentBench conflict-resolution ablation, already in the README |
| `0 API keys` | Core storage and retrieval require no provider |
| `27 MCP tools` | The existing `<!-- generated:tool-count -->` marker |
| `100% local` | No egress on the storage or retrieval path |
| `N tests passing` | A real `npm test` run — see Open items |

### 2. Section rhythm without image headers

Headings stay plain Markdown (`## Quick start`). The visual rhythm comes from a content
rule instead:

> Every major section contains at least one non-prose element — a chip row, diagram,
> screenshot, table, or code block.

This is what actually breaks a scroll. Decorated headings only look like they do.

### 3. Features: matrix plus collapsed depth

Replace the six bullet-list sub-sections with:

1. A capability matrix — a two-column HTML `<table>` of six themed cards, each listing its
   capabilities as short labels. The entire feature surface fits on one screen. The six
   themes are today's six sub-headings, unchanged: *Knowledge that corrects itself*,
   *Retrieval tuned for agents*, *Work that survives the end of a session*, *Workspaces*,
   *Reusable procedures*, *Your data, and getting it back*.
2. Six `<details>` blocks below it, one per theme in the same order, each holding **today's
   prose verbatim**. Nothing is rewritten and nothing is deleted.

The existing seventh sub-section, *Everything else*, stays open and uncollapsed — it holds
the generated tool-count marker.

Accepted trade-off: GitHub does not match in-page Ctrl+F against collapsed `<details>`
content. Mitigated by the matrix above carrying every feature name in open text, so a
search for a capability still lands on the page.

### 4. New assets

| Asset | Content | Tooling |
| --- | --- | --- |
| `docs/assets/demo.gif` | Supersession in ~18s at 900px: `knowl decide` a decision, `knowl decide` its replacement (showing `superseded` on the predecessor), `knowl query` returning only the active one, `knowl timeline` showing both | **VHS**, with the `.tape` script checked in |
| `docs/assets/chips/*.svg` (5) | Stat chips, dark theme | Hand-authored, ~600 bytes each |
| `docs/assets/chips/light/*.svg` (5) | Same geometry, light tokens | As above |
| `docs/assets/lifecycle.svg` | Hook flow: bootstrap -> capture -> checkpoint -> finalize | Hand-authored |
| `docs/assets/atom-anatomy.svg` | One atom exploded into status, freshness, provenance, evidence, history | Hand-authored |

VHS is chosen over a one-shot screen recording so the GIF is regenerable when CLI output
changes. A demo GIF nobody can update becomes a liability the first time output drifts.

Host logos in the agent grid hotlink GitHub organization avatars
(`https://github.com/anthropics.png?size=120`), matching agentmemory's approach. Five
hosts — Claude Code, Codex, Cursor, Gemini CLI, Claude Desktop — in a single row.

New SVGs follow the existing asset conventions in `docs/assets/`: `role="img"`, a
descriptive `aria-label`, and the `hero.svg` color tokens.

### 5. Section-by-section changes

| Section | Today | After |
| --- | --- | --- |
| Fold | hero, badges, nav | plus chips and GIF |
| "Looking for details?" callout | 3-line blockquote at line 24 | one line, folded into the nav block |
| Problem prose | 2 paragraphs, 11 lines | 4 lines; the GIF above has already shown it |
| Quick start | 4 code blocks | unchanged |
| The idea: memory that retires itself | prose, chart, table | unchanged |
| What gets stored | prose, 7-row table | plus `atom-anatomy.svg` |
| Connecting an agent | prose, host table | plus host icon grid and `lifecycle.svg` |
| What Knowl is for | 3 bullets | unchanged |
| Features | 140 lines of bullets | matrix plus six `<details>` |
| See it: the local viewer | 2 screenshots | unchanged |
| Requirements, Documentation, Contributing, License | prose | unchanged |

Expected outcome: roughly 450 lines, unbroken prose runs down from ~45 to ~12, visuals up
from 4 to ~20.

## Verification

- `npm run docs:check` passes (the generated tool-count marker must still round-trip).
- Rendered check on GitHub in both light and dark themes.
- Every anchor in the nav row and every `docs/reference.md#...` deep link resolves.
- Every chip number traces to a command, a source file, or a checked-in benchmark result.
- New SVGs are valid XML and carry `role="img"` plus `aria-label`.
- The GIF regenerates from its checked-in `.tape` file.

## Open items for implementation

- **Test-count chip.** A grep finds 239 test files and ~3,406 `it(`/`test(` call sites,
  while a stored session note from an earlier date records "607/607 tests". These cannot
  both describe the current suite. Resolve with a real `npm test` run before any number
  reaches the README; drop the chip rather than publish an unverified count.
- **Chip count.** Five is the target. If the test-count chip is dropped, either find a
  sixth verifiable stat or ship four — an odd trailing chip on a narrow viewport is worse
  than one fewer.
