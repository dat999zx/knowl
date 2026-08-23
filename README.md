<div align="center">

<img src="docs/assets/hero.png" alt="Knowl — persistent memory across sessions for Claude Code, Cursor and Codex, over MCP" width="100%" />

**Your CLAUDE.md only grows. Knowl retires facts when they change.**

[![npm](https://img.shields.io/npm/v/%40dat999zx%2Fknowl?color=4fd8e8&label=npm)](https://www.npmjs.com/package/@dat999zx/knowl)
[![CI](https://img.shields.io/github/actions/workflow/status/dat999zx/knowl/ci.yml?branch=main&label=CI)](https://github.com/dat999zx/knowl/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-Apache--2.0-85c577)](LICENSE)
[![node](https://img.shields.io/badge/node-%E2%89%A522-70b6fd)](package.json)
[![MCP](https://img.shields.io/badge/protocol-MCP-cab049)](https://modelcontextprotocol.io)

<a href="https://www.producthunt.com/products/knowl?embed=true&amp;utm_source=badge-featured&amp;utm_medium=badge&amp;utm_campaign=badge-knowl" target="_blank" rel="noopener noreferrer"><img alt="Knowl - Agent memory that knows when to forget | Product Hunt" width="250" height="54" src="https://api.producthunt.com/widgets/embed-image/v1/featured.svg?post_id=1228671&amp;theme=light&amp;t=1787366617137"></a>

<p align="center">
  <a href="#the-idea-memory-that-retires-itself"><picture><source media="(prefers-color-scheme: light)" srcset="docs/assets/chips/light/stat-supersession.svg"><img src="docs/assets/chips/stat-supersession.svg" alt="Scores 90 on MemoryAgentBench FactConsolidation single-hop at 262K" height="38" /></picture></a>
  <a href="#quick-start"><picture><source media="(prefers-color-scheme: light)" srcset="docs/assets/chips/light/stat-nokeys.svg"><img src="docs/assets/chips/stat-nokeys.svg" alt="0 API keys needed" height="38" /></picture></a>
  <a href="#everything-else"><picture><source media="(prefers-color-scheme: light)" srcset="docs/assets/chips/light/stat-tools.svg"><img src="docs/assets/chips/stat-tools.svg" alt="27 MCP tools" height="38" /></picture></a>
  <a href="#what-knowl-is-for"><picture><source media="(prefers-color-scheme: light)" srcset="docs/assets/chips/light/stat-local.svg"><img src="docs/assets/chips/stat-local.svg" alt="100% local, no egress" height="38" /></picture></a>
</p>

[Quick start](#quick-start) ·
[Why supersession](#the-idea-memory-that-retires-itself) ·
[What gets stored](#what-gets-stored) ·
[Features](#features) ·
[Agent setup](#connecting-an-agent) ·
[Viewer](#see-it-the-local-viewer) ·
[Requirements](#requirements-and-local-data) ·
**[Full reference →](docs/reference.md)**

</div>

---

Your agent starts every session blank, so you keep a `CLAUDE.md`. It only grows. Six months in it
still names the database you migrated off last spring, and now the agent gets both answers.

Knowl is persistent memory for Claude Code, Cursor and Codex, over
[MCP](https://modelcontextprotocol.io) or the CLI. When a fact is replaced, the old one is retired
instead of competing with the new one. No API key needed. When Knowl isn't sure the new fact
replaces the old, it leaves both active and hands you the `knowl supersede` command to say so.

Turn that off and retrieval drops from 98% to 47%. End to end, 90 to 73.
[How it was measured ↓](#the-idea-memory-that-retires-itself)

Forty seconds, one decision, three agents:

<div align="center">
<img src="docs/assets/knowl-showcase.webp" alt="Claude Code answers which database the project uses from memory, records the move to Postgres and retires the MySQL decision; Codex answers the same question from that memory in a second terminal; the Claude app answers from the same store over the hosted connector" width="88%" />
</div>

## Quick start

Requires Node.js 22 or later. macOS, Linux and Windows.

```bash
npm install -g @dat999zx/knowl
cd your-project
knowl init
```

<details>
<summary>Other package managers</summary>

The published package is the same one in every case; each of these installs it and puts `knowl`
on your `PATH`.

```bash
pnpm add -g @dat999zx/knowl
yarn global add @dat999zx/knowl
bun add -g @dat999zx/knowl
```

Or run it without installing:

```bash
npx @dat999zx/knowl init
```

Knowl runs on Node.js in all of these — Bun installs it, Node executes it. It bundles native
addons (SQLite, tree-sitter, the embedding runtime), so running the CLI under the Bun or Deno
runtime directly is not supported.

</details>

`knowl init` creates `.knowl/`, installs the project guidance files, updates `.gitignore`, and
registers Knowl with whichever agents it detects. It also warms a local embedding model (~53 MB)
in the background — `init` succeeds either way, and without it you still get keyword search.

That is the whole setup. You do not record memory by hand: your agent reads and writes it as it
works.

## Connecting an agent

<table>
<tr>
<td align="center" width="16%">
<a href="https://claude.com/product/claude-code"><img src="docs/assets/logos/anthropic.svg" alt="Claude Code" width="40" height="40" /></a><br/>
<strong>Claude Code</strong><br/>
<sub>MCP · lifecycle · gate</sub>
</td>
<td align="center" width="16%">
<a href="https://github.com/openai/codex"><img src="docs/assets/logos/openai.svg" alt="Codex" width="40" height="40" /></a><br/>
<strong>Codex</strong><br/>
<sub>MCP · lifecycle · gate</sub>
</td>
<td align="center" width="16%">
<a href="https://github.com/features/copilot"><picture><source media="(prefers-color-scheme: dark)" srcset="docs/assets/logos/githubcopilot-dark.svg" /><img src="docs/assets/logos/githubcopilot.svg" alt="Copilot" width="40" height="40" /></picture></a><br/>
<strong>Copilot</strong><br/>
<sub>MCP · lifecycle · gate</sub>
</td>
<td align="center" width="16%">
<a href="https://cursor.com"><picture><source media="(prefers-color-scheme: dark)" srcset="docs/assets/logos/cursor-dark.svg" /><img src="docs/assets/logos/cursor.svg" alt="Cursor" width="40" height="40" /></picture></a><br/>
<strong>Cursor</strong><br/>
<sub>MCP · lifecycle · gate</sub>
</td>
<td align="center" width="16%">
<a href="https://openhands.dev"><img src="docs/assets/logos/openhands.svg" alt="OpenHands" width="40" height="40" /></a><br/>
<strong>OpenHands</strong><br/>
<sub>MCP · lifecycle · gate</sub>
</td>
<td align="center" width="16%">
<a href="https://antigravity.google"><img src="docs/assets/logos/antigravity.svg" alt="Antigravity" width="40" height="40" /></a><br/>
<strong>Antigravity</strong><br/>
<sub>MCP · lifecycle · gate</sub>
</td>
</tr>
<tr>
<td align="center" width="16%">
<a href="https://windsurf.com"><picture><source media="(prefers-color-scheme: dark)" srcset="docs/assets/logos/windsurf-dark.svg" /><img src="docs/assets/logos/windsurf.svg" alt="Windsurf" width="40" height="40" /></picture></a><br/>
<strong>Windsurf</strong><br/>
<sub>MCP · lifecycle · gate</sub>
</td>
<td align="center" width="16%">
<a href="https://github.com/cline/cline"><picture><source media="(prefers-color-scheme: dark)" srcset="docs/assets/logos/cline-dark.svg" /><img src="docs/assets/logos/cline.svg" alt="Cline" width="40" height="40" /></picture></a><br/>
<strong>Cline</strong><br/>
<sub>MCP · lifecycle · plugin</sub>
</td>
<td align="center" width="16%">
<a href="https://zed.dev"><img src="docs/assets/logos/zed.svg" alt="Zed" width="40" height="40" /></a><br/>
<strong>Zed</strong><br/>
<sub>MCP · capture · ACP</sub>
</td>
<td align="center" width="16%">
<a href="https://www.jetbrains.com"><picture><source media="(prefers-color-scheme: dark)" srcset="docs/assets/logos/jetbrains-dark.svg" /><img src="docs/assets/logos/jetbrains.svg" alt="JetBrains" width="40" height="40" /></picture></a><br/>
<strong>JetBrains</strong><br/>
<sub>MCP · capture · ACP</sub>
</td>
<td align="center" width="16%">
<a href="https://github.com/anomalyco/opencode"><picture><source media="(prefers-color-scheme: dark)" srcset="docs/assets/logos/opencode-dark.svg" /><img src="docs/assets/logos/opencode.svg" alt="OpenCode" width="40" height="40" /></picture></a><br/>
<strong>OpenCode</strong><br/>
<sub>MCP · manual loop</sub>
</td>
<td align="center" width="16%">
<a href="https://claude.ai/download"><img src="docs/assets/logos/anthropic.svg" alt="Claude Desktop" width="40" height="40" /></a><br/>
<strong>Claude Desktop</strong><br/>
<sub>MCP · manual loop</sub>
</td>
</tr>
</table>

`knowl init` registers the MCP server for every host it finds. Start a new session afterwards so
the agent picks up its guidance, and it will query and write memory on its own.

**gate** means Knowl can refuse an edit that invalidates code another session is holding.
Neovim and Kiro work the same way as Zed and JetBrains, through `knowl acp`. Cline needs one
line pointing it at the shipped plugin. Any other MCP client works with no integration at all.

→ [Every host, and what each one can do](docs/hosts.md) · [How agents use it](#how-agents-use-it) · [MCP tools and resources](docs/reference.md#mcp-tools-and-resources)

## The idea: memory that retires itself

Most memory systems are append-only. Storing "we moved to SQLite" leaves "we use PostgreSQL"
active and retrievable, so the agent gets both and picks by rank. Knowl treats a same-subject write
as a correction: the predecessor is marked `superseded`, drops out of normal retrieval, and stays
queryable through [`knowl timeline`](docs/reference.md#metadata-history-and-ownership).

<div align="center">
<img src="docs/assets/demo-store.svg" alt="A write naming a subject the store already holds: the replacement takes the active lane, the predecessor is stamped superseded and moved into history, and a later query sweep matches only the current decision" width="92%" />
</div>

That single behavior is most of the accuracy difference. On the
[MemoryAgentBench](https://github.com/HUST-AI-HYZ/MemoryAgentBench) Conflict Resolution corpus —
455 facts, 100 questions about which fact is current, top-5 retrieval, no LLM reader:

<div align="center">
<img src="docs/assets/benchmark-conflict-resolution.svg" alt="Conflict-resolution retrieval ablation: supersession on reached 98 percent top-1 with 2 stale returns; supersession off reached 47 percent top-1 with 62 stale returns" width="82%" />
</div>

| Configuration | Top-1 | Stale returns | Active atoms |
| --- | ---: | ---: | ---: |
| **Supersession ON** | **98.0%** | **2 / 100** | 306 |
| Supersession OFF | 47.0% | 62 / 100 | 455 |

Same corpus, same ranker, same query path. The only variable is whether the outdated fact is still
active. This is a **retrieval-level** measurement in Knowl's own harness: it asks whether the
current fact comes back first, with no model in the loop.

### Verified end-to-end, in the benchmark's own harness

Because a number you score yourself is worth less than one somebody else scores, the same claim was
re-run **inside MemoryAgentBench's harness, scored by its own code**, with an LLM reading what
Knowl returned — the harder, fully end-to-end setup, at the largest context the task offers:

<div align="center">
<img src="docs/assets/benchmark-mab-comparison.svg" alt="MemoryAgentBench FactConsolidation single-hop at 262K context, substring exact match, gpt-4o-mini reader: Knowl 90, agentmemory 79, GPT-4o long-context 60, HippoRAG-v2 54, BM25 48, GPT-4o-mini long-context 45, Qwen3-Embedding-4B 29, Cognee 28, MemGPT 28, Mem0 18, MIRIX 14, Zep 7" width="82%" />
</div>

| System | FactConsolidation-SH @262K |
| --- | ---: |
| **Knowl** | **90** |
| **agentmemory** | **79** |
| GPT-4o (long-context) | 60 |
| HippoRAG-v2 | 54 |
| BM25 | 48 |
| GPT-4o-mini (long-context) | 45 |
| Qwen3-Embedding-4B | 29 |
| Cognee | 28 |
| MemGPT | 28 |
| Mem0 | 18 |
| MIRIX | 14 |
| Zep | 7 |

18,332 facts, 100 questions, substring exact match. Every row uses **gpt-4o-mini as the reader**,
Knowl's included — the paper states it for all RAG and memory agents, so these are like-for-like.
**Knowl and agentmemory were measured here; every other figure is from the MemoryAgentBench
paper**, [arXiv 2507.05257v4](https://arxiv.org/abs/2507.05257v4), Table 3. agentmemory is not
evaluated in that paper — its published numbers are LongMemEval-S retrieval recall, a different
task — so it was run through the same harness with the same config, and both adapters share one
reader code path so neither can drift from the paper's own RAG handler. Method, mechanism and
reproduction steps: [FINDINGS.md](benchmarks/memoryagentbench/mab/FINDINGS.md).

Otherwise shown are every commercial memory system the paper evaluates, plus the highest scorer
from each baseline family. The paper's table has changed between versions — BM25 read 56 in v1 and
reads 48 in v4 — so the version is cited, not just the table.

Knowl's 90 was measured 2026-08-08 and independently reproduced at **89.0** on 2026-08-19 with the
checked-in adapter; agentmemory's 79 is a single run. Every figure here is one run at
`temperature: 0.7`, and the ablation gap moved 4 points between two runs of the same 6k cell, so
read them to the point rather than the decimal.

Switching supersession off in that same harness drops Knowl to **73**, and the gap holds across a
40× change in corpus size:

<div align="center">
<img src="docs/assets/benchmark-supersession-ablation.svg" alt="Supersession ablation in MemoryAgentBench's own harness: at 262K context, supersession on scores 90 and off scores 73, a 17 point gap; at 6K context, on scores 94 and off scores 78, a 16 point gap" width="82%" />
</div>

| Context | Supersession ON | OFF | Gap |
| --- | ---: | ---: | ---: |
| 262K | **90** | 73 | **+17** |
| 6K | **94** | 78 | **+16** |

The two sections measure different things and are not comparable to each other: 98% is retrieval
top-1 at 6K with no reader, 90 is end-to-end accuracy at 262K with one. Only the second is
comparable to the published systems above. See [benchmarks](docs/reference.md#benchmarks) for the
protocol, the checked-in results, and what the task does not cover — including multi-hop, where
Knowl scores 7 against a 14-point retrieval ceiling.

Supersession is a correction, not a delete: the item, its assertions, and its history all survive.

Not a mock-up — the same sequence against the published CLI, recorded from
[`demo.tape`](docs/assets/demo.tape):

<div align="center">
<img src="docs/assets/demo.gif" alt="Terminal recording: knowl decide records a database decision, a second decide on the same subject reports Superseded older decision, and knowl status then reports one active item and one superseded" width="88%" />
</div>

## Sharing memory across a team: knowl.cloud

Everything above is local and needs no account. [knowl.cloud](https://knowl.cloud) is the optional
hosted layer for when one machine is not enough:

- **Shared workspaces.** Knowledge written in one checkout reaches teammates' agents, with each
  repository still owning what it publishes.
- **Browser agents.** claude.ai and chatgpt.com cannot run a local process, so they connect over a
  remote MCP endpoint with a token scoped to one workspace.

Local-only remains a first-class way to run Knowl. Nothing here is required to use anything above.

## What gets stored

Every atom has exactly one of seven categories:

| Category | Use it for |
| --- | --- |
| `fact` | Stable project truths, conventions, and verified behavior |
| `decision` | A selected option with reasoning and alternatives |
| `goal` | An intended outcome that guides future work |
| `constraint` | A rule or boundary that must continue to hold |
| `architecture` | How components are arranged and interact |
| `state` | Current progress, readiness, blockers, or operational status |
| `skill` | A reusable procedure or learned workflow description |

<div align="center">
<img src="docs/assets/atom-anatomy.svg" alt="A decision atom with its governed fields: status, freshness, confidence, tags, source commit, affected paths, and evidence — one evidence locator shown gone stale" width="88%" />
</div>

Alongside the content, each atom keeps a status (`active`, `deprecated`, `rejected`, `archived`,
`superseded`), a freshness flag, confidence, tags, source commit, affected paths, and optional
**evidence** pointing at files, commits, tests, commands, URLs, or indexed code symbols. File and
symbol evidence go stale on their own when the code moves, which is how an atom admits it may be
out of date instead of asserting a version of the repository that no longer exists.

What Knowl deliberately does *not* store is your conversations. Lifecycle capture records bounded
events and summaries — never prompts, transcripts, stdout, or environment variables. Raw transcript
search exists as an [opt-in, off-by-default index](docs/reference.md#searchable-session-transcripts-optional-off-by-default)
over files the host already wrote.

→ [Knowledge model reference](docs/reference.md#core-knowledge-model)

## How agents use it

`knowl serve` exposes the store over stdio MCP; `knowl init` registers it for you. The workflow the
installed guidance asks agents to follow is short:

1. Query memory with the words that name the subject **before** reading repository files.
2. Use an active hit directly; inspect files only on a miss, conflict, or stale result.
3. Store durable findings, stated goals, and recurring diagnoses as you go, and correct
   contradicted memory rather than duplicating it.

In practice that looks like this — a new session, no context, nothing pasted in:

```text
You     why did we pick SQLite over Postgres?

Agent   → knowl_query "sqlite postgres database choice"
        ← decision · Use SQLite · active · fresh
          "Keeps storage repository-local and simple to operate."
          alternatives: PostgreSQL, MongoDB
          tags: database, local-first

        SQLite keeps the store repository-local and simple to operate.
        Postgres and MongoDB were both considered and rejected on that
        basis.
```

The agent answered before opening a single file, and it knew the options you *rejected* —
which the code cannot tell it, because rejected alternatives leave no trace in a codebase.

| Host | MCP | Automatic lifecycle | Write gate | Capture nudge | Notes |
| --- | --- | --- | --- | --- | --- |
| Claude Code | Yes | Yes | Yes | Yes | Prompt guidance is installed as well |
| Codex CLI | Yes | Yes | Yes | Yes | Hooks need `codex_hooks`; not on Windows |
| GitHub Copilot | Yes | Yes | Yes | Yes | Reuses Claude Code's hook format |
| OpenHands | Yes | Yes | Yes | Yes | MCP entry is added by hand |
| Antigravity | Yes | Yes | Yes | Yes | Context rides `injectSteps` |
| Windsurf | Yes | Yes | Yes | Yes | Nudge rides MCP; no stop hook |
| Cursor | Yes | Yes | Yes | Yes | Finalizes per turn |
| Cline | Yes | Yes | No | Yes | Lifecycle via the shipped plugin |
| Zed, JetBrains, Neovim, Kiro | Yes | Yes | No | Yes | Via `knowl acp --` |
| Claude Desktop, OpenCode, Roo, … | Yes | No | No | Yes | MCP plus the manual work loop |

Full detail, and why each gap exists, in [docs/hosts.md](docs/hosts.md).

<div align="center">
<img src="docs/assets/lifecycle.svg" alt="Session lifecycle: bootstrap injects relevant memory, capture records bounded events, checkpoints record milestones, finalization distills durable candidates" width="88%" />
</div>

Where hooks are available, they own the session lifecycle: bootstrap context, capture, checkpoints,
and finalization happen without the agent being asked. Where they are not, `knowl task run`,
`task start`, `task checkpoint`, and `task finish` cover the same ground manually.

`knowl init` writes the MCP registration for every host it detects. To wire one by hand, the
entry is the same everywhere:

```json
{
  "mcpServers": {
    "knowl": { "command": "knowl", "args": ["serve"] }
  }
}
```

Use `knowl.cmd` as the command on Windows. Codex reads the same entry under `mcp_servers`.

→ [MCP tools and resources](docs/reference.md#mcp-tools-and-resources) · [Lifecycle reference](docs/reference.md#tasks-sessions-and-agent-lifecycle)

## What Knowl is for

Knowl does one job: keep a repository's engineering truth accurate for the agents working on it.
Not user preferences, not chat history — the decisions, constraints, and architecture of a
codebase, and which of them are still true today.

<div align="center">
<img src="docs/assets/demo-drift.svg" alt="One question answered four times over two years: append-only keeps every answer true forever so a query today matches four contradicting ones, while a governed store ends each replaced answer and matches one" width="92%" />
</div>

Three choices follow from that:

- **Typed, not free text.** A decision carries reasoning and the alternatives you rejected. A
  constraint is a rule that must keep holding. A `state` atom is *expected* to go out of date.
  Retrieval can rank on those differences; it cannot rank on paragraphs in a notes file.
- **Governed, not append-only.** Status, freshness, provenance, conflict identity, and supersession
  let the store tell you that something *stopped* being true. That is the whole difference between
  memory and an ever-growing pile of notes.
- **Repository-local, not a service.** The database sits beside the code it describes. No account,
  no egress, no vendor between you and your own project history.

Knowl is deliberately not a personalization layer. It has no opinion about your users, and it keeps
no transcripts of its own.

## Features

Everything below works from the CLI and from any MCP-connected agent, against the same local
database. No account, no server, no API key. Each item links into the
[full reference](docs/reference.md) for the detail — and for the limits.

<table>
<tr>
<td width="50%" valign="top">

**♻️ Knowledge that corrects itself**

Seven typed atom types, where a same-subject write retires its predecessor instead of
sitting beside it. That one behavior is the [90-vs-73 difference](#the-idea-memory-that-retires-itself).
Evidence attached to a file or symbol goes stale *by itself* when the code moves.

`conflicts` · `timeline` · `query --as-of` · `pr --since` · `index-code`

</td>
<td width="50%" valign="top">

**🎯 Retrieval tuned for agents**

Vector-primary with a bounded BM25 fallback, reranked by freshness, status, and confidence,
so the *current* answer wins rather than the merely similar one. The embedding model is
local and optional — without it you still get keyword retrieval, and nothing leaves the machine.

`query` · `context --token-budget` · `config set-model` · `access`

</td>
</tr>
<tr>
<td width="50%" valign="top">

**⏱️ Work that survives the session**

On Claude Code, Codex, and Cursor, hooks own bootstrap, capture, checkpoints, and
finalization without the agent being asked. A clean finish distills up to eight durable
candidates. Park a workstream under a key and pick it up in any session, from any directory.

`task run` · `handoff` · `park` · `resume <key>`

</td>
<td width="50%" valign="top">

**🔗 Workspaces**

Your API repo learned something the frontend repo needs. Link them and a query fans out,
while each repository keeps its own database and its own ownership boundary. Open a shared
peer atom in full by id, or finish that repo's work from here by naming it on the call.
Knowledge a repo already holds is shared only when you promote it.

`workspace init` · `workspace add` · `workspace promote --apply`

</td>
</tr>
<tr>
<td width="50%" valign="top">

**📦 Reusable procedures**

Package a procedure with its scripts under `.knowl/skills/`, then read it before it ever
runs. Roll several atoms into one architecture summary deterministically, with no AI
provider involved at all.

`skill list` · `skill read` · `skill run` · `synthesize`

</td>
<td width="50%" valign="top">

**💾 Your data, and getting it back**

Checksummed JSONL export and import with four explicit policies for when the same atom
changed in two places. Restore verifies schema, size, SHA-256, and SQLite integrity
*before* touching anything, and takes a pre-restore snapshot first.

`export` · `import --on-divergence` · `snapshot create` · `gc` · `doctor`

</td>
</tr>
</table>

The commands worth knowing on day one:

```bash
knowl query "auth design"              # search project memory
knowl list --unread                    # browse it — and see what nothing ever reads
knowl edit <item-id>                   # open one memory in the viewer to fix it
knowl state                            # the active memory, as a hierarchy
knowl conflicts                        # items that contradict each other
knowl timeline <item-id>               # every version an atom ever had
knowl context --token-budget 1500      # a fixed-size briefing for an agent
knowl pr --since origin/main           # knowledge your diff may invalidate
knowl doctor                           # setup, retrieval, and registration
```

<details>
<summary><b>Knowledge that corrects itself</b> — seven typed atom types, and a write that retires what it replaces</summary>
<br>

- **Seven atom types** — [listed above](#what-gets-stored). Structure instead of one growing
  notes file.
- **Automatic supersession** — a same-subject write retires its predecessor. This is the
  [90-vs-73 difference](#the-idea-memory-that-retires-itself) above.
- **Conflict identity** — mark an atom exclusive and Knowl refuses a second active answer to the
  same question, instead of quietly holding both. `knowl conflicts`
- **Full history** — every version an atom ever had survives as an immutable assertion.
  `knowl timeline <item-id>`
- **Time travel** — ask what the project believed on a past date:
  `knowl query "auth design" --as-of 2026-01-01T00:00:00Z`
- **Evidence** — attach files, symbols, commits, tests, commands, or URLs to an atom. File and
  symbol evidence go stale *by themselves* when the code moves.
- **Drift detection** — `knowl pr --since origin/main` flags knowledge your diff may have
  invalidated, before you merge it.
- **Code intelligence** — incremental Tree-sitter index over `.ts` / `.tsx` / `.js` / `.jsx`, so
  evidence can point at `symbol://` locators, not just line numbers. `knowl index-code`
- **Secret-safe writes** — every write is screened for detected secrets, sensitive paths, and
  oversized content before it lands. Long-lived memory is the last place a credential should end up.

→ [Knowledge model](docs/reference.md#core-knowledge-model) ·
[Evidence and drift](docs/reference.md#evidence-code-intelligence-and-drift)

</details>

<details>
<summary><b>Retrieval tuned for agents</b> — the current answer wins, not merely the similar one</summary>
<br>

- **Vector-primary ranking** with a bounded BM25 fallback, reranked by freshness, status,
  confidence, and recency — so the *current* answer wins, not merely the similar one. (This is the
  agent/MCP path; a single-repo `knowl query` from the CLI is lexical.)
- **Runs offline.** The embedding model is local and optional; without it you still get keyword
  retrieval. Retrieval never sends your query anywhere.
- **Five bundled embedding presets**, including a multilingual one covering 200+ languages, plus
  `custom` for your own ONNX model. `knowl config set-model <model>`
- **Exact-identifier support** — filenames, item IDs, and `symbol://` locators still hit even when
  semantic similarity is weak.
- **Token-budgeted context packs** — hand an agent a fixed-size briefing with constraints pinned
  first, so non-negotiable rules never get truncated away:
  `knowl context --query "auth rollout" --token-budget 1500`
- **Usage feedback** — agents report whether a result helped, and `knowl access` shows what
  is heavily used, what is stale, and what keeps causing corrections.

→ [Retrieval and context](docs/reference.md#retrieval-and-context)

</details>

<details>
<summary><b>Work that survives the end of a session</b> — hooks, work loops, handoff batons, and resume keys</summary>
<br>

- **Automatic lifecycle** on Claude Code, Codex, and Cursor — bootstrap, capture, checkpoints, and
  finalization happen through hooks without the agent being asked.
- **Work loops** for everything else — `knowl task start`, `checkpoint`, `finish`, or wrap a single
  command with `knowl task run "Run tests" -- npm test`.
- **Promotion at session end** — a clean finish distills up to eight durable candidates out of the
  session, and a command that has succeeded three times becomes a `skill` atom describing it.
- **Handoff** — leave one baton for the next session in this repo. It is delivered once, then
  archived.
- **Resume keys** — park a workstream under a short key you keep, and pick it up in any session,
  from any directory, any number of times later. `knowl resume <key>`
- **Optional transcript search** — off by default, and off means nothing exists on disk. Turn it on
  and past session prose becomes searchable, so a memory miss degrades to a slower lookup instead
  of amnesia.

→ [Tasks, sessions, and lifecycle](docs/reference.md#tasks-sessions-and-agent-lifecycle)

</details>

<details>
<summary><b>Workspaces: many repos, one shared memory</b> — you decide what each repo shares</summary>
<br>

Your API repo learned something the frontend repo needs. Link them, and a query fans out — while
each repository keeps its own database and its own ownership boundary.

```bash
knowl workspace init product      # create the workspace
knowl workspace add product       # run inside each repo that joins it
                                  # ...or --default-visibility repo to keep its writes private

knowl workspace promote                               # pick what to share from a list
knowl workspace promote --category decision --apply   # or name it outright
```

Joining a workspace shares what the repo writes **from then on**, and says so when it does; pass
`--default-visibility repo` to decline. What the repo already knows is shared only when you
promote it. Peer results are labeled with the repo that owns them, and a shared one can be opened
in full by id — without its `affectedPaths` or evidence, which resolve against a checkout you are
not standing in. A peer that is missing or unreadable is skipped and disclosed, never a reason for
your local search to fail.

Writing into a sibling is deliberate rather than incidental. An agent names the repo on the call
and that one call runs **as** that repo — its store, its config, its ownership rules, stamped as
its own — exactly as `cd`-ing there has always behaved for the CLI. Name nothing and a foreign id
is refused as before. Either way a repo's private knowledge stays private until it is promoted.

→ [Workspaces](docs/reference.md#workspaces)

</details>

<details>
<summary><b>Reusable procedures</b> — file-backed skills you can inspect before they run</summary>
<br>

- **File-backed skills** — package a procedure with its scripts under `.knowl/skills/`, then
  inspect it before it ever runs. `knowl skill list` · `read` · `run`
- **Deterministic synthesis** — roll several atoms into one architecture summary with no AI
  provider involved: `knowl synthesize --scope storage`

→ [Skills and synthesis](docs/reference.md#learned-skills-and-synthesis)

</details>

<details>
<summary><b>Your data, and getting it back</b> — portable export, verified snapshots, and one doctor command</summary>
<br>

- **Portable export/import** — checksummed JSONL with four explicit divergence policies for when
  the same atom changed in two places. `knowl export` · `knowl import --on-divergence newer`
- **Verified snapshots** — `knowl snapshot create` writes a checksum manifest; restore verifies
  schema version, size, SHA-256, and SQLite integrity *before* touching anything, and takes a
  pre-restore snapshot first.
- **Garbage collection** that previews by default and protects anything recently used. `knowl gc`
- **`knowl doctor`** — one command that checks setup, config, integrity, schema, retrieval, vector
  coverage, agent registration, and workspace health.
- **Optional AI** — configure a provider for `knowl ask` and raw-text ingest. Every feature above
  works without one.

→ [Portability and maintenance](docs/reference.md#portability-and-maintenance) ·
[Optional AI](docs/reference.md#optional-ai)

</details>

### See it: the local viewer

`knowl view` starts an editor on `127.0.0.1` with a fresh access token per launch — knowing the
port is not enough to read anything, and writes additionally require the request to name this
viewer as its origin, so another page you happen to have open cannot write here.

```bash
knowl view
```

<p align="center">
  <img src="docs/assets/viewer-graph.png" alt="The Knowl local viewer: the memory graph, each atom a lit point coloured by kind, linked only through tags few atoms share, with unlinked atoms scattered on the rim" width="48%" />
  <img src="docs/assets/viewer-inspect.png" alt="The Knowl local viewer list: every atom with an unread mark in the margin, and one atom open in the inspector with its markdown, tags and timeline rendered" width="48%" />
</p>

**This is where you fix what your agents got wrong.** Open any atom to read its evidence and
timeline, then edit it, archive it, or write a new one by hand. Archiving is reversible — Restore
is on the same panel.

Beside the graph there is a list, with a lens for **what nothing has ever read**. That one earns
its place: search only reaches memory you already suspect exists, and an atom carrying no
information is precisely the one nobody thinks to look for. Sorted oldest-first, it surfaces on its
own. `knowl list --unread` asks the same question from the terminal.

The graph links atoms only through tags **few** atoms share — a tag on dozens of them is a
category, and the rail already filters by those. An atom nothing else is about stays unlinked
rather than being tied to an arbitrary neighbour. It is a navigation aid, not a causal or
evidence graph. It shows full local content across every status, so loopback binding is the
privacy boundary: do not put it behind a public proxy or tunnel.

→ [Local viewer](docs/reference.md#local-viewer)

### Everything else

<!-- generated:tool-count -->
**27 MCP tools** (plus 3 when transcript search is on, 1 when connected to a cloud workspace, 1 when linked into a local workspace, and 1 when change impact is on)
<!-- /generated:tool-count -->
and two resource URIs · the
**complete CLI**, from `knowl status` to `knowl audit` · a **read-only integrity audit** ·
**retrieval evaluation** you can run yourself against the checked-in governance and 500-case
regression suites with `knowl eval`.

→ [CLI reference](docs/reference.md#cli-reference) ·
[MCP tools](docs/reference.md#mcp-tools-and-resources) ·
[Benchmarks](docs/reference.md#benchmarks)

## Requirements and local data

Node.js 22 or later. Everything Knowl writes for a project lives under `.knowl/`, which `knowl init`
adds to `.gitignore`:

| Path | Holds |
| --- | --- |
| `.knowl/config.json` | Project, search, security, AI, and workspace configuration |
| `.knowl/knowl.db` | Atoms, assertions, knowledge commits, full-text index, feedback, embeddings |
| `.knowl/skills/` | File-backed skill packages |

Workspace manifests live outside member repositories, because their checkout paths are
machine-local. Exports and snapshots are written only when you ask for them.

## Documentation

Everything above is the summary. The **[full reference](docs/reference.md)** is one document
covering every subsystem in depth — including the parts that are deliberately limited, which is
usually what you actually need to know.

| If you want to know… | Go to |
| --- | --- |
| What an atom is, and what each field means | [Knowledge model](docs/reference.md#core-knowledge-model) |
| How a query is ranked, and what wins ties | [Retrieval and context](docs/reference.md#retrieval-and-context) |
| What a hook records, and when | [Tasks, sessions, lifecycle](docs/reference.md#tasks-sessions-and-agent-lifecycle) |
| How an atom notices the code moved | [Evidence and drift](docs/reference.md#evidence-code-intelligence-and-drift) |
| How several repos share memory safely | [Workspaces](docs/reference.md#workspaces) |
| How a procedure becomes reusable | [Skills and synthesis](docs/reference.md#learned-skills-and-synthesis) |
| How to export, snapshot, or restore | [Portability and maintenance](docs/reference.md#portability-and-maintenance) |
| How to read, correct and add memory by hand | [Local viewer](docs/reference.md#local-viewer) |
| How the pieces fit, and where the trust boundaries are | [Architecture](docs/reference.md#architecture-and-security-boundaries) |
| How to wire a specific host | [Agent setup](docs/reference.md#agent-setup) |
| How the numbers on this page were measured | [Benchmarks](docs/reference.md#benchmarks) |
| Every command and every flag | [CLI reference](docs/reference.md#cli-reference) |
| Every MCP tool and resource | [MCP tools](docs/reference.md#mcp-tools-and-resources) |
| What needs a provider, and what never does | [Optional AI](docs/reference.md#optional-ai) |
| Exactly what lands on disk | [Local data](docs/reference.md#local-data) |

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, the checks to run before a pull request, and the
conventions this codebase follows. Contributors are asked to agree to the
[Contributor License Agreement](CLA.md) once, on their first pull request.

## License

Knowl is licensed under the [Apache License 2.0](LICENSE). Apache-2.0 does not grant trademark
rights.

---

<div align="center">

[![knowl MCP server](https://glama.ai/mcp/servers/dat999zx/knowl/badges/card.svg)](https://glama.ai/mcp/servers/dat999zx/knowl)

</div>
