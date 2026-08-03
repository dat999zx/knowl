# Optional transcript search

**Date:** 2026-08-03
**Status:** Approved, ready for planning

## Problem

Knowl stores distilled atoms. That is lossy by construction: whatever the writer
did not judge salient is gone, and there is no fallback. The raw Claude Code
`.jsonl` transcripts are the complete record underneath, and Knowl cannot reach
them. A memory miss is therefore amnesia rather than a slower lookup.

PR #7 solved this by indexing every message, text included, into `knowl.db` and
shipping it always-on. This design keeps the capability and changes three things:
it is off by default, it indexes prose only, and it stores pointers instead of a
second copy of the archive.

## Scope

Search a repository's own Claude Code session transcripts — including subagent
transcripts and sessions run from its worktrees, wherever those live — and
optionally those of linked workspace repos that have opted in.

Out of scope: indexing tool output, ANN vector indexes, cross-project search
without explicit sharing, session browsing (a separate feature).

## Decisions

### 1. Off by default, one config flag

```jsonc
// .knowl/config.json
"search": {
  "transcripts": {
    "enabled": false,   // nothing is created, no MCP tools are registered
    "share": false      // let linked workspace repos read this index
  }
}
```

Surfaced as a toggle in `knowl config` beside the vector settings.

The gate is not decoration. The MCP guidance card is a token cost paid by every
session of every user. Measured on `main`: `KNOWL_MCP_SERVER_INSTRUCTIONS` is
**1,746 characters** and `KNOWL_CLAUDE_OPERATIONAL_CARD` **1,695**, against a
2,000 ceiling. One added Route line brings the server card to **1,885** — inside
the ceiling, but spending more than half the remaining headroom on a feature most
repos will not enable. Off by default means those users keep their 1,746 and
never learn these tools exist.

(PR #8 reported 1,917 / 2,000. That is PR #8's branch, which adds a tool this
design does not.)

There is no partial state: enabled with an incomplete index reports its coverage
(see §6).

**Disabling deletes `.knowl/transcripts.db`.** Not "stops using it" — deletes it.
An index left on disk after the feature is off is a copy of the archive's term
and vector data that nothing will ever refresh, and the user who turned the
feature off is precisely the one who did not agree to keep it. `knowl config`
performs the deletion on the true→false transition and says how many messages
were dropped.

**Semantic ranking follows `search.vector.enabled`.** The model, dtype and
pooling all come from `search.vector.preset`; embedding transcripts while the
config says vector search is off would mean one flag denying what another is
doing. With vectors off, transcript search is keyword-only and every result says
so. Vector search is on by default, so this is invisible to most repos.

### 2. Separate database: `.knowl/transcripts.db`

Transcripts do not share `knowl.db`. This single choice buys four things:

- **No write contention with atoms.** A 3,700-row backfill cannot block the live
  session writing knowledge. PR #11 hit `SQLITE_BUSY` and a permanent
  `SQLITE_BUSY_SNAPSHOT` stall doing exactly this in one file.
- **`knowl.db` stays small** and remains practical to back up.
- **"Off" is a file that does not exist**, not dormant tables in the main schema.
- **Workspace sharing is opening a sibling's file read-only** — no copying, no
  promotion pipeline, no shared-storage lifecycle.

### 3. Index prose only

Index user messages and assistant text. Skip `tool_use` and `tool_result` blocks
entirely.

**What this does not promise.** An earlier draft said "and pasted file bodies."
It cannot. Measured across 8 sessions of this repo's archive: user messages carry
2,005 `tool_result` blocks (dropped by type) against 126 `text` blocks, and of
75 string-content user messages exactly **one** exceeds 4,000 characters — a
context-continuation summary, not a paste. A file pasted into the prompt arrives
as ordinary text, structurally identical to typing. There is no marker to key on,
and a length threshold would be a knob that catches almost nothing while
silently discarding long questions. The exclusion is by block type, and the
claim is now scoped to what the block type actually guarantees.

Tool output is the bulk of transcript bytes and close to none of the value. A
search for `embedding crash` should hit the discussion, not forty log lines that
happen to contain the word. PR #7 needed a 0.3 score multiplier to stop pasted
files winning on volume; not indexing them removes both the noise and the knob.

**Measured, not estimated** — this repo's own transcripts, 2026-08-03:

