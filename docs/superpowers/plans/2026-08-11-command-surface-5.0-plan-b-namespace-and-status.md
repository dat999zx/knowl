# Command Surface 5.0 — Plan B: Namespace and Status

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every cloud verb lives under `knowl cloud`, `publish` becomes `stage`, and `knowl cloud status` answers "am I signed in, what is queued, and what is it waiting for" without a network call.

**Architecture:** Three renames and three behaviour changes, all in the CLI layer plus two small additions below it. `CloudApi` gains `me()`; `CloudCredential` gains a cached identity written at login. `runLogin` reads the credential before starting device auth. `runConnect`'s existing `ambiguous` result becomes a `@clack/prompts` picker. `CloudStatus` grows identity, sync detail and a staged split that Plan A's `stage_state` made expressible.

**Tech Stack:** TypeScript (ESM, Node ≥22), Commander 14, `@clack/prompts` (already a dependency), Vitest. **No new runtime dependencies.**

**Spec:** `docs/superpowers/specs/2026-08-11-command-surface-redesign-design.md` §3.1–§3.6, §7. Read §3 and §7 before Task 3.

**Depends on:** Plan A — `unstagePublish` (Task 4) and `PublishedRecord.stageState` (Task 4) are used by Tasks 3 and 5 here.

## Global Constraints

- Node `>=22`. ESM only — relative imports end in `.js`. **No new runtime dependencies.** `@clack/prompts` is already present and is imported lazily (`await import('@clack/prompts')`), matching `src/cli/config/ui.ts:199`.
- Verification is `npm.cmd run build` **then** `npm.cmd test`. Finish with `git diff --check`.
- **Never `initDb`/`closeDb` from anything reachable by a tool call** (`defde27f6f234535`). `cloudStatus` owns the process context; `cloudStatusInRequest` must open and close nothing. The three cases in `tests/cloud/ambient-context.test.ts` must pass unmodified at the end of this plan.
- **Hard break: no aliases.** Removed names are removed. A removed name may exit non-zero with a signpost, which is not an alias because the command still fails.
- **Credentials never enter `.knowl/config.json`** (`src/cloud/credentials.ts:26-33`). The cached identity is credential-adjacent and lives in `knowlHome()/credentials.json`.
- **The MCP status path makes no network call, ever.** Usage is CLI-only.

## File Structure

| File | Responsibility |
| --- | --- |
| `src/cloud/api-client.ts` | Modify: add `me()` and `usage()` to `CloudApi` and its implementation |
| `src/cloud/credentials.ts` | Modify: `CloudCredential` gains `identity?: { email: string; displayName: string }`; add `listCredentialHosts()` |
| `src/cloud/token.ts` | Modify: export `isCredentialUsable`, wrapping the private `usable` rather than copying it |
| `src/cloud/login.ts` | Modify: short-circuit on a usable credential; fetch and cache identity |
| `src/cloud/connect.ts` | Unchanged — its `ambiguous` result is already the picker's input |
| `src/cli/cloud-picker.ts` | Create: the TTY picker and its non-TTY fallback |
| `src/cloud/status.ts` | Modify: `CloudStatus` gains identity, staged split, sync detail and a real disconnected variant; formatter follows |
| `src/cli/cloud-status-view.ts` | Create: the CLI-only view that adds best-effort usage, so `composeStatus` stays offline |
| `src/cli/program.ts` | Modify: extract `buildProgram()`; move/rename commands; add `workspaces`, `unstage`; signposts for removed names |

---

### Task 1: `CloudApi.me()` and the cached identity

**Files:**
- Modify: `src/cloud/api-client.ts:73-97` (the `CloudApi` type) and its implementation object
- Modify: `src/cloud/credentials.ts:6-22` (the `CloudCredential` type)
- Test: `tests/cloud/api-client.test.ts`

**Interfaces:**
- Produces:
  - `type CloudIdentity = { email: string; displayName: string }`
  - `CloudApi.me(accessToken: string): Promise<CloudIdentity>`
  - `CloudCredential.identity?: CloudIdentity`

`GET /v1/me` already exists server-side and returns `{ user: { id, email, displayName }, orgs, workspaces }` (knowl-cloud `packages/contract/src/identity.ts:4-28`). Only the client method is missing.

- [ ] **Step 1: Write the failing test**

Append to `tests/cloud/api-client.test.ts`:

```ts
  it('me() returns the display identity from /v1/me', async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (url: string | URL) => {
      calls.push(String(url));
      return new Response(JSON.stringify({
        user: { id: 'u1', email: 'dev@example.com', displayName: 'Dev' },
        orgs: [],
        workspaces: [],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;

    const { createCloudApi } = await import('../../src/cloud/api-client.js');
    const api = createCloudApi({ apiHost: 'https://api.example.com' });

    expect(await api.me('token-1')).toEqual({ email: 'dev@example.com', displayName: 'Dev' });
    expect(calls[0]).toBe('https://api.example.com/v1/me');
  });

  it('me() surfaces a failure rather than returning a blank identity', async () => {
    globalThis.fetch = (async () => new Response('nope', { status: 401 })) as typeof fetch;

    const { createCloudApi } = await import('../../src/cloud/api-client.js');
    const api = createCloudApi({ apiHost: 'https://api.example.com' });

    await expect(api.me('bad-token')).rejects.toThrow();
  });
```

If `tests/cloud/api-client.test.ts` does not exist, create it with the same `describe`/`beforeEach` scaffolding used by `tests/cloud/publish.test.ts`, restoring `globalThis.fetch` in `afterEach`.

- [ ] **Step 2: Run it and watch it fail**

Run: `npm.cmd test -- tests/cloud/api-client.test.ts`
Expected: FAIL — `api.me is not a function`.

- [ ] **Step 3: Implement**

In `src/cloud/api-client.ts`, add above the `CloudApi` type:

```ts
/** What `knowl cloud status` prints for "signed in as". */
export type CloudIdentity = { email: string; displayName: string };
```

Add to the `CloudApi` type, after `listWorkspaces`:

```ts
  me(accessToken: string): Promise<CloudIdentity>;
```

