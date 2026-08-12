import fs from 'node:fs/promises';
import path from 'node:path';
import { writeFileAtomic } from '../core/atomic-write.js';
import { knowlHome } from '../core/paths.js';

export type CloudCredential = {
  accessToken: string;
  refreshToken: string;
  /**
   * ISO-8601. Compared against `Date.now()` plus a skew window before every request.
   *
   * The server calls this `accessExpiresAt` on the wire; `api-client.ts` maps it. Reading the
   * body unmapped left this `undefined`, which `Date.parse` turns into NaN and `usable()` reads
   * as expired -- a refresh before every request, against a server that revokes on replay.
   */
  expiresAt: string;
  /**
   * The server's own handle on this session. It sends no user id, so this is what identifies
   * the login -- and it is what a future `knowl cloud sessions` would revoke by.
   */
  sessionId: string;
  /**
   * Cached at login so `knowl cloud status` can say who you are offline.
   *
   * The server sends no user id with the token (see `sessionId` above), and the MCP status path
   * is forbidden from making a network call -- so a value not captured at login is a value no
   * later read can produce. Optional because a credential written by 4.x has none, and status
   * says "identity unknown" rather than inventing one.
   */
  identity?: { email: string; displayName: string };
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

/**
 * The shared helper rather than a second implementation of it.
 *
 * These were two copies of one idea -- stage beside the target, then rename -- and they had
 * drifted: `writeFileAtomic` flushes the handle before renaming and this did not, so an
 * interrupted write here could leave an empty credentials file where the other left none. They
 * also failed the same way on Windows, and the retry that fixes it belongs in one place, which
 * is the whole reason for collapsing them rather than patching both.
 *
 * `mode` unconditionally: `writeFileAtomic` applies it at open and again after, and swallows the
 * `chmod` failure, so the `platform !== 'win32'` guard this used to carry is already handled.
 */
async function writeFileAtomically(file: CredentialFile): Promise<void> {
  await writeFileAtomic(credentialsPath(), `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
}

/**
 * One read-modify-write at a time within this process.
 *
 * Every mutation rewrites the whole file, so two overlapping writes both read the same
 * starting state and the later rename discards the earlier host outright -- logging in to
 * staging silently forgets production. Chained rather than locked because these are ordinary
 * in-process awaits; the cross-process case that actually costs a session, refresh-token
 * rotation, is serialized separately by `credentialLockPath` in `token.ts`.
 *
 * The chain absorbs rejections so one failed write cannot wedge every write after it, while
 * the caller still sees its own error.
 */
let writeQueue: Promise<unknown> = Promise.resolve();

function serialized<T>(operation: () => Promise<T>): Promise<T> {
  const run = writeQueue.then(operation, operation);
  writeQueue = run.then(() => undefined, () => undefined);
  return run;
}

export async function readCredential(apiHost: string): Promise<CloudCredential | null> {
  const file = await readFileOrEmpty();
  return file.hosts[normalizeApiHost(apiHost)] ?? null;
}

export async function writeCredential(apiHost: string, credential: CloudCredential): Promise<void> {
  await serialized(async () => {
    const file = await readFileOrEmpty();
    file.hosts[normalizeApiHost(apiHost)] = credential;
    await writeFileAtomically(file);
  });
}

export async function clearCredential(apiHost: string): Promise<void> {
  await serialized(async () => {
    const file = await readFileOrEmpty();
    delete file.hosts[normalizeApiHost(apiHost)];
    await writeFileAtomically(file);
  });
}
