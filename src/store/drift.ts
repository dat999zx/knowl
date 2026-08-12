import { spawnSync } from 'node:child_process';
import { statSync } from 'node:fs';
import path from 'node:path';
import { withClientTransaction } from './database.js';
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

/** What git tracks: the files themselves, and every directory that contains one. */
type TrackedPaths = { files: Set<string>; directories: Set<string> };

/**
 * Every path git tracks, as one call rather than one per affected path.
 *
 * `directories` is derived once here rather than scanned per lookup. The obvious way to ask
 * "does this prefix contain a tracked file" is to iterate the file set, but that runs inside a
 * loop over every affected path of every item, which is O(items x paths x trackedFiles) and
 * quietly turns a session-start check into a scan of the whole index.
 *
 * Returns null when git cannot answer at all — a missing binary, or a directory that is not a
 * checkout. Null means "unknown", which the caller must treat as "check nothing", because
 * assuming an empty set would make every path look untracked and flag the entire store.
 */
function listTrackedPaths(projectRoot: string): TrackedPaths | null {
  try {
    const output = runGit(['ls-files'], projectRoot);
    const files = new Set(
      output.split(/\r?\n/).map(line => normalizePathForKnowledge(line.trim())).filter(Boolean),
    );
    const directories = new Set<string>();
    for (const file of files) {
      let cursor = file;
      for (let slash = cursor.lastIndexOf('/'); slash > 0; slash = cursor.lastIndexOf('/')) {
        cursor = cursor.slice(0, slash);
        // Every ancestor of an already-seen file is also already recorded, so stop climbing.
        if (directories.has(cursor)) break;
        directories.add(cursor);
      }
    }
    return { files, directories };
  } catch {
    return null;
  }
}

/**
 * Affected paths that git cannot report on, which moved after the item was last written.
 *
 * WHY THIS EXISTS. `listChangedFilesSince` is `git diff --name-only`, so the whole drift check
 * sees TRACKED files and nothing else. An atom whose `affectedPaths` name an untracked or
 * ignored directory is therefore unwatchable: the check runs, finds nothing, and reports the
 * atom fresh forever.
 *
 * Measured 2026-08-12, and it is not hypothetical. A state atom recording "STILL OPEN: final
 * atmosphere pick" pointed at `experiments/reskin/` — a working directory that is deliberately
 * not in git. The question was settled days later, the directory changed constantly throughout,
 * the atom was never revised, and a later session read it and believed the question was still
 * open. Every existing defence missed it for its own structural reason; this one missed because
 * the signal source cannot see the files.
 *
 * DIRECTORY MTIME IS DELIBERATELY SHALLOW. A directory's mtime moves when entries are added or
 * removed, not when a file inside is edited, and this does NOT walk the tree to find out. The
 * atom above pointed at a directory that grew 489 MB of new subdirectories, so the shallow
 * signal catches it, while a recursive walk of exactly that directory is what makes the check
 * too expensive to run at every session start. A deep edit inside an untracked directory with a
 * stable entry list is the accepted blind spot.
 *
 * Compared against `updatedAt`, so revising an atom clears its own drift.
 */
function untrackedPathsChangedSince(
  item: KnowledgeItem,
  projectRoot: string,
  tracked: TrackedPaths | null,
): string[] {
  if (!tracked) return [];
  const writtenAt = Date.parse(item.updatedAt);
  if (!Number.isFinite(writtenAt)) return [];

  const moved: string[] = [];
  for (const affectedPath of item.affectedPaths || []) {
    const normalized = normalizePathForKnowledge(affectedPath);
    if (!normalized) continue;
    // A path git tracks is already the git diff's job; checking it here would double-report it
    // and, worse, report it on every run rather than only within the commit window.
    if (tracked.files.has(normalized)) continue;
    // A directory containing a tracked file is a real source directory, not a working area,
    // so `git diff` covers what happens inside it.
    if (tracked.directories.has(normalized)) continue;

    try {
      const stats = statSync(path.resolve(projectRoot, normalized));
      if (stats.mtimeMs > writtenAt) moved.push(normalized);
    } catch {
      // Absent is not moved. A deleted path is a different finding and this check does not
      // make it, because an atom naming a path that never existed would otherwise flag forever.
    }
  }
  return moved;
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
    /**
     * Enables the untracked-path check. Absent keeps the git-only behaviour, so a caller that
     * has no project root on hand behaves exactly as before rather than silently checking less.
     */
    projectRoot?: string;
  }
): Promise<DriftCheckResult> {
  const items = (await repo.listKnowledgeItems())
    .filter(item => item.status === 'active');
  // One git call for the whole run, not one per item per path.
  const tracked = options.projectRoot ? listTrackedPaths(options.projectRoot) : null;
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
      ...(options.projectRoot ? untrackedPathsChangedSince(item, options.projectRoot, tracked) : []),
    ]));
    return { item, matchedPaths: paths, symbolEvidence };
  }));
  const candidates = entries.filter(entry => entry.matchedPaths.length > 0 || entry.symbolEvidence.length > 0);

  let updatedCount = 0;
  if (options.apply && candidates.length > 0) {
    const changes: CommitChange[] = [];

    // Client-level, not db.transaction: see withClientTransaction for the measurement. This
    // runs on every session hook via `runAutoDriftCheckBestEffort`, inside the long-lived MCP
    // server, so it is one of the paths that can actually reach the wrapper's ceiling.
    await withClientTransaction(async tx => {
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
