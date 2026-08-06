# README Visual Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reshape `README.md` from prose-shaped documentation into a scannable landing page — without losing a word of feature depth.

**Architecture:** Additive and mechanical. Four new stat chips and two new diagrams go into `docs/assets/`; the `Features` section is restructured into an open capability matrix over six `<details>` blocks holding today's prose verbatim; a demo GIF is recorded from a checked-in VHS tape. Section headings stay plain Markdown so anchors, the auto-ToC, and screen readers keep working.

**Tech Stack:** Markdown with inline HTML (`<picture>`, `<table>`, `<details>`), hand-authored SVG, VHS for terminal recording, `tsx scripts/generate-docs.ts --check` for verification.

**Spec:** [`docs/superpowers/specs/2026-08-06-readme-visual-redesign-design.md`](../specs/2026-08-06-readme-visual-redesign-design.md)

## Global Constraints

- **No image-based headings.** Every `##` stays plain Markdown text. Never `<h2><img></h2>`.
- **No competitor named anywhere.** Standing project decision: Knowl docs do not name or route readers to alternatives.
- **Feature prose is moved, never rewritten.** Text inside `<details>` must be byte-identical to what it replaces, apart from indentation.
- **Every published number traces to a source.** A command, a source file, or a checked-in benchmark result. No estimates.
- **Do not publish a test-count stat.** The suite is not green on a developer clone — see the note below. Four chips ship, not five.
- **New SVGs carry `role="img"` and a descriptive `aria-label`**, and reuse the color tokens already in `docs/assets/hero.svg`: `#0d1117`, `#111722`, `#161b22`, accent `#3987e5`, warn `#eda100`, ok `#199e70`.
- **All local asset paths are repo-relative** (`docs/assets/...`), never absolute and never a raw GitHub URL.
- **Never rewrite a repo file with PowerShell `Get-Content`/`Set-Content`** — it mangles UTF-8 into mojibake and adds a BOM. Use the Edit/Write tools.
- **Never link the nav row or a chip at a `###` sub-heading inside `Features`.** Task 2 converts six of those into `<summary>` elements, which destroys their anchors.

### Standing note: the test-count chip is cancelled

`npm run build && npx vitest run` on a clean `fix/codeql-alerts` tree gives **15 failed files / 38 failed tests of 2,009**. The cause is pre-existing and unrelated to this work: several CLI tests place fixture directories inside the repository, and Knowl's nested-store guard correctly refuses to `init` there. CI is green only because `.knowl/` is gitignored, so a fresh checkout never trips the guard.

Do not attempt to fix that here. Do not publish a passing-test figure.

## File Structure

| File | Responsibility | Status |
| --- | --- | --- |
| `README.md` | The page | Modify |
| `docs/assets/chips/*.svg` (4) | Stat chips, dark theme | Create |
| `docs/assets/chips/light/*.svg` (4) | Stat chips, light theme | Create |
| `docs/assets/atom-anatomy.svg` | One atom exploded into its governed fields | Create |
| `docs/assets/lifecycle.svg` | bootstrap → capture → checkpoint → finalize | Create |
| `docs/assets/demo.tape` | VHS script for the demo recording | Create |
| `docs/assets/demo.gif` | Rendered output of `demo.tape` | Create |

The four chips are `stat-supersession.svg` (96% vs 40%), `stat-nokeys.svg` (0 API keys), `stat-tools.svg` (27 MCP tools), `stat-local.svg` (100% local). Four, not five, so they wrap 2×2 rather than leaving an orphan on narrow viewports.

### Anchors this plan relies on

Verified present in `README.md` as top-level `##` headings: `quick-start`, `the-idea-memory-that-retires-itself`, `what-gets-stored`, `connecting-an-agent`, `what-knowl-is-for`, `features`, `see-it-the-local-viewer`, `everything-else`, `requirements-and-local-data`.

`everything-else` is a `###` but is deliberately kept open and outside any `<details>` by Task 2 Step 4.

