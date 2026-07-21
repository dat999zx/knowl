import fs from 'node:fs/promises';
import path from 'node:path';
import {
  KNOWL_GUIDANCE_END_MARKER,
  KNOWL_GUIDANCE_START_MARKER,
  renderManagedKnowlGuidanceSection,
} from './knowl-guidance.js';

export type GuidanceInstallStatus = 'created' | 'updated' | 'unchanged';

export interface KnowlProjectGuidanceInstallResult {
  knowl: GuidanceInstallStatus;
  agents: GuidanceInstallStatus;
}

export function stripManagedKnowlGuidance(source: string): string {
  let current = source;
  while (true) {
    const start = current.indexOf(KNOWL_GUIDANCE_START_MARKER);
    if (start < 0) return current.replaceAll(KNOWL_GUIDANCE_END_MARKER, '');
    const end = current.indexOf(KNOWL_GUIDANCE_END_MARKER, start);
    const replacementEnd = end < 0 ? current.length : end + KNOWL_GUIDANCE_END_MARKER.length;
    const before = current.slice(0, start).trimEnd();
    const after = current.slice(replacementEnd).trimStart();
    current = [before, after].filter(Boolean).join('\n\n') + (before || after ? '\n' : '');
  }
}

function normalizeManagedFile(source: string, managed: string): string {
  const unmanaged = stripManagedKnowlGuidance(source).trimEnd();
  return unmanaged.length > 0 ? `${unmanaged}\n\n${managed}` : managed;
}

function isManagedFileCurrent(source: string, managed: string): boolean {
  const startCount = source.split(KNOWL_GUIDANCE_START_MARKER).length - 1;
  const endCount = source.split(KNOWL_GUIDANCE_END_MARKER).length - 1;
  return startCount === 1 && endCount === 1 && normalizeManagedFile(source, managed) === source;
}

async function installManagedFile(
  filePath: string,
  createPrefix: string,
): Promise<GuidanceInstallStatus> {
  const managed = renderManagedKnowlGuidanceSection();
  let existing: string | undefined;
  try {
    existing = await fs.readFile(filePath, 'utf8');
  } catch (error: any) {
    if (error?.code !== 'ENOENT') throw error;
  }
  if (existing === undefined) {
    await fs.writeFile(filePath, `${createPrefix}${managed}`, 'utf8');
    return 'created';
  }
  const next = normalizeManagedFile(existing, managed);
  if (next === existing) return 'unchanged';
  await fs.writeFile(filePath, next, 'utf8');
  return 'updated';
}

export async function installKnowlProjectGuidance(projectRoot: string): Promise<KnowlProjectGuidanceInstallResult> {
  return {
    knowl: await installManagedFile(path.join(projectRoot, 'KNOWL.md'), ''),
    agents: await installManagedFile(path.join(projectRoot, 'AGENTS.md'), '# Agent Instructions\n\n'),
  };
}

export async function isKnowlProjectGuidanceCurrent(projectRoot: string): Promise<boolean> {
  const managed = renderManagedKnowlGuidanceSection();
  try {
    const [knowl, agents] = await Promise.all([
      fs.readFile(path.join(projectRoot, 'KNOWL.md'), 'utf8'),
      fs.readFile(path.join(projectRoot, 'AGENTS.md'), 'utf8'),
    ]);
    return isManagedFileCurrent(knowl, managed) && isManagedFileCurrent(agents, managed);
  } catch (error: any) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}
