import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { getSkillsDir } from './registry.js';

export type SkillTrustRecord = {
  approvedHash: string;
  approvedAt: string;
  approvedBy: string;
  allowedEntrypoints: string[];
};

type TrustFile = Record<string, SkillTrustRecord>;

/**
 * The trust file sits beside `.knowl/skills`, never inside it.
 *
 * Import normalises every skill file under its own package directory, so a malicious export
 * cannot reach this path and ship its own approval.
 */
function trustPath(projectRoot: string): string {
  return path.join(projectRoot, '.knowl', 'skill-trust.json');
}

/**
 * Walk the package, refusing symlinks rather than resolving them.
 *
 * A link is unhashable in the sense that matters here: hashing its target lets the approved
 * bytes change without changing the hash, and hashing the link text lets execution -- which
 * follows the link -- run something the hash never saw. Either way approval stops meaning
 * "these bytes". A skill package is a handful of files it owns; refusing is not a hardship.
 */
async function collectFiles(dir: string, prefix = ''): Promise<Array<{ relative: string; absolute: string }>> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files: Array<{ relative: string; absolute: string }> = [];
  for (const entry of entries) {
    const absolute = path.join(dir, entry.name);
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) {
      throw new Error(`Skill package file "${relative}" is a symlink, which cannot be approved. Replace it with a real file.`);
    }
    if (entry.isDirectory()) files.push(...await collectFiles(absolute, relative));
    else if (entry.isFile()) files.push({ relative, absolute });
  }
  return files;
}

/**
 * A hash over every byte of the package, including its manifest and markdown.
 *
 * Path and length are folded in alongside content, so moving a file or adding an empty one
 * changes the hash. Sorting by path makes it independent of directory-read order.
 */
export async function hashSkillPackage(projectRoot: string, name: string): Promise<string> {
  const dir = path.join(getSkillsDir(projectRoot), name);
  const files = (await collectFiles(dir)).sort((a, b) => a.relative.localeCompare(b.relative));
  const hash = crypto.createHash('sha256');
  for (const file of files) {
    const content = await fs.readFile(file.absolute);
    hash.update(`${file.relative}\0${content.length}\0`);
    hash.update(content);
  }
  return `sha256:${hash.digest('hex')}`;
}

async function readTrustFile(projectRoot: string): Promise<TrustFile> {
  try {
    return JSON.parse(await fs.readFile(trustPath(projectRoot), 'utf-8')) as TrustFile;
  } catch (error: any) {
    if (error.code === 'ENOENT') return {};
    throw error;
  }
}

async function writeTrustFile(projectRoot: string, trust: TrustFile): Promise<void> {
  const target = trustPath(projectRoot);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, JSON.stringify(trust, null, 2), { encoding: 'utf-8', mode: 0o600 });
  await fs.chmod(target, 0o600).catch(() => {});
}

export async function listTrust(projectRoot: string): Promise<TrustFile> {
  return readTrustFile(projectRoot);
}

export async function readTrust(projectRoot: string, name: string): Promise<SkillTrustRecord | null> {
  return (await readTrustFile(projectRoot))[name] ?? null;
}

export async function approveSkill(
  projectRoot: string,
  name: string,
  options: { approvedBy?: string; allowedEntrypoints?: string[] } = {},
): Promise<SkillTrustRecord> {
  const record: SkillTrustRecord = {
    approvedHash: await hashSkillPackage(projectRoot, name),
    approvedAt: new Date().toISOString(),
    approvedBy: options.approvedBy ?? 'cli',
    allowedEntrypoints: options.allowedEntrypoints ?? ['*'],
  };
  const trust = await readTrustFile(projectRoot);
  trust[name] = record;
  await writeTrustFile(projectRoot, trust);
  return record;
}

export async function revokeSkill(projectRoot: string, name: string): Promise<boolean> {
  const trust = await readTrustFile(projectRoot);
  if (!(name in trust)) return false;
  delete trust[name];
  await writeTrustFile(projectRoot, trust);
  return true;
}

/**
 * Execution is refused unless a human approved these exact bytes for this entrypoint.
 *
 * The error names the command that fixes it, because the caller is usually an agent relaying
 * the message to the person who has to make the decision.
 */
export async function assertSkillApproved(projectRoot: string, name: string, entrypoint: string): Promise<void> {
  const record = await readTrust(projectRoot, name);
  if (!record) {
    throw new Error(`Skill "${name}" has not been approved for execution. Inspect it, then run: knowl skill approve ${name}`);
  }
  if (!record.allowedEntrypoints.includes('*') && !record.allowedEntrypoints.includes(entrypoint)) {
    throw new Error(
      `Entrypoint "${entrypoint}" of skill "${name}" is not approved. Approved: `
      + `${record.allowedEntrypoints.join(', ')}. Re-approve with: knowl skill approve ${name}`,
    );
  }
  if (await hashSkillPackage(projectRoot, name) !== record.approvedHash) {
    throw new Error(`Skill "${name}" has changed since it was approved. Re-inspect it, then run: knowl skill approve ${name}`);
  }
}