---

### Task 1: Stat chips and the fold

**Files:**
- Create: `docs/assets/chips/stat-supersession.svg`, `stat-nokeys.svg`, `stat-tools.svg`, `stat-local.svg`
- Create: `docs/assets/chips/light/` — the same four filenames
- Modify: `README.md:1-38` (the centered fold block and the two paragraphs below it)

**Interfaces:**
- Consumes: nothing.
- Produces: the chip row markup that Task 5 inserts the GIF directly beneath. Chip files are referenced as `docs/assets/chips/<name>.svg` (dark, the `src`) and `docs/assets/chips/light/<name>.svg` (the light `srcset`).

- [ ] **Step 1: Verify the tool count before drawing it**

```bash
grep -A2 'generated:tool-count' README.md
```

Expected: a line reading `**27 MCP tools** (plus 3 more when transcript search is on)`. If the number is not 27, use whatever it says — that marker is generated and authoritative. Do not hardcode a second copy anywhere else.

- [ ] **Step 2: Create the dark supersession chip**

`docs/assets/chips/stat-supersession.svg`:

```xml
<svg xmlns="http://www.w3.org/2000/svg" width="188" height="38" viewBox="0 0 188 38"
     role="img" aria-label="96 percent correct versus 40 percent without supersession">
  <rect width="188" height="38" rx="8" fill="#161b22" stroke="#30363d"/>
  <text x="14" y="24" font-family="system-ui, -apple-system, 'Segoe UI', sans-serif"
        font-size="14" font-weight="700" fill="#199e70">96%</text>
  <text x="52" y="24" font-family="system-ui, -apple-system, 'Segoe UI', sans-serif"
        font-size="12" fill="#8b949e">vs 40% stale</text>
</svg>
```

- [ ] **Step 3: Create the remaining three dark chips**

Same 38px height and 8px radius; widths differ. Copy the Step 2 markup for each and change only `width`, the `viewBox` width, `aria-label`, the bold `<text>` and its `fill`, and the label `<text>` and its `x`. Set the label `x` to the bold text's rendered width plus 24.

| File | width | bold text | bold fill | label |
| --- | ---: | --- | --- | --- |
| `stat-nokeys.svg` | 150 | `0` | `#3987e5` | `API keys needed` |
| `stat-tools.svg` | 152 | `27` | `#3987e5` | `MCP tools` |
| `stat-local.svg` | 158 | `100%` | `#eda100` | `local, no egress` |

- [ ] **Step 4: Create the four light chips**

Copy each dark chip into `docs/assets/chips/light/` under the same filename, changing exactly three attributes: `fill="#161b22"` → `fill="#f6f8fa"`, `stroke="#30363d"` → `stroke="#d0d7de"`, and the muted label `fill="#8b949e"` → `fill="#57606a"`. Accent colors stay.

- [ ] **Step 5: Verify every SVG is well-formed**

```bash
for f in docs/assets/chips/*.svg docs/assets/chips/light/*.svg; do
  python -c "import xml.dom.minidom; xml.dom.minidom.parse('$f')" \
    && echo "ok $f" || echo "BROKEN $f"
done
```

Expected: eight `ok` lines, no `BROKEN`.

- [ ] **Step 6: Insert the chip row into the fold**

In `README.md`, immediately after the badge block (currently line 11, the MCP badge) and before the nav row, insert:

```html
<p align="center">
  <a href="#the-idea-memory-that-retires-itself"><picture><source media="(prefers-color-scheme: light)" srcset="docs/assets/chips/light/stat-supersession.svg"><img src="docs/assets/chips/stat-supersession.svg" alt="96% correct vs 40% without supersession" height="38" /></picture></a>
  <a href="#quick-start"><picture><source media="(prefers-color-scheme: light)" srcset="docs/assets/chips/light/stat-nokeys.svg"><img src="docs/assets/chips/stat-nokeys.svg" alt="0 API keys needed" height="38" /></picture></a>
  <a href="#everything-else"><picture><source media="(prefers-color-scheme: light)" srcset="docs/assets/chips/light/stat-tools.svg"><img src="docs/assets/chips/stat-tools.svg" alt="27 MCP tools" height="38" /></picture></a>
  <a href="#what-knowl-is-for"><picture><source media="(prefers-color-scheme: light)" srcset="docs/assets/chips/light/stat-local.svg"><img src="docs/assets/chips/stat-local.svg" alt="100% local, no egress" height="38" /></picture></a>
</p>
```

