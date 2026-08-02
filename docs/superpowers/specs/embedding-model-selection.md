# Embedding model selection

## Problem

The default embedding model, `Xenova/all-MiniLM-L6-v2`, is weak in two ways. It is English-only,
so non-English text is split into meaningless sub-word pieces and semantically equivalent text in
other languages lands far apart in vector space. It is also poor at synonyms and paraphrase within
English. Users cannot change the model without hand-editing config, and there is no guidance about
which model to change it to.

This change fixes the synonym weakness by default and makes the multilingual fix a one-line
selection rather than research plus hand-editing. It does not make multilingual retrieval work out
of the box; see Risks.

A second, separate problem blocks any attempt to verify an improvement: the checked-in retrieval
suite cannot measure embedding quality. Measured 2026-08-02 across its 500 cases, 83.2% have at
least half their query words appearing verbatim in the expected item, and only 3.6% have zero
lexical overlap. BM25 alone satisfies most of it, so scores sit near ceiling regardless of which
embedding model is configured.

## Goals

- Let users pick an embedding model from a small set of vetted presets, or supply their own.
- Make a model change safe: no silently-degraded vector search, no mixed-model embedding rows.
- Ship a benchmark that can actually tell one embedding model from another.

## Non-goals

- Remote or API-backed embedding providers. `provider` stays `local`.
- Changing the fusion, reranking, or freshness logic.
- Multilingual benchmark coverage. Decided explicitly out of scope; see Risks.

## Decisions

Five decisions were settled with the user before this spec was written.

1. **Preset shape** — a named profile bundle. One key selects a profile carrying model, dtype and
   pooling together, rather than requiring three independent keys to be set consistently.
2. **Custom model flow** — verify and download at selection time. A model name that does not
   resolve, or has no ONNX weights, is rejected before the config is saved.
3. **Switch flow** — offer a reindex immediately after a save that changes the model.
4. **Default** — new repositories default to `granite-small-en-r2`, and multilingual support is
   opt-in. Existing repositories are left on whatever they already use. This was settled after the
   English-only consequence was raised and reaffirmed.
5. **Reindex scope** — re-embed every status, and purge embedding rows that do not match the
   configured model.

## Design

### Presets

Listed in the order the picker shows them. `granite-small-en-r2` is the default for new
repositories.

| Preset id | Model | Pooling | dtype | Dims | Context | Size | Languages |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `granite-small-en-r2` (default) | `onnx-community/granite-embedding-small-english-r2-ONNX` | cls | q8 | 384 | 8192 | ~52MB | English |
| `granite-97m-multilingual` | `onnx-community/granite-embedding-97m-multilingual-r2-ONNX` | cls | q8 | 384 | 32768 | ~98MB | 200+ |
| `bge-small-en` | `Xenova/bge-small-en-v1.5` | cls | q8 | 384 | 512 | ~34MB | English |
| `minilm-l6-en` | `Xenova/all-MiniLM-L6-v2` | mean | q8 | 384 | 512 | ~23MB | English |
| `custom` | from `search.vector.model` | from `search.vector.pooling` | from `search.vector.dtype` | probed | varies | varies | varies |

Retrieval scores, as published: `granite-small-en-r2` scores 50.9 on BEIR and 53.9 on MTEB-v2
retrieval; `granite-97m-multilingual` scores 50.1 on English retrieval and 60.3 on MTEB
multilingual retrieval. The English default is therefore marginally stronger at English than the
multilingual model, at roughly half the download.

`minilm-l6-en` is retained as a selectable preset rather than dropped. It is what every existing
repository runs, so removing it would make the current model unnameable in the picker and leave
users unable to return to it after switching away.

Multilingual coverage is opt-in by decision: the default is English-only, and a user who stores
non-English knowledge selects `granite-97m-multilingual`. The Granite model card publishes its 52
enhanced-support languages in a collapsible section:
Albanian, Arabic, Azerbaijani, Bengali, Bulgarian, Catalan, Chinese, Croatian, Czech, Danish,
Dutch, English, Estonian, Finnish, French, Georgian, German, Greek, Hebrew, Hindi, Hungarian,
Icelandic, Indonesian, Italian, Japanese, Kazakh, Khmer, Korean, Latvian, Lithuanian, Malay,
Marathi, Norwegian, Persian, Polish, Portuguese, Romanian, Russian, Serbian, Slovak, Slovenian,
Spanish, Swahili, Swedish, Tagalog, Telugu, Thai, Turkish, Ukrainian, Urdu, Uzbek and Vietnamese.

