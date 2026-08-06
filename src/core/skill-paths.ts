import path from 'node:path';

/**
 * Name and path validators for skill packages.
 *
 * These are security primitives, not skills logic: `normalizeSkillFilePath` is what stops a
 * crafted `files` entry in an imported bundle from escaping `.knowl/skills/<name>/` and
 * writing anywhere on disk. Both `skills/registry.ts` (creating a package) and
 * `store/portability.ts` (importing one) have to apply exactly the same rule, and the second
 * had to import upward into the feature to get it. A validator that two layers must agree on
 * belongs beneath both.
 */

/** Exported so the registry matches names against this pattern and not a second copy of it. */
export const SAFE_SKILL_NAME = /^[a-z0-9][a-z0-9_-]*$/;

export function validateSkillName(name: string): void {
  if (!SAFE_SKILL_NAME.test(name)) {
    throw new Error(`Invalid skill name "${name}". Use lowercase letters, numbers, underscores, and hyphens.`);
  }
}

export function normalizeSkillFilePath(filePath: string): string {
  if (!filePath || filePath.includes('\0') || path.isAbsolute(filePath) || path.win32.isAbsolute(filePath)) {
    throw new Error(`Invalid skill file path "${filePath}"`);
  }

  const normalized = path.posix.normalize(filePath.replace(/\\/g, '/'));
  if (normalized === '.' || normalized === '..' || normalized.startsWith('../')) {
    throw new Error(`Invalid skill file path "${filePath}"`);
  }

  return normalized;
}