The `media` query is `light` with the dark file as the fallback `src`, matching this repo's dark-first assets.

- [ ] **Step 7: Replace the nav row with the eight-link version**

Replace `README.md:13-18` with:

```markdown
[Quick start](#quick-start) ·
[Why supersession](#the-idea-memory-that-retires-itself) ·
[What gets stored](#what-gets-stored) ·
[Features](#features) ·
[Agent setup](#connecting-an-agent) ·
[Viewer](#see-it-the-local-viewer) ·
[Requirements](#requirements-and-local-data) ·
**[Full reference →](docs/reference.md)**
```

Every target is a top-level `##` heading verified to exist. There is deliberately no
"Workspaces" entry: that is a `###` inside `Features` and Task 2 removes its anchor.

- [ ] **Step 8: Fold the callout into one line and trim the problem prose**

Delete the three-line blockquote at `README.md:24-26`. Trim the two paragraphs that follow (currently lines 28-38) to four lines: keep the "believes the authentication design you replaced in March" image and the typed-atoms definition; drop the sentence about where the database lives, which Requirements already covers.

- [ ] **Step 9: Verify anchors resolve**

```bash
node -e "
const fs=require('fs');const md=fs.readFileSync('README.md','utf8');
const heads=[...md.matchAll(/^#+ (.+)\$/gm)].map(m=>m[1].toLowerCase().replace(/[^\w\s-]/g,'').trim().replace(/\s+/g,'-'));
const links=[...md.matchAll(/\]\(#([^)]+)\)/g)].map(m=>m[1]);
const bad=[...new Set(links)].filter(l=>!heads.includes(l));
console.log(bad.length?'BROKEN: '+bad.join(', '):'all '+new Set(links).size+' in-page anchors resolve');
"
```

Expected: `all N in-page anchors resolve`.

- [ ] **Step 10: Commit**

```bash
git add docs/assets/chips README.md
git commit -m "docs(readme): add stat chips and tighten the fold"
```

---

### Task 2: Features — capability matrix over collapsed depth

**Files:**
- Modify: `README.md:173-318` (the whole `## Features` section)

**Interfaces:**
- Consumes: the `#features` anchor referenced by Task 1 Step 7.
- Produces: the `#everything-else` anchor that Task 1 Step 6's tools chip links to. That sub-heading must survive as a plain `### Everything else`.

- [ ] **Step 1: Snapshot the section so the move can be proven lossless**

```bash
sed -n '/^## Features/,/^## Requirements/p' README.md > /tmp/features-before.txt
wc -w /tmp/features-before.txt
```

Record the word count. Step 6 checks against it.

- [ ] **Step 2: Insert the capability matrix**

Directly after the `## Features` heading and its existing two-sentence intro, insert:

```html
<table>
<tr>
<td width="50%" valign="top">

**♻️ Knowledge that corrects itself**

7 atom types · automatic supersession · conflict identity · full history · time travel · evidence · drift detection · code intelligence · secret-safe writes

</td>
<td width="50%" valign="top">

**🎯 Retrieval tuned for agents**

Vector-primary with BM25 fallback · runs offline · 4 embedding presets · exact-identifier support · token-budgeted context packs · usage feedback

</td>
</tr>
<tr>
<td width="50%" valign="top">

**⏱️ Work that survives the session**

Automatic lifecycle on 3 hosts · work loops · promotion at session end · handoff baton · resume keys · optional transcript search

</td>
<td width="50%" valign="top">

**🔗 Workspaces**

Many repos, one shared memory · promote explicitly · read-only peer results · owner-only retirement

</td>
</tr>
<tr>
<td width="50%" valign="top">

**📦 Reusable procedures**

File-backed skills · inspect before running · deterministic synthesis with no AI provider

</td>
<td width="50%" valign="top">

**💾 Your data, and getting it back**

Checksummed export/import · verified snapshots · previewing garbage collection · `knowl doctor` · optional AI

</td>
</tr>
</table>
```

