# The agent surface: does the agent use the memory, and what would make it use it well?

L3 two-angle pass (ADVICE + TAPE) plus a third leg the field does not have: **825 transcript files
of this machine's own agents using knowl, and the three stores they wrote to.** Run 2026-08-04 on
branch `r/surface`.

Every other lane improves what happens after a query is issued. This one asks whether the right
query gets issued, whether what comes back is shaped so a model acts on it, and whether anything
worth remembering gets written.

**Two claim classes, kept apart throughout.**

- **[M] MEASURED** — from this machine's transcript archive, the three live stores, or a
  ground-truth ablation over this project's own suites. Reproducible; scripts in `.tmp/` at the
  time of writing, method described inline.
- **[C] CLAIMED** — about how agents behave in general, from published sources or from reading
  other systems' shipping artifacts. Weaker. Used only to explain or to rule out.

---

## 0. The instrument

[M] Mined every `mcp__knowl__*` tool call out of `C:\Users\Admin\.claude\projects` — 1,758 `.jsonl`
files, 61,983 total tool calls.

| | |
|---|---|
| knowl tool calls | **2,082** |
| sessions that called knowl at least once | **296** |
| `knowl_query` | 924 |
| `knowl_store` | 752 |
| `knowl_update` | 269 |
| everything else | 137 |
| repos | ducksat 1,020, duckprep 963, students 91, bsPOL 8 |

Stores, copied before reading (WAL and SHM included, or the copy is malformed):

| repo | active items | `knowledge_access` rows |
|---|---|---|
| duckprep | 474 | 1,946 |
| ducksat | 208 | 1,695 |
| students | 48 | 183 |

n is large enough that no conclusion here rests on one session.

---

## 1. Query shape: agents obey the rule, and the rule is wrong

### They obey it

[M] Over 921 real `knowl_query` calls with a query string:

```
word count:  2:12  3:39  4:91  5:276  6:258  7:141  8:74  9:20  10:9  12:1
min 2 · p25 5 · median 6 · p75 7 · p90 8 · max 12 · mean 5.75
compliant with "2-6 keywords":  676/921 = 73.4%
question-shaped (leading interrogative or trailing "?"):  0/921 = 0.0%
```

Two things stand out. The "not the whole sentence" half of the instruction has **100%**
compliance — not one agent in 921 calls wrote a sentence. And the mean sits at 5.75, hard against
the top of the band, with 26.6% spilling over. That is the signature of a binding constraint, not
an ignored one: the rule is being actively obeyed and it is squeezing.

[M] The rule is stated in **eight** places across the agent-facing surface:
`knowl_query.description`, the `query` param, the routing-table row, `KNOWL.md`'s required
workflow step 1, the compact operational card (and its host-neutral twin), the per-prompt
reminder, the continuation reminder, and the subagent bootstrap card. Eight repetitions buy
73.4%.

### The rule is wrong

[M] **Ground-truth ablation**, `.tmp/qlen2.ts`: load a suite's fixtures into a clean store, then
run each case's query four ways and score against `expectedItemIds`.

| arm | what it does |
|---|---|
| `base` | the suite query as written |
| `cut6` | truncated to its first 6 words — what the rule asks for |
| `noise3` | base + 3 words lifted from an *unrelated* fixture |
| `ctx3` | base + 3 words lifted from the *expected* item's own content |

**retrieval-suite-v2 (413 cases sampled at stride 4, 434 fixtures):**

| arm | n | hit@1 | hit@3 |
|---|---|---|---|
| base | 413 | 94.4% | 98.1% |
| noise3 | 413 | **57.1%** | 90.8% |
| ctx3 | 413 | **100.0%** | 100.0% |
| base, over-cap cases only | 63 | 98.4% | 100.0% |
| **cut6, same 63 cases** | 63 | **93.7%** | **96.8%** |

**retrieval-suite (250 cases sampled at stride 2, 168 fixtures) — replication:**