| | files | source | prose messages | prose text |
|---|---|---|---|---|
| Main sessions | 23 | 71.6 MB | 3,262 | 1.7 MB |
| Subagent sessions | 52 | 9.3 MB | 455 | 0.5 MB |
| **Total** | **75** | **80.9 MB** | **3,717** | **2.2 MB** |

**Prose is 2.7% of the archive by bytes.** That single number carries the
decision: skipping tool output shrinks the corpus by a factor of ~37 while
removing nothing a person said.

The cost is honest: a unique error string that appeared only inside tool output
is not findable. Accepted.

### 3a. Subagent transcripts are included

The current archive format stores subagent sessions as separate `.jsonl` files in
a subdirectory named after the **parent session's UUID**:

```
d--coding-knowl/
  <parent-session>.jsonl
  78aed75d-.../          <- 40 subagent transcripts from that parent
    <subagent-session>.jsonl
```

PR #7 assumed subagent turns were either absent or interleaved into the parent
file as `isSidechain` entries, and disclosed the interleaved case as an
unhandled limitation. Neither is what the current format does. Enumeration must
walk one level of subdirectories or it silently misses 52 of this repo's 75
transcript files.

They are worth indexing: 455 prose messages, 12% of the corpus, and
disproportionately investigation detail. The parent link is free — it is the
directory name — so a hit can report `subagent of <parent session>`.

### 3b. Worktree roots come from git, not from a path convention

An earlier draft matched directories named `<encoded-root>-worktrees-*`,
inferring a convention from the one worktree that happened to be in this repo's
archive. That is wrong. Git worktrees live wherever they were created, and this
repo's live worktree is on a **different drive**:

```
D:/coding/knowl                                     [main]
C:/Users/Admin/AppData/Local/Temp/claude/knowl-pr7  [pr-7]
```

which encodes to `C--Users-Admin-AppData-Local-Temp-claude-knowl-pr7` — sharing
no prefix with the main root at all.

Roots come from `git worktree list --porcelain`, and each root is encoded
independently. The consequence is that a **deleted** worktree's transcripts stop
being discoverable, which is correct: its rows are then cleaned up by the same
dead-file path as any other vanished transcript (§Failure modes). Git failing or
the repo not being a checkout degrades to the main root alone, never to an
error — this runs on every enabled session.

### 4. Pointers, not text

A row is `(session_id, line_number, role, char_count)`. The message body is never
copied. A hit returns `transcript://<session>#L<line>`; the reader opens the
`.jsonl` and pulls that line.

Ranking is unaffected — BM25 scores from the term index, which is identical
either way. Dropping the text drops the copy, not the signal.

| Table | Holds | Size (this repo, 3,717 messages) |
|---|---|---|
| `transcript_messages` | session id, parent session, line, role, char count | ~0.3 MB |
| `transcript_fts` | FTS5 contentless term index over 2.2 MB of prose | ~1 MB |
| `transcript_vectors` | int8, 384-dim, one per message | 1.4 MB |
| `transcript_files` | path, `bytes_indexed` watermark, mtime, size | trivial |

**Under 3 MB total, against 80.9 MB of source** — a 27× reduction, and no
duplicated text. First-run embedding cost at the measured ~60 ms/doc is roughly
**4 minutes**, once, after opt-in.

**Verified, not assumed:** `@libsql/client` runs SQLite 3.45.1.
`content='', contentless_delete=1` is supported, so row deletion is clean.
`snippet()` returns `null` on a contentless table — confirmed by direct test —
so all preview text comes from reading the file. The design already assumed this;
it is recorded here so no implementer re-litigates it.

### 5. Incremental by byte offset

Transcripts are append-only, so `transcript_files.bytes_indexed` is a valid
resume point. Catching up twenty messages costs the same as catching up one.

Three triggers, one code path:

1. `knowl reindex --transcripts [--budget <minutes>]` — explicit backfill.
2. The existing per-turn lifecycle hook — keeps the current session current.
3. A ~1s top-up inside a search call, newest first — safety net.

**Every trigger does both halves — index *and* embed.** A trigger that only
wrote lexical rows would leave new messages permanently unvectored until someone
remembered to run a manual reindex, and the coverage figure would decay silently
from 100% as the archive grew. Whole-corpus semantic ranking is the design's
central claim (§6); a catch-up path that quietly erodes it is worse than no
catch-up path.

Per-*message* indexing was rejected: it means a write every few seconds for no
freshness gain, and write frequency is precisely what caused PR #11's lock
failures.

