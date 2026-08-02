# Changelog

Notable changes to `@dat999zx/knowl`. Versions before 2.1.0 predate this file; see the
[git tags](https://github.com/dat999zx/knowl/tags) for that history.

## 2.15.0 — 2026-08-02

### Changed

- **`knowl config` is one flat list of every setting.** No categories, no `Advanced`
  section, no level to descend into. Each row's hint is the value in effect, so the list
  is the display. Selecting any row opens an editor: the model fields, enums and booleans
  are pickers; everything else is a text box.

  It was a tree before — category, then setting, then value, with the keys a preset
  supplies hidden a level below that and refusing to open at all. Three levels to descend,
  with the thing you came for at the bottom and greyed out.

- **Edits show up in the list as you make them**, marked as unsaved, and are written
  together when you choose Save. `Discard and exit` leaves the file untouched. The
  `Edit another setting?` question after every single change is gone — returning to the
  list is the loop.

- **Interactive prompts moved from `@inquirer/prompts` to `@clack/prompts`**, with
  `picocolors`. Colour, box drawing, unicode fallback, session framing and cancel
  semantics now come from the library rather than from `src/cli/ui/style.ts`, which was
  reimplementing all of it by hand and has been deleted. `Ctrl+C` in any prompt returns to
  the list instead of tearing the process down mid-edit.

  This follows [rohitg00/agentmemory](https://github.com/rohitg00/agentmemory), whose CLI
  has no settings tree at all: a flat sequence of pickers, every option a
  `{ value, label, hint }`, and one cancel path out of anything.

### Removed

- `ConfigPrompts.selectCategory` and `ConfigPrompts.continueEditing`, replaced by
  `selectSetting`, which returns a setting key or one of `CONFIG_UI_SAVE` /
  `CONFIG_UI_QUIT`. `CONFIG_UI_BACK`, `createInquirerPrompts` and `fieldRows` are gone
  with the tree that needed them.

## 2.14.1 — 2026-08-02

### Fixed

- **Nothing in `knowl config` is read-only.** Every setting is selectable and every
  selection opens an editor. 2.14.0 refused to edit the three keys a named preset supplies
  and offered to open the preset instead — backwards for a screen whose entire purpose is
  changing things.

  The reason behind the refusal was real: `resolveVectorProfile` reads a named preset
  ahead of the flat keys, so writing `dtype` under `preset: bge-small-en` changed the file
  and nothing else. That is now answered by making the edit count rather than blocking it.
  Editing a preset-supplied field moves the profile to `custom` and writes the preset's
  other values out, so nothing is lost and the edited key wins.

- **A preset-supplied field opens on the value in effect**, not on whatever its own key
  happens to hold, so an edit starts from what is actually running.

- **`Model name` is a list.** It was the last free-text box on a value with known good
  answers; it now offers the four preset model ids and keeps typing for anything else.

## 2.14.0 — 2026-08-02

### Added

- **A visual system for the interactive commands**, in `src/cli/ui/style.ts`. Colour helpers
  that check the terminal on every call, box-drawing symbols with ASCII fallbacks, and
  `intro`/`outro` framing so `knowl config` opens and closes rather than just stopping.

  Colour marks one thing per row — the value, or the key you would script with — and is
  dropped entirely when `NO_COLOR` is set, when `TERM=dumb`, or when stdout is not a
  terminal, so a piped or logged run stays readable. `FORCE_COLOR` overrides.

  Symbols fall back to ASCII where box drawing is not safe. A legacy Windows console
  renders a missing glyph as a question mark, and it is still what a double-clicked
  `cmd.exe` opens.

### Changed

- **A category shows the settings you came to change, and nothing else.** Search is two
  rows — the embedding model and whether semantic search is on. `provider`, `model`,
  `dtype`, `pooling` and `cacheDir` moved behind `Advanced settings…`, which is also the
  only place the dotted config keys appear now: someone reading that list is already
  looking for what to pass to `knowl config set`.

  The previous list put a name, a value, a status word and a dotted key on every row, read
  while it moves under a cursor. It buried the two settings anyone opens Search for under
  five they never touch.

- **Prompts share one theme**, so the cursor, the highlight and the help line no longer
  differ between the category list, a value picker and a confirmation. Lists carry a
  breadcrumb heading (`Search › Advanced`) and a rule between the settings and the ways
  out — without it they read as one list and `Back` looked configurable.

### Fixed

- **The model picker now works on a repository that predates presets.** Ownership was read
  from `search.vector.preset`, and a config initialised before that key existed has none —
  so nothing was marked as preset-owned, `Model name` stayed a free-text box, and the
  picker opened with nothing selected. This was the whole point of 2.13.0 and it applied
  to none of the configs that needed it. `currentPresetId` falls back to matching the
  model string, so such a config reads `MiniLM L6 v2` and the picker opens on it.

- **Picking a model writes the whole profile**, not just the preset name. Writing the name
  alone was correct only because `resolveVectorProfile` prefers it; the flat keys were
  left describing whatever model came before, and a config with no `preset` key had
  nothing for the resolver to prefer. Choosing a model now repairs both.

- **A highlighted row keeps its colour to the end of the line.** The prompt library
  highlights by wrapping the text it was given, so a row that already carried colour ended
  the highlight at its own first reset. Escape sequences are stripped before wrapping.

## 2.13.0 — 2026-08-02

### Changed

- **`knowl config` reads like a settings screen instead of a key dump.** Every setting now
  carries a name and a one-line explanation, so the list shows `Embedding model` and what it
  does rather than `search.vector.preset: granite-small-en-r2`. The dotted key stays on the
  row — it is what `knowl config set` takes, and a UI that never shows it gives you no way to
  find it.

- **The embedding model is a picker built from the preset table.** `VECTOR_PRESETS` already
  recorded a readable label, a size and a language range for every model; the editor listed bare
  ids anyway. Choices now read `Granite 97M Multilingual R2 — 200+ languages, 32k context ·
  98 MB`. Selecting `Custom model…` still asks for a Hugging Face id and verifies it.

- **Every value prompt has a way out.** `ConfigPrompts.inputValue` returns `string | null`, and
  `null` abandons the edit without queueing anything; selects gained a `← Back` choice and text
  inputs cancel on a blank entry. Previously, selecting a setting by accident committed you to
  entering a value for it. Implementations that return a string are unaffected.

### Fixed

- **The editor no longer names a model that is not in use.** `resolveVectorProfile` reads a named
  preset ahead of `search.vector.model`, and switching preset never rewrites that key — so a repo
  running Granite still had `Xenova/all-MiniLM-L6-v2` on disk, and the editor displayed it.
  Preset-owned rows now show the value actually in effect, and `Pooling method` shows the
  preset's pooling rather than `unset`.

- **`search.vector.model`, `.dtype` and `.pooling` are no longer editable while a preset owns
  them.** Writing them in that state changed the file and changed no behaviour. They are marked
  `set by preset`, and selecting one offers to open the preset instead of dead-ending. Choosing
  the `custom` preset releases them, since it names no model of its own.

- **A secret is no longer reported as modified on a project that never set one.** `getConfigValue`
  returns the redaction for any secret field before it reads the file, so comparing that read
  against the default marked every secret as changed — `API key ******** modified` on a config
  with no `ai` section at all. An unwritten setting now displays the default that is actually in
  effect rather than `unset`, and is not marked.

## 2.12.1 — 2026-08-02

### Fixed

- **Change notifications are no longer swallowed when two tool calls land close together.**
  A non-shell tool event normalises to `summary: "<Tool> completed"`, and the capture
  fingerprint was built from that payload alone — so every `Grep` in a session hashed
  identically, and a second call inside the 1.5 second debounce window was dropped before any
  processing. No `KNOWL CHANGED` card, no drift counting, exit 0 and no output. Agents call
  tools far faster than that, so real notifications were being lost.

  Hook events now carry a debounce-only discriminator built from the tool name and its retained
  input, so calls that differ only in their arguments no longer collide. The `tool_input`
  allowlist additionally keeps `pattern`, `glob`, `query` and `url` — short strings, bounded like
  every other retained field and compared in memory only — without which search tools have
  nothing retained to tell one call from the next. Genuine duplicate deliveries of the same call
  are still collapsed, which is what the debounce is for.

## 2.12.0 — 2026-08-02

### Added

- **The embedding model is now a choice, not a constant.** `search.vector.preset` selects one of
  four vetted local models, or `custom` for your own. A preset bundles model, dtype and pooling
  together rather than leaving them as three keys you must keep consistent — pooling is not
  discoverable at runtime, and the wrong value produces plausible-looking vectors that rank badly
  with no error at all.

  | Preset | Model | Size (q8) | Context | Languages |
  | --- | --- | --- | --- | --- |
  | `granite-small-en-r2` *(default)* | `onnx-community/granite-embedding-small-english-r2-ONNX` | ~52MB | 8k | English |
  | `granite-97m-multilingual` | `onnx-community/granite-embedding-97m-multilingual-r2-ONNX` | ~98MB | 32k | 200+ |
  | `bge-small-en` | `Xenova/bge-small-en-v1.5` | ~34MB | 512 | English |
  | `minilm-l6-en` | `Xenova/all-MiniLM-L6-v2` | ~23MB | 512 | English |

  All four emit 384-dimension vectors, so switching never changes the stored vector width. New
  repositories default to `granite-small-en-r2`. **Existing repositories are not migrated**:
  `knowl upgrade` cannot introduce a preset, and a configuration written before presets existed
  keeps its model and its original mean pooling. No forced download, no silent model change, no
  reindex required.

  The default is English-only. Repositories storing non-English knowledge should select
  `granite-97m-multilingual`, which covers 200+ languages with enhanced training on 52 of them.

- **`knowl config set-model <model>`** selects a model of your own. It confirms the repository
  exists and ships `onnx/model_quantized.onnx`, reads its pooling method from
  `1_Pooling/config.json`, and asks which to use when the repository does not declare one —
  never guessing, because a wrong guess fails silently. The three resulting keys are written as
  one unit, so a half-configured profile can never reach disk.

- **`knowl workspace repin-embedding`** moves an established workspace to a different embedding
  model and names every peer that must then reindex. Previously the pinned identity could only be
  set while a workspace was empty, so changing it meant unlinking every repository.

- **A semantic retrieval benchmark** at `docs/evals/semantic-suite.json`, with `npm run
  bench:embeddings` comparing every preset. `knowl eval retrieval` now reports metrics per
  difficulty tier as well as overall.

### Changed

- **`knowl reindex --vectors` re-embeds items in every status**, not only active ones. Items that
  are superseded, deprecated or archived are still reachable through a status filter, so leaving
  them on a previous model made them permanently invisible to vector search. It also drops rows
  belonging to a previous model, and pages through the store instead of stopping at 10,000 items.

- **Changing the embedding model now offers to rebuild.** Interactive `knowl config` prompts;
  `knowl config set` prints the same warning with the affected row count, and says when the change
  also breaks a workspace pin.

### Fixed

- **Pooling is per-model rather than hardcoded to mean.** Every model was pooled as though it were
  MiniLM. Three of the four presets — including the new default — are CLS-pooled, so this would
  have silently degraded retrieval for anyone selecting one. Nothing errors when pooling is wrong;
  the vectors simply stop meaning what they should.

- **Embeddings record the profile that produced them.** Rows previously stored only provider and
  model, and search filtered on those two — but dtype and pooling also change the numbers a model
  emits, so changing either left old rows matching the filter and being scored against
  incompatible query vectors. Rows now carry a fingerprint over all four, added by an automatic
  migration that backfills each repository's current profile. A profile change now degrades vector
  search to keyword-only rather than mis-ranking, and an interrupted rebuild leaves a smaller
  searchable set rather than a mixed one.

- **The fingerprint filter can no longer be skipped by omission.** It was an optional parameter,
  and leaving it out dropped the predicate and scored every stored vector regardless of origin.
  Making it required revealed five call sites already doing exactly that.

- **Setting `search.vector.model` while a preset is active no longer reports a silent no-op.** The
  preset decides the model, so the command changed nothing while printing success. It now says the
  key is being overridden and names the model actually in use.

- **The access log reads back in the order it was written.** `retrieved_at` is millisecond text, so
  a retrieval and the feedback answering it routinely share one — and the tiebreak was the random
  hex `id`, which made the order of an append-only log a coin flip. Equal timestamps now break on
  the insertion counter.

## 2.11.1 — 2026-08-01

### Fixed

- **Hybrid retrieval now counts lexical rank for items vector search also returned.** The
  lexical term was gated on `vectorScore === undefined`, so any item vector returned had its
  BM25 rank discarded — an item ranked #1 lexically and #40 semantically scored on its weak
  cosine alone, indistinguishable from one lexical search never found. Agreement between the
  two engines is the signal hybrid retrieval exists to exploit, and it was the one case the
  fusion ignored.

- **The lexical weight is sized for fusion rather than fallback**, renamed
  `BM25_FALLBACK_WEIGHT` → `BM25_LEXICAL_WEIGHT` and raised 0.35 → 3.0. The old value was
  correct for a term reachable only when vector search came up empty, and deliberately too
  small to disturb the semantic ranking; as a live fusion term it capped lexical evidence at
  under 0.006 against a cosine spanning 0–1, enough to break exact ties and nothing else.

  Across the 500-case suite: **Recall@3 0.9887 → 0.9907, Recall@10 0.9940 → 0.9960, MRR
  0.9609 → 0.9639, nDCG 0.9689 → 0.9715**, with the same 8 failing cases.

  3.0 is measured rather than chosen. Retrieval improves monotonically with this weight, but
  it trades against the relevance floor, because a larger term lifts every score — at 8.0 an
  off-topic query clears the floor and starts answering again. At 3.0 the separation still
  holds on a live store: worst off-topic top score 0.2529 against a 0.30 floor, weakest
  legitimate 0.4016. Raising it further requires re-running that check, not just the eval —
  the suite is saturated on Recall@10 and cannot see a floor regression at all.

## 2.11.0 — 2026-08-01

### Added

- **Agent queries can now return nothing.** Asked something the store has no answer to —
  `training a labrador puppy` against a memory-system store — retrieval previously returned
  three confident results anyway, because vector search is nearest-neighbour with no distance
  cutoff and the only bound was `slice(0, limit)`. A measured floor of 0.30 now decides whether
  a question is answerable at all. Six off-topic queries that each returned three results return
  zero; all eight on-topic and all six deliberately-vague queries still answer.

  **The floor judges the query, not each result.** Measured across 20 queries, on-topic scored
  0.401–0.614 and off-topic 0.170–0.223 — but every one of those figures is a *top-result*
  score, so that is the only claim the measurement supports. Filtering each result instead cost
  real answers: against the 500-case retrieval suite it dropped `span export backend` (0.269),
  `jwt ttl configured value` (0.262) and `which test runner` (0.233), all three on queries whose
  top result scored 0.37–0.39, taking Recall@10 from 0.9940 to 0.9867. A weak result underneath
  a strong one is the tail of a real answer, not junk. No lower constant fixes it either —
  those answers reach down to 0.233 while off-topic queries reach 0.223.

  The shipped rule leaves the ranking untouched once a query clears, and the suite confirms it:
  **Recall@10 0.9940, MRR 0.9609, nDCG 0.9689 — identical to before, with the same 8 failing
  cases.**

- **Only results vector search could have returned are judged.** Two candidates arrive looking
  identical, both scoring about 0.034 with nothing to separate them: one that vector ranked
  outside its top N (semantically distant), and one with no embedding at all (invisible to
  vector, not distant — written since the last index, or while the embedding model was not yet
  cached). The floor now keys on whether an item is embedded under the provider and model being
  searched, so a just-written item is never suppressed by a verdict reached without it. A store
  with no embeddings is unaffected: every candidate is unjudgeable and the floor turns itself
  off.

## 2.10.0 — 2026-07-31

### Changed

- **Automatic capture now reads the two fields that actually carry knowledge.** The previous
  four rules were written before anyone measured what hook events contain. Measured across 32
  recorded sessions, git commit subjects carry 52% of the durable knowledge a reviewer would
  want kept and error text carries 45%; changed file paths alone carry **none**. So a commit
  subject becomes a `fact` or `architecture` item, and a failure that was followed by edits
  and did not recur becomes a `fact` naming what broke and what fixed it.

  `docs`, `test`, `chore` and merge commits are skipped — they record process, not knowledge.
  A failure that recurs later in the session produces nothing, because it was not fixed;
  claiming otherwise is worse than staying silent.

- **Two rules were deleted rather than re-tuned.** `Repeated workflow: …` and
  `Session outcome: …` both measured at zero value, and the first was not inert as an earlier
  baseline claimed — four such items exist in a real store, two written by the very session
  that measured it. Capture stays model-free: `finalizeMemorySession` still reports
  `usedAi: false`.

### Added

- **Skills are captured while the session is live, and surfaced back to later ones.** A
  repeated command carrying something non-obvious — a pipe, a redirect, a filter — now
  prompts the agent to save it as a runnable `.knowl/skills/` package while it still knows
  what the command was for. Asking at session end, as the old rule did, is why the stored
  items could only say "ran 3 times".

  Repetition alone does not qualify: a bare `npm test` never triggers it. The nudge fires
  once, and stands down entirely once a saved skill already covers that command. Saved skills
  appear in the session-start card within its existing character budget, and a matching skill
  is suggested after a command runs. A captured command is never executed.

### Fixed

- **Resolved-failure items no longer retire each other.** Every such item was titled from the
  error's first line, which on real data is always the shell exit line — so 22 of 31 shared
  the title `Resolved failure: Exit code 1`, and title-similarity supersession then retired
  each previous one. Replaying the recorded corpus through the write path: 30 items written
  and 6 surviving became 31 written and 31 surviving.

- **A synonym lookup could throw and lose a whole session's capture.** `SEARCH_SYNONYMS` was a
  plain object literal, so two ordinary lowercase tokens resolved to inherited
  `Object.prototype` members — truthy, not iterable, and fatal inside `finalizeMemorySession`.
  The table now has a null prototype.

- **The commit parser no longer accepts shell syntax as a subject.** Its capture class matched
  newlines, so `git commit -m "$(cat <<'EOF'` yielded a wrapper fragment whose type parsed as
  null — bypassing both the skipped-type and merge filters. The capture is bounded to one line
  and the `$(cat <<'DELIM')` form is parsed properly rather than dropped.

## 2.9.0 — 2026-07-31

### Added

- **The drift check runs at session start, and reports rather than decides.**
  `checkKnowledgeDrift` had existed since the `pr` command shipped, but its only caller was a
  command someone had to remember to type — so in practice knowledge went stale exactly as if
  the check did not exist. The session boundary is the right chokepoint, being the moment
  before an agent starts relying on memory, and a watermarked check now runs there and leads
  the session context with what moved.

  It detects; it does not flip. Measured on a documentation-heavy repository, one commit
  window matched 36 of 301 atoms and fifteen windows matched a third of the store: atoms
  annotate hot files, hot files change daily, and an automatic freshness flip would hold those
  atoms at `needs_review` permanently. Run by hand after a PR that flag volume is a review
  worklist; applied silently at every session start it is corpus-wide ranking damage and a
  warning that cries wolf. So the warning names the count, the leading titles, and the exact
  pinned `knowl pr check --since <commit>` command, and flipping freshness stays deliberate.

  The first run learns its baseline silently, and a watermark that no longer resolves — a
  rebase, an aggressive gc — re-baselines quietly rather than guessing. The warning is charged
  against the context budget before the recent-knowledge block, so it cannot push a session
  past the size the host was promised, and it is the part that survives: the watermark has
  already advanced, so that line is the only record of the window.

- **A correction flags the batch that produced it.** A wrong memory is a class, not an
  instance. The extraction pass or session promotion that produced one bad atom usually
  produced more, and the correction is the one moment the system knows where to look. Siblings
  of a corrected item — same insert commit, same source label, shared evidence — flip to
  `needs_review`, capped at twelve and recorded as one knowledge commit, so the existing change
  cards announce them.

  Only two unambiguous signals fire it: `knowl_feedback` with `causedCorrection`, and demotion
  to deprecated or rejected. A routine supersede deliberately does not — state atoms supersede
  weekly, and firing there would be a flag storm. The insert commit defines the batch, so the
  replacement that performed a correction is never itself flagged.

- **`tier`: standing earned by use, orthogonal to self-reported confidence.** Every write
  starts `asserted`; two confirmed-useful feedback events promote it to `verified`; a
  correction demotes it immediately, and a content edit resets it, because verified means
  verified-verbatim. Confirmations are counted from the moment the current tier began, so a
  reset genuinely restarts the climb instead of inheriting events that confirmed a claim the
  item no longer makes.

  Ranking gains a bounded standing term sized below the freshness re-rank: earned standing
  breaks ties between near-equals, and never outranks being current. Tier is deliberately
  absent from `lifecycleHash` — verification is one machine's own experience with an item, and
  an imported copy has not been used there yet.

- **`provenance`: how the knowledge came to be believed, fixed at write time.** `observed`,
  `user_stated`, or `inferred`, accepted on both `knowl_store` and the batch atom path, since
  extraction and session promotion write through the batch. Inferred items take a small ranking
  discount — a discount, never a burial, because an inferred item may still be the only answer.
  NULL on legacy rows means exactly "written before the class existed".

  The motivation is the memory-poisoning literature's central finding: a reflected "lesson"
  reads as authoritative once stored, and the class it was born with is the only surviving
  record that it was ever a guess.

### Changed

- Schema gains `tier`, `tier_since`, and `provenance` on `knowledge_items`, plus a `drift_state`
  table. All additive and column-guarded; no migration step is required.

## 2.8.0 — 2026-07-30

### Added

- **A repository can record what it is, and whether its knowledge is shared by default.**
  `knowl workspace add` stored a name and a path, so a repository's nature — code with private
  internals, notes that are cross-cutting by definition, one of two diverged forks — lived
  nowhere. Every agent re-derived it, and got it wrong the same way each time: one uniform
  "share selectively" posture applied across repositories that do not share a nature.

  `--role` is free text describing the repository, carried in the manifest so an agent that
  joined on another machine has it too. It is never parsed and no behavior is inferred from it.
  `--default-visibility workspace` stamps new writes as workspace-visible, so a notes
  repository stops depending on someone remembering to promote each item; `--promote-existing`
  shares what it already knows in the same command. `--kin` groups repositories of shared
  lineage, and the cross-repo write advisory checks them wider and says what they are — a
  same-subject hit between two forks is likelier a real divergence than a coincidence.

  `knowl workspace set` changes any of the three afterwards, and with no flags prints them.
  Every repository's role and default visibility now appears in `knowl status` and at the top
  of the session-start context block, so an agent has them before its first sharing decision.

  A workspace default is gated at both entry points, because it is standing automatic
  publishing rather than an explicit per-batch promote: it states that sharing cannot be
  undone, that there is no demote, and that turning it off stops future writes only. Absent
  fields mean current behavior, so existing manifests need no migration.

- **`knowl upgrade --all` upgrades and repairs every repository on the machine.** A release
  used to mean visiting each repository by hand: upgrade, run doctor, read the warnings, run
  whichever command each warning named, run doctor again. A repository you forgot drifted
  quietly — schema migrations apply themselves on every database open, but guidance files and
  lifecycle hooks, the two things that change how agents behave, waited for someone to `cd`
  in. The sweep finds every repository, snapshots it, upgrades it, applies the repairs doctor
  found, re-checks, and prints one summary; it exits non-zero if any repository is still not
  ready. `--dry-run` lists what it would visit and changes nothing.

  Repositories are found from workspace manifests and from a registry that `init` and
  `upgrade` now write, so a repository is known to a sweep after one visit — including one
  belonging to no workspace, which nothing outside its own directory knew about before. Pass
  `--root <dir>` once for repositories that predate the registry; what a scan finds is
  remembered.

- **`knowl doctor --fix` applies the repairs it just described.** Doctor already knew the
  exact command for each finding, but only as prose, so acting on it meant reading the output
  and retyping. Findings now carry their repair in a form the CLI can run: guidance refresh,
  the `.knowl/` ignore entry, session recovery, and host re-registration. Findings with no
  safe automatic answer — integrity errors, an empty knowledge store — are reported as
  unfixable rather than quietly counted as handled.

  Two deliberate limits. A host is only ever re-registered if the repository already uses it,
  so a repair can never opt a repository into an agent it did not choose. And re-embedding is
  never automatic, because its cost scales with how much a repository knows; it is reported
  and waits for `--reindex`.

### Fixed

- **`upgrade` now claims knowledge that older versions left unowned.** Joining a workspace
  stamps every item present at that moment with the repository that owns it, but until 2.6.0
  nothing stamped the items written afterwards. Those rows stayed unowned, and nothing since
  went back for them — so the count that stops `workspace remove` from orphaning a
  repository's knowledge did not see them, and the repository could be unlinked as though it
  held nothing. `knowl upgrade` now sweeps them, using the same rule as joining: it only ever
  claims an unowned row, never reassigns one that already has an owner, and does nothing at
  all outside a workspace, where unowned is the correct state. It reports what it claimed.

- **`workspace promote` says what was wrong with your filter instead of "Nothing to
  promote."** Three commands all produced that one line and exited successfully: an id given
  in the short form the listings print, a category that does not exist, and — on Windows — a
  perfectly correct `--category a,b,c`, because `knowl.cmd` runs through `cmd.exe`, which
  splits arguments on commas and left the trailing categories to be silently discarded. Each
  now fails, names the value it could not use, and the Windows one explains the quoting.
  An unknown id refuses the whole command rather than promoting the ids that did resolve:
  promotion has no reverse.

## 2.7.1 — 2026-07-30

### Fixed

- **Writing a few thousand items in one process could crash it.** 2.7.0 added a check for
  knowledge that overlaps a linked repository, and worked out which workspace you were in
  *inside* that check — so every single write re-read and re-parsed the project config. A run
  of 2500 ordinary writes died partway through, at around two thousand, with no workspace or
  vector search involved. The same run completes on 2.6.0. Which workspace you are in is now
  worked out once per process, as it already was for batch writes.

  One consequence to know about: linking a repository to a workspace while a long-running
  process is already going will not be noticed by that process until it restarts. That was
  already true of ownership stamping, and it is now written down and covered by a test rather
  than left to be discovered.

## 2.7.0 — 2026-07-30

Linked repos are now searched by the same code that searches your own, and a write is told
when another repo already covers the same subject.

### Added

- **Cross-repo conflict and duplicate reporting.** Duplicate and contradiction checks only
  ever looked in the repo doing the writing, so two linked repos could hold directly
  contradictory knowledge and nothing noticed. A write inside a workspace now also checks
  the linked repos and names what it found, and which repo owns it. It reports and never
  changes anything: that item belongs to another repo, and only its owner can retire it.
  Both the single-atom and batch writers do this, the batch naming which atom overlapped, so
  five findings do not collapse into "something in your batch overlapped". Bounded to a few
  candidates per repo and never fatal — a repo that cannot be read yields no report rather
  than a failed write. Outside a workspace it costs one check.
- **One retrieval engine, pointed at any repo.** A linked repo was searched by a separate,
  simpler implementation: a raw substring scan, scored without the recency, confidence,
  freshness, category or identifier handling your own results get. So a linked repo's
  answers were ranked by older rules than your own, and every future ranking improvement
  would have had to be made twice. Reads now take an explicit database, so the same code
  runs against any repo.

### Changed

- **Results from every repo are now scored together, in one pass.** Each repo used to be
  ranked on its own and the rankings combined afterwards. That could not work: "how recent
  is this" was measured against each repo's own results, so every repo's newest item scored
  as maximally recent regardless of its actual age. Scoring the combined set removes the
  problem rather than compensating for it, and the cross-repo ranking benchmark improves
  from 0.833 to 1.0 on the non-vector path with no weight added or changed.
- **`knowl query` and the `knowl_query` tool now rank identically.** The command line used a
  plainer keyword search — no vector search, none of the ranking adjustments — while an
  agent asking the same question got the full engine. It also disagreed with itself,
  ranking better inside a workspace than outside one and returning three results instead of
  twenty. Both paths now use the shared engine and the same default.
- **The portable export format is now version 2.** It carries owning repo, visibility and
  the new lifecycle fingerprint. Version 1 files still import, with ownership defaulted,
  which is what a file written before those fields means. A version this build does not
  recognise is refused rather than imported with pieces silently missing.
- **Identical knowledge held by two repos no longer takes two result slots.** It is
  collapsed before the result limit is applied, keeping your own copy, so a shared fact
  cannot shorten the list you asked for.

### Fixed

- **Search could return nothing while a matching answer sat just past its limit.** Results
  were cut to the limit and *then* filtered, so a query whose strongest matches were all
  archived came back empty. Filtering now happens inside the search.
- **A linked repo's private notes could reach another repo.** One of the two search paths
  never received the visibility filter, so items a repo had deliberately not shared could
  come back through a cross-repo query. The filter is now part of the query itself, so an
  unshared row is never read into another repo's process at all.
- **Exporting and re-importing threw away who owned what.** Export wrote the owning repo and
  visibility into the file; import's column list did not include them, so a round trip
  returned everything owned by nobody and private, with nothing reporting the loss.
- **Promoting, retiring or superseding a note could not travel between machines.** Those
  changes leave the text identical, and import compared only the text, so it declared the
  item unchanged and skipped it. A separate lifecycle fingerprint now travels with the item.
  Promotion also records when it happened, without which no other machine could ever prefer
  it.
- **A delete could un-delete itself.** Two places overwrote a deletion's timestamp without
  checking it was newer, so replaying an older delete moved the record backwards. Import
  also now refuses to reinstate something deleted after the export was taken, and says so
  rather than reporting it as already held.
- **"Only one active answer to this" never worked without a scope.** An exclusive conflict
  key with no scope matched nothing and guarded nothing, in both the check that reports a
  conflict and the guard that prevents the write — so fixing one alone would have reported
  the conflict and still allowed it.
- **`--as-of` matched whole phrases instead of keywords.** It found proper candidates, threw
  them away, and fell back to a literal substring search, so a keyword query missed items a
  present-tense query would have found. Both paths now share one candidate list.
- **The database file kept changing after it was closed.** Writes live in a side file until a
  checkpoint folds them in, and closing did not wait for that — leaving the main file in
  motion after the close returned. This is why some environments could not delete a
  project directory immediately afterwards.

## 2.6.0 — 2026-07-29

Agents now find out when memory changes underneath them in a linked repo, and on hosts
that never got told at all.

### Added

- **A change in a linked repo now reaches agents in the repos that can read it.** Change
  notification only ever watched your own repo's history, so when another repo promoted,
  updated, or retired a workspace-visible item, agents working here could read the new
  value through `knowl_query` but were never told it had moved — with no bound on how long
  they could go on trusting the old one. Each linked repo is now tracked separately, and
  the card names the repo a change came from, because a fact from another repo describes
  that repo. A repo-private item is never named, and a peer that is absent or mid-write is
  retried rather than skipped.
- **Change cards now arrive through Knowl's own tool results, not only through hooks.**
  Hosts without a mid-turn hook channel — Claude Desktop, generic MCP clients, and anyone
  running Knowl with no hooks installed — had their change cards computed and then thrown
  away, and could never be told about those changes again. The news now rides back on the
  next `knowl_*` call, which reaches any MCP client. Hosts that already deliver cards
  through hooks are detected and stay on that path, so nothing is announced twice.

### Fixed

- **`knowl workspace promote` left no trace in the project's history.** Promotion is the
  moment an item becomes readable by other repos, and it was the one knowledge event that
  could never be observed after the fact — including by the repos it was performed for.
- **An agent could be told about a change it had just made itself, and could miss one it
  hadn't.** Recognising your own writes was previously a guess based on matching titles, so
  a write's knock-on effects — superseding a near-duplicate, collecting stale items — came
  back to you as somebody else's work, while a genuinely foreign change that happened to
  share a title was silently hidden. Your own writes are now identified exactly, and the
  title guess is only used where that exact information is unavailable.
- **A session started in a repo with no history missed its first change.** The very first
  change committed after such a session began was treated as bookkeeping and swallowed.
- **`knowl workspace promote` could not promote anything written after the repo was
  linked.** Ownership is stamped when a repo joins a workspace, and nothing stamped it
  afterwards, so everything written from then on — the normal case — was treated as
  belonging to another repo and refused, with the misleading message "1 matching item(s)
  belong to another repo". Unowned items are now recognised as this repo's own, which they
  are, and promoting one records the ownership for good.
- **A hook payload starting with a UTF-8 byte order mark failed the whole hook.** Hosts
  send clean UTF-8, but a hook wrapped in a PowerShell redirect on Windows does not, and
  the three invisible bytes made Knowl exit with `expected a value` — no memory capture and
  no change cards, with nothing in the error to suggest the cause.

## 2.5.1 — 2026-07-28

A startup race between Knowl processes could leave the MCP server permanently stuck.

### Fixed

- **The MCP server could get permanently stuck after starting up alongside another Knowl
  process.** Two or more `knowl serve` processes bootstrapping the same project at nearly
  the same moment — several host windows opening at once, or reconnecting in quick
  succession — could make one of them hit a momentary database lock during startup. That
  process then failed every tool call for the rest of its life, even though the database
  itself was fine throughout; reconnecting or restarting the host was the only recovery.
  The lock is now waited out instead of failing instantly, and a startup that does still
  fail no longer leaves a connection abandoned holding the lock open.
- **A locked-database startup failure told you to run `knowl init`.** That's the right
  advice for a project that was never initialized, and the wrong one for a healthy project
  that was just momentarily locked by another process. The two cases now get different
  messages.
- **`knowl doctor` could report `READY` (exit 0) on a project with real problems.** Its
  exit code was set after an unrelated, best-effort check for a newer published version —
  a network call with its own timing — instead of right after the checks that determine
  readiness. A script gating on `knowl doctor`'s exit code could occasionally see success
  for a project that was not actually ready.

### Changed

- **Reading a linked workspace repo's knowledge is now read-only enforced by SQLite
  itself**, not only by which code path is used to open it. A future bug that mistakenly
  wrote through that connection would previously have silently changed a repo you don't
  own; it now fails immediately instead.

## 2.5.0 — 2026-07-27

Link several repositories so agents can work across them. Plus a fix that affects every
project, workspace or not.

### ⚠️ Run this once after upgrading

**`knowl reindex --vectors`** — in every existing project.

Knowledge saved before your first search was never indexed for semantic search, so it is
invisible to it today. The fix below stops it happening again, but it does not go back and
index what is already there. `knowl doctor` now tells you how many items are affected.

### Added

- **Workspaces.** `knowl workspace init <name>`, then `knowl workspace add <name>` in each
  repo. An agent in one repo can then read knowledge from the others, and every result says
  which repo it came from so a fact about the server is not applied to the web client.
- **Nothing is shared until you say so.** Everything you already have stays private to its
  repo. `knowl workspace promote --category decision --apply` shares what you choose. There
  is no un-share, because other repos may already have read it.
- **`knowl workspace join <manifest>`** for a second machine or a teammate. Repo paths
  differ per machine, so joining points the workspace at your checkouts.
- **`knowl workspace status`, `list`, `remove`.** `doctor` reports linked repos that are
  missing from this machine, and a repo whose embedding settings do not match the
  workspace — mismatched settings make items invisible to each other with no error.
- **`knowl init` prepares the embedding model**, so knowledge is indexed from the first
  note onward. It never fails your setup: offline or behind a proxy you get keyword search
  and a message saying so. Skip it with `KNOWL_SKIP_MODEL_DOWNLOAD=1`.

### Fixed

- **Knowledge saved before your first search was never indexed.** Embedding on write
  deliberately never downloads the model, and nothing else fetched it until the first
  search — so everything written before that was permanently invisible to semantic search,
  with no error. An agent saving twenty notes in a session left all twenty unreachable.
- **`knowl doctor` said vector search was fine when it was not.** It reported that the
  feature was switched on, which was true and useless. It now reports how many items are
  actually indexed, and names the command to fix a gap.
- **`knowl reindex --vectors` claimed to download a model it already had.** It said
  "Downloading" on every run. Nothing was being fetched; it now says "Loading".
- **Cross-repo results were ranked by keyword overlap rather than meaning.** A repo's
  knowledge is now ranked the same way local knowledge is, so the answer that actually
  answers your question comes first even when it lives in another repo.
- **`knowl query` and the agent tool gave different answers.** The command-line search did
  not search linked repos, and later ranked them differently from the agent tool. Both now
  behave the same way.
- **`knowl status` never showed workspace information** even when the repo was linked.

### Known limits

- No notification when a linked repo adds knowledge — you see it when you search.
- Linked repos are read-only. You cannot edit another repo's knowledge from here; run the
  command there.
- Code symbol indexing stays per repo.

## 2.4.0 — 2026-07-26

A release of things that were quietly not working. Nothing here is a new feature you can
point at; several are cases where Knowl reported success while losing or hiding your
knowledge. Most were found while designing multi-repo workspaces — a shared database turns
each of them from latent into destructive — but every one of them is a bug in the
single-repo product today.

### Fixed

- **A correction could be silently dropped.** Identical content produced different memory
  depending on which agent wrote it: Codex deprecated the stale item first, while Claude
  relied on auto-dedup and had its correction discarded. Only an exact title match
  superseded; everything else was thrown away. All three write paths now share one
  resolution — `no-op` only for a byte-identical re-store, `supersede` when one title's
  significant tokens are a subset of the other's, and `coexist` otherwise, which keeps both
  and tells the caller what it was left beside. Superseding is judged on titles, not whole
  text, because content overlap cannot separate a correction from a lifecycle trail: a work
  loop's start and finish records share most of their body tokens and must stay side by
  side. `knowl_ingest_atoms` now reports each atom individually, having previously counted
  a verbatim no-op toward its stored total and called an empty batch a success.
- **`knowl_query` returned less than it found, without saying so.** An `asOf` query
  hard-filtered on category, unlike every other path, so a wrong category guess returned
  nothing where the same query without `asOf` recovered; it now retries without the filter
  when the filtered result is empty. Separately, vector search and `explain` silently fell
  back to the project database alone, dropping session and any configured
  organization/global knowledge — that scope narrowing is now disclosed in the reply
  instead of being invisible.
- **Writes outside the project layout were stored with no embedding.** The embedding writer
  derived its config directory from the database's location, which only holds for
  `<root>/.knowl/knowl.db`. Any other database produced a nonsense path, config loading
  threw, and the best-effort catch swallowed it — so the item was written with no vector
  and no error. Vector-first ranking then made it effectively unretrievable.
- **Layered retrieval dropped status and tag filters.** Only the query, limit and surface
  reached each namespace, so asking for archived items or a specific tag got neither.
  Category remains a ranking boost rather than a filter, matching the direct path, because
  a wrong category guess must not empty a result set.
- **Reading a database migrated it.** Schema bootstrap runs on every open and includes the
  legacy-schema migration, which drops foreign keys and rebuilds tables outside a
  transaction. Opening a database to read from it therefore rewrote it. There is now a
  read-only open that skips bootstrap entirely.
- **`listKnowledgeItems` accepted a scope and ignored it.** It took a project id and
  selected the whole table, so garbage collection, synthesis, integrity checking, drift,
  export and the viewer all read as bounded while scanning everything. The argument is
  gone rather than quietly honored, so nothing reads as scoped that isn't.

### Added

- **Knowl refuses to open a database written by a newer version.** There was no schema
  version marker at all, and because the schema is built from `CREATE TABLE IF NOT EXISTS`
  plus additive `ALTER`s, an older client saw every table it expected, found nothing
  missing, and proceeded — writing rows the newer schema's rules do not hold for. Databases
  now carry a version and an older build declines with a message naming both.
- **Connections are pooled.** Each namespace query previously closed and reopened the
  database twice. Clients are now cached per resolved path and open mode.
- **Query results can carry provenance.** The compact response shape is an allowlist, so
  any label attached upstream was discarded before reaching the agent — including the
  namespace label layered queries have always attached. `repo` and `namespace` now survive
  serialization. Both are absent unless supplied, so existing output is unchanged.
- **`origin_repo` and `visibility` columns on knowledge items.** Groundwork for linking
  repositories into one knowledge base. Nothing reads them yet: outside a workspace
  `origin_repo` stays null and `visibility` stays `repo`, which is exactly current
  behavior.

### Changed

- Database paths are resolved in one place instead of being derived independently in three,
  which had no visible effect only because the three happened to agree.

## 2.3.0 — 2026-07-25

Memory can now move between two machines more than once, and deletes move with it.

### Added

- **Repeatable import.** `knowl import` classifies each incoming item as new, identical,
  or divergent, and resolves divergence with `--on-divergence`: `newer` (default — latest
  `updated_at` wins, `version` breaks ties), `skip`, `theirs`, or `fail`. Previously a
  single divergent item discarded the entire import, so a machine that had done any work
  could never receive anything again — including unrelated new knowledge with no conflict
  at all. Measured on a real 372-item export: one locally edited item used to block a
  peer's new decision from landing; now it lands and the divergence is reported by id and
  title.
- **Convergence.** An adopted item is written verbatim — the peer's own `content_hash`,
  `version` and `updated_at` — so a repeat import is a no-op. Applying it as an ordinary
  update would stamp a new timestamp and version, making the copy newer than the peer's
  and leaving two machines to trade a fresh winner back and forth forever.
- **Deletes travel.** Purging an item records a tombstone that export carries and import
  replays. A local item is removed only when it is older than the delete, so an edit made
  after the remote delete wins. `knowl gc --tombstone-days` (default 90) prunes them.

### Fixed

- **An agent was told about its own writes.** On Windows the same project reaches Knowl
  with different drive-letter case — a hook payload reports `D:\project` while
  `process.cwd()` reports `d:\project` — and the binding key preserved that difference.
  One agent therefore held two independent change watermarks: a write advanced one, and
  the next tool event read the other, found it stale, and reported the write back as a
  foreign change. The continuation-reminder counter was split the same way.
- **Imported knowledge was invisible to vector search.** Import wrote raw SQL and never
  called the embedding indexer that every other write path calls. Importing 372 items
  produced 372 full-text rows and zero embeddings, so retrieval silently fell back to
  BM25 until someone ran `knowl reindex --vectors` by hand.
- **`knowl --help` described half its commands.** `timeline`, `query`, `conflicts`,
  `supersede`, `context`, `export`, `import`, `synthesize` and `view` had no description
  at all.
- **`knowl doctor` named a command that does not exist.** Its integrity hint suggested
  `knowl update`, which exists only as an MCP tool. It now names `knowl supersede`.

### Changed

- **`knowl import` output has a new shape.** `skipped` is now `identical`, and `updated`,
  `keptLocal`, `deleted` and `divergent` join it. A dry run or a failed import reports
  every count as zero with the projection under `wouldApply`, replacing output that
  showed a non-zero `inserted` beside `applied: false` and read as partial success.
  Anything parsing this output needs updating.

## 2.2.0 — 2026-07-25

Live verification of the 2.1.0 subagent work found it shipped half-working, and fixing it
turned up two ways memory could be lost or blocked without telling you.

### Fixed

- **Subagents had memory but no reason to use it.** 2.1.0 delivered a subagent's memory
  snapshot and no guidance at all — a spawned agent received no prompt reminder, no MCP
  server instructions, and no `KNOWL.md`. Probing a live subagent settled the question the
  design had left open: MCP instructions do *not* reach a subagent's startup context. A
  guidance card now ships with the bootstrap, budgeted before the memory snapshot so a
  large snapshot cannot truncate it away.
- **Corrections were discarded in favour of the value they corrected.** `knowl_store`
  superseded a same-titled near-duplicate only for `state`. For every other category the
  *new* write was dropped: storing "Cache TTL: 5 minutes" and then "Cache TTL: 30 minutes
  now" left the stale five-minute item active and threw the correction away. The
  exact-title rule now applies to every category. Nothing is lost either way — a
  superseded item keeps its status and stays queryable.
- **`.env.example` counted as a secret.** The sensitive-path check matched `.env` plus any
  suffix, so `.env.example`, `.env.sample`, `.env.template` and `.env.dist` were all
  rejected. Those files exist to be committed. Template suffixes are now exempt, matched
  exactly, so `.env.exampled` is still caught.
- **`security.rejectSecrets: false` did not fully turn secret rejection off.** The
  sensitive-path check ran before the flag was consulted, so the only knob available was
  silently partial and `knowl doctor` could report NOT READY with no setting able to clear
  it. All secret detection now sits behind that flag.
- **`knowl doctor` misreported its integrity check.** It described errors as "warning(s)"
  while failing on them, and pointed at "repair reported records" when `knowl audit` is
  read-only and no repair command exists. It now counts errors and warnings separately and
  names commands that exist.

### Changed

- **`knowl config` is navigable.** Choosing a category no longer commits you to editing
  something in it: the field list offers `Back` and the category list offers `Quit`, and
  quitting without changes no longer prompts to save an empty diff.
- **Config values are picked, not typed.** Fields now declare their type, so booleans and
  enums are presented as choices instead of free-text boxes that required typing `true` or
  recalling the valid `dtype` values. Text and list fields prefill the current value.
- **A bad config entry no longer discards your work.** Invalid input is reported and
  re-prompted rather than throwing away every pending change.
- **The duplicate reply from `knowl_store` says what happened.** It previously read
  "skipped duplicate insert", which scans as success; it now leads with `NOT STORED` and
  names the recovery.

### Documentation

- Spec for the portable memory round trip — repeatable import and traceable deletes —
  covering the two items deferred from the collaboration scoping work.

## 2.1.0 — 2026-07-25

Subagents get project memory, and any agent is told when memory changed underneath it.

### Added

- **Subagent bootstrap.** `SubagentStart` and `SubagentStop` are registered for Claude Code.
  A spawned subagent receives its own memory snapshot, capped at half the normal context
  budget because fan-out multiplies whatever a subagent costs. Previously a subagent
  received nothing at all: `SessionStart` fires once per session and never reaches one.
- **Per-agent binding scope.** Subagent hook events carry an `agent_id`, now used as the
  session-binding scope, so every subagent has an independent change watermark and an
  independent continuation-reminder counter.
- **Change notification.** Each accepted tool event compares a per-agent watermark against
  the latest knowledge commit and, when it has moved, returns a compact titles-only card
  naming what changed. It costs nothing when nothing changed, replaces the continuation
  reminder when both would fire rather than adding to it, and never reports an agent's own
  writes back to it.
- **`changes` in host-neutral hook output.** `knowl agent-hook <host> <event> --json` now
  carries the same change summary as structured JSON, so hosts with no native protocol can
  consume it without one.
- **Host profiles.** Each supported host is described by one file in `src/cli/agents/hosts/`
  declaring its identity keys, event map, and context envelopes, replacing host conditionals
  spread across six modules. Capability is expressed by return value, so support cannot be
  claimed for a channel that delivers nothing. Adding a host is adding a file.
- **Change notification beyond Claude Code.** Codex CLI receives subagent bootstrap and change
  cards through the same `hookSpecificOutput.additionalContext` channel, verified with a live
  Codex model run. Cursor is sent `additional_context`. Hosts with no hook channel continue to
  read `changes` from the host-neutral JSON result.

### Fixed

- **`knowl_query` with `asOf` crashed** with `queryKnowledgeBase is not defined`. The
  historical-query branch of the MCP server called a function it never imported, so a
  documented parameter of the most-used tool failed at runtime.
- **`knowl_ingest` always reported zero counts.** It read `insertedIds`/`updatedIds`/
  `supersededIds` off the pipeline result, which carries them on `mergeResult`, so every
  ingest returned `{inserted: 0, updated: 0, superseded: 0}` regardless of what it stored.
- **Sibling subagents corrupted each other's continuation reminder.** All subagents shared
  the parent's binding row, so their tool calls incremented and reset one counter between
  them.
- **Subagent identity was stripped from hook payloads.** The lifecycle payload allowlist
  dropped `agent_id` and `agent_type` before normalization, and dropped the tool arguments
  needed to recognise an agent's own writes.
- **Claude Desktop was routed through Cursor's hook event map.** The event-mapping ternary
  checked only Codex and Claude by name, so every other host fell through to Cursor's
  camelCase events. Each host now declares its own map, and a conformance suite asserts it.

### Upgrading

- **Rerun `knowl init` for your hosts once.** A configuration written by an earlier version
  has no `SubagentStart`/`SubagentStop` handlers, and subagents keep starting with no memory
  until you rerun it. `knowl doctor` reports the configuration as stale in the meantime.
- **Codex users must trust the hooks.** Codex does not execute project hooks until they are
  trusted once, interactively when prompted or with `--dangerously-bypass-hook-trust` in
  automation. Until then the hooks silently do not run.
- **No database action required.** The new `seen_commit_rowid` column is applied
  automatically the next time any Knowl process opens the database.