| arm | n | hit@1 | hit@3 |
|---|---|---|---|
| base | 250 | 87.6% | 92.8% |
| noise3 | 250 | **63.6%** | 85.6% |
| ctx3 | 225 | 99.6% | 100.0% |
| base, over-cap cases only | 97 | 94.8% | 97.9% |
| **cut6, same 97 cases** | 97 | **87.6%** | **91.8%** |

**semantic-suite (55 cases):** base hit@1 70.9%, noise3 47.3%, ctx3 100.0%. No over-cap cases
exist in this suite because its generator enforces ≤6 words (`tests/benchmark/semantic-suite.test.ts:44`) —
which is the refuted rule baked into a fixture, and means the suites are if anything biased *for*
the cap.

**Read across the three:**

- **Truncating a query to 6 words costs 4.7pp and 7.2pp hit@1** against the identical queries
  untruncated. Two independent suites, n=63 and n=97, same direction. The cap destroys recall.
- **Off-subject padding is catastrophic**: −37.3pp, −24.0pp, −23.6pp hit@1. This is the real
  danger the rule was groping at.
- **On-subject extension is strictly better**, reaching 100%. `ctx3` is a partial upper bound —
  the added words are drawn from the target item, so treat it as "if the extra terms are truly on
  subject" rather than as a realistic estimate. The load-bearing result is `cut6`, which involves
  no such construction.

**Caveat on `cut6`, stated plainly.** It truncates *suite* queries, and the suites' long queries
are paraphrase-style cases whose later words carry real content; a real agent's 8th word may be
less load-bearing than a suite paraphrase's. What `cut6` establishes is that truncation is not
free — it cannot be assumed harmless, which is exactly what a numeric cap assumes. The direction
replicated across two independent suites and 160 over-cap cases, and no arm in any suite showed
truncation helping.

[M] A second, unrigged check on real queries: `.tmp/qlen.ts` ran the 67 unique over-cap queries
agents actually issued in duckprep against a copy of the real 474-item store, full versus
truncated to 6 words. Top-1 changed in **20.9%** of cases (mean Jaccard over top-5, 0.563). The
ranker is genuinely sensitive to those words; the suite arms say which direction that sensitivity
runs.

**The conclusion.** Word count is a proxy for "do not pad", and it is a bad one: it is silent
about the variable that actually decides the outcome (is each word about the subject?) and it
actively instructs the agent to drop real terms. **Killed and replaced with a relevance rule in
all eight places**, pinned by `tests/core/knowl-guidance.test.ts` so no number creeps back.

---

## 2. Abandonment: memory answers, then hands back a third of the answer with the map torn off

[M] What the agent does immediately after a `knowl_query` (n=924):

| next tool call | count | share |
|---|---|---|
| a file read (Read/Grep/Glob/read-ish Bash) | 304 | 32.9% |
| another knowl tool | 417 | 45.1% |
| something else | 200 | 21.6% |
| nothing — answered or ended | 3 | 0.3% |
| **a file read within the next 3 calls** | **494** | **53.5%** |

Restricted to queries that returned something (919 of 924 did — the empty-result rate is 0.2%),
the file-read-within-3 rate is unchanged at 53.8%. So this is not agents recovering from misses.

The 45.1% "another knowl tool" is mostly healthy: of the 307 immediate re-queries, **189 share no
words with the previous query** — the agent is batching distinct subjects, not retrying a failure.
Only 118 are reformulations.

### The sharpened measure, and the defect it found

Reading files after a query is not necessarily abandonment. If memory named the file and the
agent opened it, memory *routed* — that is the design working. So: of the 356 cases where a query
was followed by a Read/Grep/Glob within three calls, how often was the opened file named anywhere
in the query result?

[M] **61 of 356 = 17.1%.** In 82.9% of cases the agent went looking for a file memory never
mentioned.

[M] It could not have been otherwise. **`affectedPaths` never reaches the agent.**
`compactKnowledgeItem` (`src/core/token-budget.ts`) is an explicit allowlist, and the field was
excluded — grouped with `reasoning` and `alternatives` as "verbose provenance", pinned by a test
that asserted its absence. Meanwhile:

| repo | active items carrying `affectedPaths` | mean size of the field |
|---|---|---|
| duckprep | 49.2% | 112 chars |
| ducksat | 51.0% | 68 chars |
| students | 31.3% | 46 chars |

Half the store carries a pointer to the answer, the write-side schema asks agents to supply it,
50.5% of writes comply — and the read path throws it away. Measured across all three stores: median
3 paths per item (p90 5, p99 10), median path 29 chars (p99 57, max 81).

### And the content is a third of an atom, cut in silence

[M] `MAX_ITEM_CONTENT_CHARS = 600`, and `compactKnowledgeItem` calls `truncateText` with the
**default empty marker** — no ellipsis, no flag.

| repo | active items over 600 chars | share of stored content actually delivered |
|---|---|---|
| duckprep | 399/474 = **84.2%** | **33.3%** |
| ducksat | 194/208 = **93.3%** | **26.9%** |
| students | 45/48 = **93.8%** | **46.4%** |

So the typical `knowl_query` result is the opening third of an atom, silently severed
mid-sentence, with the file pointers stripped — handed to an agent whose instructions say
"answer from Knowl without inspecting repository files". **The agent cannot evaluate that
instruction.** It has no way to distinguish a short complete fact from the first 30% of a long
one.

53.5% file-read-after-query is not disobedience. It is the correct response to an underfed
payload. The honest reading of the abandonment number is that **the write path and the ranker
were doing their jobs and the response shape was discarding the result.**

[M] Internal precedent: `knowl_skill_read` has always returned
`truncated: skill.markdown.length > MAX_ITEM_CONTENT_CHARS`. The pattern existed; it was simply
never applied to the path carrying the traffic.

---

## 3. Write quality: the hypothesis died

The brief expected never-retrieved atoms to be a large, shapeable cost. [M] They are not, and
write shape does not predict retrieval.

| repo | active | never retrieved | never retrieved, age > 7d | age > 30d |
|---|---|---|---|---|
| duckprep | 474 | 93 = 19.6% | 9.9% | **5.9%** |
| ducksat | 208 | 42 = 20.2% | 13.0% | — |
| students | 48 | 9 = 18.8% | 15.2% | — |

Roughly 19-20% overall, and it collapses to 5.9% once an atom has been around 30 days. Most
"never retrieved" is simply "written recently".

**Retrieved versus never-retrieved, duckprep:**

| | retrieved (n=381) | never (n=93) |
|---|---|---|
| title words (median) | 13 | 15 |
| content chars (median) | 1,668 | 1,351 |
| has `affectedPaths` | 49.1% | **49.5%** |
| has tags | 85.0% | 66.7% |
| `provenance` set | 11.8% | **22.6%** |

The discriminators are absent or backwards. Retrieved atoms are *longer*. `affectedPaths` presence
is identical to within 0.4pp. Never-retrieved atoms have *more* provenance. Whether an atom is read
again is governed by whether the user returns to that topic, not by how it was written.

[M] Retrieval is heavily concentrated regardless: top-10 items are 16.4% of all retrievals in
duckprep, 27.4% in ducksat, 69.9% in students.

**Consequence, and it is a kill:** the whole family of "nag the agent into writing better atoms to
raise retrieval" changes has **no evidentiary support here** and I did not ship any. The one
write-side edit I made is different in kind — `affectedPaths`'s description now explains what the
field is *for*, and that is honest only because change #1 made it true. Before this pass, asking
for `affectedPaths` was asking for unpaid work.

### Compliance with what the write schema actually demands

[M] Over 752 real `knowl_store` calls:

| demand | compliance |
|---|---|
| `tags` | 86.8% |
| `confidence` | 65.0% |
| `affectedPaths` | 50.5% |
| **`provenance`** | **9.8%** |
| **`supersedes`** | **3.5%** |
| "Concise title" | median **15 words**, p90 25, max 55 |
| content length | median 2,014 chars |