All three built-in presets produce 384-dimension vectors and have a `model_quantized.onnx` (q8)
file, verified against their Hugging Face repositories. The stored vector width does not change
between presets, so switching one does not alter the shape of the `vector` column. A separate
`knowledge_embeddings` change is still required for a different reason — see Profile fingerprint.

Pooling differs per model and is the main correctness hazard. MiniLM is the only mean-pooled
preset; `bge-small-en-v1.5` and both Granite R2 models are CLS-pooled — including the new default,
so the very first repository created after this ships would be wrong without the fix.
`src/ai/embeddings.ts`
currently hardcodes `pooling: 'mean'`. Wrong pooling does not raise an error — it silently
produces bad vectors — which is why pooling is bundled with the model rather than left as an
independently-settable key.

### Config resolution

New module `src/core/vector-profile.ts` exports `resolveVectorProfile(config)` returning
`{ provider, model, dtype, pooling }`. Resolution order:

1. `search.vector.preset` names a built-in preset, and its bundle is returned.
2. `search.vector.preset` is `custom`, and the flat `model` / `dtype` / `pooling` keys are used.
3. `search.vector.preset` is absent (an existing config written before this change). The
   configured `model` string is matched against the built-in preset table. A match returns that
   preset's bundle; no match is treated as `custom` with `pooling` defaulting to `mean`.

Case 3 is what keeps existing installs working. A config holding `Xenova/all-MiniLM-L6-v2`
resolves to the `minilm-l6-en` bundle with mean pooling, which is exactly the current behaviour.

### Defaults must not migrate existing repositories

Case 3 only survives if nothing writes a `preset` key into an existing config. It would not.
`upgradeConfigDefaults` calls `mergeConfigDefaults`, which recursively fills in every key whose
current value is `undefined`. An existing config has no `preset` key, so adding the preset to
`DEFAULT_CONFIG` would inject `preset: granite-small-en-r2` into every repository on
`knowl upgrade`. Because a named preset outranks the flat `model` key in resolution order, those
repositories would silently switch models — the exact outcome decision 4 rules out.

The two roles that `DEFAULT_CONFIG` currently serves are therefore split:

- `DEFAULT_CONFIG` stays the merge baseline for upgrades and **does not gain a `preset` key**. Its
  `model` stays `Xenova/all-MiniLM-L6-v2`, so upgrades remain a no-op for vector config.
- A new `NEW_PROJECT_CONFIG` is `DEFAULT_CONFIG` plus `preset: granite-small-en-r2`, and is
  used only by `knowl init` and by `resetAllConfig`.

Reset is an explicit user action, so resetting to the current recommended default is correct — but
it changes the resolved profile and therefore triggers the same reindex offer as any other change.
The `preset` field's `defaultValue` in `CONFIG_FIELDS` is `granite-small-en-r2` for the same
reason.

`resolveVectorProfile` becomes the single source consumed by `src/ai/embeddings.ts`,
`src/store/write-embedding.ts`, the reindex command, and `knowl doctor`. The rejected alternative
was expanding a preset into flat keys at config-write time, which leaves four independently
editable keys that can drift into an inconsistent combination.

`getVectorSearchConfig` in `src/ai/embeddings.ts` is refactored to delegate to it, so existing
callers keep working.

### Config UI

`search.vector.preset` is added to `CONFIG_FIELDS` in `src/cli/config/schema.ts` as an `enum`
field whose values are the preset ids plus `custom`. The existing interactive UI already renders
`enum` fields as a select list, so the preset picker needs no new field type.

`search.vector.pooling` is added as an `enum` field with values `mean` and `cls`, for custom
models.

Selecting `custom` requires a follow-up prompt for the model name, which the current
`ConfigPrompts` interface cannot express. It gains one optional method for this. Implementations
that do not provide it fall back to the plain string input, which keeps existing tests working.

### Custom model verification

When a custom model name is entered, before the change is added to the save set:

1. **Resolve** — request the model from the Hugging Face model API and confirm it exists.
2. **Require ONNX** — confirm `onnx/model_quantized.onnx` is present in the file list. A repo
   without q8 ONNX weights is rejected with a message naming what was missing.
