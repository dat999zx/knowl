import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { getSkillsDir, type SkillCapability } from './registry.js';
import { globalSkillsRoot, globalTrustPath } from './paths.js';
import { writeFileAtomic } from '../core/atomic-write.js';

export type SkillTrustRecord = {
  approvedHash: string;
  approvedAt: string;
  approvedBy: string;
  allowedEntrypoints: string[];
};

type TrustFile = Record<string, SkillTrustRecord>;

function isGlobalSkillsRoot(root: string): boolean {
  return path.resolve(root) === path.resolve(globalSkillsRoot());
}

/**
 * The trust file sits beside the skills directory, never inside it.
 *
 * Import normalises every skill file under its own package directory, so a malicious export
 * cannot reach this path and ship its own approval.
 */
function resolveTrustPath(root: string): string {
  return isGlobalSkillsRoot(root) ? globalTrustPath() : path.join(root, '.knowl', 'skill-trust.json');
}

function resolveSkillPackageDir(root: string, name: string): string {
  return isGlobalSkillsRoot(root) ? path.join(root, name) : path.join(getSkillsDir(root), name);
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
export async function hashSkillPackage(root: string, name: string): Promise<string> {
  const dir = resolveSkillPackageDir(root, name);
  const files = (await collectFiles(dir)).sort((a, b) => a.relative.localeCompare(b.relative));
  const hash = crypto.createHash('sha256');
  for (const file of files) {
    const content = await fs.readFile(file.absolute);
    hash.update(`${file.relative}\0${content.length}\0`);
    hash.update(content);
  }
  return `sha256:${hash.digest('hex')}`;
}

async function readTrustFile(root: string): Promise<TrustFile> {
  try {
    return JSON.parse(await fs.readFile(resolveTrustPath(root), 'utf-8')) as TrustFile;
  } catch (error: any) {
    if (error.code === 'ENOENT') return {};
    throw error;
  }
}

async function writeTrustFile(root: string, trust: TrustFile): Promise<void> {
  // Atomic: this file decides what may execute, and a torn write would leave it unparseable
  // -- which fails closed, but silently and with no way to tell that from "nothing approved".
  await writeFileAtomic(resolveTrustPath(root), JSON.stringify(trust, null, 2), { mode: 0o600 });
}

export async function listTrust(root: string): Promise<TrustFile> {
  return readTrustFile(root);
}

export async function readTrust(root: string, name: string): Promise<SkillTrustRecord | null> {
  return (await readTrustFile(root))[name] ?? null;
}

export async function approveSkill(
  root: string,
  name: string,
  options: { approvedBy?: string; allowedEntrypoints?: string[] } | string[] = {},
): Promise<SkillTrustRecord> {
  const opts = Array.isArray(options) ? { allowedEntrypoints: options } : options;
  const record: SkillTrustRecord = {
    approvedHash: await hashSkillPackage(root, name),
    approvedAt: new Date().toISOString(),
    approvedBy: opts.approvedBy ?? 'cli',
    allowedEntrypoints: opts.allowedEntrypoints ?? ['*'],
  };
  const trust = await readTrustFile(root);
  trust[name] = record;
  await writeTrustFile(root, trust);
  return record;
}

export async function revokeSkill(root: string, name: string): Promise<boolean> {
  const trust = await readTrustFile(root);
  if (!(name in trust)) return false;
  delete trust[name];
  await writeTrustFile(root, trust);
  return true;
}

/**
 * Execution is refused unless a human approved these exact bytes for this entrypoint.
 *
 * The error names the command that fixes it, because the caller is usually an agent relaying
 * the message to the person who has to make the decision.
 */
export async function assertSkillApproved(root: string, name: string, entrypoint: string): Promise<void> {
  const isGlobal = isGlobalSkillsRoot(root);
  const reApproveCmd = `knowl skill approve ${name}${isGlobal ? ' --global' : ''}`;
  const record = await readTrust(root, name);
  if (!record) {
    throw new Error(`Skill "${name}" has not been approved for execution. Inspect it, then run: ${reApproveCmd}`);
  }
  if (!record.allowedEntrypoints.includes('*') && !record.allowedEntrypoints.includes(entrypoint)) {
    throw new Error(
      `Entrypoint "${entrypoint}" of skill "${name}" is not approved. Approved: `
      + `${record.allowedEntrypoints.join(', ')}. Re-approve with: ${reApproveCmd}`,
    );
  }
  if (await hashSkillPackage(root, name) !== record.approvedHash) {
    throw new Error(`Skill "${name}" has changed since it was approved. Re-inspect it, then run: ${reApproveCmd}`);
  }
}

const STRONGER_CAPABILITIES = new Set<SkillCapability>(['write', 'network', 'publish', 'delete']);

/**
 * Capabilities that require explicit confirmation when approving a skill.
 */
export function requiresStrongerApproval(capabilities: SkillCapability[]): SkillCapability[] {
  return Array.from(new Set(capabilities.filter(c => STRONGER_CAPABILITIES.has(c)))).sort();
}

/**
 * A checkout must never be able to approve itself.
 * Refuses when a repository contains both `.knowl/skills/<name>` and a `skills.<name>` binding.
 */
export async function assertBindingNotSelfApproved(projectRoot: string, name: string): Promise<void> {
  const localSkillDir = path.join(projectRoot, '.knowl', 'skills', name);
  const localExists = await fs.access(localSkillDir).then(() => true, () => false);
  if (!localExists) return;

  const configPath = path.join(projectRoot, '.knowl', 'config.json');
  let config: any;
  try {
    config = JSON.parse(await fs.readFile(configPath, 'utf-8'));
  } catch {
    return;
  }

  if (config.skills?.[name]) {
    throw new Error(
      `Repository ships both a skill package in .knowl/skills/${name} and a skills.${name} binding. `
      + `A checkout must never be able to approve itself. Remove one before running.`,
    );
  }
}