`provenance` is documented as affecting rank ("Inferred items rank lower until confirmed by use")
and is omitted on 90% of writes. `supersedes` carries the strongest imperative in the whole schema
("pass that item id **in this same call**") and lands 3.5% of the time. "Concise" produces 15-word
titles. These are real compliance gaps — but per the paragraph above, none of them is known to
cost retrieval, so I am reporting them rather than acting on them. Fixing an unmeasured problem is
how a surface accretes.

---

## 4. What gets pushed without being asked

[M] Across the archive, knowl guidance and session-context injections: **2,405 occurrences**,
median 524 chars, p90 1,525, max 6,005 — **~460,647 tokens** pushed into contexts that never asked
for it, against ~766,885 tokens returned by all 924 `knowl_query` calls combined.

**37% of knowl's total token footprint is unrequested.** I am flagging this and not touching it:
the injections are what produce the median first-query-at-tool-call-#2 behaviour in §5, and the
TAPE evidence below says that out-of-band channel is precisely where compliance is bought. Cutting
it without an experiment would be trading a measured good for a token saving.

---

## 5. The trigger already works

[M] Position of the *first* `knowl_query` among a session's tool calls, over 286 sessions:
**median 2**, p25 2, p75 3, p90 7. Only 9.8% of sessions get past 10 tool calls before querying
memory. Median 2 queries per session, mean 3.2, max 30.

Whatever else is wrong, "the agent does not think to ask" is **not** one of knowl's problems. This
matters for what follows, because it is the problem the rest of the field is still stuck on.

---

## 6. ADVICE (5 sub-angles retained of 9 run) — [C] throughout

Full leg in the session record; retained findings and their preconditions:

1. **Anthropic, "Writing effective tools for AI agents"** (2025-09-11). Descriptions must make
   implicit context explicit; a response-format choice cut one tool's payload 206→72 tokens.
   *Precondition:* model reads descriptions once per tool-load. **Holds here.**
2. **Anthropic, "Effective context engineering for AI agents"** (2025-09-29). Just-in-time
   retrieval: keep the window full of **pointers** — file paths, IDs — and load heavy content only
   at the moment of use. *Precondition:* none provider-specific. **Holds, and is the direct
   argument for change #1.** knowl stored the pointers and dropped them.
3. **"MCP Tool Descriptions Are Smelly!"** (arXiv 2602.14878; 856 tools, 103 servers). 97.1% carry
   design smells; LLM-augmented descriptions gained +5.85pp task success but cost **+67.5% more
   execution steps**, and the ablation found **removing the Examples component was statistically
   equivalent** to full augmentation. *Precondition:* generic tool-calling. **Holds — and it is
   why I did not add worked examples to any description.**
4. **Chroma, "Context Rot"** (2025-07; 18 frontier models, 10k–500k tokens). Accuracy decays
   non-linearly with input length, and **coherent well-formatted text degrades attention more than
   shuffled text**. *Precondition:* model-behaviour research. **Holds as a brake:** it is why
   change #2 is a boolean flag and not a raised content ceiling.
5. **STALE** (arXiv 2605.06527). Frontier models detect that a retrieved memory is outdated at
   55.2%. *Precondition:* none. **Holds** as evidence that staleness is not solvable by asking the
   model, which supports keeping freshness a stored field rather than a judgement.

---

## 7. TAPE (25 specimens read verbatim) — [C] throughout

The strongest specimen in the pass is **Anthropic A/B-ing its own most-complied-with tool in
public**. The `claude-code` bundle ships three `TodoWrite` descriptions, two of them dead:

- **v1, 1,017 words** — what-it-is, a `## When to Use This Tool` section, a `## When NOT to Use`
  section, four worked `<example>` blocks with `<reasoning>`. Everything the folk wisdom prescribes.
- **v2, 45 words.**
- **v3, LIVE, 61 words** — one sentence of what-it-is, what the *user* sees, three mechanics
  bullets. Zero when-to-use, zero negatives, zero examples.