**The watermark advances inside the same transaction as the rows it describes.**
Committing message rows and then updating `bytes_indexed` separately is not
crash-safe: a crash between the two leaves committed rows behind a stale
watermark, and the next pass replays those lines straight into the
`UNIQUE(path, line)` index and dies. "Resumable" has to mean the two facts move
together or not at all.

**Parsing streams; nothing loads a whole transcript to index it.** The largest
sessions here are multiple megabytes, and both the 1.5s hook budget and the
`--budget` flag are unenforceable if a single file allocation can blow past them.

Every trigger is interruptible and resumable, because the resume state is a byte
offset already on disk.

### 6. Ranking: BM25 + whole-corpus semantic, fused

Two orders are built independently over the entire corpus and fused.

- **Lexical** — FTS5 BM25, weighted user 2.0 / assistant 1.0.
- **Semantic** — every prose message carries a vector from the local model Knowl
  already ships (`granite-small-en-r2`, CLS pooling, 384 dims), quantized to
  int8.
- **Fusion** — Reciprocal Rank Fusion, k=60. RRF combines *positions*, not
  scores, because BM25 magnitudes and cosine similarities are not on a comparable
  scale.

Semantic coverage is the whole corpus, not a re-rank of the lexical shortlist.
Re-ranking BM25's top N cannot answer the query the feature exists for — the one
where the words you remember are not the words that were used — because the
target message is never in the shortlist. Prose-only makes whole-corpus embedding
cheap enough that this stops being a tradeoff at all: 1.4 MB of vectors and about
four minutes of one-time local CPU for this repo.

int8 over float32 or binary, carrying forward PR #11's measurements at 384 dims
(float32 MRR 0.662 / 106 MB; **int8 0.668 / 27 MB**; binary 0.310 — binary
collapses at this dimensionality and needs float32 rescoring to recover, which
defeats the purpose). Scale is `6 / sqrt(dims)`, clipping at ~6 sigma and
adapting to any model's dimensionality.

Brute force, no ANN index: single-digit milliseconds over a few thousand vectors, and an ANN
index would need a native extension `@libsql/client` cannot load.

If the embedder is missing or throws, search degrades to lexical rather than
failing.

### 7. Two signals on every result

- **Coverage**, as `embedded/indexed`. "BM25 + semantic" over 8% of an archive is
  a different claim from the same words over all of it, and only one justifies
  trusting a near-miss. A partial index says so.
- **A prompt to `knowl_store`** what was used. A fact dug out of history should
  not need digging out twice. This belongs in the *result*, not only the tool
  description: descriptions are read once, results are read every time.

### 8. Workspace sharing: opt-in, read-only fan-out

Each repo owns its `transcripts.db`. Setting `share: true` lets linked workspace
repos open it read-only. `knowl_transcript_search` accepts `repos: ["name"]` to
narrow, and tags every hit with its owning repo — the same contract
`knowl_query` already uses.

Chosen over a promote-style flow because promoting a whole session is blunt, and
because promotion copies content into shared storage where revocation cannot
fully undo it. Read-only fan-out revokes with one flag and leaves no copies.

**Federation contract.** Two things do not follow from "search each repo and
concatenate":

- **Ranking.** RRF scores are computed *within* one repo's candidate set and are
  not comparable across repos — sorting the merged list by them makes ties fall
  in repo iteration order, which is a bias dressed as a ranking. Each repo's hits
  are re-fused by a second RRF over the per-repo *positions*, so a repo's rank-1
  competes with another repo's rank-1 on equal terms regardless of corpus size.
- **Coverage.** Each repo reports its own `embedded/indexed`. The result carries
  them per repo, not summed: a peer at 12% coverage and a local index at 100%
  average to a number that describes neither.

### 9. Locators are self-contained

A hit's locator is `transcript://<repo>/<session>#L<line>`, and
`knowl_transcript_read` takes that whole string.

Session id plus line is not enough to read anything. The reader needs a
filesystem path, which requires knowing which repo owns the session — and in a
workspace two repos can hold sessions with the same id. Passing the locator back
verbatim keeps the caller from reassembling identity out of parts, which is where
a cross-repo read would silently open the wrong file.

`repo` is omitted for local hits and the local repo is assumed on read, so the
single-repo case stays short.

## MCP surface

Registered only when `enabled: true`.

