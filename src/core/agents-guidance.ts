import fs from 'node:fs/promises';
import path from 'node:path';
import {
  KNOWL_GUIDANCE_END_MARKER,
  KNOWL_GUIDANCE_START_MARKER,
  renderManagedKnowlGuidanceSection,
} from './knowl-guidance.js';

export type GuidanceInstallStatus = 'created' | 'updated' | 'unchanged';
export type AgentsGuidanceInstallStatus = GuidanceInstallStatus;

export interface KnowlProjectGuidanceInstallResult {
  knowl: GuidanceInstallStatus;
  agents: GuidanceInstallStatus;
}

export function stripManagedKnowlGuidance(source: string): string {
  const start = source.indexOf(KNOWL_GUIDANCE_START_MARKER);
  if (start < 0) return source;
  const end = source.indexOf(KNOWL_GUIDANCE_END_MARKER, start);
  const replacementEnd = end < 0 ? source.length : end + KNOWL_GUIDANCE_END_MARKER.length;
  const before = source.slice(0, start).trimEnd();
  const after = source.slice(replacementEnd).trimStart();
  return [before, after].filter(Boolean).join('\n\n') + (before || after ? '\n' : '');
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
  if (existing.includes(managed)) return 'unchanged';
  const start = existing.indexOf(KNOWL_GUIDANCE_START_MARKER);
  let next: string;
  if (start >= 0) {
    const end = existing.indexOf(KNOWL_GUIDANCE_END_MARKER, start);
    const replacementEnd = end < 0 ? existing.length : end + KNOWL_GUIDANCE_END_MARKER.length;
    const before = existing.slice(0, start).trimEnd();
    const after = existing.slice(replacementEnd).trimStart();
    next = [before, managed.trimEnd(), after].filter(Boolean).join('\n\n') + '\n';
  } else {
    const separator = existing.length === 0 ? '' : existing.endsWith('\n') ? '\n' : '\n\n';
    next = `${existing}${separator}${managed}`;
  }
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
    return knowl.includes(managed) && agents.includes(managed);
  } catch (error: any) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

export async function installKnowlAgentsGuidance(projectRoot: string): Promise<GuidanceInstallStatus> {
  return (await installKnowlProjectGuidance(projectRoot)).agents;
}

export async function isKnowlAgentsGuidanceCurrent(projectRoot: string): Promise<boolean> {
  try {
    return (await fs.readFile(path.join(projectRoot, 'AGENTS.md'), 'utf8'))
      .includes(renderManagedKnowlGuidanceSection());
  } catch (error: any) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}