A 94% cut. And the compliance did not disappear with the words: it moved out-of-band, into a
repeating runtime `system-reminder` ("The TodoWrite tool hasn't been used recently…"). Same
architecture in Anthropic's shipping **memory tool** (`memory_20250818`), whose config is literally
`{"type": "memory_20250818", "name": "memory"}` — no schema at all — with the entire protocol
auto-injected into the system prompt: *"IMPORTANT: ALWAYS VIEW YOUR MEMORY DIRECTORY BEFORE DOING
ANYTHING ELSE"*, and a threat model, *"ASSUME INTERRUPTION."*

The contrast case is the direct competitor. The **MCP reference `memory` server**'s nine tool
descriptions total **84 words**; its retrieval tool is eleven: *"Search for nodes in the knowledge
graph based on a query."* Nothing tells an agent when the moment to search has arrived — and the
maintainers know, because the README punts the whole problem to the user's system prompt, with a
ritual (*"Always begin your chat by saying only 'Remembering...'"*) to force the call.

**Cross-cut, counted over the 25:**

| property | count | note |
|---|---|---|
| when-to-use in the first sentence | ~6/25 | present in every specimen from a vendor that measured behaviour; absent in every one written as API docs |
| negative / exclusion guidance | ~8/25 | the ones that work name **a specific failure**, not a category; the highest-compliance form attaches the **reason** |
| describes its own response shape | ~5/25 | |
| **explains how to read a score** | **1/25** | **it is knowl's** |
| **tells the agent what to do on a miss** | **4/25** | the field's biggest gap |
| second-person imperative | dominant among complied-with | third-person descriptive dominates the ignored |

Length in live shipping code is bimodal with a sweet spot at **45–90 words**; long descriptions
earn it only when every added clause is a decision rule.

