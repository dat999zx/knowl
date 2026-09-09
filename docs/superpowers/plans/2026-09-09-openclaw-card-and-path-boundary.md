# Plan: OpenClaw card delivery + workspace path boundary

Spec: `docs/superpowers/specs/2026-09-09-openclaw-card-and-path-boundary.md`. Read it first.
Branch `fix/openclaw-card-and-path`, baseline `8e16c55`. Two commits, one per finding, tests
first in each.

## Task 1 — N2: the session-start card must reach the model

**Test first.** In `tests/integrations/openclaw/hooks.test.ts`, inside the existing
`describe('OpenClaw hooks: recall card')`, add:

```
it('session_start does not spend the card: the first before_prompt_build after it still carries context', ...)
```
- `knowl init --yes` a scratch dir (copy the pattern at `:63`), write the no-fleet config (`:67-69`).
- `register(api)`, get `session_start` and `before_prompt_build` handlers.
- `ctx = { workspaceDir: dir, sessionId: 'oc-n2-1', sessionKey: 'main' }`.
- `await sessionStart({}, ctx)` then `const r = await promptHook({ prompt: 'hi' }, ctx)`.
- Assert `r?.prependContext` is a non-empty string.

Run it. It must FAIL with length 0 on the baseline. If it passes, stop — the premise is wrong.

**Profile test.** In `tests/cli/hosts/` add or extend an openclaw profile test (mirror
`hermes-profile.test.ts:11,36`):
- `openclawProfile.normalizedEvent('session_start')` → `undefined`
- `OPENCLAW_PLUGIN_EVENTS` does not contain `'session_start'`
- `openclawProfile.normalizedEvent('before_prompt_build')` → `'turn-start'` (unchanged)

**Fix.**
- `src/session/hosts/openclaw.ts`: delete the `session_start: 'session-start'` line from
  `OPENCLAW_EVENT_MAP`. Replace the `session_start` paragraph in the docblock (lines 29-30) with a
  paragraph in the shape of `hermes.ts:9-16`: it is absent on purpose, why, and that warming still
  happens in the plugin.
- `integrations/openclaw/src/index.ts:452-477`: the `session_start` handler becomes
  `warmWorkspace` only. Delete `raw`, `payload`, `normalized`, and the `withDeadline(...)` call.
  Rewrite the comment above it: warms the handle so the first gate is not a cold open; does NOT
  touch the lifecycle because OpenClaw discards this hook's return and the card would be lost —
  the first `before_prompt_build` binds the session and carries it.
- `integrations/openclaw/README.md:79`: the table row for `session_start` should say "warm" not
  "bind".

Run: the new test, the profile test, the whole `tests/integrations/openclaw/` dir, and
`tests/cli/openclaw-adapter.test.ts`. All green.

Commit: `fix(openclaw): the session-start card must reach the model`

## Task 2 — N1: a workspace is a path, not a prefix

**Test first.** In `tests/integrations/openclaw/engine.test.ts`, add:

```
it('getHandle does not let a sibling directory that shares a prefix capture the lookup', ...)
```
- Create `<scratch>/knowl` and `<scratch>/knowl-cloud`, `knowl init --yes` both.
- `manager.warmWorkspace('<scratch>/knowl')`.
- `const h = await manager.getHandle('<scratch>/knowl-cloud')`.
- Assert `h?.projectRoot` equals `<scratch>/knowl-cloud` (normalise with `path.resolve` on both
  sides; the engine returns whatever `openProject` resolved).
- Also assert `getHandle('<scratch>/knowl/src')` (mkdir it) returns the `<scratch>/knowl` handle —
  nested paths must still hit the cache.
- `releaseAll()` in a `finally`.

Run it. It must FAIL on the baseline (projectRoot will be `<scratch>/knowl`).

**Fix.** In `integrations/openclaw/src/engine.ts`:
- `import path from 'node:path';`
- Add one module-level helper:
  ```ts
  /** True when `cwd` is `root` or somewhere beneath it -- a path boundary, not a string prefix. */
  function isWithin(root: string, cwd: string): boolean {
    const rel = path.relative(root, cwd);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  }
  ```
- `:131` → `.find((h) => isWithin(h.projectRoot, cwd))`
- `:185` → `([root]) => isWithin(root, cwd)`

Run `tests/integrations/openclaw/`. Green.

Commit: `fix(openclaw): a workspace is a path, not a prefix`

## Task 3 — changelog + gate

- `CHANGELOG.md`: under the Unreleased heading (look at how the top of the file is structured
  and match it), one paragraph per fix in the voice of the existing entries — the Hermes entry at
  ~line 194 is the model for the N2 one.
- Full gate: `npm run build && npm run typecheck && npm run lint && npm test`.

Commit: `docs(changelog): the OpenClaw card and the path boundary`
