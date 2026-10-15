# Domain profiles and providers

Optional AI ingestion (`knowl ingest`, MCP `knowl_ingest`, transcript candidates, `knowl ask`) runs
on prompts. A domain profile is the set of prompts for one kind of knowledge.

## What a profile is, and is not

A profile decides what the filter lets through and how the extractor words an atom. It is not a
capture mechanism: Knowl keeps no transcripts and never captures prompts, and ingestion reads only
text you hand it. It does not add categories either. The seven categories are fixed, and every
profile maps its knowledge onto them.

| Profile | Keeps | Truth derivation |
| --- | --- | --- |
| `code` | decisions, constraints, architecture of a codebase (the prompts shipped before profiles existed, unchanged byte for byte) | on |
| `general` | people, preferences, plans, dates, how-tos | off |
| `academic` | sources, claims, definitions, methods, results, people in the work | off |

The `general` profile keeps personal facts, including health details and family dates. Those live
in the global store, which travels with it if you run `knowl cloud connect --global` (README, 'It
follows you to another machine').

## Selecting one

One config key, read from the config that governs the store being written:

| Store | Config read | Default when `ai.profile` is absent |
| --- | --- | --- |
| Project | `<project>/.knowl/config.json` | `code` |
| Global | `~/.knowl/config.json` | `general` |

```bash
knowl config set ai.profile academic
```

There is no per-call override: no `--profile` flag and no MCP `profile` argument, so an agent cannot
pick a looser filter. `knowl_ingest` takes `namespace: "global"` to write to the machine-wide store.
It then uses the profile from `~/.knowl/config.json`, never the project's. With no project open it
writes to the global store automatically. An unknown or invalid profile fails before any model call.

## Adding your own

Drop one file in `~/.knowl/profiles/`. The file name is the id: lowercase letters, digits and
hyphens. A user profile cannot reuse a built-in id, and profiles are read from the home directory
only, never from a project.

```yaml
# ~/.knowl/profiles/cooking.yaml  (the file name is the id: lowercase letters, digits, hyphens)
filter: |
  You are the input filter for KNOWL ...
extract: |
  You are the core extraction engine for KNOWL ...
```

`filter` and `extract` are required. `ask` defaults to the `general` text. `passDescription` is
optional: it describes the filter's pass/fail field to the model, and without it the code wording
("valid project knowledge") is used, so set it for a non-code domain. Truth derivation is always off
for user profiles. Then `knowl config set ai.profile cooking`.

## Adding a built-in profile

One file in `src/ai/profiles/` exporting a `DomainProfile`, plus one entry in `BUILT_IN` in
`src/ai/profiles/index.ts`. The guard in `tests/ai/domain-profiles.test.ts` fails if the entry is
missing.

## Adding a provider

Anything OpenAI-compatible needs no code: set `ai.provider custom` with `ai.baseUrl` and
`ai.apiKey`. To ship a named provider, add one descriptor file under `src/core/ai-providers/` and
one entry in `ALL` in `index.ts`; the guard in `tests/ai/provider-registry.test.ts` fails if the
entry is missing. Example, not shipped:

```ts
import type { AiProviderDescriptor } from './types.js';

export const groqProvider: AiProviderDescriptor = {
  id: 'groq', sdk: 'openai',
  settings: ({ apiKey, baseUrl }) => ({
    apiKey: apiKey || process.env.GROQ_API_KEY,
    baseURL: baseUrl || 'https://api.groq.com/openai/v1',
  }),
};
```