Add to the returned implementation object, beside `listWorkspaces`:

```ts
    async me(accessToken) {
      // Only the two display fields are kept. `orgs` and `workspaces` come back too, but caching
      // them here would put a second, staler copy of the workspace list beside `listWorkspaces`.
      const { status, body } = await request<{ user: { email: string; displayName: string } }>(
        '/v1/me', { method: 'GET', accessToken },
      );
      if (status !== 200) fail('/v1/me', status, body);
      return { email: body.user.email, displayName: body.user.displayName };
    },
```

**Three details this snippet gets right that an earlier draft did not**, all of them non-negotiable because `request` is shared:

- `request` returns `{ status, body }`, not the body (`src/cloud/api-client.ts:128-131`). Destructure it.
- `method` is **required** on the init argument, and `'GET'` is not its default — the type is `{ method: 'GET' | 'POST' | 'PATCH'; ... }`.
- The status check and `fail(...)` are what turn a 401 into a `CloudApiError` carrying the status. Without them a non-200 falls through to `body.user.email` on an empty object and throws `TypeError: Cannot read properties of undefined`. The second test below would still pass — `rejects.toThrow()` catches anything — so the test cannot be relied on to notice; mirror `listWorkspaces` directly above instead.

In `src/cloud/credentials.ts`, add to `CloudCredential` after `sessionId`:

```ts
  /**
   * Cached at login so `knowl cloud status` can say who you are offline.
   *
   * The server sends no user id with the token (see `sessionId` above), and the MCP status path
   * is forbidden from making a network call -- so a value not captured at login is a value no
   * later read can produce. Optional because a credential written by 4.x has none, and status
   * says "identity unknown" rather than inventing one.
   */
  identity?: { email: string; displayName: string };
```

- [ ] **Step 4: Run it and watch it pass**

Run: `npm.cmd test -- tests/cloud/api-client.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cloud/api-client.ts src/cloud/credentials.ts tests/cloud/api-client.test.ts
git commit -m "feat(cloud): fetch and store the display identity the server already exposes"
```

---

### Task 2: `login` stops re-authenticating a signed-in user

**Files:**
- Modify: `src/cloud/login.ts` — `runLogin` (currently starts device auth at line 54)
- Test: `tests/cloud/login.test.ts`

**Interfaces:**
- Consumes: `CloudApi.me`, `CloudCredential.identity` (Task 1)
- Produces: `runLogin` result gains `'already-signed-in'`:
  ```ts
  type LoginResult =
    | { status: 'signed-in'; identity: CloudIdentity | null }
    | { status: 'already-signed-in'; identity: CloudIdentity | null }
    | { status: 'expired' };
  ```
  and `RunLoginInput` gains `force?: boolean`

- [ ] **Step 1: Write the failing test**

Append to `tests/cloud/login.test.ts`:

```ts
  it('does not start device auth when a usable credential is already stored', async () => {
    const { writeCredential } = await import('../../src/cloud/credentials.js');
    await writeCredential('https://api.example.com', {
      accessToken: 'a', refreshToken: 'r',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      sessionId: 's1',
      identity: { email: 'dev@example.com', displayName: 'Dev' },
    });

    let started = 0;
    const api = {
      startDeviceAuthorization: async () => { started += 1; throw new Error('must not be called'); },
    } as any;

    const { runLogin } = await import('../../src/cloud/login.js');
    const result = await runLogin({ apiHost: 'https://api.example.com', api, onPrompt: () => {} });

    expect(result.status).toBe('already-signed-in');
    expect(result.identity?.email).toBe('dev@example.com');
    expect(started).toBe(0);
  });

  it('re-authenticates anyway when force is set', async () => {
    const { writeCredential } = await import('../../src/cloud/credentials.js');
    await writeCredential('https://api.example.com', {
      accessToken: 'a', refreshToken: 'r',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      sessionId: 's1',
    });

    let started = 0;
    const api = {
      startDeviceAuthorization: async () => {
        started += 1;
        return { deviceCode: 'd', userCode: 'U-1', verificationUri: null, interval: 0, expiresIn: 60 };
      },
      pollForToken: async () => ({
        accessToken: 'a2', refreshToken: 'r2',
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(), sessionId: 's2',
      }),
      me: async () => ({ email: 'dev@example.com', displayName: 'Dev' }),
    } as any;

    const { runLogin } = await import('../../src/cloud/login.js');
    const result = await runLogin({ apiHost: 'https://api.example.com', api, onPrompt: () => {}, force: true });

    expect(result.status).toBe('signed-in');
    expect(started).toBe(1);
  });

  it('an expired stored credential does not short-circuit', async () => {
    const { writeCredential } = await import('../../src/cloud/credentials.js');
    await writeCredential('https://api.example.com', {
      accessToken: 'a', refreshToken: 'r',
      expiresAt: new Date(Date.now() - 1_000).toISOString(),
      sessionId: 's1',
    });

    let started = 0;
    const api = {
      startDeviceAuthorization: async () => {
        started += 1;
        return { deviceCode: 'd', userCode: 'U-1', verificationUri: null, interval: 0, expiresIn: 60 };
      },
      pollForToken: async () => ({
        accessToken: 'a2', refreshToken: 'r2',
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(), sessionId: 's2',
      }),
      me: async () => ({ email: 'dev@example.com', displayName: 'Dev' }),
    } as any;

    const { runLogin } = await import('../../src/cloud/login.js');
    expect((await runLogin({ apiHost: 'https://api.example.com', api, onPrompt: () => {} })).status)
      .toBe('signed-in');
    expect(started).toBe(1);
  });
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm.cmd test -- tests/cloud/login.test.ts`
Expected: FAIL — device authorization is started regardless, so the first case throws `must not be called`.

- [ ] **Step 3: Implement**

In `src/cloud/login.ts`, at the top of `runLogin`, before the existing `startDeviceAuthorization` call:

```ts
  // Read before spending a round trip and a browser trip. The old flow called
  // `startDeviceAuthorization` unconditionally and only reached `readCredential` afterwards, so a
  // signed-in user with an unexpired token was sent through the full device-code dance again.
  if (!input.force) {
    const existing = await readCredential(input.apiHost);
    if (existing && usable(existing)) {
      return { status: 'already-signed-in', identity: existing.identity ?? null };
    }
  }
```

**`usable` is not in `login.ts` and takes three arguments.** It lives in `src/cloud/token.ts:35` as a module-private `usable(credential, now, skewMs)` — the refresh path's expiry test. Do not duplicate the skew-window logic; export a wrapper from `token.ts` beside it, so both callers share one definition of "this token is still good":

```ts
/**
 * Is this credential still usable, on the same terms the refresh path applies?
 *
 * Exported for `runLogin`'s short-circuit. A second copy of this comparison in `login.ts` is
 * how the two would drift: the skew window is the whole subtlety, and a login that judged a
 * token good while `ensureAccessToken` judged it stale would short-circuit into a command
 * that immediately refreshed anyway.
 */
export function isCredentialUsable(
  credential: CloudCredential | null,
  now: number = Date.now(),
  skewMs: number = DEFAULT_SKEW_MS,
): boolean {
  return usable(credential, now, skewMs);
}
```

and in `login.ts`, `import { isCredentialUsable } from './token.js';`, then `if (existing && isCredentialUsable(existing))`.

After a successful `pollForToken`, before writing the credential:

```ts
      // Best-effort: a login that cannot fetch a display name has still signed the user in, and
      // failing here would turn a working login into an error for a cosmetic field. Status reports
      // "identity unknown" in that case.
      const identity = await api.me(credential.accessToken).catch(() => null);
      await writeCredential(input.apiHost, identity ? { ...credential, identity } : credential);
```

Replace the existing `writeCredential` call with the two lines above. Add `force?: boolean` to the input type.

- [ ] **Step 4: Run it and watch it pass**

Run: `npm.cmd test -- tests/cloud/login.test.ts`
Expected: PASS, including the pre-existing cases in the file.

- [ ] **Step 5: Commit**

```bash
git add src/cloud/login.ts tests/cloud/login.test.ts
git commit -m "fix(cloud): stop re-running device auth for a user who is already signed in"
```

---

### Task 3: The workspace picker

**Files:**
- Create: `src/cli/cloud-picker.ts`
- Test: `tests/cli/cloud-picker.test.ts`

**Interfaces:**
- Consumes: `CloudWorkspace` from `src/cloud/api-client.ts`
- Produces: `pickWorkspace(workspaces: CloudWorkspace[], io?: { isTTY?: boolean }): Promise<string | null>` — the chosen id, or `null` when cancelled or when there is no TTY

`runConnect` is **not** modified. Its `ambiguous` result already carries the full list; this task builds the thing that consumes it, and Task 4 wires them together.

- [ ] **Step 1: Write the failing test**

Create `tests/cli/cloud-picker.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';

const WORKSPACES = [
  { id: 'ws-1', name: 'Acme Core', role: 'owner' },
  { id: 'ws-2', name: 'Acme Research', role: 'member' },
] as any;

describe('pickWorkspace', () => {
  afterEach(() => { vi.resetModules(); vi.restoreAllMocks(); });

  it('returns null without prompting when there is no TTY', async () => {
    vi.doMock('@clack/prompts', () => ({
      select: async () => { throw new Error('must not prompt without a TTY'); },
      isCancel: () => false,
    }));

    const { pickWorkspace } = await import('../../src/cli/cloud-picker.js');
    expect(await pickWorkspace(WORKSPACES, { isTTY: false })).toBeNull();
  });

  it('returns the chosen id', async () => {
    vi.doMock('@clack/prompts', () => ({
      select: async () => 'ws-2',
      isCancel: () => false,
    }));

    const { pickWorkspace } = await import('../../src/cli/cloud-picker.js');
    expect(await pickWorkspace(WORKSPACES, { isTTY: true })).toBe('ws-2');
  });

  it('returns null when the user cancels', async () => {
    const CANCEL = Symbol('cancel');
    vi.doMock('@clack/prompts', () => ({
      select: async () => CANCEL,
      isCancel: (value: unknown) => value === CANCEL,
    }));

    const { pickWorkspace } = await import('../../src/cli/cloud-picker.js');
    expect(await pickWorkspace(WORKSPACES, { isTTY: true })).toBeNull();
  });

  it('labels each option with its role', async () => {
    let options: any[] = [];
    vi.doMock('@clack/prompts', () => ({
      select: async (input: any) => { options = input.options; return 'ws-1'; },
      isCancel: () => false,
    }));

    const { pickWorkspace } = await import('../../src/cli/cloud-picker.js');
    await pickWorkspace(WORKSPACES, { isTTY: true });

    expect(options).toEqual([
      { value: 'ws-1', label: 'Acme Core', hint: 'owner' },
      { value: 'ws-2', label: 'Acme Research', hint: 'member' },
    ]);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm.cmd test -- tests/cli/cloud-picker.test.ts`
Expected: FAIL — cannot resolve `../../src/cli/cloud-picker.js`.

- [ ] **Step 3: Implement**

Create `src/cli/cloud-picker.ts`:

```ts
import type { CloudWorkspace } from '../cloud/api-client.js';

/**
 * Choose a workspace from the list `runConnect` already fetched.
 *
 * Returns null rather than throwing on both "no TTY" and "cancelled", because the caller's
 * remedy is the same in both cases: print the list and exit non-zero, which is exactly what
 * `connect` did before this existed. A picker that blocked in CI would be worse than the error
 * it replaces.
 */
export async function pickWorkspace(
  workspaces: CloudWorkspace[],
  io: { isTTY?: boolean } = {},
): Promise<string | null> {
  const isTTY = io.isTTY ?? Boolean(process.stdin.isTTY && process.stdout.isTTY);
  if (!isTTY) return null;

  // Lazily, matching `src/cli/config/ui.ts` -- the prompt library is only reachable from
  // interactive paths and must not be paid for by `knowl serve`.
  const clack = await import('@clack/prompts');
  const chosen = await clack.select({
    message: 'Which workspace should this repository publish to?',
    options: workspaces.map(workspace => ({
      value: workspace.id,
      label: workspace.name,
      hint: workspace.role,
    })),
  });

  return clack.isCancel(chosen) ? null : String(chosen);
}
```

