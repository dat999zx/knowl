import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { EvidenceInput } from '../core/types.js';

function git(root: string, args: string[]): string {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf-8', stdio: 'pipe' });
  if (result.status !== 0) throw new Error(result.stderr.trim() || `git ${args.join(' ')} failed`);
  return result.stdout.trim();
}
function safePath(filePath: string): boolean { return !/(^|[\\/])\.env(?:\.|$)|\.(?:bin|pem|key|p12|pfx)$/i.test(filePath); }

export async function collectSessionGitEvidence(projectRoot: string, baselineCommit?: string | null): Promise<{
  baselineCommit: string | null; currentCommit: string | null; changedPaths: string[]; diffStat: string; fileEvidence: EvidenceInput[];
}> {
  const currentCommit = (() => { try { return git(projectRoot, ['rev-parse', 'HEAD']); } catch { return null; } })();
  if (!baselineCommit || !currentCommit) return { baselineCommit: baselineCommit ?? null, currentCommit, changedPaths: [], diffStat: '', fileEvidence: [] };
  const changedPaths = git(projectRoot, ['diff', '--name-only', baselineCommit]).split(/\r?\n/).filter(Boolean).filter(safePath);
  const fileEvidence: EvidenceInput[] = [];
  for (const locator of changedPaths.slice(0, 50)) {
    try {
      const content = await fs.readFile(path.join(projectRoot, locator));
      if (content.includes(0) || content.length > 200_000) continue;
      fileEvidence.push({ type: 'file', locator: locator.replace(/\\/g, '/'), contentHash: crypto.createHash('sha256').update(content).digest('hex'), observedAt: new Date().toISOString(), relationship: 'supports' });
    } catch { /* changed/deleted files have no current hash evidence */ }
  }
  return { baselineCommit, currentCommit, changedPaths, diffStat: git(projectRoot, ['diff', '--stat', baselineCommit]).slice(0, 4_000), fileEvidence };
}