- [ ] **Step 3: Wrap the six existing sub-sections in `<details>`**

For each of the six — *Knowledge that corrects itself*, *Retrieval tuned for agents*, *Work that survives the end of a session*, *Workspaces: many repos, one shared memory*, *Reusable procedures*, *Your data, and getting it back* — replace the `### Heading` line with:

```html
<details>
<summary><b>Heading</b> — one-line teaser</summary>
<br>
```

and insert `</details>` immediately before the next sub-section. Leave a blank line after `<br>` and before `</details>` so the Markdown inside still renders.

Do not touch the body text. Do not re-indent it.

- [ ] **Step 4: Leave `### Everything else` open**

The seventh sub-section stays a plain `###` heading outside any `<details>`. It holds the `<!-- generated:tool-count -->` marker, which must remain findable by the generator, by Ctrl+F, and by the chip anchor from Task 1.

- [ ] **Step 5: Verify the generated marker still round-trips**

```bash
npm run docs:check
```

Expected: exits 0. If it reports the tool-count block is out of date, run `npm run docs:generate` and commit the result with the rest.

- [ ] **Step 6: Verify no prose was lost**

```bash
sed -n '/^## Features/,/^## Requirements/p' README.md > /tmp/features-after.txt
diff <(tr -s '[:space:]' '\n' < /tmp/features-before.txt | grep -v '^$' | sort) \
     <(tr -s '[:space:]' '\n' < /tmp/features-after.txt | grep -v '^$' | sort) \
  | grep '^<' || echo "no words removed"
```

Expected: `no words removed`. Anything on a `<` line was dropped and must be restored.

- [ ] **Step 7: Commit**

```bash
git add README.md
git commit -m "docs(readme): capability matrix over collapsed feature depth"
```

---

### Task 3: Atom anatomy diagram

**Files:**
- Create: `docs/assets/atom-anatomy.svg`
- Modify: `README.md` — the `## What gets stored` section

**Interfaces:**
- Consumes: the color tokens named in Global Constraints.
- Produces: nothing later tasks depend on.

- [ ] **Step 1: Draw the diagram**

`docs/assets/atom-anatomy.svg`, 900×340, showing one `decision` atom as a rounded card with labelled callouts to its governed fields: **status** (`active`), **freshness**, **confidence**, **tags**, **source commit**, **affected paths**, and **evidence** — with one `symbol://` locator drawn as gone stale.

Card fill `#161b22`, strokes `#30363d`, field labels `#3987e5`, the stale-evidence callout `#eda100`.

The point the drawing must make: these fields are what "typed, not free text" buys. Each one is something a paragraph in a notes file cannot express.

- [ ] **Step 2: Verify it is well-formed and labelled**

```bash
python -c "import xml.dom.minidom; d=xml.dom.minidom.parse('docs/assets/atom-anatomy.svg'); \
r=d.documentElement; assert r.getAttribute('role')=='img', 'missing role'; \
assert r.getAttribute('aria-label'), 'missing aria-label'; print('ok')"
```

Expected: `ok`.

- [ ] **Step 3: Insert it into the section**

In `## What gets stored`, place the image between the seven-row category table and the paragraph beginning "Alongside the content, each atom keeps a status":

```html
<div align="center">
<img src="docs/assets/atom-anatomy.svg" alt="A decision atom with its governed fields: status, freshness, confidence, tags, source commit, affected paths, and evidence — one evidence locator shown gone stale" width="88%" />
</div>
```