If `CloudWorkspace` has no `role` field, use the fields it does have and drop `hint` — read the type in `src/cloud/api-client.ts` rather than assuming, and update the fourth test to match.

- [ ] **Step 4: Run it and watch it pass**

Run: `npm.cmd test -- tests/cli/cloud-picker.test.ts`
Expected: PASS, all four cases.

- [ ] **Step 5: Commit**

```bash
git add src/cli/cloud-picker.ts tests/cli/cloud-picker.test.ts
git commit -m "feat(cli): a workspace picker that declines rather than blocks without a TTY"
```

---

### Task 4: Move every cloud verb under `knowl cloud`

**Files:**
- Modify: `src/cli/program.ts` — remove top-level `login` (624), `logout` (653), `publish` (662); add them plus `workspaces`, `unstage` and `stage` under `cloudCommand` (698); wire the picker into `connect` (700)
- Test: `tests/cli/cloud-commands.test.ts`

**Interfaces:**
- Consumes: `pickWorkspace` (Task 3), `runLogin` with `force` (Task 2), `unstagePublish` (Plan A Task 4)
- Produces: the command tree
  ```
  knowl cloud login [--api <host>] [--force]
  knowl cloud logout [--api <host>]
  knowl cloud workspaces [--api <host>]
  knowl cloud connect [--api <host>] [--workspace <id>] [--remote <name>]
  knowl cloud stage [--id <ids...>] [--category <list>] [--apply]
  knowl cloud unstage <id> [--forever]
  knowl cloud push / pull / retract <id> / status
  ```

- [ ] **Step 1: Extract `buildProgram()` first, as a refactor with no behaviour change**

`src/cli/program.ts` has **no factory**. It builds at import time at module scope — `const cloudCommand = program.command('cloud')…` at line 698, `const workspaceCommand = …` at 873, and so on for every group. A test that asserts the command tree needs a fresh instance, and three test files across this plan and Plan D need one.

Wrap the construction in `export function buildProgram(): Command`, returning the built root. Keep the existing module-level export so `src/index.ts` is untouched:

```ts
export const program = buildProgram();
```

Commit this on its own, before any command moves:

```bash
npm.cmd run build && node dist/index.js --help   # identical output to before
git add src/cli/program.ts
git commit -m "refactor(cli): build the program in a factory so the tree can be asserted"
```

Do not proceed until `--help` renders exactly as it did before. This step is a pure move; if the output changed, something was reordered.

- [ ] **Step 2: Write the failing test**

Create `tests/cli/cloud-commands.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { buildProgram } from '../../src/cli/program.js';

/**
 * `help` is filtered out on purpose. Whether Commander materialises an implicit help subcommand
 * inside `.commands` is a version-dependent implementation detail, and pinning it here would
 * make this file fail on a Commander bump that changed nothing about our command tree.
 */
function subcommandNames(path: string[]): string[] {
  let node: any = buildProgram();
  for (const name of path) node = node.commands.find((c: any) => c.name() === name);
  return node.commands.map((c: any) => c.name()).filter((n: string) => n !== 'help').sort();
}

describe('the 5.0 cloud namespace', () => {
  it('holds every cloud verb', () => {
    expect(subcommandNames(['cloud'])).toEqual([
      'connect', 'login', 'logout', 'pull', 'push',
      'retract', 'stage', 'status', 'unstage', 'workspaces',
    ]);
  });

  /**
   * Help output, not `.commands`.
   *
   * The signposts below register `login`, `logout` and `publish` as HIDDEN top-level commands so
   * a removed name can fail with a message that names its replacement. Commander keeps hidden
   * commands in `.commands` — it only omits them from help — so asserting `.commands` does not
   * contain them would contradict Step 4 and could never pass. What the user must not see is the
   * help listing, and that is what this asserts.
   */
  it('lists no cloud verb in top-level help', () => {
    const help = buildProgram().helpInformation();
    for (const gone of ['login', 'logout', 'publish']) {
      expect(help).not.toMatch(new RegExp(`^\\s+${gone}\\b`, 'm'));
    }
  });

  it('still recognises the removed names, so they can signpost instead of saying "unknown command"', () => {
    const top = buildProgram().commands.map((c: any) => c.name());
    for (const gone of ['login', 'logout', 'publish']) expect(top).toContain(gone);
  });

  it('keeps the local workspace group untouched', () => {
    expect(subcommandNames(['workspace'])).toEqual([
      'add', 'demand', 'init', 'join', 'list',
      'promote', 'remove', 'repin-embedding', 'set', 'status',
    ]);
  });
});
```

- [ ] **Step 3: Run it and watch it fail**

Run: `npm.cmd test -- tests/cli/cloud-commands.test.ts`
Expected: FAIL — `stage`, `unstage` and `workspaces` are missing, and top-level help still lists `login`, `logout` and `publish`.

- [ ] **Step 4: Implement**

Move the three top-level command definitions inside the `cloudCommand` group. Mechanically: change `program\n  .command('login')` to `cloudCommand\n  .command('login')` and place it after the `const cloudCommand = ...` line; same for `logout`; rename `publish` to `stage` and move it likewise.

Add `--force` to `login` and pass it through:

```ts
  .option('--force', 'Re-authenticate even if this machine is already signed in')
```

and in its action, before the existing success print:

```ts
      if (result.status === 'already-signed-in') {
        console.log(result.identity
          ? `Already signed in as ${result.identity.displayName} <${result.identity.email}> at ${options.api}.`
          : `Already signed in at ${options.api}. Run with --force to re-authenticate.`);
        return;
      }
```

Wire the picker into `connect`'s `ambiguous` branch, replacing whatever it prints today:

```ts
      if (result.status === 'ambiguous') {
        const chosen = await pickWorkspace(result.workspaces);
        if (!chosen) {
          // No TTY, or the user backed out. Same remedy either way, and the same one this
          // command gave before the picker existed.
          console.error('More than one workspace. Re-run with --workspace <id>:');
          for (const workspace of result.workspaces) {
            console.error(`  ${workspace.id}  ${workspace.name}`);
          }
          process.exit(1);
        }
        // Re-enter with the choice made, rather than duplicating the pointer write here.
        const confirmed = await runConnect({ ...connectInput, workspaceId: chosen });
        return reportConnectResult(confirmed);
      }
```

Extract the existing result-reporting into `reportConnectResult` so both entry paths share it; do not copy the success and failure printing into two places.

Add `workspaces`:

```ts
cloudCommand
  .command('workspaces')
  .description('List the cloud workspaces this machine can reach')
  .option('--api <host>', 'API host (defaults to $KNOWL_API_HOST, else the hosted service)', defaultApiHost())
  .action(async options => {
    try {
      const credential = await readCredential(options.api);
      if (!credential) {
        console.error('Not signed in. Run knowl cloud login first.');
        process.exit(1);
      }
      const workspaces = await createCloudApi({ apiHost: options.api }).listWorkspaces(credential.accessToken);
      if (workspaces.length === 0) {
        console.log('You do not belong to any workspace yet.');
        return;
      }
      for (const workspace of workspaces) console.log(`  ${workspace.id}  ${workspace.name}`);
    } catch (error: any) {
      console.error(`Listing workspaces failed: ${error.message}`);
      process.exit(1);
    }
  });
```

Add `unstage`:

```ts
cloudCommand
  .command('unstage <id>')
  .description('Take an atom out of the push queue. Does not unpublish it')
  .option('--forever', 'Also exclude it, so nothing stages it again automatically')
  .action(async (id, options) => {
    try {
      const root = await findProjectRoot(process.cwd());
      const config = await loadConfig(root);
      if (!config.cloud) {
        console.error('This repository is not connected to a cloud workspace.');
        process.exit(1);
      }
      await initDb(root);
      try {
        const cleared = await unstagePublish(id, config.cloud.workspaceId);
        if (options.forever) await excludeFromPublish(id, 'knowl cloud unstage --forever');
        console.log(cleared ? `Unstaged ${id}.` : `${id} was not staged.`);
        if (options.forever) console.log('It will not be staged again automatically. Naming its id to knowl cloud stage still stages it.');
      } finally {
        await closeDb();
      }
    } catch (error: any) {
      console.error(`Unstage failed: ${error.message}`);
      process.exit(1);
    }
  });
```

Update `stage`'s success line, which currently names the old command:

```ts
      console.log(result.applied
        ? `Staged ${result.items.length} item(s). Run knowl cloud push to send them.`
        : `${result.items.length} item(s) would be staged. Re-run with --apply.`);
```

Add signposts for the three removed names, as top-level commands that fail:

```ts
for (const [gone, replacement] of [
  ['login', 'knowl cloud login'],
  ['logout', 'knowl cloud logout'],
  ['publish', 'knowl cloud stage'],
] as const) {
  program
    .command(gone, { hidden: true })
    .allowUnknownOption()
    .allowExcessArguments()
    .action(() => {
      // Not an alias: this exits non-zero and runs nothing. It exists so the failure names the
      // new command instead of "unknown command", which is the whole cost of a hard break.
      console.error(`knowl ${gone} moved to \`${replacement}\`.`);
      process.exit(1);
    });
}
```

- [ ] **Step 5: Run it and watch it pass**

Run: `npm.cmd test -- tests/cli/cloud-commands.test.ts`
Expected: PASS, all four cases — ten cloud subcommands, no removed name in top-level help, and the hidden signposts still resolvable.

- [ ] **Step 6: Verify the help output renders**

Run: `npm.cmd run build` then `node dist/index.js cloud --help`
Expected: ten subcommands, each with a description. Then `node dist/index.js publish` — expected: `knowl publish moved to \`knowl cloud stage\`.` and exit 1.

This step exists because constraint "Verify CLI UI changes by rendering the output" applies: a command tree that compiles can still render wrongly.

- [ ] **Step 7: Commit**

```bash
git add src/cli/program.ts tests/cli/cloud-commands.test.ts
git commit -m "feat(cli): every cloud verb under knowl cloud, and publish becomes stage"
```

---

### Task 5: Status answers who, what and why

**Files:**
- Modify: `src/cloud/status.ts` — `CloudStatus`, `composeStatus`, `formatCloudStatus`
- Test: `tests/cloud/status.test.ts`

**Interfaces:**
- Consumes: `CloudCredential.identity` (Task 1), `PublishedRecord.stageState` (Plan A Task 4)
- Produces: `CloudStatus` connected variant gains
  ```ts
  identity: { email: string; displayName: string } | null;
  signedIn: boolean;
  tokenExpiresAt: string | null;
  stagedNew: number;
  stagedCorrections: number;
  nextSyncDueAt: string | null;
  ```
- Produces: `CloudStatus` **disconnected** variant stops being `{ connected: false }` alone and gains
  ```ts
  apiHost: string;                 // what defaultApiHost() resolved to
  signedIn: boolean;
  identity: { email: string; displayName: string } | null;
  otherCredentialHosts: number;    // credentials stored for hosts other than apiHost
  ```

**A correction is a staged row that has a `remoteVersion`** — it has been pushed before, so this is an update to something the team already has. Plan A is what makes that distinguishable; before `stage_state`, a pushed-then-restaged row was indistinguishable from a never-pushed one on the columns alone.

**The disconnected variant is required by §7.1.2 and an earlier draft of this plan omitted it.** A disconnected repo has no `config.cloud` and therefore no `apiHost`, while credentials are keyed by host — so status resolves the host exactly as `login` and `logout` already do, via `defaultApiHost()` (`$KNOWL_API_HOST`, else the hosted default), and reports *that* host's credential. If credentials exist for other hosts it names the count and the flag that reaches them. It never guesses between them. Without this, "I ran `knowl login` and status still says nothing" is unanswerable in the one situation where the user most needs an answer.

