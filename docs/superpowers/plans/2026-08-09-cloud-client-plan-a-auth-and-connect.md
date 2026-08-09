# Knowl Cloud Client — Plan A: Authentication and Connect

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A developer can run `knowl login` once, then `knowl cloud connect` in a repo, and `knowl doctor` reports the connection honestly — with no server dependency beyond the already-shipped device-flow endpoints.

**Architecture:** A new `src/cloud/` module holding six focused files: remote-URL identity, a credential store under `knowlHome()`, a cross-process file lock, an HTTP client with injected `fetch`, connect/pointer logic, and doctor checks. Nothing here touches retrieval, the database, or `configuredNamespaces`. Sync, federation and publishing are Plan B.

**Tech Stack:** TypeScript (ESM, Node ≥22), Commander, Vitest, `node:child_process` `spawnSync` for git, global `fetch`. **No new runtime dependencies.**

**Spec:** `docs/superpowers/specs/2026-08-08-cloud-client-design.md` §6, §7, and the client half of §11.

## Global Constraints

- Node `>=22`. ESM only — every relative import ends in `.js`, including from `.ts` sources.
- **No new runtime dependencies.** No keychain module, no lockfile library, no HTTP client. Spec §6 rejects native modules because they break over SSH, in containers and in CI.
- Verification is `npm.cmd run build` **then** `npm.cmd test`, in that order — `npm test` does not build, and twelve test files spawn `node dist/index.js`, so a stale `dist/` passes against code that no longer exists. Finish with `git diff --check`.
- **Credentials never go in `.knowl/config.json`.** That file is deliberately force-committable so a workspace pointer travels with a clone.
- Tests that touch machine-local state set `process.env.KNOWL_HOME` to a repo-relative fixture directory in `beforeEach` and `delete` it in `afterEach`, matching `tests/cli/repo-registry.test.ts`.
- File permissions: `fs.chmod` is applied only when `process.platform !== 'win32'`. On Windows it toggles the read-only bit and nothing else, so claiming 0600 there would be false.
- The command is `knowl cloud connect`, never `knowl workspace connect` — "workspace" already means linked local repos and also `visibility='workspace'`.

---

### Task 1: Git remote identity

Two people cloning the same repo to different paths must resolve to the same identity, because the server keys published atoms on it.

**Files:**
- Create: `src/cloud/repo-identity.ts`
- Test: `tests/cloud/repo-identity.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `normalizeRemoteUrl(url: string): string | null`
  - `resolveRepoIdentity(projectRoot: string, options?: { remote?: string }): RepoIdentity`
  - `type RepoIdentity = { identity: string; remoteName: string; remoteUrl: string; subpath: string | null }`
  - `class NoGitRemoteError extends Error`

- [ ] **Step 1: Write the failing test for URL normalization**

Create `tests/cloud/repo-identity.test.ts`. Import everything the file will eventually need now — Step 5 appends a second `describe` block to this same file, and a duplicate `import path` would be a parse error:

```ts
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  NoGitRemoteError,
  normalizeRemoteUrl,
  resolveRepoIdentity,
} from '../../src/cloud/repo-identity.js';

