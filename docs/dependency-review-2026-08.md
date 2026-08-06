# Dependency review — 2026-08

Taken at `3.1.0`, before the 3.2.0 release. The point is not that anything here is known to be
exploitable; it is not being three majors behind when something is.

## Security position

`npm audit --omit=dev` before the upgrades:

```json
{"info":0,"low":0,"moderate":3,"high":6,"critical":0,"total":9}
```

After:

```json
{"info":0,"low":0,"moderate":2,"high":6,"critical":0,"total":8}
```

The moderate that went away is `@hono/node-server` path traversal on Windows via an encoded
backslash, reached through `@modelcontextprotocol/sdk`; the SDK upgrade carries the fix.

**The six high advisories are one advisory, counted per path.** `adm-zip` allocates 4GB on a
crafted archive (GHSA-xcpc-8h2w-3j85), and it is reached only as
`@huggingface/transformers → onnxruntime-node → adm-zip`. **There is no fix available upstream.**
Knowl's exposure is the model download: a malicious archive served in place of a HuggingFace
model could exhaust memory. It cannot be resolved by upgrading anything Knowl controls, so CI
blocks at `critical` and reports `high` beside it — see the comment in `.github/workflows/ci.yml`.
Re-check when `onnxruntime-node` moves off `adm-zip`.

## What was upgraded

| Package | From | To | Notes |
| --- | --- | --- | --- |
| `@libsql/client` | 0.14.0 | 0.17.4 | Sits under every read and write. Store suite green, 98 files. |
| `@modelcontextprotocol/sdk` | 1.4.1 | 1.30.0 | Clears the `@hono/node-server` advisory. |
| `dotenv` | 16.4.7 | 17.4.2 | **Broke the CLI.** See below. |
| `commander` | 12.1.0 | 14.0.3 | Two majors. Changed excess-argument handling; see below. |

### `dotenv` 17 writes to stdout

dotenv 17 prints `injected env (N) from .env` plus a rotating tip **to stdout** on every
`config()` call. Knowl calls it in `src/index.ts` and `src/cli/program.ts`, so that banner
landed in front of the JSON every machine-readable command emits, and four CLI suites failed
with `Unexpected token '◇'`. Both call sites now pass `{ quiet: true }`.

Worth stating plainly: this is a dependency writing to a channel its consumer had reserved for
data, introduced in a minor-looking major. Only the end-to-end CLI tests could see it — nothing
that imports the modules directly would.

### `commander` 14 rejects excess arguments

Commander now errors on unexpected positionals before the action runs. Two commands rely on
receiving them so they can explain what the user probably meant:

- `knowl config ai.model gpt-4o` → "Use \`knowl config set <key> <value>\`"
- `knowl workspace promote decision,constraint` → the note that cmd.exe split the category list

Both now call `.allowExcessArguments()`, keeping the tailored message instead of commander's
generic arity error.

**`commander` 15 is deliberately not taken.** It requires `node >=22.12.0`, and Knowl declares
`>=22`. Raising the floor is a user-visible constraint change that should be its own decision
with its own release note, not a side effect of a dependency bump. 14 needs `>=20` and is
satisfied by the current floor.

## Deferred: Zod 3 → 4

`zod@4.4.3` is available. This is a migration, not an upgrade, and it is **not** bundled here.

Where it is used — one module, `grep -rn "from 'zod'" src/`:

```
src/ai/schemas.ts
```

That narrowness is the good news and the reason to be careful anyway: `src/ai/schemas.ts`
defines the shapes the optional AI pipeline validates model output against, so a Zod behaviour
change lands on the path that decides whether an extracted atom is well-formed enough to store.
A regression there is a malformed atom accepted or a good one dropped, neither of which raises
an error anyone sees.

What the migration touches: error shapes changed (`.errors` → `.issues` on several paths) and
several APIs were renamed. It needs its own branch, its own read of the upgrade guide, and a
verification run against the pipeline suites — not a line in a release that is already large.

Note that MCP tool arguments are **not** validated by Zod here: `src/mcp/tool-schema.ts` is
hand-rolled against the JSON Schema in `src/mcp/tool-definitions.ts`. That narrows the blast
radius considerably.

## Not upgraded, and why

- `drizzle-orm` 0.45.2 is current; nothing newer to take.
- `commander` 15 — see above.