- [ ] **Step 1: Write the failing test**

Append to `tests/cloud/status.test.ts`:

```ts
  it('splits staged atoms into new and corrections', async () => {
    const { recordPushed, restageForPublish, stageForPublish } = await import('../../src/cloud/ledger.js');
    await stageForPublish(['fresh'], WS, 'main');
    await stageForPublish(['known'], WS, 'main');
    await recordPushed('known', WS, 3);
    await restageForPublish(['known'], WS, 'main');

    const { cloudStatus } = await import('../../src/cloud/status.js');
    const status = await cloudStatus(ROOT, configWithCloud()) as any;

    expect(status.staged).toBe(2);
    expect(status.stagedNew).toBe(1);
    expect(status.stagedCorrections).toBe(1);
  });

  it('reports the signed-in identity from the credential cache, with no network call', async () => {
    const { writeCredential } = await import('../../src/cloud/credentials.js');
    await writeCredential(API_HOST, {
      accessToken: 'a', refreshToken: 'r',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      sessionId: 's', identity: { email: 'dev@example.com', displayName: 'Dev' },
    });
    globalThis.fetch = (async () => { throw new Error('status must not touch the network'); }) as typeof fetch;

    const { cloudStatus } = await import('../../src/cloud/status.js');
    const status = await cloudStatus(ROOT, configWithCloud()) as any;

    expect(status.signedIn).toBe(true);
    expect(status.identity).toEqual({ email: 'dev@example.com', displayName: 'Dev' });
  });

  it('says identity unknown for a credential written before the cache existed', async () => {
    const { writeCredential } = await import('../../src/cloud/credentials.js');
    await writeCredential(API_HOST, {
      accessToken: 'a', refreshToken: 'r',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(), sessionId: 's',
    });

    const { cloudStatus, formatCloudStatus } = await import('../../src/cloud/status.js');
    const status = await cloudStatus(ROOT, configWithCloud());

    expect((status as any).identity).toBeNull();
    expect(formatCloudStatus(status)).toContain('identity unknown');
  });

  it('reports when the next auto-pull is due', async () => {
    const { cloudStatus } = await import('../../src/cloud/status.js');
    const status = await cloudStatus(ROOT, configWithCloud()) as any;
    // Never synced -> due now, not null. "I cannot tell" must not read as "not due".
    expect(status.nextSyncDueAt).not.toBeUndefined();
  });

  it('answers "am I signed in" for a repo that is not connected to anything', async () => {
    const { writeCredential } = await import('../../src/cloud/credentials.js');
    await writeCredential(API_HOST, {
      accessToken: 'a', refreshToken: 'r',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      sessionId: 's', identity: { email: 'dev@example.com', displayName: 'Dev' },
    });

    const { cloudStatus } = await import('../../src/cloud/status.js');
    // No `cloud` block at all -- the repo has never run `knowl cloud connect`.
    const status = await cloudStatus(ROOT, {} as any) as any;

    expect(status.connected).toBe(false);
    expect(status.apiHost).toBe(API_HOST);
    expect(status.signedIn).toBe(true);
    expect(status.identity).toEqual({ email: 'dev@example.com', displayName: 'Dev' });
  });

  it('names how many other hosts hold credentials, without guessing between them', async () => {
    const { writeCredential } = await import('../../src/cloud/credentials.js');
    await writeCredential('https://elsewhere.example.com', {
      accessToken: 'a', refreshToken: 'r',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(), sessionId: 's',
    });

    const { cloudStatus, formatCloudStatus } = await import('../../src/cloud/status.js');
    const status = await cloudStatus(ROOT, {} as any) as any;

    expect(status.signedIn).toBe(false);
    expect(status.otherCredentialHosts).toBe(1);
    // The remedy has to be in the output, or the count is a riddle.
    expect(formatCloudStatus(status)).toContain('--api');
  });
```

`defaultApiHost()` reads `$KNOWL_API_HOST`; set it to `API_HOST` in this file's `beforeEach` (and restore it after) so these two cases do not depend on which build default is compiled in.

Add `API_HOST` and a `configWithCloud()` helper to the file's existing scaffolding if they are not already there, matching the `ProjectConfig` shape the other cases in this file build.

- [ ] **Step 2: Run it and watch it fail**

Run: `npm.cmd test -- tests/cloud/status.test.ts`
Expected: FAIL — `stagedNew`, `identity` and `nextSyncDueAt` are undefined.

- [ ] **Step 3: Implement**

In `src/cloud/status.ts`, extend the connected variant of `CloudStatus` with the six fields above.

In `composeStatus`, derive them:

```ts
  // A staged row that already carries a server version is an update to something the team has.
  const corrections = staged.filter(row => row.remoteVersion !== null).length;

  // Read, never fetched. The MCP path calls this and is forbidden from touching the network.
  const credential = await readCredential(pointer.apiHost).catch(() => null);

  const lastSynced = state?.lastSyncedAt ? Date.parse(state.lastSyncedAt) : null;
```

and add to the returned object:

```ts
    signedIn: Boolean(credential),
    identity: credential?.identity ?? null,
    tokenExpiresAt: credential?.expiresAt ?? null,
    stagedNew: staged.length - corrections,
    stagedCorrections: corrections,
    // Null last-sync means due now rather than unknown, matching `shouldAutoSync`, which treats
    // an absent or unparseable timestamp as due for the same reason: "I cannot tell" must never
    // read as "no need", or a replica silently stops syncing forever.
    nextSyncDueAt: lastSynced === null || Number.isNaN(lastSynced)
      ? new Date().toISOString()
      : new Date(lastSynced + AUTO_SYNC_INTERVAL_MS).toISOString(),
```

Import `AUTO_SYNC_INTERVAL_MS` from `./auto-sync.js` and `readCredential` from `./credentials.js`.

In `formatCloudStatus`, add an identity line above the workspace line:

```ts
  const lines = [
    status.signedIn
      ? `Signed in: ${status.identity
          ? `${status.identity.displayName} <${status.identity.email}>`
          : 'identity unknown — run knowl cloud login'}`
      : 'Signed in: no. Run knowl cloud login.',
    `Workspace: ${status.workspace}${status.role ? ` (you are ${status.role})` : ''}`,
```