- `knowl_transcript_search(query, sessionId?, repos?, limit?)` → ranked hits, each
  a `transcript://<repo>/<session>#L<line>` locator with the message read back
  from disk. `sessionId` accepts a full id or a unique prefix.
- `knowl_transcript_read(locator, context?)` → that message plus surrounding
  turns.

## Failure modes

| Condition | Behavior |
|---|---|
| Source `.jsonl` deleted | Detected on read; that session's rows dropped and reported once |
| File shrank or was rewritten | Treated as new; rebuilt from byte 0 |
| File edited in place at identical size | **Undetected.** Append-only is an assumption, not enforced. Disclosed, not special-cased |
| Embedding model changed | Existing `embedding-identity` machinery invalidates and rebuilds |
| Worktree deleted | Its transcripts stop being discovered; rows cleaned up by the dead-file path |
| `git worktree list` fails or repo is not a checkout | Degrades to the main root alone; never an error |
| Crash mid-pass | Watermark and rows committed together, so the next pass resumes at a consistent point (§5) |
| Embedder unavailable | Lexical-only ranking; coverage signal reflects it |

**Concurrency.** Two writers are normal here, not exceptional: a `--budget`
backfill can run while a live session's per-turn hook fires. Three things are
required, and PR #11 needed all three against a real 41k-message job:

1. **`busy_timeout` at the connection**, not per statement — SQLite's default
   busy handler gives up instantly, and statements nobody thought to wrap are
   then unprotected.
2. **Reconnect on `SQLITE_BUSY_SNAPSHOT`.** It is *permanent* for a connection
   pinned to a stale read snapshot, so backing off waits for a condition only a
   reconnect clears. Measured in PR #11: a fresh process wrote the same database
   in 71 ms while a long-lived job had been failing on it for fourteen minutes.
3. **Watermark reads and row writes in one transaction.** Otherwise two writers
   read the same `bytes_indexed`, parse the same lines, and collide on
   `UNIQUE(path, line)` — the same failure as the crash case, reached by a
   different route.

## Testing

- `enabled: false` creates no file and registers no tools — the core promise of
  an opt-in feature. Asserted at the **MCP server level** against a real
  `tools/list` and a real `tools/call`, not only against the guidance text.
- Disabling an enabled repo deletes `transcripts.db`.
- Prose-only filtering: `tool_use` and `tool_result` blocks absent from the index.
- Subagent enumeration: transcripts nested one level deep are indexed, and each
  reports its parent session. A fixture with nested files must not come back with
  only the top-level count.
- Worktree discovery covers a root **outside** the main repo directory, since
  that is the case a path-prefix convention silently drops (§3b).
- Ranking order, and user-weighting over assistant.
- **Word-mismatch retrieval** — a query sharing no term with its target. This
  test fails against a shortlist-re-ranking design and is the reason for §6.
- Incremental append; rewrite-triggered rebuild.
- **Crash simulation:** interrupt after one committed batch, then run a full
  pass. It must resume, not raise `UNIQUE constraint failed`.
- **Two concurrent writers** against one database complete without a lost
  update or a uniqueness collision.
- Budget interruption: resume with no double-indexing.
- A catch-up trigger embeds as well as indexes — coverage stays at 100% after
  new messages arrive, with no manual reindex.
- Dead-file cleanup drops rows and reports.
- Workspace fan-out honors `share: false` and `repos:` filtering, reports
  per-repo coverage, and does not rank by repo order when scores tie.
- A locator round-trips: a hit from `knowl_transcript_search` is accepted
  verbatim by `knowl_transcript_read`, including a federated one.
- Embedder throwing degrades to lexical.
- Guidance contract: tool count and card size measured with the feature on and
  off.

## Relationship to open PRs

Supersedes **#7** (always-on, text-copied, `knowl.db`) and the transcript half of
**#11**. Retains from them: FTS5 over a hand-rolled index, RRF fusion, int8
quantization with its measurements, byte-offset resume, and the three
concurrency fixes — each found by running a real backfill, not by reasoning.

Corrects one factual claim in #7: its enumeration and its stated limitation both
assume subagent turns are either absent or interleaved into the parent file. In
the current format they are separate files nested under the parent session's
UUID (§3a). Top-level-only enumeration misses 69% of this repo's transcript
files.

Independent of **#8** (session directory), **#9** (ordering fix), and **#10**
(handoff).