3. **Detect pooling** — read `1_Pooling/config.json` from the repo and map
   `pooling_mode_cls_token` / `pooling_mode_mean_tokens` to the pooling value. If that file is
   absent, which is common on ONNX mirror repos, prompt the user to choose pooling explicitly.
   It is never silently defaulted, because a wrong default produces bad vectors with no error.
4. **Download** — fetch the q8 weights, reporting progress via the transformers.js
   `progress_callback` option.
5. **Probe** — embed a single token to confirm the model loads, and read the resulting vector
   length as the true dimension count.

A failure at any step re-prompts rather than saving. Config never comes to hold a model name that
has not been shown to work.

**The write must be atomic across keys.** A custom profile is three keys — `preset`, `model` and
`pooling` — but `setConfigValue` loads the config, sets one path and saves. Writing them in
sequence means `preset: custom` can land on disk with no verified model beside it, and any command
running in between resolves a profile that was never checked. `resetConfigValue` has the same
shape and the same problem.

`setConfigValues(root, entries)` is added: it parses and validates every entry first, backs up
once, and performs a single write. Nothing is persisted unless all entries are valid. The
interactive UI already batches its changes until a final confirm, so it moves to this function and
gains atomicity for free across every field, not just these.

For the non-interactive path, `knowl config set search.vector.preset custom` is rejected on its
own, because a bare `custom` is not a complete profile. The error names the alternative:
`knowl config set-model <name>`, a command that runs the same verify-and-download flow and then
commits all three keys through `setConfigValues`. Interactive, non-interactive and reset paths
therefore share one code path for producing a valid profile.

### Profile fingerprint

`knowledge_embeddings` stores only `provider` and `model`, and `searchKnowledgeEmbeddings` filters
on those two. That is not enough to describe when two vectors are comparable. dtype and pooling
both change the numbers a model produces, so after a dtype-only or pooling-only change the old
rows still match the filter and are scored against query vectors from the new profile. The result
is silently wrong rankings rather than an error. This is a pre-existing defect for dtype; making
models easy to switch turns it from a corner case into a routine one.

A `profile_fingerprint TEXT` column is added to `knowledge_embeddings`, holding a hash of
`provider|model|dtype|pooling`. `searchKnowledgeEmbeddings` and `findEmbeddedItemIds` filter on it
instead of on provider and model. Existing rows are backfilled during migration with the
fingerprint computed from the repository's resolved profile at migration time, which is by
definition the profile that produced them.

This one change also resolves the partial-rebuild and declined-rebuild cases without any staging
machinery:

- **Declined reindex.** No stored row carries the new fingerprint, so vector search matches
  nothing and retrieval falls back to BM25. Degraded and clearly reported, never wrong.
- **Interrupted reindex.** Only the rows already rewritten carry the new fingerprint. Search sees
  a smaller corpus, not a mixed one. Re-running the reindex completes it.

`knowl doctor` reports the count of stored rows whose fingerprint does not match the configured
profile, so a half-finished rebuild is visible rather than inferred from poor results.

### Reindex

`reindexKnowledgeEmbeddings` in `src/store/vector-index.ts` changes in three ways:

- It stops going through `queryKnowledgeBase`, which cannot express what reindex needs. Omitting
  `status` there does not mean "all statuses" — it applies `status = 'active'` as a default — and
  it has no cursor or offset, so paging past its limit is impossible. Simply dropping the option
  would silently keep re-embedding active items only.

  A dedicated store function `iterateKnowledgeItemsForIndexing(projectId, { batchSize })` is added
  instead. It performs a keyset scan ordered by id, applies no status predicate at all, and yields
  batches. This also removes the hardcoded `limit: 10_000`, which currently truncates larger stores
  without saying so.
- After the rebuild, embedding rows whose fingerprint does not match the resolved profile are
  deleted. This clears rows belonging to items that no longer exist.

It returns `{ indexed, purged, byStatus }`, where `indexed` and `purged` are totals and `byStatus`
maps each status to its indexed count, so the CLI can report what happened per status.

The upsert path needs no change: `upsertKnowledgeEmbedding` already uses
`ON CONFLICT(knowledge_item_id) DO UPDATE`, so there is one row per item and a reindex replaces
in place rather than accumulating.

### Change detection and the reindex offer

After a config save, the resolved profile from before and after the save are compared. If any of
`provider`, `model`, `dtype` or `pooling` differ, the fingerprint changes and every stored
embedding stops matching, so vector search falls back to BM25 until a reindex runs.

- Interactive `knowl config` prompts to reindex immediately. Declining prints a warning naming
  the number of affected rows and the command to run.