describe('normalizeRemoteUrl', () => {
  it('collapses every URL form for one repo to one identity', () => {
    // The whole point: two colleagues who cloned differently must publish to the same bucket.
    const expected = 'github.com/acme/web';
    expect(normalizeRemoteUrl('git@github.com:Acme/Web.git')).toBe(expected);
    expect(normalizeRemoteUrl('https://github.com/Acme/Web.git')).toBe(expected);
    expect(normalizeRemoteUrl('https://github.com/Acme/Web')).toBe(expected);
    expect(normalizeRemoteUrl('ssh://git@github.com/Acme/Web.git')).toBe(expected);
    expect(normalizeRemoteUrl('git://github.com/acme/web.git')).toBe(expected);
    expect(normalizeRemoteUrl('https://github.com/acme/web/')).toBe(expected);
  });

  it('strips embedded credentials, which is the one thing that must never reach the server', () => {
    expect(normalizeRemoteUrl('https://user:ghp_secret@github.com/acme/web.git')).toBe('github.com/acme/web');
  });

  it('keeps a non-default port, because two ports can be two different servers', () => {
    expect(normalizeRemoteUrl('ssh://git@git.internal:2222/team/api.git')).toBe('git.internal:2222/team/api');
  });

  it('keeps nested group paths, which GitLab uses and GitHub does not', () => {
    expect(normalizeRemoteUrl('git@gitlab.com:acme/platform/api.git')).toBe('gitlab.com/acme/platform/api');
  });

  it('returns null rather than guessing at something that is not a remote', () => {
    expect(normalizeRemoteUrl('')).toBeNull();
    expect(normalizeRemoteUrl('not a url')).toBeNull();
    expect(normalizeRemoteUrl('https://github.com')).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm.cmd test -- tests/cloud/repo-identity.test.ts`
Expected: FAIL — cannot find module `../../src/cloud/repo-identity.js`

- [ ] **Step 3: Implement normalization**

Create `src/cloud/repo-identity.ts`:

```ts
import { spawnSync } from 'node:child_process';
import path from 'node:path';

export type RepoIdentity = {
  /** `host[:port]/path`, plus `#subpath` when the project is not at the git root. */
  identity: string;
  remoteName: string;
  remoteUrl: string;
  subpath: string | null;
};

export class NoGitRemoteError extends Error {}

/**
 * One identity per repository, whatever URL form the clone used.
 *
 * Host and path are both lowercased. GitHub, GitLab and Bitbucket all treat repository
 * names case-insensitively, so preserving case would split one repo into two buckets the
 * first time somebody typed `Acme` instead of `acme`. A case-sensitive host would merge two
 * genuinely different repos, which is the rarer and more visible failure.
 *
 * Credentials are stripped before anything else. A token in a remote URL is a token that
 * would otherwise be published, stored in config, and read back by every teammate.
 */
export function normalizeRemoteUrl(url: string): string | null {
  const trimmed = url.trim();
  if (!trimmed) return null;

  // scp-like syntax (`git@host:owner/repo.git`) is not a URL and `new URL` cannot parse it.
  const scpLike = /^(?:[^@/]+@)?([^:/]+):(?!\/)(.+)$/.exec(trimmed);
  const parsed = scpLike
    ? { host: scpLike[1], pathname: scpLike[2] }
    : parseAsUrl(trimmed);
  if (!parsed) return null;

  const host = parsed.host.toLowerCase();
  const segments = parsed.pathname
    .replace(/\.git$/i, '')
    .split('/')
    .filter(Boolean)
    .map(segment => segment.toLowerCase());

  // One segment is a host with no repository -- `https://github.com` resolves, and calling it
  // a repo identity would let every such remote collide under a single bucket.
  if (!host || segments.length < 2) return null;
  return `${host}/${segments.join('/')}`;
}

function parseAsUrl(value: string): { host: string; pathname: string } | null {
  try {
    const url = new URL(value);
    // `url.host` keeps a non-default port and drops a default one, which is exactly the rule
    // we want: `:2222` distinguishes a server, `:443` does not.
    return { host: url.host, pathname: url.pathname };
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm.cmd test -- tests/cloud/repo-identity.test.ts`
Expected: PASS, 5 tests

- [ ] **Step 5: Write the failing test for resolution against a real repo**

Append to `tests/cloud/repo-identity.test.ts` — no new imports, they are all at the top of the file already:

```ts
const REPO = path.resolve('./.knowl-identity-repo');

async function makeGitRepo(root: string, remotes: Record<string, string>): Promise<void> {
  await fs.mkdir(root, { recursive: true });
  spawnSync('git', ['init', '-q'], { cwd: root });
  for (const [name, url] of Object.entries(remotes)) {
    spawnSync('git', ['remote', 'add', name, url], { cwd: root });
  }
}

describe('resolveRepoIdentity', () => {
  beforeEach(async () => {
    await fs.rm(REPO, { recursive: true, force: true }).catch(() => {});
  });
  afterEach(async () => {
    await fs.rm(REPO, { recursive: true, force: true }).catch(() => {});
  });

  it('reads origin by default and reports which remote it used', async () => {
    await makeGitRepo(REPO, { origin: 'git@github.com:acme/web.git' });

    const identity = resolveRepoIdentity(REPO);

    expect(identity.identity).toBe('github.com/acme/web');
    expect(identity.remoteName).toBe('origin');
    expect(identity.subpath).toBeNull();
  });

  it('prefers the named remote, so a fork can publish to the upstream bucket', async () => {
    // origin is the fork; upstream is the team's. Defaulting to origin silently files a
    // forked contributor's knowledge under a repo nobody else reads.
    await makeGitRepo(REPO, {
      origin: 'git@github.com:contributor/web.git',
      upstream: 'git@github.com:acme/web.git',
    });

    expect(resolveRepoIdentity(REPO, { remote: 'upstream' }).identity).toBe('github.com/acme/web');
  });

  it('qualifies a project below the git root, so a monorepo does not merge its packages', async () => {
    // Several .knowl projects under one remote normalize alike. Without the subpath they
    // would share one identity and silently pool their knowledge.
    await makeGitRepo(REPO, { origin: 'git@github.com:acme/mono.git' });
    const nested = path.join(REPO, 'packages', 'api');
    await fs.mkdir(nested, { recursive: true });

    const identity = resolveRepoIdentity(nested);

    expect(identity.subpath).toBe('packages/api');
    expect(identity.identity).toBe('github.com/acme/mono#packages/api');
  });

  it('refuses a repo with no remote instead of inventing an identity', async () => {
    await makeGitRepo(REPO, {});

    expect(() => resolveRepoIdentity(REPO)).toThrow(NoGitRemoteError);
  });
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `npm.cmd test -- tests/cloud/repo-identity.test.ts`
Expected: FAIL — `resolveRepoIdentity is not a function`

- [ ] **Step 7: Implement resolution**

Append to `src/cloud/repo-identity.ts`:

```ts
function git(cwd: string, args: string[]): string | null {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) return null;
  return result.stdout.trim() || null;
}

/**
 * Which remote, and therefore which bucket this repo publishes into.
 *
 * `origin` by default and overridable, because in a fork workflow `origin` is the fork and
 * `upstream` is the team's. Whichever was used is recorded on the result and written into
 * config, so the answer stays inspectable rather than being re-derived differently later.
 */
export function resolveRepoIdentity(
  projectRoot: string,
  options: { remote?: string } = {},
): RepoIdentity {
  const remoteName = options.remote ?? 'origin';
  const remoteUrl = git(projectRoot, ['config', '--get', `remote.${remoteName}.url`]);
  if (!remoteUrl) {
    throw new NoGitRemoteError(
      `No git remote "${remoteName}" in ${projectRoot}. ` +
      'A cloud workspace keys published knowledge on the remote URL, so a repository with ' +
      'no remote has no stable identity to publish under. Add a remote, or pass --remote ' +
      'to name a different one.',
    );
  }

  const identity = normalizeRemoteUrl(remoteUrl);
  if (!identity) {
    throw new NoGitRemoteError(
      `Could not read a repository identity from remote "${remoteName}" (${remoteUrl}).`,
    );
  }

  const toplevel = git(projectRoot, ['rev-parse', '--show-toplevel']);
  const subpath = toplevel
    ? path.relative(path.resolve(toplevel), path.resolve(projectRoot)).split(path.sep).join('/') || null
    : null;

  return {
    identity: subpath ? `${identity}#${subpath}` : identity,
    remoteName,
    remoteUrl,
    subpath,
  };
}
```

- [ ] **Step 8: Run test to verify it passes**

Run: `npm.cmd test -- tests/cloud/repo-identity.test.ts`
Expected: PASS, 9 tests

- [ ] **Step 9: Commit**

```bash
git add src/cloud/repo-identity.ts tests/cloud/repo-identity.test.ts
git commit -m "feat(cloud): resolve a stable repo identity from the git remote"
```

---

### Task 2: Credential store

**Files:**
- Create: `src/cloud/credentials.ts`
- Test: `tests/cloud/credentials.test.ts`

**Interfaces:**
- Consumes: `knowlHome()` from `src/core/paths.js`.
- Produces:
  - `type CloudCredential = { accessToken: string; refreshToken: string; expiresAt: string; userId: string }`
  - `credentialsPath(): string`
  - `readCredential(apiHost: string): Promise<CloudCredential | null>`
  - `writeCredential(apiHost: string, credential: CloudCredential): Promise<void>`
  - `clearCredential(apiHost: string): Promise<void>`
  - `normalizeApiHost(value: string): string`

- [ ] **Step 1: Write the failing test**

Create `tests/cloud/credentials.test.ts`:

```ts
import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  clearCredential,
  credentialsPath,
  readCredential,
  writeCredential,
} from '../../src/cloud/credentials.js';

const HOME = path.resolve('./.knowl-credentials-home');
const HOST = 'https://api.knowl.dev';
const OTHER = 'https://staging.knowl.dev';

const credential = (token: string) => ({
  accessToken: token,
  refreshToken: `${token}-refresh`,
  expiresAt: '2099-01-01T00:00:00.000Z',
  userId: 'user-1',
});

describe('cloud credential store', () => {
  beforeEach(async () => {
    process.env.KNOWL_HOME = HOME;
    await fs.rm(HOME, { recursive: true, force: true }).catch(() => {});
  });

  afterEach(async () => {
    delete process.env.KNOWL_HOME;
    await fs.rm(HOME, { recursive: true, force: true }).catch(() => {});
  });

  it('returns null for a host that has never been logged in to', async () => {
    expect(await readCredential(HOST)).toBeNull();
  });

  it('round-trips a credential', async () => {
    await writeCredential(HOST, credential('a'));
    expect(await readCredential(HOST)).toEqual(credential('a'));
  });

  it('keeps hosts apart, so staging cannot answer for production', async () => {
    await writeCredential(HOST, credential('prod'));
    await writeCredential(OTHER, credential('staging'));

    expect((await readCredential(HOST))?.accessToken).toBe('prod');
    expect((await readCredential(OTHER))?.accessToken).toBe('staging');
  });

  it('treats trailing slashes and case as the same host', async () => {
    await writeCredential('https://API.knowl.dev/', credential('a'));
    expect(await readCredential(HOST)).toEqual(credential('a'));
  });

  it('clears one host without disturbing the other', async () => {
    await writeCredential(HOST, credential('prod'));
    await writeCredential(OTHER, credential('staging'));

    await clearCredential(HOST);

    expect(await readCredential(HOST)).toBeNull();
    expect(await readCredential(OTHER)).not.toBeNull();
  });

  it('survives a corrupt file rather than blocking every cloud command', async () => {
    // Machine-local convenience state. A truncated file must cost a re-login, not a crash
    // on every invocation -- the same rule the repo registry follows.
    await fs.mkdir(path.dirname(credentialsPath()), { recursive: true });
    await fs.writeFile(credentialsPath(), '{ not json', 'utf8');

    expect(await readCredential(HOST)).toBeNull();
    await writeCredential(HOST, credential('a'));
    expect(await readCredential(HOST)).toEqual(credential('a'));
  });

  it('writes atomically, leaving no partial file behind', async () => {
    await writeCredential(HOST, credential('a'));
    const entries = await fs.readdir(path.dirname(credentialsPath()));
    expect(entries.filter(name => name.includes('.tmp'))).toEqual([]);
  });

  it.skipIf(process.platform === 'win32')('restricts the file to the owner on POSIX', async () => {
    await writeCredential(HOST, credential('a'));
    const mode = (await fs.stat(credentialsPath())).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm.cmd test -- tests/cloud/credentials.test.ts`
Expected: FAIL — cannot find module `../../src/cloud/credentials.js`

- [ ] **Step 3: Implement the store**

Create `src/cloud/credentials.ts`:

```ts
import fs from 'node:fs/promises';
import path from 'node:path';
import { knowlHome } from '../core/paths.js';

export type CloudCredential = {
  accessToken: string;
  refreshToken: string;
  /** ISO-8601. Compared against `Date.now()` plus a skew window before every request. */
  expiresAt: string;
  userId: string;
};

type CredentialFile = { version: 1; hosts: Record<string, CloudCredential> };

/**
 * Credentials live in `knowlHome()`, never in `.knowl/config.json`.
 *
 * `config.json` is deliberately force-committable so a workspace pointer travels with a
 * clone -- `isConfigTrackedByGit` exists for exactly that. A credential in a committable
 * file is a credential in the repository.
 */
export function credentialsPath(): string {
  return path.join(knowlHome(), 'credentials.json');
}

/** One key per deployment, so staging and self-hosted cannot answer for production. */
export function normalizeApiHost(value: string): string {
  return value.trim().toLowerCase().replace(/\/+$/, '');
}

async function readFileOrEmpty(): Promise<CredentialFile> {
  try {
    const parsed = JSON.parse(await fs.readFile(credentialsPath(), 'utf8')) as CredentialFile;
    if (!parsed || typeof parsed !== 'object' || !parsed.hosts) return { version: 1, hosts: {} };
    return parsed;
  } catch {
    // Unreadable, absent or hand-edited. Costing a re-login is right; failing every cloud
    // command until someone deletes a file by hand is not.
    return { version: 1, hosts: {} };
  }
}

async function writeFileAtomically(file: CredentialFile): Promise<void> {
  const target = credentialsPath();
  await fs.mkdir(path.dirname(target), { recursive: true });
  // Same directory, so the rename is on one filesystem and therefore atomic. A temp file in
  // the OS temp dir can land on another volume, where rename degrades to copy-then-delete
  // and a reader can observe a half-written file.
  const temporary = `${target}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(file, null, 2)}\n`, 'utf8');
  if (process.platform !== 'win32') await fs.chmod(temporary, 0o600);
  await fs.rename(temporary, target);
}

export async function readCredential(apiHost: string): Promise<CloudCredential | null> {
  const file = await readFileOrEmpty();
  return file.hosts[normalizeApiHost(apiHost)] ?? null;
}

export async function writeCredential(apiHost: string, credential: CloudCredential): Promise<void> {
  const file = await readFileOrEmpty();
  file.hosts[normalizeApiHost(apiHost)] = credential;
  await writeFileAtomically(file);
}

export async function clearCredential(apiHost: string): Promise<void> {
  const file = await readFileOrEmpty();
  delete file.hosts[normalizeApiHost(apiHost)];
  await writeFileAtomically(file);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm.cmd test -- tests/cloud/credentials.test.ts`
Expected: PASS, 8 tests (one skipped on Windows)

- [ ] **Step 5: Commit**

```bash
git add src/cloud/credentials.ts tests/cloud/credentials.test.ts
git commit -m "feat(cloud): per-host credential store under knowlHome with atomic writes"
```

---

### Task 3: Cross-process lock and single-flight token refresh

The server treats a replayed refresh token as theft and revokes the session. One long-lived MCP server plus a `knowl` CLI spawned by every hook share one credential file, so a naive refresh logs the user out mid-session.

**Files:**
- Create: `src/cloud/file-lock.ts`
- Create: `src/cloud/token.ts`
- Test: `tests/cloud/file-lock.test.ts`
- Test: `tests/cloud/token.test.ts`

**Interfaces:**
- Consumes: `readCredential`, `writeCredential`, `CloudCredential` from Task 2.
- Produces:
  - `acquireLock(lockPath: string, options?: { staleMs?: number }): Promise<(() => Promise<void>) | null>`
  - `ensureAccessToken(input: EnsureTokenInput): Promise<CloudCredential | null>`
  - `type EnsureTokenInput = { apiHost: string; refresh: (refreshToken: string) => Promise<CloudCredential>; now?: () => number; skewMs?: number; waitMs?: number }`

- [ ] **Step 1: Write the failing lock test**

Create `tests/cloud/file-lock.test.ts`:

```ts
import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { acquireLock } from '../../src/cloud/file-lock.js';

const DIR = path.resolve('./.knowl-lock-fixture');
const LOCK = path.join(DIR, 'test.lock');

describe('acquireLock', () => {
  beforeEach(async () => {
    await fs.rm(DIR, { recursive: true, force: true }).catch(() => {});
    await fs.mkdir(DIR, { recursive: true });
  });
  afterEach(async () => {
    await fs.rm(DIR, { recursive: true, force: true }).catch(() => {});
  });

  it('grants the lock when it is free', async () => {
    const release = await acquireLock(LOCK);
    expect(release).not.toBeNull();
    await release!();
  });

  it('refuses a second holder rather than waiting', async () => {
    // Losers must do nothing, not queue. A queue turns one slow refresh into every hook
    // process blocking behind it.
    const first = await acquireLock(LOCK);
    expect(await acquireLock(LOCK)).toBeNull();
    await first!();
  });

  it('grants the lock again after release', async () => {
    const first = await acquireLock(LOCK);
    await first!();
    const second = await acquireLock(LOCK);
    expect(second).not.toBeNull();
    await second!();
  });

  it('breaks a stale lock, so a killed process cannot wedge every future run', async () => {
    // A crashed holder never releases. Without staleness the next login is impossible and
    // the only remedy is deleting a file the user does not know exists.
    await fs.writeFile(LOCK, 'stale', 'utf8');
    const old = new Date(Date.now() - 60_000);
    await fs.utimes(LOCK, old, old);

    const release = await acquireLock(LOCK, { staleMs: 1_000 });

    expect(release).not.toBeNull();
    await release!();
  });

  it('releasing twice is safe', async () => {
    const release = await acquireLock(LOCK);
    await release!();
    await expect(release!()).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm.cmd test -- tests/cloud/file-lock.test.ts`
Expected: FAIL — cannot find module `../../src/cloud/file-lock.js`

- [ ] **Step 3: Implement the lock**

Create `src/cloud/file-lock.ts`:

```ts
import fs from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_STALE_MS = 30_000;

/**
 * A cross-process mutex, where losing means doing nothing.
 *
 * `wx` is an atomic create-if-absent at the filesystem level, so two processes racing cannot
 * both succeed. The loser returns `null` rather than queueing: the callers here are a
 * long-lived MCP server and a CLI spawned by every hook, so a queue would turn one slow
 * refresh into every process blocking behind it.
 *
 * Staleness is required, not a nicety. A holder killed between create and release leaves the
 * file forever, and without a break the only remedy is deleting a file the user does not know
 * exists.
 */
export async function acquireLock(
  lockPath: string,
  options: { staleMs?: number } = {},
): Promise<(() => Promise<void>) | null> {
  const staleMs = options.staleMs ?? DEFAULT_STALE_MS;
  await fs.mkdir(path.dirname(lockPath), { recursive: true });

  const release = async (): Promise<void> => {
    // `force` so a second release, or a release after another process broke our stale lock,
    // is a no-op rather than an error thrown from a cleanup path.
    await fs.rm(lockPath, { force: true }).catch(() => {});
  };

  try {
    const handle = await fs.open(lockPath, 'wx');
    await handle.close();
    return release;
  } catch (error: any) {
    if (error?.code !== 'EEXIST') throw error;
  }

  const stat = await fs.stat(lockPath).catch(() => null);
  if (!stat || Date.now() - stat.mtimeMs < staleMs) return null;

  // Break it and take it. A second breaker can win the race here and both would believe they
  // hold it; that is acceptable because the guarded operation re-reads state under the lock
  // and is idempotent -- see `ensureAccessToken`.
  await fs.rm(lockPath, { force: true }).catch(() => {});
  try {
    const handle = await fs.open(lockPath, 'wx');
    await handle.close();
    return release;
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm.cmd test -- tests/cloud/file-lock.test.ts`
Expected: PASS, 5 tests

- [ ] **Step 5: Write the failing token test**

Create `tests/cloud/token.test.ts`:

```ts
import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readCredential, writeCredential } from '../../src/cloud/credentials.js';
import { ensureAccessToken } from '../../src/cloud/token.js';

const HOME = path.resolve('./.knowl-token-home');
const HOST = 'https://api.knowl.dev';

const NOW = Date.parse('2026-08-09T12:00:00.000Z');
const iso = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();

const stored = (accessToken: string, expiresAt: string) => ({
  accessToken,
  refreshToken: 'refresh-1',
  expiresAt,
  userId: 'user-1',
});

describe('ensureAccessToken', () => {
  beforeEach(async () => {
    process.env.KNOWL_HOME = HOME;
    await fs.rm(HOME, { recursive: true, force: true }).catch(() => {});
  });
  afterEach(async () => {
    delete process.env.KNOWL_HOME;
    await fs.rm(HOME, { recursive: true, force: true }).catch(() => {});
  });

  it('returns null when nobody is logged in', async () => {
    const result = await ensureAccessToken({
      apiHost: HOST,
      refresh: async () => { throw new Error('must not refresh'); },
      now: () => NOW,
    });
    expect(result).toBeNull();
  });

  it('does not refresh a token that is still good', async () => {
    await writeCredential(HOST, stored('a', iso(600_000)));

    const result = await ensureAccessToken({
      apiHost: HOST,
      refresh: async () => { throw new Error('must not refresh'); },
      now: () => NOW,
    });

    expect(result?.accessToken).toBe('a');
  });

  it('refreshes inside the skew window, before the token actually expires', async () => {
    // A token valid for another 10 seconds will have expired by the time a request lands.
    await writeCredential(HOST, stored('a', iso(10_000)));

    const result = await ensureAccessToken({
      apiHost: HOST,
      refresh: async () => stored('b', iso(3_600_000)),
      now: () => NOW,
    });

    expect(result?.accessToken).toBe('b');
    expect((await readCredential(HOST))?.accessToken).toBe('b');
  });

  it('refreshes exactly once under concurrent callers', async () => {
    // The load-bearing test. The server revokes the whole session on a replayed refresh
    // token, so a second refresh is not a wasted request -- it is a logout.
    await writeCredential(HOST, stored('a', iso(-1_000)));
    let refreshes = 0;

    const results = await Promise.all(
      Array.from({ length: 10 }, () => ensureAccessToken({
        apiHost: HOST,
        refresh: async () => {
          refreshes += 1;
          await new Promise(resolve => setTimeout(resolve, 20));
          return stored('b', iso(3_600_000));
        },
        now: () => NOW,
      })),
    );

    expect(refreshes).toBe(1);
    expect(results.every(entry => entry?.accessToken === 'b')).toBe(true);
  });

  it('re-reads under the lock, so the winner never refreshes an already-rotated token', async () => {
    // Without the re-read, a caller that waited for the lock refreshes the token the previous
    // holder just rotated away -- which the server reads as replay.
    await writeCredential(HOST, stored('a', iso(-1_000)));
    let refreshes = 0;

    await ensureAccessToken({
      apiHost: HOST,
      refresh: async () => { refreshes += 1; return stored('b', iso(3_600_000)); },
      now: () => NOW,
    });
    const second = await ensureAccessToken({
      apiHost: HOST,
      refresh: async () => { refreshes += 1; return stored('c', iso(3_600_000)); },
      now: () => NOW,
    });

    expect(refreshes).toBe(1);
    expect(second?.accessToken).toBe('b');
  });

  it('leaves the stored credential alone when refresh fails', async () => {
    await writeCredential(HOST, stored('a', iso(-1_000)));

    await expect(ensureAccessToken({
      apiHost: HOST,
      refresh: async () => { throw new Error('network down'); },
      now: () => NOW,
    })).rejects.toThrow('network down');

    expect((await readCredential(HOST))?.accessToken).toBe('a');
  });
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `npm.cmd test -- tests/cloud/token.test.ts`
Expected: FAIL — cannot find module `../../src/cloud/token.js`

- [ ] **Step 7: Implement single-flight refresh**

Create `src/cloud/token.ts`:

```ts
import path from 'node:path';
import { knowlHome } from '../core/paths.js';
import { acquireLock } from './file-lock.js';
import { readCredential, writeCredential, type CloudCredential } from './credentials.js';

/** Refresh this long before expiry, so a request in flight does not 401 on arrival. */
const DEFAULT_SKEW_MS = 60_000;
/** How long a loser waits for the winner's write before giving up and reporting no token. */
const DEFAULT_WAIT_MS = 5_000;
const POLL_MS = 50;

export type EnsureTokenInput = {
  apiHost: string;
  refresh: (refreshToken: string) => Promise<CloudCredential>;
  now?: () => number;
  skewMs?: number;
  waitMs?: number;
};

export function credentialLockPath(): string {
  return path.join(knowlHome(), 'credentials.lock');
}

function usable(credential: CloudCredential | null, now: number, skewMs: number): boolean {
  if (!credential) return false;
  const expiresAt = Date.parse(credential.expiresAt);
  // An unparseable expiry is treated as expired. Guessing "probably fine" here would send a
  // dead token on every request and surface as an unexplained 401 instead of a refresh.
  if (Number.isNaN(expiresAt)) return false;
  return expiresAt - skewMs > now;
}

/**
 * One refresh per rotation, however many processes want one.
 *
 * The server revokes the entire session when it sees a refresh token replayed, so two
 * concurrent refreshes are not a wasted request -- the loser replays a rotated token and the
 * user is logged out mid-session with nothing to explain it.
 *
 * The re-read AFTER taking the lock is the whole mechanism. Without it the winner refreshes
 * whatever it read before waiting, which is exactly the token the previous holder just
 * rotated away.
 */
export async function ensureAccessToken(input: EnsureTokenInput): Promise<CloudCredential | null> {
  const now = input.now ?? Date.now;
  const skewMs = input.skewMs ?? DEFAULT_SKEW_MS;
  const waitMs = input.waitMs ?? DEFAULT_WAIT_MS;

  const current = await readCredential(input.apiHost);
  if (!current) return null;
  if (usable(current, now(), skewMs)) return current;

  const release = await acquireLock(credentialLockPath());
  if (!release) {
    // Someone else is refreshing. Poll their write rather than queueing behind them; if they
    // die, the lock goes stale and the next caller breaks it.
    const deadline = now() + waitMs;
    while (Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, POLL_MS));
      const landed = await readCredential(input.apiHost);
      if (usable(landed, now(), skewMs)) return landed;
    }
    return null;
  }

  try {
    const held = await readCredential(input.apiHost);
    if (usable(held, now(), skewMs)) return held;
    if (!held) return null;

    const refreshed = await input.refresh(held.refreshToken);
    await writeCredential(input.apiHost, refreshed);
    return refreshed;
  } finally {
    await release();
  }
}
```

- [ ] **Step 8: Run test to verify it passes**

Run: `npm.cmd test -- tests/cloud/token.test.ts`
Expected: PASS, 6 tests

- [ ] **Step 9: Verify the concurrency test actually tests the lock**

Temporarily change `ensureAccessToken` so `acquireLock` is not called (refresh directly after the first read). Run `npm.cmd test -- tests/cloud/token.test.ts`.
Expected: the "refreshes exactly once under concurrent callers" test FAILS with `refreshes` greater than 1. Restore the code and confirm it passes again.

- [ ] **Step 10: Commit**

```bash
git add src/cloud/file-lock.ts src/cloud/token.ts tests/cloud/file-lock.test.ts tests/cloud/token.test.ts
git commit -m "feat(cloud): single-flight token refresh behind a cross-process lock"
```

---

### Task 4: Cloud API client

**Files:**
- Create: `src/cloud/api-client.ts`
- Test: `tests/cloud/api-client.test.ts`

**Interfaces:**
- Consumes: `CloudCredential` from Task 2.
- Produces:
  - `type FetchLike = (url: string, init?: RequestInit) => Promise<Response>`
  - `createCloudApi(options: { apiHost: string; fetchImpl?: FetchLike }): CloudApi`
  - `type CloudApi = { startDeviceAuthorization(): Promise<DeviceAuthorization>; pollForToken(deviceCode: string): Promise<CloudCredential | 'pending'>; refresh(refreshToken: string): Promise<CloudCredential>; listWorkspaces(accessToken: string): Promise<CloudWorkspace[]> }`
  - `type DeviceAuthorization = { deviceCode: string; userCode: string; verificationUri: string; intervalSeconds: number; expiresInSeconds: number }`
  - `type CloudWorkspace = { id: string; name: string; role: 'owner' | 'admin' | 'editor' | 'reader' }`
  - `class CloudApiError extends Error { readonly status: number; readonly code?: string }`

- [ ] **Step 1: Write the failing test**

Create `tests/cloud/api-client.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { CloudApiError, createCloudApi, type FetchLike } from '../../src/cloud/api-client.js';

const HOST = 'https://api.knowl.dev';

function stubFetch(handler: (url: string, init?: RequestInit) => { status: number; body: unknown }): {
  fetchImpl: FetchLike;
  calls: Array<{ url: string; init?: RequestInit }>;
} {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, init });
    const { status, body } = handler(url, init);
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { fetchImpl, calls };
}

describe('cloud api client', () => {
  it('starts a device authorization and returns the poll interval the server chose', async () => {
    // The interval must come from the server: it derives its own rate limit from that number,
    // so a self-chosen interval earns a 429 while the user is still reading the code.
    const { fetchImpl, calls } = stubFetch(() => ({
      status: 200,
      body: {
        deviceCode: 'dev-1',
        userCode: 'ABCD-EFGH',
        verificationUri: 'https://knowl.dev/device',
        intervalSeconds: 5,
        expiresInSeconds: 900,
      },
    }));

    const result = await createCloudApi({ apiHost: HOST, fetchImpl }).startDeviceAuthorization();

    expect(result.userCode).toBe('ABCD-EFGH');
    expect(result.intervalSeconds).toBe(5);
    expect(calls[0].url).toBe('https://api.knowl.dev/v1/auth/device');
    expect(calls[0].init?.method).toBe('POST');
  });

  it('reports a pending approval as pending, not as an error', async () => {
    // The polling loop must be able to tell "not approved yet" from "something broke".
    const { fetchImpl } = stubFetch(() => ({ status: 428, body: { code: 'authorization_pending' } }));

    const result = await createCloudApi({ apiHost: HOST, fetchImpl }).pollForToken('dev-1');

    expect(result).toBe('pending');
  });

  it('returns the credential once approved', async () => {
    const { fetchImpl } = stubFetch(() => ({
      status: 200,
      body: {
        accessToken: 'a',
        refreshToken: 'r',
        expiresAt: '2099-01-01T00:00:00.000Z',
        userId: 'user-1',
      },
    }));

    const result = await createCloudApi({ apiHost: HOST, fetchImpl }).pollForToken('dev-1');

    expect(result).toEqual({
      accessToken: 'a',
      refreshToken: 'r',
      expiresAt: '2099-01-01T00:00:00.000Z',
      userId: 'user-1',
    });
  });

  it('raises a typed error carrying the status, so callers can branch on 401 and 403', async () => {
    const { fetchImpl } = stubFetch(() => ({ status: 403, body: { code: 'not_a_member' } }));

    const api = createCloudApi({ apiHost: HOST, fetchImpl });

    await expect(api.listWorkspaces('token')).rejects.toMatchObject({
      name: 'CloudApiError',
      status: 403,
      code: 'not_a_member',
    });
    await expect(api.listWorkspaces('token')).rejects.toBeInstanceOf(CloudApiError);
  });

  it('sends the bearer token on authenticated calls and never on the device call', async () => {
    const { fetchImpl, calls } = stubFetch(url =>
      url.endsWith('/workspaces')
        ? { status: 200, body: { workspaces: [{ id: 'w1', name: 'Acme', role: 'editor' }] } }
        : { status: 200, body: { deviceCode: 'd', userCode: 'u', verificationUri: 'v', intervalSeconds: 5, expiresInSeconds: 900 } },
    );
    const api = createCloudApi({ apiHost: HOST, fetchImpl });

    await api.startDeviceAuthorization();
    const workspaces = await api.listWorkspaces('token-1');

    expect(workspaces).toEqual([{ id: 'w1', name: 'Acme', role: 'editor' }]);
    expect((calls[0].init?.headers as Record<string, string>)?.authorization).toBeUndefined();
    expect((calls[1].init?.headers as Record<string, string>)?.authorization).toBe('Bearer token-1');
  });

  it('trims a trailing slash off the host rather than producing a double slash', async () => {
    const { fetchImpl, calls } = stubFetch(() => ({ status: 200, body: { workspaces: [] } }));

    await createCloudApi({ apiHost: 'https://api.knowl.dev/', fetchImpl }).listWorkspaces('t');

    expect(calls[0].url).toBe('https://api.knowl.dev/v1/workspaces');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm.cmd test -- tests/cloud/api-client.test.ts`
Expected: FAIL — cannot find module `../../src/cloud/api-client.js`

- [ ] **Step 3: Implement the client**

Create `src/cloud/api-client.ts`:

```ts
import { normalizeApiHost } from './credentials.js';
import type { CloudCredential } from './credentials.js';

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export type DeviceAuthorization = {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  /** The server derives its own rate limit from this, so the client must honour it. */
  intervalSeconds: number;
  expiresInSeconds: number;
};

export type CloudRole = 'owner' | 'admin' | 'editor' | 'reader';
export type CloudWorkspace = { id: string; name: string; role: CloudRole };

/** Carries the status so callers can branch: 401 means log in, 403 means not a member. */
export class CloudApiError extends Error {
  readonly name = 'CloudApiError';
  constructor(readonly status: number, message: string, readonly code?: string) {
    super(message);
  }
}

export type CloudApi = {
  startDeviceAuthorization(): Promise<DeviceAuthorization>;
  pollForToken(deviceCode: string): Promise<CloudCredential | 'pending'>;
  refresh(refreshToken: string): Promise<CloudCredential>;
  listWorkspaces(accessToken: string): Promise<CloudWorkspace[]>;
};

export function createCloudApi(options: { apiHost: string; fetchImpl?: FetchLike }): CloudApi {
  const host = normalizeApiHost(options.apiHost);
  const doFetch = options.fetchImpl ?? ((url, init) => fetch(url, init));

  async function request<T>(
    pathname: string,
    init: { method: 'GET' | 'POST'; body?: unknown; accessToken?: string },
  ): Promise<{ status: number; body: T }> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (init.body !== undefined) headers['content-type'] = 'application/json';
    if (init.accessToken) headers.authorization = `Bearer ${init.accessToken}`;

    const response = await doFetch(`${host}${pathname}`, {
      method: init.method,
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });

    // A non-JSON body is a proxy or gateway answering, not the API. Reporting the status is
    // more useful than a parse error that names neither the endpoint nor the code.
    const body = await response.json().catch(() => ({})) as T & { code?: string; message?: string };
    return { status: response.status, body };
  }

  function fail(pathname: string, status: number, body: { code?: string; message?: string }): never {
    throw new CloudApiError(status, body.message ?? `${pathname} failed with ${status}`, body.code);
  }

  return {
    async startDeviceAuthorization() {
      const { status, body } = await request<DeviceAuthorization>('/v1/auth/device', { method: 'POST' });
      if (status !== 200) fail('/v1/auth/device', status, body);
      return body;
    },

    async pollForToken(deviceCode) {
      const { status, body } = await request<CloudCredential>('/v1/auth/token', {
        method: 'POST',
        body: { grantType: 'device_code', deviceCode },
      });
      // Not yet approved is the expected steady state of a poll, not a failure. The loop has
      // to tell it apart from a real error or it would abandon a login the user is mid-way
      // through completing.
      if (status === 428) return 'pending';
      if (status !== 200) fail('/v1/auth/token', status, body);
      return body;
    },

    async refresh(refreshToken) {
      const { status, body } = await request<CloudCredential>('/v1/auth/token', {
        method: 'POST',
        body: { grantType: 'refresh_token', refreshToken },
      });
      if (status !== 200) fail('/v1/auth/token', status, body);
      return body;
    },

    async listWorkspaces(accessToken) {
      const { status, body } = await request<{ workspaces: CloudWorkspace[] }>('/v1/workspaces', {
        method: 'GET',
        accessToken,
      });
      if (status !== 200) fail('/v1/workspaces', status, body);
      return body.workspaces ?? [];
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm.cmd test -- tests/cloud/api-client.test.ts`
Expected: PASS, 6 tests

- [ ] **Step 5: Commit**

```bash
git add src/cloud/api-client.ts tests/cloud/api-client.test.ts
git commit -m "feat(cloud): typed API client with injectable fetch"
```

---

### Task 5: `knowl login` and `knowl logout`

**Files:**
- Create: `src/cloud/login.ts`
- Modify: `src/cli/program.ts` — register the commands beside `program.command('workspace')` at line 602
- Test: `tests/cloud/login.test.ts`

**Interfaces:**
- Consumes: `createCloudApi`, `DeviceAuthorization`, `CloudApiError` (Task 4); `writeCredential`, `clearCredential`, `readCredential` (Task 2).
- Produces:
  - `runLogin(input: LoginInput): Promise<LoginResult>`
  - `type LoginInput = { apiHost: string; api?: CloudApi; onPrompt: (authorization: DeviceAuthorization) => void; sleep?: (ms: number) => Promise<void>; now?: () => number }`
  - `type LoginResult = { status: 'authorized'; userId: string } | { status: 'expired' }`
  - `runLogout(apiHost: string): Promise<{ wasLoggedIn: boolean }>`
  - `DEFAULT_API_HOST: string`

- [ ] **Step 1: Write the failing test**

Create `tests/cloud/login.test.ts`:

```ts
import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readCredential, writeCredential } from '../../src/cloud/credentials.js';
import { runLogin, runLogout } from '../../src/cloud/login.js';
import type { CloudApi, DeviceAuthorization } from '../../src/cloud/api-client.js';
import { CloudApiError } from '../../src/cloud/api-client.js';

const HOME = path.resolve('./.knowl-login-home');
const HOST = 'https://api.knowl.dev';

const authorization: DeviceAuthorization = {
  deviceCode: 'dev-1',
  userCode: 'ABCD-EFGH',
  verificationUri: 'https://knowl.dev/device',
  intervalSeconds: 5,
  expiresInSeconds: 900,
};

const credential = {
  accessToken: 'a',
  refreshToken: 'r',
  expiresAt: '2099-01-01T00:00:00.000Z',
  userId: 'user-1',
};

function fakeApi(polls: Array<'pending' | typeof credential | CloudApiError>): CloudApi {
  const queue = [...polls];
  return {
    startDeviceAuthorization: async () => authorization,
    pollForToken: async () => {
      const next = queue.shift();
      if (next instanceof CloudApiError) throw next;
      return next ?? 'pending';
    },
    refresh: async () => credential,
    listWorkspaces: async () => [],
  };
}

describe('runLogin', () => {
  beforeEach(async () => {
    process.env.KNOWL_HOME = HOME;
    await fs.rm(HOME, { recursive: true, force: true }).catch(() => {});
  });
  afterEach(async () => {
    delete process.env.KNOWL_HOME;
    await fs.rm(HOME, { recursive: true, force: true }).catch(() => {});
  });

  it('shows the user the code before polling, not after', async () => {
    // The code is what the user types into the browser. Printing it after the first poll
    // means the first interval elapses before they can see what to do.
    const seen: string[] = [];

    await runLogin({
      apiHost: HOST,
      api: fakeApi([credential]),
      onPrompt: auth => seen.push(auth.userCode),
      sleep: async () => {},
    });

    expect(seen).toEqual(['ABCD-EFGH']);
  });

  it('stores the credential once approved', async () => {
    const result = await runLogin({
      apiHost: HOST,
      api: fakeApi(['pending', 'pending', credential]),
      onPrompt: () => {},
      sleep: async () => {},
    });

    expect(result).toEqual({ status: 'authorized', userId: 'user-1' });
    expect(await readCredential(HOST)).toEqual(credential);
  });

  it('waits the interval the server advertised, not one of its own choosing', async () => {
    // The server computes its rate limit from this number. Polling faster earns a 429 on the
    // tenth of twelve polls, while the user is still reading the code.
    const waits: number[] = [];

    await runLogin({
      apiHost: HOST,
      api: fakeApi(['pending', credential]),
      onPrompt: () => {},
      sleep: async ms => { waits.push(ms); },
    });

    expect(waits).toEqual([5_000]);
  });

  it('gives up when the device code expires instead of polling forever', async () => {
    let elapsed = 0;
    const result = await runLogin({
      apiHost: HOST,
      api: fakeApi(Array.from({ length: 500 }, () => 'pending' as const)),
      onPrompt: () => {},
      sleep: async ms => { elapsed += ms; },
      now: () => Date.parse('2026-08-09T12:00:00.000Z') + elapsed,
    });

    expect(result).toEqual({ status: 'expired' });
    expect(await readCredential(HOST)).toBeNull();
  });

  it('propagates a real error rather than treating it as pending', async () => {
    await expect(runLogin({
      apiHost: HOST,
      api: fakeApi([new CloudApiError(429, 'slow down', 'rate_limited')]),
      onPrompt: () => {},
      sleep: async () => {},
    })).rejects.toBeInstanceOf(CloudApiError);
  });
});

describe('runLogout', () => {
  beforeEach(async () => {
    process.env.KNOWL_HOME = HOME;
    await fs.rm(HOME, { recursive: true, force: true }).catch(() => {});
  });
  afterEach(async () => {
    delete process.env.KNOWL_HOME;
    await fs.rm(HOME, { recursive: true, force: true }).catch(() => {});
  });

  it('reports that there was nothing to clear', async () => {
    expect(await runLogout(HOST)).toEqual({ wasLoggedIn: false });
  });

  it('clears the stored credential', async () => {
    await writeCredential(HOST, credential);

    expect(await runLogout(HOST)).toEqual({ wasLoggedIn: true });
    expect(await readCredential(HOST)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm.cmd test -- tests/cloud/login.test.ts`
Expected: FAIL — cannot find module `../../src/cloud/login.js`

- [ ] **Step 3: Implement the login flow**

Create `src/cloud/login.ts`:

```ts
import { createCloudApi, type CloudApi, type DeviceAuthorization } from './api-client.js';
import { clearCredential, readCredential, writeCredential } from './credentials.js';

export const DEFAULT_API_HOST = 'https://api.knowl.dev';

export type LoginInput = {
  apiHost: string;
  api?: CloudApi;
  /** Called once, before the first poll, so the user can read the code and act on it. */
  onPrompt: (authorization: DeviceAuthorization) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
};

export type LoginResult = { status: 'authorized'; userId: string } | { status: 'expired' };

export async function runLogin(input: LoginInput): Promise<LoginResult> {
  const api = input.api ?? createCloudApi({ apiHost: input.apiHost });
  const sleep = input.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const now = input.now ?? Date.now;

  const authorization = await api.startDeviceAuthorization();
  input.onPrompt(authorization);

  const deadline = now() + authorization.expiresInSeconds * 1000;
  for (;;) {
    const result = await api.pollForToken(authorization.deviceCode);
    if (result !== 'pending') {
      await writeCredential(input.apiHost, result);
      return { status: 'authorized', userId: result.userId };
    }
    // The server's interval, never ours. It derives its own per-address rate limit from this
    // number, so polling faster is throttled partway through a login the user is completing.
    await sleep(authorization.intervalSeconds * 1000);
    if (now() >= deadline) return { status: 'expired' };
  }
}

export async function runLogout(apiHost: string): Promise<{ wasLoggedIn: boolean }> {
  const existing = await readCredential(apiHost);
  await clearCredential(apiHost);
  return { wasLoggedIn: existing !== null };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm.cmd test -- tests/cloud/login.test.ts`
Expected: PASS, 7 tests

- [ ] **Step 5: Register the commands**

In `src/cli/program.ts`, add to the import block near line 30:

```ts
import { DEFAULT_API_HOST, runLogin, runLogout } from '../cloud/login.js';
```

Add immediately before `const workspaceCommand = program.command('workspace')` (line 602):

```ts
program
  .command('login')
  .description('Sign in to a Knowl Cloud workspace')
  .option('--api <host>', 'API host', DEFAULT_API_HOST)
  .action(async options => {
    try {
      const result = await runLogin({
        apiHost: options.api,
        onPrompt: authorization => {
          console.log(`\nOpen ${authorization.verificationUri} and enter this code:\n`);
          console.log(`    ${authorization.userCode}\n`);
          console.log('Waiting for approval...');
        },
      });
      if (result.status === 'expired') {
        console.error('The code expired before it was approved. Run knowl login again.');
        process.exit(1);
      }
      console.log(`Signed in to ${options.api}.`);
    } catch (error: any) {
      console.error(`Login failed: ${error.message}`);
      process.exit(1);
    }
  });

program
  .command('logout')
  .description('Clear stored Knowl Cloud credentials')
  .option('--api <host>', 'API host', DEFAULT_API_HOST)
  .action(async options => {
    const { wasLoggedIn } = await runLogout(options.api);
    console.log(wasLoggedIn ? `Signed out of ${options.api}.` : `Not signed in to ${options.api}.`);
  });
```

- [ ] **Step 6: Build and check the commands are registered**

Run: `npm.cmd run build`
Then: `node dist/index.js login --help`
Expected: usage text showing `--api <host>`

- [ ] **Step 7: Commit**

```bash
git add src/cloud/login.ts tests/cloud/login.test.ts src/cli/program.ts
git commit -m "feat(cloud): knowl login and knowl logout over the device-code flow"
```

---

### Task 6: `knowl cloud connect`

**Files:**
- Create: `src/cloud/connect.ts`
- Modify: `src/core/types.ts:242-281` — add `cloud` to `ProjectConfig`
- Modify: `src/cli/program.ts` — register `cloud` command group
- Test: `tests/cloud/connect.test.ts`

**Interfaces:**
- Consumes: `resolveRepoIdentity`, `NoGitRemoteError` (Task 1); `readCredential` (Task 2); `createCloudApi`, `CloudWorkspace`, `CloudApiError` (Task 4).
- Produces:
  - `type CloudPointer = { apiHost: string; workspaceId: string; workspaceName: string; repo: string; remote: string }`
  - `runConnect(input: ConnectInput): Promise<ConnectResult>`
  - `type ConnectInput = { projectRoot: string; apiHost: string; workspaceId?: string; remote?: string; api?: CloudApi }`
  - `type ConnectResult = { status: 'connected'; pointer: CloudPointer; role: CloudRole } | { status: 'not-logged-in' } | { status: 'ambiguous'; workspaces: CloudWorkspace[] }`

- [ ] **Step 1: Add the config field**

In `src/core/types.ts`, immediately after the `memory?: { ... };` block (ends line 281), add:

```ts
  /**
   * Pointer to a Knowl Cloud workspace. Never a credential -- this file is deliberately
   * force-committable so the pointer travels with a clone, and `isConfigTrackedByGit`
   * exists for that case. Credentials live in `knowlHome()/credentials.json`.
   */
  cloud?: {
    apiHost: string;
    workspaceId: string;
    workspaceName?: string;
    /** Normalized git remote identity this repo publishes under. */
    repo: string;
    /** Which remote it was derived from, so a fork's choice stays inspectable. */
    remote?: string;
  };
```

- [ ] **Step 2: Write the failing test**

Create `tests/cloud/connect.test.ts`:

```ts
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/core/config.js';
import { writeCredential } from '../../src/cloud/credentials.js';
import { runConnect } from '../../src/cloud/connect.js';
import type { CloudApi } from '../../src/cloud/api-client.js';

const HOME = path.resolve('./.knowl-connect-home');
const REPO = path.resolve('./.knowl-connect-repo');
const HOST = 'https://api.knowl.dev';

const credential = {
  accessToken: 'a',
  refreshToken: 'r',
  expiresAt: '2099-01-01T00:00:00.000Z',
  userId: 'user-1',
};

function api(workspaces: Array<{ id: string; name: string; role: 'owner' | 'admin' | 'editor' | 'reader' }>): CloudApi {
  return {
    startDeviceAuthorization: async () => { throw new Error('unused'); },
    pollForToken: async () => 'pending',
    refresh: async () => credential,
    listWorkspaces: async () => workspaces,
  };
}

async function makeRepo(remote: string | null): Promise<void> {
  await fs.mkdir(path.join(REPO, '.knowl'), { recursive: true });
  await fs.writeFile(
    path.join(REPO, '.knowl', 'config.json'),
    JSON.stringify({ version: 1 }, null, 2),
    'utf8',
  );
  spawnSync('git', ['init', '-q'], { cwd: REPO });
  if (remote) spawnSync('git', ['remote', 'add', 'origin', remote], { cwd: REPO });
}

describe('runConnect', () => {
  beforeEach(async () => {
    process.env.KNOWL_HOME = HOME;
    for (const dir of [HOME, REPO]) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  });
  afterEach(async () => {
    delete process.env.KNOWL_HOME;
    for (const dir of [HOME, REPO]) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  it('refuses before login rather than after doing the work', async () => {
    await makeRepo('git@github.com:acme/web.git');

    expect(await runConnect({ projectRoot: REPO, apiHost: HOST, api: api([]) }))
      .toEqual({ status: 'not-logged-in' });
  });

  it('connects when the caller belongs to exactly one workspace', async () => {
    await makeRepo('git@github.com:acme/web.git');
    await writeCredential(HOST, credential);

    const result = await runConnect({
      projectRoot: REPO,
      apiHost: HOST,
      api: api([{ id: 'w1', name: 'Acme', role: 'editor' }]),
    });

    expect(result).toEqual({
      status: 'connected',
      role: 'editor',
      pointer: {
        apiHost: HOST,
        workspaceId: 'w1',
        workspaceName: 'Acme',
        repo: 'github.com/acme/web',
        remote: 'origin',
      },
    });
  });

  it('writes the pointer into config and no credential anywhere near it', async () => {
    await makeRepo('git@github.com:acme/web.git');
    await writeCredential(HOST, credential);

    await runConnect({
      projectRoot: REPO,
      apiHost: HOST,
      api: api([{ id: 'w1', name: 'Acme', role: 'editor' }]),
    });

    const config = await loadConfig(REPO);
    expect(config.cloud).toEqual({
      apiHost: HOST,
      workspaceId: 'w1',
      workspaceName: 'Acme',
      repo: 'github.com/acme/web',
      remote: 'origin',
    });
    const raw = await fs.readFile(path.join(REPO, '.knowl', 'config.json'), 'utf8');
    expect(raw).not.toContain(credential.accessToken);
    expect(raw).not.toContain(credential.refreshToken);
  });

  it('tells a caller who belongs to no workspace apart from one who belongs to several', async () => {
    // Signed in, but invited nowhere. Reporting this as "pick one" would print an empty list
    // and an instruction the user cannot follow.
    await makeRepo('git@github.com:acme/web.git');
    await writeCredential(HOST, credential);

    expect(await runConnect({ projectRoot: REPO, apiHost: HOST, api: api([]) }))
      .toEqual({ status: 'no-workspaces' });
  });

  it('asks which workspace when the caller belongs to several', async () => {
    await makeRepo('git@github.com:acme/web.git');
    await writeCredential(HOST, credential);

    const result = await runConnect({
      projectRoot: REPO,
      apiHost: HOST,
      api: api([
        { id: 'w1', name: 'Acme', role: 'editor' },
        { id: 'w2', name: 'Other', role: 'reader' },
      ]),
    });

    expect(result.status).toBe('ambiguous');
  });

  it('accepts an explicit workspace id when several exist', async () => {
    await makeRepo('git@github.com:acme/web.git');
    await writeCredential(HOST, credential);

    const result = await runConnect({
      projectRoot: REPO,
      apiHost: HOST,
      workspaceId: 'w2',
      api: api([
        { id: 'w1', name: 'Acme', role: 'editor' },
        { id: 'w2', name: 'Other', role: 'reader' },
      ]),
    });

    expect(result).toMatchObject({ status: 'connected', role: 'reader' });
  });

  it('refuses a repo with no git remote', async () => {
    await makeRepo(null);
    await writeCredential(HOST, credential);

    await expect(runConnect({
      projectRoot: REPO,
      apiHost: HOST,
      api: api([{ id: 'w1', name: 'Acme', role: 'editor' }]),
    })).rejects.toThrow(/no git remote/i);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm.cmd test -- tests/cloud/connect.test.ts`
Expected: FAIL — cannot find module `../../src/cloud/connect.js`

- [ ] **Step 4: Implement connect**

Create `src/cloud/connect.ts`:

```ts
import { loadConfig, saveConfig } from '../core/config.js';
import { createCloudApi, type CloudApi, type CloudRole, type CloudWorkspace } from './api-client.js';
import { readCredential } from './credentials.js';
import { resolveRepoIdentity } from './repo-identity.js';

export type CloudPointer = {
  apiHost: string;
  workspaceId: string;
  workspaceName: string;
  repo: string;
  remote: string;
};

export type ConnectInput = {
  projectRoot: string;
  apiHost: string;
  workspaceId?: string;
  remote?: string;
  api?: CloudApi;
};

export type ConnectResult =
  | { status: 'connected'; pointer: CloudPointer; role: CloudRole }
  | { status: 'not-logged-in' }
  | { status: 'no-workspaces' }
  | { status: 'ambiguous'; workspaces: CloudWorkspace[] };

/**
 * Point a repository at a cloud workspace. Publishes nothing.
 *
 * Identity is resolved BEFORE the network call, so a repository with no remote is refused
 * without spending a request or half-writing config. The pointer is written last, so a
 * failure anywhere leaves the repo exactly as it was.
 */
export async function runConnect(input: ConnectInput): Promise<ConnectResult> {
  const identity = resolveRepoIdentity(input.projectRoot, { remote: input.remote });

  const credential = await readCredential(input.apiHost);
  if (!credential) return { status: 'not-logged-in' };

  const api = input.api ?? createCloudApi({ apiHost: input.apiHost });
  const workspaces = await api.listWorkspaces(credential.accessToken);

  // Belonging to none is a different situation from belonging to several, and the remedies
  // have nothing in common: ask for an invitation versus name which one you meant. Folding
  // them together would tell someone with no workspaces to pick one from an empty list.
  if (workspaces.length === 0) return { status: 'no-workspaces' };

  const chosen = input.workspaceId
    ? workspaces.find(entry => entry.id === input.workspaceId)
    : workspaces.length === 1 ? workspaces[0] : undefined;

  // Guessing between several workspaces would silently publish a team's knowledge into
  // another team's store, which there is no unpublish for.
  if (!chosen) return { status: 'ambiguous', workspaces };

  const pointer: CloudPointer = {
    apiHost: input.apiHost,
    workspaceId: chosen.id,
    workspaceName: chosen.name,
    repo: identity.identity,
    remote: identity.remoteName,
  };

  const config = await loadConfig(input.projectRoot);
  await saveConfig(input.projectRoot, { ...config, cloud: pointer });

  return { status: 'connected', pointer, role: chosen.role };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm.cmd test -- tests/cloud/connect.test.ts`
Expected: PASS, 6 tests

- [ ] **Step 6: Register the command**

In `src/cli/program.ts`, add to the import block:

```ts
import { runConnect } from '../cloud/connect.js';
```

Add immediately after the `logout` command from Task 5:

```ts
const cloudCommand = program.command('cloud').description('Connect this repository to a Knowl Cloud workspace');

cloudCommand
  .command('connect')
  .description('Point this repository at a cloud workspace (publishes nothing)')
  .option('--api <host>', 'API host', DEFAULT_API_HOST)
  .option('--workspace <id>', 'Workspace id, when you belong to more than one')
  .option('--remote <name>', 'Git remote to derive repo identity from', 'origin')
  .action(async options => {
    try {
      const root = await findProjectRoot(process.cwd());
      const result = await runConnect({
        projectRoot: root,
        apiHost: options.api,
        workspaceId: options.workspace,
        remote: options.remote,
      });

      if (result.status === 'not-logged-in') {
        console.error('Not signed in. Run knowl login first.');
        process.exit(1);
      }
      if (result.status === 'no-workspaces') {
        console.error('You are signed in but do not belong to any workspace yet.');
        console.error('Ask a workspace owner to invite you, or create one in the web console.');
        process.exit(1);
      }
      if (result.status === 'ambiguous') {
        console.error('You belong to more than one workspace. Re-run with --workspace <id>:');
        for (const entry of result.workspaces) console.error(`  ${entry.id}  ${entry.name} (${entry.role})`);
        process.exit(1);
      }

      console.log(`Connected ${result.pointer.repo} to ${result.pointer.workspaceName} as ${result.role}.`);
      console.log('Nothing has been published. Use knowl publish to share knowledge.');
    } catch (error: any) {
      console.error(`Connect failed: ${error.message}`);
      process.exit(1);
    }
  });
```

- [ ] **Step 7: Build and verify**

Run: `npm.cmd run build`
Then: `node dist/index.js cloud connect --help`
Expected: usage text showing `--api`, `--workspace`, `--remote`

- [ ] **Step 8: Commit**

```bash
git add src/cloud/connect.ts tests/cloud/connect.test.ts src/core/types.ts src/cli/program.ts
git commit -m "feat(cloud): knowl cloud connect writes a workspace pointer and publishes nothing"
```

---

### Task 7: Doctor checks

**Files:**
- Create: `src/cloud/doctor-checks.ts`
- Modify: `src/cli/doctor-report.ts` — call the new checks alongside `workspaceDoctorChecks`
- Test: `tests/cloud/doctor-checks.test.ts`

**Interfaces:**
- Consumes: `ProjectConfig` (`src/core/types.js`); `readCredential` (Task 2); `DoctorCheck` (`src/cli/doctor-report.js`).
- Produces: `cloudDoctorChecks(config: ProjectConfig, now?: () => number): Promise<DoctorCheck[]>`

- [ ] **Step 1: Write the failing test**

Create `tests/cloud/doctor-checks.test.ts`:

```ts
import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeCredential } from '../../src/cloud/credentials.js';
import { cloudDoctorChecks } from '../../src/cloud/doctor-checks.js';
import type { ProjectConfig } from '../../src/core/types.js';

const HOME = path.resolve('./.knowl-doctor-home');
const HOST = 'https://api.knowl.dev';
const NOW = Date.parse('2026-08-09T12:00:00.000Z');

const connected: ProjectConfig = {
  version: 1,
  cloud: { apiHost: HOST, workspaceId: 'w1', workspaceName: 'Acme', repo: 'github.com/acme/web', remote: 'origin' },
};

describe('cloudDoctorChecks', () => {
  beforeEach(async () => {
    process.env.KNOWL_HOME = HOME;
    await fs.rm(HOME, { recursive: true, force: true }).catch(() => {});
  });
  afterEach(async () => {
    delete process.env.KNOWL_HOME;
    await fs.rm(HOME, { recursive: true, force: true }).catch(() => {});
  });

  it('says nothing at all when the repo is not connected', async () => {
    // Knowl is local-first. A repo that never opted into the cloud must not be told about it
    // on every doctor run.
    expect(await cloudDoctorChecks({ version: 1 })).toEqual([]);
  });

  it('warns when connected but not signed in, and says how to fix it', async () => {
    const checks = await cloudDoctorChecks(connected, () => NOW);

    expect(checks).toHaveLength(1);
    expect(checks[0].status).toBe('WARN');
    expect(checks[0].fix).toContain('knowl login');
  });

  it('reports OK when connected and holding a live credential', async () => {
    await writeCredential(HOST, {
      accessToken: 'a', refreshToken: 'r', userId: 'u',
      expiresAt: new Date(NOW + 3_600_000).toISOString(),
    });

    const checks = await cloudDoctorChecks(connected, () => NOW);

    expect(checks[0].status).toBe('OK');
    expect(checks[0].message).toContain('github.com/acme/web');
    expect(checks[0].message).toContain('Acme');
  });

  it('reports OK on an expired access token, because a refresh token still recovers it', async () => {
    // An expired ACCESS token is the ordinary steady state between refreshes. Calling it a
    // problem would make doctor cry wolf on every run more than an hour after login.
    await writeCredential(HOST, {
      accessToken: 'a', refreshToken: 'r', userId: 'u',
      expiresAt: new Date(NOW - 3_600_000).toISOString(),
    });

    const checks = await cloudDoctorChecks(connected, () => NOW);

    expect(checks[0].status).toBe('OK');
  });

  it('makes no network call, so doctor stays fast and works offline', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (() => { throw new Error('doctor must not reach the network'); }) as typeof fetch;
    try {
      await expect(cloudDoctorChecks(connected, () => NOW)).resolves.toBeDefined();
    } finally {
      globalThis.fetch = original;
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm.cmd test -- tests/cloud/doctor-checks.test.ts`
Expected: FAIL — cannot find module `../../src/cloud/doctor-checks.js`

- [ ] **Step 3: Implement the checks**

Create `src/cloud/doctor-checks.ts`:

```ts
import type { ProjectConfig } from '../core/types.js';
import type { DoctorCheck } from '../cli/doctor-report.js';
import { readCredential } from './credentials.js';

/**
 * Cloud status, without touching the network.
 *
 * Doctor runs on every `knowl doctor` and is expected to be fast and to work offline, so a
 * reachability probe belongs behind an explicit flag rather than here. This reports only what
 * the local filesystem already knows.
 *
 * Silent when the repo has no cloud pointer: Knowl is local-first, and a repository that never
 * opted in must not be advertised to about the cloud on every run.
 */
export async function cloudDoctorChecks(
  config: ProjectConfig,
  now: () => number = Date.now,
): Promise<DoctorCheck[]> {
  const pointer = config.cloud;
  if (!pointer) return [];

  const credential = await readCredential(pointer.apiHost);
  if (!credential) {
    return [{
      status: 'WARN',
      message: `Connected to ${pointer.workspaceName ?? pointer.workspaceId}, but not signed in`,
      fix: `Run knowl login --api ${pointer.apiHost}`,
    }];
  }

  // An expired ACCESS token is the ordinary state between refreshes -- the refresh token
  // recovers it silently. Reporting it would make doctor cry wolf an hour after every login.
  const expiresAt = Date.parse(credential.expiresAt);
  const fresh = !Number.isNaN(expiresAt) && expiresAt > now();

  return [{
    status: 'OK',
    message:
      `Cloud: ${pointer.repo} → ${pointer.workspaceName ?? pointer.workspaceId} ` +
      `(${pointer.apiHost}${fresh ? '' : ', access token will refresh on next use'})`,
  }];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm.cmd test -- tests/cloud/doctor-checks.test.ts`
Expected: PASS, 5 tests

- [ ] **Step 5: Wire into doctor**

In `src/cli/doctor-report.ts`, add to imports:

```ts
import { cloudDoctorChecks } from '../cloud/doctor-checks.js';
```

Immediately after `checks.push({ status: 'OK', message: 'Config loaded' });` (line 47), add:

```ts
    checks.push(...await cloudDoctorChecks(config));
```

- [ ] **Step 6: Verify the full suite and build**

Run: `npm.cmd run build`
Then: `npm.cmd test`
Expected: all tests pass, including the pre-existing suite
Then: `git diff --check`
Expected: no output

- [ ] **Step 7: Commit**

```bash
git add src/cloud/doctor-checks.ts tests/cloud/doctor-checks.test.ts src/cli/doctor-report.ts
git commit -m "feat(cloud): report cloud connection status in knowl doctor"
```

---

## Out of scope for Plan A

These belong to Plan B and must not be built here:

- The team store, the sync loop, and the change feed client
- Federation changes, including making `resolveWorkspace` return an active workspace from a cloud pointer alone
- Publishing, the `cloud_published` ledger, and the `knowl publish` command
- The `TEAM UPDATE:` notice block and the turn-boundary change card
- The tests that pin `configuredNamespaces` and `composeContext` against team rows

Plan A deliberately touches no retrieval path, no database, and no namespace code.