and replace the staged line with the split:

```ts
  lines.push(
    `Staged:    ${status.stagedNew} new, ${status.stagedCorrections} correction(s)` +
    `${status.stagedOnBranch ? ` on ${status.stagedOnBranch}` : ''}, not yet sent.`,
  );
```

Apply the same six fields in `cloudStatusInRequest`'s path — it shares `composeStatus`, so this is free, but confirm it by reading the function rather than assuming.

**Then the disconnected branch**, which is the early return `cloudStatus` takes when `config.cloud` is absent. It currently returns `{ connected: false }` and must answer the sign-in question instead:

```ts
  if (!config.cloud) {
    // §7.1.2. Credentials are keyed by host and a disconnected repo names none, so resolve the
    // host the same way `login` and `logout` do rather than inventing one or scanning for a
    // "best" credential. Naming the count of others is the honest middle: enough for the user to
    // know their token is somewhere, without this command picking a host on their behalf.
    const apiHost = defaultApiHost();
    const credential = await readCredential(apiHost).catch(() => null);
    const hosts = await listCredentialHosts().catch(() => [] as string[]);
    return {
      connected: false,
      apiHost,
      signedIn: Boolean(credential),
      identity: credential?.identity ?? null,
      otherCredentialHosts: hosts.filter(host => host !== apiHost).length,
    };
  }
```

`listCredentialHosts()` does not exist yet. Add it to `src/cloud/credentials.ts` beside `readCredential`, returning the keys of the credential file and `[]` when the file is absent or unreadable — the same failure direction `readCredential` already takes. It must **not** return the credentials themselves: this is a count for a status line, and widening it to a list of tokens would put every stored token on a path that only needed to know how many there were.

In `formatCloudStatus`, the disconnected branch gains two lines:

```ts
  // The remedy, not just the diagnosis. A count with no flag attached is a riddle.
  if (status.otherCredentialHosts > 0) {
    lines.push(
      `Signed in to ${status.otherCredentialHosts} other host(s). ` +
      'Reach them with --api <host>.',
    );
  }
```

- [ ] **Step 4: Run it and watch it pass**

Run: `npm.cmd test -- tests/cloud/status.test.ts tests/cloud/ambient-context.test.ts`
Expected: PASS. The ambient-context cases must pass **unmodified** — if one fails, `composeStatus` has acquired a database call that `cloudStatusInRequest` cannot make.

- [ ] **Step 5: Render it**

Run: `npm.cmd run build` then `node dist/index.js cloud status`
Expected: the report renders with a `Signed in:` line. Per the CLI-rendering constraint, read the actual output rather than trusting the test.

- [ ] **Step 6: Commit**

```bash
git add src/cloud/status.ts tests/cloud/status.test.ts
git commit -m "feat(cloud): status says who you are, what is queued, and when sync is due"
```

---

### Task 6: `knowl status` stops ignoring the cloud

**Files:**
- Modify: `src/core/format.ts` — `formatStatusReport`
- Modify: `src/cli/program.ts:385-425` — pass the cloud status in
- Test: `tests/core/format.test.ts`

**Interfaces:**
- Consumes: `CloudStatus` (Task 5)
- Produces: `formatStatusReport` input gains `cloud?: CloudStatus | null`

- [ ] **Step 1: Write the failing test**

Append to `tests/core/format.test.ts`:

```ts
  it('names the cloud workspace and staged count when connected', () => {
    const output = formatStatusReport({
      ...baseStatusInput(),
      cloud: {
        connected: true, workspace: 'Acme Core', role: 'owner',
        lastSyncedAt: null, lastError: null, staged: 3, stagedNew: 2, stagedCorrections: 1,
        stagedOnBranch: 'main', gate: { ok: true, detail: '' },
        signedIn: true, identity: { email: 'd@e.com', displayName: 'Dev' },
        tokenExpiresAt: null, nextSyncDueAt: null,
      } as any,
    });

    expect(output).toContain('Acme Core');
    expect(output).toContain('3');
    expect(output).toContain('knowl cloud status');
  });

  it('says nothing about the cloud when the repo is not connected', () => {
    const output = formatStatusReport({ ...baseStatusInput(), cloud: { connected: false } });
    expect(output).not.toContain('knowl cloud status');
  });
```

`baseStatusInput()` is whatever the existing cases in this file already build; reuse it rather than constructing a new one.

- [ ] **Step 2: Run it and watch it fail**

Run: `npm.cmd test -- tests/core/format.test.ts`
Expected: FAIL — no cloud section is rendered.

- [ ] **Step 3: Implement**

In `src/core/format.ts`, add `cloud?: CloudStatus | null` to the input type and render a two-line section before the commits section:

```ts
  if (context.cloud?.connected) {
    md += '## Cloud\n\n';
    md += `${context.cloud.workspace}, ${context.cloud.staged} staged.\n`;
    md += 'Run `knowl cloud status` for the full picture.\n\n';
  }
```

Two lines and a pointer, deliberately: `knowl status` is already long, and the cloud has its own command. The section is omitted entirely when disconnected so an offline repo gains no noise.

In `src/cli/program.ts`, in the `status` action, pass it:

```ts
        cloud: config.cloud ? await cloudStatus(root, config) : null,
```

`cloudStatus` opens and closes its own database context, and the `status` action already holds one — call it **before** `initDb(root)` or reuse the open context via `cloudStatusInRequest`. Read `defde27f6f234535` and pick deliberately; nesting `initDb`/`closeDb` here is the failure that constraint describes.

- [ ] **Step 4: Run it and watch it pass**

Run: `npm.cmd test -- tests/core/format.test.ts`
Expected: PASS, both cases.

- [ ] **Step 5: Full verification**

```bash
npm.cmd run build
npm.cmd test
node dist/index.js status
node dist/index.js cloud --help
git diff --check
```

Expected: suite green; `knowl status` renders with a Cloud section if this repo is connected and without one if not.

