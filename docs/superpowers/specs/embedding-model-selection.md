# Embedding model selection

## Problem

The default embedding model, `Xenova/all-MiniLM-L6-v2`, is English-only. Non-English text is
split into meaningless sub-word pieces, so semantically equivalent text in other languages lands
far apart in vector space. Synonym and paraphrase matching is also weak. Users cannot change the
model without hand-editing config, and there is no guidance about which model to change it to.

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
4. **Default** — new repositories default to the multilingual preset. Existing repositories are
   left alone and told once by `knowl doctor`.
5. **Reindex scope** — re-embed every status, and purge embedding rows that do not match the
   configured model.

## Design

### Presets

| Preset id | Model | Pooling | dtype | Dims | Size | Languages |
| --- | --- | --- | --- | --- | --- | --- |
| `minilm-l6-en` | `Xenova/all-MiniLM-L6-v2` | mean | q8 | 384 | ~23MB | English |
| `bge-small-en` | `Xenova/bge-small-en-v1.5` | cls | q8 | 384 | ~34MB | English |
| `granite-97m-multilingual` | `onnx-community/granite-embedding-97m-multilingual-r2-ONNX` | cls | q8 | 384 | ~98MB | 200+ |
| `custom` | from `search.vector.model` | from `search.vector.pooling` | from `search.vector.dtype` | probed | varies | varies |

All three built-in presets produce 384-dimension vectors and have a `model_quantized.onnx` (q8)
file, verified against their Hugging Face repositories. No `knowledge_embeddings` schema change is
needed and the stored vector width does not change between presets.

Pooling differs per model and is the main correctness hazard. MiniLM is mean-pooled; both
`bge-small-en-v1.5` and `granite-97m-multilingual-r2` are CLS-pooled. `src/ai/embeddings.ts`
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
No existing repository changes behaviour and none needs a reindex as a result of this change.

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

### Reindex

`reindexKnowledgeEmbeddings` in `src/store/vector-index.ts` changes in three ways:

- The `status: 'active'` filter is dropped, so items in every status are re-embedded. Non-active
  items are reachable through the `status` filter on queries, so leaving them on an old model
  makes them permanently invisible to vector search.
- After the rebuild, embedding rows whose `provider` and `model` do not match the resolved profile
  are deleted. This clears rows belonging to items that no longer exist.
- The hardcoded `limit: 10_000` becomes batched paging. A store larger than that currently
  truncates silently.

It returns `{ indexed, purged, byStatus }`, where `indexed` and `purged` are totals and `byStatus`
maps each status to its indexed count, so the CLI can report what happened per status.

The upsert path needs no change: `upsertKnowledgeEmbedding` already uses
`ON CONFLICT(knowledge_item_id) DO UPDATE`, so there is one row per item and a reindex replaces
in place rather than accumulating.

### Change detection and the reindex offer

After a config save, the resolved profile from before and after the save are compared. If any of
`provider`, `model`, `dtype` or `pooling` differ, every stored embedding is unusable, because
`searchKnowledgeEmbeddings` filters on provider and model.

- Interactive `knowl config` prompts to reindex immediately. Declining prints a warning naming
  the number of affected rows and the command to run.
- Non-interactive `knowl config set` prints the same warning without prompting.

Comparing the resolved profile rather than the raw keys means a pooling-only edit on a custom
model also triggers the offer. Pooling is not stored in `knowledge_embeddings`, so a pooling
change would otherwise leave rows that look valid but were computed differently.

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

**`EmbeddingIdentity` gains `pooling`.** Two repos on the same model and dtype but different
pooling produce vectors that are not comparable, and pooling is not stored in
`knowledge_embeddings`. Manifests written before this change have no pooling recorded; the field
is ignored when comparing against such a manifest, so existing workspaces keep working rather than
failing on a field that was never written.

The reindex offer additionally checks workspace membership. When the repo belongs to a workspace
and the new profile no longer matches the manifest, the warning says so and names the consequence:
this repo's items and its peers' items become invisible to each other until the profiles are
aligned.

### Default and discovery

`knowl init` defaults new repositories to `granite-97m-multilingual`. `knowl upgrade` does not
change the preset of an existing repository, so no user gets an unexpected 98MB download or a
silent change in retrieval behaviour during an upgrade.

`knowl doctor` gains a non-failing notice, shown when the resolved preset is English-only, that
names the current model and points at `knowl config`.

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

This script is run on demand and not in CI, because it downloads roughly 155MB of weights across
the three presets.

## Testing

- `resolveVectorProfile`: each built-in preset, `custom`, and the absent-preset backward
  compatibility path including the model-string match.
- Pooling reaches the transformers.js pipeline call. This is the regression that would silently
  wreck retrieval quality with no visible error.
- Reindex covers non-active statuses, purges rows not matching the configured model, and pages
  past 10,000 items.
- Profile-change detection fires for each of `provider`, `model`, `dtype`, `pooling`, and does not
  fire for unrelated config edits.
- `embeddingIdentityFromConfig` returns the resolved model for a preset-only config, rather than
  the empty string, and the workspace compatibility check behaves correctly for two configs that
  select the same model through different routes (preset versus explicit `model`).
- A manifest with no recorded pooling still compares as compatible.
- Custom model verification rejects a non-existent model and an ONNX-less repo, and prompts for
  pooling when `1_Pooling/config.json` is absent. Network calls are mocked; no test hits the
  network.
- The semantic suite generator throws when an extreme-tier case has any content-word overlap.

Tests that require model weights stay gated on the existing `.knowl/models` cache convention,
because CI has no model cache.

## Risks

**The multilingual improvement is not verified by our own measurement.** The benchmark was scoped
to English semantic cases by explicit decision. It will demonstrate the synonym and paraphrase
improvement, but the multilingual claim rests on published benchmark scores
(MTEB Multilingual retrieval: granite-97m 60.3 against multilingual-e5-small 50.9) rather than on
anything measured here. The current default is absent from that comparison because an
English-only model has no meaningful multilingual retrieval score. The `lang` field exists so this
gap can be closed later.

**Granite's enhanced-language list is unconfirmed.** IBM documents 200+ supported languages with
52 receiving enhanced training, but the list of 52 is not published in the model card, the GitHub
repository, or the launch post. Whether any particular language is in the enhanced tier is
unknown.

**Published scores are not our data.** The preset ranking comes from MTEB, measured on other
corpora. The benchmark exists precisely so the choice can be checked against Knowl's own content
rather than taken on faith.

**Download size grows.** The default model cache goes from roughly 23MB to 98MB for new
repositories. It lives in the gitignored `.knowl/models` directory and is never committed.