- [ ] **Step 4: Commit**

```bash
git add docs/assets/atom-anatomy.svg README.md
git commit -m "docs(readme): add the atom anatomy diagram"
```

---

### Task 4: Host icon grid and lifecycle diagram

**Files:**
- Create: `docs/assets/lifecycle.svg`
- Modify: `README.md` — the `## Connecting an agent` section

**Interfaces:**
- Consumes: nothing.
- Produces: nothing later tasks depend on.

- [ ] **Step 1: Add the host icon grid**

Immediately under the `## Connecting an agent` heading, before the existing `knowl serve` paragraph. All five avatar URLs were verified to return HTTP 200:

```html
<table>
<tr>
<td align="center" width="20%">
<a href="https://claude.com/product/claude-code"><img src="https://github.com/anthropics.png?size=120" alt="Claude Code" width="48" height="48" /></a><br/>
<strong>Claude Code</strong><br/>
<sub>MCP · lifecycle · subagents</sub>
</td>
<td align="center" width="20%">
<a href="https://github.com/openai/codex"><img src="https://github.com/openai.png?size=120" alt="Codex" width="48" height="48" /></a><br/>
<strong>Codex</strong><br/>
<sub>MCP · lifecycle · subagents</sub>
</td>
<td align="center" width="20%">
<a href="https://cursor.com"><img src="https://github.com/getcursor.png?size=120" alt="Cursor" width="48" height="48" /></a><br/>
<strong>Cursor</strong><br/>
<sub>MCP · lifecycle</sub>
</td>
<td align="center" width="20%">
<a href="https://github.com/google-gemini/gemini-cli"><img src="https://github.com/google-gemini.png?size=120" alt="Gemini CLI" width="48" height="48" /></a><br/>
<strong>Gemini CLI</strong><br/>
<sub>MCP · manual loop</sub>
</td>
<td align="center" width="20%">
<a href="https://claude.ai/download"><img src="https://github.com/anthropics.png?size=120" alt="Claude Desktop" width="48" height="48" /></a><br/>
<strong>Claude Desktop</strong><br/>
<sub>MCP · manual loop</sub>
</td>
</tr>
</table>
```

Keep the existing five-row host table below it — the grid is the glance, the table is the detail.

- [ ] **Step 2: Re-confirm the avatar URLs still resolve**

```bash
for u in anthropics openai getcursor google-gemini; do
  echo "$u -> $(curl -s -o /dev/null -w '%{http_code}' -L "https://github.com/$u.png?size=120")"
done
```

Expected: `200` for each. If any returns 404 the org handle changed — find the correct one rather than dropping the cell.

- [ ] **Step 3: Draw the lifecycle diagram**

`docs/assets/lifecycle.svg`, 900×200: a left-to-right flow of four labelled stages — **bootstrap** (session start injects relevant memory), **capture** (bounded events, never transcripts), **checkpoint** (milestones and blockers), **finalize** (distills up to 8 durable candidates) — with a footnote that hooks drive all four, and that the manual `knowl task` loop covers the same ground where hooks are unavailable.

- [ ] **Step 4: Verify it is well-formed and labelled**

```bash
python -c "import xml.dom.minidom; d=xml.dom.minidom.parse('docs/assets/lifecycle.svg'); \
r=d.documentElement; assert r.getAttribute('role')=='img', 'missing role'; \
assert r.getAttribute('aria-label'), 'missing aria-label'; print('ok')"
```

Expected: `ok`.

- [ ] **Step 5: Insert it after the host table**

Directly above the paragraph beginning "Where hooks are available, they own the session lifecycle":

```html
<div align="center">
<img src="docs/assets/lifecycle.svg" alt="Session lifecycle: bootstrap injects relevant memory, capture records bounded events, checkpoints record milestones, finalization distills durable candidates" width="88%" />
</div>
```