- Non-interactive `knowl config set` prints the same warning without prompting.

Comparing the resolved profile rather than the raw keys means a dtype-only or pooling-only edit
also triggers the offer, and the fingerprint guarantees the store is safe rather than merely
warned about if the user declines.

### Workspaces

A workspace pins one embedding identity in its manifest. `assertEmbeddingCompatible` rejects
`workspace add` and `workspace join` when a repo's identity differs, and `knowl doctor` warns when
a linked repo has drifted, because cross-repo vector fusion compares vectors directly.

Making the model easy to change makes that divergence easy to cause, so two changes are required.

**`embeddingIdentityFromConfig` must resolve through the profile.** It currently reads
`config.search.vector.model` and `.dtype` directly. A config that sets only `preset` has no
`model` key, so it would produce `model: ''` and the compatibility check would compare empty
strings — reporting two genuinely different models as compatible, or blocking a legitimate join.
It is changed to call `resolveVectorProfile` and read the resolved values.

**`EmbeddingIdentity` becomes the fingerprint inputs**, gaining `pooling` alongside provider,
model and dtype, so it describes exactly what the stored fingerprint describes.

**Legacy manifests get a one-time migration, not a wildcard.** Manifests written before this
change have no pooling recorded. Ignoring the field when it is absent would let two repositories
with genuinely incompatible pooling compare as compatible — reintroducing the bug this section
exists to prevent. Instead, the first time a workspace with no recorded pooling is resolved, the
value is derived from the pinned model through the preset table and written back to the manifest.
Every built-in model has a known pooling method, so this resolves cleanly for them. If the pinned
model is not in the table, pooling is recorded as `unknown`, and a manifest holding `unknown`
disables cross-repo vector fusion — federation falls back to BM25 and `knowl doctor` says why —
until the workspace is repinned. Wrong results are never preferable to degraded ones.

**Repinning needs a command.** `manifest.embedding` is assigned only when `manifest.repos.length
=== 0`, so today there is no way to move an established workspace to a different model short of
unlinking every repository. Switching models workspace-wide is now an expected operation, so
`knowl workspace repin-embedding` is added. It rewrites `manifest.embedding` to the current
repository's resolved profile, requires confirmation, and lists every linked repository that must
now run `knowl reindex --vectors`. It does not and cannot reindex peers itself, since they are
separate stores on possibly separate machines; naming them is the deliverable.

The reindex offer additionally checks workspace membership. When the repo belongs to a workspace
and the new profile no longer matches the manifest, the warning says so, names the consequence —
this repo's items and its peers' items become invisible to each other — and points at
`repin-embedding` when the intent is to move the whole workspace.

### Default and discovery

`knowl init` writes `NEW_PROJECT_CONFIG`, defaulting new repositories to `granite-small-en-r2`.
`knowl upgrade` merges against `DEFAULT_CONFIG`, which carries no preset, so it cannot change the
preset of an existing repository. No user gets an unexpected download or a silent change in
retrieval behaviour during an upgrade.

Discovery happens at init, not through a doctor warning. An English-only default is now
deliberate, so a check that flagged English-only presets would fire on every fresh install and
warn users about a choice the project made for them. Instead `knowl init` prints one line naming
the active model and noting that `knowl config` offers a multilingual option. `knowl doctor`
continues to report the active model factually, as it does today, with no warning attached.

`warmEmbeddingModel` already downloads the configured model during init and needs no change
beyond reading the resolved profile.

## Benchmark

The existing suite is kept unchanged as a regression check against ranking breakage. It is the
wrong instrument for judging embeddings, not a broken one.

New `docs/evals/semantic-suite.json`, generated by `scripts/generate-semantic-suite.mjs`.

Cases are short keyword queries against short factual atoms, matching how agents actually query
Knowl — `KNOWL.md` instructs them to use 2-6 concise keywords. Difficulty is tiered, weighted
toward ordinary usage rather than adversarial cases, because stored atoms in real use are
ordinary.

| Tier | Share | Example | Overlap rule |
| --- | --- | --- | --- |
| Basic | ~65% | Atom "PostgreSQL 16 is the primary transactional datastore", query `main database engine` | Partial overlap allowed |
| Moderate | ~25% | Atom "rows are flagged `deleted_at`, never removed", query `soft delete behaviour` | Low overlap, not forced to zero |
| Extreme | ~10% | Zero shared words, plus a decoy sharing words with the query but meaning something else | Zero overlap, generator-enforced |

