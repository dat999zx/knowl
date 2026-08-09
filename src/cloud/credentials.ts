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