Two directly actionable gaps for knowl: it already has the score sentence that nobody else has,
and its miss rule lived in doctrine and in a *sibling* tool (`knowl_transcript_search`: "Use after
knowl_query misses") — **the tool that produces the miss said nothing about it.** Best-in-corpus
form is Cursor's `codebase_search`: retry with different wording, *with the reason attached*
("first-pass results often miss key details").

---

## 8. The transfer check: what I killed

Named mechanism, named precondition, checked against this system — a **coding agent's project
memory, deterministic-first, no LLM in the write path, one user, ~500 atoms per repo.**

| borrowed idea | mechanism | precondition | verdict |
|---|---|---|---|
| Letta/MemGPT agent-controlled memory tiers | model issues its own read/write calls per turn | conversational turn-taking + LLM budget on most turns | **KILLED** — knowl's writes are deterministic and its reads are hook-triggered |
| Generative-Agents reflection / importance scoring | LLM rates each observation 1–10, synthesises on threshold | LLM in the write path, per-write cost, stable scores across model versions | **KILLED** — explicitly the opposite of this system's design axis |
| "Dreaming" background consolidation | background LLM prunes, merges, resolves contradictions | LLM rewrites the store; product-scale economics | **KILLED** as a mechanism. The *checklist* survives as a spec for a deterministic GC pass |
| Zep temporal knowledge graph | episode/entity/community subgraphs with temporal edges | enterprise multi-source scale | **KILLED** — graph-maintenance overhead unjustifiable at 500 atoms |
| RAG confidence-score reranking | rerank by LLM-judged document quality | thousands of noisy candidates | **KILLED** — the precision problem it solves does not exist at this scale |
| BoR adaptive tool-shortlist sizing | scale visible tool count to query difficulty | registries of 370–3,251 tools | **KILLED** numerically; directional taste retained |
| Worked examples in tool descriptions | demonstrate correct use | — | **KILLED** by the source that recommends augmentation: its own ablation found examples statistically equivalent to none, at +67% execution steps |
| Write-quality nagging to raise retrieval | better-shaped atoms get found more | write shape predicts retrieval | **KILLED by our own data** (§3): the discriminators are absent or backwards |

**The genre-level finding.** Most published agent-memory advice is written for a chat assistant
with a human user and a conversational memory, and its central problem is *getting the model to
call the memory tool at all* — hence the rituals, the ALL-CAPS protocols, the "Remembering..."
tokens. [M] **knowl does not have that problem**: median first query at tool call #2, 296 sessions,
0.3% of queries followed by no action. Its hooked-doctrine architecture already solved the thing
the corpus is still fighting.

Which means the advice that transfers is not the advice about *triggering*. It is the small,
unfashionable body of work about **what the response should contain** — Anthropic's
pointers-not-payloads, the 5-of-25 that describe their own response shape, the 4-of-25 that handle
a miss. That is where knowl's defect was, and it is the one place the field has the least to say.

---

## 9. The call

One thesis, three changes. **The surface asked the agent to optimise the wrong variable, then
handed back a third of the answer with the pointers removed.**

**1. `affectedPaths` now ships with every query result.** `src/core/token-budget.ts`, bounded at
`MAX_AFFECTED_PATHS = 6` and `MAX_PATH_CHARS = 120` (p90 is 5 paths; p99 path length 57 — nothing
real is cut). Cost ~112 chars on the half of items that carry them, roughly 4% of a median
2,731-char response. Overturns the assertion at `tests/core/token-budget.test.ts:23`, which grouped
a pointer list with prose.

*Found by the adversarial pass and fixed before commit:* a **foreign** item's paths are withheld.
They are repository-relative, so a peer's paths resolve against a checkout that is not this one —
and the repos most likely to be linked are fork siblings where the same path exists in both and
means different things (this workspace is exactly that: duckprep and ducksat). Handing them over
unqualified invites a reader to open the wrong file and treat it as evidence. Same reasoning that
already omits evidence and staleness for foreign items; pinned in
`tests/mcp/foreign-item-refusal.test.ts`, including the converse — local paths must still arrive,
or the guard has quietly turned the feature off.

**2. A truncated body says so.** `truncated: true` when content was cut, absent otherwise, so every
response that fitted stays byte-identical. A flag rather than a raised ceiling, on the Context-Rot
brake and because the caller's question is "is this whole?", not "how many bytes were dropped?".
Coupled with #1 this is the complete just-in-time pattern: *you have a fragment, and here is
exactly where the rest lives.*

**3. The numeric cap is gone from all eight places that stated it**, replaced by a relevance rule — *use every
word that names the subject and none that does not; one more on-subject term retrieves better, one
off-subject term retrieves worse; never pad to reach a length and never drop a real term to stay
under one.* Plus the missing miss rule on `knowl_query` itself, in the reason-bearing form TAPE
identified, **added to** rather than replacing the existing file-fallback conditions.

Pinned by: `tests/mcp/query-pointer-surface.test.ts` (new, 4 tests, end-to-end through the real
MCP boundary), 3 new tests in `tests/core/token-budget.test.ts`, and 1 in
`tests/core/knowl-guidance.test.ts` that fails if any numeric keyword cap reappears in any
agent-facing surface. Suite 1,733 / 1,733, `tsc --noEmit` clean.

## 10. If given one more pass

**Deliver `score` on the layered and lexical paths, or say plainly that it is absent and why.**
[M] Only 17 of 924 archived query results carried a `score` at all, because it is gated on the
semantic half being present — and [C] knowl is 1 of 25 specimens that explains how to read one.
The rarest asset on the surface is switched off for most real calls. The gating reasoning is sound
(cosine is absolute; a lexical-only ranking's top result scores near 1 whatever it is), so the fix
is not to publish a meaningless number — it is to emit an explicit "uncalibrated" marker so the
agent can tell "the ranker has no opinion on strength" from "the ranker forgot to say". Right now
those two are the same silence, and the agent's decision — trust this or go read the files — is
exactly the one that silence blocks. That belongs to this lane's surface, but it needs the
retrieval lane's `agent-query.ts` to hand up the distinction, so it wants coordinating.
