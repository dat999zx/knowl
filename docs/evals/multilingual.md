# Vietnamese retrieval — measurement, 2026-08-04

Knowl's owner is Vietnamese. Nothing on this machine had ever measured whether retrieval works
when he types Vietnamese. This is that measurement.

Every number below is `[MEASURED]` on this machine, through the shipped ranker, unless tagged
`[EXTERNAL]`. There is exactly one external leg: what the model card claims.

Harnesses: `.tmp/vi-eval.ts` (built with tsup against `src/`, so `selectCandidates` and
`scoreCandidates` are the product's own), `.tmp/fts-vi.mjs`, `.tmp/vi-scan.mjs`. Real databases
were **copied** and read from the copies; `KNOWL_HOME` pointed inside the worktree throughout.

---

## 0. Which model, which floor

Upstream v3.0.0 replaced the single `MIN_VECTOR_RELEVANCE = 0.30` with **one floor per model**
(`MODEL_RELEVANCE_FLOORS`, `src/core/vector-profile.ts`), and moved the default preset to
`granite-small-en-r2`. So "the floor" is not one number and every result here is reported per
model. Three are measured:

| preset | model | floor | declared languages | why it is in this table |
| --- | --- | --- | --- | --- |
| `arctic-embed-m-v2` | `Snowflake/snowflake-arctic-embed-m-v2.0` | **0.16** | English + multilingual | what every existing store on this machine is embedded with |
| `granite-small-en-r2` | `onnx-community/granite-embedding-small-english-r2-ONNX` | **0.76** | English | `DEFAULT_PRESET_ID` — what a fresh repo gets today |
| `granite-97m-multilingual` | `onnx-community/granite-embedding-97m-multilingual-r2-ONNX` | **0.74** | 200+ languages | the multilingual option already shipped in the preset table |

Verified `[MEASURED]`: the real store copy (`duckprep.db`, 482 active atoms) carries 514
embedding rows, all `Snowflake/snowflake-arctic-embed-m-v2.0`, 768-dim, one fingerprint. The
arctic column is the one describing reality; the granite columns describe a repo initialised
today, and an option.

---

## 1. How many real Vietnamese queries exist

`.tmp/vi-scan.mjs`, read-only over the machine-wide Claude Code transcript archive
(`C:\Users\Admin\.claude\projects`), 1,770 `.jsonl` files walked:

| what | count |
| --- | --- |
| Vietnamese `knowl_query` calls | **2** |
| Vietnamese `knowl_transcript_search` calls | 0 |
| Vietnamese user messages (query *intents*, never sent to a store) | 25 |

Both real store queries:

```
thuyết trình tư tưởng Hồ Chí Minh nhóm 10 slide
Mặt trận dân tộc thống nhất tài liệu Đức Quang hình ảnh
```

Representative intents (the register is what matters — these are code-switched, not pure
Vietnamese):

```
"C:\Users\Admin\Downloads\Nội dung ttHCM.docx" OK So what I need from you right is to …
OK I think you are like missing the images in the original doc "…Hình thức, nguyên tắc tổ chức
   của khối đại đoàn kết…"
1) Direct: assume p, derive q. 2) Contrapositive (gián tiếp): prove ¬q→¬p. 3) Contradiction
   (phản chứng): assume p∧¬q, reach an impossibility
Circuit minimization methods? Karnaugh map (bản đồ Karnaugh) or Quine–McCluskey. ??
```

**2 is far below the ~15 needed to conclude anything**, so the cross-lingual measurement runs on
**faithful translations of the existing suite, kept as a separate labelled arm** and never pooled
with the real two. `docs/evals/semantic-suite-vi.json` (written by an earlier attempt at this
task, reviewed and reused here unchanged — it is sound: 110 translations covering every
`semantic-suite.json` case, plus the 10 off-topic probes) carries two registers per case:

- **`viMixed`** — how a Vietnamese developer actually types: established loanwords kept
  (`thời gian cache redis`, `giới hạn request mỗi phút`). This is the register the 25 real
  intents are in.
- **`viPure`** — everything translated but proper nouns (`khoảng thời gian bộ nhớ đệm redis`).
  The stress case, and the register of the 2 real store queries.

The corpus stays **English**, deliberately: `[MEASURED]`, only **2 of 482** active atoms in the
real store contain any Vietnamese, and both are English atoms that merely *mention* Vietnamese
input (`UniKey Telex`). Vietnamese-query-over-English-atoms is the real scenario, not an
artefact of the fixture.

---

## 2. Cross-lingual retrieval through the shipped ranker

50 English fixtures, 110 cases per arm, `limit` as the suite declares. `en` is the control:
identical cases, identical gold, only the query language differs. Post-fix numbers (§5).

**`arctic-embed-m-v2` — the model every real store uses. Floor 0.16.**

| arm | fused hit@1 | fused hit@5 | fused MRR | abstained |
| --- | --- | --- | --- | --- |
| en (control) | 0.800 | 0.964 | **0.865** | **0/110** |
| viMixed | 0.818 | 0.927 | **0.863** | 11/110 |
| viPure | 0.536 | 0.755 | **0.636** | 34/110 |

**`granite-small-en-r2` — the default a fresh repo gets. Floor 0.76.**

| arm | fused hit@1 | fused hit@5 | fused MRR | abstained |
| --- | --- | --- | --- | --- |
| en (control) | 0.782 | 0.936 | **0.842** | 0/110 |
| viMixed | 0.718 | 0.827 | **0.770** | 44/110 |
| viPure | 0.100 | 0.191 | **0.151** | 106/110 |

**`granite-97m-multilingual` — already in the preset table. Floor 0.74.**

| arm | fused hit@1 | fused hit@5 | fused MRR | abstained |
| --- | --- | --- | --- | --- |
| en (control) | 0.791 | 0.918 | **0.841** | 0/110 |
| viMixed | 0.791 | 0.909 | **0.842** | 3/110 |
| viPure | 0.464 | 0.691 | **0.568** | 4/110 |

Read the arctic row first, because it is the one about existing stores: **code-switched
Vietnamese retrieves as well as English does** (0.863 against 0.865). Retrieval is not the
problem. Fully-Vietnamese phrasing costs about a quarter of MRR, which is a real but survivable
loss.

`granite-small-en-r2` is the outlier, and honestly so: it is an English-only model and on
`viPure` it returns the right answer 10% of the time. **A repo initialised today is
Vietnamese-hostile in a way the existing arctic repos are not.**

### Per tier, because pooled numbers hide where it breaks (arctic)

| arm | basic (n=72) | moderate (n=27) | extreme (n=11) |
| --- | --- | --- | --- |
| en MRR | 1.000 | 0.679 | 0.442 |
| viMixed MRR | 0.990 | 0.678 | 0.492 |
| viPure MRR | 0.713 | 0.540 | 0.361 |
| viPure abstained | 16 | 14 | 4 |

`viMixed` tracks the control tier for tier. `viPure` loses most at `basic` — the tier where
English is perfect — which is the signature of a language gap rather than a difficulty gap.

---

## 3. The two halves

`relevance = alpha * cosine + (1 - alpha) * lexical`, `FUSION_ALPHA = 0.8`. Measured over the
same cases: `semantic` re-scores the identical candidate set at `alpha = 1`; `lexical` is the
real no-vector path, **selected as well as scored without the vector half**, because a gold the
lexical path never *returns* is a different fact from one it returns and ranks badly.

| arm | fused MRR | semantic-only MRR | lexical-only MRR | lexical found gold |
| --- | --- | --- | --- | --- |
| en | 0.865 | 0.886 | 0.732 | 82/110 |
| viMixed | 0.863 | 0.848 | 0.714 | 82/110 |
| viPure | 0.636 | 0.640 | **0.097** | **12/110** |

(`lexical` is model-independent and came out bit-identical in all three model runs — a useful
check that the harness measures what it claims.)

The lexical half does **not** contribute nothing for Vietnamese; it contributes *almost*
nothing for `viPure` (0.097 against 0.732) and a full English-grade contribution for `viMixed`
(0.714), because the loanwords — `redis`, `jwks`, `canary`, `prometheus` — are ASCII and survive.
The semantic half is carrying Vietnamese essentially alone in the pure register.

Note `viPure` fused (0.636) sits slightly *below* semantic-only (0.640): on the pure register the
lexical half is still very slightly net-negative even after §5.

---

## 4. Does the floor block Vietnamese?

**No — and this is the one place the framing has to be exact.** In v3.0.0 the floor stopped
deleting. `scoreCandidates` computes `answerable` and, when false, marks every judged row
`abstained: true`; the ranking stands and the rows are returned. Verified in source on all three
surfaces — `src/mcp/tools.ts` appends `NO CONFIDENT MATCH: … They are returned rather than
withheld`, `src/cli/program.ts` prints the rows then a `Note:` on stderr, and `context-composer`
passes the floor through without filtering on it. Confirmed `[MEASURED]`: in every abstained
case the harness still found the gold at its rank in the returned list.

What *is* wrong is the verdict. It is calibrated on English and it fires on Vietnamese at a rate
English never sees:

| model | floor | en abstained | viMixed abstained | viPure abstained |
| --- | --- | --- | --- | --- |
| arctic-embed-m-v2 | 0.16 | 0/110 | 11/110 | **34/110** |
| granite-small-en-r2 | 0.76 | 0/110 | **44/110** | 106/110 |
| granite-97m-multilingual | 0.74 | 0/110 | 3/110 | 4/110 |

And it is wrong in the expensive direction — the answer was already there:

| model / arm | abstained | of those, gold in top 5 | of those, gold at rank 1 |
| --- | --- | --- | --- |
| arctic / viMixed | 11 | 6 | 3 |
| arctic / viPure | 34 | **16** | **9** |
| granite-small / viMixed | 44 | **27** | **20** |
| granite-small / viPure | 106 | 17 | 8 |
| granite-97m / viMixed | 3 | 2 | 1 |
| granite-97m / viPure | 4 | 0 | 0 |

On arctic, **9 pure-Vietnamese queries had the right atom ranked first and were told the store
probably does not hold the answer.** On `granite-small-en-r2` + `viMixed` — a plausible
combination for a new repo — it is 20 of 110.

### The distribution, and why one number cannot fix it (arctic, floor 0.16)

`bestCosine` — the exact quantity `scoreCandidates` tests:

| arm | p05 | p25 | p50 | p75 | p95 | below 0.16 |
| --- | --- | --- | --- | --- | --- | --- |
| en | 0.2340 | 0.3234 | 0.4925 | 0.5981 | 0.6863 | 0/110 |
| viMixed | 0.1356 | 0.2311 | 0.3424 | 0.4535 | 0.6455 | 11/110 |
| viPure | 0.0971 | 0.1482 | 0.1866 | 0.2582 | 0.3901 | **34/110** |

Vietnamese does not sit in its own band below English — it **overlaps** it, shifted down by
roughly 0.3 at the median. The off-topic side rules out simply lowering the floor: at 0.16,
3 of 10 English junk probes and 1 of 10 Vietnamese junk probes already clear it, and both real
Vietnamese queries score 0.0987 and 0.1262 — *below* the floor, and below Vietnamese junk's
maximum of 0.1938. **On arctic the floor is close to uninformative for Vietnamese: real queries
and junk occupy the same range.** Lowering it to catch the 34 admits the junk; raising it makes
things worse. This is a per-model, per-language calibration problem, not a knob.

`granite-97m-multilingual` is the exception that shows it is calibratable: 4/110 and 3/110, with
no gold-at-rank-1 casualties at all — its floor happens to sit right for both languages because
the model puts both languages on one scale.

---

## 5. FTS5 tokenization — and the bug in front of it

The lexical half has **two** tokenizers, and the shipped one that mattered was not SQLite's.

### Layer 1 — knowl's own query tokenizer (this was the bug)

`queryTokenGroups` in `src/store/search.ts` split on `/[^a-z0-9_]+/`. An ASCII-only class makes
every Vietnamese letter a **separator**, not a character:

| query | tokens produced |
| --- | --- |
| `hành vi của cờ đánh dấu đã xóa` | `["nh", "vi", "nh"]` |
| `khóa tài khoản khi đăng nhập thất bại nhiều lần` | `["kh","kho","khi","ng","nh","th","nhi"]` |
| `Mặt trận dân tộc thống nhất tài liệu Đức Quang hình ảnh` | `["tr","th","ng","nh","li","quang","nh","nh"]` |
| `cờ đã xóa` | `[]` → `buildFtsQuery` returns null → **lexical returns nothing** |

`src/transcripts/search.ts` `toMatchQuery` already tokenised with `\p{L}\p{N}_`. The knowledge
path was the half that disagreed. **Fixed on this branch, failing-test-first**
(`tests/store/lexical-non-ascii.test.ts`, 3 tests, red before / green after): both call sites now
use `/[^\p{L}\p{N}_]+/u`.

Blast radius, measured on the real 482-atom store: **5 atoms (1.0%)** tokenise differently, every
one an accented word that used to shatter (`hambüchen` was `hamb` + `chen`; `cháu`, `tét`, `4σ`,
`5¼h` were lost entirely). English is untouched — the arctic English arm came out **bit-identical**
before and after (hit@1 0.800, hit@5 0.964, MRR 0.865).

The interesting part is what it did to Vietnamese:

| arm | fused MRR before | after | lexical MRR before | after | lexical returned nothing |
| --- | --- | --- | --- | --- | --- |
| en | 0.8654 | 0.8654 | 0.7318 | 0.7318 | 8 → 8 |
| viMixed | 0.8512 | **0.8634** | 0.6887 | 0.7136 | 6 → 9 |
| viPure | 0.6021 | **0.6357** | 0.1389 | **0.0966** | 16 → **49** |

Fused retrieval improved while the lexical half's own score *fell*. That is the correct
direction and worth stating plainly: before the fix the shredded fragments (`nh*`, `th*`, `gi*`)
were prefix-matching English words in the corpus, so the lexical half was not silent — it was
**noisy and wrong**, and at `alpha = 0.8` that noise diluted the semantic half. Afterwards it
honestly finds nothing (49 queries with zero lexical candidates), `alpha` renormalises to 1 for
those queries (`anyLexical === false`), and the semantic half is heard undiluted.

### Layer 2 — FTS5's own tokenizer

`knowledge_items_fts` and `transcript_fts` declare no tokenizer, so FTS5 uses `unicode61`, whose
own default is `remove_diacritics=1`. Measured against real Vietnamese strings:

| variant | terms still carrying Vietnamese marks (of 24) |
| --- | --- |
| knowl default (`=1`) | 14 — `cờ dấu lần mặt nhiều nhất nhập thất thống trận tộc đa đang đanh` |
| `remove_diacritics 2` | 3 — `đa đang đanh` |
| `remove_diacritics 0` | 24 |
| `trigram` | n/a (folds nothing) |

So the default folds *single*-mark letters (`hành`→`hanh`, `khóa`→`khoa`, `dân`→`dan`) but not
Vietnamese's *stacked* tone marks (`cờ`, `nhất`, `mặt`), which need more than one decomposition
step. **`đ` is never folded by any setting**, because U+0111 is a distinct letter rather than
base + combining mark.

Confirmed on the **live transcript index** (22,837 messages, real data), typing Vietnamese
*without* diacritics — the common case:

| query | hits |
| --- | --- |
| `"tưởng"` / `"tuong"` | 4 / **0** |
| `"nhập"` / `"nhap"` | 3 / **0** |
| `"đăng"` / `"dang"` | 3 / **0** |

**Answer: no, `unicode61` does not fold Vietnamese diacritics well enough, and a no-diacritics
query finds nothing.** `remove_diacritics=2` *would* help — it fixes `tuong`→`tưởng` and
`nhap`→`nhập`, 11 of 24 terms in the sample — but it does **not** fix `đ`, so `dang` still misses
`đăng`.

Re-indexing cost `[MEASURED]`: `knowledge_items_fts` is cheap — rebuilding all 516 real rows took
**18 ms**, because the content lives in `knowledge_items` and the rebuild is one `INSERT…SELECT`.
`transcript_fts` is the expensive one: it is `content=''` (contentless), so its text is not in the
database at all and a tokenizer change means re-reading 1,770 transcript files. Both need a
migration that drops and recreates a virtual table, which is why this is filed as a finding and
not done here.

---

## 6. `[EXTERNAL]` — what the model card claims

`Snowflake/snowflake-arctic-embed-m-v2.0`, the model every real store on this machine uses. Its
card declares 74 language codes, and **`vi` is one of them**. The prose:

> Arctic Embed 2.0 introduces a new standard for multilingual embedding models, combining
> high-quality multilingual text retrieval without sacrificing performance in English.

> **Multilingual without compromise**: Excels in English and non-English retrieval,
> outperforming leading open-source and proprietary models on benchmarks like MTEB Retrieval,
> CLEF, and MIRACL.

The claim is broad; the *evidence* behind it is not. The card's own multilingual columns are
`MIRACL (4)` and `CLEF (Focused/Full)` — four MIRACL languages and a European evaluation.
**Neither covers Vietnamese.** So the card's Vietnamese support is a declaration in a metadata
list, not a measured result — which is precisely the gap §2 fills. The measurement agrees with
the declaration for code-switched Vietnamese (MRR 0.863 vs 0.865 English) and qualifies it for
the pure register (0.636).

`granite-small-en-r2` makes no multilingual claim at all — the preset table records its languages
as `English`, and §2 is what that costs.

---

## 7. The call

**Vietnamese retrieval works on the model our stores actually run; the abstention verdict on top
of it does not. Do not touch the floors — change the preset for Vietnamese use.**

1. **Ship the tokenizer fix.** Done here. It is 2 lines, it aligns the knowledge path with the
   transcript path that already did this, English is bit-identical, and it improves Vietnamese
   fused MRR in both registers. 1,829 tests pass (1,826 baseline + 3 new), `tsc --noEmit` clean.
2. **Do not move `MODEL_RELEVANCE_FLOORS`.** Measured, not assumed: on arctic, real Vietnamese
   queries (0.0987, 0.1262) score *below* Vietnamese junk's maximum (0.1938). No single cut
   separates them. The floor is calibrated per model on an English on-topic set
   (`per-model-floor.md`), and that is a documented limitation, not a bug to patch blind.
3. **For a repo whose owner queries in Vietnamese, set
   `search.vector.preset = granite-97m-multilingual`.** It is already in the table. It reaches
   English parity on the register he actually types (viMixed MRR 0.842 vs 0.841 English), and
   its floor is the only one of the three that behaves for both languages — 3/110 and 4/110
   abstentions, zero gold-at-rank-1 casualties, against arctic's 9 and granite-small's 20.
   Cost, and it is not small: a preset change is a new fingerprint, so every vector is rebuilt.
   The model lane measured the equivalent arctic rebuild on this exact store at **~185 min**
   (7 min for 516 atoms, 178 min for 22,837 transcript messages); granite-97m is a smaller model
   so this is an upper bound, not a prediction.
4. **`DEFAULT_PRESET_ID` deserves a second look, but not from this branch.** `granite-small-en-r2`
   scores viPure MRR 0.151 and abstains on 96% of it. That is defensible for an English-only
   default and indefensible if the person running `knowl init` is Vietnamese. It is a product
   decision with a real cost on the other side (52 MB vs 98 MB, 384-dim both), so it is filed
   with numbers rather than changed here.

---

## What this does not measure

- **Vietnamese *content*.** The corpus is ~100% English by measurement (2/482 atoms), so nothing
  here says how well a Vietnamese atom is retrieved by a Vietnamese query. The tokenizer fix is
  a precondition for that case, not evidence about it.
- **The 2 real queries prove nothing on their own.** They are reported as cosines against the
  real store and used only to check that the translated arms are in the same register. n=2.
- **Translations are not user queries.** They were written to be faithful and they cover all 110
  cases, but a translator's Vietnamese is not a user's Vietnamese, and the whole of §2–§4 rests
  on that arm.
- **Other languages.** Nothing here generalises to Chinese, Japanese or Korean, whose tokenization
  problem (no whitespace) is a different one that `\p{L}` does not address.
- **`remove_diacritics=2` end-to-end.** The tokenizer comparison is measured; its effect on
  retrieval metrics is not, because it needs a schema migration.
