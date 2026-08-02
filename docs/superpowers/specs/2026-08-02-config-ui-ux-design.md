# Interactive config UI: names, pickers, and a way back

Date: 2026-08-02
Status: approved

## Problem

`knowl config` opens a categorized interactive editor. Four things make it feel unfinished, reported by a user trying to change the embedding model.

**1. The embedding model asks you to type it.** Two settings read as "the model":

| Key | Type | Result |
| --- | --- | --- |
| `search.vector.preset` | enum | a picker — the one you want |
| `search.vector.model` | string | a free-text box |

Selecting the setting literally named *model* gives a text box expecting a raw
Hugging Face id. Nothing in the list says the preset is the right entry point.

**2. The picker discards metadata it already has.** `VECTOR_PRESETS`
(`src/core/vector-profile.ts`) carries `label`, `sizeMb` and `languages` for every
preset. The UI lists bare ids: `granite-97m-multilingual`.

**3. There is no way out of a value prompt.** `selectField` offers Back. `inputValue`
offers nothing — no cancel choice on enum and boolean selects, no escape from a text
box. Selecting a setting by accident commits you to entering a value for it.

**4. Three settings silently do nothing.** `resolveVectorProfile` resolves a named
preset before it ever reads the flat keys, so while a preset is set, editing
`search.vector.model`, `.dtype` or `.pooling` writes to disk and changes no behaviour.
The UI offers all three as ordinary editable fields.

Underneath 1–3: every label and prompt is the raw dotted key.
`search.vector.cacheDir: unset` is what the list shows, and `search.vector.dtype` is
the entire question asked when editing it.

## Scope

`src/cli/config/` only — the interactive layer. Reading, writing, validation and
profile resolution are unchanged, as are `knowl config get`, `set` and `reset`.

## Design

### Schema carries presentation

`ConfigField` gains three fields:

- `label` — human name, e.g. `Embedding model`
- `description` — one line explaining what the setting does
- `derivedFrom?: ConfigKey` — the setting that owns this one's value

`derivedFrom: 'search.vector.preset'` is set on `search.vector.model`, `.dtype` and
`.pooling`.

The dotted key stays the identity and stays visible: `knowl config set <key>` is the
scripting interface, and hiding the key entirely would make the UI useless for
discovering it.

### Setting list

Human name first, current value second, dotted key dimmed. A value differing from its
default is marked `modified`; a value owned by a preset says `set by preset`. A value
sitting at its default is marked with nothing, so the marks draw the eye only to what
someone changed.

```
Search
❯ Embedding model        Granite Small English R2 · 52 MB · English
  Semantic search        off                               modified
  Model name             onnx-community/granite-…    set by preset
  Quantization           q8                          set by preset
  Pooling                cls                         set by preset
  Model cache folder     unset
  ← Back
```

### Model picker

Built from `VECTOR_PRESETS`, so the metadata has one home.

```
Embedding model
Which local model produces the vectors. All options are 384-dimension,
so switching never changes the stored vector width.

❯ Granite Small English R2      default · 52 MB · English · 8k context
  Granite 97M Multilingual R2   200+ languages · 98 MB · 32k context
  BGE Small English v1.5        smallest modern English · 34 MB
  MiniLM L6 v2                  historical default · 23 MB
  Custom model…                 enter a Hugging Face id
  ← Back
```

### Cancelling

`ConfigPrompts.inputValue` returns `Promise<string | null>`. `null` abandons the edit
and returns to the setting list, queueing nothing.

Widening the return type is backward compatible: existing implementations return a
string, and the test harness supplies plain string literals.

Every select gets a `← Back` choice. Text inputs cancel on a blank entry, stated in
the prompt.

### Derived fields

Selecting a field whose `derivedFrom` setting is on a named preset does not open an
editor. It explains that the preset owns the value and offers to open the preset
picker instead, so the interaction ends somewhere useful rather than in a refusal.

Choosing the `custom` preset clears the ownership: the three fields become editable,
which is the existing `inputCustomModel` path.

## Testing

Existing `config UI` tests in `tests/cli/config-service.test.ts` must pass unchanged —
they pin the save/cancel/back/re-prompt contract and the one-save custom-preset write.

New cases:

- a view carries `label`, `description` and the dotted `key`
- a derived field is marked while a named preset is set, and unmarked under `custom`
- `inputValue` returning `null` queues no change and returns to the setting list
- the preset picker's choices carry size and language text
- a value differing from its default is marked `modified`, and one at its default is not

## Out of scope

- Colour and terminal styling beyond what `@inquirer/prompts` provides
- Changing which settings exist, their keys, or their validation
- `knowl init` onboarding flow