- [ ] **Step 6: Commit**

```bash
git add src/core/format.ts src/cli/program.ts tests/core/format.test.ts
git commit -m "feat(cli): knowl status names the cloud instead of leaving it stranded"
```

---

### Task 7: Usage, on the CLI path only

**Files:**
- Modify: `src/cloud/api-client.ts` — add `usage()`
- Modify: `src/cli/program.ts` — `cloud status` fetches it; nothing else does
- Test: `tests/cloud/api-client.test.ts`, `tests/cloud/status.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type CloudCounter = { used: number; limit: number; enforcement: string };
  export type CloudUsage = {
    plan: string;
    memoryOps: CloudCounter;
    storedAtoms: CloudCounter;
    aiOps: CloudCounter;
  };
  CloudApi.usage(input: { workspaceId: string; accessToken: string }): Promise<CloudUsage>;
  ```

**§7.1.3 requires this and an earlier draft of this plan had no task for it.** The table there is explicit: identity, workspace, staged and sync state come from cache offline on both paths, and **usage** is a best-effort fetch with a short timeout on the CLI path, degrading to `usage: unavailable` — and is **omitted entirely** on the MCP path, because a live tool request must not touch the network. The two reports differ by exactly this one line, and the spec says so.

**The server already serves it.** knowl-cloud registers `GET /:id/usage` at `src/http/routes/governance.ts:51` under the workspaces prefix, responding with `UsageResponse` (`packages/contract/src/governance.ts:84`) — `plan` plus three `{ used, limit, enforcement }` counters. It is deliberately readable by any member down to `reader`, with the contract's own comment explaining why, so no role check is needed on this side.

- [ ] **Step 1: Write the failing test**

```ts
  it('usage() returns the four counters the server sends', async () => {
    globalThis.fetch = (async (url: string | URL) => {
      expect(String(url)).toBe('https://api.example.com/v1/workspaces/ws-1/usage');
      return new Response(JSON.stringify({
        plan: 'team',
        memoryOps: { used: 10, limit: 100, enforcement: 'soft' },
        storedAtoms: { used: 5, limit: 50, enforcement: 'hard' },
        aiOps: { used: 0, limit: 10, enforcement: 'soft' },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;

    const { createCloudApi } = await import('../../src/cloud/api-client.js');
    const usage = await createCloudApi({ apiHost: 'https://api.example.com' })
      .usage({ workspaceId: 'ws-1', accessToken: 't' });

    expect(usage.plan).toBe('team');
    expect(usage.storedAtoms.used).toBe(5);
  });
```

and in `tests/cloud/status.test.ts`, the case that matters more than the happy path:

```ts
  it('a status whose usage fetch fails still reports everything else', async () => {
    globalThis.fetch = (async () => { throw new Error('offline'); }) as typeof fetch;

    const { renderCloudStatusForCli } = await import('../../src/cli/cloud-status-view.js');
    const output = await renderCloudStatusForCli(ROOT, configWithCloud());

    expect(output).toContain('Usage:     unavailable');
    expect(output).toContain('Workspace:');
  });
```

- [ ] **Step 2: Run, fail, implement**

`usage()` mirrors `listWorkspaces` exactly — `const { status, body } = await request<CloudUsage>(...)`, `method: 'GET'`, `if (status !== 200) fail(...)`.

The fetch belongs in the **CLI action, not in `composeStatus`**. `composeStatus` is shared with `cloudStatusInRequest`, and a network call added there would be made by the MCP path too — which is the exact thing §7.1.3 forbids and the ambient-context tests would not catch, because they assert about the database rather than about `fetch`. Put it in a thin `src/cli/cloud-status-view.ts` that calls `cloudStatus`, then:

```ts
  // Best-effort, and short. Usage is the least important line in this report and the only one
  // that can hang; three seconds is long enough for a healthy server and short enough that a
  // dead one does not make `knowl cloud status` feel broken. Every failure -- offline, 403,
  // timeout, a body that does not parse -- lands on the same word, because the user's next
  // action is identical in all of them and naming the cause would imply it were actionable.
  const usage = status.connected
    ? await createCloudApi({ apiHost: pointer.apiHost, timeoutMs: 3_000 })
        .usage({ workspaceId: pointer.workspaceId, accessToken: credential.accessToken })
        .catch(() => null)
    : null;
```

Render `Usage:     unavailable` when it is null, and `Usage:     42/1000 atoms, 10/100 memory ops (team)` when it is not.

- [ ] **Step 3: Prove the MCP path never fetches**

Add to `tests/cloud/ambient-context.test.ts`:

```ts
  it('cloudStatusInRequest makes no network call', async () => {
    globalThis.fetch = (async () => { throw new Error('MCP status must not touch the network'); }) as typeof fetch;
    const { cloudStatusInRequest } = await import('../../src/cloud/status.js');
    await expect(cloudStatusInRequest(ROOT, configWithCloud())).resolves.toBeDefined();
  });
```

This is the assertion that keeps the two reports different on purpose. Without it, the next person to "unify" the two paths reintroduces a network call on a live tool request and nothing fails.

- [ ] **Step 4: Verify and commit**

```bash
npm.cmd run build
npm.cmd test -- tests/cloud/api-client.test.ts tests/cloud/status.test.ts tests/cloud/ambient-context.test.ts
node dist/index.js cloud status
git add src/cloud/api-client.ts src/cli/cloud-status-view.ts src/cli/program.ts tests/cloud/
git commit -m "feat(cloud): status reports usage on the CLI, and never from an MCP request"
```

---

## What Plan B deliberately does not do

- **No auto-staging.** `cloud.autoStage`, the post-commit seam, machine-local auto-push consent and snapshot-bound confirmation are Plan C.
- **No `knowl store --local`.** The flag that writes an exclusion is Plan D; `knowl cloud unstage --forever` (Task 4) is the only writer of `cloud_excluded` until then.
- **No MCP description updates.** `src/mcp/tool-definitions.ts:99` still names `knowl login` after this plan and is corrected in Plan D, which owns the whole rename wave including knowl-cloud's web copy.