Target size is 100-120 cases, so roughly a dozen fall in the extreme tier.

Two properties guard against building a broken instrument:

- **Lexical-is-correct controls.** Some cases must have the literally-matching item be the correct
  answer, placed in other cases' `mustNotReturn`. Without them the suite would reward ignoring
  keywords, which repeats the freshness one-sidedness defect in reverse.
- **A BM25-only floor row.** If BM25 alone matches the embedding models across every tier, the
  suite is not discriminating and that must be visible rather than hidden.

The fixture format carries an optional `lang` field, unused for now, so multilingual cases can be
added later without changing the schema or the runner.

`scripts/benchmark-embedding-models.mjs` runs the suite against each preset in turn — download,
reindex into a temporary store, evaluate, tear down — and prints one table with Recall@3,
Recall@10, MRR, nDCG and embedding latency, broken out per tier plus overall.

The basic tier is the deciding column, since it predicts day-to-day quality. The extreme tier is
a stress signal; a model that wins there while losing on basic is the wrong choice.

This script is run on demand and not in CI, because it downloads roughly 207MB of weights across
the four presets.

Because the default preset is English-only and the suite is English-only, the benchmark measures
the default directly rather than a model most users will not run.

## Testing

- `resolveVectorProfile`: each built-in preset, `custom`, and the absent-preset backward
  compatibility path including the model-string match.
- Pooling reaches the transformers.js pipeline call. This is the regression that would silently
  wreck retrieval quality with no visible error.
- `mergeConfigDefaults` applied to a config written before this change produces no `preset` key,
  so `knowl upgrade` cannot migrate an existing repository onto a different model.
- Reindex covers non-active statuses, purges rows whose fingerprint does not match, and pages past
  10,000 items. A store containing items in several statuses ends with every one embedded.
- The fingerprint filter: a dtype-only change and a pooling-only change each make stored rows stop
  matching, rather than being scored against the new profile's query vectors.
- An interrupted reindex leaves a smaller searchable corpus, never a mixed one — assert that
  partially rewritten rows are the only ones returned.
- `setConfigValues` persists nothing when any entry fails validation.
- `knowl config set search.vector.preset custom` is rejected on its own.
- Legacy-manifest pooling migration: a manifest pinned to a built-in model gains the correct
  pooling; one pinned to an unrecognized model records `unknown` and disables cross-repo vector
  fusion rather than comparing as compatible.
- Profile-change detection fires for each of `provider`, `model`, `dtype`, `pooling`, and does not
  fire for unrelated config edits.
- `embeddingIdentityFromConfig` returns the resolved model for a preset-only config, rather than
  the empty string, and the workspace compatibility check behaves correctly for two configs that
  select the same model through different routes (preset versus explicit `model`).
- Custom model verification rejects a non-existent model and an ONNX-less repo, and prompts for
  pooling when `1_Pooling/config.json` is absent. Network calls are mocked; no test hits the
  network.
- The semantic suite generator throws when an extreme-tier case has any content-word overlap.

Tests that require model weights stay gated on the existing `.knowl/models` cache convention,
because CI has no model cache.

## Risks

**Non-English knowledge retrieves poorly unless the user changes a setting.** The English-only
default was chosen deliberately, after the consequence was raised. It means the original complaint
that started this work — that the embedding model only handles English — remains true of the
out-of-box experience. What changes is that a fix now exists and takes one selection, where before
it required hand-editing config and knowing which model to name. The init line naming the
multilingual option is the only thing standing between a non-English user and a silent quality
problem, so its wording matters more than its placement suggests.

**The multilingual preset is not verified by our own measurement.** The benchmark is English-only
by decision, so `granite-97m-multilingual` is selected on published scores (MTEB multilingual
retrieval 60.3, against 50.9 for multilingual-e5-small) rather than on anything measured here. The
`lang` field exists so this gap can be closed later. The English default is not affected, since
the benchmark measures it directly.

**Published scores are not our data.** The preset ranking comes from MTEB and BEIR, measured on
other corpora. The benchmark exists precisely so the choice can be checked against Knowl's own
content rather than taken on faith. If it shows the default losing to `bge-small-en` or even to
`minilm-l6-en` on Knowl-shaped content, the default should change.

**Download size grows.** The default model cache goes from roughly 23MB to 52MB for new
repositories. It lives in the gitignored `.knowl/models` directory and is never committed.