- [ ] **Step 6: Commit**

```bash
git add docs/assets/lifecycle.svg README.md
git commit -m "docs(readme): add host grid and lifecycle diagram"
```

---

### Task 5: The demo GIF

**Files:**
- Create: `docs/assets/demo.tape`, `docs/assets/demo.gif`
- Modify: `README.md` — the fold

**Interfaces:**
- Consumes: the chip row from Task 1 Step 6; the GIF goes directly beneath it.
- Produces: nothing later tasks depend on.

> **Read this before starting.** Neither `vhs` nor `ffmpeg` is installed on this machine, and VHS on Windows needs `ttyd`, which is Unix-oriented. Confirm the tooling path with the user before spending time here. If VHS cannot be made to work, the fallback is a hand-authored animated SVG — which the user explicitly considered and passed on, so it is their call, not the implementer's. **Do not silently substitute.**

- [ ] **Step 1: Install the toolchain**

```bash
# Windows, via Scoop:
scoop install vhs ffmpeg
# or WSL2:
sudo apt install ffmpeg && go install github.com/charmbracelet/vhs@latest
vhs --version
```

Expected: a version string. If this fails, stop and raise it.

- [ ] **Step 2: Create a scratch project outside the repository**

The recording must not run inside `d:\coding\knowl` — the nested-store guard will refuse `knowl init` there, exactly as it does in the CLI tests.

```bash
mkdir -p ~/knowl-demo && cd ~/knowl-demo && git init -q && knowl init --yes
```

- [ ] **Step 3: Write the tape**

`docs/assets/demo.tape`:

```
Output docs/assets/demo.gif
Set Shell bash
Set FontSize 18
Set Width 900
Set Height 540
Set Theme "Dracula"
Set TypingSpeed 45ms
Set Padding 20

Type `knowl decide "Use JWTs" "Stateless auth via JWT."`
Enter
Sleep 1500

Type `knowl decide "Use session cookies" "Server-side sessions. Revocable."`
Enter
Sleep 2500

Type `knowl query "auth approach"`
Enter
Sleep 3000

Type `knowl timeline $(knowl query "auth approach" --json | jq -r '.[0].id')`
Enter
Sleep 3500
```

- [ ] **Step 4: Render and check the result**

```bash
vhs docs/assets/demo.tape
ls -la docs/assets/demo.gif
```

Expected: a GIF under 2 MB. Watch it. It must show the second `decide` retiring the first, the query returning only the active decision, and the timeline showing both. If the supersession line is not visible on screen, the demo has failed its one job — adjust the `Sleep` values and re-render.

- [ ] **Step 5: Insert it into the fold**

Directly beneath the chip row from Task 1 Step 6, above the nav row:

```html
<p align="center">
  <img src="docs/assets/demo.gif" alt="Storing a replacement decision retires its predecessor; a query returns only the current one, and the timeline shows both" width="90%" />
</p>
```

- [ ] **Step 6: Commit**

```bash
git add docs/assets/demo.tape docs/assets/demo.gif README.md
git commit -m "docs(readme): add the supersession demo recording"
```

---

### Task 6: Whole-page verification

**Files:**
- Modify: `README.md` only if a check fails.

**Interfaces:**
- Consumes: everything above.
- Produces: the finished page.

- [ ] **Step 1: Generated content is current**

```bash
npm run docs:check
```

Expected: exits 0.

- [ ] **Step 2: Every local asset referenced actually exists**

```bash
node -e "
const fs=require('fs');const md=fs.readFileSync('README.md','utf8');
const refs=[...md.matchAll(/(?:src=\"|\]\()(docs\/assets\/[^\"')]+)/g)].map(m=>m[1]);
const missing=[...new Set(refs)].filter(p=>!fs.existsSync(p));
console.log(missing.length?'MISSING: '+missing.join(', '):'all '+new Set(refs).size+' local assets exist');
"
```

Expected: `all N local assets exist`.

