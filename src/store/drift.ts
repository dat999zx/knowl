import { spawnSync } from 'node:child_process';
import { getDb } from './database.js';
import * as repo from './repository.js';
import type { CommitChange, KnowledgeFreshness, KnowledgeItem } from '../core/types.js';
import { knowledgeMentionsChangedPath, normalizePathForKnowledge } from './freshness.js';
import { listEvidenceForItem, resolveSymbolEvidence } from './evidence-repository.js';

export interface SymbolEvidenceDrift {
  locator: string;
  suggestedLocator?: string;
}

export interface DriftCandidate {
  itemId: string;
  title: string;
  freshness: KnowledgeFreshness;
  matchedPaths: string[];
  symbolEvidence?: SymbolEvidenceDrift[];
}

export interface DriftCheckResult {
  sinceCommit: string;
  currentCommit: string | null;
  changedFiles: string[];
  candidates: DriftCandidate[];
  updatedCount: number;
}

function runGit(args: string[], cwd: string): string {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf-8',
    stdio: 'pipe',
  });

  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || `git ${args.join(' ')} failed`);
  }

  return result.stdout.trim();
}

export function getCurrentGitCommit(projectRoot: string): string | null {
  try {
    return runGit(['rev-parse', 'HEAD'], projectRoot);
  } catch {
    return null;
  }
}

export function listChangedFilesSince(projectRoot: string, sinceCommit: string, currentCommit?: string | null): string[] {
  const range = currentCommit ? `${sinceCommit}..${currentCommit}` : sinceCommit;
  const output = runGit(['diff', '--name-only', range], projectRoot);
  if (!output) return [];
  return Array.from(new Set(
    output
      .split(/\r?\n/)
      .map(line => normalizePathForKnowledge(line.trim()))
      .filter(Boolean)
  ));
}

function matchedPaths(item: KnowledgeItem, changedFiles: string[]): string[] {
  return changedFiles.filter(changedFile => knowledgeMentionsChangedPath(item, [changedFile]));
}

function symbolPath(locator: string): string | null {
  const match = /^symbol:\/\/(.+)#/.exec(locator);
  return match ? normalizePathForKnowledge(match[1]) : null;
}

export async function checkKnowledgeDrift(
  projectId: string,
  options: {
    sinceCommit: string;
    currentCommit?: string | null;
    changedFiles: string[];
    apply?: boolean;
  }
): Promise<DriftCheckResult> {
  const items = (await repo.listKnowledgeItems(projectId))
    .filter(item => item.status === 'active');
  const entries = await Promise.all(items.map(async item => {
    const evidence = await listEvidenceForItem(item.id);
    const symbolEvidence = (await Promise.all(evidence
      .filter(entry => entry.type === 'symbol')
      .map(async entry => ({ entry, resolution: await resolveSymbolEvidence(entry) }))))
      .filter(({ resolution }) => resolution.stale)
      .map(({ entry, resolution }) => ({ locator: entry.locator, suggestedLocator: resolution.suggestedLocator }));
    const symbolPaths = symbolEvidence
      .map(entry => symbolPath(entry.locator))
      .filter((entry): entry is string => Boolean(entry));
    const paths = Array.from(new Set([
      ...matchedPaths(item, options.changedFiles),
      ...symbolPaths.filter(entry => options.changedFiles.includes(entry)),
    ]));
    return { item, matchedPaths: paths, symbolEvidence };
  }));
  const candidates = entries.filter(entry => entry.matchedPaths.length > 0 || entry.symbolEvidence.length > 0);

  let updatedCount = 0;
  if (options.apply && candidates.length > 0) {
    const db = getDb();
    const changes: CommitChange[] = [];

    await db.transaction(async tx => {
      for (const candidate of candidates) {
        if (candidate.item.freshness === 'needs_review') {
          continue;
        }

        const updated = await repo.updateKnowledgeItem(candidate.item.id, {
          freshness: 'needs_review',
        }, undefined, tx);
        changes.push({
          itemId: candidate.item.id,
          action: 'update',
          before: candidate.item,
          after: updated,
        });
      }

      if (changes.length > 0) {
        await repo.createKnowledgeCommit(
          projectId,
          `Mark knowledge drift since ${options.sinceCommit}`,
          changes,
          tx
        );
      }
    });

    updatedCount = changes.length;
  }

  return {
    sinceCommit: options.sinceCommit,
    currentCommit: options.currentCommit || null,
    changedFiles: options.changedFiles,
    updatedCount,
    candidates: candidates.map(candidate => ({
      itemId: candidate.item.id,
      title: candidate.item.title,
      freshness: options.apply ? 'needs_review' : candidate.item.freshness,
      matchedPaths: candidate.matchedPaths,
      ...(candidate.symbolEvidence.length > 0 ? { symbolEvidence: candidate.symbolEvidence } : {}),
    })),
  };
}
