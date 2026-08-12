import fs from 'node:fs/promises';
import path from 'node:path';
import { writeFileAtomic } from '../core/atomic-write.js';
import { knowlHome } from '../core/paths.js';

type ConsentFile = { version: 1; workspaces: Record<string, boolean> };

/**
 * Standing permission to publish without a prompt, per machine and per workspace.
 *
 * NOT in `.knowl/config.json`, and that is the whole point. That file is deliberately
 * force-committable so a workspace pointer travels with a clone (`src/core/types.ts`), so a
 * consent flag stored there would be committed by one person and would then enable irreversible
 * automatic publishing for every teammate who clones and for CI -- none of whom agreed to it.
 * Decision `9a2fe8a011d6423b` (an agent may stage, only a human may send) would be satisfied on
 * paper by one edit and violated in fact for everyone else.
 *
 * Consent is exactly as personal as the credential it authorises, and lives beside it.
 */
export function consentPath(): string {
  return path.join(knowlHome(), 'cloud-consent.json');
}

async function readFileOrEmpty(): Promise<ConsentFile> {
  try {
    const parsed = JSON.parse(await fs.readFile(consentPath(), 'utf8')) as ConsentFile;
    if (!parsed || typeof parsed !== 'object' || !parsed.workspaces) return { version: 1, workspaces: {} };
    return parsed;
  } catch {
    // Absent, unreadable or hand-edited. Reading as "no consent" is the safe direction for a
    // permission to do something irreversible.
    return { version: 1, workspaces: {} };
  }
}

export async function readAutoPushConsent(workspaceId: string): Promise<boolean> {
  return (await readFileOrEmpty()).workspaces[workspaceId] === true;
}

export async function writeAutoPushConsent(workspaceId: string, enabled: boolean): Promise<void> {
  const file = await readFileOrEmpty();
  file.workspaces[workspaceId] = enabled;
  await writeFileAtomic(consentPath(), JSON.stringify(file, null, 2));
}