- [ ] **Step 3: Every in-page anchor resolves**

Re-run the command from Task 1 Step 9. Expected: `all N in-page anchors resolve`.

- [ ] **Step 4: Every `docs/reference.md` deep link resolves**

```bash
node -e "
const fs=require('fs');
const md=fs.readFileSync('README.md','utf8');
const ref=fs.readFileSync('docs/reference.md','utf8');
const heads=[...ref.matchAll(/^#+ (.+)\$/gm)].map(m=>m[1].toLowerCase().replace(/[^\w\s-]/g,'').trim().replace(/\s+/g,'-'));
const links=[...md.matchAll(/docs\/reference\.md#([\w-]+)/g)].map(m=>m[1]);
const bad=[...new Set(links)].filter(l=>!heads.includes(l));
console.log(bad.length?'BROKEN: '+bad.join(', '):'all '+new Set(links).size+' reference links resolve');
"
```

Expected: `all N reference links resolve`.

- [ ] **Step 5: No competitor is named**

```bash
grep -inE '\b(mem0|zep|letta|memgpt|cognee|graphiti|khoj|supermemory|mempalace|hippo|basic.memory)\b' README.md \
  && echo "VIOLATION — see Global Constraints" || echo "clean"
```

Expected: `clean`.

- [ ] **Step 6: No image-based headings crept in**

```bash
grep -nE '^#{1,4}.*<(img|picture)' README.md && echo "VIOLATION" || echo "clean"
```

Expected: `clean`.

- [ ] **Step 7: Confirm the shape actually changed**

```bash
node -e "
const md=require('fs').readFileSync('README.md','utf8').split('\n');
let run=0,max=0;
for(const l of md){ const t=l.trim(); const prose=t&&!/^[|>#\`\-*<]|^\s*\d+\./.test(t); run=prose?run+1:0; if(run>max)max=run; }
const visuals=(md.join('\n').match(/<img |<picture>/g)||[]).length;
console.log('lines',md.length,'| longest prose run',max,'| visual elements',visuals);
"
```

Expected: longest prose run at or under ~15 (was ~45); visual elements at or above 15 (was 4). If the prose run is still long, a paragraph was missed.

- [ ] **Step 8: Render check by eye**

Push the branch and open the README on GitHub in both light and dark themes. Confirm: chips legible in both, GIF plays, matrix does not overflow on a narrow window, every `<details>` expands, no broken image icons.

- [ ] **Step 9: Commit any fixes**

```bash
git add README.md
git commit -m "docs(readme): fix issues found in the verification pass"
```

---

## Self-Review

**Spec coverage.** Fold with chips and GIF → Tasks 1 and 5. Text headings kept → Global Constraints, verified at Task 6 Step 6. Features matrix over collapsed depth → Task 2, losslessness verified at Step 6. Five new assets → Tasks 1, 3, 4, 5. Host grid → Task 4. Non-goals → Global Constraints, competitor check at Task 6 Step 5. Verification list → Task 6. Spec open item "test-count chip" → resolved to *cancelled*, with evidence. Spec open item "chip count" → resolved to four.

**Placeholder scan.** Task 3 Step 1 and Task 4 Step 3 describe diagram content rather than shipping literal SVG source. That is deliberate: both are illustrations whose composition depends on the finished text, and pre-writing several hundred lines of coordinates would be guesswork the implementer would have to redo. Each is constrained by exact dimensions, a required palette, a stated point to convey, and a machine-checkable accessibility assertion in the step that follows.

**Type consistency.** Chip filenames match across Task 1 Steps 2-4 and 6 and the File Structure table. `docs/assets/chips/light/` is the light path everywhere. The `#everything-else` anchor is produced by Task 2 Step 4 but consumed by Task 1 Step 6, which lands first — an ordering hazard, so Task 6 Step 3 re-checks all anchors after both have landed. The anchor-slug script in Task 1 Step 9 matches `^#+` rather than `^##+` so it sees `### Everything else`.
